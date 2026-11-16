// Every-minute cron (Prompt 4a): queue, boot timeout, heartbeat loss, stranded jobs, budget, dev pods.
import { CONSTANTS, MAX_COST_PER_JOB_USD, MAX_PODS_AT_ONCE, MAX_REPLACEMENTS } from "./config";
import { getJob, jobCost, logEvent, markPodDeleted, now, updateJob, type JobRow, type PodRow } from "./db";
import { alert } from "./alerts";
import { busySlots } from "./mcp";
import { deletePod, podAbsent } from "./runpod";
import { hasFault } from "./faults";
import { failJob, retirePod, selectAndCreate } from "./selector";
import { canTransition, cancelJob, isTerminal, transition } from "./state";
import { verify } from "./agent";

const DELETE_STUCK_ALERT_MS = 10 * 60_000;
const LIVE_STATES = ["waiting_for_plan", "rendering", "preview_ready", "rerendering", "final_render", "uploading", "verifying"];
const POD_STATES = ["booting", ...LIVE_STATES];
// Only for a verifying job whose pod is gone or heartbeat-dead (a heartbeating verifier is never touched here):
const DONE_IN_FLIGHT_MS = 2 * 60_000; // since entering verifying: the pod's own /done may still be running -> wait
const VERIFY_GIVE_UP_MS = 15 * 60_000; // since entering verifying: persisted upload still unverifiable -> replace (re-render)

/** One bad row must not stop the tick: log it and move on to the next job/pod. */
async function each<T extends { id: string }>(items: T[], what: string, fn: (x: T) => Promise<unknown>) {
	for (const x of items) {
		try {
			await fn(x);
		} catch (e) {
			console.error(`watchdog ${what} ${x.id}:`, e);
		}
	}
}

export async function watchdog(env: Env, db: D1Database) {
	const t = now();

	// 0. Deletes RunPod never confirmed: retry until it does (pod stays tracked meanwhile).
	const pending = (await db.prepare("SELECT * FROM pods WHERE deleted_at IS NULL AND delete_reason IS NOT NULL").all<PodRow>()).results;
	await each(pending, "pending_delete", async (p) => {
		await deletePod(env, p.id).catch(() => false);
		// Cleared only on direct provider absence (GET -> 404 / TERMINATED), never on a 204 or a list omission.
		if (await podAbsent(env, p.id)) {
			await markPodDeleted(db, p.id, p.delete_reason!);
			return;
		}
		// Still billing. Alert once when it has been failing for 10 min (e.g. a cluster pod: v2 409).
		const first = await db
			.prepare("SELECT MIN(ts) AS ts, SUM(kind = 'delete_stuck') AS alerted FROM events WHERE job_id = ? AND kind IN ('delete_failed','delete_stuck') AND data_json LIKE ?")
			.bind(p.job_id, `%"pod":"${p.id}"%`)
			.first<{ ts: number | null; alerted: number | null }>();
		if (first?.ts && t - first.ts > DELETE_STUCK_ALERT_MS && !first.alerted) {
			await logEvent(db, p.job_id, "delete_stuck", { pod: p.id, reason: p.delete_reason });
			await alert(env, db, `pod ${p.id} could not be deleted for ${Math.round((t - first.ts) / 60000)} min and may still be billing: delete it in the RunPod console`, p.job_id);
		}
	});

	// 1. Live pods: dev cleanup, boot timeout, heartbeat loss.
	const pods = (await db.prepare("SELECT * FROM pods WHERE deleted_at IS NULL AND delete_reason IS NULL").all<PodRow>()).results;
	await each(pods, "pod", async (pod) => {
		const job = await getJob(db, pod.job_id);
		if (!job || isTerminal(job.state)) return; // reaper's job
		if (job.dev_mode === "dummy" && t - pod.created_at > 60_000) {
			// Terminal first, pod last (same order as failJob/release): a deleted pod must never back a live job.
			await cancelJob(db, job.id, { reason: "dev_dummy_done" });
			await retirePod(env, db, job.id, pod.id, "dev_dummy_60s");
			return;
		}
		if (!pod.hello_at && t - pod.created_at > CONSTANTS.BOOT_TIMEOUT_S * 1000) {
			await replacePod(env, db, job, pod, "boot_timeout");
			return;
		}
		const last = pod.last_heartbeat_at ?? pod.hello_at;
		if (last && LIVE_STATES.includes(job.state) && t - last > CONSTANTS.HEARTBEAT_DEAD_S * 1000) {
			await replacePod(env, db, job, pod, "heartbeat_lost");
		}
	});

	// 1b. Stranded jobs: in a pod state with no undeleted pod (the reaper marked it gone or TTL-deleted it, or a
	//     replacement lost a race). Delete-pending pods count as undeleted, so nothing starts while one may bill.
	//     No create can be in flight here (a claim is only taken in provisioning/retrying); checked anyway.
	const stranded = (
		await db
			.prepare(
				`SELECT * FROM jobs j WHERE state IN (${POD_STATES.map(() => "?").join(",")}) AND create_claim IS NULL
				 AND NOT EXISTS (SELECT 1 FROM pods p WHERE p.job_id = j.id AND p.deleted_at IS NULL)`,
			)
			.bind(...POD_STATES)
			.all<JobRow>()
	).results;
	await each(stranded, "stranded", async (job) => {
		// recover() resumes verification first for a verifying job whose upload is recorded.
		await logEvent(db, job.id, "pod_missing", { state: job.state });
		await recover(env, db, job.id, "pod_missing");
	});

	// 2. Budget (cost so far, live pods billed to now).
	const active = (await db.prepare("SELECT * FROM jobs WHERE state NOT IN ('done','failed','cancelled','queued')").all<JobRow>()).results;
	await each(active, "budget", async (job) => {
		const c = await jobCost(db, job.id);
		await updateJob(db, job.id, c);
		if (c.cost_usd > MAX_COST_PER_JOB_USD) await failJob(env, db, job, "budget", `$${c.cost_usd} > $${MAX_COST_PER_JOB_USD}`);
	});

	// 3. Admissions: held jobs (create claim set) are re-checked every minute; unclaimed ones are retried 90 s after
	//    their last selector attempt (admission_at), never judged by updated_at, which cost writes bump.
	const stuck = (
		await db
			.prepare(
				"SELECT id FROM jobs WHERE state IN ('provisioning','retrying') AND (create_claim IS NOT NULL OR COALESCE(admission_at, created_at) < ?)",
			)
			.bind(t - 90_000)
			.all<{ id: string }>()
	).results;
	await each(stuck, "admission", (j) => selectAndCreate(env, db, j.id));

	// 4. Queue: promote oldest queued jobs while there are free slots.
	const queued = (await db.prepare("SELECT * FROM jobs WHERE state = 'queued' ORDER BY created_at").all<JobRow>()).results;
	for (const job of queued) {
		if ((await busySlots(db)) >= MAX_PODS_AT_ONCE) break;
		try {
			await transition(db, job, "provisioning", { reason: "slot_free" });
			await selectAndCreate(env, db, job.id);
		} catch (e) {
			console.error(`watchdog queue ${job.id}:`, e);
		}
	}
}

/**
 * Boot timeout: DELETE, skip that data center for this job, select again (does not count as a replacement).
 * Heartbeat loss: DELETE, new pod with the same plan; more than MAX_REPLACEMENTS -> failed (pod_replacements).
 */
async function replacePod(env: Env, db: D1Database, job: JobRow, pod: PodRow, reason: "boot_timeout" | "heartbeat_lost") {
	// Upload recorded: finish verifying it instead of paying for a re-render.
	if (await resumeVerify(env, db, job, now())) return;
	// Not confirmed deleted -> leave the pod tracked and active, and do NOT start a replacement: two live pods
	// for one job is worse than a minute's delay. The next tick sees the same condition and tries again.
	if (!(await deletePod(env, pod.id).catch(() => false))) {
		await logEvent(db, job.id, "delete_failed", { pod: pod.id, reason });
		return;
	}
	await markPodDeleted(db, pod.id, reason);
	await logEvent(db, job.id, reason, { pod: pod.id, dc: pod.data_center_id });
	await recover(env, db, job.id, reason, pod);
}

/**
 * The job's pod is confirmed gone: send it to retrying and select again. The move to retrying is ONE conditional
 * UPDATE fenced on: same state, no undeleted pod, no create claim. So a stale caller (an overlapping tick that saw
 * the old pod after another tick already got a replacement accepted) changes nothing. Only the winner bumps the
 * counters. A lost pod (heartbeat_lost, pod_missing) counts toward MAX_REPLACEMENTS.
 */
async function recover(env: Env, db: D1Database, jobId: string, reason: "boot_timeout" | "heartbeat_lost" | "pod_missing", pod?: PodRow) {
	const lost = reason === "boot_timeout" ? 0 : 1;
	let job: JobRow | null = null;
	for (let i = 0; i < 20; i++) {
		const cur = await getJob(db, jobId);
		if (!cur || !canTransition(cur.state, "retrying")) return; // terminal, or already retrying/provisioning
		// A /done may have claimed the upload (uploading -> verifying) while the pod was being deleted: re-checked
		// on every fresh read, and the UPDATE is fenced on the same state + drive_file_id, so a claim landing after
		// this check makes it lose and loop back here.
		if (await resumeVerify(env, db, cur, now())) return;
		if (cur.dev_mode === "bench") {
			if (await hasLivePod(db, jobId)) return;
			await cancelJob(db, jobId, { reason });
			return;
		}
		const r = await db
			.prepare(
				`UPDATE jobs SET state = 'retrying', attempts = attempts + ?, updated_at = ? WHERE id = ? AND state = ? AND drive_file_id IS ? AND create_claim IS NULL
				 AND NOT EXISTS (SELECT 1 FROM pods WHERE job_id = ? AND deleted_at IS NULL)`,
			)
			.bind(lost, now(), jobId, cur.state, cur.drive_file_id, jobId)
			.run();
		if (r.meta.changes) {
			await logEvent(db, jobId, "state", { from: cur.state, to: "retrying", reason });
			job = { ...cur, state: "retrying", attempts: cur.attempts + lost };
			break;
		}
		const again = await getJob(db, jobId);
		if (again?.state === cur.state && again.drive_file_id === cur.drive_file_id) return; // fenced: a pod or a create claim exists -> nothing to recover
	}
	if (!job) return;
	if (lost) {
		// Phase 9: silence one pod. The replacement must neither inherit the fault nor receive its stale command.
		const silence = await hasFault(db, job.id, "silence_heartbeat", true);
		if (silence) {
			await db.prepare("UPDATE jobs SET pending_cmd = NULL WHERE id = ? AND pending_cmd = ?")
				.bind(job.id, `fault:${silence}`).run();
		}
		if (job.attempts > MAX_REPLACEMENTS) {
			await failJob(env, db, job, "pod_replacements", `${job.attempts} pods lost`);
			return;
		}
		if (job.attempts >= 2) await alert(env, db, `job has needed ${job.attempts} pod replacements`, job.id);
	} else {
		// Phase 9 slow_boot fault: one boot timeout proves the path; the replacement pod must boot normally.
		await hasFault(db, job.id, "slow_boot", true);
		const skip = JSON.parse(job.skip_dcs) as string[];
		if (pod?.data_center_id && !skip.includes(pod.data_center_id)) skip.push(pod.data_center_id);
		await updateJob(db, job.id, { skip_dcs: JSON.stringify(skip) });
	}
	await selectAndCreate(env, db, jobId);
}

const hasLivePod = async (db: D1Database, jobId: string) =>
	!!(await db.prepare("SELECT 1 FROM pods WHERE job_id = ? AND deleted_at IS NULL").bind(jobId).first());

/**
 * Called only when a verifying job's pod is missing or heartbeat-dead (never for a pod still heartbeating). Its upload
 * claim is persisted (drive_file_id), so the file is already in Drive: verify it rather than re-render.
 * Returns true when the caller must NOT replace/recover the pod.
 * - entered verifying < DONE_IN_FLIGHT_MS ago: the pod's own /done may still be running -> wait;
 * - then: run the server-side verify for the persisted claim (fenced on that claim; done / re-upload / md5 fail);
 * - still unresolved after VERIFY_GIVE_UP_MS (e.g. Drive keeps erroring): fall through to a normal replacement,
 *   so the job is never stranded.
 */
async function resumeVerify(env: Env, db: D1Database, job: JobRow, t: number): Promise<boolean> {
	if (job.state !== "verifying" || !job.drive_file_id) return false;
	const ev = await db
		.prepare("SELECT MAX(ts) AS ts FROM events WHERE job_id = ? AND kind = 'state' AND data_json LIKE '%\"to\":\"verifying\"%'")
		.bind(job.id)
		.first<{ ts: number | null }>();
	const since = ev?.ts ?? job.updated_at;
	if (t - since < DONE_IN_FLIGHT_MS) return true;
	await logEvent(db, job.id, "verify_resume", { file: job.drive_file_id });
	try {
		await verify(env, job, { file_id: job.drive_file_id, md5: job.md5 ?? "", size: job.size ?? 0 });
	} catch (e) {
		console.error(`watchdog verify_resume ${job.id}:`, e);
	}
	const after = await getJob(db, job.id);
	if (!after || after.state !== "verifying" || after.drive_file_id !== job.drive_file_id) return true; // resolved
	return t - since < VERIFY_GIVE_UP_MS;
}
