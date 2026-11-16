// MCP protocol layer (SPEC §4): the real createServer() behind the real agents createMcpHandler, driven with
// JSON-RPC over Streamable HTTP exactly as Claude's connector sends it (initialize -> tools/list -> tools/call).
import { createMcpHandler } from "agents/mcp/server";
import { env as stubEnv, pending } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getJob } from "../src/db";
import { createServer } from "../src/mcp";
import { RTX4090, catalogOf, json, makeEnv, mockFetch } from "./helpers";
import { READY_STYLES, STYLE_REGISTRY } from "../../packages/contract/src/styles";

const handler = createMcpHandler(createServer);
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
const PROTO = "2025-06-18";
let id = 0;
let calls: ReturnType<typeof mockFetch>;
let podGate: Promise<void> = Promise.resolve(); // hold RunPod's create-pod reply to model its real latency

type Block = { type: string; text?: string; data?: string; mimeType?: string };
type Msg = { id?: number; result?: { content?: Block[]; isError?: boolean; tools?: Tool[] } & Record<string, unknown>; error?: { code: number; message: string } };
type Tool = { name: string; description: string; inputSchema: Schema };
type Schema = { type?: string; properties?: Record<string, Schema>; required?: string[]; enum?: string[]; anyOf?: Schema[]; maximum?: number; minimum?: number; additionalProperties?: unknown };

/** POST one JSON-RPC message; accepts either a JSON body or an SSE stream (takes the response for our id). */
async function rpc(method: string, params: unknown = {}, notification = false): Promise<Msg> {
	const body = notification ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: ++id, method, params };
	const res = await handler(
		new Request("https://cp.test/mcp", {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": PROTO },
			body: JSON.stringify(body),
		}),
		stubEnv,
		ctx,
	);
	if (notification) {
		expect(res.status).toBe(202);
		return {};
	}
	expect(res.status).toBe(200);
	const text = await res.text();
	if (!res.headers.get("content-type")?.includes("text/event-stream")) return JSON.parse(text);
	const msgs = text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)) as Msg);
	return msgs.find((m) => m.id === id)!;
}
const call = async (name: string, args: Record<string, unknown>) => (await rpc("tools/call", { name, arguments: args })).result!;
const textOf = (r: { content?: Block[] }) => r.content![0].text!;
const jsonOf = (r: { content?: Block[] }) => JSON.parse(textOf(r).split("\n")[0]);

const ACQ = { style: "explainer", title: "My Video", voiceover: { text: "Hi. Bye." }, chat_key: "chatkeyA" };
const PLAN = {
	style: "explainer", fps: 30, resolution: "1920x1080",
	scenes: [
		{ n: 1, template: "title", props: { title: "Hi" }, duration_s: 3, narration: "Hi", transition: "cut" },
		{ n: 2, template: "end-card", props: {}, duration_s: 2, narration: "Bye", transition: "fade" },
	],
};

async function seedJob(state: string, extra: Record<string, unknown> = {}) {
	const row = { id: "j_seed", chat_key: "seedkey", state, title: "T", style: "explainer", voiceover_json: '{"text":"x"}', plan_json: JSON.stringify(PLAN), ttl_min: 60, created_at: 1, updated_at: 1, ...extra };
	const cols = Object.keys(row);
	await stubEnv.DB.prepare(`INSERT INTO jobs (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).bind(...Object.values(row)).run();
	return row.id;
}

beforeEach(async () => {
	podGate = Promise.resolve();
	Object.assign(stubEnv, makeEnv()); // fresh D1 per test; createServer() reads env.DB per request
	let podN = 0;
	calls = mockFetch(
		(u) => (u.includes("/v2/catalog/datacenters") ? json(catalogOf({ "AP-IN-1": { [RTX4090]: "HIGH" } })) : undefined),
		async (u, i) => (u === "https://rest.runpod.io/v1/pods" && i.method === "POST" ? (await podGate, json({ id: `pod${++podN}`, costPerHr: 0.6, machine: { gpuTypeId: RTX4090, dataCenterId: "AP-IN-1" } }, 201)) : undefined),
		(u, i) => (/runpod\.io\/v[12]\/pods\//.test(u) && i.method === "DELETE" ? json({}) : undefined),
	);
	const init = await rpc("initialize", { protocolVersion: PROTO, capabilities: {}, clientInfo: { name: "claude-test", version: "1" } });
	expect(init.result).toMatchObject({ protocolVersion: PROTO, capabilities: { tools: {} }, serverInfo: { name: "Video Factory" } });
	await rpc("notifications/initialized", {}, true);
});
afterEach(async () => {
	for (const r of await Promise.allSettled(pending.splice(0))) expect(r.status).toBe("fulfilled");
});

describe("list_styles", () => {
	it("lists every registered style with status and rents nothing", async () => {
		const r = await call("list_styles", {});
		const styles = (JSON.parse((r as { content: { text: string }[] }).content[0].text) as { styles: { id: string; status: string }[] }).styles;
		expect(styles.map((s) => s.id)).toEqual(Object.keys(STYLE_REGISTRY));
		expect(styles.filter((s) => s.status === "ready").map((s) => s.id)).toEqual(READY_STYLES);
	});
});

describe("tools/list", () => {
	let tools: Record<string, Tool>;
	beforeEach(async () => {
		const list = (await rpc("tools/list")).result!.tools!;
		tools = Object.fromEntries(list.map((t) => [t.name, t]));
	});

	it("registers the six SPEC §4 tools plus list_styles", () => {
		expect(Object.keys(tools).sort()).toEqual(["acquire_gpu", "approve", "list_styles", "release", "revise_scene", "submit_job", "wait_job"]);
	});

	it("input schemas are JSON Schema objects with the SPEC field names", () => {
		for (const t of Object.values(tools)) {
			expect(t.inputSchema.type).toBe("object");
			expect(JSON.parse(JSON.stringify(t.inputSchema))).toEqual(t.inputSchema); // plain JSON, no zod leftovers
		}
		const a = tools.acquire_gpu.inputSchema;
		expect(a.required!.sort()).toEqual(["chat_key", "style", "title", "voiceover"]);
		expect(a.properties!.style.enum).toEqual(READY_STYLES); // only ready styles can be rented for
		expect(a.properties!.voiceover.anyOf!.map((s) => s.required)).toEqual([["text"], ["drive_file_id"]]);
		expect(a.properties!.voiceover.anyOf!.every((s) => s.additionalProperties === false)).toBe(true); // never both

		expect(tools.submit_job.inputSchema.required!.sort()).toEqual(["job_id", "scene_plan"]);
		expect(tools.submit_job.inputSchema.properties!.scene_plan.type).toBe("object");

		const w = tools.wait_job.inputSchema;
		expect(w.required!.sort()).toEqual(["job_id", "until"]);
		expect(w.properties!.until.enum).toEqual(["preview", "done"]);
		expect(w.properties!.timeout_s.maximum).toBe(50);

		expect(tools.approve.inputSchema.required).toEqual(["job_id"]);
		expect(tools.release.inputSchema.required).toEqual(["job_id"]);
		const r = tools.revise_scene.inputSchema;
		expect(r.required!.sort()).toEqual(["job_id", "patch", "scene"]);
		expect(r.properties!.scene).toMatchObject({ type: "integer", minimum: 1 });
		expect(r.properties!.patch.type).toBe("object");
	});

	it("descriptions tell Claude what to call next", () => {
		expect(tools.acquire_gpu.description).toMatch(/call submit_job/);
		expect(tools.acquire_gpu.description).toMatch(/chat_key/);
		expect(tools.submit_job.description).toMatch(/call wait_job/);
		expect(tools.wait_job.description).toMatch(/revise_scene/);
		expect(tools.wait_job.description).toMatch(/never acquire_gpu/);
		expect(tools.approve.description).toMatch(/wait_job .*until:"done"/);
		expect(tools.revise_scene.description).toMatch(/call wait_job/);
		expect(tools.release.description).toMatch(/explicitly asks to abort/);
	});
});

describe("tools/call", () => {
	it("acquire_gpu returns {job_id, state} at once; the pod is rented in waitUntil; chat_key is idempotent", async () => {
		const t0 = Date.now();
		const r = await call("acquire_gpu", ACQ);
		expect(Date.now() - t0).toBeLessThan(1000);
		expect(r.isError).toBeFalsy();
		const out = jsonOf(r);
		expect(Object.keys(out).sort()).toEqual(["job_id", "state"]);
		expect(out).toMatchObject({ job_id: expect.stringMatching(/^j_/), state: "provisioning" });

		await Promise.all(pending.splice(0));
		expect(calls.filter((c) => c.method === "POST" && c.url.endsWith("/v1/pods"))).toHaveLength(1);
		expect((await getJob(stubEnv.DB, out.job_id))!.state).toBe("booting");

		const again = jsonOf(await call("acquire_gpu", { ...ACQ, title: "other" }));
		expect(again).toEqual({ job_id: out.job_id, state: "booting" });
		expect(pending).toHaveLength(0); // a repeat call starts no second selection
	});

	it("a repeat acquire_gpu while still provisioning does not rent a second pod", async () => {
		let open!: () => void;
		podGate = new Promise((r) => (open = r));
		const a = jsonOf(await call("acquire_gpu", ACQ));
		const b = jsonOf(await call("acquire_gpu", ACQ)); // first selection still waiting on RunPod
		expect(b).toEqual(a);
		open();
		await Promise.all(pending.splice(0));
		podGate = Promise.resolve();
		expect(calls.filter((c) => c.method === "POST" && c.url.endsWith("/v1/pods"))).toHaveLength(1);
	});

	it("list_styles is read-only: zero jobs, zero provider calls", async () => {
		const r = await call("list_styles", {});
		expect(r.isError).toBeFalsy();
		await Promise.all(pending.splice(0));
		expect(calls).toHaveLength(0);
		expect((await stubEnv.DB.prepare("SELECT COUNT(*) n FROM jobs").first<{ n: number }>())!.n).toBe(0);
	});

	it("a pending (or unknown) style id is rejected by acquire_gpu with an otherwise valid request", async () => {
		const notReady = Object.keys(STYLE_REGISTRY).find((k) => STYLE_REGISTRY[k].status === "pending") ?? "stickman";
		expect(READY_STYLES).not.toContain(notReady);
		const r = await call("acquire_gpu", { ...ACQ, style: notReady });
		expect(r.isError).toBe(true);
		await Promise.all(pending.splice(0));
		expect(calls).toHaveLength(0);
		expect((await stubEnv.DB.prepare("SELECT COUNT(*) n FROM jobs").first<{ n: number }>())!.n).toBe(0);
	});

	it("acquire_gpu pins the job to the current renderer image", async () => {
		const out = jsonOf(await call("acquire_gpu", ACQ));
		expect((await getJob(stubEnv.DB, out.job_id))!.renderer_image).toBe(stubEnv.RENDERER_IMAGE);
		await Promise.all(pending.splice(0));
	});

	it("bad acquire_gpu input is a tool error, not a crash", async () => {
		const r = await call("acquire_gpu", { ...ACQ, style: "cartoon", voiceover: { text: "a", drive_file_id: "b" } });
		expect(r.isError).toBe(true);
		expect(textOf(r)).toMatch(/style/);
		expect(textOf(r)).toMatch(/voiceover/);
	});

	it("submit_job with an invalid plan returns isError with every problem", async () => {
		const { job_id } = jsonOf(await call("acquire_gpu", ACQ));
		const bad = { ...PLAN, style: "documentary", fps: 7, scenes: [{ ...PLAN.scenes[0], n: 2, template: "nope", transition: "spin" }] };
		const r = await call("submit_job", { job_id, scene_plan: bad });
		expect(r.isError).toBe(true);
		const msg = textOf(r);
		expect(msg).toMatch(/fix and call submit_job again/);
		expect(msg).toContain('style must be "explainer"');
		expect(msg).toContain("fps must be an integer 12..60");
		expect(msg).toContain("scenes[0].n must be 1");
		expect(msg).toContain('scenes[0].template "nope" is not in style explainer');
		expect(msg).toContain("scenes[0].transition must be one of");

		const ok = await call("submit_job", { job_id, scene_plan: PLAN });
		expect(ok.isError).toBeFalsy();
		expect(jsonOf(ok)).toMatchObject({ state: expect.any(String) });
		expect(textOf(await call("submit_job", { job_id: "j_nope", scene_plan: PLAN }))).toBe("no job j_nope");
	});

	it("wait_job at preview_ready returns labelled JPEG image blocks (latest round per frame)", async () => {
		const jid = await seedJob("preview_ready");
		const jpeg = (b: number) => new Uint8Array([0xff, 0xd8, b, 0xff, 0xd9]);
		const ins = (round: number, scene: number, idx: number, b: number) =>
			stubEnv.DB.prepare("INSERT INTO previews (job_id, round, scene, idx, jpeg) VALUES (?, ?, ?, ?, ?)").bind(jid, round, scene, idx, jpeg(b)).run();
		await ins(0, 1, 0, 1);
		await ins(0, 2, 0, 2);
		await ins(1, 1, 0, 3); // scene 1 re-rendered in round 1

		const r = await call("wait_job", { job_id: jid, until: "preview", timeout_s: 5 });
		expect(r.isError).toBeFalsy();
		const [head, ...rest] = r.content!;
		expect(head.type).toBe("text");
		const out = JSON.parse(head.text!.split("\n")[0]);
		expect(out).toMatchObject({ state: "preview_ready", previews: [{ scene: 1, idx: 0, round: 1 }, { scene: 2, idx: 0, round: 0 }] });
		expect(head.text).toMatch(/revise_scene .*approve/);
		expect(rest.map((b) => b.type)).toEqual(["text", "image", "text", "image"]);
		expect(rest[0].text).toBe("scene 1 frame 0 (round 1)");
		expect(rest[2].text).toBe("scene 2 frame 0 (round 0)");
		for (const b of [rest[1], rest[3]]) expect(b).toMatchObject({ mimeType: "image/jpeg", data: expect.stringMatching(/^[A-Za-z0-9+/]+=*$/) });
		expect([...Buffer.from(rest[1].data!, "base64")]).toEqual([...jpeg(3)]);
		expect([...Buffer.from(rest[3].data!, "base64")]).toEqual([...jpeg(2)]);
	});

	it("wait_job enforces timeout_s <= 50 and reports unknown jobs as tool errors", async () => {
		const tooLong = await call("wait_job", { job_id: "j_x", until: "preview", timeout_s: 51 });
		expect(tooLong.isError).toBe(true);
		expect(textOf(tooLong)).toMatch(/timeout_s/);
		const r = await call("wait_job", { job_id: "j_x", until: "done", timeout_s: 0 });
		expect(r).toMatchObject({ isError: true, content: [{ type: "text", text: "no job j_x" }] });
	});

	it("approve / revise_scene / release error paths are isError results, not JSON-RPC errors", async () => {
		for (const [name, args] of [
			["approve", { job_id: "j_x" }],
			["revise_scene", { job_id: "j_x", scene: 1, patch: {} }],
			["release", { job_id: "j_x" }],
		] as const) {
			const m = await rpc("tools/call", { name, arguments: args });
			expect(m.error).toBeUndefined();
			expect(m.result).toMatchObject({ isError: true, content: [{ type: "text", text: "no job j_x" }] });
		}
		const jid = await seedJob("rendering");
		expect(textOf(await call("approve", { job_id: jid }))).toMatch(/approve needs state preview_ready, job is rendering/);
		const noScene = await call("revise_scene", { job_id: jid, scene: 9, patch: {} });
		expect(noScene).toMatchObject({ isError: true });
		expect(textOf(noScene)).toBe("no scene 9; scenes are 1..2");
		const badPatch = await call("revise_scene", { job_id: jid, scene: 1, patch: { transition: "spin" } });
		expect(textOf(badPatch)).toMatch(/patched scene invalid:\n- scenes\[0\]\.transition/);
		expect((await call("revise_scene", { job_id: jid, scene: 0, patch: {} })).isError).toBe(true); // schema: scene >= 1
	});

	it("approve, revise_scene and release succeed on the happy path", async () => {
		const jid = await seedJob("preview_ready");
		expect(jsonOf(await call("revise_scene", { job_id: jid, scene: 2, patch: { props: { cta: "Sub" } } }))).toEqual({ state: "rerendering", scene: 2 });
		await stubEnv.DB.prepare("UPDATE jobs SET state = 'preview_ready' WHERE id = ?").bind(jid).run();
		expect(jsonOf(await call("approve", { job_id: jid }))).toEqual({ state: "final_render" });
		expect(jsonOf(await call("release", { job_id: jid }))).toEqual({ state: "cancelled" });
		expect(jsonOf(await call("release", { job_id: jid }))).toEqual({ state: "cancelled" }); // idempotent
	});

	it("unknown tool is reported, not thrown", async () => {
		const m = await rpc("tools/call", { name: "render_everything", arguments: {} });
		expect(m.error ?? m.result?.isError).toBeTruthy();
	});
});

describe("per-job renderer pin", () => {
	it("pods for a job use the job's pinned image, not a newer global one", async () => {
		const { podBody } = await import("../src/selector");
		const job = { id: "j_pin", dev_mode: null, renderer_image: "docker.io/x/video-renderer@sha256:old" } as never;
		const env2 = { ...stubEnv, RENDERER_IMAGE: "docker.io/x/video-renderer@sha256:new" } as Env;
		const a = { computeTier: "GPU/SECURE", dataCenterIds: ["EU-RO-1"], gpuTypeIds: [RTX4090] } as never;
		expect(podBody(env2, job, a, "tok").imageName).toBe("docker.io/x/video-renderer@sha256:old");
		expect(podBody(env2, { ...(job as object), renderer_image: null } as never, a, "tok").imageName).toBe("docker.io/x/video-renderer@sha256:new");
	});
});
