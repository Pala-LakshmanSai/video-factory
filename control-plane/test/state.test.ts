import { describe, expect, it } from "vitest";
import type { JobState } from "../../packages/contract/src/index";
import { canTransition, IllegalTransition, transition } from "../src/state";
import { makeDb } from "./helpers";

const ALL: JobState[] = [
	"queued", "provisioning", "booting", "waiting_for_plan", "rendering", "preview_ready", "rerendering",
	"final_render", "uploading", "verifying", "done", "retrying", "failed", "cancelled",
];

// Written straight from the CONTRACT.md §10 table, independent of src/state.ts.
const POD = ["booting", "waiting_for_plan", "rendering", "preview_ready", "rerendering", "final_render", "uploading", "verifying"];
const LEGAL = new Set<string>([
	"queued>provisioning", "provisioning>booting", "booting>waiting_for_plan", "booting>rendering",
	"waiting_for_plan>rendering", "rendering>preview_ready", "rendering>rerendering", "preview_ready>rerendering",
	"rerendering>rerendering", "rerendering>preview_ready", "preview_ready>final_render", "final_render>uploading",
	"uploading>verifying", "verifying>uploading", "verifying>done", "retrying>booting",
	...POD.map((s) => `${s}>retrying`),
	...ALL.filter((s) => !["done", "failed", "cancelled"].includes(s)).flatMap((s) => [`${s}>failed`, `${s}>cancelled`]),
]);

describe("state machine (SPEC §10 + CONTRACT)", () => {
	for (const from of ALL)
		for (const to of ALL) {
			const legal = LEGAL.has(`${from}>${to}`);
			it(`${from} -> ${to} is ${legal ? "legal" : "illegal"}`, () => expect(canTransition(from, to)).toBe(legal));
		}

	it("writes an event on every change and updates the row", async () => {
		const db = makeDb();
		await db.prepare("INSERT INTO jobs (id, chat_key, state, title, style, voiceover_json, created_at, updated_at) VALUES ('j1','k','provisioning','t','explainer','{}',0,0)").run();
		const job = { id: "j1", state: "provisioning" as JobState };
		await transition(db, job, "booting");
		expect(job.state).toBe("booting");
		expect((await db.prepare("SELECT state FROM jobs WHERE id='j1'").first<{ state: string }>())!.state).toBe("booting");
		const ev = await db.prepare("SELECT kind, data_json FROM events WHERE job_id='j1'").all<{ kind: string; data_json: string }>();
		expect(ev.results).toHaveLength(1);
		expect(JSON.parse(ev.results[0].data_json)).toMatchObject({ from: "provisioning", to: "booting" });
	});

	it("throws on an illegal transition and on a stale state (concurrent change)", async () => {
		const db = makeDb();
		await db.prepare("INSERT INTO jobs (id, chat_key, state, title, style, voiceover_json, created_at, updated_at) VALUES ('j1','k','rendering','t','explainer','{}',0,0)").run();
		await expect(transition(db, { id: "j1", state: "rendering" }, "done")).rejects.toBeInstanceOf(IllegalTransition);
		await expect(transition(db, { id: "j1", state: "waiting_for_plan" }, "rendering")).rejects.toBeInstanceOf(IllegalTransition);
		expect(await db.prepare("SELECT COUNT(*) n FROM events").first<{ n: number }>()).toEqual({ n: 0 });
	});
});
