// SPEC §6 step 5 / §6.5 reaper (cron every 5 min). Deletes every "vf-*" pod whose job is
// done/failed/cancelled/missing or older than its TTL; never touches other names.
import { alert } from "./alerts";
import { getJob, logEvent, markPodDeleted, now } from "./db";
import { balance, deletePod, listPods } from "./runpod";
import { isTerminal } from "./state";

const GRACE_MS = 2 * 60_000; // the pod's own TTL self-destruct gets the first go

export async function reaper(env: Env, db: D1Database) {
	const live = await listPods(env);
	const liveIds = new Set(live.map((p) => p.id));

	for (const p of live) {
		if (!p.name?.startsWith("vf-")) continue;
		const row = await db.prepare("SELECT job_id, created_at FROM pods WHERE id = ?").bind(p.id).first<{ job_id: string; created_at: number }>();
		const job = row ? await getJob(db, row.job_id) : null;
		const createdAt = row?.created_at ?? (p.createdAt ? Date.parse(p.createdAt) : 0);
		const ttlMs = (job?.ttl_min ?? 30) * 60_000;
		let reason: string | null = null;
		if (!job) reason = "orphan";
		else if (isTerminal(job.state)) reason = `job_${job.state}`;
		else if (createdAt && now() - createdAt > ttlMs + GRACE_MS) reason = "past_ttl";
		if (!reason) continue;
		await deletePod(env, p.id);
		if (row) await markPodDeleted(db, p.id, `reaper:${reason}`);
		await logEvent(db, job?.id ?? "reaper", "reaper_delete", { pod: p.id, name: p.name, reason });
		if (job && !isTerminal(job.state)) await alert(env, db, `reaper deleted pod ${p.id} of a still-active job (${reason})`, job.id);
	}

	// Pods D1 thinks are alive but RunPod no longer lists (self-destructed, deleted by hand).
	const tracked = (await db.prepare("SELECT id FROM pods WHERE deleted_at IS NULL").all<{ id: string }>()).results;
	for (const t of tracked) if (!liveIds.has(t.id)) await markPodDeleted(db, t.id, "gone");
}

/** Daily RunPod balance check (§12: pods are deleted at $0). */
export async function balanceCheck(env: Env) {
	const b = await balance(env);
	if (b === null) await alert(env, null, "could not read RunPod balance");
	else if (b < 10) await alert(env, null, `RunPod balance low: $${b.toFixed(2)} (pods are deleted at $0; check auto-pay)`);
}
