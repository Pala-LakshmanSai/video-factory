// SPEC §10 + CONTRACT state table. Every change writes an event; illegal transitions throw.
import type { JobState } from "../../packages/contract/src/index";
import { TERMINAL_STATES } from "../../packages/contract/src/index";
import { logEvent, now, type JobRow } from "./db";

const NEXT: Partial<Record<JobState, JobState[]>> = {
	queued: ["provisioning"],
	provisioning: ["booting"],
	booting: ["waiting_for_plan", "rendering"],
	waiting_for_plan: ["rendering"],
	rendering: ["preview_ready", "rerendering"],
	preview_ready: ["rerendering", "final_render"],
	rerendering: ["preview_ready", "rerendering"],
	final_render: ["uploading"],
	uploading: ["verifying"],
	verifying: ["uploading", "done"],
	retrying: ["booting"],
};

/** States that have (or are about to have) a pod, so a lost pod sends them to `retrying`. */
const POD_STATES: JobState[] = [
	"booting", "waiting_for_plan", "rendering", "preview_ready", "rerendering", "final_render", "uploading", "verifying",
];

export const isTerminal = (s: JobState) => (TERMINAL_STATES as readonly string[]).includes(s);

export function canTransition(from: JobState, to: JobState): boolean {
	if (isTerminal(from)) return false;
	if (to === "failed" || to === "cancelled") return true;
	if (to === "retrying") return POD_STATES.includes(from);
	return NEXT[from]?.includes(to) ?? false;
}

export class IllegalTransition extends Error {
	constructor(public from: JobState, public to: JobState) {
		super(`illegal transition ${from} -> ${to}`);
	}
}

/**
 * Move a job to `to`. Guarded by the job's current state in SQL, so a concurrent change
 * (another request already moved it) also throws instead of silently overwriting.
 */
export async function transition(db: D1Database, job: Pick<JobRow, "id" | "state">, to: JobState, data?: unknown) {
	if (!canTransition(job.state, to)) throw new IllegalTransition(job.state, to);
	const r = await db
		.prepare("UPDATE jobs SET state = ?, updated_at = ? WHERE id = ? AND state = ?")
		.bind(to, now(), job.id, job.state)
		.run();
	if (!r.meta.changes) throw new IllegalTransition(job.state, to);
	await logEvent(db, job.id, "state", { from: job.state, to, ...(data as object) });
	(job as { state: JobState }).state = to;
}
