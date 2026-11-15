// SPEC §6 Contract C. Retries per §8: 429/5xx -> 1 s, 2 s, 4 s + jitter, max 3 retries.
// Checked against docs.runpod.io (2026-11-15):
// - v1 create-pod's dataCenterIds/gpuTypeIds enums lag the catalog (no AP-IN-1, no RTX PRO 4500), so a
//   v1 400 retries the same attempt through POST api.runpod.io/v2/pods (one gpu.id per call).
// - Scoped API keys may be refused by v1 REST entirely (401/403) while v2 works. Any v1 401/403 sends that
//   call to v2, and creates skip v1 for the rest of this isolate's life.
// - Create is not idempotent: a 5xx, a network error or an unreadable 2xx may still have made a pod. Such a
//   create is never replayed and never followed by another candidate. The pod is looked up by its name
//   (vf-{job_id}); found -> adopted, anything else -> "uncertain": the selector holds the job (no replacement)
//   and re-checks later (see selector.ts). A pod that appears after a hold is adopted or reaped.
// - Lists are validated against the v2 OpenAPI contract (ListPodsResponse, Pod); a malformed or incomplete
//   list throws, so the reaper and lookups never act on a partial view.
import type { Catalog, CreatePodBody } from "../../packages/contract/src/index";
import { CONSTANTS } from "./config";
import { now } from "./db";

const REST = "https://rest.runpod.io/v1";
const V2 = "https://api.runpod.io/v2";

/** Swappable in tests. `v1Denied` is set once v1 REST refuses this key. */
export const deps = { sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), v1Denied: false };

/**
 * Provider bodies can echo a pod's env (JOB_TOKEN, CP_URL) or other account data, so they never reach events,
 * alerts or error messages raw: only the problem-detail strings (title/detail/error/message) are kept,
 * token-shaped values are masked, and non-JSON bodies are reduced to their size.
 */
export function safeDetail(text: string): string {
	let j: unknown;
	try {
		j = JSON.parse(text);
	} catch {
		return text ? `<non-JSON body, ${text.length} bytes>` : "";
	}
	const o = (j && typeof j === "object" ? j : {}) as Record<string, unknown>;
	const parts = ["title", "detail", "error", "message"].map((k) => o[k]).filter((v): v is string => typeof v === "string");
	return redact(parts.join(" | ")).slice(0, 200) || "<no detail>";
}
export const redact = (s: string) =>
	s.replace(/\bt_[0-9a-f]{16,}\b/gi, "t_***").replace(/(JOB_TOKEN|RUNPOD_API_KEY|token|secret|password)(["':=\s]+)[^\s"',}]+/gi, "$1$2***");

export class RunPodError extends Error {
	constructor(public status: number, body: string) {
		super(`RunPod ${status}: ${safeDetail(body)}`);
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

/** `uncertain`: RunPod may or may not have made the pod; the caller must not create a replacement. */
export type CreateResult =
	| { ok: true; pod: CreatedPod }
	| { ok: false; status: number; body: string; uncertain?: false }
	| { ok: false; status: number; body: string; uncertain: true };

type Body = CreatePodBody & { dockerStartCmd?: string[] };

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isStr = (x: unknown): x is string => typeof x === "string" && x.length > 0;

/**
 * One create POST, never replayed. 429 is retried inside rp (the request was not processed). A 5xx, a network
 * error or a 2xx we can't read is ambiguous: look the pod up by name; found -> adopt; otherwise uncertain.
 */
async function createNoReplay(env: Env, url: string, payload: unknown, name: string, exclude: string[], parse: (j: unknown) => CreatedPod | null): Promise<CreateResult> {
	let res: Response;
	try {
		res = await rp(env, url, { method: "POST", body: JSON.stringify(payload) }, false);
	} catch (e) {
		return ambiguous(env, name, exclude, 0, `network error: ${redact((e as Error).message).slice(0, 120)}`);
	}
	if (res.status === 200 || res.status === 201) {
		const pod = parse(await res.json().catch(() => null));
		return pod ? { ok: true, pod } : ambiguous(env, name, exclude, res.status, "unreadable create response");
	}
	if (res.status >= 500 || (res.status >= 200 && res.status < 300)) return ambiguous(env, name, exclude, res.status, safeDetail(await res.text()));
	return { ok: false, status: res.status, body: safeDetail(await res.text()) };
}

async function ambiguous(env: Env, name: string, exclude: string[], status: number, body: string): Promise<CreateResult> {
	const found = await lookupPodByName(env, name, exclude);
	if (found.state === "found") return { ok: true, pod: found.pod };
	return { ok: false, status, body: `${body.slice(0, 200)} (lookup: ${found.state})`, uncertain: true };
}

const parseV1 = (j: unknown): CreatedPod | null => {
	const p = j as { id?: unknown; costPerHr?: unknown; machine?: { gpuTypeId?: string; dataCenterId?: string; cpuCount?: number } } | null;
	if (!p || !isStr(p.id)) return null;
	return { id: p.id, costPerHr: isNum(p.costPerHr) ? p.costPerHr : NaN, gpuTypeId: p.machine?.gpuTypeId ?? null, dataCenterId: p.machine?.dataCenterId ?? null, cpuCount: p.machine?.cpuCount ?? null, api: "v1" };
};

/**
 * §6.2 / §6.2b. v1 first (one call covers the whole ranked GPU list); v1 400/401/403 -> the same attempt via v2.
 * `exclude`: pod ids this job already had (a replaced pod keeps the same name until RunPod forgets it).
 */
export async function createPod(env: Env, body: Body, exclude: string[] = []): Promise<CreateResult> {
	if (!deps.v1Denied) {
		const r = await createNoReplay(env, `${REST}/pods`, body, body.name, exclude, parseV1);
		if (r.ok || r.uncertain) return r;
		if (denied(r.status)) deps.v1Denied = true;
		else if (r.status !== 400) return r;
	}
	return createPodV2(env, body, exclude);
}

/** v2 places exactly one GPU type (or CPU flavor) per call: try the ranked candidates in order. */
async function createPodV2(env: Env, body: Body, exclude: string[]): Promise<CreateResult> {
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
		last = await createNoReplay(env, `${V2}/pods`, payload, body.name, exclude, (j) => {
			const p = validPod(j);
			return p ? fromV2(p, want) : null;
		});
		// 400 = this candidate could not be placed (or rule broken): try the next. Success, uncertain or anything else: stop.
		if (last.ok || last.uncertain || last.status !== 400) return last;
	}
	return last;
}

/** Pod per the v2 OpenAPI contract (required: id, name, status, cost, createdAt, …); null if malformed. */
interface V2Pod { id: string; name: string; status: string; cost: number; createdAt: string; dataCenterId?: string | null; gpu?: { id?: string; vcpuCount?: number } | null }
const STATUSES = ["PROVISIONING", "STARTING", "RUNNING", "EXITED", "ERROR", "TERMINATED"];
function validPod(j: unknown): V2Pod | null {
	const p = j as Partial<V2Pod> | null;
	if (!p || typeof p !== "object" || !isStr(p.id) || typeof p.name !== "string" || !STATUSES.includes(p.status as string) || !isNum(p.cost) || typeof p.createdAt !== "string") return null;
	return p as V2Pod;
}
const fromV2 = (p: V2Pod, gpuFallback: string | null = null): CreatedPod => ({
	id: p.id, costPerHr: p.cost, gpuTypeId: p.gpu?.id ?? gpuFallback, dataCenterId: p.dataCenterId ?? null, cpuCount: p.gpu?.vcpuCount ?? null, api: "v2",
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

export interface ListedPod { id: string; name: string; createdAt?: string; costPerHr?: number; dataCenterId?: string | null; gpuTypeId?: string | null }

/** Our own message (never provider content), so it is safe to log as is. */
export class MalformedList extends Error {}
const MAX_PAGES = 50;

/**
 * Every live pod (TERMINATED left out). v2 with cursor pagination, validated against ListPodsResponse; v1 if
 * v2 refuses the key. Throws on any malformed page or an incomplete walk, so callers never act on a partial list.
 */
export async function listPods(env: Env): Promise<ListedPod[]> {
	const out: ListedPod[] = [];
	let cursor: string | null = null;
	for (let page = 0; page < MAX_PAGES; page++) {
		const res = await rp(env, `${V2}/pods?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
		if (denied(res.status) && page === 0) return listPodsV1(env);
		if (!res.ok) throw new RunPodError(res.status, await res.text());
		const j = (await res.json().catch(() => null)) as { pods?: unknown; pagination?: { nextCursor?: unknown; hasNextPage?: unknown } } | null;
		const pg = j?.pagination;
		if (!j || !Array.isArray(j.pods) || !pg || typeof pg.hasNextPage !== "boolean" || !(pg.nextCursor === null || typeof pg.nextCursor === "string")) {
			throw new MalformedList(`malformed ListPodsResponse on page ${page + 1}`);
		}
		for (const raw of j.pods) {
			const p = validPod(raw);
			if (!p) throw new MalformedList(`malformed Pod #${j.pods.indexOf(raw)} on page ${page + 1}`);
			if (p.status === "TERMINATED") continue;
			out.push({ id: p.id, name: p.name, createdAt: p.createdAt, costPerHr: p.cost, dataCenterId: p.dataCenterId ?? null, gpuTypeId: p.gpu?.id ?? null });
		}
		if (!pg.hasNextPage) return out;
		if (!isStr(pg.nextCursor)) throw new MalformedList(`hasNextPage without nextCursor on page ${page + 1}`);
		cursor = pg.nextCursor;
	}
	throw new MalformedList(`pod list longer than ${MAX_PAGES} pages: incomplete`);
}

async function listPodsV1(env: Env): Promise<ListedPod[]> {
	const res = await rp(env, `${REST}/pods`);
	if (!res.ok) throw new RunPodError(res.status, await res.text());
	const j = await res.json().catch(() => null);
	if (!Array.isArray(j) || !j.every((p) => p && isStr(p.id) && typeof p.name === "string")) throw new MalformedList("malformed v1 pod list");
	return j as ListedPod[];
}

export type Lookup = { state: "found"; pod: CreatedPod } | { state: "absent" } | { state: "unknown" };

/**
 * Did RunPod make a pod named `name` (other than the ids in `exclude`)? Exactly one match -> found.
 * A list error, a malformed list or several matches -> unknown. "absent" only means "not listed yet".
 */
export async function lookupPodByName(env: Env, name: string, exclude: string[] = []): Promise<Lookup> {
	let pods: ListedPod[];
	try {
		pods = await listPods(env);
	} catch {
		return { state: "unknown" };
	}
	const hits = pods.filter((p) => p.name === name && !exclude.includes(p.id));
	if (hits.length > 1) return { state: "unknown" };
	if (!hits.length) return { state: "absent" };
	const p = hits[0];
	return { state: "found", pod: { id: p.id, costPerHr: isNum(p.costPerHr) ? p.costPerHr : NaN, gpuTypeId: p.gpuTypeId ?? null, dataCenterId: p.dataCenterId ?? null, cpuCount: null, api: "v2" } };
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
