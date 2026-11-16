// Review: stranded jobs (pod gone, job non-terminal), per-row isolation in the watchdog tick, cost re-recorded on
// every confirmed delete, dev-dummy cancel-before-retire, no forced re-render of a verifying job with its upload done.
import { beforeEach, describe, expect, it } from "vitest";
import { getJob } from "../src/db";
import { reaper } from "../src/reaper";
import { deps } from "../src/runpod";
import { watchdog } from "../src/watchdog";
import { RTX4090, catalogOf, json, makeEnv, mockFetch, v2list, v2pod, type Route } from "./helpers";

deps.sleep = async () => {};
const cat = catalogOf({ "AP-IN-1": { [RTX4090]: "HIGH" } });
const MIN = 60_000;
let env: Env;

const job = (id: string, state: string, cols: Record<string, unknown> = {}) => {
	const k = Object.keys(cols);
	return env.DB.prepare(`INSERT INTO jobs (id, chat_key, state, title, style, voiceover_json, created_at, updated_at${k.map((c) => ", " + c).join("")}) VALUES (?, ?, ?, 't', 'explainer', '{}', ?, ?${k.map(() => ", ?").join("")})`)
		.bind(id, `k-${id}`, state, Date.now(), Date.now(), ...Object.values(cols))
		.run();
};
const pod = (id: string, jobId: string, ageMs: number, o: { hello?: number; hb?: number; pending?: string; deleted?: number } = {}) =>
	env.DB.prepare("INSERT INTO pods (id, job_id, cost_per_hr, created_at, hello_at, last_heartbeat_at, delete_reason, deleted_at) VALUES (?, ?, 0.6, ?, ?, ?, ?, ?)")
		.bind(id, jobId, Date.now() - ageMs, o.hello ?? null, o.hb ?? null, o.pending ?? null, o.deleted ?? null)
		.run();
const state = async (id: string) => (await getJob(env.DB, id))!.state;
const silent = (ageMs = 10 * MIN) => ({ hello: Date.now() - ageMs + MIN, hb: Date.now() - 2 * MIN });

const del: Route = (u, i) => (i.method === "DELETE" ? new Response(null, { status: 204 }) : undefined);
const create: Route[] = [
	(u) => (u.includes("/v2/catalog/datacenters") ? json(cat) : undefined),
	(u, i) => (u === "https://rest.runpod.io/v1/pods" && i.method === "POST" ? json({ id: "p2", costPerHr: 0.6, machine: { gpuTypeId: RTX4090, dataCenterId: "AP-IN-1" } }, 201) : undefined),
];

beforeEach(() => {
	env = makeEnv();
	deps.v1Denied = false;
});

describe("stranded jobs are recovered", () => {
	it("1a: replacement loses its compare-and-set to a concurrent /previews -> re-reads and still moves to retrying", async () => {
		await job("j1", "rendering", { plan_json: "{}" });
		await pod("p1", "j1", 10 * MIN, silent());
		mockFetch(async (u, i) => {
			if (i.method !== "DELETE") return undefined;
			await env.DB.prepare("UPDATE jobs SET state = 'preview_ready' WHERE id = 'j1'").run(); // /previews lands mid-replace
			return new Response(null, { status: 204 });
		}, ...create);
		await watchdog(env, env.DB);
		expect(await state("j1")).toBe("booting");
		expect((await getJob(env.DB, "j1"))!.attempts).toBe(1);
	});

	it("1a: the job became terminal meanwhile -> left alone, no new pod", async () => {
		await job("j1", "rendering", { plan_json: "{}" });
		await pod("p1", "j1", 10 * MIN, silent());
		const calls = mockFetch(async (u, i) => {
			if (i.method !== "DELETE") return undefined;
			await env.DB.prepare("UPDATE jobs SET state = 'cancelled' WHERE id = 'j1'").run();
			return new Response(null, { status: 204 });
		}, ...create);
		await watchdog(env, env.DB);
		expect(await state("j1")).toBe("cancelled");
		expect(calls.some((c) => c.method === "POST")).toBe(false);
	});

	it("1b: reaper marks a vanished pod gone before heartbeat loss -> next watchdog tick replaces it", async () => {
		await job("j1", "rendering", { plan_json: "{}" });
		await pod("p1", "j1", 10 * MIN, { hello: Date.now() - 9 * MIN, hb: Date.now() - 20_000 });
		mockFetch((u) => (u.startsWith("https://api.runpod.io/v2/pods?") ? json(v2list([])) : undefined));
		await reaper(env, env.DB);
		mockFetch(...create);
		await watchdog(env, env.DB);
		expect(await state("j1")).toBe("booting");
		expect((await getJob(env.DB, "j1"))!.attempts).toBe(1);
	});

	it("1c: reaper TTL-deletes a live job's pod -> confirmed gone -> replaced like a lost pod (counts toward MAX_REPLACEMENTS)", async () => {
		await job("j1", "rendering", { plan_json: "{}", attempts: 2 });
		await pod("p1", "j1", 40 * MIN, silent(40 * MIN));
		await env.DB.prepare("UPDATE pods SET last_heartbeat_at = ? WHERE id = 'p1'").bind(Date.now() - 10_000).run();
		mockFetch((u) => (u.startsWith("https://api.runpod.io/v2/pods?") ? json(v2list([v2pod({ id: "p1", name: "vf-j1", createdAt: new Date(Date.now() - 40 * MIN).toISOString() })])) : undefined), del);
		await reaper(env, env.DB);
		mockFetch(del, (u) => (u === "https://api.runpod.io/v2/pods/p1" ? json({}, 404) : undefined), ...create);
		await watchdog(env, env.DB);
		const j = (await getJob(env.DB, "j1"))!;
		expect(j.state).toBe("failed"); // third lost pod > MAX_REPLACEMENTS (2)
		expect(JSON.parse(j.error_json!).code).toBe("pod_replacements");
	});

	it("leaves a job alone while its old pod is still delete-pending", async () => {
		await job("j1", "rendering", { plan_json: "{}" });
		await pod("p1", "j1", 10 * MIN, { pending: "reaper:past_ttl" });
		const calls = mockFetch((u, i) => (i.method === "DELETE" ? json({}, 503) : undefined), (u) => (u === "https://api.runpod.io/v2/pods/p1" ? json(v2pod({ id: "p1", name: "vf-j1" })) : undefined), ...create);
		await watchdog(env, env.DB);
		expect(await state("j1")).toBe("rendering");
		expect(calls.some((c) => c.method === "POST")).toBe(false);
	});
});

describe("watchdog tick", () => {
	it("2: one job throwing does not stop the others", async () => {
		await job("bad", "booting", { skip_dcs: "not json" });
		await pod("pb", "bad", 30 * MIN); // boot timeout -> JSON.parse(skip_dcs) throws
		await job("j1", "rendering", { plan_json: "{}" });
		await pod("p1", "j1", 10 * MIN, silent());
		mockFetch(del, ...create);
		await watchdog(env, env.DB);
		expect(await state("j1")).toBe("booting");
	});

	it("5: dev-dummy cleanup cancels the job before deleting its pod", async () => {
		await job("j1", "waiting_for_plan", { dev_mode: "dummy" });
		await pod("p1", "j1", 2 * MIN, { hello: Date.now() - MIN, hb: Date.now() });
		let atDelete: string | undefined;
		mockFetch(async (u, i) => {
			if (i.method !== "DELETE") return undefined;
			atDelete = await state("j1");
			return new Response(null, { status: 204 });
		});
		await watchdog(env, env.DB);
		expect(atDelete).toBe("cancelled");
		expect((await getJob(env.DB, "j1"))!.cost_usd).toBeGreaterThan(0);
	});

	it("6: heartbeat loss on a verifying job whose upload is recorded -> no delete, no re-render", async () => {
		await job("j1", "verifying", { plan_json: "{}", drive_file_id: "f1" });
		await pod("p1", "j1", 10 * MIN, silent());
		const calls = mockFetch();
		await watchdog(env, env.DB);
		expect(calls).toHaveLength(0);
		expect(await state("j1")).toBe("verifying");
	});

	it("6: a verifying job with its upload recorded gets a grace period for /done after its pod went", async () => {
		await job("j1", "verifying", { plan_json: "{}", drive_file_id: "f1" });
		await pod("p1", "j1", 10 * MIN, { deleted: Date.now() - 30_000 });
		mockFetch(...create);
		await watchdog(env, env.DB);
		expect(await state("j1")).toBe("verifying");
		await env.DB.prepare("UPDATE pods SET deleted_at = ? WHERE id = 'p1'").bind(Date.now() - 3 * MIN).run();
		await watchdog(env, env.DB);
		expect(await state("j1")).toBe("booting");
	});
});

describe("cost", () => {
	it("3: a delete confirmed later (watchdog, on direct absence) re-records the job's final cost", async () => {
		await job("j1", "failed", { cost_usd: 0.01 });
		await pod("p1", "j1", 60 * MIN, { pending: "failed:budget" });
		mockFetch(del, (u) => (u === "https://api.runpod.io/v2/pods/p1" ? json({}, 404) : undefined));
		await watchdog(env, env.DB);
		expect((await getJob(env.DB, "j1"))!.cost_usd).toBeCloseTo(0.6, 2);
	});

	it("3: a pod the reaper marks gone re-records the cost of a terminal job", async () => {
		await job("j1", "done", { cost_usd: 0 });
		await pod("p1", "j1", 30 * MIN);
		mockFetch((u) => (u.startsWith("https://api.runpod.io/v2/pods?") ? json(v2list([])) : undefined));
		await reaper(env, env.DB);
		expect((await getJob(env.DB, "j1"))!.cost_usd).toBeCloseTo(0.3, 2);
	});
});
