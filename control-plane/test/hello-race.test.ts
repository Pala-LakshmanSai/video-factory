// /hello vs submit_job: the booting -> next-state decision must use the row's current plan_json.
import { beforeEach, expect, it } from "vitest";
import { agentApp } from "../src/agent";
import { getJob, sha256Hex } from "../src/db";
import { submitJob } from "../src/mcp";
import { makeEnv, mockFetch } from "./helpers";

let env: Env;
const PLAN = {
	style: "explainer", fps: 30, resolution: "1920x1080",
	scenes: [{ n: 1, template: "title", props: { title: "Hi" }, duration_s: 3, narration: "Hi", transition: "cut" }],
};

beforeEach(async () => {
	env = makeEnv();
	mockFetch();
	const t = Date.now();
	await env.DB.prepare("INSERT INTO jobs (id, chat_key, state, title, style, voiceover_json, created_at, updated_at, job_token_sha256, token_expires_at) VALUES ('j1', 'k1', 'booting', 't', 'explainer', '{\"text\":\"Hi\"}', ?, ?, ?, ?)")
		.bind(t, t, await sha256Hex("tok"), t + 3_600_000).run();
});

it("a plan submitted while /hello is in flight starts rendering (not parked in waiting_for_plan)", async () => {
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	const body = new ReadableStream<Uint8Array>({
		async start(ctl) {
			await gate; // auth has already read the job (booting, plan_json NULL) when the body arrives
			ctl.enqueue(new TextEncoder().encode(JSON.stringify({ gpu: "g", vcpu: 4, ram_gb: 16, pod_id: "p", data_center: "d" })));
			ctl.close();
		},
	});
	const hello = agentApp.fetch(new Request("https://cp.test/agent/j1/hello", { method: "POST", headers: { Authorization: "Bearer tok", "content-type": "application/json" }, body, duplex: "half" } as RequestInit), env);
	await new Promise((r) => setTimeout(r, 20));
	expect(await submitJob(env.DB, "j1", PLAN, env.OAUTH_KV)).not.toHaveProperty("error");
	release();
	const res = await hello;
	expect(await res.json()).toEqual({ state: "rendering" });
	expect((await getJob(env.DB, "j1"))!.state).toBe("rendering");
	const spec = await agentApp.fetch(new Request("https://cp.test/agent/j1/spec", { headers: { Authorization: "Bearer tok" } }), env);
	expect(spec.status).toBe(200);
});

it("without a plan, /hello still moves booting -> waiting_for_plan", async () => {
	const res = await agentApp.fetch(new Request("https://cp.test/agent/j1/hello", { method: "POST", headers: { Authorization: "Bearer tok" }, body: "{}" }), env);
	expect(await res.json()).toEqual({ state: "waiting_for_plan" });
	expect((await getJob(env.DB, "j1"))!.state).toBe("waiting_for_plan");
});

it("a paused hello from a replaced pod does not mark the replacement as booted", async () => {
	await env.DB.prepare("INSERT INTO pods (id, job_id, cost_per_hr, created_at) VALUES ('podA', 'j1', 0.6, ?)").bind(Date.now()).run();
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	const body = new ReadableStream<Uint8Array>({
		async start(ctl) {
			await gate;
			ctl.enqueue(new TextEncoder().encode("{}"));
			ctl.close();
		},
	});
	const old = agentApp.fetch(new Request("https://cp.test/agent/j1/hello", { method: "POST", headers: { Authorization: "Bearer tok" }, body, duplex: "half" } as RequestInit), env);
	await new Promise((r) => setTimeout(r, 20));
	// Watchdog replaces A with B: A deleted, B active, job token rotated.
	await env.DB.prepare("UPDATE pods SET deleted_at = ? WHERE id = 'podA'").bind(Date.now()).run();
	await env.DB.prepare("INSERT INTO pods (id, job_id, cost_per_hr, created_at) VALUES ('podB', 'j1', 0.6, ?)").bind(Date.now()).run();
	await env.DB.prepare("UPDATE jobs SET job_token_sha256 = ? WHERE id = 'j1'").bind(await sha256Hex("tokB")).run();
	release();
	await old;
	const b = await env.DB.prepare("SELECT hello_at, last_heartbeat_at FROM pods WHERE id = 'podB'").first<{ hello_at: number | null; last_heartbeat_at: number | null }>();
	expect(b).toEqual({ hello_at: null, last_heartbeat_at: null });
	expect((await getJob(env.DB, "j1"))!.state).toBe("booting");
});
