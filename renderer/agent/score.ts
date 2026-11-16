// blockworld audio: the episode's own caption-led score (kit audio.py via renderer/audio/blockworld/score.py),
// generated on the pod and bound to the episode it was made from. Timing comes from episode.json, never a voice.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SpecOut } from "../../packages/contract/src/index.ts";
import { durationOf, must } from "../engine/ffmpeg.ts";

const SCORER = fileURLToPath(new URL("../audio/blockworld/score.py", import.meta.url));

export type Score = { path: string; seconds: number; sha: string };
export type Runner = (planFile: string, out: string, voice: string | null) => Promise<void>;

const canon = (v: unknown): string =>
	Array.isArray(v) ? `[${v.map(canon).join(",")}]`
	: v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}`
	: JSON.stringify(v);

type Episode = { scenes: { dur: number }[] };
const episodeOf = (s: SpecOut) => (s.scenes[0]?.props as { episode?: Episode } | undefined)?.episode;

/** Identity of the episode a score was made from (scene 1's copy; the control plane keeps all copies equal). */
export const episodeSha = (s: SpecOut) => createHash("sha256").update(canon(episodeOf(s) ?? null)).digest("hex");

/** Episode length: what previews time against, and what the score must measure. */
export const episodeSeconds = (s: SpecOut) => (episodeOf(s)?.scenes ?? []).reduce((a, x) => a + x.dur, 0);

const python: Runner = (planFile, out, voice) =>
	must(process.env.BLOCKWORLD_PYTHON ?? "python3", [SCORER, planFile, out, ...(voice ? ["--voice", voice] : [])]).then(() => undefined);

/**
 * One score per episode sha, started as soon as a spec is seen (previews do not wait for it) and awaited by the
 * final. A revise that changes the episode changes the sha, so a stale score can never be picked for the mux.
 */
export class Scores {
	private jobs = new Map<string, Promise<Score>>();
	private dir: string;
	private voice: string | null;
	private run: Runner;
	constructor(dir: string, voice: string | null, run: Runner = python) {
		this.dir = dir;
		this.voice = voice;
		this.run = run;
	}

	get(s: SpecOut): Promise<Score> {
		const sha = episodeSha(s);
		let p = this.jobs.get(sha);
		if (!p) {
			p = (async () => {
				await mkdir(this.dir, { recursive: true });
				const plan = join(this.dir, `plan-${sha}.json`), out = join(this.dir, `score-${sha}.wav`);
				await writeFile(plan, JSON.stringify({ style: s.style, fps: s.fps, resolution: s.resolution, scenes: s.scenes }));
				await this.run(plan, out, this.voice);
				return { path: out, seconds: await durationOf(out), sha };
			})();
			p.catch(() => this.jobs.delete(sha)); // a failed score is retried on the next request, not cached
			this.jobs.set(sha, p);
		}
		return p;
	}

	/** Score for the final mux: must be this spec's episode and exactly its length (within one frame). */
	async forFinal(s: SpecOut): Promise<Score> {
		const sc = await this.get(s);
		assertMatches(sc, s);
		return sc;
	}
}

export function assertMatches(sc: Score, s: SpecOut) {
	if (sc.sha !== episodeSha(s)) throw new Error(`stale score: made for episode ${sc.sha.slice(0, 12)}, plan has ${episodeSha(s).slice(0, 12)}`);
	const want = episodeSeconds(s);
	if (Math.abs(sc.seconds - want) > 1 / s.fps) throw new Error(`score is ${sc.seconds.toFixed(3)} s, episode is ${want.toFixed(3)} s`);
}
