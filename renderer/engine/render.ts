// Render engine (Prompt 6a). Headless Chromium per scene template with frozen time; the engine drives
// window.__seek(t) per frame and pipes screenshots into ffmpeg. Chromium drawing is the CPU-bound part
// (SPEC §9.3), so pages render contiguous frame ranges in parallel; segments are joined with the
// concat demuxer (no re-encode), then the audio is muxed. Same plan + same machine -> same bytes.
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import type { ScenePlan } from "../../packages/contract/src/index.ts";
import { encoderArgs, must, pickEncoder, run, type Encoder } from "./ffmpeg.ts";
import { previewTimes, timeScenes, type Timed } from "./timing.ts";

export class TemplateError extends Error {
	scene: number;
	logTail: string;
	constructor(scene: number, logTail: string) {
		super(`template error in scene ${scene}: ${logTail.slice(-300)}`);
		this.scene = scene;
		this.logTail = logTail;
	}
}

export interface RenderInput {
	plan: ScenePlan;
	stylesDir: string; // .../renderer/styles
	workDir: string;
	audioPath: string | null; // null: silent (bench)
	audioSeconds: number;
	onProgress?: (pct: number, scene: number) => void;
	failScene?: number | null; // Phase 9 fault: render_error:<scene>
}

const TRANSITION_S = 0.35;

// Runs in the page before any template script: freeze time, seed randomness, expose __scene.
function initScript(arg: { scene: unknown; incoming: string; seed: number }) {
	const T0 = 1_700_000_000_000;
	const D = Date;
	// @ts-ignore browser context
	globalThis.Date = class extends D {
		constructor(...a: unknown[]) {
			// @ts-ignore
			a.length ? super(...a) : super(T0);
		}
		static now() {
			return T0;
		}
	};
	performance.now = () => 0;
	// @ts-ignore
	window.requestAnimationFrame = () => 0;
	// @ts-ignore
	window.setTimeout = () => 0;
	// @ts-ignore
	window.setInterval = () => 0;
	let s = arg.seed >>> 0;
	Math.random = () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	// @ts-ignore
	window.__scene = arg.scene;
	// @ts-ignore
	window.__vfIncoming = arg.incoming;
}

async function openScene(browser: Browser, inp: RenderInput, timed: Timed[], k: number): Promise<{ page: Page; errors: string[] }> {
	const { plan } = inp;
	const [w, h] = plan.resolution.split("x").map(Number);
	const t = timed[k];
	const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(String(e.stack ?? e)));
	page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
	const tokens = JSON.parse(await readFile(join(inp.stylesDir, plan.style, "tokens.json"), "utf8"));
	await page.addInitScript(initScript, {
		scene: {
			props: t.scene.props, tokens, duration: t.duration, width: w, height: h, fps: plan.fps,
			n: t.scene.n, total: plan.scenes.length, narration: t.scene.narration,
		},
		incoming: k > 0 ? timed[k - 1].scene.transition : "cut",
		seed: t.scene.n * 7919,
	});
	const file = join(inp.stylesDir, plan.style, `${t.scene.template}.html`);
	try {
		await page.goto(pathToFileURL(file).href, { waitUntil: "load" });
		// Transitions go through the style's own background, not black: templates exit to that background, so
		// a fade or slide from it is seamless (a fade from black flashed one dark frame at every join).
		const bg = typeof tokens?.palette?.bg === "string" ? tokens.palette.bg : "#000";
		await page.evaluate(async (bg: string) => {
			// @ts-ignore
			if (window.__ready) await window.__ready;
			// @ts-ignore
			if (typeof window.__seek !== "function") throw new Error("template defines no window.__seek");
			document.documentElement.style.background = bg;
			const o = document.createElement("div");
			o.id = "__vf_overlay";
			o.style.cssText = "position:fixed;inset:0;opacity:0;pointer-events:none;z-index:2147483647";
			o.style.background = bg;
			document.body.appendChild(o);
		}, bg);
	} catch (e) {
		errors.push(String((e as Error).message));
	}
	if (errors.length) {
		await page.close();
		throw new TemplateError(t.scene.n, errors.join("\n"));
	}
	return { page, errors };
}

async function shot(page: Page, errors: string[], sceneN: number, t: number): Promise<Buffer> {
	await page.evaluate(
		({ t, tr }) => {
			// @ts-ignore
			window.__seek(t);
			// @ts-ignore
			const kind = window.__vfIncoming;
			const p = Math.min(1, Math.max(0, t / tr));
			const e = 1 - (1 - p) ** 3;
			const o = document.getElementById("__vf_overlay")!;
			o.style.opacity = kind === "fade" ? String(1 - e) : "0";
			document.body.style.transform = kind === "slide" && p < 1 ? `translateX(${(1 - e) * 100}%)` : "";
		},
		{ t, tr: TRANSITION_S },
	).catch((e: Error) => {
		throw new TemplateError(sceneN, `__seek(${t.toFixed(3)}) threw: ${e.message}\n${errors.join("\n")}`);
	});
	if (errors.length) throw new TemplateError(sceneN, errors.join("\n"));
	return page.screenshot({ type: "jpeg", quality: 92 });
}

const launch = () =>
	chromium.launch({ args: ["--disable-gpu", "--font-render-hinting=none", "--force-color-profile=srgb", "--disable-lcd-text", "--hide-scrollbars"] });

/** 3 key frames per scene, 1280 px on the long side, JPEG < 500 KB. Returns {"scene-n-idx": jpeg}. */
export async function renderPreviews(inp: RenderInput, onlyScenes?: number[]): Promise<Map<string, Buffer>> {
	const timed = timeScenes(inp.plan.scenes, inp.audioSeconds, inp.plan.fps);
	const out = new Map<string, Buffer>();
	const browser = await launch();
	try {
		for (let k = 0; k < timed.length; k++) {
			const n = timed[k].scene.n;
			if (onlyScenes && !onlyScenes.includes(n)) continue;
			if (inp.failScene === n) throw new TemplateError(n, "fault injected: render_error");
			const { page, errors } = await openScene(browser, inp, timed, k);
			const times = previewTimes(timed[k].duration);
			for (let i = 0; i < 3; i++) out.set(`scene-${n}-${i}`, await shrink(await shot(page, errors, n, times[i])));
			await page.close();
			inp.onProgress?.(Math.round(((k + 1) / timed.length) * 100), n);
		}
	} finally {
		await browser.close();
	}
	return out;
}

async function shrink(jpeg: Buffer): Promise<Buffer> {
	for (const q of [3, 6, 10, 16]) {
		const src = new PassThrough();
		src.end(jpeg);
		const r = await runBuffer(["-hide_banner", "-loglevel", "error", "-f", "image2pipe", "-i", "-", "-vf", "scale='if(gt(iw,ih),1280,-2)':'if(gt(iw,ih),-2,1280)'", "-q:v", String(q), "-f", "image2", "-c:v", "mjpeg", "-"], src);
		if (r.length < 500 * 1024) return r;
	}
	throw new Error("preview could not be made smaller than 500 KB");
}

function runBuffer(args: string[], input: NodeJS.ReadableStream): Promise<Buffer> {
	return new Promise(async (resolve, reject) => {
		const { spawn } = await import("node:child_process");
		const p = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
		const chunks: Buffer[] = [];
		let err = "";
		p.stdout.on("data", (d: Buffer) => chunks.push(d));
		p.stderr.on("data", (d) => (err += d));
		p.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(err.slice(-500)))));
		input.pipe(p.stdin);
	});
}

export function renderWorkerCount(requested: number, maxSegments: number, encoder: Encoder["name"]): number {
	// Every worker opens its own encoder. Leave room below the shared GeForce NVENC session limit.
	const encoderLimit = encoder === "h264_nvenc" ? 4 : Infinity;
	return Math.max(1, Math.min(requested, maxSegments, encoderLimit));
}

/** Full video: parallel frame ranges -> segments -> concat (copy) -> mux audio. Returns the mp4 path. */
export async function renderFinal(inp: RenderInput): Promise<string> {
	const { plan, workDir } = inp;
	const timed = timeScenes(plan.scenes, inp.audioSeconds, plan.fps);
	const total = timed.reduce((a, t) => a + t.frames, 0);
	const enc = await pickEncoder();
	const workers = renderWorkerCount(
		Number(process.env.RENDER_WORKERS) || availableParallelism() - 1, Math.ceil(total / plan.fps), enc.name,
	);
	await rm(workDir, { recursive: true, force: true });
	await mkdir(workDir, { recursive: true });
	for (const t of timed) if (inp.failScene === t.scene.n) throw new TemplateError(t.scene.n, "fault injected: render_error");

	const per = Math.ceil(total / workers);
	let done = 0;
	const browser = await launch();
	try {
		await Promise.all(
			Array.from({ length: workers }, async (_, w) => {
				const from = w * per;
				const to = Math.min(total, from + per);
				if (from >= to) return;
				const pipe = new PassThrough();
				const ff = run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "image2pipe", "-framerate", String(plan.fps), "-c:v", "mjpeg", "-i", "-", ...encoderArgs(enc), "-r", String(plan.fps), join(workDir, `seg_${String(w).padStart(3, "0")}.mp4`)], pipe);
				let k = timed.findIndex((t) => from < t.startFrame + t.frames);
				let cur = await openScene(browser, inp, timed, k);
				try {
					for (let f = from; f < to; f++) {
						while (f >= timed[k].startFrame + timed[k].frames) {
							await cur.page.close();
							cur = await openScene(browser, inp, timed, ++k);
						}
						const jpeg = await shot(cur.page, cur.errors, timed[k].scene.n, (f - timed[k].startFrame) / plan.fps);
						if (!pipe.write(jpeg)) await new Promise((r) => pipe.once("drain", r));
						if (++done % plan.fps === 0) inp.onProgress?.(Math.round((done / total) * 100), timed[k].scene.n);
					}
				} finally {
					pipe.end();
					await cur.page.close().catch(() => undefined);
				}
				const r = await ff;
				if (r.code !== 0) throw new Error(`encode segment ${w}: ${r.stderr.slice(-800)}`);
			}),
		);
	} finally {
		await browser.close();
	}

	const segs = Array.from({ length: workers }, (_, w) => `file 'seg_${String(w).padStart(3, "0")}.mp4'`).filter((_, w) => w * per < total);
	await writeFile(join(workDir, "segments.txt"), segs.join("\n") + "\n");
	const video = join(workDir, "video.mp4");
	await must("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", join(workDir, "segments.txt"), "-c", "copy", "-fflags", "+bitexact", "-map_metadata", "-1", video]);
	const out = join(workDir, "final.mp4");
	if (!inp.audioPath) {
		await must("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", video, "-c", "copy", "-movflags", "+faststart", "-fflags", "+bitexact", out]);
	} else {
		await must("ffmpeg", [
			"-hide_banner", "-loglevel", "error", "-y", "-i", video, "-i", inp.audioPath,
			"-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-flags:a", "+bitexact",
			"-t", (total / plan.fps).toFixed(3), "-movflags", "+faststart", "-fflags", "+bitexact", "-map_metadata", "-1", out,
		]);
	}
	return out;
}

export async function md5File(path: string): Promise<{ md5: string; size: number }> {
	const { createHash } = await import("node:crypto");
	const h = createHash("md5");
	for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
	return { md5: h.digest("hex"), size: (await stat(path)).size };
}
