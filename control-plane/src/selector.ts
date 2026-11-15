// SPEC §8 literally: compute tier OUTER (GPU/SECURE, GPU/COMMUNITY, CPU), region tier inner,
// intersect with the live catalog, skip GPUs with availability NONE, cost check > $2/hr -> DELETE, continue.
import type { Catalog, CreatePodBody, ErrorCode } from "../../packages/contract/src/index";
import { alert } from "./alerts";
import {
	COMPUTE_TIERS, CONSTANTS, CPU_FLAVORS, DEV_DUMMY_IMAGE, EXCLUDED_GPUS, GPU_RANK, REGION_TIERS, getConfig, norm,
} from "./config";
import { activePod, getJob, jobCost, logEvent, markPodDeleted, now, randomId, sha256Hex, updateJob, type JobRow } from "./db";
import { catalog, createPod, deletePod } from "./runpod";
import { faultArg, hasFault } from "./faults";
import { transition } from "./state";

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

/**
 * Rent a pod for `jobId` (state provisioning or retrying). On success: pod recorded, new JOB_TOKEN hash
 * stored (one token per pod, so a replaced pod's token stops working), state -> booting.
 * On no capacity: state -> failed (failed_no_capacity), Telegram alert.
 */
export async function selectAndCreate(
	env: Env, db: D1Database, jobId: string, opts: { rank?: string[]; gpuOnly?: boolean } = {},
): Promise<"created" | "no_capacity" | "skipped"> {
	const job = await getJob(db, jobId);
	if (!job || (job.state !== "provisioning" && job.state !== "retrying")) return "skipped";
	if (await activePod(db, jobId)) return "skipped";

	const rank = opts.rank ?? (await getConfig<string[]>(db, "gpu_rank", GPU_RANK));
	const cat = await catalog(env, db);
	const blocked = faultArg(await hasFault(db, job.id, "block_region"));
	const cap = Number(faultArg(await hasFault(db, job.id, "price_cap")) ?? CONSTANTS.PRICE_CAP_USD_PER_HR);
	const attempts = planAttempts(cat, rank, [...JSON.parse(job.skip_dcs), ...(blocked ? [blocked] : [])]).filter(
		(a) => !opts.gpuOnly || a.computeTier !== "CPU",
	);

	for (const a of attempts) {
		const token = randomId("t_") + randomId("");
		const res = await createPod(env, podBody(env, job, a, token));
		if (!res.ok) {
			await logEvent(db, job.id, "create_failed", { tier: a.computeTier, dcs: a.dataCenterIds, status: res.status, body: res.body.slice(0, 300) });
			continue;
		}
		const pod = res.pod;
		if (pod.costPerHr > cap) {
			await deletePod(env, pod.id);
			await logEvent(db, job.id, "cost_reject", { pod: pod.id, costPerHr: pod.costPerHr, gpu: pod.gpuTypeId });
			continue;
		}
		const t = now();
		await db
			.prepare("INSERT INTO pods (id, job_id, gpu_type_id, data_center_id, cloud_type, compute_type, cost_per_hr, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
			.bind(pod.id, job.id, pod.gpuTypeId, pod.dataCenterId, a.computeTier.split("/")[1] ?? null, a.computeTier === "CPU" ? "CPU" : "GPU", pod.costPerHr, t)
			.run();
		await updateJob(db, job.id, {
			job_token_sha256: await sha256Hex(token),
			token_expires_at: t + job.ttl_min * 60_000,
			gpu_label: `${shortGpu(pod.gpuTypeId)} · ${pod.dataCenterId ?? a.dataCenterIds[0]}`,
		});
		await logEvent(db, job.id, "pod_created", { pod: pod.id, tier: a.computeTier, gpu: pod.gpuTypeId, dc: pod.dataCenterId, costPerHr: pod.costPerHr, api: pod.api });
		try {
			await transition(db, job, "booting");
		} catch {
			// Job was cancelled/failed while we were creating: do not leave the pod running.
			await deletePod(env, pod.id);
			await markPodDeleted(db, pod.id, "job_left_provisioning");
			return "skipped";
		}
		return "created";
	}

	if (job.dev_mode === "bench") {
		await transition(db, job, "cancelled", { reason: "bench_no_capacity" });
		return "no_capacity";
	}
	await failJob(env, db, job, "failed_no_capacity", `no pod in ${attempts.length} attempts`);
	return "no_capacity";
}

/** Fail a job: delete its pod, record cost, alert. Safe to call on an already-terminal job. */
export async function failJob(env: Env, db: D1Database, job: JobRow, code: ErrorCode, message: string) {
	const pod = await activePod(db, job.id);
	if (pod) {
		await deletePod(env, pod.id);
		await markPodDeleted(db, pod.id, `failed:${code}`);
	}
	try {
		await transition(db, job, "failed", { code });
	} catch {
		return; // already terminal
	}
	await updateJob(db, job.id, { error_json: JSON.stringify({ code, message }), ...(await jobCost(db, job.id)) });
	await alert(env, db, `job failed: ${code}: ${message}`, job.id);
}
