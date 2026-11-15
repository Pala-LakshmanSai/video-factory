// End-to-end: the real pod agent (renderer/agent/main.ts, its own Node process, real Chromium + ffmpeg)
// talks HTTP to the real agent API (agentApp) while this process drives the MCP functions.
// Fakes: RunPod, Google token/Drive metadata (stubbed fetch here) and the Drive resumable session (HTTP below).
// Slow (~1 min): runs only with E2E=1, and only when ffmpeg and Playwright's Chromium are installed.
//   cd control-plane && E2E=1 npx vitest run test/e2e.test.ts
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getJob } from "../src/db";
import { armFault } from "../src/faults";
import { acquireGpu, approve, reviseScene, submitJob } from "../src/mcp";
import { selectAndCreate } from "../src/selector";
import { PLAN, VO_SECONDS, ready, startHarness, type Agent, type Harness } from "./e2e-harness";

describe.skipIf(!ready())("e2e: pod agent process <-> agent API over HTTP", () => {
	let h: Harness;
	beforeAll(async () => void (h = await startHarness()));
	afterAll(async () => h?.stop());

	it("acquire -> pod agent renders previews -> revise -> approve -> final mp4 uploaded (drop + resume, md5 re-upload), verified, pod deleted", async () => {
		const { env, base, createBodies, deleted, sessions, files, waitUntil } = h;
		const { job_id: id, state } = await acquireGpu(env, env.DB, { style: "explainer", title: "Why Tea Cools", voiceover: { drive_file_id: "vo1" }, chat_key: "e2echat1" });
		expect(state).toBe("provisioning");
		expect(await selectAndCreate(env, env.DB, id)).toBe("created");
		expect(await submitJob(env.DB, id, PLAN)).toMatchObject({ state: "booting" });

		expect(createBodies.at(-1)!.env.CP_URL).toBe(base);
		const agent: Agent = h.spawnAgent();

		// First round: 3 key frames per scene, real JPEGs.
		const p1 = await waitUntil(id, "preview", "preview_ready");
		expect(p1.out!.previews).toHaveLength(12);
		const imgs = p1.images.filter((c) => c.type === "image") as { data: string }[];
		expect(imgs).toHaveLength(12);
		for (const im of imgs) expect([...Buffer.from(im.data, "base64").subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);

		// QA fix on scene 2 -> only scene 2 re-renders, in the next round.
		expect(await reviseScene(env.DB, id, 2, { props: { text: "Heat always flows hot to cold" } })).toEqual({ state: "rerendering", scene: 2 });
		const p2 = await waitUntil(id, "preview", "preview_ready");
		const r0 = p1.out!.previews[0].round;
		expect(p1.out!.previews.every((l) => l.round === r0)).toBe(true);
		expect(p2.out!.previews).toHaveLength(12);
		expect(p2.out!.previews.filter((l) => l.round !== r0)).toEqual([0, 1, 2].map((idx) => ({ scene: 2, idx, round: r0 + 1 })));

		// Faults: the agent drops the connection after upload chunk 1 (must query "bytes */size" and resume),
		// and the first verify sees a bad md5 (cmd reupload -> a second session). Agent faults ride the heartbeat.
		await armFault(env, id, "drop_upload_after_chunk:1");
		for (let i = 0; (await getJob(env.DB, id))!.pending_cmd && i < 50; i++) await new Promise((r) => setTimeout(r, 200));
		expect((await getJob(env.DB, id))!.pending_cmd).toBeNull();
		await armFault(env, id, "corrupt_md5");

		expect(await approve(env.DB, id)).toEqual({ state: "final_render" });
		const done = await waitUntil(id, "done", "done", 300);
		const job = (await getJob(env.DB, id))!;
		expect(job.state).toBe("done");
		expect(job.reuploads).toBe(1);
		expect(done.out!.drive_link).toBe(`https://drive.test/${job.drive_file_id}`);
		expect([...sessions.values()].map((s) => s.queries)).toEqual([1, 0]); // resumed once in session 1; session 2 clean
		expect(sessions.get("1")!.chunks.length).toBeGreaterThan(2); // really chunked
		expect(files.get("file1")).toEqual(files.get("file2"));

		// The bytes Drive received are the agent's mp4: md5/size match what /done reported, duration = voiceover.
		const bytes = files.get(job.drive_file_id!)!;
		expect(bytes.length).toBe(job.size);
		expect(createHash("md5").update(bytes).digest("hex")).toBe(job.md5);
		const info = await h.probe(bytes);
		expect(Math.abs(info.duration - VO_SECONDS)).toBeLessThanOrEqual(0.15);
		expect(info.streams.find((s) => s.codec_type === "video")).toMatchObject({ codec_name: "h264", width: 640, height: 360 });
		expect(info.streams.find((s) => s.codec_type === "audio")).toMatchObject({ codec_name: "aac" });

		// Pod deleted by the control plane; the agent gets 410 on its next heartbeat and exits.
		expect(deleted).toEqual(["pod1"]);
		const pod = await env.DB.prepare("SELECT deleted_at, delete_reason FROM pods WHERE id = 'pod1'").first<{ deleted_at: number | null; delete_reason: string }>();
		expect(pod).toMatchObject({ delete_reason: "done" });
		expect(pod!.deleted_at).not.toBeNull();
		const code = await Promise.race([agent.exited, new Promise((r) => setTimeout(() => r("timeout"), 15_000))]);
		expect(code, agent.log().slice(-2000)).toBe(0);
		expect(agent.log()).toContain("self-destruct: cancel");

		expect(await h.states(id)).toEqual(["provisioning", "booting", "rendering", "preview_ready", "rerendering", "preview_ready", "final_render", "uploading", "verifying", "uploading", "verifying", "done"]);
		const kinds = (await env.DB.prepare("SELECT kind FROM events WHERE job_id = ?").bind(id).all<{ kind: string }>()).results.map((e) => e.kind);
		expect(kinds).toEqual(expect.arrayContaining(["pod_created", "plan_submitted", "hello", "upload_session", "verify"]));
		// drop_upload_after_chunk:1 with 64 KiB chunks: the agent resumed at Drive's 308 offset and reported it.
		const resumed = (await env.DB.prepare("SELECT data_json FROM events WHERE job_id = ? AND kind = 'upload_resumed'").bind(id).all<{ data_json: string }>()).results;
		expect(resumed.length).toBeGreaterThanOrEqual(1);
		expect(JSON.parse(resumed[0].data_json).offset).toBeGreaterThan(0);
	}, 600_000);
});
