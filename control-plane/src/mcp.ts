// SPEC §4 Contract A: MCP tools (Claude -> control plane). Claude runs unattended (§1), so every
// description says what to call next. failed_no_capacity is the only state reported mid-run (§8).
import { McpServer } from "@modelcontextprotocol/server";
import { env, waitUntil } from "cloudflare:workers";
import { z } from "zod";
import type { JobState, PreviewLabel, Scene, ScenePlan, Voiceover, WaitJobOut } from "../../packages/contract/src/index";
import { CONSTANTS, MAX_PODS_AT_ONCE, STYLES } from "./config";
import { activePod, getJob, jobCost, logEvent, now, plan, randomId, updateJob, type JobRow } from "./db";
import { mergePatch, validatePlan } from "./plan";
import { retirePod, selectAndCreate } from "./selector";
import { isTerminal, transition } from "./state";

export const deps = { sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), pollMs: 2000 };

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
const json = (o: unknown, extra: Content[] = []) => ({ content: [{ type: "text" as const, text: JSON.stringify(o) }, ...extra] });
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true });

const NEXT = {
	acquire: "Next: write the scene_plan from the style doc and call submit_job. Do not call acquire_gpu again in this chat.",
	submit: 'Next: call wait_job {job_id, until:"preview", timeout_s:50} repeatedly until state is preview_ready.',
	preview: "Next: inspect every preview frame; fix problems with revise_scene (max 2 rounds), then call approve.",
	done: 'Next: call wait_job {job_id, until:"done", timeout_s:50} repeatedly until state is done.',
};

/** Pods running now + jobs about to get one (for the max-pods-at-once queue). */
export async function busySlots(db: D1Database) {
	const r = await db
		.prepare("SELECT (SELECT COUNT(*) FROM pods WHERE deleted_at IS NULL) + (SELECT COUNT(*) FROM jobs WHERE state IN ('provisioning','retrying')) AS n")
		.first<{ n: number }>();
	return r?.n ?? 0;
}

export async function acquireGpu(e: Env, db: D1Database, a: { style: string; title: string; voiceover: Voiceover; chat_key: string }, opts: { dev_mode?: string } = {}) {
	const byKey = () => db.prepare("SELECT * FROM jobs WHERE chat_key = ?").bind(a.chat_key).first<JobRow>();
	const existing = await byKey();
	if (existing) return { job_id: existing.id, state: existing.state };
	const id = randomId("j_");
	const state: JobState = (await busySlots(db)) >= MAX_PODS_AT_ONCE ? "queued" : "provisioning";
	const t = now();
	// A concurrent repeat call with the same chat_key loses the race and returns the winner's job.
	const r = await db
		.prepare("INSERT INTO jobs (id, chat_key, state, title, style, voiceover_json, ttl_min, dev_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(chat_key) DO NOTHING")
		.bind(id, a.chat_key, state, a.title, a.style, JSON.stringify(a.voiceover), CONSTANTS.POD_TTL_MIN, opts.dev_mode ?? null, t, t)
		.run();
	if (!r.meta.changes) {
		const won = (await byKey())!;
		return { job_id: won.id, state: won.state };
	}
	await logEvent(db, id, "state", { from: null, to: state });
	return { job_id: id, state, created: true as const };
}

export async function submitJob(db: D1Database, jobId: string, scenePlan: unknown) {
	const job = await getJob(db, jobId);
	if (!job) return { error: `no job ${jobId}` };
	if (isTerminal(job.state)) return { error: `job is ${job.state}` };
	const errs = validatePlan(scenePlan, job.style);
	if (errs.length) return { error: "scene_plan invalid; fix and call submit_job again:\n- " + errs.join("\n- ") };
	if (job.plan_json && !["queued", "provisioning", "booting", "waiting_for_plan", "retrying"].includes(job.state)) {
		return { error: `plan already rendering (state ${job.state}); use revise_scene to change a scene` };
	}
	await updateJob(db, job.id, { plan_json: JSON.stringify(scenePlan) });
	await logEvent(db, job.id, "plan_submitted", { scenes: (scenePlan as ScenePlan).scenes.length });
	if (job.state === "waiting_for_plan") await transition(db, job, "rendering");
	return { state: job.state, gpu: job.gpu_label };
}

/** Long-poll D1 every 2 s; return early on the target state, a terminal state or an unseen render error. */
export async function waitJob(db: D1Database, jobId: string, until: "preview" | "done", timeoutS = 50) {
	const deadline = now() + Math.min(timeoutS, CONSTANTS.WAIT_JOB_TIMEOUT_MAX_S) * 1000;
	const target: JobState = until === "preview" ? "preview_ready" : "done";
	for (;;) {
		const job = await getJob(db, jobId);
		if (!job) return { out: null, images: [] as Content[], error: `no job ${jobId}` };
		const reached = job.state === target || (until === "preview" && ["final_render", "uploading", "verifying", "done"].includes(job.state));
		const renderError = job.last_render_error && !isTerminal(job.state);
		if (reached || isTerminal(job.state) || renderError || now() + deps.pollMs > deadline) {
			const out: WaitJobOut = { state: job.state, pct: job.pct, previews: [] };
			const images: Content[] = [];
			if (job.state === "preview_ready") {
				// Latest version of every frame across rounds (a rerender round only re-does one scene).
				const rows = (
					await db
						.prepare(
							"SELECT p.round, p.scene, p.idx, p.jpeg FROM previews p JOIN (SELECT scene, idx, MAX(round) r FROM previews WHERE job_id = ? GROUP BY scene, idx) m ON p.scene = m.scene AND p.idx = m.idx AND p.round = m.r WHERE p.job_id = ? ORDER BY p.scene, p.idx",
						)
						.bind(job.id, job.id)
						.all<{ round: number; scene: number; idx: number; jpeg: ArrayBuffer | number[] }>()
				).results;
				for (const r of rows) {
					const label: PreviewLabel = { scene: r.scene, idx: r.idx, round: r.round };
					out.previews.push(label);
					images.push({ type: "text", text: `scene ${r.scene} frame ${r.idx} (round ${r.round})` });
					images.push({ type: "image", data: b64(r.jpeg), mimeType: "image/jpeg" });
				}
			}
			if (job.state === "done") {
				out.drive_link = job.drive_link ?? undefined;
				out.gpu_minutes = Math.round((job.gpu_seconds / 60) * 10) / 10;
				out.cost_usd = job.cost_usd;
			}
			if (job.error_json) {
				const e = JSON.parse(job.error_json) as { code: string; message: string };
				out.error = `${e.code}: ${e.message}`;
			} else if (renderError) {
				const e = JSON.parse(job.last_render_error!) as { scene: number | null; stage: string; log_tail: string };
				out.error = `render error in scene ${e.scene} (${e.stage}): ${e.log_tail.slice(-1500)}`;
				await updateJob(db, job.id, { last_render_error: null }); // shown once
			}
			return { out, images, job };
		}
		await deps.sleep(deps.pollMs);
	}
}

function b64(buf: ArrayBuffer | number[]) {
	const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : Uint8Array.from(buf);
	let s = "";
	for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(s);
}

export async function approve(db: D1Database, jobId: string) {
	const job = await getJob(db, jobId);
	if (!job) return { error: `no job ${jobId}` };
	if (job.state !== "preview_ready") return { error: `approve needs state preview_ready, job is ${job.state}; keep calling wait_job` };
	await updateJob(db, job.id, { approved: 1, pending_cmd: "render_final" });
	await transition(db, job, "final_render");
	return { state: "final_render" as const };
}

export async function reviseScene(db: D1Database, jobId: string, scene: number, patch: Partial<Scene>) {
	const job = await getJob(db, jobId);
	if (!job) return { error: `no job ${jobId}` };
	if (!["rendering", "preview_ready", "rerendering", "final_render"].includes(job.state)) return { error: `revise_scene needs a preview or a reported final render error, job is ${job.state}` };
	const p = plan(job)!;
	const i = p.scenes.findIndex((s) => s.n === scene);
	if (i < 0) return { error: `no scene ${scene}; scenes are 1..${p.scenes.length}` };
	const next = { ...p, scenes: p.scenes.map((s, k) => (k === i ? ({ ...(mergePatch(s, patch) as Scene), n: scene }) : s)) };
	const errs = validatePlan(next, job.style);
	if (errs.length) return { error: "patched scene invalid:\n- " + errs.join("\n- ") };
	if (job.state === "final_render") {
		// wait_job clears the notification after showing it. Use the event to require a scene error
		// after the latest state transition, and fence the repair against concurrent progress or approval.
		const last = await db.prepare("SELECT id, kind, data_json FROM events WHERE job_id = ? AND kind IN ('state', 'render_error') ORDER BY id DESC LIMIT 1")
			.bind(job.id).first<{ id: number; kind: string; data_json: string }>();
		const error = last?.kind === "render_error" ? JSON.parse(last.data_json) as { stage: string; scene?: number; n: number } : null;
		if (!last || error?.stage !== "final_render" || error.scene !== scene || !Number.isInteger(error.n) || error.n < 1 || error.n >= CONSTANTS.RENDER_ERROR_RETRIES_MAX) {
			return { error: `revise_scene during final_render requires a reported final render error for scene ${scene}` };
		}
		const result = await db.prepare(
			"UPDATE jobs SET state = 'rerendering', plan_json = ?, pending_cmd = ?, rerender_scene = ?, qa_rounds = qa_rounds + 1, approved = 0, last_render_error = NULL, updated_at = ? " +
			"WHERE id = ? AND state = 'final_render' AND qa_rounds = ? AND ? = (SELECT MAX(id) FROM events WHERE job_id = ? AND kind IN ('state', 'render_error'))",
		).bind(JSON.stringify(next), `rerender:${scene}`, scene, now(), job.id, job.qa_rounds, last.id, job.id).run();
		if (result.meta.changes !== 1) return { error: "job changed while repairing final render; call wait_job" };
		await logEvent(db, job.id, "state", { from: "final_render", to: "rerendering", scene });
		return { state: "rerendering" as const, scene };
	}
	await updateJob(db, job.id, { plan_json: JSON.stringify(next), pending_cmd: `rerender:${scene}`, rerender_scene: scene, qa_rounds: job.qa_rounds + 1 });
	await transition(db, job, "rerendering", { scene });
	return { state: "rerendering" as const, scene };
}

export async function release(e: Env, db: D1Database, jobId: string) {
	const job = await getJob(db, jobId);
	if (!job) return { error: `no job ${jobId}` };
	const pod = await activePod(db, job.id);
	if (pod) {
		await retirePod(e, db, job.id, pod.id, "released");
	}
	if (!isTerminal(job.state)) await transition(db, job, "cancelled");
	await updateJob(db, job.id, await jobCost(db, job.id));
	return { state: job.state };
}

const voiceoverSchema = z.union([
	z.object({ text: z.string().min(1) }).strict(),
	z.object({ drive_file_id: z.string().min(1) }).strict(),
]);

export function createServer() {
	const server = new McpServer({ name: "Video Factory", version: "2.0.0" });
	const db = env.DB;

	server.registerTool(
		"acquire_gpu",
		{
			description:
				"Call FIRST for a new video request, before planning: rents a fresh GPU while you plan. Pass a random 8-letter chat_key you make once per chat and reuse it on any repeat call (same chat -> same job). Returns {job_id, state} in under 1 s. " + NEXT.acquire,
			inputSchema: z.object({
				style: z.enum(STYLES as [string, ...string[]]),
				title: z.string().min(1).max(200),
				voiceover: voiceoverSchema,
				chat_key: z.string().min(4).max(64),
			}),
		},
		async (a) => {
			const { created, ...r } = await acquireGpu(env, db, a as never);
			// Only a new job starts selection: a repeat call must not race a second selectAndCreate (two pods).
			// A lost waitUntil is picked up by the watchdog's stuck-provisioning sweep.
			if (created && r.state === "provisioning") waitUntil(selectAndCreate(env, db, r.job_id).then(() => undefined));
			return json(r);
		},
	);

	server.registerTool(
		"submit_job",
		{
			description:
				"Submit the scene_plan {style, fps, resolution, scenes:[{n, template, props, duration_s, narration, transition}]} for job_id. Only templates and transitions from that style's doc. On validation errors, fix them and call submit_job again. " + NEXT.submit,
			inputSchema: z.object({ job_id: z.string(), scene_plan: z.record(z.string(), z.unknown()) }),
		},
		async ({ job_id, scene_plan }) => {
			const r = await submitJob(db, job_id, scene_plan);
			return "error" in r ? fail(r.error!) : json(r);
		},
	);

	server.registerTool(
		"wait_job",
		{
			description:
				'Long-poll a job (<= 50 s). until:"preview" returns when previews are ready (as images with scene labels); until:"done" returns the Drive link, GPU minutes and cost. provisioning, booting, retrying, rendering and rerendering are normal: just call wait_job again, never acquire_gpu. If it reports a render error for a scene, fix that scene with revise_scene (max 3 per scene). If state is failed, report the error and job_id to the user.',
			inputSchema: z.object({ job_id: z.string(), until: z.enum(["preview", "done"]), timeout_s: z.number().max(50).optional() }),
		},
		async ({ job_id, until, timeout_s }) => {
			const r = await waitJob(db, job_id, until, timeout_s ?? 50);
			if (r.error) return fail(r.error);
			const hint = r.out!.state === "preview_ready" ? NEXT.preview : r.out!.state === "done" ? "Post the final message now." : until === "done" ? NEXT.done : NEXT.submit;
			return { content: [{ type: "text" as const, text: JSON.stringify(r.out) + "\n" + hint }, ...r.images] };
		},
	);

	server.registerTool(
		"approve",
		{ description: "Approve the previews of job_id: the GPU renders and uploads the final video. " + NEXT.done, inputSchema: z.object({ job_id: z.string() }) },
		async ({ job_id }) => {
			const r = await approve(db, job_id);
			return "error" in r ? fail(r.error!) : json(r);
		},
	);

	server.registerTool(
		"revise_scene",
		{
			description:
				"Fix one scene: patch is a JSON merge patch on that scene (e.g. {props:{title:'...'}}). Only that scene re-renders. After a final render error, repair only the reported scene, then review and approve the new preview. " + 'Next: call wait_job {until:"preview"} again.',
			inputSchema: z.object({ job_id: z.string(), scene: z.number().int().min(1), patch: z.record(z.string(), z.unknown()) }),
		},
		async ({ job_id, scene, patch }) => {
			const r = await reviseScene(db, job_id, scene, patch as Partial<Scene>);
			return "error" in r ? fail(r.error!) : json(r);
		},
	);

	server.registerTool(
		"release",
		{ description: "Abort job_id and delete its GPU. Only when the user explicitly asks to abort.", inputSchema: z.object({ job_id: z.string() }) },
		async ({ job_id }) => {
			const r = await release(env, db, job_id);
			return "error" in r ? fail(r.error!) : json(r);
		},
	);

	return server;
}
