// flatglow style fixture: the real engine renders the example plan offline (preview frames, a short final with
// silent audio) and the templates seek deterministically. Passing this is what makes the style "ready".
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
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
const DIR = join(STYLES, "flatglow");
const OUT = join(process.env.TEST_OUT ?? join(tmpdir(), "vf-test-out"), "flatglow");
const load = async () => JSON.parse(await readFile(join(DIR, "example-plan.json"), "utf8")) as ScenePlan;

// mean luma and its spread of a JPEG, via ffmpeg signalstats
async function stats(jpeg: Buffer, file: string): Promise<{ avg: number; spread: number }> {
	const { writeFile } = await import("node:fs/promises");
	await writeFile(file, jpeg);
	const r = await run("ffmpeg", ["-hide_banner", "-i", file, "-vf", "signalstats,metadata=print", "-f", "null", "-"]);
	const g = (k: string) => Number(new RegExp(`${k}=([\\d.]+)`).exec(r.stderr)?.[1]);
	return { avg: g("YAVG"), spread: g("YMAX") - g("YMIN") };
}

test("flatglow: example plan previews (one+ frame per scene, none blank)", { timeout: 5 * 60_000 }, async () => {
	const plan = await load();
	assert.equal(plan.style, "flatglow");
	const total = plan.scenes.reduce((a, s) => a + s.duration_s, 0);
	assert.ok(total >= 10 && total <= 20, `example is ${total} s`);
	await mkdir(OUT, { recursive: true });
	const frames = await renderPreviews({ plan, stylesDir: STYLES, workDir: join(OUT, "prev"), audioPath: null, audioSeconds: total });
	assert.equal(frames.size, plan.scenes.length * 3);
	const spread = new Map<number, number>();
	for (const [name, jpeg] of frames) {
		assert.ok(jpeg.length > 4 * 1024 && jpeg.length < 500 * 1024, `${name}: ${jpeg.length} bytes`);
		const n = Number(name.split("-")[1]);
		spread.set(n, Math.max(spread.get(n) ?? 0, (await stats(jpeg, join(OUT, `${name}.jpg`))).spread));
	}
	// the first frame of a scene may be mid fade-in; at least one of its frames must show real content
	for (const s of plan.scenes) assert.ok((spread.get(s.n) ?? 0) > 120, `scene ${s.n} looks blank (luma spread ${spread.get(s.n)})`);
});

test("flatglow: short final with silent audio has the right duration", { timeout: 5 * 60_000 }, async () => {
	const ex = await load();
	const pick = (t: string) => ex.scenes.find((s) => s.template === t)!;
	const plan: ScenePlan = {
		style: "flatglow", fps: 12, resolution: "640x360",
		scenes: [
			{ ...pick("scene"), n: 1, duration_s: 2, transition: "fade" },
			{ ...pick("kinetic"), n: 2, duration_s: 2, transition: "cut" },
		],
	};
	await mkdir(OUT, { recursive: true });
	const audio = await silence(4, join(OUT, "final.wav"));
	const file = await renderFinal({ plan, stylesDir: STYLES, workDir: join(OUT, "final"), audioPath: audio.path, audioSeconds: audio.seconds });
	const d = await durationOf(file);
	assert.ok(Math.abs(d - 4) <= 0.1, `duration ${d}`);
});

test("flatglow: every template seeks deterministically (same t -> same pixels, any order)", { timeout: 3 * 60_000 }, async () => {
	const plan = await load();
	const tokens = JSON.parse(await readFile(join(DIR, "tokens.json"), "utf8"));
	const browser = await chromium.launch({ args: ["--disable-gpu", "--font-render-hinting=none", "--disable-lcd-text"] });
	try {
		for (const s of plan.scenes) {
			const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
			const errors: string[] = [];
			page.on("pageerror", (e) => errors.push(String(e)));
			await page.addInitScript((scene) => {
				// @ts-ignore browser context
				window.__scene = scene;
			}, { props: s.props, tokens, duration: s.duration_s, width: 480, height: 270, fps: 30, n: s.n, total: plan.scenes.length, narration: s.narration });
			await page.goto(pathToFileURL(join(DIR, `${s.template}.html`)).href);
			// @ts-ignore browser context
			await page.evaluate(() => window.__ready);
			// @ts-ignore browser context
			const at = (t: number) => page.evaluate((t) => (window.__seek(t), (document.getElementById("c") as HTMLCanvasElement).toDataURL()), t);
			const a = await at(1.3);
			await at(0.1);
			await at(s.duration_s - 0.05);
			assert.equal(await at(1.3), a, `${s.template}: frame at 1.3 s changed after other seeks`);
			assert.deepEqual(errors, [], `${s.template}: ${errors.join("; ")}`);
			await page.close();
		}
	} finally {
		await browser.close();
	}
});
