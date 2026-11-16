// SPEC §9.3 weekly re-rank (Prompt 7.3). Sunday 03:00 UTC: one bench pod per ranked GPU that is
// available now; the agent (env BENCH=1) renders bench/plan-60s.json without uploading and POSTs
// /agent/{job}/bench {render_s}. boot_s = /hello - pod create. Score = cost_per_hr * (boot_s + render_s) / 3600
// = $ per standard test video. Tested GPUs sorted by score, untested keep their relative order below.
import { alert } from "./alerts";
import { GPU_RANK, getConfig, norm, setConfig } from "./config";
import { activePod, getJob, jobCost, logEvent, now } from "./db";
import { acquireGpu, release } from "./mcp";
import { catalog } from "./runpod";
import { retirePod, selectAndCreate } from "./selector";
import { cancelJob, isTerminal } from "./state";

const BUDGET_USD = 2;
const EST_MIN_PER_RUN = 12; // boot + 60 s render on a slow pod, generous
const RUN_TIMEOUT_MS = 60 * 60_000;

interface BenchRun {
	started_at: number;
	jobs: { job_id: string; gpu: string }[];
}
type BenchResult = { boot_s: number; render_s: number; cost_per_hr: number; score: number };
/** One row per bench job, written once (INSERT OR IGNORE): concurrent pod reports never overwrite each other. */
const resultKey = (jobId: string) => `bench_result:${jobId}`;

const cancel = (db: D1Database, jobId: string, reason: string) => cancelJob(db, jobId, { reason });

export async function startBench(env: Env, db: D1Database) {
	if (String(env.BENCH_ENABLED) !== "1") return "bench disabled: benchmark not started";
	if (String(env.ADMISSION_ENABLED) !== "1") return "admission disabled: benchmark not started";
	// Reserve the run BEFORE renting (atomically: two starts cannot both win), so an early pod report finds it.
	const run: BenchRun = { started_at: now(), jobs: [] };
	const reserved = await db.prepare("INSERT OR IGNORE INTO config (key, value_json) VALUES ('bench_run', ?)").bind(JSON.stringify(run)).run();
	if (!reserved.meta.changes) return "already running";
	const rank = await getConfig<string[]>(db, "gpu_rank", GPU_RANK);
	const cat = await catalog(env, db);
	const available = rank.filter((g) => cat.dataCenters.some((dc) => dc.gpuAvailability?.some((a) => norm(a.id) === norm(g) && a.availability !== "NONE")));
	let rented = 0;
	let estimate = 0;
	for (const gpu of available) {
		const { job_id } = await acquireGpu(env, db, {
			style: "explainer", title: `bench ${gpu}`, voiceover: { text: "bench" }, chat_key: `bench-${now()}-${norm(gpu).replace(/\W+/g, "-")}`,
		}, { dev_mode: "bench" });
		// Register the job in the run before its pod can exist (single-statement append, no read-modify-write).
		await db.prepare("UPDATE config SET value_json = json_insert(value_json, '$.jobs[#]', json(?)) WHERE key = 'bench_run'")
			.bind(JSON.stringify({ job_id, gpu })).run();
		const r = await selectAndCreate(env, db, job_id, { rank: [gpu], gpuOnly: true });
		const pod = r === "created" ? await activePod(db, job_id) : null;
		if (!pod) {
			// Not rented now (queued, held, skipped): cancel so the watchdog can never rent it outside this budget.
			// A held create's pod, if one appears, belongs to a cancelled job and the reaper deletes it.
			await release(env, db, job_id);
			await logEvent(db, job_id, "bench_not_created", { gpu, result: r });
			continue;
		}
		const cost = (pod.cost_per_hr * EST_MIN_PER_RUN) / 60;
		if (estimate + cost > BUDGET_USD) {
			// Abort: this run would spend more than $2. Terminal state first, then the pod.
			await cancel(db, job_id, "bench_budget");
			await retirePod(env, db, pod.job_id, pod.id, "bench_budget");
			break;
		}
		estimate += cost;
		rented++;
	}
	return `bench started: ${rented} GPUs, est $${estimate.toFixed(2)}`;
}

/**
 * POST /agent/{job}/bench handler body. Result row and terminal state are written BEFORE the pod delete:
 * deleting the pod kills the agent and its open request, so the delete goes last, through `defer` (waitUntil).
 */
export async function recordBench(env: Env, db: D1Database, jobId: string, renderS: number, defer: (p: Promise<unknown>) => void = () => {}) {
	const run = await getConfig<BenchRun | null>(db, "bench_run", null);
	const entry = run?.jobs.find((j) => j.job_id === jobId);
	const pod = await activePod(db, jobId);
	let result: BenchResult | null = null;
	if (entry && pod?.hello_at) {
		const boot_s = (pod.hello_at - pod.created_at) / 1000;
		const score = (pod.cost_per_hr * (boot_s + renderS)) / 3600;
		result = { boot_s: Math.round(boot_s), render_s: Math.round(renderS), cost_per_hr: pod.cost_per_hr, score: Math.round(score * 10000) / 10000 };
		await db.prepare("INSERT OR IGNORE INTO config (key, value_json) VALUES (?, ?)").bind(resultKey(jobId), JSON.stringify(result)).run();
	}
	await cancel(db, jobId, "bench_done");
	await logEvent(db, jobId, "bench_result", result);
	if (pod) {
		const retire = retirePod(env, db, pod.job_id, pod.id, "bench_done");
		defer(retire);
		await retire;
	}
}

/** Pure re-rank, unit-tested. */
export function rerank(rank: string[], results: Record<string, BenchResult>): string[] {
	const tested = rank.filter((g) => results[g]).sort((a, b) => results[a].score - results[b].score);
	return [...tested, ...rank.filter((g) => !results[g])];
}

/** Called from the 5-min cron: finish the run once every bench job is terminal (or after 1 h). */
export async function finishBench(env: Env, db: D1Database) {
	const run = await getConfig<BenchRun | null>(db, "bench_run", null);
	if (!run) return;
	const jobs = await Promise.all(run.jobs.map((j) => getJob(db, j.job_id)));
	// Actual spend of every pod the bench jobs rented (live pods billed to now), not the start-time estimate.
	const spent = (await Promise.all(run.jobs.map((j) => jobCost(db, j.job_id)))).reduce((s, c) => s + c.cost_usd, 0);
	const over = spent > BUDGET_USD;
	if (!over && !jobs.every((j) => !j || isTerminal(j.state)) && now() - run.started_at < RUN_TIMEOUT_MS) return;
	const reason = over ? "bench_budget" : "bench_timeout";
	if (over) await logEvent(db, "bench", "bench_budget", { spent_usd: spent, budget_usd: BUDGET_USD });
	for (const j of jobs) {
		if (!j || isTerminal(j.state)) continue;
		const pod = await activePod(db, j.id);
		await cancel(db, j.id, reason); // terminal first, so a failed/slow delete never leaves a live bench job
		if (pod) await retirePod(env, db, pod.job_id, pod.id, reason);
	}
	const results: Record<string, BenchResult> = {};
	for (const j of run.jobs) {
		const r = await getConfig<BenchResult | null>(db, resultKey(j.job_id), null);
		if (r) results[j.gpu] = r;
	}
	const rank = await getConfig<string[]>(db, "gpu_rank", GPU_RANK);
	const next = rerank(rank, results);
	if (Object.keys(results).length) await setConfig(db, "gpu_rank", next);
	await setConfig(db, "bench_last", { ...run, results, finished_at: now(), rank: next });
	await db.prepare("DELETE FROM config WHERE key = 'bench_run' OR key LIKE 'bench_result:%'").run();
	const lines = next.map((g, i) => `${i + 1}. ${g}${results[g] ? ` $${results[g].score} (boot ${results[g].boot_s}s, render ${results[g].render_s}s)` : " (untested)"}`);
	await alert(env, null, `weekly GPU ranking ($ per 60 s test video)\n${lines.join("\n")}`);
}
