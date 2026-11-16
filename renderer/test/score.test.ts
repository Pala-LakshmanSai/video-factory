import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SpecOut } from "../../packages/contract/src/index.ts";
import { assertMatches, episodeSeconds, episodeSha, Scores, type Runner } from "../agent/score.ts";
import { timeScenes } from "../engine/timing.ts";
import { silence } from "../engine/voice.ts";

/** Caption-led episode spec: every scene carries the same episode, duration_s = dur (as the control plane enforces). */
function spec(durs: number[]): SpecOut {
	const episode = {
		meta: { title: "t", voiceover: null },
		scenes: durs.map((dur, i) => ({ id: `s${i}`, dur, captions: [{ t: 0.2, d: dur - 0.4, text: `Scene ${i}` }], ...(i === 0 ? { music: "whimsical", hit: true, sfx: [{ t: 0.5, name: "sparkle" }] } : {}) })),
	};
	return {
		style: "blockworld", fps: 30, resolution: "1920x1080", voiceover: { none: true },
		scenes: durs.map((dur, i) => ({ n: i + 1, template: "episode", props: { episode }, duration_s: dur, narration: "", transition: "cut" })),
	} as SpecOut;
}

/** Stub scorer: a silent WAV exactly as long as the plan file's episode (stands in for kit audio.py). */
const calls: string[] = [];
const stub: Runner = async (planFile, out) => {
	const p = JSON.parse(await readFile(planFile, "utf8")) as SpecOut;
	calls.push(planFile);
	await silence(episodeSeconds(p), out);
};

test("a timing revise re-scores; preview timing and final audio both equal the new episode length", async () => {
	const sc = new Scores(await mkdtemp(join(tmpdir(), "score-")), null, stub);
	const a = spec([2.25, 2.75]);
	const sa = await sc.forFinal(a);
	assert.equal(sa.seconds, 5);
	const b = spec([2.25, 3.75]); // revise_scene changed scene 2's dur (control plane updated every copy)
	assert.notEqual(episodeSha(b), episodeSha(a));
	const preview = timeScenes(b.scenes, episodeSeconds(b), b.fps);
	assert.equal(preview.reduce((x, t) => x + t.frames, 0), 6 * 30);
	assert.deepEqual(preview.map((t) => t.frames), [68, 112]); // identity rescale (67.5 -> 68 whole frames)
	const sb = await sc.forFinal(b);
	assert.equal(sb.seconds, 6);
	assert.notEqual(sb.path, sa.path);
	assert.equal(calls.length, 2);
	await sc.forFinal(b); // same episode: cached, not re-scored
	assert.equal(calls.length, 2);
});

test("a stale or wrong-length score is never accepted for the final mux", async () => {
	const sc = new Scores(await mkdtemp(join(tmpdir(), "score-")), null, stub);
	const old = await sc.get(spec([2.25, 2.75]));
	assert.throws(() => assertMatches(old, spec([2.25, 3.75])), /stale score/);
	assert.throws(() => assertMatches({ ...old, seconds: 4.5 }, spec([2.25, 2.75])), /score is 4\.500 s, episode is 5\.000 s/);
	const fresh = await sc.forFinal(spec([2.25, 3.75]));
	assert.equal(fresh.sha, episodeSha(spec([2.25, 3.75])));
});

test("a failed score is not cached", async () => {
	let n = 0;
	const sc = new Scores(await mkdtemp(join(tmpdir(), "score-")), null, async (p, o, v) => {
		if (n++ === 0) throw new Error("boom");
		await stub(p, o, v);
	});
	await assert.rejects(sc.forFinal(spec([3])), /boom/);
	assert.equal((await sc.forFinal(spec([3]))).seconds, 3);
});

// Real kit audio.py (needs python with numpy+scipy and the samples): BLOCKWORLD_PYTHON=/path/to/python
test("real scorer: reviewer baseline is exactly 5.000 s and deterministic", { skip: !process.env.BLOCKWORLD_PYTHON }, async () => {
	const a = await new Scores(await mkdtemp(join(tmpdir(), "score-")), null).forFinal(spec([2.25, 2.75]));
	const b = await new Scores(await mkdtemp(join(tmpdir(), "score-")), null).forFinal(spec([2.25, 2.75]));
	assert.equal(a.seconds, 5);
	assert.deepEqual(await readFile(a.path), await readFile(b.path));
});
