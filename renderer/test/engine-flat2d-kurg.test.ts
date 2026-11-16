// The flat2d engine's kurg look (engines/flat2d/looks/kurg.*: blob bodies, glow/shade parts, atmosphere, bloom)
// through the real render engine: the kurg example is built as style "custom", every scene previews non-blank,
// and __seek is pure with no page errors. The gta example and the final render are covered by engine-flat2d.test.ts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import type { ScenePlan } from "../../packages/contract/src/index.ts";
import { run } from "../engine/ffmpeg.ts";
import { renderPreviews } from "../engine/render.ts";

process.env.FORCE_X264 = "1";
const ENGINE = fileURLToPath(new URL("../../engines/flat2d", import.meta.url));
const STYLES = await mkdtemp(join(tmpdir(), "flat2d-kurg-"));
const PKG = join(STYLES, "custom");
const PLAN = join(STYLES, "scene_plan.json");
execFileSync("node", [join(ENGINE, "tools/build-package.mjs"), join(ENGINE, "examples/kurg/video.json"), join(ENGINE, "examples/kurg/scenes.json"), PKG, "--plan", PLAN]);
const plan = JSON.parse(await readFile(PLAN, "utf8")) as ScenePlan;
const OUT = join(process.env.TEST_OUT ?? join(tmpdir(), "vf-test-out"), "engine-flat2d-kurg");

async function lumaSpread(file: string): Promise<number> {
	const r = await run("ffmpeg", ["-hide_banner", "-i", file, "-vf", "signalstats,metadata=print", "-f", "null", "-"]);
	return Number(/YHIGH=([\d.]+)/.exec(r.stderr)?.[1]) - Number(/YLOW=([\d.]+)/.exec(r.stderr)?.[1]);
}

test("flat2d kurg: example packs under 8 MiB", () => {
	const r = JSON.parse(execFileSync("node", [fileURLToPath(new URL("../../scripts/pack-style.mjs", import.meta.url)), PKG, PLAN], { encoding: "utf8" }));
	assert.ok(r.bytes < 8 * 1024 * 1024, `package ${r.bytes} bytes`);
	assert.ok(plan.scenes.every((s) => s.template === "scene"));
});

test("flat2d kurg: example previews, every scene drawn", { timeout: 5 * 60_000 }, async () => {
	await mkdir(OUT, { recursive: true });
	const total = plan.scenes.reduce((a, s) => a + s.duration_s, 0);
	const frames = await renderPreviews({ plan, stylesDir: STYLES, workDir: join(OUT, "prev"), audioPath: null, audioSeconds: total });
	for (const s of plan.scenes)
		for (const i of [0, 1, 2]) {
			const jpg = frames.get(`scene-${s.n}-${i}`);
			assert.ok(jpg, `scene ${s.n} preview ${i} missing`);
			const f = join(OUT, `scene-${s.n}-${i}.jpg`);
			await writeFile(f, jpg);
			const spread = await lumaSpread(f);
			assert.ok(spread > 20, `scene ${s.n} preview ${i} looks blank/uniform: luma spread ${spread}`);
		}
});

test("flat2d kurg: __seek is pure, no page errors, __qa filled", { timeout: 3 * 60_000 }, async () => {
	const tokens = JSON.parse(await readFile(join(PKG, "tokens.json"), "utf8"));
	const browser = await chromium.launch({ args: ["--disable-gpu", "--font-render-hinting=none", "--disable-lcd-text"] });
	try {
		for (const s of plan.scenes) {
			const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
			const errors: string[] = [];
			page.on("pageerror", (e) => errors.push(String(e)));
			page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
			// @ts-ignore browser context
			await page.addInitScript((scene) => { window.__scene = scene; }, { props: s.props, tokens, duration: s.duration_s, width: 1920, height: 1080, fps: 30, n: s.n, total: plan.scenes.length, narration: "" });
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
			assert.ok(qa && qa.blank === false && qa.items.length > 0, `scene ${s.n}: __qa ${JSON.stringify(qa)?.slice(0, 200)}`);
			await page.close();
		}
	} finally {
		await browser.close();
	}
});
