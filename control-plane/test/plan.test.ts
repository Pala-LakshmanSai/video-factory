import { describe, expect, it } from "vitest";
import { rerank } from "../src/bench";
import { mergePatch, validatePlan } from "../src/plan";

const ok = { style: "explainer", fps: 30, resolution: "1920x1080", scenes: [{ n: 1, template: "title", props: {}, duration_s: 3, narration: "x", transition: "cut" }] };

describe("scene_plan validation", () => {
	it("accepts a valid plan", () => expect(validatePlan(ok, "explainer")).toEqual([]));
	it("gives precise errors", () => {
		const errs = validatePlan({ ...ok, style: "documentary", fps: 7, scenes: [{ ...ok.scenes[0], n: 2, template: "nope", transition: "spin" }] }, "explainer");
		expect(errs.join("\n")).toMatch(/style must be "explainer"/);
		expect(errs.join("\n")).toMatch(/fps/);
		expect(errs.join("\n")).toMatch(/scenes\[0\]\.n must be 1/);
		expect(errs.join("\n")).toMatch(/template "nope"/);
		expect(errs.join("\n")).toMatch(/transition/);
	});
	it("rejects videos over 3 min", () => expect(validatePlan({ ...ok, scenes: [{ ...ok.scenes[0], duration_s: 181 }] }, "explainer")[0]).toMatch(/exceeds/));
});

describe("helpers", () => {
	it("mergePatch follows RFC 7386", () => expect(mergePatch({ a: 1, b: { c: 2, d: 3 } }, { b: { c: null, e: 4 } })).toEqual({ a: 1, b: { d: 3, e: 4 } }));
	it("rerank: tested by $ per video, untested keep their order below", () => {
		const res = { B: { boot_s: 1, render_s: 1, cost_per_hr: 1, score: 0.05 }, D: { boot_s: 1, render_s: 1, cost_per_hr: 1, score: 0.02 } };
		expect(rerank(["A", "B", "C", "D", "E"], res)).toEqual(["D", "B", "A", "C", "E"]);
	});
});

describe("plan size limit", () => {
	it("rejects a serialized plan over 1.5 MB with a clear message, accepts one just under", () => {
		const base = { style: "explainer", fps: 30, resolution: "1920x1080", scenes: [{ n: 1, template: "title", props: { title: "x", image: "" }, duration_s: 3, narration: "x", transition: "cut" }] };
		const big = structuredClone(base);
		big.scenes[0].props.image = "data:image/jpeg;base64," + "A".repeat(1_500_001);
		expect(validatePlan(big, "explainer").join("\n")).toMatch(/limit is 1\.5 MB/);
		const ok = structuredClone(base);
		ok.scenes[0].props.image = "data:image/jpeg;base64," + "A".repeat(1_400_000);
		expect(validatePlan(ok, "explainer").filter((e) => /MB/.test(e))).toEqual([]);
	});
});
