#!/usr/bin/env node
// flat2d validator: schema + reference checks for video.json + scenes.json (docs/ENGINE_FLAT2D.md).
// Usage: node engines/flat2d/tools/validate.mjs <video.json> <scenes.json>   -> exit 1 on errors
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// The ONE list of allowed enum values. The engine and looks import this; add new names here.
export const ENUMS = {
	itemTypes: ["actor", "prop", "image", "text", "label", "pill", "tag", "board", "counter", "quote", "card", "map", "arrow", "web", "chart", "split", "custom"],
	actions: ["stand", "walk", "run", "pose", "face", "look", "hold", "drop", "joints"],
	poses: ["point", "wave", "cheer", "shrug", "think", "facepalm", "cross-arms", "hands-hips", "sit", "lie", "crouch", "fight", "punch", "kick", "fall", "jump", "celebrate", "phone", "drink", "type", "carry", "hands-up", "hug", "sneak", "talk"],
	enterExit: ["pop", "fade", "slide-l", "slide-r", "slide-u", "slide-d", "draw", "wipe", "type", "grow"],
	fx: ["flash", "whoosh-lines", "confetti", "dust", "rain", "stars", "smoke", "sparkle"],
	// The spec only shows "ioC"; this family (in/out/inOut x Quad/Cubic/Expo/Back...) is our reading of it.
	eases: ["linear", "step", "in", "out", "io", "inQ", "outQ", "ioQ", "inC", "outC", "ioC", "inE", "outE", "ioE", "inB", "outB", "ioB", "outEl", "outBo", "lin", "ioS"],
	headShape: ["round", "oval", "square", "egg"],
	top: ["tee", "hoodie", "jacket", "suit", "hawaii", "open", "vest", "dress", "lab", "none"],
	pattern: ["none", "stripes", "dots", "flowers", "camo"],
	bottom: ["trousers", "shorts", "skirt"],
	hair: ["none", "short", "slick", "ponytail", "bun", "long", "curly", "afro", "white", "bald", "braids"],
	hat: ["none", "cap", "capBack", "beanie", "fedora", "homburg", "headband", "crown"],
	acc: ["glasses", "sunglasses", "chain", "headset", "headphones", "bandana", "beard", "mustache", "watch", "badge"],
	anchors: ["head", "neck", "chest", "hip", "handL", "handR"],
	eyes: ["dot", "wide", "happy", "sleepy", "angry", "smug"],
	mouth: ["flat", "smile", "grin", "o", "frown", "smirk"],
	brows: ["none", "up", "down", "worried"],
	hands: ["L", "R", "l", "r", "left", "right", "handL", "handR"],
	shapeParts: ["rect", "circle", "ellipse", "path", "poly", "line", "text", "image", "group"],
	rim: ["warm", "cool", "none"],
	fit: ["cover", "contain"],
	frame: ["none", "polaroid", "tv", "phone", "board"],
	chart: ["bar", "line", "pie"],
	maps: ["florida"],
	animKeys: ["x", "y", "dx", "dy", "scale", "rot", "opacity"],
};

const TEXT_TYPES = { text: 48, label: 32, pill: 32, tag: 40, quote: 40 }; // default size if the item gives none

export function validate(video, scenes) {
	const errors = [], warnings = [];
	const err = (scene, item, msg) => errors.push({ scene, item, msg });
	const warn = (scene, item, msg) => warnings.push({ scene, item, msg });
	const has = (o, k) => o != null && typeof o === "object" && Object.hasOwn(o, k);
	const ids = (k) => new Set(Object.keys(video?.[k] ?? {}));
	const cast = ids("cast"), props = ids("props"), sets = ids("sets"), images = ids("images");
	const [W, H] = Array.isArray(video?.size) ? video.size : [1920, 1080];

	// no http(s) URLs anywhere, in either file
	const urls = (o, where, path = "") => {
		if (typeof o === "string") { if (/https?:\/\//i.test(o)) err(where, path || "-", `network URL not allowed: ${o.slice(0, 80)}`); }
		else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) urls(v, where, path ? `${path}.${k}` : k);
	};
	urls(video, "video");
	(Array.isArray(scenes) ? scenes : []).forEach((s, i) => urls(s, s?.n ?? i + 1));

	const oneOf = (where, item, field, v, list) => { if (v !== undefined && !ENUMS[list].includes(v)) err(where, item, `${field}: "${v}" is not one of ${list} (${ENUMS[list].join("|")})`); };

	// ---- video.json ----
	if (!video || typeof video !== "object") { err("video", "-", "video.json is not an object"); return { errors, warnings }; }
	if (!video.id) err("video", "id", "missing id");
	if (!video.look) err("video", "look", "missing look");
	for (const [id, src] of Object.entries(video.images ?? {}))
		if (typeof src !== "string" || !src.startsWith("data:image/")) err("video", `images.${id}`, "image must be a data:image/... URI");

	const shape = (where, item, s) => {
		if (!s || typeof s !== "object") return err(where, item, "shape must be an object");
		if (has(s, "box") && !(Array.isArray(s.box) && s.box.length === 2)) err(where, item, "box must be [w, h]");
		parts(where, item, s.parts);
	};
	const parts = (where, item, list) => {
		if (!Array.isArray(list)) return err(where, item, "parts must be an array");
		list.forEach((p, j) => {
			const kinds = ENUMS.shapeParts.filter((k) => has(p, k));
			if (kinds.length !== 1) return err(where, `${item}.parts[${j}]`, `part needs exactly one of ${ENUMS.shapeParts.join("|")}`);
			if (kinds[0] === "image" && !images.has(p.image)) err(where, `${item}.parts[${j}]`, `unknown image id "${p.image}"`);
			if (kinds[0] === "group") parts(where, `${item}.parts[${j}]`, p.group);
			if (p.anim) anim(where, `${item}.parts[${j}]`, p.anim, Infinity);
		});
	};
	// keyframes [[t, v, ease?], ...]; dur = scene duration (Infinity outside scenes)
	const keys = (where, item, field, kf, dur) => {
		if (!Array.isArray(kf)) return err(where, item, `${field} must be a keyframe list`);
		for (const k of kf) {
			if (!Array.isArray(k) || typeof k[0] !== "number") { err(where, item, `${field}: bad keyframe ${JSON.stringify(k)}`); continue; }
			time(where, item, field, k[0], dur);
			if (k[2] !== undefined && !ENUMS.eases.includes(k[2])) err(where, item, `${field}: ease "${k[2]}" is not one of eases`);
		}
	};
	const anim = (where, item, a, dur) => {
		for (const [k, kf] of Object.entries(a ?? {})) {
			if (!ENUMS.animKeys.includes(k)) err(where, item, `anim.${k}: not one of ${ENUMS.animKeys.join("|")}`);
			keys(where, item, `anim.${k}`, kf, dur);
		}
	};
	const time = (where, item, field, t, dur) => {
		if (typeof t !== "number" || !Number.isFinite(t)) return err(where, item, `${field}: time missing or not a number`);
		if (t < -1e-3 || t > dur + 1e-3) err(where, item, `${field}: t=${t} outside scene 0..${dur}`);
	};

	for (const [id, a] of Object.entries(video.cast ?? {})) {
		const it = `cast.${id}`;
		oneOf("video", it, "build.headShape", a.build?.headShape, "headShape");
		oneOf("video", it, "top.kind", a.top?.kind, "top");
		oneOf("video", it, "top.pattern", a.top?.pattern, "pattern");
		oneOf("video", it, "bottom.kind", a.bottom?.kind, "bottom");
		oneOf("video", it, "hair.style", a.hair?.style, "hair");
		oneOf("video", it, "hat.kind", a.hat?.kind, "hat");
		for (const x of a.acc ?? []) oneOf("video", it, "acc", x, "acc");
		oneOf("video", it, "face.eyes", a.face?.eyes, "eyes");
		oneOf("video", it, "face.mouth", a.face?.mouth, "mouth");
		oneOf("video", it, "face.brows", a.face?.brows, "brows");
		(a.extra ?? []).forEach((e, j) => { oneOf("video", `${it}.extra[${j}]`, "anchor", e.anchor, "anchors"); shape("video", `${it}.extra[${j}]`, e.shape); });
	}
	for (const [id, p] of Object.entries(video.props ?? {})) shape("video", `props.${id}`, p);
	for (const [id, s] of Object.entries(video.sets ?? {})) {
		oneOf("video", `sets.${id}`, "light.rim", s.light?.rim, "rim");
		(s.layers ?? []).forEach((l, j) => { if (l.prop !== undefined) { if (!video.props?.[l.prop]) err("video", `sets.${id}.layers[${j}]`, `unknown prop "${l.prop}"`); } else shape("video", `sets.${id}.layers[${j}]`, l.shape); });
	}

	// ---- scenes.json ----
	if (!Array.isArray(scenes)) { err("scenes", "-", "scenes.json must be an array"); return { errors, warnings }; }
	const lb = 60 * (H / 1080);
	const safe = { x0: 0.06 * W, x1: 0.94 * W, y0: lb + 0.04 * H, y1: H - lb - 0.04 * H };
	const seenN = new Set();

	const item = (sn, it, dur, top) => {
		const id = it?.id ?? "(no id)";
		if (!it || typeof it !== "object") return err(sn, id, "item must be an object");
		if (!it.id) err(sn, id, "item has no id");
		if (!ENUMS.itemTypes.includes(it.type)) return err(sn, id, `type "${it.type}" is not one of itemTypes`);
		for (const k of ["enter", "exit"]) if (it[k]) { oneOf(sn, id, `${k}.how`, it[k].how, "enterExit"); time(sn, id, `${k}.t`, it[k].t, dur); }
		if (it.anim) anim(sn, id, it.anim, dur);
		const need = (f) => { if (it[f] === undefined) err(sn, id, `${it.type} needs "${f}"`); };
		switch (it.type) {
			case "actor":
				if (!cast.has(it.cast)) err(sn, id, `unknown cast id "${it.cast}"`);
				if (it.face !== undefined && ![1, 0, -1].includes(it.face)) err(sn, id, "face must be -1, 0 (front) or 1");
				for (const [j, s] of (it.say ?? []).entries()) { time(sn, id, `say[${j}][0]`, s?.[0], dur); time(sn, id, `say[${j}][1]`, s?.[1], dur); }
				for (const d of it.do ?? []) {
					if (!Array.isArray(d)) { err(sn, id, `do: bad entry ${JSON.stringify(d)}`); continue; }
					const [t, act, args = {}] = d;
					time(sn, id, `do ${act}`, t, dur);
					if (!ENUMS.actions.includes(act)) { err(sn, id, `do: action "${act}" is not one of actions`); continue; }
					if (act === "pose") { if (!ENUMS.poses.includes(args.name)) err(sn, id, `do pose: name "${args.name}" is not one of poses`); }
					if ((act === "walk" || act === "run") && (args.to === undefined || typeof args.dur !== "number")) err(sn, id, `do ${act} needs {to, dur}`);
					if ((act === "walk" || act === "run") && typeof args.dur === "number" && t + args.dur > dur + 1e-3) err(sn, id, `do ${act}: ends at ${t + args.dur}, after scene end ${dur}`);
					if (act === "face") { oneOf(sn, id, "do face.eyes", args.eyes, "eyes"); oneOf(sn, id, "do face.mouth", args.mouth, "mouth"); oneOf(sn, id, "do face.brows", args.brows, "brows"); }
					if (act === "look" && ![1, 0, -1].includes(args.dir)) err(sn, id, "do look: dir must be -1, 0 (front) or 1");
					if (act === "hold") { if (!props.has(args.prop)) err(sn, id, `do hold: unknown prop id "${args.prop}"`); oneOf(sn, id, "do hold.hand", args.hand, "hands"); }
					if (act === "drop") oneOf(sn, id, "do drop.hand", args.hand, "hands");
				}
				break;
			case "prop":
				if (it.prop !== undefined) { if (!props.has(it.prop)) err(sn, id, `unknown prop id "${it.prop}"`); }
				else if (it.shape) shape(sn, id, it.shape);
				else err(sn, id, 'prop needs "prop" or "shape"');
				break;
			case "image":
				if (!images.has(it.image)) err(sn, id, `unknown image id "${it.image}"`);
				oneOf(sn, id, "fit", it.fit, "fit");
				oneOf(sn, id, "frame", it.frame, "frame");
				break;
			case "text": case "label": case "pill": case "tag": case "quote": need("str"); break;
			case "board": (it.items ?? []).forEach((x) => item(sn, x, dur, false)); break;
			case "counter":
				for (const f of ["to", "t0", "t1"]) need(f);
				if (typeof it.t0 === "number") time(sn, id, "t0", it.t0, dur);
				if (typeof it.t1 === "number") time(sn, id, "t1", it.t1, dur);
				if (it.t0 > it.t1) err(sn, id, "t0 after t1");
				break;
			case "card": if (!cast.has(it.cast)) err(sn, id, `unknown cast id "${it.cast}"`); break;
			case "map":
				if (typeof it.outline === "string") oneOf(sn, id, "outline", it.outline, "maps");
				else if (it.outline) shape(sn, id, it.outline);
				for (const [j, r] of (it.routes ?? []).entries()) { time(sn, id, `routes[${j}].t0`, r.t0, dur); time(sn, id, `routes[${j}].t1`, r.t1, dur); }
				break;
			case "arrow":
				need("from"); need("to");
				if (it.t0 !== undefined) time(sn, id, "t0", it.t0, dur);
				if (it.t1 !== undefined) time(sn, id, "t1", it.t1, dur);
				break;
			case "web": {
				const nodes = new Set((it.nodes ?? []).map((n) => n.id));
				for (const n of it.nodes ?? []) if (n.cast !== undefined && !cast.has(n.cast)) err(sn, id, `node ${n.id}: unknown cast id "${n.cast}"`);
				for (const l of it.links ?? []) {
					for (const e of [l?.[0], l?.[1]]) if (!nodes.has(e)) err(sn, id, `link to unknown node "${e}"`);
					if (l?.[2] !== undefined) time(sn, id, "link t", l[2], dur);
				}
				break;
			}
			case "chart":
				oneOf(sn, id, "kind", it.kind, "chart");
				need("data");
				if (it.t0 !== undefined) time(sn, id, "t0", it.t0, dur);
				if (it.t1 !== undefined) time(sn, id, "t1", it.t1, dur);
				break;
			case "split":
				for (const side of ["left", "right"]) if (it[side]) spec(sn, it[side], dur, false); else err(sn, id, `split needs "${side}"`);
				break;
			case "custom": if (typeof it.fn !== "string" || !it.fn) err(sn, id, 'custom needs "fn" (a function name in custom.js)'); break;
		}
		// text width estimate vs safe area: top-level items only (nested ones use local coordinates)
		if (top && it.type in TEXT_TYPES && typeof it.str === "string" && Array.isArray(it.at)) {
			const size = it.size ?? TEXT_TYPES[it.type];
			const w = Math.min(it.str.length * 0.58 * size, it.maxW ?? Infinity);
			const [x, y] = it.at;
			const x0 = it.align === "right" ? x - w : it.align === "left" ? x : x - w / 2; // ponytail: assumes center default; match engine if it differs
			if (x0 < safe.x0 - 0.5 || x0 + w > safe.x1 + 0.5 || y - size / 2 < safe.y0 || y + size / 2 > safe.y1)
				warn(sn, id, `text "${it.str.slice(0, 40)}" (~${Math.round(w)}x${size}px at ${x},${y}) may leave the safe area ${Math.round(safe.x0)}..${Math.round(safe.x1)} x ${Math.round(safe.y0)}..${Math.round(safe.y1)}`);
		}
	};
	const spec = (sn, sp, dur, top) => {
		if (!sp || typeof sp !== "object") return err(sn, "-", "spec must be an object");
		if (sp.set !== undefined && !sets.has(sp.set)) err(sn, "set", `unknown set id "${sp.set}"`);
		if (sp.camera) keys(sn, "camera", "camera", sp.camera, dur);
		for (const s of sp.shake ?? []) time(sn, "shake", "shake t", s?.[0], dur);
		for (const [j, f] of (sp.fx ?? []).entries()) { oneOf(sn, `fx[${j}]`, "kind", f.kind, "fx"); time(sn, `fx[${j}]`, "t", f.t, dur); }
		if (!Array.isArray(sp.items)) return err(sn, "-", "spec.items must be an array");
		const seen = new Set();
		for (const it of sp.items) {
			if (it?.id && seen.has(it.id)) err(sn, it.id, "duplicate item id in scene");
			seen.add(it?.id);
			item(sn, it, dur, top);
		}
	};

	scenes.forEach((s, i) => {
		const sn = s?.n ?? `#${i + 1}`;
		if (typeof s?.n !== "number") err(sn, "-", "scene needs a numeric n");
		else if (seenN.has(s.n)) err(sn, "-", "duplicate scene n");
		seenN.add(s?.n);
		if (!(s?.duration > 0)) return err(sn, "-", "duration must be > 0");
		if (typeof s.start !== "number") err(sn, "-", "start missing");
		if (i === 0 && Math.abs(s.start) > 1e-3) err(sn, "-", `first scene starts at ${s.start}, not 0`);
		const next = scenes[i + 1];
		if (next && typeof next.start === "number" && Math.abs(s.start + s.duration - next.start) > 1e-3)
			err(sn, "-", `not contiguous: ends at ${+(s.start + s.duration).toFixed(3)}, next starts at ${next.start}`);
		spec(sn, s.spec, s.duration, true);
	});
	return { errors, warnings };
}

export const format = ({ errors, warnings }) =>
	[...errors.map((e) => `ERROR scene ${e.scene}  ${e.item}: ${e.msg}`), ...warnings.map((e) => `warn  scene ${e.scene}  ${e.item}: ${e.msg}`),
		`${errors.length} error(s), ${warnings.length} warning(s)`].join("\n");

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const [v, s] = process.argv.slice(2);
	if (!v || !s) { console.error("usage: validate.mjs <video.json> <scenes.json>"); process.exit(2); }
	const r = validate(JSON.parse(readFileSync(v, "utf8")), JSON.parse(readFileSync(s, "utf8")));
	console.log(format(r));
	process.exit(r.errors.length ? 1 : 0);
}
