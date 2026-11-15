import { beforeEach, describe, expect, it } from "vitest";
import { GPU_RANK, REGION_TIERS } from "../src/config";
import { getJob } from "../src/db";
import { deps } from "../src/runpod";
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
		await env.DB.prepare("INSERT INTO jobs (id, chat_key, state, title, style, voiceover_json, created_at, updated_at) VALUES ('j1','k','provisioning','t','explainer','{\"text\":\"hi\"}',0,0)").run();
	});
	const cat = catalogOf({ "AP-IN-1": { [RTX4090]: "HIGH" }, "EU-RO-1": { [RTX4090]: "HIGH" } });

	it("costPerHr 2.40 -> DELETE and continue to the next attempt", async () => {
		let n = 0;
		const calls = mockFetch(
			(u) => (u.includes("/v2/catalog/datacenters") ? json(cat) : undefined),
			(u, i) => (u.endsWith("/v1/pods") && i.method === "POST" ? json({ id: `p${++n}`, costPerHr: n === 1 ? 2.4 : 0.69, machine: { gpuTypeId: RTX4090, dataCenterId: n === 1 ? "AP-IN-1" : "EU-RO-1" } }, 201) : undefined),
			(u, i) => (i.method === "DELETE" ? json({}) : undefined),
		);
		expect(await selectAndCreate(env, env.DB, "j1")).toBe("created");
		expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual(["https://rest.runpod.io/v1/pods/p1"]);
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

	it("429 retried with backoff, then no capacity anywhere -> failed_no_capacity", async () => {
		let posts = 0;
		mockFetch(
			(u) => (u.includes("/v2/catalog/datacenters") ? json(catalogOf({ "EU-RO-1": { [RTX4090]: "HIGH" } })) : undefined),
			(u, i) => (i.method === "POST" && u.includes("runpod") ? (posts++, json({ error: "busy" }, posts % 4 === 0 ? 500 : 429)) : undefined),
		);
		expect(await selectAndCreate(env, env.DB, "j1")).toBe("no_capacity");
		expect(posts).toBe(3 * 4); // 3 attempts (SECURE, COMMUNITY, CPU) x (1 + 3 retries)
		const job = (await getJob(env.DB, "j1"))!;
		expect(job.state).toBe("failed");
		expect(JSON.parse(job.error_json!).code).toBe("failed_no_capacity");
	});
});
