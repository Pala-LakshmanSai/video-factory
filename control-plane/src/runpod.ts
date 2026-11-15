// SPEC §6 Contract C. Retries per §8: 429/5xx -> 1 s, 2 s, 4 s + jitter, max 3 retries.
// Checked against docs.runpod.io (2026-11-15): v1 create-pod's dataCenterIds/gpuTypeIds enums lag
// the catalog (no AP-IN-1, no RTX PRO 4500), so a v1 400 falls back to POST api.runpod.io/v2/pods
// (one gpu.id per call, `registry` = credential id, `cost` = $/hr).
import type { Catalog, CreatePodBody } from "../../packages/contract/src/index";
import { CONSTANTS } from "./config";
import { now } from "./db";

const REST = "https://rest.runpod.io/v1";
const V2 = "https://api.runpod.io/v2";

/** Swappable in tests. */
export const deps = { sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) };

export class RunPodError extends Error {
	constructor(public status: number, public body: string) {
		super(`RunPod ${status}: ${body.slice(0, 300)}`);
	}
}

export async function rp(env: Env, url: string, init: RequestInit = {}): Promise<Response> {
	for (let attempt = 0; ; attempt++) {
		const res = await fetch(url, {
			...init,
			headers: { Authorization: `Bearer ${env.RUNPOD_API_KEY}`, "Content-Type": "application/json", ...init.headers },
		});
		if ((res.status === 429 || res.status >= 500) && attempt < CONSTANTS.RUNPOD_RETRIES) {
			await deps.sleep(1000 * 2 ** attempt + Math.random() * 500);
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

/** §6.2 / §6.2b. On a v1 400 (enum lag, §9.2) the same attempt is retried through v2 for GPU pods. */
export async function createPod(env: Env, body: CreatePodBody & { dockerStartCmd?: string[] }): Promise<CreateResult> {
	const res = await rp(env, `${REST}/pods`, { method: "POST", body: JSON.stringify(body) });
	if (res.ok) {
		const p = (await res.json()) as {
			id: string; costPerHr: number; adjustedCostPerHr?: number;
			machine?: { gpuTypeId?: string; dataCenterId?: string; cpuCount?: number };
		};
		return {
			ok: true,
			pod: {
				id: p.id,
				costPerHr: p.costPerHr,
				gpuTypeId: p.machine?.gpuTypeId ?? null,
				dataCenterId: p.machine?.dataCenterId ?? null,
				cpuCount: p.machine?.cpuCount ?? null,
				api: "v1",
			},
		};
	}
	const text = await res.text();
	if (res.status !== 400 || body.computeType !== "GPU") return { ok: false, status: res.status, body: text };
	return createPodV2(env, body, text);
}

async function createPodV2(env: Env, body: CreatePodBody & { dockerStartCmd?: string[] }, v1Error: string): Promise<CreateResult> {
	let last: CreateResult = { ok: false, status: 400, body: v1Error };
	for (const gpuId of body.gpuTypeIds ?? []) {
		const res = await rp(env, `${V2}/pods`, {
			method: "POST",
			body: JSON.stringify({
				name: body.name,
				image: body.imageName,
				registry: body.containerRegistryAuthId,
				cloud: body.cloudType,
				dataCenterIds: body.dataCenterIds,
				gpu: { id: gpuId, count: 1, minVcpuCountPerGpu: body.minVCPUPerGPU },
				disk: body.containerDiskInGb,
				env: body.env,
				ports: [],
				...(body.dockerStartCmd?.length ? { cmd: body.dockerStartCmd } : {}),
			}),
		});
		if (res.status === 201) {
			const p = (await res.json()) as { id: string; cost: number; dataCenterId?: string; gpu?: { id?: string; vcpuCount?: number } };
			return {
				ok: true,
				pod: { id: p.id, costPerHr: p.cost, gpuTypeId: p.gpu?.id ?? gpuId, dataCenterId: p.dataCenterId ?? null, cpuCount: p.gpu?.vcpuCount ?? null, api: "v2" },
			};
		}
		last = { ok: false, status: res.status, body: await res.text() };
	}
	return last;
}

/** §6.3. A pod that is already gone counts as deleted. */
export async function deletePod(env: Env, podId: string): Promise<boolean> {
	const res = await rp(env, `${REST}/pods/${encodeURIComponent(podId)}`, { method: "DELETE" });
	return res.ok || res.status === 404;
}

export interface ListedPod { id: string; name: string; createdAt?: string; costPerHr?: number }

export async function listPods(env: Env): Promise<ListedPod[]> {
	const res = await rp(env, `${REST}/pods`);
	if (!res.ok) throw new RunPodError(res.status, await res.text());
	return (await res.json()) as ListedPod[];
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
