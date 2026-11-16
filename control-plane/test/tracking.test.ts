// Review findings on 4763b20: create claim before POST, held-job scanning, pods kept tracked when a delete is
// not confirmed, reaper grace for young/held untracked pods, no raw provider JSON in diagnostics.
import { beforeEach, describe, expect, it } from "vitest";
import { getJob } from "../src/db";
import { reaper } from "../src/reaper";
import { deps, listPods, safeDetail } from "../src/runpod";
import { selectAndCreate } from "../src/selector";
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
		expect((await getJob(env.DB, "j1"))!.create_claim).toBeNull();
	});

	it("a claim left by a crashed run (no pod row) -> held, lookup only, no POST", async () => {
		await job("j1", "provisioning", `create_claim='c_dead'`);
		const calls = mockFetch((u) => (u.startsWith("https://api.runpod.io/v2/pods?") ? json(v2list([])) : undefined));
		expect(await selectAndCreate(env, env.DB, "j1")).toBe("held");
		expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
	});
});

describe("watchdog", () => {
	it("scans a held job every minute even though updated_at is fresh", async () => {
		await job("j1", "provisioning", `create_claim='c_dead'`);
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
		// DELETE accepted (204) but the pod is still listed by GET: NOT cleared.
		let getStatus = 200;
		mockFetch(
			(u, i) => (i.method === "DELETE" ? new Response(null, { status: 204 }) : undefined),
			(u, i) => (u === "https://api.runpod.io/v2/pods/p1" && i.method !== "DELETE" ? (getStatus === 404 ? json({ status: 404 }, 404) : json(v2pod({ id: "p1", name: "vf-j1", status: "RUNNING" }))) : undefined),
		);
		await watchdog(env, env.DB);
		expect((await row("p1"))!.deleted_at).toBeNull();
		getStatus = 404; // direct provider absence
		await watchdog(env, env.DB);
		expect((await row("p1"))!.deleted_at).toBeTypeOf("number");
	});

	it("price-rejected pod pending delete blocks admission until direct absence, then a fresh pod", async () => {
		await job("j1");
		await env.DB.prepare("UPDATE jobs SET created_at = 0, admission_at = 0 WHERE id = 'j1'").run();
		await pod("p1", "j1", 4 * MIN, { pending: "cost_reject" });
		let gone = false;
		const calls = mockFetch(
			(u, i) => (i.method === "DELETE" ? new Response(null, { status: 204 }) : undefined),
			(u, i) => (u === "https://api.runpod.io/v2/pods/p1" ? (gone ? json({}, 404) : json(v2pod({ id: "p1", name: "vf-j1" }))) : undefined),
			(u) => (u.includes("/v2/catalog/datacenters") ? json(cat) : undefined),
			(u, i) => (u === "https://rest.runpod.io/v1/pods" && i.method === "POST" ? json({ id: "p2", costPerHr: 0.6, machine: { gpuTypeId: RTX4090, dataCenterId: "AP-IN-1" } }, 201) : undefined),
		);
		await watchdog(env, env.DB);
		expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
		gone = true;
		await watchdog(env, env.DB);
		expect((await row("p1"))!.deleted_at).toBeTypeOf("number");
		expect((await getJob(env.DB, "j1"))!.state).toBe("booting");
	});

	it("unclaimed stale admission is retried from admission_at even though cost writes keep updated_at fresh", async () => {
		await job("j1");
		await env.DB.prepare("UPDATE jobs SET admission_at = ?, updated_at = ? WHERE id = 'j1'").bind(Date.now() - 2 * MIN, Date.now()).run();
		const calls = mockFetch((u) => (u.includes("/v2/catalog/datacenters") ? json(cat) : undefined), (u, i) => (u === "https://rest.runpod.io/v1/pods" && i.method === "POST" ? json({ id: "p1", costPerHr: 0.6, machine: { gpuTypeId: RTX4090, dataCenterId: "AP-IN-1" } }, 201) : undefined));
		await watchdog(env, env.DB);
		expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
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

	it("any reaper delete of a tracked pod leaves it delete-pending (cleared later only on direct absence)", async () => {
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

describe("safety review 3", () => {
	it("a malformed price_cap fault cannot disable the cap (NaN) and cannot raise it above $2/hr", async () => {
		for (const arg of ["abc", "5"]) {
			env = makeEnv();
			await job("j1");
			await env.DB.prepare("INSERT INTO config (key, value_json) VALUES ('faults:j1', ?)").bind(JSON.stringify([`price_cap:${arg}`])).run();
			let n = 0;
			mockFetch(
				(u) => (u.includes("/v2/catalog/datacenters") ? json(cat) : undefined),
				(u, i) => (u === "https://rest.runpod.io/v1/pods" && i.method === "POST" ? json({ id: `p${++n}`, costPerHr: n === 1 ? 2.4 : 0.6, machine: { gpuTypeId: RTX4090, dataCenterId: "AP-IN-1" } }, 201) : undefined),
				(u, i) => (i.method === "DELETE" ? new Response(null, { status: 204 }) : undefined),
			);
			expect(await selectAndCreate(env, env.DB, "j1")).toBe("created");
			expect((await row("p1"))!.delete_reason).toBe("cost_reject");
		}
	});

	it("catalog outage: nothing claimed, nothing created, retried later", async () => {
		await job("j1");
		const calls = mockFetch((u) => (u.includes("/v2/catalog/datacenters") ? json({ title: "down" }, 503) : undefined));
		expect(await selectAndCreate(env, env.DB, "j1")).toBe("skipped");
		expect((await getJob(env.DB, "j1"))!.create_uncertain_at).toBeNull();
		expect(calls.some((c) => c.method === "POST")).toBe(false);
	});

	it("202 QueuedPod is cancelled and counts as 'not placed': next candidate, no hold", async () => {
		await job("j1");
		deps.v1Denied = true;
		const calls = mockFetch(
			(u) => (u.includes("/v2/catalog/datacenters") ? json(catalogOf({ "AP-IN-1": { [RTX4090]: "HIGH", "NVIDIA L40S": "HIGH" } })) : undefined),
			(u, i) => {
				if (u !== "https://api.runpod.io/v2/pods" || i.method !== "POST") return;
				const b = JSON.parse(i.body as string);
				return b.gpu.id === RTX4090 ? json({ id: "q1" }, 202) : json(v2pod({ id: "ok", name: b.name, cost: 0.8, gpu: { id: b.gpu.id } }), 201);
			},
			(u, i) => (u === "https://api.runpod.io/v2/queued-pods/q1" && i.method === "DELETE" ? new Response(null, { status: 204 }) : undefined),
		);
		expect(await selectAndCreate(env, env.DB, "j1")).toBe("created");
		expect(calls.some((c) => c.url.endsWith("/queued-pods/q1") && c.method === "DELETE")).toBe(true);
	});

	it("202 QueuedPod whose cancel fails -> job held (it could start later)", async () => {
		await job("j1");
		deps.v1Denied = true;
		mockFetch(
			(u) => (u.includes("/v2/catalog/datacenters") ? json(cat) : undefined),
			(u, i) => (u === "https://api.runpod.io/v2/pods" && i.method === "POST" ? json({ id: "q1" }, 202) : undefined),
			(u) => (u.includes("/queued-pods/") ? json({}, 503) : undefined),
		);
		expect(await selectAndCreate(env, env.DB, "j1")).toBe("held");
	});

	it("a delete failing for 10 min raises one 'may still be billing' alert", async () => {
		await job("j1", "failed");
		await pod("p1", "j1", 30 * MIN, { pending: "failed:budget" });
		await env.DB.prepare("INSERT INTO events (job_id, ts, kind, data_json) VALUES ('j1', ?, 'delete_failed', ?)").bind(Date.now() - 11 * MIN, JSON.stringify({ pod: "p1", reason: "failed:budget" })).run();
		mockFetch((u, i) => (i.method === "DELETE" ? json({ title: "Conflict" }, 409) : undefined));
		await watchdog(env, env.DB);
		await watchdog(env, env.DB);
		const n = await env.DB.prepare("SELECT COUNT(*) n FROM events WHERE kind = 'delete_stuck'").first<{ n: number }>();
		expect(n!.n).toBe(1);
		expect((await row("p1"))!.deleted_at).toBeNull();
	});
});

describe("review 4: fencing, no replay, admission switch", () => {
	it("an old selector whose claim was taken over stops before its next POST", async () => {
		await job("j1");
		deps.v1Denied = true;
		let posts = 0;
		mockFetch(
			(u) => (u.includes("/v2/catalog/datacenters") ? json(catalogOf({ "AP-IN-1": { [RTX4090]: "HIGH", "NVIDIA L40S": "HIGH" } })) : undefined),
			async (u, i) => {
				if (u !== "https://api.runpod.io/v2/pods" || i.method !== "POST") return;
				posts++;
				// While the first POST is "in flight", another actor takes admission over.
				await env.DB.prepare("UPDATE jobs SET create_claim = 'c_other' WHERE id = 'j1'").run();
				return json({ status: 400, detail: "no capacity" }, 400);
			},
		);
		expect(await selectAndCreate(env, env.DB, "j1")).toBe("held");
		expect(posts).toBe(1); // the second candidate (L40S) is NOT posted
		const ev = await env.DB.prepare("SELECT COUNT(*) n FROM events WHERE kind = 'claim_lost'").first<{ n: number }>();
		expect(ev!.n).toBe(1);
	});

	it("an old selector cannot release a claim it no longer owns", async () => {
		await job("j1", "provisioning", `create_claim='c_new'`);
		const { releaseClaim } = await import("../src/selector");
		await releaseClaim(env.DB, "j1", "c_old");
		expect((await getJob(env.DB, "j1"))!.create_claim).toBe("c_new");
	});

	it("ADMISSION_ENABLED != 1: no catalog read, no claim, no POST; benchmark refuses to start", async () => {
		env = { ...makeEnv(), ADMISSION_ENABLED: "0", BENCH_ENABLED: "1" } as Env;
		await job("j1");
		const calls = mockFetch();
		expect(await selectAndCreate(env, env.DB, "j1")).toBe("skipped");
		expect(calls).toHaveLength(0);
		expect((await getJob(env.DB, "j1"))!.create_claim).toBeNull();
		const { startBench } = await import("../src/bench");
		expect(await startBench(env, env.DB)).toMatch(/admission disabled/);
		expect(calls).toHaveLength(0);
	});
});

describe("live smoke render finding (2026-11-16)", () => {
	it("verify marks the job done BEFORE deleting the pod (the delete kills the agent's /done request)", async () => {
		const { verify } = await import("../src/agent");
		await job("j1", "verifying", "plan_json='{}'");
		await pod("p1", "j1", 10 * MIN, { hello: Date.now() - 9 * MIN });
		let stateAtDelete = "";
		const deferred: Promise<unknown>[] = [];
		mockFetch(
			(u) => (u === "https://oauth2.googleapis.com/token" ? json({ access_token: "at", expires_in: 3599 }) : undefined),
			(u) => (u.includes("/files/f1?fields") ? json({ size: "100", md5Checksum: "abc", webViewLink: "https://drive.test/f1" }) : undefined),
			(u) => (u.includes("/files/f1/permissions") ? json({ id: "anyone" }) : undefined),
			async (u, i) => {
				if (i.method !== "DELETE") return;
				stateAtDelete = (await getJob(env.DB, "j1"))!.state;
				return new Response(null, { status: 204 });
			},
		);
		await verify(env, (await getJob(env.DB, "j1"))!, { file_id: "f1", md5: "abc", size: 100 }, (p) => deferred.push(p));
		expect(stateAtDelete).toBe("done");
		expect(deferred).toHaveLength(1); // the delete is handed to waitUntil
		const j = (await getJob(env.DB, "j1"))!;
		expect(j.state).toBe("done");
		expect(j.drive_link).toBe("https://drive.test/f1");
	});
});

describe("failure paths record before deleting the pod", () => {
	for (const [label, run] of [
		["3 render errors (/error)", async (j: string) => {
			const { agentApp } = await import("../src/agent");
			const { sha256Hex } = await import("../src/db");
			await env.DB.prepare("UPDATE jobs SET job_token_sha256 = ?, token_expires_at = ?, render_errors = '{\"2\":2}' WHERE id = ?").bind(await sha256Hex("tok"), Date.now() + 60 * MIN, j).run();
			return agentApp.fetch(new Request(`https://cp.test/agent/${j}/error`, { method: "POST", headers: { Authorization: "Bearer tok", "Content-Type": "application/json" }, body: JSON.stringify({ stage: "preview", scene: 2, log_tail: "boom" }) }), env);
		}],
		["direct failJob (budget)", async (j: string) => {
			const { failJob } = await import("../src/selector");
			await failJob(env, env.DB, (await getJob(env.DB, j))!, "budget", "over");
		}],
	] as const) {
		it(`${label}: state is failed with error_json when the DELETE goes out`, async () => {
			await job("j1", "rendering", "plan_json='{}'");
			await pod("p1", "j1", 10 * MIN, { hello: Date.now() - 9 * MIN });
			let atDelete: { state: string; error_json: string | null } | null = null;
			mockFetch(async (u, i) => {
				if (i.method !== "DELETE") return;
				atDelete = (await getJob(env.DB, "j1"))!;
				return new Response(null, { status: 204 });
			});
			await run("j1");
			expect(atDelete!.state).toBe("failed");
			expect(atDelete!.error_json).toBeTruthy();
			expect((await row("p1"))!.deleted_at).toBeTypeOf("number");
		});
	}
});

describe("Phase 9 fault mechanics", () => {
	it("slow_boot: one boot timeout consumes the fault, so the replacement pod can boot", async () => {
		await job("j1", "booting");
		await pod("p1", "j1", 11 * MIN);
		await env.DB.prepare("INSERT INTO config (key, value_json) VALUES ('faults:j1', '[\"slow_boot\"]')").run();
		mockFetch(
			(u, i) => (i.method === "DELETE" ? new Response(null, { status: 204 }) : undefined),
			(u) => (u.includes("/v2/catalog/datacenters") ? json(cat) : undefined),
			(u, i) => (u === "https://rest.runpod.io/v1/pods" && i.method === "POST" ? json({ id: "p2", costPerHr: 0.6, machine: { gpuTypeId: RTX4090, dataCenterId: "EU-RO-1" } }, 201) : undefined),
		);
		await watchdog(env, env.DB);
		const left = await env.DB.prepare("SELECT value_json FROM config WHERE key = 'faults:j1'").first<{ value_json: string }>();
		expect(JSON.parse(left!.value_json)).toEqual([]);
		expect((await getJob(env.DB, "j1"))!.state).toBe("booting"); // on the replacement pod
	});

	it("an agent fault never overwrites a queued pending_cmd; it arms only into an empty slot", async () => {
		const { armFault } = await import("../src/faults");
		const { agentApp } = await import("../src/agent");
		const { sha256Hex } = await import("../src/db");
		await job("j1", "final_render", "plan_json='{}'");
		await pod("p1", "j1", 5 * MIN, { hello: Date.now() - 4 * MIN, hb: Date.now() - 10_000 });
		await env.DB.prepare("UPDATE jobs SET job_token_sha256 = ?, token_expires_at = ?, pending_cmd = 'render_final' WHERE id = 'j1'").bind(await sha256Hex("tok"), Date.now() + 60 * MIN).run();
		await expect(armFault(env, "j1", "silence_heartbeat")).rejects.toThrow("pending_cmd busy (render_final); retry when empty");
		expect((await getJob(env.DB, "j1"))!.pending_cmd).toBe("render_final");
		expect(await env.DB.prepare("SELECT 1 FROM events WHERE kind = 'fault_armed'").first()).toBeNull();
		expect(await env.DB.prepare("SELECT 1 FROM config WHERE key = 'faults:j1'").first()).toBeNull();
		const hb = await agentApp.fetch(new Request("https://cp.test/agent/j1/heartbeat", { method: "POST", headers: { Authorization: "Bearer tok", "Content-Type": "application/json" }, body: JSON.stringify({ stage: "rendering", pct: 10 }) }), env);
		expect(await hb.json()).toEqual({ cmd: "render_final" }); // the original command is delivered, not a fault
		expect((await row("p1"))!.deleted_at).toBeNull(); // pod still live
		// empty slot: the fault arms
		await armFault(env, "j1", "silence_heartbeat");
		expect((await getJob(env.DB, "j1"))!.pending_cmd).toBe("fault:silence_heartbeat");
	});
});

describe("upload-resume telemetry never touches the command channel", () => {
	it("keeps pending_cmd, logs only a valid positive offset, and the next real heartbeat still gets the command", async () => {
		const { agentApp } = await import("../src/agent");
		const { sha256Hex } = await import("../src/db");
		await job("j1", "final_render", "plan_json='{}'");
		await pod("p1", "j1", 5 * MIN, { hello: Date.now() - 4 * MIN, hb: Date.now() - 10_000 });
		await env.DB.prepare("UPDATE jobs SET job_token_sha256 = ?, token_expires_at = ?, pending_cmd = 'render_final' WHERE id = 'j1'").bind(await sha256Hex("tok"), Date.now() + 60 * MIN).run();
		const hb = (stage: string) =>
			agentApp.fetch(new Request("https://cp.test/agent/j1/heartbeat", { method: "POST", headers: { Authorization: "Bearer tok", "Content-Type": "application/json" }, body: JSON.stringify({ stage, pct: 0 }) }), env).then((r) => r.json());
		for (const bad of ["upload_resumed:0", "upload_resumed:-5", "upload_resumed:abc", "upload_resumed:1e400", "upload_resumed:"]) {
			expect(await hb(bad)).toEqual({ cmd: "continue" });
		}
		expect(await hb("upload_resumed:1048576")).toEqual({ cmd: "continue" });
		expect((await getJob(env.DB, "j1"))!.pending_cmd).toBe("render_final");
		const ev = (await env.DB.prepare("SELECT data_json FROM events WHERE kind = 'upload_resumed'").all<{ data_json: string }>()).results;
		expect(ev.map((e) => JSON.parse(e.data_json))).toEqual([{ offset: 1048576 }]);
		expect(await hb("uploading")).toEqual({ cmd: "render_final" }); // the real heartbeat still receives it
		expect((await getJob(env.DB, "j1"))!.pending_cmd).toBeNull();
	});
});

describe("slow_boot holds /hello until the watchdog's boot timeout replaces the pod", () => {
	it("hello at 8-9.9 min stays 503 with the fault armed; >=10 min watchdog replaces + consumes; replacement boots", async () => {
		const { agentApp } = await import("../src/agent");
		const { sha256Hex } = await import("../src/db");
		await job("j1", "booting");
		await env.DB.prepare("UPDATE jobs SET job_token_sha256 = ?, token_expires_at = ? WHERE id = 'j1'").bind(await sha256Hex("tok"), Date.now() + 60 * MIN).run();
		await env.DB.prepare("INSERT INTO config (key, value_json) VALUES ('faults:j1', '[\"slow_boot\"]')").run();
		const faults = async () => JSON.parse((await env.DB.prepare("SELECT value_json FROM config WHERE key = 'faults:j1'").first<{ value_json: string }>())!.value_json);
		const hello = () => agentApp.fetch(new Request("https://cp.test/agent/j1/hello", { method: "POST", headers: { Authorization: "Bearer tok", "Content-Type": "application/json" }, body: "{}" }), env);
		for (const age of [8 * MIN, 9.9 * MIN]) {
			await env.DB.prepare("DELETE FROM pods").run();
			await pod("p1", "j1", age);
			const held = await hello();
			expect(held.status).toBe(503);
			expect(held.headers.get("X-VF-Hold")).toBe("slow_boot"); // agent treats this as reachable
			expect(await faults()).toEqual(["slow_boot"]);
		}
		await env.DB.prepare("DELETE FROM pods").run();
		await pod("p1", "j1", 10 * MIN + 1000);
		mockFetch(
			(u, i) => (i.method === "DELETE" ? new Response(null, { status: 204 }) : undefined),
			(u) => (u.includes("/v2/catalog/datacenters") ? json(cat) : undefined),
			(u, i) => (u === "https://rest.runpod.io/v1/pods" && i.method === "POST" ? json({ id: "p2", costPerHr: 0.6, machine: { gpuTypeId: RTX4090, dataCenterId: "EU-RO-1" } }, 201) : undefined),
		);
		await watchdog(env, env.DB);
		expect((await row("p1"))!.delete_reason).toBe("boot_timeout");
		expect(await faults()).toEqual([]);
		// Replacement has a fresh token (one per selection): reuse ours for the test.
		await env.DB.prepare("UPDATE jobs SET job_token_sha256 = ? WHERE id = 'j1'").bind(await sha256Hex("tok")).run();
		const r = await hello();
		expect(r.status).toBe(200);
		expect((await getJob(env.DB, "j1"))!.state).toBe("waiting_for_plan");
	});
});

describe("Sunday benchmark accounting", () => {
	const benchEnv = () => ({ ...makeEnv(), BENCH_ENABLED: "1" }) as Env;

	it("BENCH_ENABLED != 1 (admission on): no jobs, no fetch", async () => {
		const { startBench } = await import("../src/bench");
		const calls = mockFetch();
		expect(await startBench(env, env.DB)).toMatch(/bench disabled/);
		expect(calls).toHaveLength(0);
		expect(await env.DB.prepare("SELECT COUNT(*) n FROM jobs").first<{ n: number }>()).toEqual({ n: 0 });
	});

	it("a queued bench job (all slots busy) is cancelled at once and the watchdog never rents it", async () => {
		env = benchEnv();
		const { startBench } = await import("../src/bench");
		const { MAX_PODS_AT_ONCE } = await import("../src/config");
		for (let i = 0; i < MAX_PODS_AT_ONCE; i++) await job(`busy${i}`, "provisioning", "create_claim='c_held'");
		const calls = mockFetch(
			(u) => (u.includes("/v2/catalog/datacenters") ? json(cat) : undefined),
			(u) => (u.startsWith("https://api.runpod.io/v2/pods?") ? json(v2list([])) : undefined),
		);
		expect(await startBench(env, env.DB)).toMatch(/0 GPUs/);
		const bench = (await env.DB.prepare("SELECT * FROM jobs WHERE dev_mode = 'bench'").all<{ id: string; state: string }>()).results;
		expect(bench.length).toBeGreaterThan(0);
		for (const b of bench) expect(b.state).toBe("cancelled");
		expect(await env.DB.prepare("SELECT 1 FROM events WHERE kind = 'bench_not_created'").first()).toBeTruthy();
		await env.DB.prepare("DELETE FROM jobs WHERE id LIKE 'busy%'").run(); // slots free up
		await watchdog(env, env.DB);
		expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
		expect(await env.DB.prepare("SELECT COUNT(*) n FROM pods").first<{ n: number }>()).toEqual({ n: 0 });
	});

	it("finishBench aborts remaining bench jobs once actual pod cost exceeds $2", async () => {
		const { finishBench } = await import("../src/bench");
		await job("b1", "rendering", "dev_mode='bench'");
		await job("b2", "booting", "dev_mode='bench'");
		// b1: a pod at $0.6/h for 3 h = $1.80; b2: a second at $0.6/h for 30 min = $0.30 -> $2.10 > $2.
		await pod("p1", "b1", 180 * MIN, { hello: Date.now() - 170 * MIN });
		await pod("p2", "b2", 30 * MIN);
		await env.DB.prepare("INSERT INTO config (key, value_json) VALUES ('bench_run', ?)").bind(JSON.stringify({ started_at: Date.now() - 5 * MIN, jobs: [{ job_id: "b1", gpu: RTX4090, cost_per_hr: 0.6 }, { job_id: "b2", gpu: "NVIDIA L40S", cost_per_hr: 0.6 }], results: {} })).run();
		mockFetch((u, i) => (i.method === "DELETE" ? new Response(null, { status: 204 }) : undefined));
		await finishBench(env, env.DB);
		expect((await getJob(env.DB, "b1"))!.state).toBe("cancelled");
		expect((await getJob(env.DB, "b2"))!.state).toBe("cancelled");
		expect((await row("p1"))!.delete_reason).toBe("bench_budget");
		expect((await row("p2"))!.delete_reason).toBe("bench_budget");
		expect(await env.DB.prepare("SELECT 1 FROM config WHERE key = 'bench_run'").first()).toBeNull();
	});

	it("finishBench under budget with live jobs leaves them running", async () => {
		const { finishBench } = await import("../src/bench");
		await job("b1", "rendering", "dev_mode='bench'");
		await pod("p1", "b1", 10 * MIN, { hello: Date.now() - 8 * MIN });
		await env.DB.prepare("INSERT INTO config (key, value_json) VALUES ('bench_run', ?)").bind(JSON.stringify({ started_at: Date.now() - 10 * MIN, jobs: [{ job_id: "b1", gpu: RTX4090, cost_per_hr: 0.6 }], results: {} })).run();
		mockFetch();
		await finishBench(env, env.DB);
		expect((await getJob(env.DB, "b1"))!.state).toBe("rendering");
	});
});
