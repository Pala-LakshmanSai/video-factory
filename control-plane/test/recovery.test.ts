// Review: stranded jobs (pod gone, job non-terminal), per-row isolation in the watchdog tick, cost re-recorded on
// every confirmed delete, dev-dummy cancel-before-retire, no forced re-render of a verifying job with its upload done.
import { beforeEach, describe, expect, it } from "vitest";
import { getJob, markPodDeleted } from "../src/db";
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

	it("6: heartbeat loss on a verifying job whose upload was just recorded -> no delete, no re-render", async () => {
		await job("j1", "verifying", { plan_json: "{}", drive_file_id: "f1" });
		await verifyingSince(30_000);
		await pod("p1", "j1", 10 * MIN, silent());
		const calls = mockFetch();
		await watchdog(env, env.DB);
		expect(calls).toHaveLength(0);
		expect(await state("j1")).toBe("verifying");
	});

	const verifyingSince = (msAgo: number) =>
		env.DB.prepare("INSERT INTO events (job_id, ts, kind, data_json) VALUES ('j1', ?, 'state', ?)")
			.bind(Date.now() - msAgo, JSON.stringify({ from: "uploading", to: "verifying" })).run();
	const upload = { drive_file_id: "f1", md5: "abc", size: 100, plan_json: "{}" };
	const drive = (meta: () => Response): Route[] => [
		(u) => (u === "https://oauth2.googleapis.com/token" ? json({ access_token: "at", expires_in: 3599 }) : undefined),
		(u) => (u.includes("/files/f1/permissions") ? json({ id: "anyone" }) : undefined),
		(u) => (u.includes("/files/f1?") ? meta() : undefined),
	];

	it("6: within the grace after entering verifying, a gone pod is left alone (the pod's /done may be running)", async () => {
		await job("j1", "verifying", upload);
		await verifyingSince(30_000);
		await pod("p1", "j1", 10 * MIN, { deleted: Date.now() - 30_000 });
		const calls = mockFetch();
		await watchdog(env, env.DB);
		expect(calls).toHaveLength(0);
		expect(await state("j1")).toBe("verifying");
	});

	it("4: after the grace, a dead tracked pod on a verifying job -> server-side verify of the persisted upload -> done, no re-render", async () => {
		await job("j1", "verifying", upload);
		await verifyingSince(5 * MIN);
		await pod("p1", "j1", 20 * MIN, silent(20 * MIN));
		const calls = mockFetch(del, ...drive(() => json({ size: "100", md5Checksum: "abc", webViewLink: "https://drive.test/f1" })), ...create);
		await watchdog(env, env.DB);
		const j = (await getJob(env.DB, "j1"))!;
		expect(j.state).toBe("done");
		expect(j.drive_link).toBe("https://drive.test/f1");
		expect(calls.some((c) => c.method === "POST" && c.url.includes("runpod"))).toBe(false);
	});

	it("4: verify keeps erroring -> stays verifying until VERIFY_GIVE_UP, then the pod is replaced (never stranded)", async () => {
		await job("j1", "verifying", upload);
		await verifyingSince(5 * MIN);
		await pod("p1", "j1", 30 * MIN, silent(30 * MIN));
		mockFetch(del, ...drive(() => json({ error: "backend" }, 500)), ...create);
		await watchdog(env, env.DB);
		expect(await state("j1")).toBe("verifying");
		await env.DB.prepare("UPDATE events SET ts = ? WHERE kind = 'state'").bind(Date.now() - 16 * MIN).run();
		await watchdog(env, env.DB);
		expect(await state("j1")).toBe("booting");
	});

	it("3: overlapping ticks: a stale recovery after the replacement p2 was accepted is a no-op", async () => {
		await job("j1", "rendering", { plan_json: "{}" });
		await pod("p1", "j1", 10 * MIN, silent());
		const calls = mockFetch(async (u, i) => {
			if (i.method !== "DELETE") return undefined;
			// Tick A finished while this (stale) tick B was deleting p1: p1 gone, p2 accepted, job booting, attempts 1.
			await env.DB.prepare("UPDATE pods SET deleted_at = ?, delete_reason = 'heartbeat_lost' WHERE id = 'p1'").bind(Date.now()).run();
			await pod("p2", "j1", 0);
			await env.DB.prepare("UPDATE jobs SET state = 'booting', attempts = 1 WHERE id = 'j1'").run();
			return new Response(null, { status: 204 });
		}, ...create);
		await watchdog(env, env.DB);
		const j = (await getJob(env.DB, "j1"))!;
		expect(j.state).toBe("booting");
		expect(j.attempts).toBe(1);
		expect((await env.DB.prepare("SELECT deleted_at, delete_reason FROM pods WHERE id = 'p2'").first())).toEqual({ deleted_at: null, delete_reason: null });
		expect(calls.some((c) => c.method === "POST")).toBe(false);
	});

	it("1: a /done claim landing during the DELETE is left to verify (no re-render); a later tick verifies it -> done", async () => {
		await job("j1", "uploading", { plan_json: "{}" });
		await pod("p1", "j1", 20 * MIN, silent(20 * MIN));
		const calls = mockFetch(async (u, i) => {
			if (i.method !== "DELETE") return undefined;
			await env.DB.prepare("UPDATE jobs SET state = 'verifying', drive_file_id = 'f1', md5 = 'abc', size = 100 WHERE id = 'j1'").run();
			await verifyingSince(0);
			return new Response(null, { status: 204 });
		}, ...drive(() => json({ size: "100", md5Checksum: "abc", webViewLink: "https://drive.test/f1" })), ...create);
		await watchdog(env, env.DB);
		expect(await state("j1")).toBe("verifying");
		expect(calls.some((c) => c.method === "POST")).toBe(false);
		await env.DB.prepare("UPDATE events SET ts = ? WHERE kind = 'state'").bind(Date.now() - 3 * MIN).run();
		await watchdog(env, env.DB);
		expect(await state("j1")).toBe("done");
		expect(calls.some((c) => c.method === "POST" && c.url.includes("runpod"))).toBe(false);
	});

	it("2: verifying event missing -> grace counts from the pod's last heartbeat, not updated_at (refreshed by cost writes)", async () => {
		await job("j1", "verifying", upload);
		await pod("p1", "j1", 20 * MIN, { hello: Date.now() - 19 * MIN, hb: Date.now() - 3 * MIN, deleted: Date.now() - 30_000 });
		mockFetch(...drive(() => json({ size: "100", md5Checksum: "abc", webViewLink: "https://drive.test/f1" })), ...create);
		await watchdog(env, env.DB);
		expect(await state("j1")).toBe("done");
	});

	it("2: the per-tick cost write does not bump updated_at", async () => {
		await job("j1", "rendering", { plan_json: "{}" });
		await env.DB.prepare("UPDATE jobs SET updated_at = 1 WHERE id = 'j1'").run();
		await pod("p1", "j1", 10 * MIN, { hello: Date.now() - 9 * MIN, hb: Date.now() });
		mockFetch();
		await watchdog(env, env.DB);
		const j = (await getJob(env.DB, "j1"))!;
		expect(j.cost_usd).toBeGreaterThan(0);
		expect(j.updated_at).toBe(1);
	});
});

describe("recovery publishes its constraints atomically", () => {
	const twoDcs = catalogOf({ "AP-IN-1": { [RTX4090]: "HIGH" }, "EU-RO-1": { [RTX4090]: "HIGH" } });

	it("1: boot timeout -> the first admission to see retrying already sees the failed DC in skip_dcs", async () => {
		await job("j1", "booting");
		await pod("p1", "j1", 30 * MIN);
		await env.DB.prepare("UPDATE pods SET data_center_id = 'AP-IN-1' WHERE id = 'p1'").run();
		// Snapshot the row right after the first statement that makes 'retrying' visible: that is the earliest moment an
		// overlapping tick's admission could read it.
		let seen: { state: string; skip: string } | null = null;
		const raw = env.DB.prepare.bind(env.DB);
		(env.DB as { prepare: unknown }).prepare = (sql: string) => {
			const wrap = (st: D1PreparedStatement): D1PreparedStatement =>
				Object.assign(Object.create(st), {
					bind: (...a: unknown[]) => wrap(st.bind(...a)),
					run: async () => {
						const r = await st.run();
						const j = (await raw("SELECT state, skip_dcs FROM jobs WHERE id = 'j1'").first()) as { state: string; skip_dcs: string };
						if (!seen && j.state === "retrying") seen = { state: j.state, skip: j.skip_dcs };
						return r;
					},
				});
			return wrap(raw(sql));
		};
		const calls = mockFetch(del, (u) => (u.includes("/v2/catalog/datacenters") ? json(twoDcs) : undefined), create[1]);
		await watchdog(env, env.DB);
		expect(seen).toEqual({ state: "retrying", skip: '["AP-IN-1"]' });
		const post = calls.find((c) => c.method === "POST")!.body as { dataCenterIds: string[] };
		expect(post.dataCenterIds).toEqual(["EU-RO-1"]);
	});

	it("1: a lost pod at the cap goes straight to failed (never published as retrying), so no admission can rent", async () => {
		await job("j1", "rendering", { plan_json: "{}", attempts: 2 });
		await pod("p1", "j1", 10 * MIN, silent());
		const calls = mockFetch(del, ...create);
		await watchdog(env, env.DB);
		const j = (await getJob(env.DB, "j1"))!;
		expect(j.state).toBe("failed");
		expect(j.attempts).toBe(3);
		expect(JSON.parse(j.error_json!).code).toBe("pod_replacements");
		const states = (await env.DB.prepare("SELECT data_json FROM events WHERE kind = 'state'").all<{ data_json: string }>()).results.map((e) => JSON.parse(e.data_json).to);
		expect(states).not.toContain("retrying");
		expect(calls.some((c) => c.method === "POST")).toBe(false);
	});
});

describe("cost", () => {
	it("3: the reaper reconciles a lost cost write of a job that ended in the last 24 h", async () => {
		await job("j1", "done", { cost_usd: 0 });
		await pod("p1", "j1", 60 * MIN, { deleted: Date.now() - 30 * MIN });
		await job("old", "done", { cost_usd: 0 });
		await env.DB.prepare("UPDATE jobs SET updated_at = ? WHERE id = 'old'").bind(Date.now() - 25 * 3600_000).run();
		await pod("po", "old", 60 * MIN, { deleted: Date.now() - 30 * MIN });
		mockFetch((u) => (u.startsWith("https://api.runpod.io/v2/pods?") ? json(v2list([])) : undefined));
		await reaper(env, env.DB);
		expect((await getJob(env.DB, "j1"))!.cost_usd).toBeCloseTo(0.3, 2);
		expect((await getJob(env.DB, "old"))!.cost_usd).toBe(0);
	});

	it("3: a delete confirmed later (watchdog, on direct absence) re-records the job's final cost", async () => {
		await job("j1", "failed", { cost_usd: 0.01 });
		await pod("p1", "j1", 60 * MIN, { pending: "failed:budget" });
		mockFetch(del, (u) => (u === "https://api.runpod.io/v2/pods/p1" ? json({}, 404) : undefined));
		await watchdog(env, env.DB);
		expect((await getJob(env.DB, "j1"))!.cost_usd).toBeCloseTo(0.6, 2);
	});

	it("5: markPodDeleted on an already-deleted pod still reconciles a cost write that was lost earlier", async () => {
		await job("j1", "done", { cost_usd: 0 });
		await pod("p1", "j1", 60 * MIN, { deleted: Date.now() - 30 * MIN });
		await markPodDeleted(env.DB, "p1", "done");
		expect((await getJob(env.DB, "j1"))!.cost_usd).toBeCloseTo(0.3, 2);
		expect((await env.DB.prepare("SELECT delete_reason FROM pods WHERE id = 'p1'").first<{ delete_reason: string | null }>())!.delete_reason).toBeNull();
	});

	it("3: a pod the reaper marks gone re-records the cost of a terminal job", async () => {
		await job("j1", "done", { cost_usd: 0 });
		await pod("p1", "j1", 30 * MIN);
		mockFetch((u) => (u.startsWith("https://api.runpod.io/v2/pods?") ? json(v2list([])) : undefined));
		await reaper(env, env.DB);
		expect((await getJob(env.DB, "j1"))!.cost_usd).toBeCloseTo(0.3, 2);
	});
});
