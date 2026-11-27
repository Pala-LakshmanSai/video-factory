// Style "footage": vf footage uploads a bundle to footage/<sha> -> scene 1 props.bundle -> GET /agent/{job}/input/bundle.
import { beforeEach, describe, expect, it } from "vitest";
import { agentApp } from "../src/agent";
import { b2 } from "../src/blobs";
import { sha256Hex } from "../src/db";
import { acquireGpu, submitJob } from "../src/mcp";
import { makeEnv, mockFetch } from "./helpers";

const R2 = "https://acct.r2.cloudflarestorage.com/bucket";
const SHA = "a".repeat(64);
const CLIP = "b".repeat(64);
const manifest = { v: 1, skill: "doomsday", cwd: ".", cmd: ["python3", "skill/scripts/render_edit.py", "job/edit.json"], out: "job/out/final.mp4", files: { "job/footage/src/x.mp4": { sha256: CLIP, size: 9 }, "job/footage/src/y.mp4": { sha256: CLIP, size: 9 } } };
const planOf = (props: Record<string, unknown> = { bundle: SHA, skill: "doomsday" }, n = 1) => ({
	style: "footage", fps: 30, resolution: "1920x1080",
	scenes: Array.from({ length: n }, (_, i) => ({ n: i + 1, template: "bundle", props, duration_s: 1320, narration: "", transition: "cut" })),
});

let env: Env;
let stored: Set<string>;
async function seed(plan: unknown = null) {
	const cols = { id: "j1", chat_key: "k", state: "waiting_for_plan", title: "t", style: "footage", voiceover_json: '{"none":true}', plan_json: plan && JSON.stringify(plan),
		created_at: Date.now(), updated_at: Date.now(), job_token_sha256: await sha256Hex("tok"), token_expires_at: Date.now() + 3_600_000 };
	await env.DB.prepare(`INSERT INTO jobs (${Object.keys(cols).join(", ")}) VALUES (${Object.keys(cols).map(() => "?").join(", ")})`).bind(...Object.values(cols)).run();
}
const get = (path: string, tok = "tok") => agentApp.fetch(new Request(`https://cp.test/agent/j1${path}`, { headers: { Authorization: `Bearer ${tok}` } }), env);

beforeEach(() => {
	env = Object.assign(makeEnv(), { R2_ENDPOINT: R2, R2_KEY_ID: "id", R2_SECRET: "secret" });
	stored = new Set([SHA]);
	mockFetch((url, init) => {
		const m = /\/footage\/([0-9a-f]{64})$/.exec(new URL(url).pathname);
		if (!url.startsWith(R2) || !m) return undefined;
		if (!stored.has(m[1])) return new Response(null, { status: 404 });
		return new Response(init.method === "HEAD" ? null : JSON.stringify(manifest), { status: 200 });
	});
});

describe("style footage", () => {
	it("acquire needs voiceover {none: true}", async () => {
		await expect(acquireGpu(env, env.DB, { style: "footage", title: "t", voiceover: { text: "hi" }, chat_key: "abcd" })).rejects.toThrow(/none: true/);
		expect(await acquireGpu(env, env.DB, { style: "footage", title: "t", voiceover: { none: true }, chat_key: "abce" })).toHaveProperty("job_id");
	});

	it("submit_job: one scene, a bundle sha and a skill; the bundle must exist", async () => {
		await seed();
		const s = b2(env);
		expect(await submitJob(env.DB, "j1", planOf(undefined, 2), env.OAUTH_KV, s)).toMatchObject({ error: expect.stringMatching(/exactly one scene/) });
		expect(await submitJob(env.DB, "j1", planOf({ bundle: "x", skill: "Doom!" }), env.OAUTH_KV, s)).toMatchObject({ error: expect.stringMatching(/props\.bundle[\s\S]*props\.skill/) });
		expect(await submitJob(env.DB, "j1", planOf({ bundle: CLIP, skill: "doomsday" }), env.OAUTH_KV, s)).toMatchObject({ error: expect.stringMatching(/not found/) });
		expect(await submitJob(env.DB, "j1", planOf(), env.OAUTH_KV, s)).toMatchObject({ state: "rendering" });
	});

	it("GET /input/bundle: manifest + one signed link per distinct file sha; 404 when the bundle is gone", async () => {
		await seed(planOf());
		expect((await get("/input/bundle", "wrong")).status).toBe(401);
		const r = (await (await get("/input/bundle")).json()) as { manifest: typeof manifest; links: Record<string, string> };
		expect(r.manifest).toEqual(manifest);
		expect(Object.keys(r.links)).toEqual([CLIP]);
		expect(r.links[CLIP]).toMatch(new RegExp(`^${R2}/footage/${CLIP}\\?X-Amz-Expires=3600.*X-Amz-Signature=`));
		stored.clear();
		expect((await get("/input/bundle")).status).toBe(404);
	});
});
