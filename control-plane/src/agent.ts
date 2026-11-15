// SPEC §5 Contract B: agent API (pod -> control plane) at /agent/{job_id}/*.
// Auth: Bearer JOB_TOKEN, SHA-256 compared in constant time; rejected after TTL or once the job is terminal.
import { Hono } from "hono";
import type {
	DoneIn, ErrorIn, HeartbeatIn, HelloIn, ScenePlan, SpecOut, UploadSessionIn,
} from "../../packages/contract/src/index";
import { CONSTANTS, MAX_REUPLOADS } from "./config";
import {
	activePod, constantTimeEqual, getJob, jobCost, logEvent, now, plan, sha256Hex, updateJob, voiceover, type JobRow,
} from "./db";
import { DriveAuthError, createSession, fileMeta, shareAnyone, streamFile } from "./drive";
import { recordBench } from "./bench";
import { hasFault } from "./faults";
import { failJob, retirePod } from "./selector";
import { isTerminal, transition } from "./state";

type Ctx = { Bindings: Env; Variables: { job: JobRow } };

/** waitUntil of this request, so a pod delete survives the agent's connection dropping (no-op in tests). */
const deferOf = (c: { executionCtx: { waitUntil(p: Promise<unknown>): void } }) => (p: Promise<unknown>) => {
	try {
		c.executionCtx.waitUntil(p);
	} catch {
		// No ExecutionContext (local test harness): the awaited call still completes the work.
	}
};
export const agentApp = new Hono<Ctx>().basePath("/agent/:job");

export const deps = { sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), pollMs: 2000 };

agentApp.use("*", async (c, next) => {
	const job = await getJob(c.env.DB, c.req.param("job")!);
	const token = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
	if (!job || !job.job_token_sha256 || !token) return c.json({ error: "unauthorized" }, 401);
	if (!constantTimeEqual(await sha256Hex(token), job.job_token_sha256)) return c.json({ error: "unauthorized" }, 401);
	if ((job.token_expires_at ?? 0) < now()) return c.json({ error: "token expired" }, 401);
	if (isTerminal(job.state)) return c.json({ error: `job ${job.state}`, cmd: "cancel" }, 410);
	c.set("job", job);
	await next();
});

agentApp.post("/hello", async (c) => {
	const job = c.get("job");
	const body = await c.req.json<HelloIn>();
	const pod = await activePod(c.env.DB, job.id);
	if (pod && now() - pod.created_at < 7 * 60_000 && (await hasFault(c.env.DB, job.id, "slow_boot"))) {
		return c.json({ error: "slow_boot fault: try again" }, 503);
	}
	if (pod) await c.env.DB.prepare("UPDATE pods SET hello_at = ?, last_heartbeat_at = ? WHERE id = ?").bind(now(), now(), pod.id).run();
	await logEvent(c.env.DB, job.id, "hello", body);
	if (job.state === "booting") await transition(c.env.DB, job, job.plan_json ? "rendering" : "waiting_for_plan");
	return c.json({ state: job.state === "rendering" ? "rendering" : "waiting_for_plan" });
});

agentApp.get("/spec", async (c) => {
	const deadline = now() + CONSTANTS.SPEC_LONG_POLL_S * 1000;
	let job = c.get("job");
	for (;;) {
		const p = plan(job);
		if (p && !isTerminal(job.state) && job.state !== "waiting_for_plan") {
			const out: SpecOut = { style: p.style, scenes: p.scenes, voiceover: voiceover(job), fps: p.fps, resolution: p.resolution };
			return c.json(out);
		}
		if (now() + deps.pollMs > deadline) return c.body(null, 204);
		await deps.sleep(deps.pollMs);
		job = (await getJob(c.env.DB, job.id))!;
	}
});

agentApp.post("/heartbeat", async (c) => {
	const job = c.get("job");
	const hb = await c.req.json<HeartbeatIn>();
	const pod = await activePod(c.env.DB, job.id);
	if (pod && !(await hasFault(c.env.DB, job.id, "silence_heartbeat"))) {
		await c.env.DB.prepare("UPDATE pods SET last_heartbeat_at = ? WHERE id = ?").bind(now(), pod.id).run();
	}
	// Clear the command only if it is still the one we read (approve/revise may race).
	const cmd = job.pending_cmd ?? "continue";
	await c.env.DB
		.prepare("UPDATE jobs SET stage = ?, pct = ?, scene = ?, pending_cmd = CASE WHEN pending_cmd = ? THEN NULL ELSE pending_cmd END, updated_at = ? WHERE id = ?")
		.bind(hb.stage ?? null, hb.pct ?? 0, hb.scene ?? null, job.pending_cmd, now(), job.id)
		.run();
	return c.json({ cmd });
});

agentApp.post("/previews", async (c) => {
	const job = c.get("job");
	const form = await c.req.formData();
	const round = job.qa_rounds;
	for (const [name, value] of form.entries()) {
		const m = /^scene-(\d+)-(\d+)$/.exec(name);
		if (!m || typeof value === "string") continue;
		const bytes = new Uint8Array(await (value as File).arrayBuffer());
		if (bytes.byteLength > 500 * 1024) return c.json({ error: `${name} is ${bytes.byteLength} bytes; max 500 KB` }, 413);
		await c.env.DB
			.prepare("INSERT OR REPLACE INTO previews (job_id, round, scene, idx, jpeg) VALUES (?, ?, ?, ?, ?)")
			.bind(job.id, round, +m[1], +m[2], bytes)
			.run();
	}
	// Round complete? rendering: every scene has 3 frames this round. rerendering: the revised scene does.
	const p = plan(job);
	const need = job.state === "rerendering" && job.rerender_scene ? [job.rerender_scene] : (p?.scenes ?? []).map((s) => s.n);
	const have = (
		await c.env.DB.prepare("SELECT scene, COUNT(*) AS k FROM previews WHERE job_id = ? AND round = ? GROUP BY scene").bind(job.id, round).all<{ scene: number; k: number }>()
	).results;
	const done = need.length > 0 && need.every((n) => (have.find((h) => h.scene === n)?.k ?? 0) >= 3);
	if (done && (job.state === "rendering" || job.state === "rerendering")) {
		await updateJob(c.env.DB, job.id, { rerender_scene: null });
		await transition(c.env.DB, job, "preview_ready", { round });
		if (job.approved) {
			// Replacement pod after approve: Claude already approved, go straight on.
			await updateJob(c.env.DB, job.id, { pending_cmd: "render_final" });
			await transition(c.env.DB, job, "final_render", { reason: "already_approved" });
		}
	}
	return c.body(null, 201);
});

agentApp.post("/upload-session", async (c) => {
	const job = c.get("job");
	const body = await c.req.json<UploadSessionIn>();
	try {
		if (await hasFault(c.env.DB, job.id, "revoke_drive", true)) throw new DriveAuthError("invalid_grant (revoke_drive fault)");
		let uri = await createSession(c.env, `${job.title}.mp4`, body.size);
		if (await hasFault(c.env.DB, job.id, "expire_upload_session", true)) uri += "&upload_id=expired-by-fault";
		if (job.state === "final_render") await transition(c.env.DB, job, "uploading");
		await logEvent(c.env.DB, job.id, "upload_session", { size: body.size, md5: body.md5 });
		return c.json({ session_uri: uri });
	} catch (e) {
		if (e instanceof DriveAuthError) {
			await failJob(c.env, c.env.DB, job, "drive_auth", e.message, deferOf(c));
			return c.json({ error: "drive_auth", cmd: "cancel" }, 410);
		}
		throw e;
	}
});

agentApp.post("/done", async (c) => {
	const job = c.get("job");
	const body = await c.req.json<DoneIn>();
	await updateJob(c.env.DB, job.id, { drive_file_id: body.file_id, md5: body.md5, size: body.size });
	if (job.state === "uploading") await transition(c.env.DB, job, "verifying");
	return c.json(await verify(c.env, job, body, deferOf(c)));
});

/** §7 verification: size + md5 must match, else re-upload (max 2); match -> share, DELETE pod, done. */
/**
 * `defer` runs work that must survive the agent's connection dropping. Deleting the pod kills the agent and
 * with it the open /done request, and Workers cancel a handler whose client is gone, so the pod delete is
 * the LAST step and goes through waitUntil (found live on 2026-11-16: drive_link stored, `done` never set).
 */
export async function verify(env: Env, job: JobRow, body: DoneIn, defer: (p: Promise<unknown>) => void = () => {}) {
	const db = env.DB;
	try {
		const meta = await fileMeta(env, body.file_id);
		const corrupt = await hasFault(db, job.id, "corrupt_md5", true);
		const ok = Number(meta.size) === body.size && meta.md5Checksum === body.md5 && !corrupt;
		await logEvent(db, job.id, "verify", { ok, size: meta.size, md5: meta.md5Checksum, corrupt });
		if (!ok) {
			if (job.reuploads >= MAX_REUPLOADS) {
				await failJob(env, db, job, "md5_mismatch", "md5 mismatch after 2 re-uploads", defer); // pod deleted last, inside
				return {};
			}
			await updateJob(db, job.id, { reuploads: job.reuploads + 1, pending_cmd: "reupload" });
			await transition(db, job, "uploading", { reason: "md5_mismatch" });
			return {};
		}
		await shareAnyone(env, body.file_id);
		const pod = await activePod(db, job.id);
		await updateJob(db, job.id, { drive_link: meta.webViewLink, ...(await jobCost(db, job.id)) });
		await transition(db, job, "done");
		// Only now delete the pod (this ends the agent and its request). Unconfirmed -> stays tracked, reaper retries.
		if (pod) {
			const retire = retirePod(env, db, job.id, pod.id, "done").then(async () => updateJob(db, job.id, await jobCost(db, job.id)));
			defer(retire);
			await retire;
		}
		return {};
	} catch (e) {
		if (e instanceof DriveAuthError) await failJob(env, db, job, "drive_auth", e.message, defer);
		else throw e;
		return {};
	}
}

agentApp.post("/error", async (c) => {
	const job = c.get("job");
	const body = await c.req.json<ErrorIn>();
	const counts = JSON.parse(job.render_errors) as Record<string, number>;
	const key = String(body.scene ?? 0);
	counts[key] = (counts[key] ?? 0) + 1;
	await updateJob(c.env.DB, job.id, {
		render_errors: JSON.stringify(counts),
		last_render_error: JSON.stringify({ stage: body.stage, scene: body.scene ?? null, log_tail: body.log_tail.slice(-2000) }),
	});
	await logEvent(c.env.DB, job.id, "render_error", { stage: body.stage, scene: body.scene, n: counts[key] });
	if (counts[key] >= CONSTANTS.RENDER_ERROR_RETRIES_MAX) {
		await failJob(c.env, c.env.DB, job, "render_errors", `scene ${key} failed ${counts[key]} times: ${body.log_tail.slice(-300)}`, deferOf(c));
		return c.json({ cmd: "cancel" });
	}
	return c.json({ cmd: "retry" });
});

agentApp.get("/input/voiceover", async (c) => {
	const vo = voiceover(c.get("job"));
	if (!vo.drive_file_id) return c.json({ error: "voiceover is text" }, 404);
	return streamFile(c.env, vo.drive_file_id);
});

/** Bench mode (env BENCH=1): the agent reports how long the 60 s test video took. */
agentApp.post("/bench", async (c) => {
	const { render_s } = await c.req.json<{ render_s: number }>();
	await recordBench(c.env, c.env.DB, c.get("job").id, render_s);
	return c.json({ cmd: "cancel" });
});

export type { ScenePlan };
