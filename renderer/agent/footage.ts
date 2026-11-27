// Style "footage" (skill styles: doomsday, gta, aviation, paper-style): GET /input/bundle -> download every file
// (sha256-verified, kept across rerenders) -> run the skill's own render command with every vCPU -> the mp4.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { availableParallelism, cpus } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { BundleOut, FootageManifest } from "../../packages/contract/src/index.ts";
import { must } from "../engine/ffmpeg.ts";

const SHA = /^[0-9a-f]{64}$/;
const PAR = 8; // parallel downloads

/** Bundle-relative path that stays inside the bundle (no absolute paths, no "..", no backslashes). */
export function safeRel(p: string): boolean {
	return typeof p === "string" && !!p && !p.startsWith("/") && !p.includes("\\") && !p.includes("\0") && !p.split("/").some((s) => s === ".." || s === "");
}

export function checkManifest(m: FootageManifest): void {
	if (m?.v !== 1) throw new Error("footage bundle rejected: manifest v must be 1");
	if (!Array.isArray(m.cmd) || !m.cmd.length || !m.cmd.every((a) => typeof a === "string")) throw new Error("footage bundle rejected: cmd must be a non-empty argv array");
	for (const p of [m.out, ...Object.keys(m.files ?? {})]) if (!safeRel(p)) throw new Error(`footage bundle rejected: unsafe path "${p}"`);
	if (m.cwd !== "." && !safeRel(m.cwd)) throw new Error(`footage bundle rejected: unsafe cwd "${m.cwd}"`);
	for (const [p, f] of Object.entries(m.files)) if (!SHA.test(f?.sha256) || !(f.size >= 0)) throw new Error(`footage bundle rejected: bad sha256/size for "${p}"`);
}

async function download(url: string, dest: string, sha: string, size: number) {
	const tmp = `${dest}.part`;
	await mkdir(dirname(dest), { recursive: true });
	const res = await fetch(url, { signal: AbortSignal.timeout(30 * 60_000) });
	if (res.status !== 200 || !res.body) throw new Error(`download ${dest}: ${res.status}`);
	const h = createHash("sha256");
	let n = 0;
	await pipeline(Readable.fromWeb(res.body as never), async function* (src) {
		for await (const c of src) {
			h.update(c);
			n += c.length;
			yield c;
		}
	}, createWriteStream(tmp));
	if (n !== size || h.digest("hex") !== sha) throw new Error(`download ${dest}: content does not match the manifest`);
	await rename(tmp, dest);
}

/**
 * Materialize the bundle in `dir`. Files already there from an earlier round (same path + sha) are kept, so a
 * revised bundle only fetches what changed. Links expire after an hour: each retry asks for fresh ones.
 */
export async function fetchBundle(dir: string, get: () => Promise<BundleOut>, have: Map<string, string>, log = console.log): Promise<FootageManifest> {
	for (let attempt = 1; ; attempt++) {
		const { manifest, links } = await get();
		checkManifest(manifest);
		const todo = Object.entries(manifest.files).filter(([p, f]) => have.get(p) !== f.sha256);
		const bytes = todo.reduce((a, [, f]) => a + f.size, 0);
		log(`footage bundle: ${Object.keys(manifest.files).length} files, ${todo.length} to fetch (${(bytes / 1e6).toFixed(0)} MB)`);
		const errs: string[] = [];
		let i = 0;
		await Promise.all(Array.from({ length: Math.min(PAR, todo.length) }, async () => {
			while (i < todo.length) {
				const [p, f] = todo[i++];
				try {
					if (!links[f.sha256]) throw new Error(`no link for ${p}`);
					await download(links[f.sha256], join(dir, p), f.sha256, f.size);
					have.set(p, f.sha256);
				} catch (e) {
					errs.push((e as Error).message);
				}
			}
		}));
		if (!errs.length) return manifest;
		if (attempt >= 3) throw new Error(`footage bundle download failed: ${errs.slice(0, 5).join("; ")}`);
		log(`footage bundle: ${errs.length} downloads failed, retrying with fresh links: ${errs[0]}`);
	}
}

const readOr = (f: string) => { try { return readFileSync(f, "utf8").trim(); } catch { return ""; } };

/**
 * vCPUs this container may use. A RunPod pod sees every host core (os.cpus(): 192 on a 32-vCPU CPU pod) but is
 * limited by its cgroup CPU quota; sizing parallelism from the host count made ffmpeg run 192 workers x 192 threads
 * and die (found live 2026-11-27). Quota (cgroup v2 cpu.max, v1 cfs) -> affinity -> cpus().
 */
export function podVcpus(): number {
	const [q, per] = readOr("/sys/fs/cgroup/cpu.max").split(/\s+/);
	let n = q && q !== "max" ? Number(q) / Number(per) : NaN;
	if (!(n > 0)) {
		const q1 = Number(readOr("/sys/fs/cgroup/cpu/cpu.cfs_quota_us")), p1 = Number(readOr("/sys/fs/cgroup/cpu/cpu.cfs_period_us"));
		n = q1 > 0 && p1 > 0 ? q1 / p1 : NaN;
	}
	return Math.max(1, Math.min(availableParallelism(), Number.isFinite(n) ? Math.ceil(n) : cpus().length));
}

/**
 * Run the manifest's command (argv, no shell) in the bundle with every vCPU the pod has: VF_THREADS = that count,
 * and (Linux) pinned to that many cores with taskset, so ffmpeg/x264/filters size their own threads from it too.
 */
export async function runBundle(dir: string, m: FootageManifest, log = console.log): Promise<string> {
	const out = join(dir, m.out);
	await rm(out, { force: true });
	const n = podVcpus();
	const env = { ...process.env, VF_THREADS: String(n), PYTHONUNBUFFERED: "1" };
	const limits = `vcpus ${n} (host ${cpus().length}), cpu.max "${readOr("/sys/fs/cgroup/cpu.max")}", memory.max "${readOr("/sys/fs/cgroup/memory.max")}", pids.max "${readOr("/sys/fs/cgroup/pids.max")}"`;
	log(`footage render: ${limits}`);
	const pin = n < availableParallelism() && process.platform === "linux" ? ["taskset", "-c", `0-${n - 1}`] : [];
	const argv = [...pin, ...m.cmd];
	let tail = "";
	const code = await new Promise<number>((resolve, reject) => {
		const p = spawn(argv[0], argv.slice(1), { cwd: join(dir, m.cwd), env, stdio: ["ignore", "pipe", "pipe"] });
		const on = (d: Buffer) => {
			tail = (tail + d).slice(-8000);
			for (const l of String(d).split("\n")) if (l.trim()) log(`[${m.skill}] ${l}`);
		};
		p.stdout.on("data", on);
		p.stderr.on("data", on);
		p.on("error", reject);
		p.on("close", (c) => resolve(c ?? -1));
	});
	if (code !== 0) throw new Error(`${m.skill} render exited ${code} (${limits}):\n${tail}`);
	if (!existsSync(out) || !(await stat(out)).size) throw new Error(`${m.skill} render finished but wrote no ${m.out}:\n${tail}`);
	return out;
}

/** `n` evenly spaced 1280 px JPEG frames of the finished video, as preview parts "scene-1-<idx>". */
export async function previewFrames(file: string, seconds: number, dir: string, n = 12): Promise<Map<string, Buffer>> {
	await mkdir(dir, { recursive: true });
	const frames = new Map<string, Buffer>();
	for (let i = 0; i < n; i++) {
		const t = ((i + 0.5) / n) * seconds;
		const jpg = join(dir, `f${i}.jpg`);
		await must("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", t.toFixed(3), "-i", file, "-frames:v", "1", "-vf", "scale=1280:-2", "-q:v", "5", jpg]);
		frames.set(`scene-1-${i}`, await readFile(jpg));
	}
	return frames;
}
