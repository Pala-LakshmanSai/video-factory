// Offline fixture for the `discovery` style through the real engine: previews of every scene of
// example-plan.json are not blank, a short final render has the right duration, and seeking is deterministic.
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ScenePlan } from "../../packages/contract/src/index.ts";
import { durationOf, run } from "../engine/ffmpeg.ts";
import { renderFinal, renderPreviews } from "../engine/render.ts";
import { silence } from "../engine/voice.ts";

process.env.FORCE_X264 = "1";
const STYLES = fileURLToPath(new URL("../styles", import.meta.url));
const OUT = join(process.env.TEST_OUT ?? join(tmpdir(), "vf-test-out"), "discovery");
const TEMPLATES = ["title", "chapter", "photo", "map", "compare", "quote", "end"];
const load = async () => JSON.parse(await readFile(join(STYLES, "discovery", "example-plan.json"), "utf8")) as ScenePlan;
const total = (p: ScenePlan) => p.scenes.reduce((a, s) => a + s.duration_s, 0);

// luma range of a jpeg: a blank or uniform frame has YMAX - YMIN near 0
async function lumaRange(file: string): Promise<number> {
	const r = await run("ffmpeg", ["-hide_banner", "-i", file, "-vf", "signalstats,metadata=print", "-f", "null", "-"]);
	const g = (k: string) => Number(new RegExp(`lavfi\\.signalstats\\.${k}=([\\d.]+)`).exec(r.stderr)?.[1]);
	return g("YMAX") - g("YMIN");
}

test("discovery ships its templates and a valid example plan", async () => {
	const files = await readdir(join(STYLES, "discovery"));
	for (const t of [...TEMPLATES.map((t) => `${t}.html`), "tokens.json", "discovery.js"]) assert.ok(files.includes(t), `${t} missing`);
	const plan = await load();
	assert.equal(plan.style, "discovery");
	assert.ok(plan.fps >= 12 && plan.fps <= 60 && total(plan) <= 180);
	plan.scenes.forEach((s, i) => {
		assert.equal(s.n, i + 1);
		assert.ok(TEMPLATES.includes(s.template), s.template);
		assert.ok(["cut", "fade", "slide"].includes(s.transition), s.transition);
	});
	assert.deepEqual([...new Set(plan.scenes.map((s) => s.template))].sort(), [...TEMPLATES].sort(), "example uses every template");
});

test("discovery previews: one non-uniform frame per scene", { timeout: 5 * 60_000 }, async () => {
	const plan = await load();
	const frames = await renderPreviews({ plan, stylesDir: STYLES, workDir: join(OUT, "previews"), audioPath: null, audioSeconds: total(plan) });
	assert.equal(frames.size, plan.scenes.length * 3);
	await mkdir(OUT, { recursive: true });
	for (const s of plan.scenes) {
		const f = join(OUT, `scene-${s.n}-1.jpg`);
		await writeFile(f, frames.get(`scene-${s.n}-1`)!);
		const range = await lumaRange(f);
		assert.ok(range > 40, `scene ${s.n} (${s.template}) looks blank: luma range ${range}`);
	}
});

test("discovery seek is deterministic (same frame twice is byte-identical)", { timeout: 5 * 60_000 }, async () => {
	const plan = await load();
	const inp = { plan, stylesDir: STYLES, workDir: join(OUT, "det"), audioPath: null, audioSeconds: total(plan) };
	const a = await renderPreviews(inp, [3, 4]);
	const b = await renderPreviews(inp, [3, 4]);
	assert.equal(a.size, 6);
	for (const [k, v] of a) assert.ok(v.equals(b.get(k)!), `${k} differs between runs`);
});

test("discovery final: 4 s plan renders to 4 s ± 0.1 s", { timeout: 10 * 60_000 }, async () => {
	const ex = await load();
	const pick = (t: string) => ex.scenes.find((s) => s.template === t)!.props;
	const plan: ScenePlan = {
		style: "discovery", fps: 12, resolution: "640x360",
		scenes: [
			{ n: 1, template: "title", props: pick("title"), duration_s: 1.5, narration: "", transition: "fade" },
			{ n: 2, template: "photo", props: pick("photo"), duration_s: 1.5, narration: "", transition: "slide" },
			{ n: 3, template: "map", props: pick("map"), duration_s: 1, narration: "", transition: "cut" },
		],
	};
	await mkdir(OUT, { recursive: true });
	const audio = await silence(4, join(OUT, "final.wav"));
	const file = await renderFinal({ plan, stylesDir: STYLES, workDir: join(OUT, "final"), audioPath: audio.path, audioSeconds: audio.seconds });
	const d = await durationOf(file);
	assert.ok(Math.abs(d - 4) <= 0.1, `duration ${d}`);
});
