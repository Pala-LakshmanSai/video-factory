#!/usr/bin/env node
// Self-checks for validate.mjs, repeat-check.mjs and qa.mjs. Run: node engines/flat2d/tools/test-guards.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validate, ENUMS } from "./validate.mjs";
import { check, record, loadHistory, castSim } from "./repeat-check.mjs";
import { qa, checkQa } from "./qa.mjs";

const tmp = mkdtempSync(join(tmpdir(), "flat2d-guards-"));
const ok = (name) => console.log(`ok  ${name}`);

// ---------- validate ----------
const video = {
	id: "v1", look: "stickman", size: [1920, 1080], fps: 30,
	cast: { ana: { top: { kind: "hoodie", color: "#e05a3a" }, hair: { style: "bun", color: "#222" }, acc: ["glasses"] } },
	props: { mug: { box: [60, 80], parts: [{ rect: [0, 0, 60, 80], fill: "@navy" }] } },
	sets: { office: { sky: ["#fff", "#eee"], layers: [{ shape: { box: [10, 10], parts: [{ rect: [0, 0, 10, 10], fill: "#123456" }] }, at: [0, 0] }] } },
	images: { cover: "data:image/png;base64,AAAA" },
};
const scene = (n, start, duration, items, extra = {}) => ({ n, start, duration, narration: "x", spec: { set: "office", items, ...extra } });
const good = [
	scene(1, 0, 3, [
		{ id: "a", type: "actor", cast: "ana", at: [960, 800], do: [[0, "stand"], [0.5, "pose", { name: "wave" }], [1, "walk", { to: [1200, 800], dur: 1 }], [2, "hold", { prop: "mug", hand: "R" }]] },
		{ id: "t", type: "text", str: "Hello", size: 60, at: [960, 300] },
		{ id: "c", type: "counter", to: 100, t0: 0.5, t1: 2.5, at: [960, 500] },
	], { camera: [[0, { zoom: 1 }], [3, { zoom: 1.1 }, "ioC"]], fx: [{ t: 1, kind: "flash" }] }),
	scene(2, 3, 2, [{ id: "img", type: "image", image: "cover", fit: "cover", at: [960, 540] }, { id: "cx", type: "custom", fn: "boom" }]),
];
{
	const r = validate(video, good);
	assert.deepEqual(r.errors, [], JSON.stringify(r.errors));
	assert.equal(r.warnings.length, 0);
	ok("validate: clean example passes");
}
{
	const bad = structuredClone(good);
	bad[0].spec.items[0].cast = "bob"; // bad cast id
	bad[0].spec.items[0].do[1][2].name = "moonwalk"; // bad pose
	bad[0].spec.items.push({ id: "e", type: "pill", str: "X", enter: { t: 9, how: "spin" } }); // bad enum + time outside
	bad[0].spec.items.push({ id: "c2", type: "counter", to: 5 }); // counter without t0/t1
	bad[0].spec.fx.push({ t: 1, kind: "lasers" });
	bad[1].start = 3.5; // gap
	bad[1].spec.items[1].fn = undefined; // custom without fn
	bad[1].spec.items[0].image = "nope";
	bad[1].narration = "see https://example.com";
	const v = structuredClone(video);
	v.cast.ana.acc.push("monocle"); // unknown acc
	const { errors } = validate(v, bad);
	const has = (re) => assert.ok(errors.some((e) => re.test(e.msg)), `expected error ${re}; got:\n${errors.map((e) => e.msg).join("\n")}`);
	has(/unknown cast id "bob"/);
	has(/name "moonwalk"/);
	has(/enter.how: "spin"/);
	has(/enter.t: t=9 outside/);
	has(/counter needs "t0"/);
	has(/counter needs "t1"/);
	has(/kind: "lasers"/);
	has(/not contiguous/);
	has(/custom needs "fn"/);
	has(/unknown image id "nope"/);
	has(/network URL/);
	has(/acc: "monocle"/);
	assert.ok(errors.find((e) => /bob/.test(e.msg)).scene === 1 && errors.find((e) => /bob/.test(e.msg)).item === "a");
	ok(`validate: bad ids / enums / times / URLs caught (${errors.length} errors)`);
}
{
	const wide = [scene(1, 0, 2, [{ id: "long", type: "text", str: "THIS HEADLINE IS FAR TOO LONG TO FIT ACROSS", size: 90, at: [960, 540] }])];
	const r = validate(video, wide);
	assert.equal(r.errors.length, 0);
	assert.ok(r.warnings.some((w) => w.item === "long"));
	ok("validate: over-wide text is a warning, not an error");
}
assert.ok(ENUMS.poses.includes("wave") && ENUMS.itemTypes.includes("custom"));

// ---------- repeat-check ----------
const hist = join(tmp, "history");
const older = {
	id: "old-video",
	cast: { hero: { top: { kind: "hoodie", color: "#e05a3a" }, bottom: { kind: "trousers", color: "#333" }, hair: { style: "bun", color: "#222" }, acc: ["glasses"] } },
	props: { box: { box: [60, 80], parts: [{ rect: [0, 0, 60, 80], fill: "#203040" }, { circle: [30, 30, 10], fill: "#ffcc00" }] } },
	sets: {},
};
record(older, hist);
const nu = {
	id: "new-video",
	cast: {
		ana: { top: { kind: "hoodie", color: "#e35c3c" }, bottom: { kind: "trousers", color: "#353535" }, hair: { style: "bun", color: "#202020" }, acc: ["glasses"] }, // near-copy of hero
		ben: { top: { kind: "suit", color: "#1a2b6d" }, bottom: { kind: "trousers", color: "#111" }, hair: { style: "slick", color: "#c9a14a" }, hat: { kind: "fedora", color: "#444" }, acc: ["beard", "watch"] },
	},
	props: { crate: { box: [60, 80], parts: [{ rect: [0, 0, 62, 78], fill: "#213141" }, { circle: [30, 30, 10], fill: "#ffcd02" }] } },
	sets: {},
};
{
	const r = check(nu, { history: loadHistory(hist) });
	assert.ok(!r.ok);
	assert.ok(r.hits.some((h) => h.id === "ana" && h.match === "hero" && h.video === "old-video" && h.score >= 0.8));
	assert.ok(r.hits.some((h) => h.id === "crate" && h.match === "box"));
	assert.ok(!r.hits.some((h) => h.id === "ben"), "distinct character must not be flagged");
	ok("repeat-check: near-duplicate cast and prop from history flagged");
}
{
	const r = check(nu, { history: loadHistory(hist), allow: ["ana", "crate"] });
	assert.ok(r.ok && r.hits.length === 2 && r.hits.every((h) => h.allowed));
	ok("repeat-check: --allow passes series cast/props");
}
{
	const twins = { id: "twins", cast: { a: nu.cast.ana, b: structuredClone(nu.cast.ana), c: nu.cast.ben }, props: {}, sets: {} };
	twins.cast.b.hair.color = "#252525";
	const r = check(twins, { history: [] });
	assert.ok(!r.ok && r.hits.some((h) => h.video === "(this video)" && h.id === "a" && h.match === "b"));
	assert.ok(castSim(r.prints.cast.a, r.prints.cast.c) < 0.5);
	ok("repeat-check: near-identical cast within one video flagged");
}
{
	record(nu, hist);
	const f = JSON.parse(readFileSync(join(hist, "new-video.json"), "utf8"));
	assert.equal(f.id, "new-video");
	assert.ok(f.cast.ana && f.props.crate);
	assert.ok(check(nu, { history: loadHistory(hist), allow: ["ana", "crate"] }).ok, "own history entry is skipped");
	ok("repeat-check: --record writes history and the same video is not its own repeat");
}

// ---------- qa ----------
assert.equal(checkQa({ texts: [{ str: "x", box: [900, 500, 100, 40], size: 40 }], items: [], blank: false }, { W: 1920, H: 1080, mid: true }).length, 0);
{
	const p = checkQa({ texts: [{ str: "a", box: [900, 500, 200, 40], size: 20 }, { str: "b", box: [950, 510, 200, 40], size: 40 }, { str: "c", box: [900, 20, 100, 30], size: 40 }],
		items: [{ id: "hero", type: "actor", box: [1800, 300, 300, 600] }] }, { W: 1920, H: 1080, mid: true }).map((x) => x.msg).join("\n");
	for (const re of [/size 20px < 28px/, /overlap/, /"c" inside the letterbox/, /actor hero cut/]) assert.match(p, re);
	ok("qa: small text, overlap, letterbox and cut actor rules");
}
{
	const pkg = join(tmp, "pkg");
	mkdirSync(pkg, { recursive: true });
	writeFileSync(join(pkg, "tokens.json"), JSON.stringify({ palette: { bg: "#ffffff" } }));
	// fake engine: scene 1 draws stripes with a text at x=10 (off the safe area); scene 2 is blank
	writeFileSync(join(pkg, "scene.html"), `<!doctype html><html><body style="margin:0"><canvas id="c" width="1280" height="720"></canvas><script>
const S = window.__scene, c = document.getElementById("c").getContext("2d");
window.__ready = Promise.resolve();
window.__seek = (t) => {
  const blank = S.props.blank;
  c.fillStyle = "#fff"; c.fillRect(0, 0, 1280, 720);
  if (!blank) for (let i = 0; i < 1280; i += 80) { c.fillStyle = "#123"; c.fillRect(i, 0, 40, 720); }
  window.__qa = blank ? { texts: [], items: [], blank: true }
    : { texts: [{ str: "OFF EDGE", box: [10, 300, 300, 50], size: 50 }], items: [{ id: "a", type: "actor", box: [500, 200, 200, 400] }], blank: false };
};
</script></body></html>`);
	const plan = { style: "custom", fps: 30, resolution: "1280x720", scenes: [
		{ n: 1, template: "scene", props: { blank: false }, duration_s: 2, narration: "a", transition: "cut" },
		{ n: 2, template: "scene", props: { blank: true }, duration_s: 2, narration: "b", transition: "cut" },
	] };
	const planFile = join(tmp, "scene_plan.json");
	writeFileSync(planFile, JSON.stringify(plan));
	const out = join(tmp, "qa-out");
	const t0 = Date.now();
	const { report, text } = await qa(pkg, planFile, { out });
	console.log(text.split("\n").map((l) => "    " + l).join("\n"));
	const e = (n, re) => report.issues.some((i) => i.scene === n && i.level === "error" && re.test(i.msg));
	assert.ok(e(1, /outside the safe area/), "off-safe-area text flagged");
	assert.ok(e(2, /blank frame/), "blank flag flagged");
	assert.ok(e(2, /flat frame/), "flat screenshot flagged");
	assert.ok(!report.issues.some((i) => i.scene === 1 && /flat|actor|blank/.test(i.msg)), "striped scene 1 is not flat");
	assert.ok(report.contactSheet && readFileSync(report.contactSheet).length > 1000);
	assert.ok(readFileSync(join(out, "qa-report.txt"), "utf8").includes("error(s)"));
	ok(`qa: fake package flagged off-safe text, blank and flat frames; contact sheet written (${Date.now() - t0} ms)`);
}
console.log(`all guard checks passed (scratch: ${tmp})`);
