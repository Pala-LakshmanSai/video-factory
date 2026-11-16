// Create-claim race (double rental) and the pod-INSERT/booting crash gap; selection-time cap and skip_dcs.
import { beforeEach, describe, expect, it } from "vitest";
import { getJob } from "../src/db";
import { deps } from "../src/runpod";
import { selectAndCreate } from "../src/selector";
import { RTX4090, catalogOf, json, makeEnv, mockFetch } from "./helpers";

deps.sleep = async () => {};
const cat = catalogOf({ "AP-IN-1": { [RTX4090]: "HIGH" }, "EU-RO-1": { [RTX4090]: "HIGH" } });
let env: Env;
let raw: D1Database;

/** D1 wrapper that runs `before`/`after` around every statement's run(): injects a concurrent actor at an exact SQL step. */
const hooked = (db: D1Database, hook: { before?: (sql: string, a: unknown[]) => Promise<void>; after?: (sql: string, a: unknown[]) => Promise<void> }) => {
	const wrap = (st: D1PreparedStatement, sql: string, a: unknown[] = []): D1PreparedStatement => new Proxy(st, {
		get: (t, k) => k === "bind" ? (...b: unknown[]) => wrap(t.bind(...b), sql, b)
			: k === "run" ? async () => { await hook.before?.(sql, a); const r = await t.run(); await hook.after?.(sql, a); return r; }
			: (t as never)[k],
	});
	return { prepare: (sql: string) => wrap(db.prepare(sql), sql) } as unknown as D1Database;
};
const isTakeClaim = (sql: string) => sql.startsWith("UPDATE jobs SET create_claim = ?");

function runpod() {
	let n = 0;
	const calls = mockFetch(
		(u) => (u.includes("/v2/catalog/datacenters") ? json(cat) : undefined),
		(u, i) => (u === "https://rest.runpod.io/v1/pods" && i.method === "POST" ? json({ id: `p${++n}`, costPerHr: 0.6, machine: { gpuTypeId: RTX4090, dataCenterId: "AP-IN-1" } }, 201) : undefined),
	);
	return { posts: () => calls.filter((c) => c.method === "POST" && c.url.endsWith("/v1/pods")) };
}
const podCount = async () => (await raw.prepare("SELECT COUNT(*) n FROM pods WHERE job_id = 'j1'").first<{ n: number }>())!.n;

beforeEach(async () => {
	env = makeEnv();
	raw = env.DB;
	deps.v1Denied = false;
	await raw.prepare("INSERT INTO jobs (id, chat_key, state, title, style, voiceover_json, created_at, updated_at) VALUES ('j1','k','provisioning','t','explainer','{}',0,0)").run();
});

describe("create claim vs an accepted pod", () => {
	it("normal path: exactly one POST, one pod, booting, claim cleared in the same step", async () => {
		const rp = runpod();
		expect(await selectAndCreate(env, raw, "j1")).toBe("created");
		expect(rp.posts()).toHaveLength(1);
		expect(await podCount()).toBe(1);
		expect(await getJob(raw, "j1")).toMatchObject({ state: "booting", create_claim: null, create_uncertain_at: null });
	});

	it("contender passed the no-pod preflight, another run then accepts its pod: contender cannot claim, no second POST", async () => {
		const rp = runpod();
		// Contender pauses at its claim CAS (preflight already passed). Winner runs; right after the write that clears
		// its claim (the old gap: claim free, job still provisioning, pod row present) the contender is let go.
		let atClaim!: () => void, go!: () => void;
		const reached = new Promise<void>((r) => (atClaim = r));
		const gate = new Promise<void>((r) => (go = r));
		const contender = hooked(raw, { before: async (sql) => {
			if (isTakeClaim(sql)) { atClaim(); await gate; }
		} });
		const c = selectAndCreate(env, contender, "j1");
		await reached;
		let contenderResult: unknown;
		const winner = hooked(raw, { after: async (sql) => {
			if (sql.includes("create_claim = NULL")) { go(); contenderResult = await c; }
		} });
		await selectAndCreate(env, winner, "j1");
		expect(contenderResult).toBe("held");
		expect(rp.posts()).toHaveLength(1);
		expect(await podCount()).toBe(1);
		expect((await getJob(raw, "j1"))!.state).toBe("booting");
	});

	it("claim CAS itself refuses while an undeleted pod exists, even with no claim and the job still provisioning", async () => {
		const rp = runpod();
		const contender = hooked(raw, { before: async (sql) => {
			if (isTakeClaim(sql)) await raw.prepare("INSERT OR IGNORE INTO pods (id, job_id, cost_per_hr, created_at) VALUES ('px', 'j1', 0.6, ?)").bind(Date.now()).run();
		} });
		expect(await selectAndCreate(env, contender, "j1")).toBe("held");
		expect(rp.posts()).toHaveLength(0);
		expect((await getJob(raw, "j1"))!.create_claim).toBeNull();
	});

	it("run dies after the pod INSERT, before booting: next admission finishes acceptance, never POSTs again", async () => {
		const rp = runpod();
		const dying = hooked(raw, { after: async (sql) => {
			if (sql.startsWith("INSERT OR IGNORE INTO pods")) throw new Error("worker died");
		} });
		await expect(selectAndCreate(env, dying, "j1")).rejects.toThrow("worker died");
		const stuck = (await getJob(raw, "j1"))!;
		expect(stuck.state).toBe("provisioning");
		expect(stuck.create_claim).not.toBeNull(); // claim still set -> watchdog admission re-checks it every minute

		expect(await selectAndCreate(env, raw, "j1")).toBe("created");
		expect(await getJob(raw, "j1")).toMatchObject({ state: "booting", create_claim: null });
		expect(rp.posts()).toHaveLength(1);
		expect(await podCount()).toBe(1);
	});
});

describe("selection-time limits read from the fresh row", () => {
	it("attempts over MAX_REPLACEMENTS (bumped after preflight) -> no POST, job failed pod_replacements, claim released", async () => {
		const rp = runpod();
		await raw.prepare("UPDATE jobs SET state = 'retrying' WHERE id = 'j1'").run();
		const db = hooked(raw, { before: async (sql) => {
			if (isTakeClaim(sql)) await raw.prepare("UPDATE jobs SET attempts = 3 WHERE id = 'j1'").run();
		} });
		expect(await selectAndCreate(env, db, "j1")).toBe("no_capacity");
		expect(rp.posts()).toHaveLength(0);
		const j = (await getJob(raw, "j1"))!;
		expect(j).toMatchObject({ state: "failed", create_claim: null });
		expect(JSON.parse(j.error_json!).code).toBe("pod_replacements");
	});

	it("attempts at MAX_REPLACEMENTS is still allowed its last replacement (recover fails only above it)", async () => {
		const rp = runpod();
		await raw.prepare("UPDATE jobs SET state = 'retrying', attempts = 2 WHERE id = 'j1'").run();
		expect(await selectAndCreate(env, raw, "j1")).toBe("created");
		expect(rp.posts()).toHaveLength(1);
	});

	it("skip_dcs written after preflight is honoured: candidates never include it", async () => {
		const rp = runpod();
		const db = hooked(raw, { before: async (sql) => {
			if (isTakeClaim(sql)) await raw.prepare(`UPDATE jobs SET skip_dcs = '["AP-IN-1"]' WHERE id = 'j1'`).run();
		} });
		expect(await selectAndCreate(env, db, "j1")).toBe("created");
		const dcs = rp.posts().map((c) => (c.body as { dataCenterIds: string[] }).dataCenterIds);
		expect(dcs).toEqual([["EU-RO-1"]]);
	});
});
