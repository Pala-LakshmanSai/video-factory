// /previews losing its state CAS to approve/revise_scene answers 201 (no agent /error); /done is idempotent.
import { beforeEach, describe, expect, it } from "vitest";
import { agentApp } from "../src/agent";
import { getJob, sha256Hex } from "../src/db";
import { json, makeEnv, mockFetch } from "./helpers";

let env: Env;
const plan = JSON.stringify({ style: "explainer", fps: 30, resolution: "1920x1080", scenes: [{ n: 1, duration_s: 5 }] });

async function job(state: string, extra: Record<string, unknown> = {}) {
	const cols = { id: "j1", chat_key: "k", state, title: "t", style: "explainer", voiceover_json: "{}", plan_json: plan, created_at: Date.now(), updated_at: Date.now(),
		job_token_sha256: await sha256Hex("tok"), token_expires_at: Date.now() + 3_600_000, ...extra };
	await env.DB.prepare(`INSERT INTO jobs (${Object.keys(cols).join(", ")}) VALUES (${Object.keys(cols).map(() => "?").join(", ")})`).bind(...Object.values(cols)).run();
}
const call = (path: string, body: BodyInit, json = true) =>
	agentApp.fetch(new Request(`https://cp.test/agent/j1${path}`, { method: "POST", headers: { Authorization: "Bearer tok", ...(json ? { "Content-Type": "application/json" } : {}) }, body }), env);
const frames = () => {
	const f = new FormData();
	for (const i of [0, 1, 2]) f.append(`scene-1-${i}`, new Blob([new Uint8Array(10)], { type: "image/jpeg" }), "x.jpg");
	return f;
};
const errorsRecorded = async () => (await env.DB.prepare("SELECT COUNT(*) AS k FROM events WHERE job_id = 'j1' AND kind = 'render_error'").first<{ k: number }>())!.k;

beforeEach(() => {
	env = makeEnv();
});

describe("/previews lost transition", () => {
	it("approve moves the job on mid-request -> 201, previews stored, no render error", async () => {
		await job("rendering", { approved: 1 });
		// Simulate approve landing between our preview_ready and final_render transitions.
		const prepare = env.DB.prepare.bind(env.DB);
		let n = 0;
		env.DB.prepare = ((sql: string) => {
			if (sql.startsWith("UPDATE jobs SET state = ?") && ++n === 2) void prepare("UPDATE jobs SET state = 'final_render' WHERE id = 'j1'").run();
			return prepare(sql);
		}) as typeof env.DB.prepare;
		const res = await call("/previews", frames(), false);
		expect(res.status).toBe(201);
		expect((await getJob(env.DB, "j1"))!.state).toBe("final_render");
		expect((await env.DB.prepare("SELECT COUNT(*) AS k FROM previews WHERE job_id = 'j1'").first<{ k: number }>())!.k).toBe(3);
		expect(await errorsRecorded()).toBe(0);
	});

	it("revise_scene moved the job before our transition -> 201", async () => {
		await job("rendering");
		const prepare = env.DB.prepare.bind(env.DB);
		env.DB.prepare = ((sql: string) => {
			if (sql.startsWith("UPDATE jobs SET state = ?")) void prepare("UPDATE jobs SET state = 'rerendering', rerender_scene = 1 WHERE id = 'j1'").run();
			return prepare(sql);
		}) as typeof env.DB.prepare;
		expect((await call("/previews", frames(), false)).status).toBe(201);
		const j = (await getJob(env.DB, "j1"))!;
		expect(j.state).toBe("rerendering");
		expect(j.rerender_scene).toBe(1);
	});
});

describe("/done idempotent", () => {
	const routes = () =>
		mockFetch(
			(u) => (u === "https://oauth2.googleapis.com/token" ? json({ access_token: "at", expires_in: 3599 }) : undefined),
			(u) => (u.includes("/files/f1?fields") ? json({ size: "100", md5Checksum: "bad", webViewLink: "https://drive.test/f1" }) : undefined),
		);

	it("a repeated /done for a file already rejected does not re-verify or count another re-upload", async () => {
		await job("uploading");
		const calls = routes();
		const body = JSON.stringify({ file_id: "f1", md5: "abc", size: 100 });
		expect((await call("/done", body)).status).toBe(200);
		let j = (await getJob(env.DB, "j1"))!;
		expect([j.state, j.reuploads, j.pending_cmd]).toEqual(["uploading", 1, "reupload"]);
		const n = calls.length;
		expect((await call("/done", body)).status).toBe(200);
		j = (await getJob(env.DB, "j1"))!;
		expect([j.state, j.reuploads]).toEqual(["uploading", 1]);
		expect(calls.length).toBe(n); // no second Drive lookup
	});

	it("a repeated /done after the job is done -> 410 (agent stops)", async () => {
		await job("done");
		expect((await call("/done", JSON.stringify({ file_id: "f1", md5: "abc", size: 100 }))).status).toBe(410);
	});
});
