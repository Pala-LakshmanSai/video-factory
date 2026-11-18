// SPEC §4 Contract A: MCP tools (Claude -> control plane). Claude runs unattended (§1), so every
// description says what to call next. failed_no_capacity is the only state reported mid-run (§8).
import { McpServer } from "@modelcontextprotocol/server";
import { env, waitUntil } from "cloudflare:workers";
import { z } from "zod";
import { ttlMinFor, type JobState, type PreviewLabel, type Scene, type ScenePlan, type Voiceover, type WaitJobOut } from "../../packages/contract/src/index";
import { CONSTANTS, MAX_PODS_AT_ONCE, STYLES } from "./config";
import { STYLE_REGISTRY } from "../../packages/contract/src/styles";
import { activePod, getJob, jobCost, logEvent, now, plan, randomId, updateJob, type JobRow } from "./db";
import { canon, mergePatch, validatePlan } from "./plan";
import { getPackage, putPackage } from "./packages";
import { retirePod, selectAndCreate } from "./selector";
import { canTransition, cancelJob, isTerminal, transition } from "./state";
import { addPref, docNames, getDoc, groupPrefs, listPrefs, retirePref } from "./sync";

export const deps = { sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), pollMs: 2000 };

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
const json = (o: unknown, extra: Content[] = []) => ({ content: [{ type: "text" as const, text: JSON.stringify(o) }, ...extra] });
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true });

const NEXT = {
	acquire: "Next: if you have not yet in this chat, call style_guide {style} (live style doc + owner preferences, which override older Project knowledge), then write the scene_plan from it and call submit_job. Do not call acquire_gpu again in this chat.",
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
	if (existing) return { job_id: existing.id, state: existing.state }; // same-chat replay works even if the style was later hidden
	if ((e as unknown as Record<string, string>).ACQUIRE_ENABLED === "0") throw new Error("Video Factory is not accepting new videos right now (maintenance). Try again later.");
	if (!STYLES.includes(a.style)) throw new Error(`style "${a.style}" is not available for new videos; call list_styles and use a ready style id`);
	if ("none" in a.voiceover && STYLE_REGISTRY[a.style]?.audio !== "episode-score") throw new Error(`voiceover {none: true} is only for caption-led styles; style "${a.style}" needs text or drive_file_id`);
	const id = randomId("j_");
	const state: JobState = (await busySlots(db)) >= MAX_PODS_AT_ONCE ? "queued" : "provisioning";
	const t = now();
	// A concurrent repeat call with the same chat_key loses the race and returns the winner's job.
	const r = await db
		.prepare("INSERT INTO jobs (id, chat_key, state, title, style, voiceover_json, ttl_min, dev_mode, renderer_image, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(chat_key) DO NOTHING")
		.bind(id, a.chat_key, state, a.title, a.style, JSON.stringify(a.voiceover), CONSTANTS.POD_TTL_MIN, opts.dev_mode ?? null, e.RENDERER_IMAGE, t, t)
		.run();
	if (!r.meta.changes) {
		const won = (await byKey())!;
		return { job_id: won.id, state: won.state };
	}
	await logEvent(db, id, "state", { from: null, to: state });
	return { job_id: id, state, created: true as const };
}

export async function submitJob(db: D1Database, jobId: string, scenePlan: unknown, kv?: KVNamespace) {
	const job = await getJob(db, jobId);
	if (!job) return { error: `no job ${jobId}` };
	if (isTerminal(job.state)) return { error: `job is ${job.state}` };
	const errs = validatePlan(scenePlan, job.style);
	if (errs.length) return { error: "scene_plan invalid; fix and call submit_job again:\n- " + errs.join("\n- ") };
	const pkg = (scenePlan as ScenePlan).package;
	if (pkg && !(kv && (await getPackage(kv, pkg)))) return { error: `package ${pkg} not found or expired; call upload_package again` };
	// Compare-and-set on the state, never an unconditional write: a concurrent submit that already moved the job to
	// rendering must win, or /spec and /input/package could disagree about which plan (and package) the pod renders.
	const planJson = JSON.stringify(scenePlan);
	// One pod renders the whole video, so its TTL follows the plan's length: minutes already spent + ttlMinFor(total).
	// The reaper and the job token enforce it; the pod's own env timer is the max-length backstop (selector.ts).
	const total = (scenePlan as ScenePlan).scenes.reduce((a, s) => a + s.duration_s, 0);
	const ttl = Math.ceil((now() - job.created_at) / 60_000) + ttlMinFor(total);
	const tokenExp = now() + ttlMinFor(total) * 60_000;
	for (let cur = job; ; ) {
		if (cur.state === "waiting_for_plan") {
			const r = await db
				.prepare("UPDATE jobs SET plan_json = ?, ttl_min = ?, token_expires_at = MAX(COALESCE(token_expires_at, 0), ?), state = 'rendering', updated_at = ? WHERE id = ? AND state = 'waiting_for_plan'")
				.bind(planJson, ttl, tokenExp, now(), cur.id)
				.run();
			if (r.meta.changes) {
				await logEvent(db, cur.id, "plan_submitted", { scenes: (scenePlan as ScenePlan).scenes.length });
				await logEvent(db, cur.id, "state", { from: "waiting_for_plan", to: "rendering" });
				return { state: "rendering" as JobState, gpu: cur.gpu_label };
			}
		} else if (PRE_POD.includes(cur.state)) {
			const r = await db
				.prepare(`UPDATE jobs SET plan_json = ?, ttl_min = ?, token_expires_at = CASE WHEN token_expires_at IS NULL THEN NULL ELSE MAX(token_expires_at, ?) END, updated_at = ? WHERE id = ? AND state IN (${PRE_POD.map(() => "?").join(", ")})`)
				.bind(planJson, ttl, tokenExp, now(), cur.id, ...PRE_POD)
				.run();
			if (r.meta.changes) {
				await logEvent(db, cur.id, "plan_submitted", { scenes: (scenePlan as ScenePlan).scenes.length });
				return { state: cur.state, gpu: cur.gpu_label };
			}
		} else if (isTerminal(cur.state)) return { error: `job is ${cur.state}` };
		else return { error: `plan already rendering (state ${cur.state}); use revise_scene to change a scene` };
		cur = (await getJob(db, jobId))!; // lost the race: re-read and apply the rule to the new state
	}
}

const PREVIEW_IMAGES_MAX = 90;

/** States before a pod is asking for the plan: a resubmitted plan simply replaces the stored one. */
const PRE_POD: JobState[] = ["queued", "provisioning", "booting", "retrying"];

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
				// Latest version of every frame across rounds (a rerender round only re-does one scene). Labels first, no
				// JPEG bytes: a long video has ~1200 frames and loading them all exceeds D1's 50 MB result limit.
				const rows = (
					await db
						.prepare(
							"SELECT p.round, p.scene, p.idx FROM previews p JOIN (SELECT scene, idx, MAX(round) r FROM previews WHERE job_id = ? GROUP BY scene, idx) m ON p.scene = m.scene AND p.idx = m.idx AND p.round = m.r WHERE p.job_id = ? ORDER BY p.scene, p.idx",
						)
						.bind(job.id, job.id)
						.all<{ round: number; scene: number; idx: number }>()
				).results;
				// Long videos (one pod, any length) have ~3 frames x hundreds of scenes: send at most PREVIEW_IMAGES_MAX,
				// mid frames only, evenly spread. Every frame stays in D1.
				const mids = rows.length > PREVIEW_IMAGES_MAX ? rows.filter((r) => r.idx === 1) : rows;
				const step = Math.max(1, mids.length / PREVIEW_IMAGES_MAX);
				const picked = mids.length > PREVIEW_IMAGES_MAX ? Array.from({ length: PREVIEW_IMAGES_MAX }, (_, i) => mids[Math.floor(i * step)]) : mids;
				if (picked.length < rows.length) images.push({ type: "text", text: `${rows.length} preview frames; showing ${picked.length} mid-scene frames evenly spread. revise_scene any scene that needs it.` });
				// Then the JPEGs of the shown frames only, one batch.
				const jpegStmt = db.prepare("SELECT jpeg FROM previews WHERE job_id = ? AND round = ? AND scene = ? AND idx = ?");
				const got = picked.length ? await db.batch<{ jpeg: ArrayBuffer | number[] }>(picked.map((r) => jpegStmt.bind(job.id, r.round, r.scene, r.idx))) : [];
				const shown = picked.flatMap((r, i) => (got[i]?.results[0] ? [{ ...r, jpeg: got[i].results[0].jpeg }] : []));
				for (const r of shown) {
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
	// One conditional write: approval, its command and the state move together, only for the preview round that was
	// read. A revise that lands first changes state/qa_rounds, so this writes nothing (and vice versa).
	const r = await db.prepare("UPDATE jobs SET approved = 1, pending_cmd = 'render_final', state = 'final_render', updated_at = ? WHERE id = ? AND state = 'preview_ready' AND qa_rounds = ?")
		.bind(now(), job.id, job.qa_rounds).run();
	if (r.meta.changes !== 1) return { error: "job changed before approve (a revise_scene or render progress landed first); call wait_job" };
	await logEvent(db, job.id, "state", { from: "preview_ready", to: "final_render" });
	return { state: "final_render" as const };
}

export async function reviseScene(db: D1Database, jobId: string, scene: number, patch: Partial<Scene>) {
	const job = await getJob(db, jobId);
	if (!job) return { error: `no job ${jobId}` };
	if (!["rendering", "preview_ready", "rerendering", "final_render"].includes(job.state)) return { error: `revise_scene needs a preview or a reported final render error, job is ${job.state}` };
	const p = plan(job)!;
	const i = p.scenes.findIndex((s) => s.n === scene);
	if (i < 0) return { error: `no scene ${scene}; scenes are 1..${p.scenes.length}` };
	let next = { ...p, scenes: p.scenes.map((s, k) => (k === i ? ({ ...(mergePatch(s, patch) as Scene), n: scene }) : s)) };
	// Episode styles: an episode patch on any scene is applied to EVERY scene's copy in this same write, and each
	// scene's duration follows the episode. A changed episode re-previews all scenes (and the pod re-scores it).
	const ep = (s?: Scene) => (s?.props as { episode?: { scenes?: { dur: number }[] } } | undefined)?.episode;
	const episodeChanged = STYLE_REGISTRY[job.style]?.audio === "episode-score" && canon(ep(next.scenes[i])) !== canon(ep(p.scenes[i]));
	if (episodeChanged) {
		const shared = ep(next.scenes[i]);
		next = { ...next, scenes: next.scenes.map((s, k) => ({ ...s, props: { ...s?.props, episode: shared }, duration_s: shared?.scenes?.[k]?.dur ?? s?.duration_s })) };
	}
	const cmd = episodeChanged ? "previews" : `rerender:${scene}`;
	const rerender = episodeChanged ? null : scene;
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
		).bind(JSON.stringify(next), cmd, rerender, now(), job.id, job.qa_rounds, last.id, job.id).run();
		if (result.meta.changes !== 1) return { error: "job changed while repairing final render; call wait_job" };
		await logEvent(db, job.id, "state", { from: "final_render", to: "rerendering", scene });
		return { state: "rerendering" as const, scene };
	}
	// One conditional write: plan, command, round and state together, only if the job is still in the state and round
	// we read. Losing to approve (or to render progress) writes nothing.
	if (!canTransition(job.state, "rerendering")) return { error: `revise_scene needs a preview, job is ${job.state}` };
	const r = await db.prepare(
		"UPDATE jobs SET state = 'rerendering', plan_json = ?, pending_cmd = ?, rerender_scene = ?, qa_rounds = qa_rounds + 1, updated_at = ? WHERE id = ? AND state = ? AND qa_rounds = ?",
	).bind(JSON.stringify(next), cmd, rerender, now(), job.id, job.state, job.qa_rounds).run();
	if (r.meta.changes !== 1) return { error: `job changed while revising (now ${(await getJob(db, job.id))?.state}); call wait_job` };
	await logEvent(db, job.id, "state", { from: job.state, to: "rerendering", scene });
	return { state: "rerendering" as const, scene };
}

/**
 * Terminal state FIRST, pod delete after (deferred via waitUntil): a concurrent /hello, /done or watchdog step can
 * never leave a non-terminal job without its pod. A job already terminal by another path (e.g. done) is reported
 * as is; that path owns its pod (the reaper backstops), so nothing is retired twice.
 */
export async function release(e: Env, db: D1Database, jobId: string, defer: (p: Promise<unknown>) => void = waitUntil) {
	if (!(await getJob(db, jobId))) return { error: `no job ${jobId}` };
	if (await cancelJob(db, jobId)) {
		const pod = await activePod(db, jobId);
		if (pod) {
			const retire = retirePod(e, db, jobId, pod.id, "released");
			defer(retire);
			await retire;
		}
		await updateJob(db, jobId, await jobCost(db, jobId));
	}
	return { state: (await getJob(db, jobId))!.state };
}

const voiceoverSchema = z.union([
	z.object({ text: z.string().min(1) }).strict(),
	z.object({ drive_file_id: z.string().min(1) }).strict(),
	z.object({ none: z.literal(true) }).strict().describe("no narrator: caption-led styles (blockworld) only; the pod scores the episode"),
]);

export function createServer() {
	const server = new McpServer(
		{ name: "Video Factory", version: "2.0.0" },
		{
			instructions:
				"Video Factory makes videos. At the start of every chat that uses these tools, call project_brief first and follow the instructions and owner preferences it returns: they are live, shared by every Claude account, and override older Project instructions or memory. Call style_guide {style} before planning a video. Save lasting preferences the user states with add_preference.",
		},
	);
	const db = env.DB;

	server.registerTool(
		"list_styles",
		{
			description:
				"List the video styles before asking the user to pick one (call before acquire_gpu when the user hasn't named a ready style). Read-only, rents nothing. Only status \"ready\" styles can be used; \"pending\" ones are imported but not yet qualified (see blocked).",
			inputSchema: z.object({}),
		},
		async () =>
			json({
				styles: Object.entries(STYLE_REGISTRY).map(([id, s]) => ({ id, version: s.version, status: s.status, label: s.label, summary: s.summary, templates: s.templates, ...(s.blocked ? { blocked: s.blocked } : {}) })),
				new_style: "To add a new style, the user uploads the kit (.md/.zip) to the operator; it appears here as pending, then ready after its preview + final fixture pass.",
				preferences: "Owner preferences are live: call project_brief once per chat and style_guide {style} before planning.",
			}),
	);

	server.registerTool(
		"project_brief",
		{
			description:
				"Call FIRST in every chat (read-only, rents nothing). Returns the live Video Factory instructions and the owner's current preferences, shared by every Claude account. They override anything older in the Project's instructions or knowledge; follow them. Then call style_guide {style} before planning a video.",
			inputSchema: z.object({}),
		},
		async () => {
			const doc = await getDoc(db, "PROJECT_INSTRUCTIONS.md");
			const block = doc ? (/```[a-z]*\n([\s\S]*?)```/.exec(doc.body)?.[1] ?? doc.body) : null;
			const prefs = groupPrefs(await listPrefs(db));
			return json({
				instructions: block ?? "(instructions not published yet: follow the Project's own instructions)",
				instructions_updated_at: doc ? new Date(doc.updated_at).toISOString() : null,
				preferences_global: prefs.global ?? [],
				preferences_by_style: Object.fromEntries(Object.entries(prefs).filter(([k]) => k !== "global")),
				style_docs: (await docNames(db)).filter((n) => n.startsWith("styles/")).map((n) => n.slice(7, -3)),
				rules: "When the user states a lasting preference, save it with add_preference (scope global or the style id) so every account gets it. If it replaces an older one, retire_preference that id.",
			});
		},
	);

	server.registerTool(
		"style_guide",
		{
			description:
				"Call before writing a scene_plan for a style (read-only). Returns the live style doc (template props, pacing) and the owner's preferences for that style plus global ones. Follow the preferences over any older Project knowledge file.",
			inputSchema: z.object({ style: z.string().min(1).max(64).describe("style id, e.g. flatglow") }),
		},
		async ({ style }) => {
			const doc = await getDoc(db, `styles/${style}.md`);
			const prefs = groupPrefs(await listPrefs(db));
			return json({
				style,
				registry: STYLE_REGISTRY[style] ? { status: STYLE_REGISTRY[style].status, templates: STYLE_REGISTRY[style].templates } : null,
				preferences_global: prefs.global ?? [],
				preferences_style: prefs[style] ?? [],
				doc: doc?.body ?? (STYLE_REGISTRY[style] ? "(style doc not published yet)" : "No registry doc: this style is made in Claude Code with its skill or kit; the preferences above still apply."),
			});
		},
	);

	server.registerTool(
		"add_preference",
		{
			description:
				"Save a lasting owner preference (call when the user says how videos or a style should always look/sound/be made). It applies immediately to every Claude account and Claude Code. scope: \"global\" or a style id. One clear rule per call, in the user's intent, e.g. \"flatglow: captions never cover characters\".",
			inputSchema: z.object({ scope: z.string().min(1).max(40), text: z.string().min(1).max(2000) }),
		},
		async ({ scope, text }) => {
			const r = await addPref(db, scope, text, "claude.ai");
			return "error" in r ? fail(r.error!) : json(r);
		},
	);

	server.registerTool(
		"retire_preference",
		{
			description: "Retire an owner preference by id (from project_brief/style_guide) when the user withdraws or replaces it. Kept in history.",
			inputSchema: z.object({ id: z.number().int().positive(), reason: z.string().max(500).default("") }),
		},
		async ({ id, reason }) => {
			const r = await retirePref(db, id, reason);
			return "error" in r ? fail(r.error!) : json(r);
		},
	);

	server.registerTool(
		"acquire_gpu",
		{
			description:
				"Call for a new video request once the style is known, before planning: rents a fresh GPU while you plan. style is a registry id from list_styles (e.g. \"explainer\"), not its label; style \"custom\" means per-video code: call upload_package and set scene_plan.package before submit_job. Only ready styles are accepted, so call list_styles first if the user hasn't picked one. Pass a random 8-letter chat_key you make once per chat and reuse it on any repeat call (same chat -> same job). Returns {job_id, state} in under 1 s. " + NEXT.acquire,
			inputSchema: z.object({
				style: z.string().min(1).max(64).describe("registry id of a ready style from list_styles"),
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
		"upload_package",
		{
			description:
				'For style "custom" only: upload the per-video style package (base64 of a .tar.gz, max 8 MiB, root has tokens.json and one <template>.html per template id). Rents nothing; same bytes -> same package_id. Kept 7 days. Next: put package_id in scene_plan.package and call submit_job.',
			inputSchema: z.object({ name: z.string().regex(/^[a-z0-9-]{1,64}$/), data_b64: z.string().min(1) }),
		},
		async ({ name, data_b64 }) => {
			if (STYLE_REGISTRY.custom?.status !== "ready") throw new Error(`style "custom" is not available yet: ${STYLE_REGISTRY.custom?.blocked ?? "pending"}`);
			const r = await putPackage(env.OAUTH_KV, name, data_b64);
			return "error" in r ? fail(r.error!) : json(r);
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
			const r = await submitJob(db, job_id, scene_plan, env.OAUTH_KV);
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
