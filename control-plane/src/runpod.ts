// SPEC §6 Contract C. Retries per §8: 429/5xx -> 1 s, 2 s, 4 s + jitter, max 3 retries.
// Checked against docs.runpod.io (2026-11-15):
// - v1 create-pod's dataCenterIds/gpuTypeIds enums lag the catalog (no AP-IN-1, no RTX PRO 4500), so a
//   v1 400 retries the same attempt through POST api.runpod.io/v2/pods (one gpu.id per call).
// - Scoped API keys may be refused by v1 REST entirely (401/403) while v2 works. Any v1 401/403 sends that
//   call to v2, and creates skip v1 for the rest of this isolate's life.
// - Create is not idempotent: a 5xx after the request reached RunPod may still have made a pod. So a create
//   is never replayed blindly: after a 5xx we look the pod up by its unique name (vf-{job_id}) and adopt it
//   if it exists; only if it doesn't do we retry. A pod that appears later anyway is an orphan the reaper deletes.
import type { Catalog, CreatePodBody } from "../../packages/contract/src/index";
import { CONSTANTS } from "./config";
import { now } from "./db";

const REST = "https://rest.runpod.io/v1";
const V2 = "https://api.runpod.io/v2";

/** Swappable in tests. `v1Denied` is set once v1 REST refuses this key. */
export const deps = { sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), v1Denied: false };

export class RunPodError extends Error {
	constructor(public status: number, public body: string) {
		super(`RunPod ${status}: ${body.slice(0, 300)}`);
	}
}

const denied = (status: number) => status === 401 || status === 403;
const backoff = (attempt: number) => deps.sleep(1000 * 2 ** attempt + Math.random() * 500);

/** Retries 429 always; 5xx only when `replay5xx` (safe for GET/DELETE, never for create). */
export async function rp(env: Env, url: string, init: RequestInit = {}, replay5xx = true): Promise<Response> {
	for (let attempt = 0; ; attempt++) {
		const res = await fetch(url, {
			...init,
			headers: { Authorization: `Bearer ${env.RUNPOD_API_KEY}`, "Content-Type": "application/json", ...init.headers },
		});
		if ((res.status === 429 || (replay5xx && res.status >= 500)) && attempt < CONSTANTS.RUNPOD_RETRIES) {
			await backoff(attempt);
			continue;
		}
		return res;
	}
}

/** §6.1 live catalog, cached 60 s in D1 catalog_cache. */
export async function catalog(env: Env, db: D1Database): Promise<Catalog> {
	const row = await db.prepare("SELECT fetched_at, json FROM catalog_cache WHERE id = 1").first<{ fetched_at: number; json: string }>();
	if (row && now() - row.fetched_at < CONSTANTS.CATALOG_CACHE_S * 1000) return JSON.parse(row.json);
	const res = await rp(env, `${V2}/catalog/datacenters?include=GPU_AVAILABILITY`);
	if (!res.ok) throw new RunPodError(res.status, await res.text());
	const json = (await res.json()) as Catalog;
	await db
		.prepare("INSERT INTO catalog_cache (id, fetched_at, json) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET fetched_at = excluded.fetched_at, json = excluded.json")
		.bind(now(), JSON.stringify(json))
		.run();
	return json;
}

export interface CreatedPod {
	id: string;
	costPerHr: number;
	gpuTypeId: string | null;
	dataCenterId: string | null;
	cpuCount: number | null;
	api: "v1" | "v2";
}

export type CreateResult = { ok: true; pod: CreatedPod } | { ok: false; status: number; body: string };

type Body = CreatePodBody & { dockerStartCmd?: string[] };

/**
 * POST a create without blind replay: on a 5xx, look the pod up by name and adopt it if it exists;
 * otherwise back off and retry (max RUNPOD_RETRIES). 429 is retried inside rp (request was not processed).
 */
async function createNoReplay(env: Env, url: string, payload: unknown, name: string, parse: (r: Response) => Promise<CreatedPod>): Promise<CreateResult> {
	for (let attempt = 0; ; attempt++) {
		const res = await rp(env, url, { method: "POST", body: JSON.stringify(payload) }, false);
		if (res.status === 200 || res.status === 201) return { ok: true, pod: await parse(res) };
		if (res.status < 500) return { ok: false, status: res.status, body: await res.text() };
		const body = await res.text();
		const existing = await findPodByName(env, name).catch(() => null);
		if (existing) return { ok: true, pod: existing };
		if (attempt >= CONSTANTS.RUNPOD_RETRIES) return { ok: false, status: res.status, body };
		await backoff(attempt);
	}
}

/** §6.2 / §6.2b. v1 first (one call covers the whole ranked GPU list); v1 400/401/403 -> the same attempt via v2. */
export async function createPod(env: Env, body: Body): Promise<CreateResult> {
	if (!deps.v1Denied) {
		const r = await createNoReplay(env, `${REST}/pods`, body, body.name, async (res) => {
			const p = (await res.json()) as { id: string; costPerHr: number; machine?: { gpuTypeId?: string; dataCenterId?: string; cpuCount?: number } };
			return { id: p.id, costPerHr: p.costPerHr, gpuTypeId: p.machine?.gpuTypeId ?? null, dataCenterId: p.machine?.dataCenterId ?? null, cpuCount: p.machine?.cpuCount ?? null, api: "v1" };
		});
		if (r.ok) return r;
		if (denied(r.status)) deps.v1Denied = true;
		else if (r.status !== 400) return r;
	}
	return createPodV2(env, body);
}

/** v2 places exactly one GPU type (or CPU flavor) per call: try the ranked candidates in order. */
async function createPodV2(env: Env, body: Body): Promise<CreateResult> {
	const base = {
		name: body.name,
		image: body.imageName,
		registry: body.containerRegistryAuthId,
		dataCenterIds: body.dataCenterIds,
		disk: body.containerDiskInGb,
		env: body.env,
		ports: [],
		...(body.dockerStartCmd?.length ? { cmd: body.dockerStartCmd } : {}),
	};
	const candidates =
		body.computeType === "CPU"
			? (body.cpuFlavorIds ?? []).map((id) => ({ ...base, cpu: { id, vcpuCount: body.vcpuCount ?? 16 } }))
			: (body.gpuTypeIds ?? []).map((id) => ({ ...base, cloud: body.cloudType, gpu: { id, count: 1, minVcpuCountPerGpu: body.minVCPUPerGPU } }));
	let last: CreateResult = { ok: false, status: 400, body: "no candidates" };
	for (const payload of candidates) {
		const want = "gpu" in payload ? payload.gpu.id : null;
		last = await createNoReplay(env, `${V2}/pods`, payload, body.name, async (res) => {
			const p = (await res.json()) as V2Pod;
			return fromV2(p, want);
		});
		if (last.ok) return last;
		// 400 = this candidate could not be placed (or rule broken): try the next one. Anything else: stop.
		if (last.status !== 400) return last;
	}
	return last;
}

interface V2Pod { id: string; name?: string; status?: string; cost?: number; dataCenterId?: string; createdAt?: string; gpu?: { id?: string; vcpuCount?: number } }
const fromV2 = (p: V2Pod, gpuFallback: string | null = null): CreatedPod => ({
	id: p.id, costPerHr: p.cost ?? 0, gpuTypeId: p.gpu?.id ?? gpuFallback, dataCenterId: p.dataCenterId ?? null, cpuCount: p.gpu?.vcpuCount ?? null, api: "v2",
});

/** §6.3. v2 DELETE first (works for pods made by either API); v1 if v2 refuses the key. Gone counts as deleted. */
export async function deletePod(env: Env, podId: string): Promise<boolean> {
	const id = encodeURIComponent(podId);
	const v2 = await rp(env, `${V2}/pods/${id}`, { method: "DELETE" });
	if (v2.ok || v2.status === 404) return true;
	if (!denied(v2.status) && v2.status !== 405) return false;
	const v1 = await rp(env, `${REST}/pods/${id}`, { method: "DELETE" });
	return v1.ok || v1.status === 404;
}

export interface ListedPod { id: string; name: string; createdAt?: string; costPerHr?: number }

/** Every live pod (TERMINATED left out). v2 with pagination; v1 if v2 refuses the key. */
export async function listPods(env: Env): Promise<ListedPod[]> {
	const out: ListedPod[] = [];
	let cursor: string | null = null;
	for (let page = 0; page < 50; page++) {
		const res = await rp(env, `${V2}/pods?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
		if (denied(res.status) && page === 0) return listPodsV1(env);
		if (!res.ok) throw new RunPodError(res.status, await res.text());
		const j = (await res.json()) as { pods: V2Pod[]; pagination?: { nextCursor?: string | null; hasNextPage?: boolean } };
		for (const p of j.pods ?? []) {
			if (p.status === "TERMINATED") continue;
			out.push({ id: p.id, name: p.name ?? "", createdAt: p.createdAt, costPerHr: p.cost });
		}
		if (!j.pagination?.hasNextPage || !j.pagination.nextCursor) return out;
		cursor = j.pagination.nextCursor;
	}
	return out;
}

async function listPodsV1(env: Env): Promise<ListedPod[]> {
	const res = await rp(env, `${REST}/pods`);
	if (!res.ok) throw new RunPodError(res.status, await res.text());
	return (await res.json()) as ListedPod[];
}

/** Used after a create 5xx: did RunPod make the pod anyway? Names are unique per job (vf-{job_id}). */
async function findPodByName(env: Env, name: string): Promise<CreatedPod | null> {
	const res = await rp(env, `${V2}/pods?limit=1000`);
	if (res.ok) {
		const j = (await res.json()) as { pods: V2Pod[] };
		const p = j.pods?.find((x) => x.name === name && x.status !== "TERMINATED");
		return p ? fromV2(p) : null;
	}
	const v1 = await listPodsV1(env);
	const p = v1.find((x) => x.name === name);
	return p ? { id: p.id, costPerHr: p.costPerHr ?? 0, gpuTypeId: null, dataCenterId: null, cpuCount: null, api: "v1" } : null;
}

/** Daily balance check (Phase 7). GraphQL `myself { clientBalance }`. */
export async function balance(env: Env): Promise<number | null> {
	const res = await rp(env, "https://api.runpod.io/graphql", {
		method: "POST",
		body: JSON.stringify({ query: "query { myself { clientBalance } }" }),
	});
	if (!res.ok) return null;
	const j = (await res.json()) as { data?: { myself?: { clientBalance?: number } } };
	return j.data?.myself?.clientBalance ?? null;
}
