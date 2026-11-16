// /previews losing its state CAS to approve/revise_scene answers 201 (no agent /error); /done is idempotent.
import { beforeEach, describe, expect, it } from "vitest";
import { agentApp, verify } from "../src/agent";
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

	const body = JSON.stringify({ file_id: "f1", md5: "abc", size: 100 });
	const stateEvents = async () => (await env.DB.prepare("SELECT data_json FROM events WHERE job_id = 'j1' AND kind = 'state'").all<{ data_json: string }>()).results.map((e) => JSON.parse(e.data_json).to);

	it("first /done cut off after the claim -> state is verifying (claim is atomic); the retry resumes and re-uploads once", async () => {
		await job("uploading");
		mockFetch((u) => (u === "https://oauth2.googleapis.com/token" ? json({ access_token: "at", expires_in: 3599 }) : undefined)); // Drive metadata unrouted -> throws
		expect((await call("/done", body)).status).toBe(500);
		let j = (await getJob(env.DB, "j1"))!;
		expect([j.state, j.drive_file_id]).toEqual(["verifying", "f1"]);
		routes();
		expect((await call("/done", body)).status).toBe(200);
		j = (await getJob(env.DB, "j1"))!;
		expect([j.state, j.reuploads, j.pending_cmd]).toEqual(["uploading", 1, "reupload"]);
		expect(await stateEvents()).toEqual(["verifying", "uploading"]);
	});

	it("retry while verifying with a matching file -> resumes to done", async () => {
		await job("verifying", { drive_file_id: "f1", md5: "abc", size: 100 });
		mockFetch(
			(u) => (u === "https://oauth2.googleapis.com/token" ? json({ access_token: "at", expires_in: 3599 }) : undefined),
			(u) => (u.includes("/files/f1?fields") ? json({ size: "100", md5Checksum: "abc", webViewLink: "https://drive.test/f1" }) : undefined),
			(u) => (u.includes("/files/f1/permissions") ? json({ id: "anyone" }) : undefined),
		);
		expect((await call("/done", body)).status).toBe(200);
		expect((await getJob(env.DB, "j1"))!.state).toBe("done");
		expect(await stateEvents()).toEqual(["done"]);
	});

	it("two concurrent /done -> exactly one verify side effect (one re-upload queued)", async () => {
		await job("uploading");
		routes();
		const rs = await Promise.all([call("/done", body), call("/done", body)]);
		expect(rs.map((r) => r.status)).toEqual([200, 200]);
		const j = (await getJob(env.DB, "j1"))!;
		expect([j.state, j.reuploads, j.pending_cmd]).toEqual(["uploading", 1, "reupload"]);
		expect(await stateEvents()).toEqual(["verifying", "uploading"]);
	});

	it("a repeated /done after the job is done -> 410 (agent stops)", async () => {
		await job("done");
		expect((await call("/done", JSON.stringify({ file_id: "f1", md5: "abc", size: 100 }))).status).toBe(410);
	});

	const drive = (md5: string) =>
		mockFetch(
			(u) => (u === "https://oauth2.googleapis.com/token" ? json({ access_token: "at", expires_in: 3599 }) : undefined),
			(u) => { const m = /\/files\/(f\d)\?fields/.exec(u); return m ? json({ size: "100", md5Checksum: md5, webViewLink: `https://drive.test/${m[1]}` }) : undefined; },
			(u) => (/\/files\/f\d\/permissions/.test(u) ? json({ id: "anyone" }) : undefined),
		);
	const shares = (calls: { url: string }[]) => calls.filter((c) => c.url.includes("/permissions")).map((c) => /files\/(f\d)/.exec(c.url)![1]);

	it("two concurrent /done with different files -> only the claimed file is verified/shared/linked, the other 409s", async () => {
		await job("uploading");
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const calls = mockFetch(
			async (u) => (u.includes("/files/f1?fields") ? (await gate, undefined) : undefined), // hold f1's verify mid-flight
			(u) => (u === "https://oauth2.googleapis.com/token" ? json({ access_token: "at", expires_in: 3599 }) : undefined),
			(u) => { const m = /\/files\/(f\d)\?fields/.exec(u); return m ? json({ size: "100", md5Checksum: "abc", webViewLink: `https://drive.test/${m[1]}` }) : undefined; },
			(u) => (/\/files\/f\d\/permissions/.test(u) ? json({ id: "anyone" }) : undefined),
		);
		const a = call("/done", JSON.stringify({ file_id: "f1", md5: "abc", size: 100 }));
		await new Promise((r) => setTimeout(r, 20)); // f1 has claimed and is inside its Drive lookup
		const b = await call("/done", JSON.stringify({ file_id: "f2", md5: "abc", size: 100 }));
		release();
		expect([(await a).status, b.status]).toEqual([200, 409]);
		const j = (await getJob(env.DB, "j1"))!;
		expect([j.state, j.drive_file_id, j.drive_link]).toEqual(["done", "f1", "https://drive.test/f1"]);
		expect(shares(calls)).toEqual(["f1"]);
	});

	it("stale negative verifier (ABA: f1 rejected, f2 claimed) cannot queue a re-upload for f2", async () => {
		await job("verifying", { drive_file_id: "f2", md5: "abc", size: 100 });
		const stale = { ...(await getJob(env.DB, "j1"))!, drive_file_id: "f1" };
		drive("bad");
		await verify(env, stale, { file_id: "f1", md5: "abc", size: 100 });
		const j = (await getJob(env.DB, "j1"))!;
		expect([j.state, j.reuploads, j.pending_cmd, j.drive_file_id]).toEqual(["verifying", 0, null, "f2"]);
	});

	it("stale positive verifier for a file that no longer holds the claim does not publish", async () => {
		await job("verifying", { drive_file_id: "f2", md5: "abc", size: 100 });
		const stale = { ...(await getJob(env.DB, "j1"))!, drive_file_id: "f1" };
		const calls = drive("abc");
		await verify(env, stale, { file_id: "f1", md5: "abc", size: 100 });
		const j = (await getJob(env.DB, "j1"))!;
		expect([j.state, j.drive_link]).toEqual(["verifying", null]);
		expect(shares(calls)).toEqual([]);
	});

	const stale = async () => {
		await job("verifying", { drive_file_id: "f2", md5: "abc", size: 100, reuploads: 2 });
		await env.DB.prepare("INSERT INTO pods (id, job_id, cost_per_hr, created_at) VALUES ('p1', 'j1', 0.6, ?)").bind(Date.now()).run();
		return { ...(await getJob(env.DB, "j1"))!, drive_file_id: "f1" };
	};
	const untouched = async (calls: { method: string }[]) => {
		const j = (await getJob(env.DB, "j1"))!;
		expect([j.state, j.error_json, j.drive_file_id]).toEqual(["verifying", null, "f2"]);
		expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0); // pod not retired
	};

	it("delayed DriveAuthError from a stale verifier (f2 now claimed) does not fail the job", async () => {
		const old = await stale();
		const calls = mockFetch((u) => (u === "https://oauth2.googleapis.com/token" ? json({ error: "invalid_grant" }, 400) : undefined));
		await verify(env, old, { file_id: "f1", md5: "abc", size: 100 });
		await untouched(calls);
	});

	it("terminal md5 mismatch from a stale verifier does not fail the newer claim", async () => {
		const old = await stale();
		const calls = drive("bad");
		await verify(env, old, { file_id: "f1", md5: "abc", size: 100 });
		await untouched(calls);
	});

	it("terminal md5 mismatch on the live claim fails the job once and retires the pod", async () => {
		const cur = await stale();
		cur.drive_file_id = "f2";
		mockFetch(
			(u) => (u === "https://oauth2.googleapis.com/token" ? json({ access_token: "at", expires_in: 3599 }) : undefined),
			(u) => (u.includes("/files/f2?fields") ? json({ size: "100", md5Checksum: "bad", webViewLink: "x" }) : undefined),
			(_u, i) => (i.method === "DELETE" ? new Response(null, { status: 204 }) : undefined),
		);
		await verify(env, cur, { file_id: "f2", md5: "abc", size: 100 });
		const j = (await getJob(env.DB, "j1"))!;
		expect(j.state).toBe("failed");
		expect(JSON.parse(j.error_json!).code).toBe("md5_mismatch");
	});
});
