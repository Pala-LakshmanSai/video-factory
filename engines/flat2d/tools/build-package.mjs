#!/usr/bin/env node
// video.json + scenes.json -> a style "custom" package dir + scene_plan.json (docs/ENGINE_FLAT2D.md).
//   node engines/flat2d/tools/build-package.mjs <video.json> <scenes.json> <out-dir> [--custom custom.js] [--plan scene_plan.json]
// The package holds scene.html (the one template), the engine, the look as tokens.json, look.js (look extras or a
// stub), custom.js (the video's escape-hatch code, or a stub) and the look's fonts + licences. Each plan scene
// carries props {video: the subset of video.json it uses, spec}. Then: node scripts/pack-style.mjs <out-dir> <plan>.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ENGINE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const customArg = opt("--custom"), planArg = opt("--plan");
const [videoArg, scenesArg, outArg] = args;
if (!outArg) { console.error("usage: build-package.mjs <video.json> <scenes.json> <out-dir> [--custom custom.js] [--plan scene_plan.json]"); process.exit(2); }
const fail = (m) => { console.error(`build-package: ${m}`); process.exit(1); };

const video = JSON.parse(readFileSync(videoArg, "utf8"));
const scenes = JSON.parse(readFileSync(scenesArg, "utf8"));
if (!Array.isArray(scenes) || !scenes.length) fail("scenes.json must be a non-empty array");
const lookFile = join(ENGINE, "looks", `${video.look}.json`);
if (!existsSync(lookFile)) fail(`look "${video.look}" not found (${lookFile})`);
const look = JSON.parse(readFileSync(lookFile, "utf8"));

// ---- the subset of video.json each scene uses: walk for cast/prop/set/image ids until closed
const KEYS = { cast: "cast", prop: "props", set: "sets", image: "images" };
function refs(root) {
	const used = { cast: new Set(), props: new Set(), sets: new Set(), images: new Set() };
	const queue = [root];
	const walk = (o) => {
		if (Array.isArray(o)) return o.forEach(walk);
		if (!o || typeof o !== "object") return;
		for (const [k, v] of Object.entries(o)) {
			if (KEYS[k] && typeof v === "string") {
				const bag = KEYS[k];
				if (!used[bag].has(v)) { used[bag].add(v); if (bag !== "images") queue.push(video[bag]?.[v]); }
			} else walk(v);
		}
	};
	while (queue.length) walk(queue.shift());
	return used;
}
const pick = (bag, ids) => Object.fromEntries([...ids].filter((id) => video[bag]?.[id] !== undefined).map((id) => [id, video[bag][id]]));

// ---- package dir
const out = resolve(outArg);
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "fonts"), { recursive: true });
for (const f of ["scene.html", "engine.js", "rig.js", "shapes.js", "ui.js"]) copyFileSync(join(ENGINE, f), join(out, f));
const lookJs = join(ENGINE, "looks", `${video.look}.js`);
writeFileSync(join(out, "look.js"), existsSync(lookJs) ? readFileSync(lookJs) : `// look "${video.look}" has no extras\n`);
const customSrc = customArg ?? (existsSync(join(dirname(resolve(videoArg)), "custom.js")) ? join(dirname(resolve(videoArg)), "custom.js") : null);
writeFileSync(join(out, "custom.js"), customSrc ? readFileSync(customSrc) : "// no custom code for this video\n");
for (const f of look.fontFiles ?? []) {
	const src = join(ENGINE, f.file);
	if (!existsSync(src)) fail(`look font missing: ${src}`);
	copyFileSync(src, join(out, f.file));
}
for (const f of readdirSync(join(ENGINE, "fonts"))) if (/^(OFL|LICENSE)/i.test(f)) copyFileSync(join(ENGINE, "fonts", f), join(out, "fonts", f));
writeFileSync(join(out, "tokens.json"), JSON.stringify(look, null, 1));

// ---- scene_plan.json
const [w, h] = video.size ?? [1920, 1080];
const plan = {
	style: "custom",
	fps: video.fps ?? 30,
	resolution: `${w}x${h}`,
	scenes: scenes.map((s, i) => {
		if (s.n !== i + 1) fail(`scenes[${i}].n must be ${i + 1}`);
		if (!(s.duration > 0)) fail(`scene ${s.n}: duration must be > 0`);
		if (!s.spec) fail(`scene ${s.n}: missing spec`);
		const u = refs(s.spec);
		const sub = { id: video.id, look: video.look, size: [w, h], fps: video.fps ?? 30, cast: pick("cast", u.cast), props: pick("props", u.props), sets: pick("sets", u.sets), images: pick("images", u.images) };
		return { n: s.n, template: "scene", props: { video: sub, spec: s.spec }, duration_s: s.duration, narration: s.narration ?? "", transition: s.transition ?? "cut" };
	}),
};
const planFile = resolve(planArg ?? join(dirname(out), `${basename(out)}.scene_plan.json`));
writeFileSync(planFile, JSON.stringify(plan, null, 1));
const bytes = Buffer.byteLength(JSON.stringify(plan));
if (bytes > 1_500_000) fail(`scene_plan is ${(bytes / 1e6).toFixed(2)} MB > 1.5 MB; shrink the images`);
console.log(JSON.stringify({ package: out, plan: planFile, scenes: plan.scenes.length, seconds: +plan.scenes.reduce((a, s) => a + s.duration_s, 0).toFixed(2), planBytes: bytes }));
