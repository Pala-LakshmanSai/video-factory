// E2E fault scenarios: real pod agent processes against agentApp over HTTP (see e2e-harness.ts).
//   cd control-plane && E2E=1 npx vitest run test/e2e-faults.test.ts
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getJob } from "../src/db";
import { armFault } from "../src/faults";
import { acquireGpu, approve, reviseScene, submitJob, waitJob } from "../src/mcp";
import { selectAndCreate } from "../src/selector";
import { watchdog } from "../src/watchdog";
import { PLAN, VO_SECONDS, ready, startHarness, type Harness } from "./e2e-harness";

const TTS_CACHE = "/private/tmp/claude-501/-Users-lakshmansai--claude-spares-spare-AohpXQ/074a52fc-5da0-4f7b-87d0-132c3165a4e7/scratchpad/tts";
const hasKokoro = existsSync(join(TTS_CACHE, "onnx-community/Kokoro-82M-v1.0-ONNX/onnx/model_quantized.onnx"));

describe.skipIf(!ready())("e2e faults", () => {
	let h: Harness;
	beforeEach(async () => void (h = await startHarness()));
	afterEach(async () => h?.stop());

	async function start(voiceover: { drive_file_id: string } | { text: string }, chat_key: string) {
		const { job_id: id } = await acquireGpu(h.env, h.env.DB, { style: "explainer", title: "Why Tea Cools", voiceover, chat_key });
		expect(await selectAndCreate(h.env, h.env.DB, id)).toBe("created");
		return id;
	}
	async function finish(id: string) {
		expect(await approve(h.env.DB, id)).toEqual({ state: "final_render" });
		await h.waitUntil(id, "done", "done", 300);
		const job = (await getJob(h.env.DB, id))!;
		return { job, info: await h.probe(h.files.get(job.drive_file_id!)!) };
	}

	it("pod dies after previews -> watchdog replaces it (new token) -> fresh agent re-renders the stored plan -> done", async () => {
		const { env, createBodies, deleted, base } = h;
		const id = await start({ drive_file_id: "vo1" }, "e2edie01");
		await submitJob(env.DB, id, PLAN);
		const a1 = h.spawnAgent({}, join(h.work, "pod1"));
		expect((await h.waitUntil(id, "preview", "preview_ready")).out!.previews).toHaveLength(12);

		// SIGKILL the pod; make its last heartbeat 61 s old (HEARTBEAT_DEAD_S = 60) and run the watchdog once.
		a1.proc.kill("SIGKILL");
		await a1.exited;
		await env.DB.prepare("UPDATE pods SET last_heartbeat_at = ? WHERE id = 'pod1'").bind(Date.now() - 61_000).run();
		await watchdog(env, env.DB);

		expect(deleted).toEqual(["pod1"]);
		const job = (await getJob(env.DB, id))!;
		expect(job).toMatchObject({ state: "booting", attempts: 1 });
		expect(createBodies).toHaveLength(2);
		const [t1, t2] = createBodies.map((b) => b.env.JOB_TOKEN);
		expect(t2).not.toBe(t1);
		expect(await env.DB.prepare("SELECT delete_reason FROM pods WHERE id = 'pod1'").first()).toEqual({ delete_reason: "heartbeat_lost" });
		expect(await env.DB.prepare("SELECT id FROM pods WHERE deleted_at IS NULL").all()).toEqual({ results: [{ id: "pod2" }] });
		// The dead pod's token no longer works.
		const old = await fetch(`${base}/agent/${id}/heartbeat`, { method: "POST", headers: { Authorization: `Bearer ${t1}`, "Content-Type": "application/json" }, body: "{}" });
		expect(old.status).toBe(401);

		// Replacement pod: fresh work dir, new token; hello goes straight to rendering (plan already stored).
		const a2 = h.spawnAgent({}, join(h.work, "pod2"));
		expect((await h.waitUntil(id, "preview", "preview_ready")).out!.previews).toHaveLength(12);
		const { job: fin, info } = await finish(id);
		expect(fin.plan_json).toBe(JSON.stringify(PLAN));
		expect(Math.abs(info.duration - VO_SECONDS)).toBeLessThanOrEqual(0.15);
		expect(deleted).toEqual(["pod1", "pod2"]);
		expect(await Promise.race([a2.exited, new Promise((r) => setTimeout(() => r("timeout"), 15_000))])).toBe(0);
		expect(a2.log()).toContain("hello -> rendering");
		expect(await h.states(id)).toEqual([
			"provisioning", "booting", "rendering", "preview_ready", "retrying", "booting", "rendering", "preview_ready", "final_render", "uploading", "verifying", "done",
		]);
	}, 600_000);

	it("render_error:2 -> wait_job reports scene 2 -> revise_scene fixes it -> previews -> done", async () => {
		const { env } = h;
		const id = await start({ drive_file_id: "vo1" }, "e2eerr01");
		// Arm before the plan so the fault reaches the agent (heartbeat) while it long-polls /spec.
		await armFault(env, id, "render_error:2");
		h.spawnAgent();
		for (let i = 0; (await getJob(env.DB, id))!.pending_cmd && i < 100; i++) await new Promise((r) => setTimeout(r, 200));
		expect((await getJob(env.DB, id))!.pending_cmd).toBeNull();
		await submitJob(env.DB, id, PLAN);

		let err = "";
		for (let i = 0; !err && i < 10; i++) {
			const w = await waitJob(env.DB, id, "preview", 50);
			expect(w.out!.state, h.logs()).toBe("rendering");
			err = w.out!.error ?? "";
		}
		expect(err).toMatch(/^render error in scene 2 \(preview\)/);
		expect(JSON.parse((await getJob(env.DB, id))!.render_errors)).toEqual({ "2": 1 });

		expect(await reviseScene(env.DB, id, 2, { props: { text: "Heat always flows hot to cold" } })).toEqual({ state: "rerendering", scene: 2 });
		const p = await h.waitUntil(id, "preview", "preview_ready");
		// The failed round posted nothing, so the fix round must preview every scene, not only scene 2.
		expect(p.out!.previews).toHaveLength(12);
		const { job, info } = await finish(id);
		expect(JSON.parse(job.render_errors)).toEqual({ "2": 1 });
		expect(Math.abs(info.duration - VO_SECONDS)).toBeLessThanOrEqual(0.15);
		expect(await h.states(id)).toEqual([
			"provisioning", "booting", "waiting_for_plan", "rendering", "rerendering", "preview_ready", "final_render", "uploading", "verifying", "done",
		]);
	}, 600_000);

	it.skipIf(!hasKokoro)("text voiceover through real Kokoro TTS -> final mp4 as long as the TTS wav, with audio", async () => {
		const id = await start({ text: "Tea cools because heat flows out. It escapes in three ways." }, "e2etts01");
		await submitJob(h.env.DB, id, PLAN);
		h.spawnAgent({ TTS_CACHE });
		await h.waitUntil(id, "preview", "preview_ready", 300);
		const { info } = await finish(id);
		const wav = await h.probe(await readFile(join(h.work, "vf/audio/voice.wav")), "voice.wav");
		expect(wav.duration).toBeGreaterThan(2);
		expect(Math.abs(info.duration - wav.duration)).toBeLessThanOrEqual(0.15);
		expect(info.streams.find((s) => s.codec_type === "audio")).toMatchObject({ codec_name: "aac" });
		expect(info.streams.find((s) => s.codec_type === "video")).toMatchObject({ codec_name: "h264", width: 640, height: 360 });
	}, 600_000);
});
