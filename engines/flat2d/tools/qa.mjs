#!/usr/bin/env node
// flat2d automatic QA (docs/ENGINE_FLAT2D.md "QA hook", Guard 5): opens every scene of a package the way
// renderer/engine/render.ts does, seeks 3 sample times, reads window.__qa, screenshots, and flags problems.
// Usage: node engines/flat2d/tools/qa.mjs <package-dir> <scene_plan.json> [--frames 3] [--out dir]
// Writes <out>/qa-report.json, <out>/qa-report.txt, <out>/contact-sheet.jpg; exit 1 on any error.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { availableParallelism } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(new URL("../../../renderer/package.json", import.meta.url));
const { chromium } = require("playwright");

const LUMA_MIN = 20, TEXT_MIN = 28, LETTERBOX = 60; // px at 1080p

// Same as renderer/engine/render.ts initScript: frozen time, seeded Math.random, window.__scene.
function initScript(arg) {
	const T0 = 1_700_000_000_000, D = Date;
	globalThis.Date = class extends D { constructor(...a) { a.length ? super(...a) : super(T0); } static now() { return T0; } };
	performance.now = () => 0;
	window.requestAnimationFrame = () => 0;
	window.setTimeout = () => 0;
	window.setInterval = () => 0;
	let s = arg.seed >>> 0;
	Math.random = () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	window.__scene = arg.scene;
	window.__vfIncoming = arg.incoming;
}

function ffmpeg(args) {
	return new Promise((res, rej) => {
		const p = spawn("ffmpeg", ["-hide_banner", "-y", ...args], { stdio: ["ignore", "ignore", "pipe"] });
		let err = "";
		p.stderr.on("data", (d) => (err += d));
		p.on("close", (c) => (c === 0 ? res(err) : rej(new Error(err.slice(-500)))));
	});
}
// luma spread YHIGH - YLOW (10th..90th percentile), as renderer/test/style-stickman.test.ts
async function lumaSpread(file) {
	const r = await ffmpeg(["-i", file, "-vf", "signalstats,metadata=print", "-f", "null", "-"]);
	return Number(/YHIGH=([\d.]+)/.exec(r)?.[1]) - Number(/YLOW=([\d.]+)/.exec(r)?.[1]);
}

// sample times: start+0.3, evenly spaced middles, end-0.3; the middle one (index floor(k/2)) is "mid"
export function sampleTimes(dur, k = 3) {
	const a = Math.min(0.3, dur / 2), b = Math.max(dur - 0.3, dur / 2);
	return k === 1 ? [dur / 2] : Array.from({ length: k }, (_, i) => a + ((b - a) * i) / (k - 1));
}

// Pure checks on one __qa snapshot. Returns [{level, msg}].
export function checkQa(qa, { W, H, letterbox = LETTERBOX, mid }) {
	const out = [], E = (msg) => out.push({ level: "error", msg });
	if (!qa || typeof qa !== "object") return [{ level: "error", msg: "window.__qa missing after __seek" }];
	const lb = letterbox * (H / 1080), minSize = TEXT_MIN * (H / 1080);
	const sx0 = 0.06 * W, sx1 = 0.94 * W, sy0 = lb + 0.04 * H, sy1 = H - lb - 0.04 * H;
	if (qa.blank) E("engine reports a blank frame");
	const texts = qa.texts ?? [];
	for (const t of texts) {
		const [x, y, w, h] = t.box ?? [0, 0, 0, 0], s = `"${String(t.str).slice(0, 40)}"`;
		if (lb > 0 && (y < lb || y + h > H - lb)) E(`text ${s} inside the letterbox bars (box ${t.box.map(Math.round)})`);
		else if (x < sx0 || x + w > sx1 || y < sy0 || y + h > sy1) E(`text ${s} outside the safe area (box ${t.box.map(Math.round)})`);
		if (t.size < minSize) E(`text ${s} size ${t.size}px < ${Math.round(minSize)}px`);
	}
	for (let i = 0; i < texts.length; i++)
		for (let j = i + 1; j < texts.length; j++) {
			const [ax, ay, aw, ah] = texts[i].box, [bx, by, bw, bh] = texts[j].box;
			const ix = Math.min(ax + aw, bx + bw) - Math.max(ax, bx), iy = Math.min(ay + ah, by + bh) - Math.max(ay, by);
			// ponytail: >5% of the smaller box counts as overlap, so touching line boxes are not flagged
			if (ix > 0 && iy > 0 && ix * iy > 0.05 * Math.min(aw * ah, bw * bh))
				E(`texts "${String(texts[i].str).slice(0, 30)}" and "${String(texts[j].str).slice(0, 30)}" overlap`);
		}
	// Owner rule 2026-11-16 (all styles): never overlap two or more infographics or texts, and keep every one fully
	// inside the safe area. Top-level non-actor items only (a board's own children are laid out inside it); an
	// item's box already contains its texts, so this also catches text over a chart, calendar, receipt or arrow.
	const graphics = (qa.items ?? []).filter((it) => it.type !== "actor" && it.type !== "split" && !it.scenery && it.top !== false && it.box);
	for (let i = 0; i < graphics.length; i++)
		for (let j = i + 1; j < graphics.length; j++) {
			const a = graphics[i], b = graphics[j], [ax, ay, aw, ah] = a.box, [bx, by, bw, bh] = b.box;
			const ix = Math.min(ax + aw, bx + bw) - Math.max(ax, bx), iy = Math.min(ay + ah, by + bh) - Math.max(ay, by);
			if (ix > 0 && iy > 0 && ix * iy > 0.05 * Math.min(aw * ah, bw * bh))
				E(`${a.type} "${a.id}" and ${b.type} "${b.id}" overlap (${a.box.map(Math.round)} / ${b.box.map(Math.round)})`);
		}
	if (mid)
		for (const it of graphics) {
			const [x, y, w, h] = it.box;
			if (x < sx0 - 2 || x + w > sx1 + 2 || y < sy0 - 2 || y + h > sy1 + 2) E(`${it.type} "${it.id}" not fully inside the safe area (box ${it.box.map(Math.round)})`);
		}
	if (mid)
		for (const it of qa.items ?? []) {
			if (it.type !== "actor") continue;
			const [x, y, w, h] = it.box ?? [0, 0, 0, 0];
			if (x < 0 || y < 0 || x + w > W || y + h > H) E(`actor ${it.id} cut by the frame edge (box ${it.box.map(Math.round)})`);
		}
	return out;
}

export async function qa(pkgDir, planFile, { frames = 3, out } = {}) {
	pkgDir = realpathSync(resolve(pkgDir));
	out = resolve(out ?? join(pkgDir, "..", "qa-out"));
	mkdirSync(out, { recursive: true });
	const plan = JSON.parse(readFileSync(planFile, "utf8"));
	const [W, H] = plan.resolution.split("x").map(Number);
	const tokensFile = join(pkgDir, "tokens.json");
	const tokens = existsSync(tokensFile) ? JSON.parse(readFileSync(tokensFile, "utf8")) : {};
	// letterbox: tokens.letterbox as px at 1080p (number), false/0 = none, absent = 60
	const letterbox = typeof tokens.letterbox === "number" ? tokens.letterbox : tokens.letterbox === false ? 0 : LETTERBOX;
	const midIdx = Math.floor(frames / 2);
	const issues = [];
	const add = (n, t, level, msg) => issues.push({ scene: n, t: t == null ? null : +t.toFixed(2), level, msg });

	const browser = await chromium.launch({
		args: ["--disable-gpu", "--font-render-hinting=none", "--force-color-profile=srgb", "--disable-lcd-text", "--hide-scrollbars",
			"--host-resolver-rules=MAP * ~NOTFOUND", "--disable-background-networking"],
	});
	// offline context: only file:// inside the package loads (as render.ts offlineContext)
	const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, offline: true, serviceWorkers: "block" });
	await ctx.route("**/*", async (route) => {
		const url = route.request().url();
		let ok = false;
		if (url.startsWith("file:")) try { ok = realpathSync(fileURLToPath(url)).startsWith(pkgDir + sep); } catch { /* missing file */ }
		if (!ok) add(null, null, "error", `blocked request: ${url.slice(0, 100)}`);
		await (ok ? route.continue() : route.abort("blockedbyclient"));
	});
	await ctx.routeWebSocket(/.*/, (ws) => ws.close());

	const mids = new Array(plan.scenes.length);
	let next = 0;
	const worker = async () => {
		for (let k = next++; k < plan.scenes.length; k = next++) {
			const s = plan.scenes[k], n = s.n, dur = s.duration_s;
			const page = await ctx.newPage();
			const errors = [];
			page.on("pageerror", (e) => errors.push(String(e.message ?? e)));
			page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
			const flush = (t) => { for (const e of errors.splice(0)) add(n, t, "error", `page error: ${e.slice(0, 300)}`); };
			try {
				await page.addInitScript(initScript, {
					scene: { props: s.props, tokens, duration: dur, width: W, height: H, fps: plan.fps, n, total: plan.scenes.length, narration: s.narration },
					incoming: k > 0 ? plan.scenes[k - 1].transition : "cut",
					seed: n * 7919,
				});
				await page.goto(pathToFileURL(join(pkgDir, `${s.template}.html`)).href, { waitUntil: "load" });
				await page.evaluate(async () => {
					if (window.__ready) await window.__ready;
					if (typeof window.__seek !== "function") throw new Error("template defines no window.__seek");
				});
				flush(null);
				const times = sampleTimes(dur, frames);
				for (let i = 0; i < times.length; i++) {
					const t = times[i], mid = i === midIdx;
					let snap;
					try {
						snap = await page.evaluate((t) => { window.__seek(t); return JSON.parse(JSON.stringify(window.__qa ?? null)); }, t);
					} catch (e) { add(n, t, "error", `__seek(${t.toFixed(2)}) threw: ${e.message.slice(0, 300)}`); continue; }
					flush(t);
					for (const p of checkQa(snap, { W, H, letterbox, mid })) add(n, t, p.level, p.msg);
					const file = join(out, `scene-${n}-${i}.jpg`);
					await page.screenshot({ path: file, type: "jpeg", quality: 85 });
					const spread = await lumaSpread(file);
					if (spread < LUMA_MIN) add(n, t, mid ? "error" : "warn", `flat frame: luma spread ${spread} < ${LUMA_MIN}`);
					if (mid) {
						// labelled copy for the contact sheet
						await page.evaluate((n) => {
							const d = document.createElement("div");
							d.id = "__qa_label";
							d.textContent = String(n);
							d.style.cssText = "position:fixed;left:0;top:0;z-index:2147483647;background:#000;color:#fff;font:bold 96px sans-serif;padding:8px 28px";
							document.body.appendChild(d);
						}, n);
						mids[k] = join(out, `sheet-${String(k).padStart(4, "0")}.jpg`);
						await page.screenshot({ path: mids[k], type: "jpeg", quality: 80 });
						await page.evaluate(() => document.getElementById("__qa_label")?.remove());
					}
				}
			} catch (e) {
				flush(null);
				add(n, null, "error", `scene failed to open: ${e.message.slice(0, 300)}`);
			} finally {
				await page.close().catch(() => {});
			}
		}
	};
	try {
		await Promise.all(Array.from({ length: Math.max(1, Math.min(plan.scenes.length, availableParallelism() - 1)) }, worker));
	} finally {
		await browser.close();
	}

	// contact sheet of the middle frames (renumbered gapless for the image2 pattern)
	const sheet = join(out, "contact-sheet.jpg");
	const have = mids.filter(Boolean);
	if (have.length) {
		for (const f of readdirSync(out)) if (f.startsWith("sheet-seq-")) rmSync(join(out, f)); // stale from an earlier run
		have.forEach((f, i) => renameSync(f, join(out, `sheet-seq-${String(i).padStart(4, "0")}.jpg`)));
		const cols = Math.min(8, Math.ceil(Math.sqrt(have.length)));
		await ffmpeg(["-framerate", "1", "-i", join(out, "sheet-seq-%04d.jpg"), "-vf", `scale=480:-2,tile=${cols}x${Math.ceil(have.length / cols)}:padding=4`, "-frames:v", "1", "-q:v", "4", sheet]);
	}

	issues.sort((a, b) => (a.scene ?? 0) - (b.scene ?? 0) || (a.t ?? 0) - (b.t ?? 0));
	const report = { package: pkgDir, plan: resolve(planFile), scenes: plan.scenes.length, errors: issues.filter((i) => i.level === "error").length,
		warnings: issues.filter((i) => i.level === "warn").length, issues, contactSheet: have.length ? sheet : null };
	const text = [...issues.map((i) => `${i.level === "error" ? "ERROR" : "warn "} scene ${i.scene ?? "-"}${i.t != null ? ` @${i.t}s` : ""}: ${i.msg}`),
		`${report.errors} error(s), ${report.warnings} warning(s) over ${report.scenes} scene(s)`, report.contactSheet ? `contact sheet: ${sheet}` : ""].join("\n");
	writeFileSync(join(out, "qa-report.json"), JSON.stringify(report, null, 1));
	writeFileSync(join(out, "qa-report.txt"), text + "\n");
	return { report, text };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const a = process.argv.slice(2);
	const opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a.splice(i, 2)[1] : undefined; };
	const frames = Number(opt("--frames") ?? 3), out = opt("--out");
	if (a.length < 2) { console.error("usage: qa.mjs <package-dir> <scene_plan.json> [--frames 3] [--out dir]"); process.exit(2); }
	const { report, text } = await qa(a[0], a[1], { frames, out });
	console.log(text);
	process.exit(report.errors ? 1 : 0);
}
