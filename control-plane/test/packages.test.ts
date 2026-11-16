// Style "custom": upload_package -> scene_plan.package -> GET /agent/{job}/input/package.
import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it } from "vitest";
import { agentApp } from "../src/agent";
import { sha256Hex } from "../src/db";
import { submitJob } from "../src/mcp";
import { MAX_PACKAGE_BYTES, putPackage } from "../src/packages";
import { makeEnv, mockFetch } from "./helpers";

let env: Env;
let calls: ReturnType<typeof mockFetch>;
const TGZ = gzipSync(Buffer.from("tokens.json fake tar"));
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const scenes = [{ n: 1, template: "my-hero", props: {}, duration_s: 3, narration: "Hi", transition: "cut" }];
const planOf = (style: string, extra: Record<string, unknown> = {}) => ({ style, fps: 30, resolution: "1920x1080", scenes, ...extra });

async function seed(style: string, plan: unknown = null) {
	const cols = { id: "j1", chat_key: "k", state: "waiting_for_plan", title: "t", style, voiceover_json: '{"text":"x"}', plan_json: plan && JSON.stringify(plan),
		created_at: Date.now(), updated_at: Date.now(), job_token_sha256: await sha256Hex("tok"), token_expires_at: Date.now() + 3_600_000 };
	await env.DB.prepare(`INSERT INTO jobs (${Object.keys(cols).join(", ")}) VALUES (${Object.keys(cols).map(() => "?").join(", ")})`).bind(...Object.values(cols)).run();
}
const jobCount = async () => (await env.DB.prepare("SELECT COUNT(*) n FROM jobs").first<{ n: number }>())!.n;
const get = (path: string, tok = "tok") => agentApp.fetch(new Request(`https://cp.test/agent/j1${path}`, { headers: { Authorization: `Bearer ${tok}` } }), env);

beforeEach(() => {
	env = makeEnv();
	calls = mockFetch(); // any provider call fails the test
});

describe("upload_package", () => {
	it("stores the bytes under pkg:<id>, is idempotent, creates no job and calls no provider", async () => {
		const a = await putPackage(env.OAUTH_KV, "my-kit", b64(TGZ));
		expect(a).toMatchObject({ bytes: TGZ.length, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
		const r = a as { package_id: string; sha256: string };
		expect(r.package_id).toBe("pk_" + r.sha256.slice(0, 24));
		expect(await putPackage(env.OAUTH_KV, "other", b64(TGZ))).toEqual(a);
		expect(Buffer.from((await env.OAUTH_KV.get(`pkg:${r.package_id}`, "arrayBuffer")) as ArrayBuffer)).toEqual(TGZ);
		expect(calls).toHaveLength(0);
		expect(await jobCount()).toBe(0);
	});

	it("rejects bad base64, missing gzip magic and > 8 MiB", async () => {
		expect(await putPackage(env.OAUTH_KV, "x", "@@not base64@@")).toHaveProperty("error");
		expect(await putPackage(env.OAUTH_KV, "x", b64(new Uint8Array([1, 2, 3])))).toMatchObject({ error: expect.stringMatching(/gzip/) });
		const big = new Uint8Array(MAX_PACKAGE_BYTES + 1);
		big.set([0x1f, 0x8b]);
		expect(await putPackage(env.OAUTH_KV, "x", b64(big))).toMatchObject({ error: expect.stringMatching(/8 MiB/) });
	});
});

describe("submit_job with style custom", () => {
	it("requires a well-formed package that exists in KV", async () => {
		await seed("custom");
		expect(await submitJob(env.DB, "j1", planOf("custom"), env.OAUTH_KV)).toMatchObject({ error: expect.stringMatching(/package must be/) });
		expect(await submitJob(env.DB, "j1", planOf("custom", { package: "pk_" + "0".repeat(24) }), env.OAUTH_KV))
			.toEqual({ error: `package pk_${"0".repeat(24)} not found or expired; call upload_package again` });
		const { package_id } = (await putPackage(env.OAUTH_KV, "kit", b64(TGZ))) as { package_id: string };
		expect(await submitJob(env.DB, "j1", planOf("custom", { package: package_id, scenes: [{ ...scenes[0], template: "Bad_Id" }] }), env.OAUTH_KV))
			.toMatchObject({ error: expect.stringMatching(/template must match/) });
		expect(await submitJob(env.DB, "j1", planOf("custom", { package: package_id }), env.OAUTH_KV)).not.toHaveProperty("error");
	});

	it("a registry style rejects a package", async () => {
		await seed("explainer");
		const r = await submitJob(env.DB, "j1", { ...planOf("explainer", { package: "pk_" + "0".repeat(24) }), scenes: [{ ...scenes[0], template: "title" }] }, env.OAUTH_KV);
		expect(r).toMatchObject({ error: expect.stringMatching(/package is only allowed with style "custom"/) });
	});
});

describe("GET /agent/:job/input/package", () => {
	it("needs the job token, returns the same bytes as application/gzip, 404 without a package", async () => {
		const { package_id } = (await putPackage(env.OAUTH_KV, "kit", b64(TGZ))) as { package_id: string };
		await seed("custom", planOf("custom", { package: package_id }));
		expect((await get("/input/package", "wrong")).status).toBe(401);
		const res = await get("/input/package");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("application/gzip");
		expect(Buffer.from(await res.arrayBuffer())).toEqual(TGZ);
		await env.OAUTH_KV.delete(`pkg:${package_id}`);
		expect((await get("/input/package")).status).toBe(404);
	});

	it("404 when the job has no package", async () => {
		await seed("explainer", { ...planOf("explainer"), scenes: [{ ...scenes[0], template: "title" }] });
		expect((await get("/input/package")).status).toBe(404);
	});
});
