// Offline fixture for the flat2d engine (engines/flat2d) through the real render engine: the gta example is built
// into a temp stylesDir as style "custom", then previews (every scene non-blank), a short final render with a
// silent track (correct duration), and seek determinism.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
const ENGINE = fileURLToPath(new URL("../../engines/flat2d", import.meta.url));
const STYLES = await mkdtemp(join(tmpdir(), "flat2d-styles-"));
const PKG = join(STYLES, "custom");
const PLAN = join(STYLES, "scene_plan.json");
execFileSync("node", [join(ENGINE, "tools/build-package.mjs"), join(ENGINE, "examples/gta/video.json"), join(ENGINE, "examples/gta/scenes.json"), PKG, "--plan", PLAN]);
const plan = JSON.parse(await readFile(PLAN, "utf8")) as ScenePlan;
const OUT = join(process.env.TEST_OUT ?? join(tmpdir(), "vf-test-out"), "engine-flat2d");
const total = (p: ScenePlan) => p.scenes.reduce((a, s) => a + s.duration_s, 0);

async function lumaSpread(file: string): Promise<number> {
	const r = await run("ffmpeg", ["-hide_banner", "-i", file, "-vf", "signalstats,metadata=print", "-f", "null", "-"]);
	return Number(/YHIGH=([\d.]+)/.exec(r.stderr)?.[1]) - Number(/YLOW=([\d.]+)/.exec(r.stderr)?.[1]);
}

test("flat2d: example package packs under 8 MiB", () => {
	const r = JSON.parse(execFileSync("node", [fileURLToPath(new URL("../../scripts/pack-style.mjs", import.meta.url)), PKG, PLAN], { encoding: "utf8" }));
	assert.ok(r.bytes < 8 * 1024 * 1024, `package ${r.bytes} bytes`);
	assert.equal(plan.style, "custom");
	assert.ok(plan.scenes.every((s) => s.template === "scene"));
});

test("flat2d: example previews, every scene drawn", { timeout: 5 * 60_000 }, async () => {
	await mkdir(OUT, { recursive: true });
	const frames = await renderPreviews({ plan, stylesDir: STYLES, workDir: join(OUT, "prev"), audioPath: null, audioSeconds: total(plan) });
	for (const s of plan.scenes) {
		for (const i of [0, 1, 2]) {
			const jpg = frames.get(`scene-${s.n}-${i}`);
			assert.ok(jpg, `scene ${s.n} preview ${i} missing`);
			const f = join(OUT, `scene-${s.n}-${i}.jpg`);
			await writeFile(f, jpg);
			const spread = await lumaSpread(f);
			assert.ok(spread > 20, `scene ${s.n} preview ${i} looks blank/uniform: luma spread ${spread}`);
		}
	}
	assert.equal(frames.size, plan.scenes.length * 3);
});

test("flat2d: ~4 s final render with silent audio has the right duration", { timeout: 10 * 60_000 }, async () => {
	const short: ScenePlan = { ...plan, fps: 24, scenes: plan.scenes.slice(0, 2).map((s) => ({ ...s, duration_s: 2 })) };
	await mkdir(OUT, { recursive: true });
	const audio = await silence(4, join(OUT, "silence.wav"));
	const file = await renderFinal({ plan: short, stylesDir: STYLES, workDir: join(OUT, "final"), audioPath: audio.path, audioSeconds: audio.seconds });
	const d = await durationOf(file);
	assert.ok(Math.abs(d - 4) <= 0.1, `duration ${d}`);
});

test("flat2d: __seek is pure and fills __qa (same t twice is byte-identical)", { timeout: 3 * 60_000 }, async () => {
	const tokens = JSON.parse(await readFile(join(PKG, "tokens.json"), "utf8"));
	const browser = await chromium.launch({ args: ["--disable-gpu", "--font-render-hinting=none", "--disable-lcd-text"] });
	try {
		for (const s of plan.scenes) {
			const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
			const errors: string[] = [];
			page.on("pageerror", (e) => errors.push(String(e)));
			page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
			await page.addInitScript((scene) => {
				// @ts-ignore browser context
				window.__scene = scene;
			}, { props: s.props, tokens, duration: s.duration_s, width: 1920, height: 1080, fps: 30, n: s.n, total: plan.scenes.length, narration: "" });
			await page.goto(pathToFileURL(join(PKG, "scene.html")).href);
			const t = s.duration_s * 0.6;
			// @ts-ignore browser context
			const qa = await page.evaluate(async (t) => { await window.__ready; window.__seek(t); return window.__qa; }, t);
			const a = await page.screenshot({ type: "png" });
			// @ts-ignore browser context
			await page.evaluate((t) => { window.__seek(0.1); window.__seek(t * 1.5); window.__seek(t); }, t);
			const b = await page.screenshot({ type: "png" });
			assert.deepEqual(errors, [], `scene ${s.n}: ${errors.join("\n")}`);
			assert.ok(a.equals(b), `scene ${s.n}: frame at ${t} s differs between seeks`);
			assert.ok(qa && Array.isArray(qa.texts) && Array.isArray(qa.items) && qa.blank === false, `scene ${s.n}: __qa ${JSON.stringify(qa)?.slice(0, 200)}`);
			await page.close();
		}
	} finally {
		await browser.close();
	}
});

test("flat2d: unknown ids throw a clear error naming the item", { timeout: 60_000 }, async () => {
	const tokens = JSON.parse(await readFile(join(PKG, "tokens.json"), "utf8"));
	const s = plan.scenes[1];
	const bad = { ...s.props, spec: { ...(s.props.spec as object), items: [{ id: "ghost", type: "actor", cast: "nobody", at: [960, 900] }] } };
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
		const errors: string[] = [];
		page.on("pageerror", (e) => errors.push(String(e)));
		// @ts-ignore browser context
		await page.addInitScript((scene) => { window.__scene = scene; }, { props: bad, tokens, duration: 3, width: 1920, height: 1080, fps: 30, n: 2, total: 1, narration: "" });
		await page.goto(pathToFileURL(join(PKG, "scene.html")).href);
		assert.match(errors.join("\n"), /item "ghost" \(actor\): unknown cast "nobody"/);
		await page.close();
	} finally {
		await browser.close();
	}
});
