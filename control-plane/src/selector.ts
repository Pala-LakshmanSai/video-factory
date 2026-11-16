// SPEC §8 literally: compute tier OUTER (GPU/SECURE, GPU/COMMUNITY, CPU), region tier inner,
// intersect with the live catalog, skip GPUs with availability NONE, cost check > $2/hr -> DELETE, continue.
import { CONSTANTS as C, ttlMinFor, type Catalog, type CreatePodBody, type ErrorCode } from "../../packages/contract/src/index";
import { alert } from "./alerts";
import {
	COMPUTE_TIERS, CONSTANTS, CPU_FLAVORS, DEV_DUMMY_IMAGE, EXCLUDED_GPUS, GPU_RANK, MAX_REPLACEMENTS, REGION_TIERS, getConfig, norm,
} from "./config";
import { activePod, getJob, jobCost, logEvent, markDeletePending, markPodDeleted, now, randomId, sha256Hex, updateJob, type JobRow } from "./db";
import { catalog, createPod, deletePod, lookupPodByName, type CreatedPod } from "./runpod";
import { faultArg, hasFault } from "./faults";
import { IllegalTransition, isTerminal, transition } from "./state";

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
		imageName: dummy ? DEV_DUMMY_IMAGE : (job.renderer_image ?? env.RENDERER_IMAGE),
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
			TTL_MIN: String(Math.max(job.ttl_min, ttlMinFor(C.MAX_VIDEO_MIN * 60))), // backstop only; reaper + token use job.ttl_min
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

/** A held (ambiguous) create unresolved for this long fails the job. It is never replayed automatically. */
export const UNCERTAIN_GIVE_UP_MS = 15 * 60_000;

/**
 * `jobs.create_claim` is a unique token: only the selector run holding it may POST a create for the job.
 * It is taken atomically before the first POST, re-checked before EVERY POST (fence), and cleared only on a
 * definite outcome, fenced on the same token. A claim found set by any other run means a create may have
 * happened: that run only looks the pod up by name. It never POSTs, and a negative list never clears the
 * hold (lists can lag). The hold ends when the pod is found (adopted) or after UNCERTAIN_GIVE_UP_MS (failed).
 * The claim is never granted while the job has an undeleted pod: a contender that passed the "no pod" preflight
 * before another run accepted its pod cannot take a fresh claim and POST a second pod.
 */
async function takeClaim(db: D1Database, jobId: string): Promise<string | null> {
	const c = randomId("c_");
	const r = await db
		.prepare(
			`UPDATE jobs SET create_claim = ?, create_uncertain_at = ? WHERE id = ? AND state IN ('provisioning','retrying') AND create_claim IS NULL
			 AND NOT EXISTS (SELECT 1 FROM pods WHERE job_id = ? AND deleted_at IS NULL)`,
		)
		.bind(c, now(), jobId, jobId)
		.run();
	return r.meta.changes === 1 ? c : null;
}
const holdsClaim = async (db: D1Database, jobId: string, c: string) =>
	(await db.prepare("SELECT create_claim FROM jobs WHERE id = ?").bind(jobId).first<{ create_claim: string | null }>())?.create_claim === c;
const releaseClaimStmt = (db: D1Database, jobId: string, c: string) =>
	db.prepare("UPDATE jobs SET create_claim = NULL, create_uncertain_at = NULL WHERE id = ? AND create_claim = ?").bind(jobId, c);
export const releaseClaim = (db: D1Database, jobId: string, c: string) => releaseClaimStmt(db, jobId, c).run();

/**
 * Rent a pod for `jobId` (state provisioning or retrying). On success: pod recorded, JOB_TOKEN hash stored
 * (one token per selection, so a replaced pod's token stops working), state -> booting.
 * "held": a create's outcome is unknown, or one of this job's pods is not yet confirmed gone. No POST then.
 * No capacity: state -> failed (failed_no_capacity). ADMISSION_ENABLED != "1": nothing is created ("skipped").
 */
export async function selectAndCreate(
	env: Env, db: D1Database, jobId: string, opts: { rank?: string[]; gpuOnly?: boolean } = {},
): Promise<"created" | "no_capacity" | "skipped" | "held"> {
	const job = await getJob(db, jobId);
	if (!job || (job.state !== "provisioning" && job.state !== "retrying")) return "skipped";
	const capArg = Number(faultArg(await hasFault(db, job.id, "price_cap")));
	// Never above the spec cap, never NaN (a NaN cap would make every "cost > cap" check false).
	const cap = Number.isFinite(capArg) && capArg > 0 ? Math.min(capArg, CONSTANTS.PRICE_CAP_USD_PER_HR) : CONSTANTS.PRICE_CAP_USD_PER_HR;
	const live = await activePod(db, jobId);
	if (live) {
		// Accepted pod recorded but the job never reached booting (the run died between the pod INSERT and the
		// booting compare-and-set): finish the acceptance from the recorded row. A concurrent accept of the same
		// pod is harmless (one CAS wins, the other sees booting and leaves it). No claim can be taken meanwhile.
		const r = await accept(env, db, job, { id: live.id, costPerHr: live.cost_per_hr, gpuTypeId: live.gpu_type_id, dataCenterId: live.data_center_id, cpuCount: null, api: "v2" }, null, cap, job.create_claim);
		if (r === "rejected" && job.create_claim) await releaseClaim(db, job.id, job.create_claim);
		return r === "created" ? "created" : r === "rejected_pending" ? "held" : "skipped";
	}
	const pods = (await db.prepare("SELECT id, deleted_at FROM pods WHERE job_id = ?").bind(jobId).all<{ id: string; deleted_at: number | null }>()).results;
	const known = pods.map((r) => r.id);
	const undeleted = pods.filter((r) => r.deleted_at === null).length; // delete-pending pods of this job

	if (job.create_claim) {
		if (!job.create_uncertain_at) {
			// Claim without a clock (should not happen): start it now rather than give up immediately.
			job.create_uncertain_at = now();
			await db.prepare("UPDATE jobs SET create_uncertain_at = ? WHERE id = ? AND create_uncertain_at IS NULL").bind(job.create_uncertain_at, job.id).run();
		}
		const age = now() - job.create_uncertain_at;
		const found = await lookupPodByName(env, `vf-${job.id}`, known);
		await logEvent(db, job.id, "create_hold_check", { lookup: found.state, age_s: Math.round(age / 1000), undeleted });
		if (found.state === "found") {
			const r = await accept(env, db, job, found.pod, null, cap, job.create_claim);
			if (r === "created" || r === "skipped") return r;
			if (r === "rejected_pending") return "held";
			// Adopted pod was over the cap and is confirmed gone: the ambiguity is resolved, a fresh selection may follow.
			await releaseClaim(db, job.id, job.create_claim);
			job.create_claim = null;
		} else if (age >= UNCERTAIN_GIVE_UP_MS) {
			await failJob(env, db, job, "failed_no_capacity", `create outcome still unknown after ${Math.round(age / 60000)} min`);
			return "no_capacity";
		} else {
			return "held"; // absent or unknown: never replay
		}
	}
	if (undeleted > 0) return "held"; // never start a replacement while an old pod may still be running

	await db.prepare("UPDATE jobs SET admission_at = ? WHERE id = ?").bind(now(), job.id).run();
	if (String(env.ADMISSION_ENABLED) !== "1") {
		await logEvent(db, job.id, "admission_disabled", {});
		return "skipped";
	}

	// Read-only preparation BEFORE taking the claim: a catalog outage must not leave a claim (a hold) behind.
	const rank = opts.rank ?? (await getConfig<string[]>(db, "gpu_rank", GPU_RANK));
	let cat;
	try {
		cat = await catalog(env, db);
	} catch (e) {
		await logEvent(db, job.id, "catalog_failed", { error: String((e as Error).message).slice(0, 200) });
		return "skipped"; // the watchdog retries from admission_at; nothing was claimed or created
	}
	const blocked = faultArg(await hasFault(db, job.id, "block_region"));

	const first = await takeClaim(db, job.id);
	if (!first) return "held";
	let c: string = first;

	// Defense in depth, from the row as it is now that we hold the claim (not the snapshot above): never rent past
	// the replacement cap, never in a data center this job must skip.
	const fresh = await getJob(db, job.id);
	if (!fresh || (fresh.state !== "provisioning" && fresh.state !== "retrying")) {
		await releaseClaim(db, job.id, c);
		return "skipped";
	}
	Object.assign(job, fresh);
	if (job.attempts > MAX_REPLACEMENTS) {
		await releaseClaim(db, job.id, c);
		await failJob(env, db, job, "pod_replacements", `${job.attempts} pods lost`);
		return "no_capacity";
	}
	const attempts = planAttempts(cat, rank, [...JSON.parse(job.skip_dcs), ...(blocked ? [blocked] : [])]).filter(
		(a) => !opts.gpuOnly || a.computeTier !== "CPU",
	);

	// One token per selection, stored BEFORE any create: a pod adopted after an uncertain create already
	// carries this token in its env, so its /hello must verify.
	const token = randomId("t_") + randomId("");
	await updateJob(db, job.id, { job_token_sha256: await sha256Hex(token), token_expires_at: now() + job.ttl_min * 60_000 });

	for (const a of attempts) {
		// Fence: re-checked immediately before EVERY provider POST (v2 makes one POST per GPU type).
		const res = await createPod(env, podBody(env, job, a, token), known, () => holdsClaim(db, job.id, c));
		if (!res.ok && res.fenced) {
			await logEvent(db, job.id, "claim_lost", { tier: a.computeTier });
			return "held"; // someone else owns admission now; no more POSTs from this run
		}
		if (!res.ok && res.uncertain) {
			// Keep the claim (that IS the hold); restart its clock at the moment the outcome became unknown.
			await db.prepare("UPDATE jobs SET create_uncertain_at = ? WHERE id = ? AND create_claim = ?").bind(now(), job.id, c).run();
			await logEvent(db, job.id, "create_uncertain", { tier: a.computeTier, dcs: a.dataCenterIds, status: res.status, detail: res.body });
			await alert(env, db, "pod create outcome unknown: job held, no replacement until resolved", job.id);
			return "held";
		}
		if (!res.ok) {
			await logEvent(db, job.id, "create_failed", { tier: a.computeTier, dcs: a.dataCenterIds, status: res.status, detail: res.body });
			continue;
		}
		known.push(res.pod.id);
		const r = await accept(env, db, job, res.pod, a, cap, c);
		if (r === "rejected") {
			// accept() released claim c with the rejected pod's INSERT (that generation is over). The pod is confirmed
			// gone, so a fresh claim (same no-undeleted-pod fence) may continue to the next attempt.
			const next = await takeClaim(db, job.id);
			if (!next) return "held";
			c = next;
			continue;
		}
		if (r === "rejected_pending") return "held";
		return r;
	}

	await releaseClaim(db, job.id, c);
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
async function accept(env: Env, db: D1Database, job: JobRow, pod: CreatedPod, a: Attempt | null, cap: number, c: string | null): Promise<"created" | "rejected" | "rejected_pending" | "skipped"> {
	const t = now();
	const compute = a ? (a.computeTier === "CPU" ? "CPU" : "GPU") : pod.gpuTypeId ? "GPU" : null;
	const costOk = Number.isFinite(pod.costPerHr) && pod.costPerHr >= 0;
	const reject = !costOk || pod.costPerHr > cap ? (costOk ? "cost_reject" : "cost_invalid") : null;
	// A rejected pod is recorded already delete-pending (same statement): its row never looks like an active,
	// valid-priced pod, so a crash before the DELETE leaves it to the pending-delete retry, never to repair/boot.
	// Its create is resolved, so claim c is released in the SAME batch: no crash can leave a stale claim behind
	// (that would read as an ambiguous create and fail the job). The undeleted pod alone holds further admission.
	const insert = db
		.prepare("INSERT OR IGNORE INTO pods (id, job_id, gpu_type_id, data_center_id, cloud_type, compute_type, cost_per_hr, created_at, delete_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
		.bind(pod.id, job.id, pod.gpuTypeId, pod.dataCenterId, a?.computeTier.split("/")[1] ?? null, compute, Number.isFinite(pod.costPerHr) ? pod.costPerHr : CONSTANTS.PRICE_CAP_USD_PER_HR, t, reject);
	if (reject && c) await db.batch([insert, releaseClaimStmt(db, job.id, c)]);
	else await insert.run();
	if (reject) {
		await logEvent(db, job.id, "cost_reject", { pod: pod.id, costPerHr: Number.isFinite(pod.costPerHr) ? pod.costPerHr : String(pod.costPerHr), reason: costOk ? "over_cap" : "cost_invalid", gpu: pod.gpuTypeId });
		const gone = await retirePod(env, db, job.id, pod.id, reject);
		// Not confirmed gone: the pending delete keeps the job held (`undeleted` gate) until it is.
		return gone ? "rejected" : "rejected_pending";
	}
	// booting + claim release in ONE compare-and-set (fenced on state and claim): no window where the claim is
	// free but the job still looks admissible. The pod INSERT above is separate; selectAndCreate repairs that gap.
	const from = job.state;
	const done = await db
		.prepare("UPDATE jobs SET state = 'booting', gpu_label = ?, create_claim = NULL, create_uncertain_at = NULL, updated_at = ? WHERE id = ? AND state = ? AND state IN ('provisioning','retrying') AND create_claim IS ?")
		.bind(`${shortGpu(pod.gpuTypeId)} · ${pod.dataCenterId ?? a?.dataCenterIds[0] ?? "?"}`, now(), job.id, from, c)
		.run();
	if (done.meta.changes) {
		job.state = "booting";
		await logEvent(db, job.id, "pod_created", { pod: pod.id, tier: a?.computeTier ?? "adopted", gpu: pod.gpuTypeId, dc: pod.dataCenterId, costPerHr: pod.costPerHr, api: pod.api });
		await logEvent(db, job.id, "state", { from, to: "booting" });
	} else {
		if (c) await releaseClaim(db, job.id, c);
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
/**
 * Record the failure (state, error, cost, alert) FIRST, delete the pod LAST. Called from the pod's own
 * requests (/error, /upload-session, /done), deleting the pod kills the agent and Workers then cancel the
 * handler, so anything after the delete may never run. `defer` (waitUntil) keeps the delete alive.
 */
export async function failJob(
	env: Env, db: D1Database, job: JobRow, code: ErrorCode, message: string, defer: (p: Promise<unknown>) => void = () => {},
) {
	const pod = await activePod(db, job.id);
	// A lost compare-and-set (stale `job`: a concurrent /hello or /previews moved it) re-reads and retries;
	// only a job that is (or became) terminal is left as is. Its pod still goes either way.
	let recorded = false;
	for (let cur: JobRow | null = job, i = 0; cur && !isTerminal(cur.state) && i < 20; i++) {
		try {
			await transition(db, cur, "failed", { code });
			recorded = true;
			job.state = "failed";
			break;
		} catch (e) {
			if (!(e instanceof IllegalTransition)) throw e;
			cur = await getJob(db, job.id);
		}
	}
	if (recorded) {
		await updateJob(db, job.id, { error_json: JSON.stringify({ code, message }), ...(await jobCost(db, job.id)) });
		await alert(env, db, `job failed: ${code}: ${message}`, job.id);
	}
	if (pod) {
		const retire = retirePod(env, db, job.id, pod.id, `failed:${code}`).then(async () => {
			if (recorded) await updateJob(db, job.id, await jobCost(db, job.id));
		});
		defer(retire);
		await retire;
	}
}
