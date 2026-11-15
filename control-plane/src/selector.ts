// SPEC §8 literally: compute tier OUTER (GPU/SECURE, GPU/COMMUNITY, CPU), region tier inner,
// intersect with the live catalog, skip GPUs with availability NONE, cost check > $2/hr -> DELETE, continue.
import type { Catalog, CreatePodBody, ErrorCode } from "../../packages/contract/src/index";
import { alert } from "./alerts";
import {
	COMPUTE_TIERS, CONSTANTS, CPU_FLAVORS, DEV_DUMMY_IMAGE, EXCLUDED_GPUS, GPU_RANK, REGION_TIERS, getConfig, norm,
} from "./config";
import { activePod, getJob, jobCost, logEvent, markDeletePending, markPodDeleted, now, randomId, sha256Hex, updateJob, type JobRow } from "./db";
import { catalog, createPod, deletePod, lookupPodByName, type CreatedPod } from "./runpod";
import { faultArg, hasFault } from "./faults";
import { isTerminal, transition } from "./state";

const matches = (pattern: string, id: string) =>
	pattern.endsWith("*") ? id.startsWith(pattern.slice(0, -1)) : id === pattern;

/** One planned create call: what §8 would POST for this compute tier × region tier. */
export interface Attempt {
	computeTier: (typeof COMPUTE_TIERS)[number];
	dataCenterIds: string[];
	gpuTypeIds: string[]; // exact catalog ids, rank order (empty for CPU)
}

/** Pure §8 ordering, unit-tested with a fake catalog. */
export function planAttempts(cat: Catalog, rank: string[], skipDcs: string[], regionTiers = REGION_TIERS): Attempt[] {
	const out: Attempt[] = [];
	for (const computeTier of COMPUTE_TIERS) {
		for (const tier of regionTiers) {
			const dcs = cat.dataCenters.filter((dc) => tier.some((p) => matches(p, dc.id)) && !skipDcs.includes(dc.id));
			if (!dcs.length) continue;
			if (computeTier === "CPU") {
				out.push({ computeTier, dataCenterIds: dcs.map((d) => d.id), gpuTypeIds: [] });
				continue;
			}
			const gpus: string[] = [];
			for (const want of rank) {
				if (EXCLUDED_GPUS.some((x) => norm(want).includes(x))) continue;
				for (const dc of dcs) {
					const g = dc.gpuAvailability?.find((a) => norm(a.id) === norm(want) && a.availability !== "NONE");
					if (g && !gpus.includes(g.id)) gpus.push(g.id); // send the catalog's exact spelling
				}
			}
			if (gpus.length) out.push({ computeTier, dataCenterIds: dcs.map((d) => d.id), gpuTypeIds: gpus });
		}
	}
	return out;
}

export function podBody(env: Env, job: JobRow, a: Attempt, token: string): CreatePodBody & { dockerStartCmd?: string[] } {
	const dummy = job.dev_mode === "dummy";
	const base = {
		name: `vf-${job.id}` as const,
		imageName: dummy ? DEV_DUMMY_IMAGE : env.RENDERER_IMAGE,
		containerRegistryAuthId: env.RUNPOD_REGISTRY_AUTH_ID,
		dataCenterIds: a.dataCenterIds,
		dataCenterPriority: "custom" as const,
		containerDiskInGb: 30 as const,
		volumeInGb: 0 as const,
		ports: [] as [],
		env: {
			JOB_ID: job.id,
			JOB_TOKEN: token,
			CP_URL: env.CP_URL,
			TTL_MIN: String(job.ttl_min),
			...(a.computeTier === "CPU" ? {} : { NVIDIA_DRIVER_CAPABILITIES: "compute,utility,video" as const }),
			...(job.dev_mode === "bench" ? { BENCH: "1" as const } : {}),
		},
		...(dummy ? { dockerStartCmd: ["sleep", "600"] } : {}),
	};
	if (a.computeTier === "CPU") {
		return { ...base, computeType: "CPU", cpuFlavorIds: [...CPU_FLAVORS] as ["cpu5c", "cpu3c"], cpuFlavorPriority: "custom", vcpuCount: 16 };
	}
	return {
		...base,
		computeType: "GPU",
		cloudType: a.computeTier === "GPU/SECURE" ? "SECURE" : "COMMUNITY",
		gpuTypeIds: a.gpuTypeIds,
		gpuTypePriority: "custom",
		gpuCount: 1,
		minVCPUPerGPU: 8,
	};
}

const shortGpu = (id: string | null) => (id ?? "CPU").replace(/^NVIDIA (GeForce )?/, "");

/** A held create is re-checked by the watchdog: confirmed absent for this long -> safe to create again. */
export const UNCERTAIN_GRACE_MS = 3 * 60_000;
/** Still unknown after this long -> give up on the job (a pod that shows up later is reaped as an orphan). */
export const UNCERTAIN_GIVE_UP_MS = 15 * 60_000;

/**
 * `jobs.create_uncertain_at` is the create claim. It is set atomically BEFORE the first POST of a selection
 * and cleared only once the outcome is definite (pod accepted, or every candidate definitely refused).
 * So a crash mid-create, or a second selector run racing this one (acquire's waitUntil vs the watchdog),
 * finds the claim and treats the create as uncertain: it looks the pod up by name, never POSTs.
 */
async function claim(db: D1Database, jobId: string, prev: number | null): Promise<boolean> {
	const r = await db
		.prepare(
			`UPDATE jobs SET create_uncertain_at = ?, updated_at = ? WHERE id = ? AND state IN ('provisioning','retrying') AND ${prev === null ? "create_uncertain_at IS NULL" : "create_uncertain_at = ?"}`,
		)
		.bind(now(), now(), jobId, ...(prev === null ? [] : [prev]))
		.run();
	return r.meta.changes === 1;
}

/**
 * Rent a pod for `jobId` (state provisioning or retrying). On success: pod recorded, JOB_TOKEN hash stored
 * (one token per selection, so a replaced pod's token stops working), state -> booting.
 * Held ("held"): a create may be in flight or its outcome is unknown, or one of this job's pods is not yet
 * confirmed deleted. No POST happens while held. No capacity: state -> failed (failed_no_capacity).
 */
export async function selectAndCreate(
	env: Env, db: D1Database, jobId: string, opts: { rank?: string[]; gpuOnly?: boolean } = {},
): Promise<"created" | "no_capacity" | "skipped" | "held"> {
	const job = await getJob(db, jobId);
	if (!job || (job.state !== "provisioning" && job.state !== "retrying")) return "skipped";
	if (await activePod(db, jobId)) return "skipped";
	const pods = (await db.prepare("SELECT id, deleted_at FROM pods WHERE job_id = ?").bind(jobId).all<{ id: string; deleted_at: number | null }>()).results;
	const known = pods.map((r) => r.id);
	const undeleted = pods.filter((r) => r.deleted_at === null).length; // delete-pending pods of this job
	const cap = Number(faultArg(await hasFault(db, job.id, "price_cap")) ?? CONSTANTS.PRICE_CAP_USD_PER_HR);

	if (job.create_uncertain_at) {
		const age = now() - job.create_uncertain_at;
		const found = await lookupPodByName(env, `vf-${job.id}`, known);
		await logEvent(db, job.id, "create_hold_check", { lookup: found.state, age_s: Math.round(age / 1000), undeleted });
		if (found.state === "found") {
			const r = await accept(env, db, job, found.pod, null, cap);
			if (r !== "rejected") return r === "rejected_pending" ? "held" : r;
			// Adopted pod was over the cap and is confirmed deleted: a fresh selection may follow.
		} else if (age >= UNCERTAIN_GIVE_UP_MS) {
			await failJob(env, db, job, "failed_no_capacity", `create outcome still unknown after ${Math.round(age / 60000)} min`);
			return "no_capacity";
		} else if (found.state !== "absent" || age < UNCERTAIN_GRACE_MS || undeleted > 0) {
			return "held";
		}
		// Confirmed absent past the grace period, nothing pending deletion: take the claim over (atomically).
		if (!(await claim(db, job.id, job.create_uncertain_at))) return "held";
	} else {
		if (undeleted > 0) return "held"; // never start a replacement while an old pod may still be running
		if (!(await claim(db, job.id, null))) return "held";
	}

	const rank = opts.rank ?? (await getConfig<string[]>(db, "gpu_rank", GPU_RANK));
	const cat = await catalog(env, db);
	const blocked = faultArg(await hasFault(db, job.id, "block_region"));
	const attempts = planAttempts(cat, rank, [...JSON.parse(job.skip_dcs), ...(blocked ? [blocked] : [])]).filter(
		(a) => !opts.gpuOnly || a.computeTier !== "CPU",
	);

	// One token per selection, stored BEFORE any create: a pod adopted after an uncertain create already
	// carries this token in its env, so its /hello must verify.
	const token = randomId("t_") + randomId("");
	await updateJob(db, job.id, { job_token_sha256: await sha256Hex(token), token_expires_at: now() + job.ttl_min * 60_000 });

	for (const a of attempts) {
		const res = await createPod(env, podBody(env, job, a, token), known);
		if (!res.ok && res.uncertain) {
			// Keep the claim; restart its clock at the moment the outcome became unknown.
			await db.prepare("UPDATE jobs SET create_uncertain_at = ? WHERE id = ?").bind(now(), job.id).run();
			await logEvent(db, job.id, "create_uncertain", { tier: a.computeTier, dcs: a.dataCenterIds, status: res.status, detail: res.body });
			await alert(env, db, "pod create outcome unknown: job held, no replacement until resolved", job.id);
			return "held";
		}
		if (!res.ok) {
			await logEvent(db, job.id, "create_failed", { tier: a.computeTier, dcs: a.dataCenterIds, status: res.status, detail: res.body });
			continue;
		}
		known.push(res.pod.id);
		const r = await accept(env, db, job, res.pod, a, cap);
		if (r === "rejected") continue;
		// Over-cap pod not confirmed deleted: keep the claim, no replacement until the watchdog deletes it.
		if (r === "rejected_pending") return "held";
		return r;
	}

	await updateJob(db, job.id, { create_uncertain_at: null });
	if (job.dev_mode === "bench") {
		await transition(db, job, "cancelled", { reason: "bench_no_capacity" });
		return "no_capacity";
	}
	await failJob(env, db, job, "failed_no_capacity", `no pod in ${attempts.length} attempts`);
	return "no_capacity";
}

/**
 * Record a pod RunPod made (always, so it stays tracked), then enforce the price cap. A cost that is missing,
 * not a finite number or negative cannot be checked against the cap, so it is treated as over it.
 */
async function accept(env: Env, db: D1Database, job: JobRow, pod: CreatedPod, a: Attempt | null, cap: number): Promise<"created" | "rejected" | "rejected_pending" | "skipped"> {
	const t = now();
	const compute = a ? (a.computeTier === "CPU" ? "CPU" : "GPU") : pod.gpuTypeId ? "GPU" : null;
	await db
		.prepare("INSERT OR IGNORE INTO pods (id, job_id, gpu_type_id, data_center_id, cloud_type, compute_type, cost_per_hr, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
		.bind(pod.id, job.id, pod.gpuTypeId, pod.dataCenterId, a?.computeTier.split("/")[1] ?? null, compute, Number.isFinite(pod.costPerHr) ? pod.costPerHr : CONSTANTS.PRICE_CAP_USD_PER_HR, t)
		.run();
	const costOk = Number.isFinite(pod.costPerHr) && pod.costPerHr >= 0;
	if (!costOk || pod.costPerHr > cap) {
		await logEvent(db, job.id, "cost_reject", { pod: pod.id, costPerHr: Number.isFinite(pod.costPerHr) ? pod.costPerHr : String(pod.costPerHr), reason: costOk ? "over_cap" : "cost_invalid", gpu: pod.gpuTypeId });
		const gone = await retirePod(env, db, job.id, pod.id, costOk ? "cost_reject" : "cost_invalid");
		return gone ? "rejected" : "rejected_pending";
	}
	await updateJob(db, job.id, {
		gpu_label: `${shortGpu(pod.gpuTypeId)} · ${pod.dataCenterId ?? a?.dataCenterIds[0] ?? "?"}`,
		create_uncertain_at: null,
	});
	await logEvent(db, job.id, "pod_created", { pod: pod.id, tier: a?.computeTier ?? "adopted", gpu: pod.gpuTypeId, dc: pod.dataCenterId, costPerHr: pod.costPerHr, api: pod.api });
	try {
		await transition(db, job, "booting");
	} catch {
		const now_ = await getJob(db, job.id);
		// Another selector run already accepted this same pod: leave it alone.
		if (now_ && !isTerminal(now_.state) && (await activePod(db, job.id))?.id === pod.id) return "skipped";
		// Job was cancelled/failed while we were creating: do not leave the pod running.
		await retirePod(env, db, job.id, pod.id, "job_left_provisioning");
		return "skipped";
	}
	return "created";
}

/**
 * Delete a pod and record the outcome. Confirmed -> deleted_at set. Not confirmed -> stays tracked as
 * "delete pending" (deleted_at NULL, delete_reason set); the watchdog retries it every minute and the reaper
 * every 5 min. Returns whether RunPod confirmed.
 */
export async function retirePod(env: Env, db: D1Database, jobId: string, podId: string, reason: string): Promise<boolean> {
	const ok = await deletePod(env, podId).catch(() => false);
	if (ok) await markPodDeleted(db, podId, reason);
	else {
		await markDeletePending(db, podId, reason);
		await logEvent(db, jobId, "delete_failed", { pod: podId, reason });
	}
	return ok;
}

/** Fail a job: delete its pod, record cost, alert. Safe to call on an already-terminal job. */
export async function failJob(env: Env, db: D1Database, job: JobRow, code: ErrorCode, message: string) {
	const pod = await activePod(db, job.id);
	if (pod) await retirePod(env, db, job.id, pod.id, `failed:${code}`);
	try {
		await transition(db, job, "failed", { code });
	} catch {
		return; // already terminal
	}
	await updateJob(db, job.id, { error_json: JSON.stringify({ code, message }), ...(await jobCost(db, job.id)) });
	await alert(env, db, `job failed: ${code}: ${message}`, job.id);
}
