// Agent API (§5), watchdog (Prompt 4a) and the MCP flow (§3/§4) against fake RunPod + Drive, with fake time.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentApp, deps as agentDeps } from "../src/agent";
import { getJob } from "../src/db";
import { armFault } from "../src/faults";
import { acquireGpu, approve, deps as mcpDeps, reviseScene, submitJob, waitJob } from "../src/mcp";
import { deps as rpDeps } from "../src/runpod";
import { selectAndCreate } from "../src/selector";
import { watchdog } from "../src/watchdog";
import { RTX4090, catalogOf, json, makeEnv, mockFetch } from "./helpers";

rpDeps.sleep = async () => {};
agentDeps.sleep = async (ms) => void vi.advanceTimersByTime(ms);
mcpDeps.sleep = async (ms) => void vi.advanceTimersByTime(ms);

const PLAN = {
	style: "explainer", fps: 30, resolution: "1920x1080",
	scenes: [
		{ n: 1, template: "title", props: { title: "Hi" }, duration_s: 3, narration: "Hi", transition: "cut" },
		{ n: 2, template: "end-card", props: {}, duration_s: 2, narration: "Bye", transition: "fade" },
	],
};
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

let env: Env;
let podN = 0;
let driveMd5 = "abc";
let calls: ReturnType<typeof mockFetch>;

function fakeCloud() {
	calls = mockFetch(
		(u) => (u.includes("/v2/catalog/datacenters") ? json(catalogOf({ "AP-IN-1": { [RTX4090]: "HIGH" }, "EU-RO-1": { [RTX4090]: "HIGH" } })) : undefined),
		(u, i) => {
			if (u === "https://rest.runpod.io/v1/pods" && i.method === "POST") {
				const dc = (JSON.parse(i.body as string) as { dataCenterIds: string[] }).dataCenterIds[0];
				return json({ id: `pod${++podN}`, costPerHr: 0.6, machine: { gpuTypeId: RTX4090, dataCenterId: dc } }, 201);
			}
		},
		(u, i) => (/runpod\.io\/v[12]\/pods\//.test(u) && i.method === "DELETE" ? json({}) : undefined),
		(u) => (u === "https://oauth2.googleapis.com/token" ? json({ access_token: "at", expires_in: 3599 }) : undefined),
		(u) => (u.startsWith("https://www.googleapis.com/upload/") ? new Response(null, { status: 200, headers: { Location: "https://upload.test/session1" } }) : undefined),
		(u) => (u.includes("/files/f1?fields") ? json({ size: "100", md5Checksum: driveMd5, webViewLink: "https://drive.test/f1" }) : undefined),
		(u) => (u.includes("/files/f1/permissions") ? json({ id: "anyone" }) : undefined),
	);
}

/** Pod-side caller: grabs the current token by re-running selection is not possible (hash only),
 *  so tests capture JOB_TOKEN from the create-pod request body, exactly as the pod gets it. */
function token() {
	const posts = calls.filter((c) => c.url === "https://rest.runpod.io/v1/pods" && c.method === "POST");
	return (posts.at(-1)!.body as { env: { JOB_TOKEN: string } }).env.JOB_TOKEN;
}
const agent = (jobId: string, path: string, body?: unknown, tok = token(), form?: FormData) =>
	agentApp.fetch(
		new Request(`https://cp.test/agent/${jobId}${path}`, {
			method: body === undefined && !form ? "GET" : "POST",
			headers: { Authorization: `Bearer ${tok}`, ...(form ? {} : { "Content-Type": "application/json" }) },
			body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
		}),
		env,
	);
const previews = (scenes: number[]) => {
	const f = new FormData();
	for (const s of scenes) for (const i of [0, 1, 2]) f.append(`scene-${s}-${i}`, new File([JPEG], "x.jpg", { type: "image/jpeg" }));
	return f;
};

beforeEach(() => {
	vi.useFakeTimers({ now: new Date("2026-11-15T10:00:00Z") });
	env = makeEnv();
	podN = 0;
	driveMd5 = "abc";
	fakeCloud();
});
afterEach(() => vi.useRealTimers());

async function newJob() {
	const { job_id } = await acquireGpu(env, env.DB, { style: "explainer", title: "My Video", voiceover: { text: "Hi. Bye." }, chat_key: "chatkeyA" });
	await selectAndCreate(env, env.DB, job_id);
	return job_id;
}

describe("happy path: acquire -> submit -> hello -> previews -> approve -> upload -> done", () => {
	it("ends with a shared Drive link, the pod deleted and cost recorded", async () => {
		const id = await newJob();
		expect((await acquireGpu(env, env.DB, { style: "explainer", title: "x", voiceover: { text: "y" }, chat_key: "chatkeyA" })).job_id).toBe(id); // idempotent

		// Claude submits while the pod boots (§3 step 4): state stays booting.
		expect(await submitJob(env.DB, id, PLAN)).toEqual({ state: "booting", gpu: "RTX 4090 · AP-IN-1" });

		// Pod says hello with a plan already stored -> rendering (Contradiction #3).
		const hello = await agent(id, "/hello", { gpu: RTX4090, vcpu: 16, ram_gb: 62, pod_id: "pod1", data_center: "AP-IN-1" });
		expect(await hello.json()).toEqual({ state: "rendering" });
		const spec = await (await agent(id, "/spec")).json();
		expect(spec).toMatchObject({ style: "explainer", fps: 30, resolution: "1920x1080", voiceover: { text: "Hi. Bye." } });
		expect(spec.scenes).toHaveLength(2);

		expect((await agent(id, "/previews", undefined, token(), previews([1]))).status).toBe(201);
		expect((await getJob(env.DB, id))!.state).toBe("rendering");
		await agent(id, "/previews", undefined, token(), previews([2]));
		const w = await waitJob(env.DB, id, "preview", 50);
		expect(w.out!.state).toBe("preview_ready");
		expect(w.out!.previews).toHaveLength(6);
		expect(w.images.filter((c) => c.type === "image")).toHaveLength(6);

		// One QA fix, then approve.
		expect(await reviseScene(env.DB, id, 1, { props: { title: "Hello" } })).toEqual({ state: "rerendering", scene: 1 });
		expect(await (await agent(id, "/heartbeat", { stage: "preview", pct: 50 })).json()).toEqual({ cmd: "rerender:1" });
		expect(await (await agent(id, "/heartbeat", { stage: "preview", pct: 60 })).json()).toEqual({ cmd: "continue" });
		await agent(id, "/previews", undefined, token(), previews([1]));
		expect((await getJob(env.DB, id))!.state).toBe("preview_ready");
		expect(await approve(env.DB, id)).toEqual({ state: "final_render" });
		expect(await (await agent(id, "/heartbeat", { stage: "final_render", pct: 0 })).json()).toEqual({ cmd: "render_final" });

		const s = await (await agent(id, "/upload-session", { name: "My Video.mp4", size: 100, md5: "abc" })).json();
		expect(s).toEqual({ session_uri: "https://upload.test/session1" });
		const sessionReq = calls.find((c) => c.url.startsWith("https://www.googleapis.com/upload/"))!;
		expect(sessionReq.body).toEqual({ name: "My Video.mp4", parents: ["folder"] });

		vi.advanceTimersByTime(10 * 60_000);
		await agent(id, "/done", { file_id: "f1", md5: "abc", size: 100 });
		const job = (await getJob(env.DB, id))!;
		expect(job.state).toBe("done");
		expect(job.drive_link).toBe("https://drive.test/f1");
		expect(job.cost_usd).toBeCloseTo(0.1, 2); // 10 min at $0.60/hr
		expect(calls.some((c) => c.url.endsWith("/v2/pods/pod1") && c.method === "DELETE")).toBe(true);
		const done = await waitJob(env.DB, id, "done", 50);
		expect(done.out).toMatchObject({ state: "done", drive_link: "https://drive.test/f1", gpu_minutes: 10, cost_usd: job.cost_usd });

		// Terminal job: the pod's token no longer works.
		expect((await agent(id, "/heartbeat", { stage: "x", pct: 0 })).status).toBe(410);
	});

	it("md5 mismatch -> reupload cmd, state back to uploading", async () => {
		const id = await newJob();
		await submitJob(env.DB, id, PLAN);
		await agent(id, "/hello", { gpu: "g", vcpu: 8, ram_gb: 32, pod_id: "pod1", data_center: "AP-IN-1" });
		await agent(id, "/previews", undefined, token(), previews([1, 2]));
		await approve(env.DB, id);
		await agent(id, "/upload-session", { name: "x", size: 100, md5: "abc" });
		driveMd5 = "different";
		await agent(id, "/done", { file_id: "f1", md5: "abc", size: 100 });
		const job = (await getJob(env.DB, id))!;
		expect(job.state).toBe("uploading");
		expect(job.pending_cmd).toBe("reupload");
		expect(job.reuploads).toBe(1);
	});
});

describe("agent auth", () => {
	it("repairs only the failed scene of the current final render after the error was shown", async () => {
		const id = await newJob();
		await submitJob(env.DB, id, PLAN);
		await agent(id, "/hello", { gpu: "g", vcpu: 8, ram_gb: 32, pod_id: "pod1", data_center: "AP-IN-1" });
		await agent(id, "/previews", undefined, token(), previews([1, 2]));
		expect(await approve(env.DB, id)).toEqual({ state: "final_render" });
		const patch = { props: { title: "Updated" } };
		expect(await reviseScene(env.DB, id, 2, patch)).toHaveProperty("error");

		await agent(id, "/error", { stage: "final_render", scene: 2, log_tail: "Template error" });
		expect((await waitJob(env.DB, id, "done", 1)).out!.error).toContain("render error in scene 2 (final_render)");
		expect((await getJob(env.DB, id))!.last_render_error).toBeNull();
		expect(await reviseScene(env.DB, id, 1, patch)).toHaveProperty("error");
		expect(await reviseScene(env.DB, id, 2, patch)).toEqual({ state: "rerendering", scene: 2 });
		expect(await getJob(env.DB, id)).toMatchObject({ approved: 0, pending_cmd: "rerender:2", render_errors: '{"2":1}' });

		expect(await (await agent(id, "/heartbeat", { stage: "idle", pct: 0 })).json()).toEqual({ cmd: "rerender:2" });
		await agent(id, "/previews", undefined, token(), previews([2]));
		expect((await getJob(env.DB, id))!.state).toBe("preview_ready");
		expect(await approve(env.DB, id)).toEqual({ state: "final_render" });
		expect(await reviseScene(env.DB, id, 2, patch)).toHaveProperty("error");
		expect(podN).toBe(1);
	});

	it("rejects a wrong token and an expired token", async () => {
		const id = await newJob();
		expect((await agent(id, "/heartbeat", { stage: "x", pct: 0 }, "nope")).status).toBe(401);
		vi.advanceTimersByTime(31 * 60_000);
		expect((await agent(id, "/heartbeat", { stage: "x", pct: 0 })).status).toBe(401);
	});

	it("/spec long-polls and returns 204 with no plan", async () => {
		const id = await newJob();
		await agent(id, "/hello", { gpu: "g", vcpu: 8, ram_gb: 32, pod_id: "pod1", data_center: "AP-IN-1" });
		const r = await agent(id, "/spec");
		expect(r.status).toBe(204);
	});

	it("3 render errors in one scene -> failed (render_errors), pod deleted", async () => {
		const id = await newJob();
		await submitJob(env.DB, id, PLAN);
		await agent(id, "/hello", { gpu: "g", vcpu: 8, ram_gb: 32, pod_id: "pod1", data_center: "AP-IN-1" });
		const e = { stage: "preview", scene: 2, log_tail: "TypeError" };
		expect(await (await agent(id, "/error", e)).json()).toEqual({ cmd: "retry" });
		const w = await waitJob(env.DB, id, "preview", 50);
		expect(w.out!.error).toContain("render error in scene 2");
		await agent(id, "/error", e);
		expect(await (await agent(id, "/error", e)).json()).toEqual({ cmd: "cancel" });
		expect(JSON.parse((await getJob(env.DB, id))!.error_json!).code).toBe("render_errors");
	});
});

describe("watchdog (fake time)", () => {
	it("no /hello within 6 min -> DELETE, skip that data center, new pod elsewhere", async () => {
		const id = await newJob();
		vi.advanceTimersByTime(6 * 60_000 + 1000);
		await watchdog(env, env.DB);
		const job = (await getJob(env.DB, id))!;
		expect(job.state).toBe("booting");
		expect(JSON.parse(job.skip_dcs)).toEqual(["AP-IN-1"]);
		expect(job.gpu_label).toBe("RTX 4090 · EU-RO-1");
		expect(calls.some((c) => c.url.endsWith("/v2/pods/pod1") && c.method === "DELETE")).toBe(true);
	});

	it("heartbeat silent 60 s while rendering -> replaced with the same plan; 3rd loss -> failed", async () => {
		const id = await newJob();
		await submitJob(env.DB, id, PLAN);
		for (let i = 1; i <= 3; i++) {
			const r = await agent(id, "/hello", { gpu: "g", vcpu: 8, ram_gb: 32, pod_id: `pod${i}`, data_center: "AP-IN-1" });
			expect(await r.json()).toEqual({ state: "rendering" });
			vi.advanceTimersByTime(61_000);
			await watchdog(env, env.DB);
			const job = (await getJob(env.DB, id))!;
			if (i < 3) {
				expect(job.state).toBe("booting");
				expect(job.attempts).toBe(i);
				expect(job.plan_json).toBe(JSON.stringify(PLAN));
			} else {
				expect(job.state).toBe("failed");
				expect(JSON.parse(job.error_json!).code).toBe("pod_replacements");
			}
		}
		const live = await env.DB.prepare("SELECT COUNT(*) n FROM pods WHERE deleted_at IS NULL").first<{ n: number }>();
		expect(live).toEqual({ n: 0 });
	});

	it("an old pod's token stops working after replacement", async () => {
		const id = await newJob();
		const old = token();
		await submitJob(env.DB, id, PLAN);
		await agent(id, "/hello", { gpu: "g", vcpu: 8, ram_gb: 32, pod_id: "pod1", data_center: "AP-IN-1" });
		vi.advanceTimersByTime(61_000);
		await watchdog(env, env.DB);
		expect((await agent(id, "/heartbeat", { stage: "x", pct: 0 }, old)).status).toBe(401);
		expect((await agent(id, "/heartbeat", { stage: "x", pct: 0 })).status).toBe(200);
	});

	it("silence_heartbeat affects one pod even if it never fetched the fault command", async () => {
		const id = await newJob();
		await submitJob(env.DB, id, PLAN);
		const hello = { gpu: "g", vcpu: 8, ram_gb: 32, pod_id: "pod1", data_center: "AP-IN-1" };
		await agent(id, "/hello", hello);
		await armFault(env, id, "silence_heartbeat");
		vi.advanceTimersByTime(61_000);
		await watchdog(env, env.DB);
		expect((await getJob(env.DB, id))!.attempts).toBe(1);
		expect(podN).toBe(2);
		await agent(id, "/hello", { ...hello, pod_id: "pod2" });

		vi.advanceTimersByTime(40_000);
		const heartbeat = await agent(id, "/heartbeat", { stage: "rendering", pct: 25 });
		expect(await heartbeat.json()).toEqual({ cmd: "continue" });
		expect(await env.DB.prepare("SELECT last_heartbeat_at FROM pods WHERE id = 'pod2'").first())
			.toEqual({ last_heartbeat_at: Date.now() });
		vi.advanceTimersByTime(25_000);
		await watchdog(env, env.DB);
		expect(podN).toBe(2);
		expect((await getJob(env.DB, id))!.state).toBe("rendering");
	});

	it("cost over max per job -> failed (budget)", async () => {
		const id = await newJob();
		await agent(id, "/hello", { gpu: "g", vcpu: 8, ram_gb: 32, pod_id: "pod1", data_center: "AP-IN-1" });
		for (let m = 0; m < 101; m++) {
			vi.advanceTimersByTime(60_000);
			await agent(id, "/heartbeat", { stage: "x", pct: 0 }).catch(() => undefined);
		}
		await watchdog(env, env.DB);
		expect(JSON.parse((await getJob(env.DB, id))!.error_json!).code).toBe("budget");
	});

	it("max pods at once: the 16th job queues, then starts when a slot frees", async () => {
		const ids: string[] = [];
		for (let i = 0; i < 16; i++) {
			const r = await acquireGpu(env, env.DB, { style: "explainer", title: `v${i}`, voiceover: { text: "x" }, chat_key: `key${i}` });
			ids.push(r.job_id);
			if (r.state === "provisioning") await selectAndCreate(env, env.DB, r.job_id);
		}
		expect((await getJob(env.DB, ids[15]))!.state).toBe("queued");
		await env.DB.prepare("UPDATE pods SET deleted_at = 1 WHERE job_id = ?").bind(ids[0]).run();
		await env.DB.prepare("UPDATE jobs SET state = 'cancelled' WHERE id = ?").bind(ids[0]).run();
		await watchdog(env, env.DB);
		expect((await getJob(env.DB, ids[15]))!.state).toBe("booting");
	});
});
