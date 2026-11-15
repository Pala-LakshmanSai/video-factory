import { beforeEach, describe, expect, it } from "vitest";
import { GPU_RANK, REGION_TIERS } from "../src/config";
import { getJob } from "../src/db";
import { deletePod, deps, listPods } from "../src/runpod";
import { planAttempts, selectAndCreate } from "../src/selector";
import { L40S, RTX4090, catalogOf, json, makeEnv, mockFetch } from "./helpers";

deps.sleep = async () => {};

describe("planAttempts: §8 ordering", () => {
	it("compute tier is the OUTER loop, region tier inner, nearest first", () => {
		const cat = catalogOf({ "AP-IN-1": { [RTX4090]: "HIGH" }, "EU-RO-1": { [L40S]: "LOW" }, "US-TX-3": { [RTX4090]: "MEDIUM" } });
		const a = planAttempts(cat, GPU_RANK, []);
		expect(a.map((x) => `${x.computeTier} ${x.dataCenterIds.join(",")}`)).toEqual([
			"GPU/SECURE AP-IN-1", "GPU/SECURE EU-RO-1", "GPU/SECURE US-TX-3",
			"GPU/COMMUNITY AP-IN-1", "GPU/COMMUNITY EU-RO-1", "GPU/COMMUNITY US-TX-3",
			"CPU AP-IN-1", "CPU EU-RO-1", "CPU US-TX-3",
		]);
	});

	it("AP-IN-1 empty (absent or all NONE) -> starts at Romania", () => {
		const cat = catalogOf({ "AP-IN-1": { [RTX4090]: "NONE" }, "EU-RO-1": { [RTX4090]: "HIGH" } });
		expect(planAttempts(cat, GPU_RANK, [])[0]).toMatchObject({ computeTier: "GPU/SECURE", dataCenterIds: ["EU-RO-1"] });
		expect(planAttempts(catalogOf({ "EU-RO-1": { [RTX4090]: "HIGH" } }), GPU_RANK, [])[0].dataCenterIds).toEqual(["EU-RO-1"]);
	});

	it("all GPUs NONE everywhere -> only CPU attempts", () => {
		const cat = catalogOf({ "AP-IN-1": { [RTX4090]: "NONE" }, "EU-SE-1": { [L40S]: "NONE" } });
		expect(planAttempts(cat, GPU_RANK, []).map((x) => x.computeTier)).toEqual(["CPU", "CPU"]);
	});

	it("keeps rank order, sends the catalog's exact spelling, drops excluded and skipped", () => {
		const cat = catalogOf({ "EU-SE-1": { "NVIDIA  RTX A4500": "HIGH", [L40S]: "HIGH", "NVIDIA H100 PCIe": "HIGH" }, "EU-RO-1": { [RTX4090]: "HIGH" } });
		const a = planAttempts(cat, [...GPU_RANK, "NVIDIA H100 PCIe"], ["EU-RO-1"]);
		expect(a[0]).toEqual({ computeTier: "GPU/SECURE", dataCenterIds: ["EU-SE-1"], gpuTypeIds: [L40S, "NVIDIA  RTX A4500"] });
	});

	it("expands US-* / CA-MTL-* wildcards against the catalog", () => {
		const cat = catalogOf({ "US-KS-2": { [RTX4090]: "HIGH" }, "CA-MTL-3": { [RTX4090]: "LOW" } });
		expect(planAttempts(cat, GPU_RANK, [], REGION_TIERS)[0].dataCenterIds).toEqual(["US-KS-2", "CA-MTL-3"]);
	});
});

describe("selectAndCreate against a fake RunPod", () => {
	let env: Env;
	beforeEach(async () => {
		env = makeEnv();
		deps.v1Denied = false;
		await env.DB.prepare("INSERT INTO jobs (id, chat_key, state, title, style, voiceover_json, created_at, updated_at) VALUES ('j1','k','provisioning','t','explainer','{\"text\":\"hi\"}',0,0)").run();
	});
	const cat = catalogOf({ "AP-IN-1": { [RTX4090]: "HIGH" }, "EU-RO-1": { [RTX4090]: "HIGH" } });

	it("costPerHr 2.40 -> DELETE and continue to the next attempt", async () => {
		let n = 0;
		const calls = mockFetch(
			(u) => (u.includes("/v2/catalog/datacenters") ? json(cat) : undefined),
			(u, i) => (u.endsWith("/v1/pods") && i.method === "POST" ? json({ id: `p${++n}`, costPerHr: n === 1 ? 2.4 : 0.69, machine: { gpuTypeId: RTX4090, dataCenterId: n === 1 ? "AP-IN-1" : "EU-RO-1" } }, 201) : undefined),
			(u, i) => (i.method === "DELETE" ? new Response(null, { status: 204 }) : undefined),
		);
		expect(await selectAndCreate(env, env.DB, "j1")).toBe("created");
		expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual(["https://api.runpod.io/v2/pods/p1"]);
		const job = (await getJob(env.DB, "j1"))!;
		expect(job.state).toBe("booting");
		expect(job.gpu_label).toBe("RTX 4090 · EU-RO-1");
		expect(job.job_token_sha256).toMatch(/^[0-9a-f]{64}$/);
		const body = calls.find((c) => c.method === "POST")!.body as Record<string, any>;
		expect(body).toMatchObject({ name: "vf-j1", computeType: "GPU", cloudType: "SECURE", gpuTypePriority: "custom", dataCenterPriority: "custom", volumeInGb: 0, ports: [], minVCPUPerGPU: 8 });
		expect(body.env).toMatchObject({ JOB_ID: "j1", CP_URL: "https://cp.test", TTL_MIN: "30", NVIDIA_DRIVER_CAPABILITIES: "compute,utility,video" });
		const kinds = (await env.DB.prepare("SELECT kind FROM events").all<{ kind: string }>()).results.map((e) => e.kind);
		expect(kinds).toEqual(["cost_reject", "pod_created", "state"]);
	});

	it("v1 400 (enum lag on AP-IN-1) -> same attempt retried through v2", async () => {
		const calls = mockFetch(
			(u) => (u.includes("/v2/catalog/datacenters") ? json(cat) : undefined),
			(u) => (u === "https://rest.runpod.io/v1/pods" ? json({ error: "dataCenterIds: invalid enum value AP-IN-1" }, 400) : undefined),
			(u) => (u === "https://api.runpod.io/v2/pods" ? json({ id: "v2pod", cost: 0.59, dataCenterId: "AP-IN-1", gpu: { id: RTX4090, vcpuCount: 16 } }, 201) : undefined),
		);
		expect(await selectAndCreate(env, env.DB, "j1")).toBe("created");
		const v2 = calls.find((c) => c.url === "https://api.runpod.io/v2/pods")!.body as Record<string, any>;
		expect(v2).toMatchObject({ name: "vf-j1", registry: "reg", cloud: "SECURE", dataCenterIds: ["AP-IN-1"], gpu: { id: RTX4090 }, ports: [] });
		expect((await getJob(env.DB, "j1"))!.gpu_label).toBe("RTX 4090 · AP-IN-1");
	});

	it("429 retried with backoff (never processed), then no capacity anywhere -> failed_no_capacity", async () => {
		let posts = 0;
		mockFetch(
			(u) => (u.includes("/v2/catalog/datacenters") ? json(catalogOf({ "EU-RO-1": { [RTX4090]: "HIGH" } })) : undefined),
			(u, i) => (i.method === "POST" && u.includes("runpod") ? (posts++, json({ error: "busy" }, 429)) : undefined),
		);
		expect(await selectAndCreate(env, env.DB, "j1")).toBe("no_capacity");
		expect(posts).toBe(3 * 4); // 3 attempts (SECURE, COMMUNITY, CPU) x (1 + 3 retries)
		const job = (await getJob(env.DB, "j1"))!;
		expect(job.state).toBe("failed");
		expect(JSON.parse(job.error_json!).code).toBe("failed_no_capacity");
	});

	it("create 5xx is never replayed blindly: the pod RunPod made anyway is found by name and adopted", async () => {
		let posts = 0;
		const calls = mockFetch(
			(u) => (u.includes("/v2/catalog/datacenters") ? json(cat) : undefined),
			(u, i) => (u === "https://rest.runpod.io/v1/pods" && i.method === "POST" ? (posts++, json({ error: "gateway" }, 502)) : undefined),
			(u) => (u.startsWith("https://api.runpod.io/v2/pods?") ? json({ pods: [{ id: "made", name: "vf-j1", status: "PROVISIONING", cost: 0.69, dataCenterId: "AP-IN-1", gpu: { id: RTX4090 } }] }) : undefined),
		);
		expect(await selectAndCreate(env, env.DB, "j1")).toBe("created");
		expect(posts).toBe(1);
		expect(calls.some((c) => c.method === "DELETE")).toBe(false);
		const pods = (await env.DB.prepare("SELECT id, cost_per_hr FROM pods").all()).results;
		expect(pods).toEqual([{ id: "made", cost_per_hr: 0.69 }]);
		expect((await getJob(env.DB, "j1"))!.gpu_label).toBe("RTX 4090 · AP-IN-1");
	});

	it("create 5xx with no pod made -> retried after the lookup", async () => {
		let posts = 0;
		mockFetch(
			(u) => (u.includes("/v2/catalog/datacenters") ? json(cat) : undefined),
			(u, i) =>
				u === "https://rest.runpod.io/v1/pods" && i.method === "POST"
					? (++posts === 1 ? json({ error: "oops" }, 500) : json({ id: "p2", costPerHr: 0.69, machine: { gpuTypeId: RTX4090, dataCenterId: "AP-IN-1" } }, 201))
					: undefined,
			(u) => (u.startsWith("https://api.runpod.io/v2/pods?") ? json({ pods: [{ id: "other", name: "vf-someone-else", status: "RUNNING" }] }) : undefined),
		);
		expect(await selectAndCreate(env, env.DB, "j1")).toBe("created");
		expect(posts).toBe(2);
		expect((await env.DB.prepare("SELECT id FROM pods").first<{ id: string }>())!.id).toBe("p2");
	});

	it("v1 REST refuses the key (403) -> v2 per GPU, and later creates skip v1 entirely", async () => {
		let v2n = 0;
		const calls = mockFetch(
			(u) => (u.includes("/v2/catalog/datacenters") ? json(catalogOf({ "AP-IN-1": { [RTX4090]: "HIGH", [L40S]: "HIGH" } })) : undefined),
			(u) => (u === "https://rest.runpod.io/v1/pods" ? json({ error: "forbidden" }, 403) : undefined),
			(u, i) => {
				if (u !== "https://api.runpod.io/v2/pods" || i.method !== "POST") return;
				const b = JSON.parse(i.body as string);
				return b.gpu.id === RTX4090 ? json({ title: "Bad Request", status: 400, detail: "no capacity" }, 400) : json({ id: `v2pod${++v2n}`, cost: 0.8, dataCenterId: "AP-IN-1", gpu: { id: L40S } }, 201);
			},
		);
		expect(await selectAndCreate(env, env.DB, "j1")).toBe("created");
		expect(deps.v1Denied).toBe(true);
		const v2 = calls.filter((c) => c.url === "https://api.runpod.io/v2/pods").map((c) => (c.body as any).gpu.id);
		expect(v2).toEqual([RTX4090, L40S]); // rank order, one GPU type per call
		expect((await getJob(env.DB, "j1"))!.gpu_label).toBe("L40S · AP-IN-1");

		await env.DB.prepare("INSERT INTO jobs (id, chat_key, state, title, style, voiceover_json, created_at, updated_at) VALUES ('j2','k2','provisioning','t','explainer','{}',0,0)").run();
		const before = calls.filter((c) => c.url === "https://rest.runpod.io/v1/pods").length;
		await selectAndCreate(env, env.DB, "j2");
		expect(calls.filter((c) => c.url === "https://rest.runpod.io/v1/pods").length).toBe(before);
	});

	it("CPU tier through v2 sends cpu {id, vcpuCount} per flavor", async () => {
		deps.v1Denied = true;
		const calls = mockFetch(
			(u) => (u.includes("/v2/catalog/datacenters") ? json(catalogOf({ "EU-RO-1": { [RTX4090]: "NONE" } })) : undefined),
			(u, i) => {
				if (u !== "https://api.runpod.io/v2/pods" || i.method !== "POST") return;
				const b = JSON.parse(i.body as string);
				return b.cpu.id === "cpu5c" ? json({ status: 400, detail: "no capacity" }, 400) : json({ id: "cpupod", cost: 0.32, dataCenterId: "EU-RO-1" }, 201);
			},
		);
		expect(await selectAndCreate(env, env.DB, "j1")).toBe("created");
		const bodies = calls.filter((c) => c.url === "https://api.runpod.io/v2/pods").map((c) => (c.body as any).cpu);
		expect(bodies).toEqual([{ id: "cpu5c", vcpuCount: 16 }, { id: "cpu3c", vcpuCount: 16 }]);
		expect((await getJob(env.DB, "j1"))!.gpu_label).toBe("CPU · EU-RO-1");
	});
});

describe("deletePod / listPods", () => {
	const env = makeEnv();
	it("v2 DELETE first; 204 and 404 both count as deleted", async () => {
		mockFetch((u, i) => (u === "https://api.runpod.io/v2/pods/a" && i.method === "DELETE" ? new Response(null, { status: 204 }) : undefined));
		expect(await deletePod(env, "a")).toBe(true);
		mockFetch((u) => (u === "https://api.runpod.io/v2/pods/b" ? json({ status: 404 }, 404) : undefined));
		expect(await deletePod(env, "b")).toBe(true);
	});
	it("v2 refuses the key -> v1 DELETE (old pods / old keys keep working)", async () => {
		const calls = mockFetch(
			(u) => (u === "https://api.runpod.io/v2/pods/c" ? json({ status: 403 }, 403) : undefined),
			(u, i) => (u === "https://rest.runpod.io/v1/pods/c" && i.method === "DELETE" ? json({}) : undefined),
		);
		expect(await deletePod(env, "c")).toBe(true);
		expect(calls.map((c) => c.url)).toEqual(["https://api.runpod.io/v2/pods/c", "https://rest.runpod.io/v1/pods/c"]);
	});
	it("v2 5xx is retried (DELETE is idempotent), then reported as not deleted", async () => {
		let n = 0;
		mockFetch((u) => (u === "https://api.runpod.io/v2/pods/d" ? (n++, json({}, 503)) : undefined));
		expect(await deletePod(env, "d")).toBe(false);
		expect(n).toBe(4);
	});
	it("listPods follows v2 pagination and drops TERMINATED pods", async () => {
		mockFetch((u) =>
			u.startsWith("https://api.runpod.io/v2/pods?")
				? u.includes("cursor=c2")
					? json({ pods: [{ id: "3", name: "vf-b", status: "RUNNING" }], pagination: { nextCursor: null, hasNextPage: false } })
					: json({ pods: [{ id: "1", name: "vf-a", status: "RUNNING", cost: 0.5, createdAt: "2026-11-15T00:00:00Z" }, { id: "2", name: "vf-x", status: "TERMINATED" }], pagination: { nextCursor: "c2", hasNextPage: true } })
				: undefined,
		);
		expect(await listPods(env)).toEqual([
			{ id: "1", name: "vf-a", createdAt: "2026-11-15T00:00:00Z", costPerHr: 0.5 },
			{ id: "3", name: "vf-b", createdAt: undefined, costPerHr: undefined },
		]);
	});
	it("listPods falls back to v1 when v2 refuses the key", async () => {
		mockFetch(
			(u) => (u.startsWith("https://api.runpod.io/v2/pods?") ? json({}, 401) : undefined),
			(u) => (u === "https://rest.runpod.io/v1/pods" ? json([{ id: "9", name: "vf-old" }]) : undefined),
		);
		expect(await listPods(env)).toEqual([{ id: "9", name: "vf-old" }]);
	});
});
