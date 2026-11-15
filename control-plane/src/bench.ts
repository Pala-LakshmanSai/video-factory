// SPEC §9.3 weekly re-rank (Prompt 7.3). Sunday 03:00 UTC: one bench pod per ranked GPU that is
// available now; the agent (env BENCH=1) renders bench/plan-60s.json without uploading and POSTs
// /agent/{job}/bench {render_s}. boot_s = /hello - pod create. Score = cost_per_hr * (boot_s + render_s) / 3600
// = $ per standard test video. Tested GPUs sorted by score, untested keep their relative order below.
import { alert } from "./alerts";
import { GPU_RANK, getConfig, norm, setConfig } from "./config";
import { activePod, getJob, logEvent, markPodDeleted, now } from "./db";
import { acquireGpu } from "./mcp";
import { catalog, deletePod } from "./runpod";
import { selectAndCreate } from "./selector";
import { isTerminal, transition } from "./state";

const BUDGET_USD = 2;
const EST_MIN_PER_RUN = 12; // boot + 60 s render on a slow pod, generous
const RUN_TIMEOUT_MS = 60 * 60_000;

interface BenchRun {
	started_at: number;
	jobs: { job_id: string; gpu: string; cost_per_hr: number }[];
	results: Record<string, { boot_s: number; render_s: number; cost_per_hr: number; score: number }>;
}

export async function startBench(env: Env, db: D1Database) {
	if (await getConfig<BenchRun | null>(db, "bench_run", null)) return "already running";
	const rank = await getConfig<string[]>(db, "gpu_rank", GPU_RANK);
	const cat = await catalog(env, db);
	const available = rank.filter((g) => cat.dataCenters.some((dc) => dc.gpuAvailability?.some((a) => norm(a.id) === norm(g) && a.availability !== "NONE")));
	const run: BenchRun = { started_at: now(), jobs: [], results: {} };
	let estimate = 0;
	for (const gpu of available) {
		const { job_id } = await acquireGpu(env, db, {
			style: "explainer", title: `bench ${gpu}`, voiceover: { text: "bench" }, chat_key: `bench-${now()}-${norm(gpu).replace(/\W+/g, "-")}`,
		}, { dev_mode: "bench" });
		const r = await selectAndCreate(env, db, job_id, { rank: [gpu], gpuOnly: true });
		const pod = r === "created" ? await activePod(db, job_id) : null;
		if (!pod) continue;
		const cost = (pod.cost_per_hr * EST_MIN_PER_RUN) / 60;
		if (estimate + cost > BUDGET_USD) {
			// Abort: this run would spend more than $2.
			await deletePod(env, pod.id);
			await markPodDeleted(db, pod.id, "bench_budget");
			const job = await getJob(db, job_id);
			if (job && !isTerminal(job.state)) await transition(db, job, "cancelled", { reason: "bench_budget" });
			break;
		}
		estimate += cost;
		run.jobs.push({ job_id, gpu, cost_per_hr: pod.cost_per_hr });
	}
	await setConfig(db, "bench_run", run);
	return `bench started: ${run.jobs.length} GPUs, est $${estimate.toFixed(2)}`;
}

/** POST /agent/{job}/bench handler body. */
export async function recordBench(env: Env, db: D1Database, jobId: string, renderS: number) {
	const run = await getConfig<BenchRun | null>(db, "bench_run", null);
	const entry = run?.jobs.find((j) => j.job_id === jobId);
	const pod = await activePod(db, jobId);
	if (run && entry && pod?.hello_at) {
		const boot_s = (pod.hello_at - pod.created_at) / 1000;
		const score = (entry.cost_per_hr * (boot_s + renderS)) / 3600;
		run.results[entry.gpu] = { boot_s: Math.round(boot_s), render_s: Math.round(renderS), cost_per_hr: entry.cost_per_hr, score: Math.round(score * 10000) / 10000 };
		await setConfig(db, "bench_run", run);
	}
	if (pod) {
		await deletePod(env, pod.id);
		await markPodDeleted(db, pod.id, "bench_done");
	}
	const job = await getJob(db, jobId);
	if (job && !isTerminal(job.state)) await transition(db, job, "cancelled", { reason: "bench_done" });
	await logEvent(db, jobId, "bench_result", run?.results[entry?.gpu ?? ""] ?? null);
}

/** Pure re-rank, unit-tested. */
export function rerank(rank: string[], results: BenchRun["results"]): string[] {
	const tested = rank.filter((g) => results[g]).sort((a, b) => results[a].score - results[b].score);
	return [...tested, ...rank.filter((g) => !results[g])];
}

/** Called from the 5-min cron: finish the run once every bench job is terminal (or after 1 h). */
export async function finishBench(env: Env, db: D1Database) {
	const run = await getConfig<BenchRun | null>(db, "bench_run", null);
	if (!run) return;
	const jobs = await Promise.all(run.jobs.map((j) => getJob(db, j.job_id)));
	if (!jobs.every((j) => !j || isTerminal(j.state)) && now() - run.started_at < RUN_TIMEOUT_MS) return;
	for (const j of jobs) {
		if (!j || isTerminal(j.state)) continue;
		const pod = await activePod(db, j.id);
		if (pod) {
			await deletePod(env, pod.id);
			await markPodDeleted(db, pod.id, "bench_timeout");
		}
		await transition(db, j, "cancelled", { reason: "bench_timeout" });
	}
	const rank = await getConfig<string[]>(db, "gpu_rank", GPU_RANK);
	const next = rerank(rank, run.results);
	if (Object.keys(run.results).length) await setConfig(db, "gpu_rank", next);
	await setConfig(db, "bench_last", { ...run, finished_at: now(), rank: next });
	await db.prepare("DELETE FROM config WHERE key = 'bench_run'").run();
	const lines = next.map((g, i) => `${i + 1}. ${g}${run.results[g] ? ` $${run.results[g].score} (boot ${run.results[g].boot_s}s, render ${run.results[g].render_s}s)` : " (untested)"}`);
	await alert(env, null, `weekly GPU ranking ($ per 60 s test video)\n${lines.join("\n")}`);
}
