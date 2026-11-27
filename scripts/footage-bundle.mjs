// Footage-job bundles for style "footage" (docs/KIT_WORKFLOW.md "Footage styles on RunPod"): which local files a skill
// render needs, where they sit in the bundle, and the command the pod runs. Used by `vf footage`; no network here.
//
// Bundle layout: job/ (the job folder's files, same relative paths), skill/ (the skill's scripts and assets),
// ext/<hash>/<name> (anything else the edit points at by absolute path). The pod runs cmd with cwd = bundle root.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const inside = (dir, p) => {
	const r = relative(dir, p);
	return r && !r.startsWith("..") && !isAbsolute(r) ? r.split(sep).join("/") : null;
};
const walk = (dir) => readdirSync(dir, { withFileTypes: true, recursive: true }).filter((e) => e.isFile() && !e.name.startsWith(".")).map((e) => join(e.parentPath, e.name));
const probeSeconds = (f) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f], { encoding: "utf8" }).trim());

/** Collects files as {bundle path -> local abs path}; bundle paths for job/skill/other files. */
class Files {
	constructor(job, skill) {
		this.job = job;
		this.skill = skill;
		this.map = new Map();
	}
	/** Add a local file; returns its bundle path. Missing files are an error (the pod would fail later, after renting). */
	add(abs, required = true, as = null) {
		if (!existsSync(abs) || !statSync(abs).isFile()) {
			if (required) throw new Error(`file the edit needs is missing: ${abs}`);
			return null;
		}
		const j = inside(this.job, abs), k = inside(this.skill, abs);
		const rel = as ?? (j ? `job/${j}` : k ? `skill/${k}` : `ext/${createHash("sha256").update(abs).digest("hex").slice(0, 10)}/${basename(abs)}`);
		this.map.set(rel, abs);
		return rel;
	}
	/** Path written into the job's rewritten edit.json for a bundle path (relative to job/). */
	static fromJob = (rel) => (rel.startsWith("job/") ? rel.slice(4) : `../${rel}`);
}

/**
 * Doomsday: everything render_edit.py reads for this edit (header of that script documents edit.json).
 * Returns { manifest (without file hashes), files: Map(bundle path -> abs), edit (rewritten), seconds }.
 */
export function doomsdayBundle(editPath, skillDir = join(homedir(), ".claude/skills/doomsday")) {
	const ej = resolve(editPath), base = dirname(ej), skill = resolve(skillDir);
	const E = JSON.parse(readFileSync(ej, "utf8"));
	const P = (p) => (isAbsolute(String(p)) ? String(p) : resolve(base, String(p)));
	const f = new Files(base, skill);
	const relOf = (abs) => Files.fromJob(f.add(abs));
	const out = { ...E };
	for (const k of ["voice", "words"]) out[k] = relOf(P(E[k]));
	const srcdir = P(E.srcdir);
	if (!inside(base, srcdir)) throw new Error(`srcdir must be inside the job folder (${base}), got ${srcdir}`);
	const outAbs = P(E.out);
	if (!inside(base, outAbs)) throw new Error(`out must be inside the job folder (${base}), got ${outAbs}`);
	const srcs = new Set([...(E.shots ?? []).flatMap((s) => [s.src, s.src2]), ...(E.inserts ?? []).map((s) => s.src)].filter(Boolean));
	for (const s of srcs) {
		if (isAbsolute(s)) throw new Error(`shot src must be a name inside srcdir, got ${s}`);
		f.add(join(srcdir, s));
		f.add(join(srcdir, `${s}.crop`), false); // cached letterbox crop: the pod uses the same crop as the local render
		if (E.catalog) f.add(join(P(E.catalog), s.replace(/\.[^.]+$/, ""), "shots.json"), false);
	}
	if (E.music?.file) out.music = { ...E.music, file: relOf(P(E.music.file)) };
	// sfx: a name under the skill's assets/sfx (shipped below), or an absolute path, which joins them there by name
	out.sfx = (E.sfx ?? []).map((e) => {
		if (!isAbsolute(String(e.file))) return e;
		const name = `ext-${createHash("sha256").update(String(e.file)).digest("hex").slice(0, 8)}-${basename(e.file)}`;
		f.add(String(e.file), true, `skill/assets/sfx/${name}`);
		return { ...e, file: name };
	});
	for (const p of [...walk(join(skill, "scripts")), ...walk(join(skill, "assets/overlays")), ...walk(join(skill, "assets/sfx")), ...walk(join(skill, "assets/fonts"))]) f.add(p);
	const seconds = probeSeconds(P(E.voice)) + (E.inserts ?? []).reduce((a, s) => a + Number(s.dur), 0) + 0.6;
	return {
		manifest: { v: 1, skill: "doomsday", cwd: ".", cmd: ["python3", "skill/scripts/render_edit.py", "job/edit.json"], out: `job/${inside(base, outAbs)}` },
		files: f.map, edit: { path: "job/edit.json", json: out }, seconds: Math.round(seconds * 100) / 100,
	};
}

/**
 * Any other skill (gta, aviation, paper-style, or doomsday by hand): ship a whole folder and run a command in it.
 * cmd is an argv array run from the folder (the bundle's job/); out is the mp4 it writes, relative to the folder.
 */
export function folderBundle(dir, { cmd, out, skill, seconds, exclude = ["node_modules", ".git", "__pycache__", ".DS_Store"] }) {
	const base = resolve(dir), f = new Files(base, base);
	for (const p of walk(base)) if (!relative(base, p).split(sep).some((s) => exclude.includes(s))) f.add(p);
	f.map = new Map([...f.map].map(([rel, abs]) => [`job/${inside(base, abs)}`, abs])); // everything under job/
	return { manifest: { v: 1, skill, cwd: "job", cmd, out: `job/${out}` }, files: f.map, edit: null, seconds: Number(seconds) || (existsSync(join(base, out)) ? probeSeconds(join(base, out)) : 0) };
}

/** The scene_plan submit_job takes for a footage bundle. */
export const footagePlan = (bundleSha, skill, seconds) => ({
	style: "footage", fps: 30, resolution: "1920x1080",
	scenes: [{ n: 1, template: "bundle", props: { bundle: bundleSha, skill }, duration_s: seconds, narration: "", transition: "cut" }],
});
