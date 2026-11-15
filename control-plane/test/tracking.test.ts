// Review findings on 4763b20: create claim before POST, held-job scanning, pods kept tracked when a delete is
// not confirmed, reaper grace for young/held untracked pods, no raw provider JSON in diagnostics.
import { beforeEach, describe, expect, it } from "vitest";
import { getJob } from "../src/db";
import { reaper } from "../src/reaper";
import { deps, listPods, safeDetail } from "../src/runpod";
import { UNCERTAIN_GRACE_MS, selectAndCreate } from "../src/selector";
import { watchdog } from "../src/watchdog";
import { RTX4090, catalogOf, json, makeEnv, mockFetch, v2list, v2pod } from "./helpers";

deps.sleep = async () => {};
const cat = catalogOf({ "AP-IN-1": { [RTX4090]: "HIGH" }, "EU-RO-1": { [RTX4090]: "HIGH" } });
const MIN = 60_000;
let env: Env;

async function job(id: string, state = "provisioning", extra = "") {
	await env.DB.prepare(`INSERT INTO jobs (id, chat_key, state, title, style, voiceover_json, created_at, updated_at${extra ? ", " + extra.split("=")[0] : ""}) VALUES (?, ?, ?, 't', 'explainer', '{}', ?, ?${extra ? ", " + extra.split("=")[1] : ""})`)
		.bind(id, `k-${id}`, state, Date.now(), Date.now())
		.run();
}
const pod = (id: string, jobId: string, ageMs: number, extra: Record<string, unknown> = {}) =>
	env.DB.prepare("INSERT INTO pods (id, job_id, cost_per_hr, created_at, hello_at, last_heartbeat_at, delete_reason) VALUES (?, ?, 0.6, ?, ?, ?, ?)")
		.bind(id, jobId, Date.now() - ageMs, (extra.hello as number) ?? null, (extra.hb as number) ?? null, (extra.pending as string) ?? null)
		.run();
const row = (id: string) => env.DB.prepare("SELECT deleted_at, delete_reason FROM pods WHERE id = ?").bind(id).first<{ deleted_at: number | null; delete_reason: string | null }>();

beforeEach(() => {
	env = makeEnv();
	deps.v1Denied = false;
});

describe("create claim is taken before any POST", () => {
	it("two selector runs racing (acquire's waitUntil + watchdog): exactly one POST", async () => {
		await job("j1");
		let posts = 0;
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		mockFetch(
			(u) => (u.includes("/v2/catalog/datacenters") ? json(cat) : undefined),
			async (u, i) => (u === "https://rest.runpod.io/v1/pods" && i.method === "POST" ? (posts++, await gate, json({ id: "p1", costPerHr: 0.6, machine: { gpuTypeId: RTX4090, dataCenterId: "AP-IN-1" } }, 201)) : undefined),
			(u) => (u.startsWith("https://api.runpod.io/v2/pods?") ? json(v2list([])) : undefined),
		);
		const first = selectAndCreate(env, env.DB, "j1");
		await new Promise((r) => setTimeout(r, 20)); // first run is now inside its POST
		const second = await selectAndCreate(env, env.DB, "j1");
		release();
		expect(await first).toBe("created");
		expect(second).toBe("held");
		expect(posts).toBe(1);
		expect((await getJob(env.DB, "j1"))!.create_uncertain_at).toBeNull();
	});

	it("a claim left by a crashed run (no pod row) -> held, lookup only, no POST", async () => {
		await job("j1", "provisioning", `create_uncertain_at=${Date.now() - 30_000}`);
		const calls = mockFetch((u) => (u.startsWith("https://api.runpod.io/v2/pods?") ? json(v2list([])) : undefined));
		expect(await selectAndCreate(env, env.DB, "j1")).toBe("held");
		expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
	});
});

describe("watchdog", () => {
	it("scans a held job every minute even though updated_at is fresh", async () => {
		await job("j1", "provisioning", `create_uncertain_at=${Date.now() - 30_000}`);
		const calls = mockFetch((u) => (u.startsWith("https://api.runpod.io/v2/pods?") ? json(v2list([v2pod({ id: "late", name: "vf-j1", gpu: { id: RTX4090 } })])) : undefined));
		await watchdog(env, env.DB);
		expect(calls.some((c) => c.url.startsWith("https://api.runpod.io/v2/pods?"))).toBe(true);
		expect((await getJob(env.DB, "j1"))!.state).toBe("booting"); // the late pod was adopted
	});

	it("heartbeat lost but DELETE not confirmed -> pod stays tracked and active, no replacement; next tick retries", async () => {
		await job("j1", "rendering", "plan_json='{}'");
		await pod("p1", "j1", 10 * MIN, { hello: Date.now() - 9 * MIN, hb: Date.now() - 2 * MIN });
		let deleteOk = false;
		const calls = mockFetch(
			(u, i) => (i.method === "DELETE" ? (deleteOk ? new Response(null, { status: 204 }) : json({}, 503)) : undefined),
			(u) => (u.includes("/v2/catalog/datacenters") ? json(cat) : undefined),
			(u, i) => (u === "https://rest.runpod.io/v1/pods" && i.method === "POST" ? json({ id: "p2", costPerHr: 0.6, machine: { gpuTypeId: RTX4090, dataCenterId: "AP-IN-1" } }, 201) : undefined),
		);
		await watchdog(env, env.DB);
		expect(await row("p1")).toEqual({ deleted_at: null, delete_reason: null });
		expect((await getJob(env.DB, "j1"))!.state).toBe("rendering");
		expect(calls.some((c) => c.method === "POST")).toBe(false);

		deleteOk = true;
		await watchdog(env, env.DB);
		expect((await row("p1"))!.deleted_at).toBeTypeOf("number");
		expect((await getJob(env.DB, "j1"))!.state).toBe("booting");
		expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
	});

	it("retries delete-pending pods until RunPod confirms", async () => {
		await job("j1", "failed");
		await pod("p1", "j1", 5 * MIN, { pending: "failed:budget" });
		mockFetch((u, i) => (i.method === "DELETE" ? json({}, 503) : undefined));
		await watchdog(env, env.DB);
		expect(await row("p1")).toEqual({ deleted_at: null, delete_reason: "failed:budget" });
		mockFetch((u, i) => (i.method === "DELETE" ? new Response(null, { status: 204 }) : undefined));
		await watchdog(env, env.DB);
		expect((await row("p1"))!.deleted_at).toBeTypeOf("number");
	});

	it("price-rejected pod pending delete: confirmed later, then (after the grace) a fresh pod", async () => {
		await job("j1", "provisioning", `create_uncertain_at=${Date.now() - UNCERTAIN_GRACE_MS - 1000}`);
		await pod("p1", "j1", 4 * MIN, { pending: "cost_reject" });
		mockFetch(
			(u, i) => (i.method === "DELETE" ? new Response(null, { status: 204 }) : undefined),
			(u) => (u.startsWith("https://api.runpod.io/v2/pods?") ? json(v2list([])) : undefined),
			(u) => (u.includes("/v2/catalog/datacenters") ? json(cat) : undefined),
			(u, i) => (u === "https://rest.runpod.io/v1/pods" && i.method === "POST" ? json({ id: "p2", costPerHr: 0.6, machine: { gpuTypeId: RTX4090, dataCenterId: "AP-IN-1" } }, 201) : undefined),
		);
		await env.DB.prepare("UPDATE jobs SET updated_at = 0 WHERE id = 'j1'").run();
		await watchdog(env, env.DB); // step 0 confirms p1's delete; step 3 finds the hold resolvable
		expect((await row("p1"))!.deleted_at).toBeTypeOf("number");
		expect((await getJob(env.DB, "j1"))!.state).toBe("booting");
	});
});

describe("reaper", () => {
	const list = (...pods: unknown[]) => (u: string) => (u.startsWith("https://api.runpod.io/v2/pods?") ? json(v2list(pods)) : undefined);
	const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

	it("leaves a young untracked vf- pod alone (its create may still be being recorded)", async () => {
		await job("j1", "provisioning");
		const calls = mockFetch(list(v2pod({ id: "new", name: "vf-j1", createdAt: iso(30_000) })));
		await reaper(env, env.DB);
		expect(calls.some((c) => c.method === "DELETE")).toBe(false);
	});

	it("leaves an untracked pod of a held job alone, whatever its age (the hold check adopts it)", async () => {
		await job("j1", "provisioning", `create_uncertain_at=${Date.now() - 10 * MIN}`);
		const calls = mockFetch(list(v2pod({ id: "late", name: "vf-j1", createdAt: iso(10 * MIN) })));
		await reaper(env, env.DB);
		expect(calls.some((c) => c.method === "DELETE")).toBe(false);
	});

	it("deletes an old untracked orphan; leaves other names alone", async () => {
		const calls = mockFetch(list(v2pod({ id: "o", name: "vf-gone", createdAt: iso(20 * MIN) }), v2pod({ id: "x", name: "my-notebook", createdAt: iso(99 * MIN) })), (u, i) => (i.method === "DELETE" ? new Response(null, { status: 204 }) : undefined));
		await reaper(env, env.DB);
		expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual(["https://api.runpod.io/v2/pods/o"]);
	});

	it("unconfirmed delete of a terminal job's pod -> kept tracked as delete-pending", async () => {
		await job("j1", "done");
		await pod("p1", "j1", 20 * MIN);
		mockFetch(list(v2pod({ id: "p1", name: "vf-j1", createdAt: iso(20 * MIN) })), (u, i) => (i.method === "DELETE" ? json({}, 503) : undefined));
		await reaper(env, env.DB);
		expect(await row("p1")).toEqual({ deleted_at: null, delete_reason: "reaper:job_done" });
	});

	it("malformed list -> throws before touching anything (nothing marked gone)", async () => {
		await job("j1", "rendering");
		await pod("p1", "j1", 20 * MIN);
		const calls = mockFetch((u) => (u.startsWith("https://api.runpod.io/v2/pods?") ? json({ pods: [], pagination: { nextCursor: null, hasNextPage: true } }) : undefined));
		await expect(reaper(env, env.DB)).rejects.toThrow();
		expect((await row("p1"))!.deleted_at).toBeNull();
		expect(calls.some((c) => c.method === "DELETE")).toBe(false);
	});

	it("a tracked pod younger than the list lag is not marked gone just because it isn't listed yet", async () => {
		await job("j1", "booting");
		await pod("p1", "j1", 30_000);
		mockFetch(list());
		await reaper(env, env.DB);
		expect((await row("p1"))!.deleted_at).toBeNull();
	});
});

describe("no raw provider JSON in diagnostics", () => {
	it("a create error that echoes the request env never puts the token in events", async () => {
		await job("j1");
		mockFetch(
			(u) => (u.includes("/v2/catalog/datacenters") ? json(catalogOf({ "AP-IN-1": { [RTX4090]: "HIGH" } })) : undefined),
			(u, i) => (u.includes("runpod.io/v") && u.endsWith("/pods") && i.method === "POST" ? json({ error: "bad request", request: JSON.parse(i.body as string) }, 422) : undefined),
		);
		await selectAndCreate(env, env.DB, "j1");
		const dump = JSON.stringify((await env.DB.prepare("SELECT data_json FROM events").all()).results);
		expect(dump).not.toMatch(/t_[0-9a-f]{16}/);
		expect(dump).not.toContain("JOB_TOKEN");
		expect(dump).toContain("bad request");
	});

	it("safeDetail keeps only problem-detail strings and masks token-shaped values", () => {
		expect(safeDetail(JSON.stringify({ title: "Bad", detail: "env JOB_TOKEN=t_0123456789abcdef0123 rejected", env: { JOB_TOKEN: "t_0123456789abcdef0123" } }))).toBe("Bad | env JOB_TOKEN=*** rejected");
		expect(safeDetail("<html>gateway</html>")).toBe("<non-JSON body, 20 bytes>");
	});

	it("a malformed Pod in a list is reported by position, not by content", async () => {
		mockFetch((u) => (u.startsWith("https://api.runpod.io/v2/pods?") ? json(v2list([{ id: "1", name: "vf-a", env: { JOB_TOKEN: "t_0123456789abcdef0123" } }])) : undefined));
		const err = await listPods(env).catch((e: Error) => e);
		expect(String(err)).toMatch(/malformed Pod #0 on page 1/);
		expect(String(err)).not.toContain("t_0123");
	});
});
