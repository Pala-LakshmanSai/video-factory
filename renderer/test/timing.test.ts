import assert from "node:assert/strict";
import { test } from "node:test";
import { previewTimes, timeScenes } from "../engine/timing.ts";

const s = (n: number, d: number) => ({ n, template: "title", props: {}, duration_s: d, narration: "", transition: "cut" });

test("scene durations rescale to the audio and snap to whole frames", () => {
	const t = timeScenes([s(1, 3), s(2, 3), s(3, 4)], 12.5, 30);
	assert.equal(t.reduce((a, x) => a + x.frames, 0), 375);
	assert.deepEqual(t.map((x) => x.startFrame), [0, 113, 226]);
	assert.ok(Math.abs(t[2].duration - 4.9667) < 0.01);
});

test("preview times sit after the entrance and before the exit", () => {
	const [a, b, c] = previewTimes(4);
	assert.ok(a > 0.4 && a < b && b < c && c < 4);
});
