// blockworld (3D WebGL) through the real engine: previews per scene, a short silent final, seek determinism,
// and a hard failure when the episode prop is missing. WebGL runs on SwiftShader under the engine's --disable-gpu.
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ScenePlan } from "../../packages/contract/src/index.ts";
import { durationOf, run } from "../engine/ffmpeg.ts";
import { renderFinal, renderPreviews, TemplateError } from "../engine/render.ts";
import { silence } from "../engine/voice.ts";

process.env.FORCE_X264 = "1";
const STYLES = fileURLToPath(new URL("../styles", import.meta.url));
const OUT = join(process.env.TEST_OUT ?? join(tmpdir(), "vf-test-out"), "blockworld");
const example = async () => JSON.parse(await readFile(join(STYLES, "blockworld", "example-plan.json"), "utf8")) as ScenePlan;
const secs = (p: ScenePlan) => p.scenes.reduce((a, s) => a + s.duration_s, 0);

async function lumaStd(jpeg: Buffer, file: string): Promise<number> {
	await mkdir(OUT, { recursive: true });
	const { writeFile } = await import("node:fs/promises");
	await writeFile(file, jpeg);
	const r = await run("ffmpeg", ["-hide_banner", "-i", file, "-vf", "format=gray,signalstats,metadata=print", "-f", "null", "-"]);
	const lo = Number(/YLOW=([\d.]+)/.exec(r.stderr)![1]), hi = Number(/YHIGH=([\d.]+)/.exec(r.stderr)![1]);
	return hi - lo; // 10th..90th percentile spread; a blank frame is ~0
}

test("blockworld previews: every scene renders non-blank, seek is deterministic", { timeout: 10 * 60_000 }, async () => {
	const plan = await example();
	const inp = { plan, stylesDir: STYLES, workDir: OUT, audioPath: null, audioSeconds: secs(plan) };
	const a = await renderPreviews(inp);
	assert.equal(a.size, plan.scenes.length * 3);
	for (const s of plan.scenes) {
		const spread = await lumaStd(a.get(`scene-${s.n}-1`)!, join(OUT, `scene-${s.n}-1.jpg`));
		assert.ok(spread > 20, `scene ${s.n} looks blank (luma spread ${spread})`);
	}
	const b = await renderPreviews(inp, [2]);
	for (let i = 0; i < 3; i++) assert.ok(b.get(`scene-2-${i}`)!.equals(a.get(`scene-2-${i}`)!), `scene-2-${i} differs between runs`);
});

test("blockworld final: 4 s silent render lasts 4 s", { timeout: 15 * 60_000 }, async () => {
	const ex = await example();
	const plan: ScenePlan = { ...ex, scenes: ex.scenes.slice(0, 2).map((s) => ({ ...s, duration_s: 2 })) };
	const audio = await silence(4, join(tmpdir(), "vf-blockworld-4s.wav"));
	const file = await renderFinal({ plan, stylesDir: STYLES, workDir: join(OUT, "final"), audioPath: audio.path, audioSeconds: audio.seconds });
	const d = await durationOf(file);
	assert.ok(Math.abs(d - 4) <= 0.1, `duration ${d}`);
});

test("blockworld: missing or malformed episode prop fails the scene", { timeout: 5 * 60_000 }, async () => {
	const ex = await example();
	for (const props of [{}, { episode: { scenes: [] } }, { episode: { scenes: [{ set: "room" }] } }]) {
		const plan: ScenePlan = { ...ex, scenes: [{ ...ex.scenes[0], props }] };
		await assert.rejects(
			renderPreviews({ plan, stylesDir: STYLES, workDir: OUT, audioPath: null, audioSeconds: 4 }),
			(e) => e instanceof TemplateError && /blockworld: /.test(e.logTail),
		);
	}
});
