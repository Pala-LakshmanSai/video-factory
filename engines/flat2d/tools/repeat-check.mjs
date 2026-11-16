#!/usr/bin/env node
// flat2d uniqueness guard (docs/ENGINE_FLAT2D.md, Guard 4): fingerprints this video's cast, props and sets and
// compares them with earlier videos in style-kits/_history/*.json, and cast members with each other.
// Usage: node engines/flat2d/tools/repeat-check.mjs <video.json> [--allow id,...] [--record]
// History dir: $FLAT2D_HISTORY or <repo>/style-kits/_history (gitignored).
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const HISTORY_DIR = process.env.FLAT2D_HISTORY ?? fileURLToPath(new URL("../../../style-kits/_history/", import.meta.url));
export const THRESHOLD = 0.8, SAME_VIDEO_THRESHOLD = 0.9;

// ---- fingerprints (plain JSON, stored in history) ----
const r1 = (v) => (typeof v === "number" ? Math.round(v * 10) / 10 : 1);
export function castPrint(a = {}) {
	return {
		top: [a.top?.kind ?? "default", a.top?.color ?? null],
		bottom: [a.bottom?.kind ?? "default", a.bottom?.color ?? null],
		hair: [a.hair?.style ?? "default", a.hair?.color ?? null],
		hat: [a.hat?.kind ?? "none", a.hat?.color ?? null],
		acc: [...(a.acc ?? [])].sort(),
		headShape: a.build?.headShape ?? "default",
		build: [r1(a.build?.height), r1(a.build?.width), r1(a.build?.head)],
	};
}
// a ShapeSpec (or several) -> primitive kinds in order, rounded sizes, palette, path command shapes
export function shapePrint(shapes, extraColors = []) {
	const kinds = [], sizes = [], colors = new Set(extraColors.filter(Boolean)), paths = [];
	const r = (v) => Math.round(v / 10) * 10;
	const walk = (list) => {
		for (const p of list ?? []) {
			const k = ["rect", "circle", "ellipse", "path", "poly", "line", "text", "image", "group"].find((k) => p?.[k] !== undefined);
			if (!k) continue;
			if (k === "group") { walk(p.group); continue; }
			kinds.push(k);
			for (const c of [p.fill, p.stroke]) if (typeof c === "string") colors.add(c.toLowerCase());
			if (k === "rect") sizes.push(`r${r(p.rect[2])}x${r(p.rect[3])}`);
			else if (k === "circle") sizes.push(`c${r(p.circle[2])}`);
			else if (k === "ellipse") sizes.push(`e${r(p.ellipse[2])}x${r(p.ellipse[3])}`);
			else if (k === "poly") sizes.push(`p${p.poly.length}`);
			else if (k === "text") sizes.push(`t${r(p.size ?? 0)}`);
			else if (k === "path") paths.push(String(p.path).replace(/[^a-zA-Z]/g, "").toUpperCase());
		}
	};
	for (const s of shapes) walk(s?.parts);
	return { kinds, sizes: sizes.sort(), colors: [...colors].sort(), paths: paths.sort() };
}
export const setPrint = (s = {}) =>
	({ ...shapePrint((s.layers ?? []).map((l) => l.shape), [...(s.sky ?? []), s.ground?.color]), board: !!s.board });
export const prints = (video) => ({
	id: video.id,
	cast: Object.fromEntries(Object.entries(video.cast ?? {}).map(([k, v]) => [k, castPrint(v)])),
	props: Object.fromEntries(Object.entries(video.props ?? {}).map(([k, v]) => [k, shapePrint([v])])),
	sets: Object.fromEntries(Object.entries(video.sets ?? {}).map(([k, v]) => [k, setPrint(v)])),
});

// ---- similarity 0..1 ----
const rgb = (c) => {
	const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c ?? "");
	if (!m) return null;
	const h = m[1].length === 3 ? [...m[1]].map((x) => x + x).join("") : m[1];
	return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};
// colours: identical -> 1; hex within RGB distance 25 -> 1, fading to 0 at 100; tokens (@navy) only match by name
export function colorSim(a, b) {
	if (a == null && b == null) return 1;
	if (a == null || b == null) return 0;
	if (a.toLowerCase() === b.toLowerCase()) return 1;
	const x = rgb(a), y = rgb(b);
	if (!x || !y) return 0;
	const d = Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
	return Math.max(0, Math.min(1, 1 - (d - 25) / 75));
}
const jaccard = (a, b) => {
	if (!a.length && !b.length) return 1;
	const A = new Set(a), B = new Set(b);
	return [...A].filter((x) => B.has(x)).length / new Set([...A, ...B]).size;
};
const lcs = (a, b) => {
	const d = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
	for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = a[i - 1] === b[j - 1] ? d[i - 1][j - 1] + 1 : Math.max(d[i - 1][j], d[i][j - 1]);
	return a.length || b.length ? d[a.length][b.length] / Math.max(a.length, b.length) : 1;
};
// each colour matched to its nearest in the other palette, both ways
const paletteSim = (a, b) => {
	if (!a.length && !b.length) return 1;
	if (!a.length || !b.length) return 0;
	const near = (xs, ys) => xs.reduce((s, x) => s + Math.max(...ys.map((y) => colorSim(x, y))), 0) / xs.length;
	return (near(a, b) + near(b, a)) / 2;
};

export function castSim(a, b) {
	const eq = (x, y) => (x === y ? 1 : 0);
	const f = [
		[1.5, eq(a.top[0], b.top[0])], [1.5, colorSim(a.top[1], b.top[1])],
		[0.5, eq(a.bottom[0], b.bottom[0])], [1, colorSim(a.bottom[1], b.bottom[1])],
		[1.5, eq(a.hair[0], b.hair[0])], [1, colorSim(a.hair[1], b.hair[1])],
		[1, eq(a.hat[0], b.hat[0])], [0.5, a.hat[0] === "none" && b.hat[0] === "none" ? 1 : colorSim(a.hat[1], b.hat[1])],
		[1.5, jaccard(a.acc, b.acc)], [0.5, eq(a.headShape, b.headShape)],
		[0.5, a.build.reduce((s, v, i) => s + (Math.abs(v - b.build[i]) <= 0.05 ? 1 : 0), 0) / 3],
	];
	return f.reduce((s, [w, v]) => s + w * v, 0) / f.reduce((s, [w]) => s + w, 0);
}
export function shapeSim(a, b) {
	const s = 0.4 * lcs(a.kinds, b.kinds) + 0.3 * paletteSim(a.colors, b.colors) + 0.15 * jaccard(a.sizes, b.sizes) + 0.15 * jaccard(a.paths, b.paths);
	return a.board !== undefined && a.board !== b.board ? s * 0.8 : s;
}

// ---- check ----
export function loadHistory(dir = HISTORY_DIR) {
	mkdirSync(dir, { recursive: true });
	return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}
export function check(video, { allow = [], history = loadHistory() } = {}) {
	const me = prints(video), hits = [];
	for (const old of history) {
		if (old.id === me.id) continue; // re-running the same video is not a repeat
		for (const [kind, sim] of [["cast", castSim], ["props", shapeSim], ["sets", shapeSim]])
			for (const [id, fp] of Object.entries(me[kind]))
				for (const [oid, ofp] of Object.entries(old[kind] ?? {})) {
					const score = sim(fp, ofp);
					if (score >= THRESHOLD) hits.push({ kind, id, score, video: old.id, match: oid, allowed: allow.includes(id) });
				}
	}
	const castIds = Object.keys(me.cast);
	for (let i = 0; i < castIds.length; i++)
		for (let j = i + 1; j < castIds.length; j++) {
			const score = castSim(me.cast[castIds[i]], me.cast[castIds[j]]);
			if (score > SAME_VIDEO_THRESHOLD)
				hits.push({ kind: "cast", id: castIds[i], score, video: "(this video)", match: castIds[j], allowed: allow.includes(castIds[i]) || allow.includes(castIds[j]) });
		}
	return { hits, ok: hits.every((h) => h.allowed), prints: me };
}
export function record(video, dir = HISTORY_DIR) {
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${String(video.id).replace(/[^\w.-]/g, "_")}.json`);
	writeFileSync(file, JSON.stringify({ ...prints(video), recorded: new Date().toISOString(), notes: video.notes ?? "" }, null, 1));
	return file;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const args = process.argv.slice(2);
	const file = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--allow");
	if (!file) { console.error("usage: repeat-check.mjs <video.json> [--allow id,...] [--record]"); process.exit(2); }
	const ai = args.indexOf("--allow");
	const allow = ai >= 0 ? (args[ai + 1] ?? "").split(",").filter(Boolean) : [];
	const video = JSON.parse(readFileSync(file, "utf8"));
	const { hits, ok } = check(video, { allow });
	for (const h of hits)
		console.log(`${h.allowed ? "allowed" : "REPEAT "} ${h.kind} "${h.id}" ~ "${h.match}" in ${h.video}  score ${h.score.toFixed(2)}`);
	console.log(hits.length ? `${hits.filter((h) => !h.allowed).length} blocking repeat(s)` : "no repeats");
	if (args.includes("--record")) console.log(`recorded ${record(video)}`);
	process.exit(ok ? 0 : 1);
}
