import { beforeEach, describe, expect, it } from "vitest";
import { GPU_RANK, REGION_TIERS } from "../src/config";
import { getJob } from "../src/db";
import { deletePod, deps, listPods } from "../src/runpod";
import { UNCERTAIN_GIVE_UP_MS, planAttempts, selectAndCreate } from "../src/selector";
import { L40S, RTX4090, catalogOf, json, makeEnv, mockFetch, v2list, v2pod } from "./helpers";

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
			(u) => (u === "https://api.runpod.io/v2/pods" ? json(v2pod({ id: "v2pod", name: "vf-j1", cost: 0.59, dataCenterId: "AP-IN-1", gpu: { id: RTX4090, vcpuCount: 16 } }), 201) : undefined),
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
			(u) => (u.startsWith("https://api.runpod.io/v2/pods?") ? json(v2list([v2pod({ id: "made", name: "vf-j1", status: "PROVISIONING", cost: 0.69, dataCenterId: "AP-IN-1", gpu: { id: RTX4090 } })])) : undefined),
		);
		expect(await selectAndCreate(env, env.DB, "j1")).toBe("created");
		expect(posts).toBe(1);
		expect(calls.some((c) => c.method === "DELETE")).toBe(false);
		const pods = (await env.DB.prepare("SELECT id, cost_per_hr FROM pods").all()).results;
		expect(pods).toEqual([{ id: "made", cost_per_hr: 0.69 }]);
		expect((await getJob(env.DB, "j1"))!.gpu_label).toBe("RTX 4090 · AP-IN-1");
	});

	it("create 5xx, pod not listed (yet) -> job held: no retry, no next candidate, no replacement", async () => {
		let posts = 0;
		mockFetch(
			(u) => (u.includes("/v2/catalog/datacenters") ? json(cat) : undefined),
			(u, i) => (u.includes("runpod.io/v") && u.endsWith("/pods") && i.method === "POST" ? (posts++, json({ error: "oops" }, 500)) : undefined),
			(u) => (u.startsWith("https://api.runpod.io/v2/pods?") ? json(v2list([v2pod({ id: "other", name: "vf-someone-else" })])) : undefined),
		);
		expect(await selectAndCreate(env, env.DB, "j1")).toBe("held");
		expect(posts).toBe(1);
		const job = (await getJob(env.DB, "j1"))!;
		expect(job.state).toBe("provisioning");
		expect(job.create_uncertain_at).toBeTypeOf("number");
		expect(job.create_claim).toMatch(/^c_/);
		// Watchdog re-runs: still held, still no POST.
		expect(await selectAndCreate(env, env.DB, "j1")).toBe("held");
		expect(posts).toBe(1);
	});

	it("network error on create + lookup fails (list 5xx) -> held, never treated as absent", async () => {
		let posts = 0;
		mockFetch(
			(u) => (u.includes("/v2/catalog/datacenters") ? json(cat) : undefined),
			(u, i) => {
				if (u === "https://rest.runpod.io/v1/pods" && i.method === "POST") {
					posts++;
					throw new TypeError("fetch failed");
				}
			},
			(u) => (u.startsWith("https://api.runpod.io/v2/pods?") ? json({ error: "busy" }, 503) : undefined),
		);
		expect(await selectAndCreate(env, env.DB, "j1")).toBe("held");
		expect(posts).toBe(1);
		const ev = (await env.DB.prepare("SELECT data_json FROM events WHERE kind = 'create_uncertain'").first<{ data_json: string }>())!;
		expect(ev.data_json).toContain("lookup: unknown");
	});

	it("unreadable 201 (Pod missing required fields) -> held, not adopted", async () => {
		mockFetch(
			(u) => (u.includes("/v2/catalog/datacenters") ? json(cat) : undefined),
			(u) => (u === "https://rest.runpod.io/v1/pods" ? json({ error: "x" }, 403) : undefined),
			(u, i) => (u === "https://api.runpod.io/v2/pods" && i.method === "POST" ? json({ id: "p?", cost: 0.5 }, 201) : undefined),
			(u) => (u.startsWith("https://api.runpod.io/v2/pods?") ? json(v2list([])) : undefined),
		);
		expect(await selectAndCreate(env, env.DB, "j1")).toBe("held");
		expect(await env.DB.prepare("SELECT COUNT(*) n FROM pods").first()).toEqual({ n: 0 });
	});

	describe("held job, re-checked by the watchdog", () => {
		const hold = (msAgo: number) => env.DB.prepare("UPDATE jobs SET create_claim = 'c_crashed', create_uncertain_at = ? WHERE id = 'j1'").bind(Date.now() - msAgo).run();

		it("pod shows up in the list -> adopted with the token already stored, no new POST", async () => {
			await hold(60_000);
			await env.DB.prepare("UPDATE jobs SET job_token_sha256 = 'h-before' WHERE id = 'j1'").run();
			const calls = mockFetch((u) => (u.startsWith("https://api.runpod.io/v2/pods?") ? json(v2list([v2pod({ id: "late", name: "vf-j1", cost: 0.7, gpu: { id: RTX4090 } })])) : undefined));
			expect(await selectAndCreate(env, env.DB, "j1")).toBe("created");
			expect(calls.some((c) => c.method === "POST")).toBe(false);
			const job = (await getJob(env.DB, "j1"))!;
			expect(job.state).toBe("booting");
			expect(job.create_claim).toBeNull();
			expect(job.job_token_sha256).toBe("h-before");
		});

		it("a replaced pod with the same name (already known) is not adopted", async () => {
			await env.DB.prepare("INSERT INTO pods (id, job_id, cost_per_hr, created_at, deleted_at) VALUES ('old', 'j1', 0.5, 0, 1)").run();
			await hold(60_000);
			mockFetch((u) => (u.startsWith("https://api.runpod.io/v2/pods?") ? json(v2list([v2pod({ id: "old", name: "vf-j1" })])) : undefined));
			expect(await selectAndCreate(env, env.DB, "j1")).toBe("held");
		});

		it("absent in the list for a long time (14 min) -> STILL held: a negative list never permits a replay", async () => {
			await hold(14 * 60_000);
			const calls = mockFetch(
				(u) => (u.startsWith("https://api.runpod.io/v2/pods?") ? json(v2list([])) : undefined),
				(u) => (u.includes("/v2/catalog/datacenters") ? json(cat) : undefined),
			);
			expect(await selectAndCreate(env, env.DB, "j1")).toBe("held");
			expect(calls.some((c) => c.method === "POST")).toBe(false);
			expect((await getJob(env.DB, "j1"))!.create_claim).toBe("c_crashed");
		});

		it("lookup keeps failing -> still held (unknown is not absent)", async () => {
			await hold(5 * 60_000);
			mockFetch((u) => (u.startsWith("https://api.runpod.io/v2/pods?") ? json({ pods: "nope" }) : undefined));
			expect(await selectAndCreate(env, env.DB, "j1")).toBe("held");
		});

		it("unknown for 15 min -> job failed, no pod created", async () => {
			await hold(UNCERTAIN_GIVE_UP_MS + 1000);
			const calls = mockFetch((u) => (u.startsWith("https://api.runpod.io/v2/pods?") ? json({}, 503) : undefined));
			expect(await selectAndCreate(env, env.DB, "j1")).toBe("no_capacity");
			expect((await getJob(env.DB, "j1"))!.state).toBe("failed");
			expect(calls.some((c) => c.method === "POST")).toBe(false);
		});
	});

	it("cost missing / not a number -> treated as over the cap: tracked, deleted, next attempt", async () => {
		let n = 0;
		mockFetch(
			(u) => (u.includes("/v2/catalog/datacenters") ? json(cat) : undefined),
			(u, i) => (u === "https://rest.runpod.io/v1/pods" && i.method === "POST" ? json(++n === 1 ? { id: "nocost", machine: { gpuTypeId: RTX4090, dataCenterId: "AP-IN-1" } } : { id: "ok", costPerHr: 0.6, machine: { gpuTypeId: RTX4090, dataCenterId: "EU-RO-1" } }, 201) : undefined),
			(u, i) => (i.method === "DELETE" ? new Response(null, { status: 204 }) : undefined),
		);
		expect(await selectAndCreate(env, env.DB, "j1")).toBe("created");
		const rows = (await env.DB.prepare("SELECT id, deleted_at IS NOT NULL AS gone, delete_reason FROM pods ORDER BY id").all()).results;
		expect(rows).toEqual([{ id: "nocost", gone: 1, delete_reason: "cost_invalid" }, { id: "ok", gone: 0, delete_reason: null }]);
	});

	it("over-cap pod whose DELETE fails: tracked as delete-pending and NO replacement is created", async () => {
		let n = 0;
		mockFetch(
			(u) => (u.includes("/v2/catalog/datacenters") ? json(cat) : undefined),
			(u, i) => (u === "https://rest.runpod.io/v1/pods" && i.method === "POST" ? json({ id: `p${++n}`, costPerHr: n === 1 ? 3 : 0.6, machine: { gpuTypeId: RTX4090, dataCenterId: "AP-IN-1" } }, 201) : undefined),
			(u, i) => (i.method === "DELETE" ? json({}, 503) : undefined),
		);
		expect(await selectAndCreate(env, env.DB, "j1")).toBe("held");
		expect(n).toBe(1);
		const p1 = await env.DB.prepare("SELECT deleted_at, delete_reason FROM pods WHERE id = 'p1'").first();
		expect(p1).toEqual({ deleted_at: null, delete_reason: "cost_reject" });
		expect(await selectAndCreate(env, env.DB, "j1")).toBe("held"); // still pending: no POST
		expect(n).toBe(1);
	});

	it("v1 REST refuses the key (403) -> v2 per GPU, and later creates skip v1 entirely", async () => {
		let v2n = 0;
		const calls = mockFetch(
			(u) => (u.includes("/v2/catalog/datacenters") ? json(catalogOf({ "AP-IN-1": { [RTX4090]: "HIGH", [L40S]: "HIGH" } })) : undefined),
			(u) => (u === "https://rest.runpod.io/v1/pods" ? json({ error: "forbidden" }, 403) : undefined),
			(u, i) => {
				if (u !== "https://api.runpod.io/v2/pods" || i.method !== "POST") return;
				const b = JSON.parse(i.body as string);
				return b.gpu.id === RTX4090 ? json({ title: "Bad Request", status: 400, detail: "no capacity" }, 400) : json(v2pod({ id: `v2pod${++v2n}`, name: b.name, cost: 0.8, dataCenterId: "AP-IN-1", gpu: { id: L40S } }), 201);
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
				return b.cpu.id === "cpu5c" ? json({ status: 400, detail: "no capacity" }, 400) : json(v2pod({ id: "cpupod", name: b.name, cost: 0.32, dataCenterId: "EU-RO-1" }), 201);
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
					? json(v2list([v2pod({ id: "3", name: "vf-b", cost: 0.4 })]))
					: json(v2list([v2pod({ id: "1", name: "vf-a" }), v2pod({ id: "2", name: "vf-x", status: "TERMINATED" })], "c2"))
				: undefined,
		);
		expect((await listPods(env)).map((p) => [p.id, p.name, p.costPerHr])).toEqual([["1", "vf-a", 0.5], ["3", "vf-b", 0.4]]);
	});
	for (const [label, page] of [
		["missing pagination", { pods: [] }],
		["hasNextPage without a cursor", { pods: [], pagination: { nextCursor: null, hasNextPage: true } }],
		["pods not an array", { pods: {}, pagination: { nextCursor: null, hasNextPage: false } }],
		["a Pod without cost", { pods: [{ id: "1", name: "vf-a", status: "RUNNING", createdAt: "x" }], pagination: { nextCursor: null, hasNextPage: false } }],
		["a Pod with an unknown status", v2list([v2pod({ id: "1", status: "WEIRD" })])],
	] as const) {
		it(`listPods rejects a malformed page: ${label}`, async () => {
			mockFetch((u) => (u.startsWith("https://api.runpod.io/v2/pods?") ? json(page) : undefined));
			await expect(listPods(env)).rejects.toThrow(/malformed|without nextCursor/);
		});
	}
	it("listPods rejects an endless cursor chain as incomplete", async () => {
		let n = 0;
		mockFetch((u) => (u.startsWith("https://api.runpod.io/v2/pods?") ? json(v2list([], `c${++n}`)) : undefined));
		await expect(listPods(env)).rejects.toThrow(/incomplete/);
	});
	it("listPods falls back to v1 when v2 refuses the key", async () => {
		mockFetch(
			(u) => (u.startsWith("https://api.runpod.io/v2/pods?") ? json({}, 401) : undefined),
			(u) => (u === "https://rest.runpod.io/v1/pods" ? json([{ id: "9", name: "vf-old" }]) : undefined),
		);
		expect(await listPods(env)).toEqual([{ id: "9", name: "vf-old" }]);
	});
});
