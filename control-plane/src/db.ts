import type { JobState, Voiceover, ScenePlan } from "../../packages/contract/src/index";

export interface JobRow {
	id: string;
	chat_key: string;
	state: JobState;
	title: string;
	style: string;
	voiceover_json: string;
	plan_json: string | null;
	job_token_sha256: string | null;
	token_expires_at: number | null;
	attempts: number;
	render_errors: string;
	last_render_error: string | null;
	qa_rounds: number;
	rerender_scene: number | null;
	approved: number;
	create_claim: string | null;
	create_uncertain_at: number | null;
	admission_at: number | null;
	pending_cmd: string | null;
	renderer_image: string | null;
	reuploads: number;
	skip_dcs: string;
	stage: string | null;
	pct: number;
	scene: number | null;
	gpu_label: string;
	ttl_min: number;
	dev_mode: string | null;
	cost_usd: number;
	gpu_seconds: number;
	drive_file_id: string | null;
	drive_link: string | null;
	size: number | null;
	md5: string | null;
	error_json: string | null;
	created_at: number;
	updated_at: number;
}

export interface PodRow {
	id: string;
	job_id: string;
	gpu_type_id: string | null;
	data_center_id: string | null;
	cloud_type: string | null;
	compute_type: string | null;
	cost_per_hr: number;
	created_at: number;
	hello_at: number | null;
	last_heartbeat_at: number | null;
	deleted_at: number | null;
	delete_reason: string | null;
}

export const now = () => Date.now();

export const plan = (j: JobRow) => (j.plan_json ? (JSON.parse(j.plan_json) as ScenePlan) : null);
export const voiceover = (j: JobRow) => JSON.parse(j.voiceover_json) as Voiceover;

export async function getJob(db: D1Database, id: string) {
	return db.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first<JobRow>();
}

/** Update columns other than `state` (state changes go through state.ts). */
export async function updateJob(db: D1Database, id: string, fields: Partial<Omit<JobRow, "id" | "state">>) {
	const keys = Object.keys(fields);
	if (!keys.length) return;
	const sets = keys.map((k) => `${k} = ?`).join(", ");
	await db
		.prepare(`UPDATE jobs SET ${sets}, updated_at = ? WHERE id = ?`)
		.bind(...keys.map((k) => (fields as Record<string, unknown>)[k] ?? null), now(), id)
		.run();
}

export async function logEvent(db: D1Database, jobId: string, kind: string, data?: unknown) {
	await db
		.prepare("INSERT INTO events (job_id, ts, kind, data_json) VALUES (?, ?, ?, ?)")
		.bind(jobId, now(), kind, data === undefined ? null : JSON.stringify(data))
		.run();
}

export async function lastEvents(db: D1Database, jobId: string, n = 5) {
	const r = await db
		.prepare("SELECT ts, kind, data_json FROM events WHERE job_id = ? ORDER BY id DESC LIMIT ?")
		.bind(jobId, n)
		.all<{ ts: number; kind: string; data_json: string | null }>();
	return r.results;
}

export async function activePod(db: D1Database, jobId: string) {
	return db
		.prepare("SELECT * FROM pods WHERE job_id = ? AND deleted_at IS NULL AND delete_reason IS NULL ORDER BY created_at DESC LIMIT 1")
		.bind(jobId)
		.first<PodRow>();
}

/** Deletion asked for but not confirmed by RunPod: stays tracked (deleted_at NULL) and is retried by the watchdog. */
export async function markDeletePending(db: D1Database, podId: string, reason: string) {
	await db.prepare("UPDATE pods SET delete_reason = ? WHERE id = ? AND deleted_at IS NULL").bind(reason, podId).run();
}

/** RunPod confirmed the pod is gone (DELETE 2xx/404). Every confirmed delete re-records the job's final cost. */
export async function markPodDeleted(db: D1Database, podId: string, reason: string) {
	const r = await db
		.prepare("UPDATE pods SET deleted_at = ?, delete_reason = ? WHERE id = ? AND deleted_at IS NULL")
		.bind(now(), reason, podId)
		.run();
	if (!r.meta.changes) return;
	const pod = await db.prepare("SELECT job_id FROM pods WHERE id = ?").bind(podId).first<{ job_id: string }>();
	if (pod) await updateJob(db, pod.job_id, await jobCost(db, pod.job_id));
}

/** GPU seconds + $ across every pod this job ever had (live pods billed up to now). */
export async function jobCost(db: D1Database, jobId: string) {
	const pods = (await db.prepare("SELECT * FROM pods WHERE job_id = ?").bind(jobId).all<PodRow>()).results;
	let seconds = 0;
	let usd = 0;
	for (const p of pods) {
		const s = ((p.deleted_at ?? now()) - p.created_at) / 1000;
		seconds += s;
		usd += (s * p.cost_per_hr) / 3600;
	}
	return { gpu_seconds: Math.round(seconds), cost_usd: Math.round(usd * 10000) / 10000 };
}

export function randomId(prefix: string) {
	return prefix + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

export async function sha256Hex(s: string) {
	const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
	return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function constantTimeEqual(a: string, b: string) {
	if (a.length !== b.length) return false;
	let x = 0;
	for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return x === 0;
}
