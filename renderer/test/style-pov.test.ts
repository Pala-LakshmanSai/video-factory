// pov style fixture through the REAL engine (its own Chromium launch flags, incl. --disable-gpu: WebGL runs on
// SwiftShader). Previews: a frame per scene, non-blank. Final: a ~4 s silent render (x264), duration checked.
// Seek determinism: the same frame from two fresh pages is byte-identical.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ScenePlan } from "../../packages/contract/src/index.ts";
import { durationOf, run } from "../engine/ffmpeg.ts";
import { renderFinal, renderPreviews } from "../engine/render.ts";
import { silence } from "../engine/voice.ts";

process.env.FORCE_X264 = "1";
const STYLES = fileURLToPath(new URL("../styles", import.meta.url));
const OUT = join(process.env.TEST_OUT ?? join(tmpdir(), "vf-test-out"), "pov");
const total = (p: ScenePlan) => p.scenes.reduce((a, s) => a + s.duration_s, 0);
const loadPlan = async () => JSON.parse(await readFile(join(STYLES, "pov", "example-plan.json"), "utf8")) as ScenePlan;

/** 10th..90th percentile luma spread of a JPEG (0 for a flat frame). */
async function spread(jpeg: Buffer): Promise<number> {
	const src = new PassThrough();
	src.end(jpeg);
	const r = await run("ffmpeg", ["-hide_banner", "-f", "image2pipe", "-i", "-", "-vf", "signalstats,metadata=print", "-f", "null", "-"], src);
	const g = (k: string) => Number(new RegExp(`${k}=([\\d.]+)`).exec(r.stderr)?.[1] ?? NaN);
	return g("YHIGH") - g("YLOW");
}

test("pov previews: every scene renders a non-blank WebGL frame under the engine flags", { timeout: 10 * 60_000 }, async () => {
	const plan = await loadPlan();
	await mkdir(OUT, { recursive: true });
	const t0 = performance.now();
	const frames = await renderPreviews({ plan, stylesDir: STYLES, workDir: OUT, audioPath: null, audioSeconds: total(plan) });
	console.log(`pov previews: ${frames.size} frames in ${((performance.now() - t0) / 1000).toFixed(1)} s (incl. page + world setup per scene)`);
	assert.equal(frames.size, plan.scenes.length * 3);
	for (const [name, jpeg] of frames) await writeFile(join(OUT, `${name}.jpg`), jpeg);
	for (const s of plan.scenes) {
		// the end-card white-out legitimately ends flat (cream, then black): require detail in at least one key frame
		const sp = Math.max(...(await Promise.all([0, 1, 2].map((i) => spread(frames.get(`scene-${s.n}-${i}`)!)))));
		assert.ok(sp > 20, `scene ${s.n} (${s.template}) looks blank: best luma spread ${sp}`);
	}
});

test("pov seek determinism: the same frame from two fresh pages is byte-identical", { timeout: 5 * 60_000 }, async () => {
	const plan = await loadPlan();
	const inp = { plan, stylesDir: STYLES, workDir: OUT, audioPath: null, audioSeconds: total(plan) };
	const a = await renderPreviews(inp, [3]);
	const b = await renderPreviews(inp, [3]);
	for (const [k, v] of a) assert.ok(v.equals(b.get(k)!), `${k} differs between runs`);
});

test("pov final: ~4 s silent render at 1920x1080 lasts 4 s", { timeout: 20 * 60_000 }, async () => {
	const ex = await loadPlan();
	const plan: ScenePlan = { ...ex, scenes: [{ ...ex.scenes[1], n: 1, duration_s: 2, transition: "fade" }, { ...ex.scenes[3], n: 2, duration_s: 2, transition: "cut" }] };
	await mkdir(OUT, { recursive: true });
	const audio = await silence(4, join(OUT, "silent.wav"));
	const t0 = performance.now();
	const file = await renderFinal({ plan, stylesDir: STYLES, workDir: join(OUT, "final"), audioPath: audio.path, audioSeconds: audio.seconds });
	const ms = performance.now() - t0;
	console.log(`pov final: ${plan.fps * 4} frames in ${(ms / 1000).toFixed(1)} s wall = ${(ms / (plan.fps * 4)).toFixed(0)} ms/frame wall (workers=${process.env.RENDER_WORKERS ?? "auto"})`);
	const d = await durationOf(file);
	assert.ok(Math.abs(d - 4) <= 0.1, `duration ${d}`);
});
