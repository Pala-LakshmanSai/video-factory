// Every-minute cron (Prompt 4a): queue, boot timeout, heartbeat loss, budget, dev pods.
import { CONSTANTS, MAX_COST_PER_JOB_USD, MAX_PODS_AT_ONCE, MAX_REPLACEMENTS } from "./config";
import { getJob, jobCost, logEvent, markPodDeleted, now, updateJob, type JobRow, type PodRow } from "./db";
import { alert } from "./alerts";
import { busySlots } from "./mcp";
import { deletePod } from "./runpod";
import { failJob, selectAndCreate } from "./selector";
import { isTerminal, transition } from "./state";

const LIVE_STATES = ["waiting_for_plan", "rendering", "preview_ready", "rerendering", "final_render", "uploading", "verifying"];

export async function watchdog(env: Env, db: D1Database) {
	const t = now();

	// 1. Live pods: dev cleanup, boot timeout, heartbeat loss.
	const pods = (await db.prepare("SELECT * FROM pods WHERE deleted_at IS NULL").all<PodRow>()).results;
	for (const pod of pods) {
		const job = await getJob(db, pod.job_id);
		if (!job || isTerminal(job.state)) continue; // reaper's job
		if (job.dev_mode === "dummy" && t - pod.created_at > 60_000) {
			await deletePod(env, pod.id);
			await markPodDeleted(db, pod.id, "dev_dummy_60s");
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

	// 3. Selector runs that never happened or died (waitUntil cut short): retry after 90 s.
	const stuck = (
		await db.prepare("SELECT id FROM jobs WHERE state IN ('provisioning','retrying') AND updated_at < ?").bind(t - 90_000).all<{ id: string }>()
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
	await deletePod(env, pod.id);
	await markPodDeleted(db, pod.id, reason);
	await logEvent(db, job.id, reason, { pod: pod.id, dc: pod.data_center_id });
	if (job.dev_mode === "bench") {
		await transition(db, job, "cancelled", { reason });
		return;
	}
	if (reason === "boot_timeout") {
		const skip = JSON.parse(job.skip_dcs) as string[];
		if (pod.data_center_id && !skip.includes(pod.data_center_id)) skip.push(pod.data_center_id);
		await updateJob(db, job.id, { skip_dcs: JSON.stringify(skip) });
	} else {
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
