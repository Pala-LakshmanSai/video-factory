// Every-minute cron (Prompt 4a): queue, boot timeout, heartbeat loss, budget, dev pods.
import { CONSTANTS, MAX_COST_PER_JOB_USD, MAX_PODS_AT_ONCE, MAX_REPLACEMENTS } from "./config";
import { getJob, jobCost, logEvent, markPodDeleted, now, updateJob, type JobRow, type PodRow } from "./db";
import { alert } from "./alerts";
import { busySlots } from "./mcp";
import { deletePod, podAbsent } from "./runpod";
import { hasFault } from "./faults";
import { failJob, retirePod, selectAndCreate } from "./selector";
import { isTerminal, transition } from "./state";

const DELETE_STUCK_ALERT_MS = 10 * 60_000;
const LIVE_STATES = ["waiting_for_plan", "rendering", "preview_ready", "rerendering", "final_render", "uploading", "verifying"];

export async function watchdog(env: Env, db: D1Database) {
	const t = now();

	// 0. Deletes RunPod never confirmed: retry until it does (pod stays tracked meanwhile).
	const pending = (await db.prepare("SELECT * FROM pods WHERE deleted_at IS NULL AND delete_reason IS NOT NULL").all<PodRow>()).results;
	for (const p of pending) {
		await deletePod(env, p.id).catch(() => false);
		// Cleared only on direct provider absence (GET -> 404 / TERMINATED), never on a 204 or a list omission.
		if (await podAbsent(env, p.id)) {
			await markPodDeleted(db, p.id, p.delete_reason!);
			continue;
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
	}

	// 1. Live pods: dev cleanup, boot timeout, heartbeat loss.
	const pods = (await db.prepare("SELECT * FROM pods WHERE deleted_at IS NULL AND delete_reason IS NULL").all<PodRow>()).results;
	for (const pod of pods) {
		const job = await getJob(db, pod.job_id);
		if (!job || isTerminal(job.state)) continue; // reaper's job
		if (job.dev_mode === "dummy" && t - pod.created_at > 60_000) {
			await retirePod(env, db, job.id, pod.id, "dev_dummy_60s");
			await transition(db, job, "cancelled", { reason: "dev_dummy_done" });
			continue;
		}
		if (!pod.hello_at && t - pod.created_at > CONSTANTS.BOOT_TIMEOUT_S * 1000) {
			await replacePod(env, db, job, pod, "boot_timeout");
			continue;
		}
		const last = pod.last_heartbeat_at ?? pod.hello_at;
		if (last && LIVE_STATES.includes(job.state) && t - last > CONSTANTS.HEARTBEAT_DEAD_S * 1000) {
			await replacePod(env, db, job, pod, "heartbeat_lost");
		}
	}

	// 2. Budget (cost so far, live pods billed to now).
	const active = (await db.prepare("SELECT * FROM jobs WHERE state NOT IN ('done','failed','cancelled','queued')").all<JobRow>()).results;
	for (const job of active) {
		const c = await jobCost(db, job.id);
		await updateJob(db, job.id, c);
		if (c.cost_usd > MAX_COST_PER_JOB_USD) await failJob(env, db, job, "budget", `$${c.cost_usd} > $${MAX_COST_PER_JOB_USD}`);
	}

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
	for (const j of stuck) await selectAndCreate(env, db, j.id);

	// 4. Queue: promote oldest queued jobs while there are free slots.
	const queued = (await db.prepare("SELECT * FROM jobs WHERE state = 'queued' ORDER BY created_at").all<JobRow>()).results;
	for (const job of queued) {
		if ((await busySlots(db)) >= MAX_PODS_AT_ONCE) break;
		await transition(db, job, "provisioning", { reason: "slot_free" });
		await selectAndCreate(env, db, job.id);
	}
}

/**
 * Boot timeout: DELETE, skip that data center for this job, select again (does not count as a replacement).
 * Heartbeat loss: DELETE, new pod with the same plan; more than MAX_REPLACEMENTS -> failed (pod_replacements).
 */
async function replacePod(env: Env, db: D1Database, job: JobRow, pod: PodRow, reason: "boot_timeout" | "heartbeat_lost") {
	// Not confirmed deleted -> leave the pod tracked and active, and do NOT start a replacement: two live pods
	// for one job is worse than a minute's delay. The next tick sees the same condition and tries again.
	if (!(await deletePod(env, pod.id).catch(() => false))) {
		await logEvent(db, job.id, "delete_failed", { pod: pod.id, reason });
		return;
	}
	await markPodDeleted(db, pod.id, reason);
	await logEvent(db, job.id, reason, { pod: pod.id, dc: pod.data_center_id });
	if (job.dev_mode === "bench") {
		await transition(db, job, "cancelled", { reason });
		return;
	}
	if (reason === "boot_timeout") {
		// Phase 9 slow_boot fault: one boot timeout proves the path; the replacement pod must boot normally.
		await hasFault(db, job.id, "slow_boot", true);
		const skip = JSON.parse(job.skip_dcs) as string[];
		if (pod.data_center_id && !skip.includes(pod.data_center_id)) skip.push(pod.data_center_id);
		await updateJob(db, job.id, { skip_dcs: JSON.stringify(skip) });
	} else {
		// Phase 9: silence one pod. The replacement must neither inherit the fault nor receive its stale command.
		const silence = await hasFault(db, job.id, "silence_heartbeat", true);
		if (silence) {
			await db.prepare("UPDATE jobs SET pending_cmd = NULL WHERE id = ? AND pending_cmd = ?")
				.bind(job.id, `fault:${silence}`).run();
		}
		const attempts = job.attempts + 1;
		await updateJob(db, job.id, { attempts });
		if (attempts > MAX_REPLACEMENTS) {
			await failJob(env, db, job, "pod_replacements", `${attempts} pods lost heartbeat`);
			return;
		}
		if (attempts >= 2) await alert(env, db, `job has needed ${attempts} pod replacements`, job.id);
	}
	await transition(db, job, "retrying", { reason });
	await selectAndCreate(env, db, job.id);
}
