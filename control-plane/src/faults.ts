// Phase 9 test-only fault injection. Active only when FAULTS_ENABLED="1".
// POST /admin/fault {job_id, fault}; job_id "*" arms the fault for the next job that checks it.
// Server-side faults are checked where they bite; agent-side ones go to the pod as heartbeat cmd "fault:<name>".
import { getConfig, setConfig } from "./config";
import { activePod, getJob, logEvent } from "./db";
import { deletePod } from "./runpod";

export const SERVER_FAULTS = ["kill_pod", "slow_boot", "price_cap", "block_region", "expire_upload_session", "corrupt_md5", "revoke_drive"];
export const AGENT_FAULTS = ["silence_heartbeat", "drop_upload_after_chunk", "render_error"];
export const ALL_FAULTS = [...SERVER_FAULTS, ...AGENT_FAULTS];

const key = (jobId: string) => `faults:${jobId}`;

/** Returns the armed fault (e.g. "price_cap:0.01") whose name matches, or null. `consume` disarms it. */
export async function hasFault(db: D1Database, jobId: string, name: string, consume = false): Promise<string | null> {
	for (const id of [jobId, "*"]) {
		const list = await getConfig<string[]>(db, key(id), []);
		const hit = list.find((f) => f === name || f.startsWith(name + ":"));
		if (hit) {
			if (consume || id === "*") {
				await setConfig(db, key(id), list.filter((f) => f !== hit));
				if (id === "*" && !consume) await setConfig(db, key(jobId), [...(await getConfig<string[]>(db, key(jobId), [])), hit]);
			}
			return hit;
		}
	}
	return null;
}

export const faultArg = (f: string | null) => (f && f.includes(":") ? f.slice(f.indexOf(":") + 1) : null);

/** Thrown when an agent fault can't be delivered because the single pending_cmd slot already holds a command. */
export class PendingCmdBusy extends Error {}

export async function armFault(env: Env, jobId: string, fault: string): Promise<string> {
	const name = fault.split(":")[0];
	if (!ALL_FAULTS.includes(name)) throw new Error(`unknown fault ${name}; known: ${ALL_FAULTS.join(", ")}`);
	const db = env.DB;
	const job = jobId !== "*" ? await getJob(db, jobId) : null;
	if (jobId !== "*" && !job) throw new Error(`no job ${jobId}`);
	if (job && AGENT_FAULTS.includes(name)) {
		// Claim the slot atomically; never overwrite a queued command (cancel/render) with a fault.
		const r = await db.prepare("UPDATE jobs SET pending_cmd = ?, updated_at = ? WHERE id = ? AND pending_cmd IS NULL").bind(`fault:${fault}`, Date.now(), jobId).run();
		if (!r.meta.changes) {
			const cur = (await getJob(db, jobId))?.pending_cmd;
			throw new PendingCmdBusy(`pending_cmd busy (${cur}); retry when empty`);
		}
	}
	await setConfig(db, key(jobId), [...(await getConfig<string[]>(db, key(jobId), [])), fault]);
	if (jobId !== "*") {
		await logEvent(db, jobId, "fault_armed", { fault });
		if (name === "kill_pod") {
			const pod = await activePod(db, jobId);
			if (pod) await deletePod(env, pod.id); // watchdog sees the silence and replaces it
		}
	}
	return `armed ${fault} for ${jobId}`;
}
