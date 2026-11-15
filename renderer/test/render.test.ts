// Prompt 6a/6b: (1) the 60 s standard test video renders on CPU and lasts 60 s ± 0.1 s;
// (2) golden test: each style's example plan previews match committed reference JPEGs (SSIM >= 0.95).
// References live in test/golden/<style>/. Missing ones are written to test/out/golden/ and the test is
// skipped for that frame: commit them from a Linux run (CI uploads test/out as an artifact on failure,
// or run with GOLDEN_WRITE=1 to write straight into test/golden/). Fonts differ between macOS and Linux,
// so references must come from the same OS + font set as CI (ubuntu-24.04 + the apt fonts in renderer.yml).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ScenePlan } from "../../packages/contract/src/index.ts";
import { STYLE_TEMPLATES } from "../../packages/contract/src/styles.ts";
import { durationOf, run } from "../engine/ffmpeg.ts";
import { renderFinal, renderPreviews, renderWorkerCount } from "../engine/render.ts";
import { silence } from "../engine/voice.ts";

process.env.FORCE_X264 = "1";
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const STYLES = here("../styles");
const OUT = process.env.TEST_OUT ?? join(tmpdir(), "vf-test-out");
const total = (p: ScenePlan) => p.scenes.reduce((a, s) => a + s.duration_s, 0);

test("NVENC worker cap preserves lower overrides and CPU parallelism", () => {
	assert.equal(renderWorkerCount(32, 45, "h264_nvenc"), 4);
	assert.equal(renderWorkerCount(2, 45, "h264_nvenc"), 2);
	assert.equal(renderWorkerCount(32, 1, "h264_nvenc"), 1);
	assert.equal(renderWorkerCount(32, 45, "libx264"), 32);
	assert.equal(renderWorkerCount(32, 2, "libx264"), 2);
});

test("every style ships every template listed in packages/contract/src/styles.ts", async () => {
	for (const [style, templates] of Object.entries(STYLE_TEMPLATES)) {
		const files = await readdir(join(STYLES, style));
		for (const t of templates) assert.ok(files.includes(`${t}.html`), `${style}/${t}.html missing`);
		assert.ok(files.includes("tokens.json"), `${style}/tokens.json missing`);
	}
});

test("bench/plan-60s.json renders on CPU to 60 s ± 0.1 s", { timeout: 20 * 60_000 }, async () => {
	const plan = JSON.parse(await readFile(here("../../bench/plan-60s.json"), "utf8")) as ScenePlan;
	await mkdir(OUT, { recursive: true });
	const audio = await silence(total(plan), join(OUT, "bench.wav"));
	const t0 = performance.now();
	const file = await renderFinal({ plan, stylesDir: STYLES, workDir: join(OUT, "bench"), audioPath: audio.path, audioSeconds: audio.seconds });
	console.log(`60 s bench rendered in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
	const d = await durationOf(file);
	assert.ok(Math.abs(d - 60) <= 0.1, `duration ${d}`);
});

async function ssim(a: string, b: string): Promise<number> {
	const r = await run("ffmpeg", ["-hide_banner", "-i", a, "-i", b, "-lavfi", "[0:v][1:v]scale2ref[x][y];[x][y]ssim", "-f", "null", "-"]);
	const m = /All:([\d.]+)/.exec(r.stderr);
	if (!m) throw new Error(r.stderr.slice(-500));
	return Number(m[1]);
}

for (const style of Object.keys(STYLE_TEMPLATES)) {
	test(`golden previews: ${style}`, { timeout: 5 * 60_000 }, async (t) => {
		const plan = JSON.parse(await readFile(join(STYLES, style, "example-plan.json"), "utf8")) as ScenePlan;
		const frames = await renderPreviews({ plan, stylesDir: STYLES, workDir: join(OUT, style), audioPath: null, audioSeconds: total(plan) });
		assert.equal(frames.size, plan.scenes.length * 3);
		const goldenDir = here(`./golden/${style}`);
		const outDir = join(OUT, "golden", style);
		await mkdir(outDir, { recursive: true });
		if (process.env.GOLDEN_WRITE === "1") await mkdir(goldenDir, { recursive: true });
		let missing = 0;
		for (const [name, jpeg] of frames) {
			assert.ok(jpeg.length < 500 * 1024, `${name} is ${jpeg.length} bytes`);
			const out = join(outDir, `${name}.jpg`);
			await writeFile(out, jpeg);
			const ref = join(goldenDir, `${name}.jpg`);
			if (process.env.GOLDEN_WRITE === "1") await writeFile(ref, jpeg);
			if (!existsSync(ref)) {
				missing++;
				continue;
			}
			const s = await ssim(out, ref);
			assert.ok(s >= 0.95, `${style} ${name}: SSIM ${s.toFixed(3)} < 0.95 (new frame in ${out})`);
		}
		if (missing) t.skip(`${missing} reference frames missing; candidates written to ${outDir}`);
	});
}

test("fade and slide joins never dip to black (style background, not #000)", { timeout: 5 * 60_000 }, async () => {
	const props = JSON.parse(await readFile(join(STYLES, "explainer", "example-plan.json"), "utf8")) as ScenePlan;
	const pick = (t: string) => props.scenes.find((s) => s.template === t)!.props;
	const plan: ScenePlan = {
		style: "explainer", fps: 12, resolution: "640x360",
		scenes: [
			{ n: 1, template: "title", props: pick("title"), duration_s: 2, narration: "", transition: "fade" },
			{ n: 2, template: "kinetic-text", props: pick("kinetic-text"), duration_s: 2, narration: "", transition: "slide" },
			{ n: 3, template: "list", props: pick("list"), duration_s: 2, narration: "", transition: "cut" },
		],
	};
	await mkdir(OUT, { recursive: true });
	const audio = await silence(6, join(OUT, "joins.wav"));
	const file = await renderFinal({ plan, stylesDir: STYLES, workDir: join(OUT, "joins"), audioPath: audio.path, audioSeconds: audio.seconds });
	const r = await run("ffmpeg", ["-hide_banner", "-i", file, "-vf", "signalstats,metadata=print:key=lavfi.signalstats.YAVG", "-f", "null", "-"]);
	const luma = [...r.stderr.matchAll(/YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
	assert.equal(luma.length, 72, "one value per frame");
	// Explainer's background is #f6f4ef (luma ~240); a black transition frame reads ~16.
	assert.ok(Math.min(...luma) > 150, `darkest frame luma ${Math.min(...luma).toFixed(1)} (frame ${luma.indexOf(Math.min(...luma))})`);
});
