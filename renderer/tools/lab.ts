// Style lab: the measuring tools behind docs/prompts/STYLE_REFINEMENT.md.
//
//   node renderer/tools/lab.ts refs <channel-url> [--top 5] [--first 600] [--out DIR] [--shorts]
//       Top videos of a channel by views -> DIR/<id>.mp4 (+ English captions, info json, refs.json).
//       Default DIR: ~/.cache/vf-refs/<channel>/ (never synced: other people's videos).
//   node renderer/tools/lab.ts sample <plan.json> [--out DIR] [--voice af_heart] [--voice-file a.wav] [--styles DIR]
//       Local render of a scene plan with the real engine: per-scene Kokoro voice (parallel), exact scene timing,
//       renderFinal at full parallelism, contact sheet. Writes DIR/final.mp4, plan.timed.json, sheet.jpg, sample.json.
//   node renderer/tools/lab.ts compare --sample <mp4> --refs <dir|mp4...> [--out DIR]
//       Measures every video the same way (pacing, colour, motion, loudness, speech rate, palette) and writes
//       DIR/report.md + report.json + side-by-side frame sheets (full video and first 12 s) for visual review.
import { execFile } from "node:child_process";
import { availableParallelism, homedir } from "node:os";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const RENDERER = resolve(HERE, "..");
const args = process.argv.slice(2);
const opt = (f: string, d?: string) => (args.indexOf(f) >= 0 ? args[args.indexOf(f) + 1] : d);
const flag = (f: string) => args.includes(f);
const VALUED = new Set(["--top", "--first", "--out", "--voice", "--voice-file", "--styles", "--sample", "--cap"]);
const positional = () => {
	const end = args.includes("--refs") ? args.indexOf("--refs") : args.length; // --refs takes every value after it
	return args.slice(0, end).filter((a, i) => !a.startsWith("--") && !VALUED.has(args[i - 1]));
};
const ff = (a: string[], max = 1 << 28) => run("ffmpeg", ["-hide_banner", "-nostdin", ...a], { maxBuffer: max });
const probeDur = async (f: string) => Number((await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f])).stdout.trim());

async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let i = 0;
	await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
		while (i < items.length) {
			const k = i++;
			out[k] = await fn(items[k], k);
		}
	}));
	return out;
}

// ------------------------------------------------------------------ refs
async function refs() {
	const url = positional()[1];
	if (!url) throw new Error("usage: lab.ts refs <channel-url> [--top 5] [--first 600] [--out DIR] [--shorts]");
	const top = Number(opt("--top", "5"));
	const first = Number(opt("--first", "600"));
	const base = url.replace(/\/(videos|shorts|featured|streams)\/?$/, "");
	const tab = `${base}/${flag("--shorts") ? "shorts" : "videos"}`;
	const slug = (/@([\w.-]+)/.exec(base)?.[1] ?? basename(base)).toLowerCase();
	const out = resolve(opt("--out", join(homedir(), ".cache", "vf-refs", slug))!);
	mkdirSync(out, { recursive: true });
	console.log(`listing ${tab} ...`);
	const list = JSON.parse((await run("yt-dlp", ["--flat-playlist", "-J", "--playlist-end", "400", tab], { maxBuffer: 1 << 28 })).stdout);
	type Entry = { id: string; title: string; view_count?: number; duration?: number };
	const entries = (list.entries as Entry[]).filter((e) => e.id && (flag("--shorts") || !e.duration || e.duration >= 60));
	if (!entries.some((e) => e.view_count)) console.warn("view counts missing from the listing; taking the newest videos instead");
	const picked = entries.sort((a, b) => (b.view_count ?? 0) - (a.view_count ?? 0)).slice(0, top);
	console.log(`downloading ${picked.length} (first ${first}s of each, <=720p) into ${out}`);
	const videos = await pool(picked, 3, async (e) => {
		const file = join(out, `${e.id}.mp4`);
		if (!existsSync(file)) {
			await run("yt-dlp", [
				"-q", "--no-warnings", "-f", "bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720]/b", "--merge-output-format", "mp4",
				"--download-sections", `*0-${first}`, "--write-info-json", "-o", join(out, "%(id)s.%(ext)s"), `https://www.youtube.com/watch?v=${e.id}`,
			], { maxBuffer: 1 << 26 });
			// captions (speech rate) are optional: YouTube rate-limits them, never fail the download over it
			await run("yt-dlp", ["-q", "--no-warnings", "--skip-download", "--write-subs", "--write-auto-subs", "--sub-langs", "en,en-orig,en-US,en-GB", "--sub-format", "vtt", "-o", join(out, "%(id)s.%(ext)s"), `https://www.youtube.com/watch?v=${e.id}`]).catch(() => console.warn(`  (no captions for ${e.id})`));
		}
		const subs = readdirSync(out).find((f) => f.startsWith(e.id + ".") && f.endsWith(".vtt"));
		console.log(`  ${e.id}  ${(e.view_count ?? 0).toLocaleString()} views  ${e.title}`);
		return { id: e.id, title: e.title, views: e.view_count ?? null, duration: e.duration ?? null, file, subs: subs ? join(out, subs) : null };
	});
	writeFileSync(join(out, "refs.json"), JSON.stringify({ channel: base, fetched_at: new Date().toISOString(), first_seconds: first, videos }, null, 1));
	console.log(`REFS ${out}`);
}

// ------------------------------------------------------------------ sample
async function sample() {
	const planPath = resolve(positional()[1] ?? "");
	if (!existsSync(planPath)) throw new Error("usage: lab.ts sample <plan.json> [--out DIR] [--voice af_heart] [--voice-file a.wav] [--styles DIR]");
	const out = resolve(opt("--out", join(dirname(planPath), "sample"))!);
	mkdirSync(out, { recursive: true });
	const { must, durationOf } = await import("../engine/ffmpeg.ts");
	const { renderFinal } = await import("../engine/render.ts");
	const plan = JSON.parse(readFileSync(planPath, "utf8"));
	let voice: string;
	const t0 = Date.now();
	if (opt("--voice-file")) {
		voice = join(out, "voice.wav");
		await must("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", resolve(opt("--voice-file")!), "-ac", "1", "-ar", "48000", voice]);
	} else {
		// Kokoro per scene, several child processes at once (each capped to a few ONNX threads)
		const par = Math.max(1, Math.floor(availableParallelism() / 4));
		const env = { ...process.env, TTS_ALLOW_DOWNLOAD: "1", TTS_THREADS: "4", ...(opt("--voice") ? { TTS_VOICE: opt("--voice") } : {}) };
		const voiceTs = join(RENDERER, "engine", "voice.ts");
		await pool(plan.scenes, par, async (s: { n: number; narration: string }) => {
			const raw = join(out, `vo_${s.n}.wav`);
			const txt = join(out, `vo_${s.n}.txt`);
			const prev = existsSync(txt) ? readFileSync(txt, "utf8") : "";
			if (!existsSync(raw) || prev !== s.narration) {
				writeFileSync(txt, s.narration);
				await run(process.execPath, [voiceTs, txt, raw], { env, maxBuffer: 1 << 26 });
			}
		});
		const list: string[] = [];
		for (const s of plan.scenes) {
			const pad = join(out, `vp_${s.n}.wav`);
			await must("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", join(out, `vo_${s.n}.wav`), "-af", "apad=pad_dur=0.35", pad]);
			s.duration_s = Math.max(2.2, await durationOf(pad));
			list.push(`file '${pad}'`);
		}
		writeFileSync(join(out, "vo.txt"), list.join("\n") + "\n");
		voice = join(out, "voice.wav");
		await must("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", join(out, "vo.txt"), "-ac", "1", "-ar", "48000", voice]);
		console.log(`voice: ${((Date.now() - t0) / 1000).toFixed(0)} s (${par} parallel)`);
	}
	const secs = await durationOf(voice);
	writeFileSync(join(out, "plan.timed.json"), JSON.stringify(plan, null, 1));
	const t1 = Date.now();
	const stylesDir = resolve(opt("--styles", join(RENDERER, "styles"))!);
	const file = await renderFinal({ plan, stylesDir, workDir: join(out, "work"), audioPath: voice, audioSeconds: secs, onProgress: (p) => p % 25 === 0 && console.log(`render ${p}%`) });
	const final = join(out, "final.mp4");
	await must("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", file, "-c", "copy", final]);
	const words = plan.scenes.reduce((a: number, s: { narration?: string }) => a + (s.narration ?? "").split(/\s+/).filter(Boolean).length, 0);
	writeFileSync(join(out, "sample.json"), JSON.stringify({ plan: planPath, seconds: secs, words, render_s: (Date.now() - t1) / 1000 }, null, 1));
	await sheet([final], join(out, "sheet.jpg"), 12, secs);
	console.log(`render: ${((Date.now() - t1) / 1000).toFixed(0)} s for ${secs.toFixed(1)} s of video`);
	console.log(`SAMPLE ${final}`);
}

// ------------------------------------------------------------------ compare
type Metrics = Record<string, number | string | null>;
async function measure(file: string, cap: number): Promise<Metrics> {
	const dur = Math.min(await probeDur(file), cap);
	const T = ["-t", String(dur)];
	const [cuts, stats, motion, loud, pal] = await Promise.all([
		ff(["-i", file, ...T, "-an", "-vf", "scale=320:-2,select='gte(scene,0)',metadata=print:key=lavfi.scene_score:file=-", "-f", "null", "-"]).then((r) => shotChanges(r.stdout)),
		ff(["-i", file, ...T, "-an", "-vf", "fps=1,scale=320:-2,signalstats,metadata=print:file=-", "-f", "null", "-"]).then((r) => {
			const avg = (k: string) => {
				const v = [...r.stdout.matchAll(new RegExp(`lavfi\\.signalstats\\.${k}=([\\d.]+)`, "g"))].map((m) => Number(m[1]));
				return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
			};
			const hi = avg("YHIGH"), lo = avg("YLOW");
			return { luma: avg("YAVG"), saturation: avg("SATAVG"), contrast: hi !== null && lo !== null ? hi - lo : null };
		}),
		ff(["-i", file, ...T, "-an", "-vf", "fps=5,scale=160:-2,tblend=all_mode=difference,signalstats,metadata=print:file=-", "-f", "null", "-"]).then((r) => {
			const v = [...r.stdout.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
			return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
		}),
		ff(["-i", file, ...T, "-vn", "-af", "ebur128=framelog=quiet", "-f", "null", "-"]).then((r) => ({
			lufs: Number(/I:\s+(-?[\d.]+) LUFS/.exec(r.stderr)?.[1] ?? NaN),
			lra: Number(/LRA:\s+([\d.]+) LU/.exec(r.stderr)?.[1] ?? NaN),
		})).catch(() => ({ lufs: NaN, lra: NaN })),
		(async () => {
			const png = join(dirname(file), `.palette-${basename(file)}.png`);
			await ff(["-loglevel", "error", "-y", "-i", file, ...T, "-an", "-vf", "fps=0.5,scale=160:-2,palettegen=max_colors=6:reserve_transparent=0:stats_mode=full", "-frames:v", "1", png]);
			const r = await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", png, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { encoding: "buffer", maxBuffer: 1 << 20 });
			const b = r.stdout as unknown as Buffer;
			return Array.from({ length: 6 }, (_, i) => "#" + b.subarray(i * 3, i * 3 + 3).toString("hex")).join(" ");
		})()
			.catch(() => null),
	]);
	const words = wordsFor(file, dur);
	return {
		file: basename(file),
		seconds: Number(dur.toFixed(1)),
		shots: cuts + 1,
		avg_shot_s: Number((dur / (cuts + 1)).toFixed(2)),
		shot_changes_per_min: Number(((cuts / dur) * 60).toFixed(1)),
		luma: round(stats.luma),
		saturation: round(stats.saturation),
		contrast: round(stats.contrast),
		motion: round(motion),
		lufs: Number.isFinite(loud.lufs) ? loud.lufs : null,
		loudness_range: Number.isFinite(loud.lra) ? loud.lra : null,
		words_per_min: words !== null ? Number(((words / dur) * 60).toFixed(0)) : null,
		palette: pal,
	};
}
/** Shot changes = hard cuts plus fast transitions: local peaks of the frame-difference score that stand well above
 *  the video's own baseline (animation rarely crosses the 0.3 live-action cut threshold), at least 0.4 s apart. */
function shotChanges(meta: string): number {
	const pts: { t: number; v: number }[] = [];
	let t = 0;
	for (const line of meta.split("\n")) {
		const m = /pts_time:([\d.]+)/.exec(line);
		if (m) t = Number(m[1]);
		const v = /scene_score=([\d.]+)/.exec(line);
		if (v) pts.push({ t, v: Number(v[1]) });
	}
	if (pts.length < 3) return 0;
	const vals = pts.map((p) => p.v).sort((a, b) => a - b);
	const median = vals[Math.floor(vals.length / 2)];
	const p90 = vals[Math.floor(vals.length * 0.9)];
	const thr = Math.max(0.05, median * 6, p90 * 2);
	let n = 0, last = -1;
	for (let i = 1; i < pts.length - 1; i++) {
		const p = pts[i];
		if (p.v >= thr && p.v >= pts[i - 1].v && p.v >= pts[i + 1].v && p.t - last >= 0.4) (n++, (last = p.t));
	}
	return n;
}
const round = (v: number | null) => (v === null ? null : Number(v.toFixed(1)));

/** Speech rate source: sample.json next to a lab sample, or the YouTube captions next to a reference (first `cap` s). */
function wordsFor(file: string, cap: number): number | null {
	const sj = join(dirname(file), "sample.json");
	if (basename(file) === "final.mp4" && existsSync(sj)) return JSON.parse(readFileSync(sj, "utf8")).words;
	const id = basename(file).replace(/\.mp4$/, "");
	const vtts = readdirSync(dirname(file)).filter((f) => f.startsWith(id + ".") && f.endsWith(".vtt"));
	const vtt = [".en.vtt", ".en-orig.vtt", ".en-US.vtt", ".en-GB.vtt"].map((x) => id + x).find((x) => vtts.includes(x)) ?? vtts[0];
	if (!vtt) return null;
	// cues that start inside the measured window; auto captions roll (each cue repeats the previous line), so keep
	// each cue's last line, strip word-timing tags and drop consecutive repeats
	const lines: string[] = [];
	for (const block of readFileSync(join(dirname(file), vtt), "utf8").split(/\n\n+/)) {
		const ts = /(\d+):(\d+):([\d.]+)\s+-->/.exec(block);
		if (!ts || Number(ts[1]) * 3600 + Number(ts[2]) * 60 + Number(ts[3]) >= cap) continue;
		const text = block.split("\n").filter((l) => l.trim() && !l.includes("-->")).at(-1)?.replace(/<[^>]+>/g, "").trim();
		if (text && text !== lines.at(-1)) lines.push(text);
	}
	return lines.join(" ").split(/\s+/).filter(Boolean).length;
}

async function sheet(files: string[], out: string, frames: number, cap: number, from = 0) {
	const rows = await pool(files, 3, async (f, i) => {
		const d = Math.min(await probeDur(f), cap) - from;
		const fps = frames / Math.max(1, d);
		const row = join(dirname(out), `.row-${basename(out, ".jpg")}-${i}.jpg`);
		await ff(["-loglevel", "error", "-y", "-ss", String(from), "-i", f, "-t", String(d), "-vf", `fps=${fps},scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2,tile=${frames}x1`, "-frames:v", "1", row]);
		return row;
	});
	if (rows.length === 1) await ff(["-loglevel", "error", "-y", "-i", rows[0], out]);
	else await ff(["-loglevel", "error", "-y", ...rows.flatMap((r) => ["-i", r]), "-filter_complex", `vstack=inputs=${rows.length}`, out]);
}

async function compare() {
	const sampleFile = resolve(opt("--sample") ?? "");
	if (!existsSync(sampleFile)) throw new Error("usage: lab.ts compare --sample <mp4> --refs <dir|mp4...> [--out DIR]");
	const ri = args.indexOf("--refs");
	const refArgs = ri >= 0 ? args.slice(ri + 1).filter((a, i, all) => !a.startsWith("--") && !all.slice(0, i).some((x) => x.startsWith("--"))) : [];
	const refFiles = refArgs.flatMap((a) => (statSync(a).isDirectory() ? readdirSync(a).filter((f) => f.endsWith(".mp4")).map((f) => join(a, f)) : [a])).map((f) => resolve(f));
	if (!refFiles.length) throw new Error("no reference .mp4 files found");
	const out = resolve(opt("--out", join(dirname(sampleFile), "compare"))!);
	mkdirSync(out, { recursive: true });
	const cap = Number(opt("--cap", "600"));
	const all = await pool([...refFiles, sampleFile], 3, (f) => measure(f, cap));
	const refsM = all.slice(0, -1), sM = all.at(-1)!;
	const keys = ["avg_shot_s", "shot_changes_per_min", "words_per_min", "luma", "saturation", "contrast", "motion", "lufs", "loudness_range"];
	const rows = keys.map((k) => {
		const v = refsM.map((m) => m[k]).filter((x): x is number => typeof x === "number");
		const mean = v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
		const lo = v.length ? Math.min(...v) : null, hi = v.length ? Math.max(...v) : null;
		const s = typeof sM[k] === "number" ? (sM[k] as number) : null;
		const span = lo !== null && hi !== null ? Math.max(hi - lo, Math.abs(mean ?? 0) * 0.15) : 0;
		const off = s !== null && mean !== null && lo !== null && hi !== null && (s < lo - span * 0.25 || s > hi + span * 0.25);
		return { metric: k, ref_mean: mean === null ? null : Number(mean.toFixed(2)), ref_min: lo, ref_max: hi, sample: s, gap: off ? (s! > hi! ? "HIGH" : "LOW") : "ok" };
	});
	await sheet(refFiles.slice(0, 5).concat(sampleFile), join(out, "side-by-side.jpg"), 8, cap);
	await sheet(refFiles.slice(0, 5).concat(sampleFile), join(out, "hooks-first-12s.jpg"), 8, 12);
	const md = [
		`# Style comparison`,
		``,
		`Sample: ${basename(dirname(sampleFile))}/${basename(sampleFile)} — references: ${refFiles.length} (first ${cap}s each).`,
		``,
		`| metric | refs mean | refs range | sample | gap |`,
		`|---|---|---|---|---|`,
		...rows.map((r) => `| ${r.metric} | ${r.ref_mean ?? "–"} | ${r.ref_min ?? "–"} – ${r.ref_max ?? "–"} | ${r.sample ?? "–"} | ${r.gap} |`),
		``,
		`Palettes (6 dominant colours): ${refsM.map((m) => `\n- ref ${m.file}: ${m.palette}`).join("")}\n- SAMPLE: ${sM.palette}`,
		``,
		`Frame sheets (rows = references in order, LAST row = sample): side-by-side.jpg (whole video), hooks-first-12s.jpg (openings).`,
		`Metrics are pacing/colour/sound only; judge drawing style, typography, layout, characters and storytelling from the sheets.`,
		`Glossary: avg_shot_s = seconds between shot changes (cuts or fast transitions); motion = mean frame-to-frame change (0-255, higher = busier); contrast = mean luma range; lufs = integrated loudness (YouTube normalises to about -14).`,
	].join("\n");
	writeFileSync(join(out, "report.md"), md + "\n");
	writeFileSync(join(out, "report.json"), JSON.stringify({ refs: refsM, sample: sM, rows }, null, 1));
	console.log(md);
	console.log(`\nREPORT ${join(out, "report.md")}`);
}

const cmd = args[0];
const fn = { refs, sample, compare }[cmd as "refs"];
if (!fn) {
	console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(0, 13).join("\n").replace(/^\/\/ ?/gm, ""));
	process.exit(cmd ? 1 : 0);
}
fn().catch((e) => {
	console.error(`lab ${cmd}: ${e.message}`);
	process.exit(1);
});
