// Pod agent, the container ENTRYPOINT (SPEC §2, §5, §6.4). Env: JOB_ID, JOB_TOKEN, CP_URL, TTL_MIN
// + RunPod-injected RUNPOD_POD_ID, RUNPOD_API_KEY (pod-scoped), RUNPOD_DC_ID.
//   node agent/main.ts             run the job
//   node agent/main.ts --selftest  print GPU, encode 5 s of 1080p test pattern, print fps
//   BENCH=1 / --bench              render bench/plan-60s.json without uploading, report render_s
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { cpus, totalmem, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ScenePlan, SpecOut } from "../../packages/contract/src/index.ts";
import { CONSTANTS } from "../../packages/contract/src/index.ts";
import { durationOf, encoderArgs, pickEncoder, run } from "../engine/ffmpeg.ts";
import { md5File, renderFinal, renderPreviews, TemplateError, type RenderInput } from "../engine/render.ts";
import { prepareVoice, silence } from "../engine/voice.ts";
import { ControlPlane, Gone, Held } from "./cp.ts";
import { fetchPackage } from "./package.ts";
import { fetchBundle, previewFrames, runBundle } from "./footage.ts";
import { resumableUpload } from "./upload.ts";
import { episodeSeconds, Scores } from "./score.ts";

const env = process.env;
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const STYLES_DIR = fileURLToPath(new URL("../styles", import.meta.url));
const BENCH_PLAN = fileURLToPath(new URL("../../bench/plan-60s.json", import.meta.url));
const WORK = join(env.WORK_DIR ?? tmpdir(), "vf");
const UPLOAD_CHUNK = Number(env.UPLOAD_CHUNK_BYTES) || undefined; // tests only; default CONSTANTS.DRIVE_CHUNK_BYTES
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- self-destruct (§6.4): DELETE with the pod-scoped key; fallback POST .../stop. Log both outcomes.
let destroying = false;
async function selfDestruct(reason: string): Promise<never> {
	if (!destroying) {
		destroying = true;
		log(`self-destruct: ${reason}`);
		const id = env.RUNPOD_POD_ID;
		const auth = { Authorization: `Bearer ${env.RUNPOD_API_KEY}` };
		if (id && env.RUNPOD_API_KEY) {
			const gone = (r: Response | Error) => !(r instanceof Error) && (r.ok || r.status === 404);
			let del = await fetch(`https://rest.runpod.io/v1/pods/${id}`, { method: "DELETE", headers: auth }).catch((e) => e as Error);
			log("DELETE pod (v1):", del instanceof Error ? del.message : del.status);
			if (!gone(del)) {
				// Scoped keys may be refused by v1 REST; v2 terminates any pod.
				del = await fetch(`https://api.runpod.io/v2/pods/${id}`, { method: "DELETE", headers: auth }).catch((e) => e as Error);
				log("DELETE pod (v2):", del instanceof Error ? del.message : del.status);
			}
			if (!gone(del)) {
				const stop = await fetch(`https://rest.runpod.io/v1/pods/${id}/stop`, { method: "POST", headers: auth }).catch((e) => e as Error);
				log("POST stop:", stop instanceof Error ? stop.message : stop.status);
			}
		} else log("no RUNPOD_POD_ID / RUNPOD_API_KEY: not on RunPod, just exiting");
	}
	process.exit(0);
}

function gpuName(): string {
	try {
		return execFileSync("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"], { encoding: "utf8" }).trim().split("\n")[0] || "cpu";
	} catch {
		return "cpu";
	}
}

async function selftest() {
	log("GPU:", gpuName());
	try {
		log(execFileSync("nvidia-smi", { encoding: "utf8" }));
	} catch {
		log("nvidia-smi not available");
	}
	const enc = await pickEncoder();
	log("encoder:", enc.name);
	if (enc.name !== "h264_nvenc") {
		const sh = (c: string) => { try { return execFileSync("sh", ["-c", c], { encoding: "utf8" }).trim(); } catch (e) { return `(${(e as Error).message.split("\n")[0]})`; } };
		log("nvenc diag: driver", sh("nvidia-smi --query-gpu=driver_version --format=csv,noheader"));
		log("nvenc diag: libs", sh("ldconfig -p | grep -E 'libnvidia-encode|libcuda\\.so' || echo none"));
		log("nvenc diag: caps", process.env.NVIDIA_DRIVER_CAPABILITIES ?? "unset", "visible", process.env.NVIDIA_VISIBLE_DEVICES ?? "unset");
	}
	const t0 = performance.now();
	const r = await run("ffmpeg", ["-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=5", ...encoderArgs(enc), "-f", "mp4", join(tmpdir(), "selftest.mp4")]);
	const s = (performance.now() - t0) / 1000;
	if (r.code !== 0) throw new Error(r.stderr.slice(-1000));
	log(`encoded 150 frames of 1080p with ${enc.name} in ${s.toFixed(2)} s = ${(150 / s).toFixed(1)} fps`);
	log("ffmpeg encoders:", execFileSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" }).split("\n").filter((l) => /nvenc|libx264 /.test(l)).join(" | "));
}

// ---- job run
const status: { stage: string; pct: number; scene?: number } = { stage: "booting", pct: 0 };
const queue: string[] = [];
let wake: (() => void) | null = null;
const faults = { silence: false, dropAfterChunk: null as number | null, renderErrorScene: null as number | null };

function push(cmd: string) {
	queue.push(cmd);
	wake?.();
}
async function nextCmd(): Promise<string> {
	while (!queue.length) await new Promise<void>((r) => (wake = r));
	return queue.shift()!;
}

function applyFault(f: string) {
	const [name, arg] = [f.split(":")[0], f.split(":").slice(1).join(":")];
	log("fault received:", f);
	if (name === "silence_heartbeat") faults.silence = true;
	if (name === "drop_upload_after_chunk") faults.dropAfterChunk = Number(arg || 1);
	if (name === "render_error") faults.renderErrorScene = Number(arg);
}

function startHeartbeat(cp: ControlPlane) {
	const every = Number(env.HEARTBEAT_MS) || CONSTANTS.HEARTBEAT_INTERVAL_S * 1000; // HEARTBEAT_MS: tests only
	let last = performance.now();
	setInterval(async () => {
		const gap = performance.now() - last;
		last = performance.now();
		if (gap > every * 1.5) log(`heartbeat tick late: ${(gap / 1000).toFixed(1)} s since last (stage=${status.stage})`);
		if (faults.silence) return;
		try {
			const { cmd } = await cp.heartbeat({ stage: status.stage, pct: status.pct, ...(status.scene ? { scene: status.scene } : {}) });
			if (cmd.startsWith("fault:")) applyFault(cmd.slice(6));
			else if (cmd !== "continue") push(cmd);
		} catch (e) {
			if (e instanceof Gone) push("cancel");
			else log("heartbeat failed:", (e as Error).message);
		}
	}, every);
}

const planOf = (s: SpecOut): ScenePlan => ({ style: s.style, fps: s.fps, resolution: s.resolution, scenes: s.scenes });

async function main() {
	if (process.argv.includes("--selftest")) return selftest();
	const { JOB_ID, JOB_TOKEN, CP_URL } = env;
	if (!JOB_ID || !JOB_TOKEN || !CP_URL) throw new Error("JOB_ID, JOB_TOKEN and CP_URL are required");

	// 1. TTL timer first; also give up if the control plane is unreachable for 5 min.
	const ttlMin = Number(env.TTL_MIN ?? CONSTANTS.POD_TTL_MIN);
	setTimeout(() => void selfDestruct(`TTL ${ttlMin} min`), ttlMin * 60_000);
	let reached = false;
	setTimeout(() => !reached && void selfDestruct("control plane unreachable for 5 min"), 5 * 60_000);

	const cp = new ControlPlane(CP_URL, JOB_ID, JOB_TOKEN);
	// 2. hello
	let hello;
	for (;;) {
		try {
			hello = await cp.hello({
				gpu: gpuName(), vcpu: cpus().length, ram_gb: Math.round(totalmem() / 2 ** 30),
				pod_id: env.RUNPOD_POD_ID ?? "local", data_center: env.RUNPOD_DC_ID ?? "local",
			});
			break;
		} catch (e) {
			if (e instanceof Gone) return selfDestruct(e.message);
			if (e instanceof Held) reached = true; // deliberate hold (slow_boot): not an outage; TTL still applies
			log("hello failed, retrying:", (e as Error).message);
			await sleep(10_000);
		}
	}
	reached = true;
	log("hello ->", hello.state);
	status.stage = hello.state;
	startHeartbeat(cp);

	const bench = env.BENCH === "1" || process.argv.includes("--bench");
	if (bench) {
		const plan = JSON.parse(await readFile(BENCH_PLAN, "utf8")) as ScenePlan;
		const audio = await silence(plan.scenes.reduce((a, s) => a + s.duration_s, 0), join(WORK, "bench.wav"));
		status.stage = "bench";
		const t0 = performance.now();
		await renderFinal({ plan, stylesDir: STYLES_DIR, workDir: join(WORK, "bench"), audioPath: audio.path, audioSeconds: audio.seconds, onProgress: (pct) => (status.pct = pct) });
		const render_s = (performance.now() - t0) / 1000;
		log(`bench render ${render_s.toFixed(1)} s`);
		await cp.bench(render_s).catch((e) => log("bench report failed", e));
		return selfDestruct("bench done");
	}

	// 3. plan + voiceover
	let spec = await cp.spec();
	status.stage = "tts";
	// voiceover {none:true} (blockworld only): caption-led, no narrator. A blockworld voice is only an explicit extra.
	const voice = "none" in spec.voiceover ? null : await prepareVoice(spec.voiceover, join(WORK, "audio"), () => cp.voiceover());
	if (voice) log(`voiceover ${voice.seconds.toFixed(2)} s`);
	// blockworld: the episode's own score, re-made whenever the episode changes (keyed by its sha), never a stale one.
	const scores = spec.style === "blockworld" ? new Scores(join(WORK, "score"), voice?.path ?? null) : null;
	const scoreLater = (s: SpecOut) => void scores?.get(s).catch((e) => log("score failed (retried at final):", (e as Error).message));
	// style "custom": the job's own package, fetched once per pod and again only if the plan's package id changes.
	let pkg: { id: string; dir: string } | null = null;
	const stylesFor = async (s: SpecOut): Promise<string> => {
		if (s.style !== "custom") return STYLES_DIR;
		const id = s.package ?? "";
		if (pkg?.id !== id) {
			pkg = null;
			pkg = { id, dir: await fetchPackage(id, s.package_sha256, WORK, () => cp.pkg()) };
			log(`style package ${id} ready`);
		}
		return pkg.dir;
	};
	// style "footage": the skill's own render over the job's bundle, once per bundle sha (a revise that changes
	// scene 1 props.bundle renders again; files that did not change stay downloaded).
	const footageDir = join(WORK, "footage");
	const haveFiles = new Map<string, string>();
	let footage: { sha: string; file: string } | null = null;
	const footageRender = async (s: SpecOut): Promise<string> => {
		const sha = String((s.scenes[0]?.props as { bundle?: unknown } | undefined)?.bundle ?? "");
		if (footage?.sha === sha) return footage.file;
		footage = null;
		status.stage = "footage_download";
		const m = await fetchBundle(footageDir, () => cp.bundle(), haveFiles, log);
		status.stage = "footage_render";
		const t0 = performance.now();
		const file = await runBundle(footageDir, m, log);
		log(`footage render ${((performance.now() - t0) / 1000).toFixed(1)} s -> ${file}`);
		footage = { sha, file };
		return file;
	};
	// Previews only need the length: blockworld times against the episode (its score is exactly that long).
	const previewAudio = (s: SpecOut) => (scores ? { path: null, seconds: episodeSeconds(s) } : voice!);
	const input = (s: SpecOut, stylesDir: string, audio: { path: string | null; seconds: number }): RenderInput => ({
		plan: planOf(s), stylesDir, workDir: join(WORK, "final"), audioPath: audio.path, audioSeconds: audio.seconds,
		failScene: faults.renderErrorScene,
		onProgress: (pct, scene) => Object.assign(status, { pct, scene }),
	});

	/** Run a step; on a template/render error report /error and return false (wait for a fix). */
	const attempt = async (stage: string, fn: () => Promise<void>): Promise<boolean> => {
		status.stage = stage;
		status.pct = 0;
		try {
			await fn();
			return true;
		} catch (e) {
			if (e instanceof Gone) throw e;
			const te = e instanceof TemplateError ? e : null;
			if (te && faults.renderErrorScene === te.scene) faults.renderErrorScene = null; // inject once
			log(`${stage} failed:`, (e as Error).message);
			const { cmd } = await cp.error({ stage, ...(te ? { scene: te.scene } : {}), log_tail: (te?.logTail ?? (e as Error).stack ?? String(e)).slice(-4000) });
			if (cmd === "cancel") push("cancel");
			else if (!te) setTimeout(() => push(stage === "preview" ? "previews" : stage === "final_render" ? "render_final" : "previews"), 5000);
			return false;
		}
	};

	let lastUpload = null as { file: string; fileId: string; md5: string; size: number } | null;
	// Scenes whose previews the control plane has. A round that failed posted nothing, so a later
	// rerender:<n> must also preview every scene still missing (else preview_ready shows only scene n).
	const previewed = new Set<number>();
	const doPreviews = (only?: number[]) =>
		attempt("preview", async () => {
			const scenes = only && [...new Set([...only, ...spec.scenes.map((s) => s.n).filter((n) => !previewed.has(n))])];
			if (spec.style === "footage") {
				const file = await footageRender(spec);
				await cp.previews(await previewFrames(file, await durationOf(file), join(WORK, "footage-previews")));
				previewed.add(1);
				return;
			}
			scoreLater(spec);
			await cp.previews(await renderPreviews(input(spec, await stylesFor(spec), previewAudio(spec)), scenes));
			for (const n of scenes ?? spec.scenes.map((s) => s.n)) previewed.add(n);
		});
	let resumeReport: Promise<unknown> | null = null;
	const doFinal = () =>
		attempt("final_render", async () => {
			const file = spec.style === "footage" ? await footageRender(spec)
				: await renderFinal(input(spec, await stylesFor(spec), scores ? await scores.forFinal(spec) : voice!)); // forFinal throws on a stale or wrong-length score
			const { md5, size } = await md5File(file);
			status.stage = "uploading";
			const fileId = await resumableUpload(file, size, {
				newSession: async () => (await cp.uploadSession({ name: `${spec.style}.mp4`, size, md5 })).session_uri,
				log,
				// With the drop fault armed, use 1 MiB chunks (a Drive-valid multiple of 256 KiB) so a normal
				// few-MB render spans several chunks and the drop lands mid-file (positive-offset resume).
				chunk: UPLOAD_CHUNK ?? (faults.dropAfterChunk ? 1024 * 1024 : undefined),
				dropAfterChunk: faults.dropAfterChunk,
				// Report the resume offset (from Drive's 308 Range) so the control plane records the evidence.
				// Telemetry only: the control plane answers it without consuming any pending command.
				onResume: (offset) => {
					resumeReport = cp.heartbeat({ stage: `upload_resumed:${offset}`, pct: 0 }).catch(() => undefined);
				},
			});
			// Best effort, bounded: let the telemetry land before /done so it can't race the verify.
			if (resumeReport) await Promise.race([resumeReport, sleep(5000)]);
			faults.dropAfterChunk = null;
			status.stage = "verifying";
			await cp.done({ file_id: fileId, md5, size });
			lastUpload = { file, fileId, md5, size };
		});

	await doPreviews();
	// 4. commands from heartbeats
	for (;;) {
		const cmd = await nextCmd();
		log("cmd:", cmd);
		if (cmd === "cancel") return selfDestruct("cancel");
		spec = await cp.spec(); // pick up revisions
		if (cmd === "previews") await doPreviews();
		else if (cmd.startsWith("rerender:")) await doPreviews([Number(cmd.split(":")[1])]);
		else if (cmd === "render_final") await doFinal();
		else if (cmd === "reupload" && lastUpload) {
			const u: { file: string; md5: string; size: number } = lastUpload;
			await attempt("uploading", async () => {
				const fileId = await resumableUpload(u.file, u.size, {
					newSession: async () => (await cp.uploadSession({ name: `${spec.style}.mp4`, size: u.size, md5: u.md5 })).session_uri,
					log,
					chunk: UPLOAD_CHUNK,
				});
				status.stage = "verifying";
				await cp.done({ file_id: fileId, md5: u.md5, size: u.size });
			});
		}
		status.stage = "idle";
	}
}

main().catch(async (e) => {
	log("fatal:", e instanceof Error ? e.stack : e);
	await selfDestruct(e instanceof Gone ? "job gone" : "fatal error");
});
