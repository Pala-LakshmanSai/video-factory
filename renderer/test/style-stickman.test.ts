// Offline fixture for the `stickman` style through the real engine: previews of example-plan.json (non-blank,
// non-uniform), a short final render with a silent track (correct duration), and seek determinism.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import type { ScenePlan } from "../../packages/contract/src/index.ts";
import { durationOf, run } from "../engine/ffmpeg.ts";
import { renderFinal, renderPreviews } from "../engine/render.ts";
import { silence } from "../engine/voice.ts";

process.env.FORCE_X264 = "1";
const STYLES = fileURLToPath(new URL("../styles", import.meta.url));
const DIR = join(STYLES, "stickman");
const OUT = join(process.env.TEST_OUT ?? join(tmpdir(), "vf-test-out"), "stickman");
const plan = JSON.parse(await readFile(join(DIR, "example-plan.json"), "utf8")) as ScenePlan;
const total = (p: ScenePlan) => p.scenes.reduce((a, s) => a + s.duration_s, 0);

// luma spread of a JPEG: YHIGH - YLOW (10th..90th percentile); a blank or flat frame is ~0
async function lumaSpread(file: string): Promise<number> {
	const r = await run("ffmpeg", ["-hide_banner", "-i", file, "-vf", "signalstats,metadata=print", "-f", "null", "-"]);
	const lo = Number(/YLOW=([\d.]+)/.exec(r.stderr)?.[1]);
	const hi = Number(/YHIGH=([\d.]+)/.exec(r.stderr)?.[1]);
	return hi - lo;
}

test("stickman: example plan previews, every scene drawn", { timeout: 5 * 60_000 }, async () => {
	await mkdir(OUT, { recursive: true });
	const frames = await renderPreviews({ plan, stylesDir: STYLES, workDir: join(OUT, "prev"), audioPath: null, audioSeconds: total(plan) });
	for (const s of plan.scenes) {
		const mid = frames.get(`scene-${s.n}-1`);
		assert.ok(mid, `scene ${s.n} has no preview`);
		const f = join(OUT, `scene-${s.n}-1.jpg`);
		await writeFile(f, mid);
		const spread = await lumaSpread(f);
		assert.ok(spread > 20, `scene ${s.n} (${s.template}) looks blank/uniform: luma spread ${spread}`);
	}
	assert.equal(frames.size, plan.scenes.length * 3);
});

test("stickman: ~4 s final render with silent audio has the right duration", { timeout: 10 * 60_000 }, async () => {
	const short: ScenePlan = {
		style: "stickman", fps: 24, resolution: "1920x1080",
		scenes: [
			{ n: 1, template: "title", props: { word: "FLY?" }, duration_s: 2, narration: "", transition: "cut" },
			{ n: 2, template: "number", props: { value: "11 km", label: "AIRLINERS" }, duration_s: 2, narration: "", transition: "fade" },
		],
	};
	await mkdir(OUT, { recursive: true });
	const audio = await silence(4, join(OUT, "silence.wav"));
	const file = await renderFinal({ plan: short, stylesDir: STYLES, workDir: join(OUT, "final"), audioPath: audio.path, audioSeconds: audio.seconds });
	const d = await durationOf(file);
	assert.ok(Math.abs(d - 4) <= 0.1, `duration ${d}`);
});

test("stickman: __seek is pure (same t twice is byte-identical, across templates)", { timeout: 2 * 60_000 }, async () => {
	const tokens = JSON.parse(await readFile(join(DIR, "tokens.json"), "utf8"));
	const browser = await chromium.launch({ args: ["--disable-gpu", "--font-render-hinting=none", "--disable-lcd-text"] });
	try {
		for (const s of plan.scenes.filter((s, i, a) => a.findIndex((o) => o.template === s.template) === i)) {
			const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
			const errors: string[] = [];
			page.on("pageerror", (e) => errors.push(String(e)));
			await page.addInitScript((scene) => {
				// @ts-ignore browser context
				window.__scene = scene;
			}, { props: s.props, tokens, duration: s.duration_s, width: 1920, height: 1080, fps: 24, n: s.n, total: 1, narration: "" });
			await page.goto(pathToFileURL(join(DIR, `${s.template}.html`)).href);
			// @ts-ignore browser context
			await page.evaluate(async () => { await window.__ready; window.__seek(1.3); });
			const a = await page.screenshot({ type: "png" });
			// @ts-ignore browser context
			await page.evaluate(() => { window.__seek(0.2); window.__seek(2.4); window.__seek(1.3); });
			const b = await page.screenshot({ type: "png" });
			assert.deepEqual(errors, [], `${s.template}: ${errors.join("\n")}`);
			assert.ok(a.equals(b), `${s.template}: frame at 1.3 s differs between seeks`);
			await page.close();
		}
	} finally {
		await browser.close();
	}
});
