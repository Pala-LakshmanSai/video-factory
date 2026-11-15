// Scene timing: the plan's duration_s are estimates; scale them to the real audio length
// (CONTRACT Contradictions #6) and snap to whole frames, the last scene absorbing rounding.
import type { Scene } from "../../packages/contract/src/index.ts";

export interface Timed { scene: Scene; frames: number; startFrame: number; duration: number }

export function timeScenes(scenes: Scene[], audioSeconds: number, fps: number): Timed[] {
	const total = Math.round(audioSeconds * fps);
	const sum = scenes.reduce((a, s) => a + s.duration_s, 0);
	let start = 0;
	return scenes.map((scene, i) => {
		const frames = i === scenes.length - 1 ? total - start : Math.max(1, Math.round((scene.duration_s / sum) * total));
		const t: Timed = { scene, frames, startFrame: start, duration: frames / fps };
		start += frames;
		return t;
	});
}

/** Prompt 6a: 3 key frames per scene (start / mid / end), past the entrance and before the exit. */
export function previewTimes(duration: number): [number, number, number] {
	const start = Math.min(0.7, duration * 0.25);
	const end = Math.max(duration - 0.6, duration * 0.75);
	return [start, duration / 2, end];
}
