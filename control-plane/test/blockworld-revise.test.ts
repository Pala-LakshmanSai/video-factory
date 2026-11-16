// Episode styles (blockworld): one episode shared by every scene; revise_scene keeps all copies identical and
// re-previews every scene when the episode changes. Other styles keep the single-scene rerender path.
import { describe, expect, it } from "vitest";
import { getJob, plan } from "../src/db";
import { acquireGpu, reviseScene } from "../src/mcp";
import { canon, validatePlan } from "../src/plan";
import { makeEnv } from "./helpers";

const episode = (durs: number[]) => ({ meta: { title: "t", voiceover: null }, scenes: durs.map((dur, i) => ({ id: `s${i}`, dur, caption: `Scene ${i}` })) });
const bwPlan = (durs: number[]) => {
	const ep = episode(durs);
	return { style: "blockworld", fps: 30, resolution: "1920x1080", scenes: durs.map((d, i) => ({ n: i + 1, template: "episode", props: { episode: ep }, duration_s: d, narration: "", transition: "cut" })) };
};

async function job(env: Env, style: string, p: unknown, state = "preview_ready") {
	const t = Date.now();
	await env.DB.prepare("INSERT INTO jobs (id, chat_key, state, title, style, voiceover_json, ttl_min, plan_json, created_at, updated_at) VALUES ('j1', 'ck', ?, 't', ?, ?, 60, ?, ?, ?)")
		.bind(state, style, JSON.stringify(style === "blockworld" ? { none: true } : { text: "x" }), JSON.stringify(p), t, t).run();
	return "j1";
}

describe("blockworld episode plans", () => {
	it("rejects a later scene carrying a different episode, and duration_s that differs from dur", () => {
		const p = bwPlan([2.25, 2.75]);
		p.scenes[1] = { ...p.scenes[1], props: { episode: episode([2.25, 9]) } };
		expect(validatePlan(p, "blockworld").join("\n")).toMatch(/scenes\[1\]\.props\.episode must be identical/);
		const q = bwPlan([2.25, 2.75]);
		q.scenes[0].duration_s = 3;
		expect(validatePlan(q, "blockworld").join("\n")).toMatch(/scenes\[0\]\.duration_s must equal episode\.scenes\[0\]\.dur/);
		expect(validatePlan(bwPlan([2.25, 2.75]), "blockworld")).toEqual([]);
	});

	it("a timing revise on one scene updates every scene's episode and durations, and re-previews all scenes", async () => {
		const env = makeEnv();
		const id = await job(env, "blockworld", bwPlan([2.25, 2.75]));
		const r = await reviseScene(env.DB, id, 1, { props: { episode: { scenes: [{ id: "s0", dur: 2.25, caption: "Scene 0" }, { id: "s1", dur: 3.75, caption: "Longer" }] } } } as never);
		expect(r).toEqual({ state: "rerendering", scene: 1 });
		const j = (await getJob(env.DB, id))!;
		const p = plan(j)!;
		const eps = p.scenes.map((s) => canon((s.props as { episode: unknown }).episode));
		expect(new Set(eps).size).toBe(1); // every scene identical
		expect(p.scenes.map((s) => s.duration_s)).toEqual([2.25, 3.75]);
		expect(j.pending_cmd).toBe("previews"); // all scenes re-preview; the pod re-scores the new episode sha
		expect(j.rerender_scene).toBeNull();
		expect(validatePlan(p, "blockworld")).toEqual([]);
	});

	it("a non-episode blockworld patch keeps the single-scene rerender path", async () => {
		const env = makeEnv();
		const id = await job(env, "blockworld", bwPlan([2.25, 2.75]));
		expect(await reviseScene(env.DB, id, 2, { narration: "two" })).toEqual({ state: "rerendering", scene: 2 });
		const j = (await getJob(env.DB, id))!;
		expect([j.pending_cmd, j.rerender_scene]).toEqual(["rerender:2", 2]);
	});

	it("voiceover {none} is refused for voiceover styles", async () => {
		const env = makeEnv();
		await expect(acquireGpu(env, env.DB, { style: "explainer", title: "t", voiceover: { none: true }, chat_key: "abcd" })).rejects.toThrow(/caption-led/);
	});
});
