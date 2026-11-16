// SPEC §6 step 5 / §6.5 reaper (cron every 5 min). Deletes every "vf-*" pod whose job is
// done/failed/cancelled/missing or older than its TTL; never touches other names.
import { alert } from "./alerts";
import { getJob, logEvent, markDeletePending, markPodDeleted, now, reconcileCosts } from "./db";
import { balance, deletePod, listPods } from "./runpod";
import { isTerminal } from "./state";

const GRACE_MS = 2 * 60_000; // the pod's own TTL self-destruct gets the first go
const LIST_LAG_MS = 5 * 60_000; // a pod this young may simply not be listed yet

export async function reaper(env: Env, db: D1Database) {
	// Throws on a malformed or incomplete list: then nothing below runs (no deletes, nothing marked gone).
	const live = await listPods(env);
	const liveIds = new Set(live.map((p) => p.id));

	for (const p of live) {
		if (!p.name?.startsWith("vf-")) continue;
		const row = await db.prepare("SELECT job_id, created_at, deleted_at, delete_reason FROM pods WHERE id = ?").bind(p.id).first<{ job_id: string; created_at: number; deleted_at: number | null; delete_reason: string | null }>();
		const job = row ? await getJob(db, row.job_id) : null;
		const createdAt = row?.created_at ?? (p.createdAt ? Date.parse(p.createdAt) : 0);
		const ttlMs = (job?.ttl_min ?? 30) * 60_000;
		let reason: string | null = null;
		if (!row) {
			// Untracked vf- pod. It may be one whose create is still being recorded (list can show it before the
			// INSERT lands) or the subject of a held create the watchdog will adopt: leave those alone.
			const born = p.createdAt ? Date.parse(p.createdAt) : NaN;
			if (!Number.isFinite(born) || now() - born < LIST_LAG_MS) continue;
			const owner = await getJob(db, p.name.slice(3));
			if (owner && !isTerminal(owner.state) && owner.create_uncertain_at) continue;
		}
		if (row && !row.deleted_at && row.delete_reason) reason = `pending:${row.delete_reason}`;
		else if (!job) reason = "orphan";
		else if (isTerminal(job.state)) reason = `job_${job.state}`;
		else if (createdAt && now() - createdAt > ttlMs + GRACE_MS) reason = "past_ttl";
		if (!reason) continue;
		const ok = await deletePod(env, p.id).catch(() => false);
		// Unconfirmed -> keep it tracked (delete pending); the watchdog and the next reaper run retry it.
		// Tracked pods become delete-pending either way; the watchdog clears them on direct provider absence.
		if (row) await markDeletePending(db, p.id, `reaper:${reason}`);
		await logEvent(db, job?.id ?? "reaper", ok ? "reaper_delete" : "delete_failed", { pod: p.id, name: p.name, reason });
		if (job && !isTerminal(job.state)) await alert(env, db, `reaper deleted pod ${p.id} of a still-active job (${reason})`, job.id);
	}

	// Pods D1 thinks are alive but RunPod no longer lists (self-destructed, deleted by hand).
	// Only trusted because listPods returned a complete, validated list; young pods are skipped (list lag).
	// Delete-pending pods are excluded: they clear only on direct absence (watchdog), never on a list omission.
	const tracked = (await db.prepare("SELECT id FROM pods WHERE deleted_at IS NULL AND delete_reason IS NULL AND created_at < ?").bind(now() - LIST_LAG_MS).all<{ id: string }>()).results;
	for (const t of tracked) if (!liveIds.has(t.id)) await markPodDeleted(db, t.id, "gone");

	await reconcileCosts(db);
}

/** Daily RunPod balance check (§12: pods are deleted at $0). */
export async function balanceCheck(env: Env) {
	const b = await balance(env);
	if (b === null) await alert(env, null, "could not read RunPod balance");
	else if (b < 10) await alert(env, null, `RunPod balance low: $${b.toFixed(2)} (pods are deleted at $0; check auto-pay)`);
}
