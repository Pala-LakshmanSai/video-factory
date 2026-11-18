#!/usr/bin/env node
// vf: Video Factory cross-account sync (docs/SYNC.md).
//
// What syncs where:
//   git (this repo)         code, registry styles, docs, CLAUDE.md, prompts            -> git pull (fast-forward only)
//   Worker /sync/* + D1     live index of synced files, owner preferences, live docs   -> this tool
//   GitHub release assets   file bytes of skills + style kits (content-addressed)      -> this tool
// One credential everywhere: your GitHub login (gh auth login). No other secrets.
//
// Commands: setup | pull | push | status | track | untrack | resolve | repack | gc | prefs | pref add|retire | docs publish | hook session-start|stop
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync, closeSync, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, openAsBlob, openSync,
	readFileSync, readSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CFG = JSON.parse(readFileSync(join(REPO, ".vf/config.json"), "utf8")); // { api, repo }
// Git worktrees (parallel Claude sessions) share the main checkout's synced folders, state and lock.
const MAIN = (() => {
	try {
		const common = execFileSync("git", ["-C", REPO, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		return common.endsWith(`${sep}.git`) ? dirname(common) : REPO;
	} catch {
		return REPO;
	}
})();
const LOCAL = join(MAIN, ".vf/local"); // gitignored: state, hash cache, lock, logs
const STATE_F = join(LOCAL, "state.json");
const CACHE_F = join(LOCAL, "hash-cache.json");
const LOCK_F = join(LOCAL, "lock");
const LAST_F = join(LOCAL, "last.json");
const LOG_F = join(LOCAL, "sync.log");
const CLIENT = `${hostname()}/${userInfo().username}`;
const DEFAULT_EXCLUDE = [".git", "node_modules", ".venv", "venv", "__pycache__", "*.pyc", ".DS_Store", "._*", ".vf-tmp-*", "Thumbs.db"];
const MAX_FILE = 1_900_000_000; // GitHub release asset limit is 2 GiB
const PAR = 8; // parallel transfers
const CHUNK = 100; // changes per commit (each is one row write on the server)
mkdirSync(LOCAL, { recursive: true });

// ---------------------------------------------------------------- small helpers
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f, d) => (argv.indexOf(f) >= 0 ? argv[argv.indexOf(f) + 1] : d);
let QUIET = flag("--quiet");
const say = (...a) => QUIET || console.log(...a);
const warn = (...a) => console.error(...a);
const readJson = (f, d) => {
	try {
		return JSON.parse(readFileSync(f, "utf8"));
	} catch {
		return d;
	}
};
const writeJson = (f, o) => {
	const tmp = `${f}.tmp-${process.pid}`;
	writeFileSync(tmp, JSON.stringify(o));
	renameSync(tmp, f);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtB = (n) => (n > 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.ceil(n / 1e3)} KB`);
const keyOf = (root, path) => `${root}\u0000${path}`;
const splitKey = (k) => k.split("\u0000");

async function pool(items, n, fn) {
	let i = 0;
	const errs = [];
	await Promise.all(
		Array.from({ length: Math.min(n, items.length) }, async () => {
			while (i < items.length) {
				const it = items[i++];
				try {
					await fn(it);
				} catch (e) {
					errs.push([it, e]);
				}
			}
		}),
	);
	return errs;
}

// ---------------------------------------------------------------- auth + HTTP
let TOKEN;
function token() {
	if (TOKEN) return TOKEN;
	TOKEN = process.env.VF_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
	if (!TOKEN) {
		try {
			TOKEN = execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		} catch {}
	}
	if (!TOKEN) throw new Error("no GitHub token: run `gh auth login` (or set GH_TOKEN)");
	return TOKEN;
}

async function retry(fn, what, tries = 4) {
	let waited = 0;
	for (let a = 1; ; a++) {
		try {
			return await fn();
		} catch (e) {
			// GitHub rate limits: wait as long as GitHub says (up to 30 min in total), then carry on
			if (e.waitMs && waited < 30 * 60_000) {
				const ms = Math.min(e.waitMs, 30 * 60_000 - waited);
				warn(`GitHub rate limit; waiting ${Math.ceil(ms / 1000)} s before continuing`);
				await sleep(ms);
				waited += ms;
				a--;
				continue;
			}
			if (a >= tries || e.noRetry) throw e;
			await sleep(500 * 2 ** a);
		}
	}
}
function rateLimitWait(r) {
	const after = Number(r.headers.get("retry-after"));
	if (after > 0) return after * 1000 + 1000;
	if (r.headers.get("x-ratelimit-remaining") === "0") return Math.max(5_000, Number(r.headers.get("x-ratelimit-reset")) * 1000 - Date.now() + 2000);
	return 60_000; // secondary limit without a hint: GitHub asks for at least a minute
}

async function api(method, path, body) {
	return retry(async () => {
		const r = await fetch(CFG.api + path, {
			method,
			headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json", "X-VF-Client": CLIENT },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(60_000),
		});
		const j = await r.json().catch(() => ({}));
		if (r.status >= 500) throw new Error(`${method} ${path}: ${r.status}`);
		if (r.status === 401) throw Object.assign(new Error("sync API refused the GitHub token (needs read access to " + CFG.repo + ")"), { noRetry: true });
		return { status: r.status, json: j };
	}, path);
}

async function gh(method, url, { body, headers = {}, raw = false } = {}) {
	return retry(async () => {
		const r = await fetch(url.startsWith("http") ? url : `https://api.github.com${url}`, {
			method,
			headers: { Authorization: `Bearer ${token()}`, Accept: "application/vnd.github+json", "User-Agent": "vf-sync", "X-GitHub-Api-Version": "2022-11-28", ...headers },
			body,
			duplex: body instanceof ReadableStream ? "half" : undefined,
			redirect: "manual",
			signal: AbortSignal.timeout(30 * 60_000),
		});
		if (r.status >= 500) throw new Error(`${method} ${url}: ${r.status}`);
		if (r.status === 429 || (r.status === 403 && /rate limit/i.test(await r.clone().text()))) {
			await r.body?.cancel();
			throw Object.assign(new Error(`${method} ${url}: rate limited`), { waitMs: rateLimitWait(r) });
		}
		if (raw) return r;
		const j = await r.json().catch(() => null);
		return { status: r.status, json: j, link: r.headers.get("link") };
	}, url);
}

async function ghAll(path) {
	const out = [];
	for (let url = path + (path.includes("?") ? "&" : "?") + "per_page=100"; url; ) {
		const r = await gh("GET", url);
		if (r.status !== 200) throw new Error(`GET ${url}: ${r.status} ${JSON.stringify(r.json)?.slice(0, 200)}`);
		out.push(...r.json);
		url = /<([^>]+)>;\s*rel="next"/.exec(r.link ?? "")?.[1];
	}
	return out;
}

// ---------------------------------------------------------------- blob store: draft GitHub releases vf-blobs-0..f
let RELS; // Promise<Map<shard name, release id>>
const CREATING = new Map();
async function releaseFor(sha) {
	const name = `vf-blobs-${sha[0]}`;
	RELS ??= ghAll(`/repos/${CFG.repo}/releases`).then((all) => {
		const m = new Map();
		for (const r of all.filter((r) => r.name?.startsWith("vf-blobs-")).sort((a, b) => a.id - b.id)) if (!m.has(r.name)) m.set(r.name, r.id);
		return m;
	});
	const rels = await RELS;
	if (rels.has(name)) return rels.get(name);
	// one creation per shard even with many parallel uploads
	if (!CREATING.has(name))
		CREATING.set(name, (async () => {
			const r = await gh("POST", `/repos/${CFG.repo}/releases`, {
				body: JSON.stringify({ tag_name: name, name, draft: true, body: "Video Factory sync blobs, managed by scripts/vf.mjs (docs/SYNC.md). Do not edit or publish." }),
			});
			if (r.status !== 201) throw new Error(`create release ${name}: ${r.status} ${JSON.stringify(r.json)}`);
			rels.set(name, r.json.id);
			return r.json.id;
		})());
	return CREATING.get(name);
}

/** All blob assets across every vf-blobs-* release (duplicates of a shard included). */
async function allAssets() {
	const rels = (await ghAll(`/repos/${CFG.repo}/releases`)).filter((r) => r.name?.startsWith("vf-blobs-"));
	return (await Promise.all(rels.map(async (r) => (await ghAll(`/repos/${CFG.repo}/releases/${r.id}/assets`)).map((a) => ({ ...a, release: r.id }))))).flat();
}

async function uploadBlob(abs, sha, size) {
	if (size === 0) return 0;
	const rel = await releaseFor(sha);
	const r = await gh("POST", `https://uploads.github.com/repos/${CFG.repo}/releases/${rel}/assets?name=${sha}`, {
		body: await openAsBlob(abs),
		headers: { "Content-Type": "application/octet-stream" },
	});
	if (r.status === 201) {
		if (r.json.size !== size) throw new Error(`upload size mismatch for ${abs}`);
		return r.json.id;
	}
	if (r.status === 422) {
		// already uploaded earlier (e.g. a push that died before committing): reuse it
		const a = (await allAssets()).find((x) => x.name === sha && x.release === rel);
		if (a && a.size === size && a.state === "uploaded") return a.id;
		if (a) await gh("DELETE", `/repos/${CFG.repo}/releases/assets/${a.id}`); // half-uploaded leftover
		throw new Error(`asset ${sha} was in a bad state; retry the push`);
	}
	throw new Error(`upload ${abs}: ${r.status} ${JSON.stringify(r.json)?.slice(0, 300)}`);
}

async function fetchAsset(asset, dest) {
	await retry(async () => {
		const r = await gh("GET", `/repos/${CFG.repo}/releases/assets/${asset}`, { headers: { Accept: "application/octet-stream" }, raw: true });
		let body = r;
		// the redirect goes to signed storage: follow it without our GitHub token
		if (r.status === 302 || r.status === 301) body = await fetch(r.headers.get("location"), { signal: AbortSignal.timeout(30 * 60_000) });
		if (body.status !== 200) throw new Error(`download asset ${asset}: ${body.status}`);
		await pipeline(Readable.fromWeb(body.body), createWriteStream(dest));
	}, "download");
}

// Small files travel packed: one release asset holds many files back to back (GitHub limits uploads per hour).
// A pack is fetched once per run into .vf/local/packs/ and members are sliced out by offset.
const PACK_DIR = join(LOCAL, "packs");
const PACK_MAX = 64_000_000;
const BIG = 8_000_000; // files this size or larger get their own asset
const PACKS = new Map();
function packFile(asset) {
	if (!PACKS.has(asset))
		PACKS.set(asset, (async () => {
			mkdirSync(PACK_DIR, { recursive: true });
			const f = join(PACK_DIR, String(asset));
			if (!existsSync(f)) {
				const part = `${f}.part-${process.pid}`;
				await fetchAsset(asset, part);
				renameSync(part, f);
			}
			return f;
		})());
	return PACKS.get(asset);
}
const clearPacks = () => (PACKS.clear(), rmSync(PACK_DIR, { recursive: true, force: true }));

async function downloadBlob(asset, sha, dest, mode, off = null, size = 0) {
	mkdirSync(dirname(dest), { recursive: true });
	const tmp = join(dirname(dest), `.vf-tmp-${randomBytes(6).toString("hex")}`);
	try {
		if (asset === 0) writeFileSync(tmp, "");
		else if (off == null) await fetchAsset(asset, tmp);
		else {
			const pack = await packFile(asset);
			const buf = Buffer.alloc(size);
			const fd = openSync(pack, "r");
			try {
				readSync(fd, buf, 0, size, off);
			} finally {
				closeSync(fd);
			}
			writeFileSync(tmp, buf);
		}
		const got = await hashFile(tmp);
		if (got !== sha) {
			if (off != null) (PACKS.delete(asset), rmSync(join(PACK_DIR, String(asset)), { force: true })); // refetch next time
			throw new Error(`checksum mismatch for ${dest} (asset ${asset})`);
		}
		chmodSync(tmp, mode & 0o111 ? 0o755 : 0o644);
		renameSync(tmp, dest);
	} finally {
		if (existsSync(tmp)) unlinkSync(tmp);
	}
}

// ---------------------------------------------------------------- hashing with a stat cache
const CACHE = readJson(CACHE_F, {});
function hashFile(abs) {
	return new Promise((res, rej) => {
		const h = createHash("sha256");
		createReadStream(abs).on("error", rej).on("data", (d) => h.update(d)).on("end", () => res(h.digest("hex")));
	});
}
async function shaOf(abs, st) {
	st ??= statOrNull(abs);
	if (!st) return null;
	const c = CACHE[abs];
	if (c && c.size === st.size && c.mtime === st.mtimeMs) return c.sha;
	const sha = await hashFile(abs);
	CACHE[abs] = { size: st.size, mtime: st.mtimeMs, sha };
	return sha;
}
function lstatSyncOrNull(p) {
	try {
		return lstatSync(p);
	} catch {
		return null;
	}
}
function statOrNull(abs) {
	try {
		const s = lstatSync(abs);
		return s.isFile() ? s : null;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------- roots
function resolveTarget(t) {
	// Only two places can ever be written: the user's Claude skills folder and this repo (server enforces the same).
	const m = /^(~\/\.claude\/skills|@repo)\/(.+)$/.exec(t);
	if (!m || m[2].split("/").some((s) => !s || s === "." || s === "..")) throw new Error(`refusing root target ${t}`);
	const base = m[1] === "@repo" ? MAIN : join(homedir(), ".claude", "skills");
	return join(base, m[2]);
}
const globRe = (g) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]") + "$");
function excluder(root) {
	const pats = [...DEFAULT_EXCLUDE, ...(root.exclude ?? [])].map((p) => ({ slash: p.includes("/"), re: globRe(p.replace(/\/$/, "")) }));
	return (rel) => {
		const segs = rel.split("/");
		return pats.some((p) => (p.slash ? segs.some((_, i) => p.re.test(segs.slice(0, i + 1).join("/"))) : segs.some((s) => p.re.test(s))));
	};
}
function walk(base, excluded) {
	const out = new Map();
	const skipped = [];
	const rec = (dir, rel) => {
		for (const d of readdirSync(dir, { withFileTypes: true })) {
			const r = rel ? `${rel}/${d.name}` : d.name;
			if (excluded(r)) continue;
			const abs = join(dir, d.name);
			if (d.isSymbolicLink()) skipped.push(r);
			else if (d.isDirectory()) rec(abs, r);
			else if (d.isFile()) out.set(r, abs);
		}
	};
	rec(base, "");
	return { files: out, skipped };
}

// ---------------------------------------------------------------- lock
function lock(wait = false) {
	for (const until = Date.now() + (wait ? 120_000 : 0); ; ) {
		try {
			const fd = openSync(LOCK_F, "wx");
			writeFileSync(fd, String(process.pid));
			closeSync(fd);
			const release = () => {
				try {
					if (readFileSync(LOCK_F, "utf8") === String(process.pid)) unlinkSync(LOCK_F);
				} catch {}
			};
			process.on("exit", release);
			return release;
		} catch {
			const pid = Number(readJson(LOCK_F, 0));
			let alive = false;
			try {
				alive = !!pid && process.kill(pid, 0);
			} catch {}
			if (!alive) {
				try {
					unlinkSync(LOCK_F);
				} catch {}
				continue;
			}
			if (Date.now() > until) return null;
		}
		execFileSync("sleep", ["1"]);
	}
}
const lockBusy = () => {
	if (!existsSync(LOCK_F)) return false;
	try {
		return process.kill(Number(readFileSync(LOCK_F, "utf8")), 0);
	} catch {
		return false;
	}
};

// ---------------------------------------------------------------- git fast-forward
function git(...a) {
	return execFileSync("git", ["-C", REPO, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function gitFastForward() {
	try {
		git("rev-parse", "--abbrev-ref", "@{u}");
	} catch {
		return "git: no upstream branch, skipped";
	}
	try {
		git("fetch", "-q");
		const behind = Number(git("rev-list", "--count", "HEAD..@{u}"));
		const ahead = Number(git("rev-list", "--count", "@{u}..HEAD"));
		if (!behind) return ahead ? `git: ${ahead} local commit(s) not pushed` : "git: up to date";
		if (ahead) return `git: diverged (${ahead} ahead, ${behind} behind): merge or rebase by hand`;
		git("merge", "--ff-only", "-q", "@{u}");
		return `git: fast-forwarded ${behind} commit(s)`;
	} catch (e) {
		return `git: could not fast-forward (${String(e.stderr || e.message).trim().split("\n")[0]})`;
	}
}

// ---------------------------------------------------------------- state
function loadState() {
	const s = readJson(STATE_F, null) ?? { ver: 0, files: {}, conflicts: {}, roots: [] };
	s.conflicts ??= {};
	return s;
}
function saveState(s) {
	writeJson(STATE_F, s);
	writeJson(CACHE_F, CACHE);
}

async function fetchRoots(state) {
	const r = await api("GET", "/sync/roots");
	if (r.status !== 200) throw new Error(`roots: ${r.status}`);
	state.roots = r.json.roots;
	return new Map(state.roots.map((x) => [x.name, x]));
}

// ---------------------------------------------------------------- pull
async function pull(state) {
	const report = { git: gitFastForward(), downloaded: 0, bytes: 0, deleted: 0, conflicts: [], errors: [] };
	const roots = await fetchRoots(state);
	// in a worktree, point its @repo folders (style-kits/) at the main checkout's synced copy
	if (REPO !== MAIN)
		for (const r of roots.values()) {
			const m = /^@repo\/(.+)$/.exec(r.target);
			if (m && !existsSync(join(REPO, m[1])) && !lstatSyncOrNull(join(REPO, m[1]))) {
				mkdirSync(dirname(join(REPO, m[1])), { recursive: true });
				symlinkSync(join(MAIN, m[1]), join(REPO, m[1]));
			}
		}
	const latest = new Map();
	let maxVer = state.ver;
	for (let after = ""; ; ) {
		const r = await api("GET", `/sync/files?since=${state.ver}&limit=1000${after ? `&after=${after}` : ""}`);
		if (r.status !== 200) throw new Error(`files: ${r.status}`);
		for (const row of r.json.rows) latest.set(keyOf(row.root, row.path), row), (maxVer = Math.max(maxVer, row.ver));
		if (!r.json.more) break;
		const last = r.json.rows.at(-1);
		after = `${last.ver}:${last.rid}`;
	}
	const errs = await pool([...latest.values()], PAR, async (r) => {
		const k = keyOf(r.root, r.path);
		const root = roots.get(r.root);
		if (!root) return; // root removed: leave local files alone
		const base = resolveTarget(root.target);
		const abs = join(base, r.path);
		if (!abs.startsWith(base + sep)) throw new Error(`path escapes root: ${r.path}`);
		const old = state.files[k];
		const local = await shaOf(abs);
		const remote = r.sha ? { sha: r.sha, size: r.size, mode: r.mode, asset: r.asset, off: r.off ?? null } : null;
		const set = () => (remote ? (state.files[k] = remote) : delete state.files[k], delete state.conflicts[k]);
		if (local === (r.sha ?? null)) return set(); // already identical
		if ((old?.sha ?? null) === (r.sha ?? null)) return; // remote unchanged since our last sync (e.g. our own commit): local edits wait for push
		const unchangedLocally = local === null ? true : old?.sha === local;
		if (!unchangedLocally) {
			// both sides changed: keep the local file, park the remote copy, wait for `vf resolve`
			state.conflicts[k] = r.sha ?? "deleted";
			report.conflicts.push(`${r.root}:${r.path}`);
			if (remote) await downloadBlob(remote.asset, remote.sha, join(LOCAL, "conflicts", r.root, r.path), remote.mode, remote.off, remote.size).catch(() => {});
			return;
		}
		if (!remote) {
			if (local !== null) {
				unlinkSync(abs);
				delete CACHE[abs];
				pruneDirs(dirname(abs), base);
				report.deleted++;
			}
			return set();
		}
		await downloadBlob(remote.asset, remote.sha, abs, remote.mode, remote.off, remote.size);
		CACHE[abs] = { size: remote.size, mtime: statSync(abs).mtimeMs, sha: remote.sha };
		report.downloaded++;
		report.bytes += remote.size;
		set();
	});
	for (const [r, e] of errs) report.errors.push(`${r.root}:${r.path}: ${e.message}`);
	if (!errs.length) state.ver = maxVer; // a failed file is retried on the next pull
	clearPacks();
	saveState(state);
	return report;
}
function pruneDirs(dir, base) {
	while (dir.startsWith(base + sep)) {
		try {
			rmdirSync(dir); // only succeeds when empty
		} catch {
			return;
		}
		dir = dirname(dir);
	}
}
/** sha -> where its bytes already are ({asset, off}); lets identical content be committed without re-uploading. */
function assetIndex(state) {
	const m = new Map();
	for (const f of Object.values(state.files)) if (f.sha && f.asset != null) m.set(f.sha, { asset: f.asset, off: f.off ?? null });
	return m;
}

// ---------------------------------------------------------------- local changes
async function localChanges(state, roots, { allowMassDelete = false } = {}) {
	const changes = [];
	const notes = [];
	for (const root of roots.values()) {
		const base = resolveTarget(root.target);
		const known = Object.entries(state.files).filter(([k]) => splitKey(k)[0] === root.name);
		if (!existsSync(base)) {
			// never treat a missing folder (unmounted drive, not installed yet) as "delete everything"
			if (known.length) notes.push(`${root.name}: ${base} is missing; run \`vf pull\` to restore it (nothing pushed)`);
			continue;
		}
		const excluded = excluder(root);
		const { files, skipped } = walk(base, excluded);
		if (skipped.length) notes.push(`${root.name}: skipped ${skipped.length} symlink(s), e.g. ${skipped[0]}`);
		const rootChanges = [];
		await pool([...files], PAR, async ([rel, abs]) => {
			const k = keyOf(root.name, rel);
			if (state.conflicts[k]) return;
			const st = statOrNull(abs);
			if (!st) return;
			if (st.size > MAX_FILE) return void notes.push(`${root.name}:${rel} is over 1.9 GB, not synced`);
			const sha = await shaOf(abs, st);
			const old = state.files[k];
			if (old?.sha !== sha) rootChanges.push({ root: root.name, path: rel, sha, size: st.size, mode: st.mode & 0o111 ? 0o755 : 0o644, prev: old?.sha ?? null, abs });
		});
		const deletes = known.filter(([k, f]) => f.sha && !files.has(splitKey(k)[1]) && !excluded(splitKey(k)[1]) && !state.conflicts[k]);
		if (deletes.length > 20 && deletes.length > known.length / 2 && !allowMassDelete) {
			notes.push(`${root.name}: ${deletes.length} of ${known.length} files are gone locally; refusing to delete them everywhere (use --allow-mass-delete if intended)`);
		} else for (const [k, f] of deletes) rootChanges.push({ root: root.name, path: splitKey(k)[1], sha: null, prev: f.sha });
		changes.push(...rootChanges.sort((a, b) => a.path.localeCompare(b.path)));
	}
	return { changes, notes };
}

// ---------------------------------------------------------------- push
async function push(state, opts = {}) {
	const pr = await pull(state);
	const roots = new Map(state.roots.map((x) => [x.name, x]));
	if (opts.only) for (const n of [...roots.keys()]) if (n !== opts.only) roots.delete(n);
	const { changes, notes } = await localChanges(state, roots, opts);
	const report = { pull: pr, uploaded: 0, bytes: 0, committed: 0, notes, conflicts: [], errors: [] };
	if (!changes.length) return saveState(state), report;
	const assets = assetIndex(state);
	const need = [...new Map(changes.filter((c) => c.sha && !assets.has(c.sha)).map((c) => [c.sha, c])).values()];
	const total = need.reduce((a, c) => a + c.size, 0);
	if (need.length) say(`uploading ${need.length} file(s), ${fmtB(total)}`);
	await uploadAll(need, assets, report, total);
	await commitChanges(state, changes, assets, report);
	if (report.conflicts.length) {
		// someone else changed these first: pull marks real conflicts (or no-ops when identical) for `vf resolve`
		await pull(state);
	}
	writeJson(LAST_F, { at: Date.now(), kind: "push", ...summary(state, report) });
	return report;
}

/** Upload file bytes: big files one asset each, small files packed into ~64 MB assets (GitHub limits uploads per hour). */
async function uploadAll(need, assets, report, total) {
	// big files: one asset each; small files: packed into ~64 MB assets (few uploads, GitHub rate limits)
	const big = need.filter((c) => c.size >= BIG);
	const small = need.filter((c) => c.size < BIG);
	const groups = [];
	for (const c of small) {
		if (c.size === 0) (assets.set(c.sha, { asset: 0, off: null }), report.uploaded++);
		else if (!groups.length || groups.at(-1).size + c.size > PACK_MAX) groups.push({ size: c.size, items: [c] });
		else (groups.at(-1).size += c.size), groups.at(-1).items.push(c);
	}
	const progress = (n, b) => {
		report.uploaded += n;
		report.bytes += b;
		if (!QUIET) say(`  ${report.uploaded}/${need.length} files (${fmtB(report.bytes)} of ${fmtB(total)})`);
	};
	const upErr = [];
	upErr.push(...(await pool(groups, 3, async (g) => {
		const parts = [];
		const members = [];
		let off = 0;
		for (const c of g.items) {
			const buf = readFileSync(c.abs);
			if (buf.length !== c.size || createHash("sha256").update(buf).digest("hex") !== c.sha) {
				report.errors.push(`${c.root}:${c.path}: file changed while uploading; will retry next push`);
				continue;
			}
			parts.push(buf);
			members.push([c, off]);
			off += buf.length;
		}
		if (!members.length) return;
		const body = Buffer.concat(parts);
		mkdirSync(PACK_DIR, { recursive: true });
		const f = join(PACK_DIR, `up-${randomBytes(6).toString("hex")}`);
		writeFileSync(f, body);
		try {
			const id = await uploadBlob(f, createHash("sha256").update(body).digest("hex"), body.length);
			for (const [c, o] of members) assets.set(c.sha, { asset: id, off: o });
			progress(members.length, body.length);
		} finally {
			rmSync(f, { force: true });
		}
	})).map(([g, e]) => [g.items[0], e]));
	upErr.push(...(await pool(big, 4, async (c) => {
		const id = await uploadBlob(c.abs, c.sha, c.size);
		const st = statOrNull(c.abs);
		if (!st || st.size !== c.size || (await shaOf(c.abs, st)) !== c.sha) throw new Error("file changed while uploading; will retry next push");
		assets.set(c.sha, { asset: id, off: null });
		progress(1, c.size);
	})));
	for (const [c, e] of upErr) report.errors.push(`${c.root}:${c.path}: ${e.message}`);
}

/** Commit changes to the index in chunks; updates state for every change the server accepted. */
async function commitChanges(state, changes, assets, report) {
	const ready = changes.filter((c) => c.sha === null || assets.has(c.sha));
	for (let i = 0; i < ready.length; i += CHUNK) {
		const chunk = ready.slice(i, i + CHUNK).map(({ abs, ...c }) => (c.sha ? { ...c, ...assets.get(c.sha) } : c));
		const r = await api("POST", "/sync/commit", { changes: chunk });
		if (r.status === 400) throw new Error(`commit rejected: ${r.json.error}`);
		const lost = new Set((r.json.conflicts ?? []).map((x) => keyOf(x.root, x.path)));
		for (const c of chunk) {
			const k = keyOf(c.root, c.path);
			if (r.status === 200 || (r.json.applied && !lost.has(k))) {
				if (c.sha) state.files[k] = { sha: c.sha, size: c.size, mode: c.mode, asset: c.asset, off: c.off ?? null };
				else delete state.files[k];
				report.committed++;
			} else if (lost.has(k)) report.conflicts.push(`${c.root}:${c.path}`);
		}
		saveState(state);
	}
}

function summary(state, rep) {
	return { ver: state.ver, conflicts: Object.keys(state.conflicts).map((k) => splitKey(k).join(":")), errors: rep.errors ?? [], git: rep.git ?? rep.pull?.git };
}

// ---------------------------------------------------------------- preferences + docs
async function prefsText() {
	const r = await api("GET", "/sync/prefs");
	if (r.status !== 200) throw new Error(`prefs: ${r.status}`);
	const by = {};
	for (const p of r.json.prefs) (by[p.scope] ??= []).push(p);
	const scopes = Object.keys(by).sort((a, b) => (a === "global" ? -1 : b === "global" ? 1 : a.localeCompare(b)));
	if (!scopes.length) return "(no owner preferences saved yet)";
	return scopes.map((s) => `${s}:\n` + by[s].map((p) => `  #${p.id} ${p.text}`).join("\n")).join("\n");
}

async function publishDocs() {
	const list = ["PROJECT_INSTRUCTIONS.md", "CONTRACT.md", "KIT_WORKFLOW.md", "ENGINE_FLAT2D.md", "SYNC.md"]
		.filter((f) => existsSync(join(REPO, "docs", f)))
		.map((f) => ({ name: f, body: readFileSync(join(REPO, "docs", f), "utf8") }));
	list.push({ name: "install.sh", body: readFileSync(join(REPO, "scripts", "install.sh"), "utf8") }); // served at GET /install
	for (const sub of ["styles", "prompts"]) {
		const d = join(REPO, "docs", sub);
		if (existsSync(d)) for (const f of readdirSync(d).filter((x) => x.endsWith(".md"))) list.push({ name: `${sub}/${f}`, body: readFileSync(join(d, f), "utf8") });
	}
	const r = await api("PUT", "/sync/docs", { docs: list, prune: true });
	if (r.status !== 200) throw new Error(`docs publish: ${r.status} ${JSON.stringify(r.json)}`);
	return list.length;
}

// ---------------------------------------------------------------- setup (new machine / new account)
function have(cmd, args = ["--version"]) {
	try {
		execFileSync(cmd, args, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}
function npmCi(dir) {
	say(`  npm ci in ${dir}`);
	execFileSync("npm", ["ci", "--no-audit", "--no-fund", ...(dir.endsWith("control-plane") ? ["--legacy-peer-deps"] : [])], { cwd: dir, stdio: QUIET ? "ignore" : "inherit" });
}
// Big per-machine downloads the skills need (not synced: they are public and large). Each is skipped when present.
async function fetchTo(url, dest, minBytes) {
	if (existsSync(dest) && statSync(dest).size >= minBytes) return false;
	mkdirSync(dirname(dest), { recursive: true });
	say(`  downloading ${url.split("/").at(-1)}...`);
	execFileSync("curl", ["-fL", "--retry", "3", "-o", `${dest}.part`, url], { stdio: QUIET ? "ignore" : "inherit" });
	if (statSync(`${dest}.part`).size < minBytes) throw new Error(`${url}: download too small`);
	renameSync(`${dest}.part`, dest);
	return true;
}
async function setupModels(skills) {
	const names = new Set(skills.map((s) => s.split(sep).at(-1)));
	const step = async (what, fn) => {
		try {
			await fn();
		} catch (e) {
			warn(`  ${what} failed: ${e.message.split("\n")[0]}`);
		}
	};
	if (["gta", "aviation", "paper-style"].some((n) => names.has(n)))
		await step("whisper model", () => fetchTo("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin", join(process.env.WHISPER_MODEL ? dirname(process.env.WHISPER_MODEL) : join(homedir(), ".whisper-models"), "ggml-large-v3-turbo.bin"), 1_000_000_000));
	const paper = skills.find((s) => s.endsWith(`${sep}paper-style`));
	if (paper) {
		const kok = process.env.KOKORO_DIR ?? join(homedir(), ".cache", "kokoro");
		const rel = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0";
		await step("kokoro model", () => fetchTo(`${rel}/kokoro-v1.0.onnx`, join(kok, "kokoro-v1.0.onnx"), 300_000_000));
		await step("kokoro voices", () => fetchTo(`${rel}/voices-v1.0.bin`, join(kok, "voices-v1.0.bin"), 20_000_000));
		const venv = join(paper, "audio", ".venv");
		if (!existsSync(join(venv, "bin", "python")))
			await step("paper-style audio venv", () => {
				say("  making paper-style audio venv...");
				execFileSync("uv", ["venv", "--python", "3.12", venv], { stdio: QUIET ? "ignore" : "inherit" });
				execFileSync("uv", ["pip", "install", "kokoro-onnx", "soundfile"], { env: { ...process.env, VIRTUAL_ENV: venv }, stdio: QUIET ? "ignore" : "inherit" });
			});
	}
}
// Registers the factory's MCP connector for every Claude Code session of this user (sign-in happens on first use).
function connectMcp() {
	const claude = [join(homedir(), ".local", "bin", "claude"), "claude"].find((c) => have(c));
	if (!claude) return `claude command not found; later run: claude mcp add --transport http --scope user video-factory ${CFG.api}/mcp`;
	if (have(claude, ["mcp", "get", "video-factory"])) return "already added";
	try {
		execFileSync(claude, ["mcp", "add", "--transport", "http", "--scope", "user", "video-factory", `${CFG.api}/mcp`], { stdio: "ignore" });
		return "added (Claude asks you to sign in with GitHub the first time it uses it; type /mcp if needed)";
	} catch (e) {
		return `could not add (${e.message.split("\n")[0]}); run: claude mcp add --transport http --scope user video-factory ${CFG.api}/mcp`;
	}
}
async function setup(state) {
	const [maj, min] = process.versions.node.split(".").map(Number);
	const checks = [
		["node >= 22.18", maj > 22 || (maj === 22 && min >= 18)],
		["git", have("git")],
		["gh (GitHub CLI) signed in", have("gh", ["auth", "status"])],
		["ffmpeg", have("ffmpeg", ["-version"])],
		["yt-dlp (style refinement)", have("yt-dlp")],
		["python3", have("python3")],
	];
	for (const [n, ok] of checks) say(`${ok ? "ok  " : "MISSING"}  ${n}`);
	if (!checks[2][1]) throw new Error("sign in first: gh auth login");
	say("\nsyncing files (skills + style kits)...");
	const rep = await pull(state);
	say(`  ${rep.git}; ${rep.downloaded} file(s) downloaded (${fmtB(rep.bytes)})${rep.errors.length ? `, ${rep.errors.length} error(s)` : ""}`);
	say("\ninstalling dependencies...");
	for (const d of ["renderer", "control-plane"]) if (!existsSync(join(REPO, d, "node_modules"))) npmCi(join(REPO, d));
	try {
		execFileSync("npx", ["playwright", "install", "chromium-headless-shell"], { cwd: join(REPO, "renderer"), stdio: QUIET ? "ignore" : "inherit" });
	} catch {
		warn("  playwright browser install failed; run `cd renderer && npx playwright install chromium-headless-shell`");
	}
	for (const root of state.roots) {
		const base = resolveTarget(root.target);
		if (!existsSync(base)) continue;
		const ex = excluder(root);
		for (const rel of walk(base, ex).files.keys())
			if (rel.endsWith("package-lock.json") && !existsSync(join(base, dirname(rel), "node_modules"))) {
				try {
					npmCi(join(base, dirname(rel)));
				} catch {
					warn(`  npm ci failed in ${root.name}/${dirname(rel)}`);
				}
			}
	}
	const skills = state.roots.filter((r) => r.target.startsWith("~/.claude/skills/")).map((r) => resolveTarget(r.target));
	say(`\nskills synced: ${skills.map((s) => s.split(sep).at(-1)).join(", ") || "(none)"}`);
	if (!flag("--no-models")) await setupModels(skills);
	const bad = [];
	for (const s of skills.filter((s) => existsSync(join(s, "scripts", "check_setup.py")))) {
		let out;
		try {
			out = execFileSync("python3", [join(s, "scripts", "check_setup.py")], { encoding: "utf8", timeout: 120_000 });
		} catch (e) {
			out = `${e.stdout ?? ""}${e.stderr ?? e.message}`;
		}
		const left = out.split("\n").filter((l) => l.startsWith("MISSING"));
		say(`  ${s.split(sep).at(-1)}: ${left.length ? `${left.length} missing` : "all good"}`);
		for (const l of left) bad.push(`${s.split(sep).at(-1)}: ${l.replace(/^MISSING\s+/, "")}`);
	}
	say(`\nconnector for Claude Code: ${connectMcp()}`);
	say(`\nlive owner preferences:\n${await prefsText()}`);
	if (bad.length) say(`\nstill to fix:\n${bad.map((b) => `  - ${b}`).join("\n")}`);
	else say("\nsetup complete: everything checks out");
	writeJson(LAST_F, { at: Date.now(), kind: "setup", ...summary(state, rep) });
}

// ---------------------------------------------------------------- hooks (Claude Code: .claude/settings.json)
function spawnSelf(args) {
	const out = openSync(LOG_F, "a");
	const p = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], { detached: true, stdio: ["ignore", out, out], cwd: REPO });
	p.unref();
	return p.pid;
}
async function hookSessionStart() {
	// Never block or fail the session: pull in the background, wait up to 40 s, then print the live context.
	let note = "";
	if (!lockBusy()) {
		const pid = spawnSelf(["pull", "--quiet", "--log"]);
		const until = Date.now() + 40_000;
		for (;;) {
			let alive = false;
			try {
				alive = process.kill(pid, 0);
			} catch {}
			if (!alive) break;
			if (Date.now() > until) {
				note = " (still downloading in the background; skills/kits may update during this session)";
				break;
			}
			await sleep(500);
		}
	} else note = " (another sync is running)";
	const last = readJson(LAST_F, {});
	const lines = [`[Video Factory sync] ${last.git ?? ""}; files at version ${last.ver ?? "?"}${note}.`];
	if (last.conflicts?.length) lines.push(`SYNC CONFLICTS (both machines changed these; run \`node scripts/vf.mjs resolve <root:path> --keep local|remote\`): ${last.conflicts.join(", ")}`);
	if (last.errors?.length) lines.push(`Sync errors (${last.errors.length}; details: node scripts/vf.mjs status): ${last.errors.slice(0, 3).map((e) => e.slice(0, 160)).join("; ")}`);
	try {
		lines.push(
			"Owner preferences (LIVE, shared by every Claude account; they override older notes). Save new lasting ones with " +
				'`node scripts/vf.mjs pref add <global|style-id> "<rule>"`, never in local memory:\n' +
				(await prefsText()),
		);
	} catch (e) {
		lines.push(`(could not load live preferences: ${e.message})`);
	}
	console.log(lines.join("\n"));
}
function hookStop() {
	const last = readJson(join(LOCAL, "last-auto.json"), { at: 0 });
	if (lockBusy() || Date.now() - last.at < 90_000) return;
	writeJson(join(LOCAL, "last-auto.json"), { at: Date.now() });
	spawnSelf(["push", "--quiet", "--log", "--auto"]);
}

// ---------------------------------------------------------------- main
async function main() {
	const [cmd, sub] = argv;
	const log = flag("--log");
	if (log) console.log(`--- ${new Date().toISOString()} ${argv.join(" ")}`);
	if (cmd === "hook" && sub === "session-start") return hookSessionStart();
	if (cmd === "hook" && sub === "stop") return hookStop();
	if (cmd === "prefs") return console.log(await prefsText());
	if (cmd === "pref" && sub === "add") {
		const [scope, ...words] = argv.slice(2).filter((a) => !a.startsWith("--"));
		const r = await api("POST", "/sync/prefs", { scope, text: words.join(" ") });
		if (r.status !== 200) throw new Error(r.json.error);
		return console.log(r.json.duplicate ? `already saved as #${r.json.id}` : `saved #${r.json.id} (${scope}); live for every account now`);
	}
	if (cmd === "pref" && sub === "retire") {
		const r = await api("POST", "/sync/prefs/retire", { id: Number(argv[2]), reason: argv.slice(3).join(" ") });
		if (r.status !== 200) throw new Error(r.json.error);
		return console.log(`retired #${argv[2]}`);
	}
	if (cmd === "docs" && sub === "publish") return console.log(`published ${await publishDocs()} doc(s)`);

	const release = lock(!flag("--auto"));
	if (!release) return say("another vf sync is running; try again shortly");
	const state = loadState();
	try {
		if (cmd === "setup") return await setup(state);
		if (cmd === "pull") {
			const r = await pull(state);
			writeJson(LAST_F, { at: Date.now(), kind: "pull", ...summary(state, r) });
			say(`${r.git}\nfiles: version ${state.ver}; ${r.downloaded} downloaded (${fmtB(r.bytes)}), ${r.deleted} deleted`);
			if (r.conflicts.length) warn(`conflicts (local kept, remote copy in .vf/local/conflicts): ${r.conflicts.join(", ")}`);
			if (r.errors.length) (warn(`errors:\n  ${r.errors.join("\n  ")}`), (process.exitCode = 1));
			return;
		}
		if (cmd === "push") {
			const r = await push(state, { allowMassDelete: flag("--allow-mass-delete"), only: opt("--root") });
			say(`${r.pull.git}\nuploaded ${r.uploaded} (${fmtB(r.bytes)}), committed ${r.committed} change(s); files at version ${state.ver}`);
			for (const n of r.notes) warn(`note: ${n}`);
			if (r.conflicts.length) warn(`conflicts (run vf resolve): ${r.conflicts.join(", ")}`);
			if (r.errors.length) (warn(`errors:\n  ${r.errors.join("\n  ")}`), (process.exitCode = 1));
			return;
		}
		if (cmd === "status") {
			const roots = await fetchRoots(state);
			const { changes, notes } = await localChanges(state, roots);
			saveState(state);
			console.log(`server roots: ${[...roots.values()].map((r) => `${r.name} -> ${r.target}`).join(", ") || "(none)"}`);
			console.log(`last synced version ${state.ver}; ${Object.keys(state.files).length} file(s) tracked`);
			for (const c of changes.slice(0, 200)) console.log(`  ${c.sha ? (c.prev ? "modified" : "new     ") : "deleted "} ${c.root}:${c.path}`);
			if (changes.length > 200) console.log(`  ... ${changes.length - 200} more`);
			if (!changes.length) console.log("  no local changes");
			for (const n of notes) console.log(`note: ${n}`);
			for (const k of Object.keys(state.conflicts)) console.log(`CONFLICT ${splitKey(k).join(":")}`);
			return;
		}
		if (cmd === "track") {
			const [name, target] = argv.slice(1).filter((a) => !a.startsWith("--"));
			const exclude = (opt("--exclude", "") || "").split(",").filter(Boolean);
			resolveTarget(target);
			const r = await api("PUT", "/sync/roots", { name, target, exclude });
			if (r.status !== 200) throw new Error(r.json.error);
			const p = await push(state, { only: name });
			return say(`tracking ${name} -> ${target}; uploaded ${p.uploaded} (${fmtB(p.bytes)}), committed ${p.committed}`);
		}
		if (cmd === "repack") {
			// Re-store small files that were uploaded one asset each into packs, so a new machine downloads
			// a few dozen assets instead of thousands (GitHub allows 5000 API calls per hour).
			await pull(state);
			const roots = new Map(state.roots.map((x) => [x.name, x]));
			const items = [];
			for (const [k, f] of Object.entries(state.files)) {
				if (!f.sha || f.off != null || f.asset === 0 || f.size >= BIG || state.conflicts[k]) continue;
				const [rn, path] = splitKey(k);
				if (!roots.has(rn)) continue;
				const abs = join(resolveTarget(roots.get(rn).target), path);
				if ((await shaOf(abs)) === f.sha) items.push({ root: rn, path, sha: f.sha, size: f.size, mode: f.mode, prev: f.sha, abs });
			}
			const need = [...new Map(items.map((c) => [c.sha, c])).values()];
			const report = { uploaded: 0, bytes: 0, committed: 0, conflicts: [], errors: [] };
			const total = need.reduce((a, c) => a + c.size, 0);
			say(`repacking ${items.length} small file(s) (${fmtB(total)})`);
			const assets = new Map();
			await uploadAll(need, assets, report, total);
			await commitChanges(state, items.filter((c) => assets.has(c.sha)), assets, report);
			saveState(state);
			say(`repacked ${report.committed} file(s) into packs; run \`vf gc --days 0 --yes\` later to delete the old single-file copies`);
			if (report.errors.length) (warn(`errors:\n  ${report.errors.slice(0, 20).join("\n  ")}`), (process.exitCode = 1));
			return;
		}
		if (cmd === "gc") {
			// Deletes blob assets no current file uses (old versions, failed pushes) once older than --days (default 30).
			// Keeps release storage far below GitHub's 1000-assets-per-release cap. Old versions are gone after this.
			const days = Number(opt("--days", "30"));
			const used = new Set();
			for (let after = ""; ; ) {
				const r = (await api("GET", `/sync/files?since=0&limit=1000${after ? `&after=${after}` : ""}`)).json;
				for (const row of r.rows) if (row.asset) used.add(row.asset);
				if (!r.more) break;
				after = `${r.rows.at(-1).ver}:${r.rows.at(-1).rid}`;
			}
			const old = (await allAssets()).filter((a) => !used.has(a.id) && Date.now() - Date.parse(a.created_at) > days * 86400_000);
			if (!flag("--yes")) return say(`${old.length} unused asset(s) older than ${days} days (${fmtB(old.reduce((x, a) => x + a.size, 0))}); rerun with --yes to delete`);
			await pool(old, PAR, (a) => gh("DELETE", `/repos/${CFG.repo}/releases/assets/${a.id}`));
			return say(`deleted ${old.length} unused asset(s)`);
		}
		if (cmd === "untrack") {
			const r = await api("DELETE", `/sync/roots?name=${encodeURIComponent(argv[1] ?? "")}`);
			if (r.status !== 200) throw new Error(r.json.error);
			for (const k of Object.keys(state.files)) if (splitKey(k)[0] === argv[1]) delete state.files[k];
			saveState(state);
			return say(`stopped syncing ${argv[1]} (local files kept on every machine)`);
		}
		if (cmd === "resolve") {
			const keep = opt("--keep");
			if (keep !== "local" && keep !== "remote") throw new Error("usage: vf resolve <root:path|--all> --keep local|remote");
			const want = flag("--all") ? Object.keys(state.conflicts) : [keyOf(...argv[1].split(/:(.*)/s).slice(0, 2))];
			const roots = await fetchRoots(state);
			for (const k of want) {
				if (!state.conflicts[k]) continue;
				const [rn, path] = splitKey(k);
				const r = (await api("GET", `/sync/files?since=0&limit=1000`)).json; // small helper fetch: find current row
				let row = r.rows.find((x) => x.root === rn && x.path === path);
				for (let after = r.more ? `${r.rows.at(-1).ver}:${r.rows.at(-1).rid}` : ""; !row && after; ) {
					const n = (await api("GET", `/sync/files?since=0&limit=1000&after=${after}`)).json;
					row = n.rows.find((x) => x.root === rn && x.path === path);
					after = n.more ? `${n.rows.at(-1).ver}:${n.rows.at(-1).rid}` : "";
				}
				const abs = join(resolveTarget(roots.get(rn).target), path);
				if (keep === "remote") {
					if (row?.sha) await downloadBlob(row.asset, row.sha, abs, row.mode, row.off ?? null, row.size);
					else if (existsSync(abs)) unlinkSync(abs);
				}
				if (row?.sha) state.files[k] = { sha: row.sha, size: row.size, mode: row.mode, asset: row.asset, off: row.off ?? null };
				else delete state.files[k];
				delete state.conflicts[k];
				say(`resolved ${rn}:${path} (kept ${keep})`);
			}
			saveState(state);
			if (keep === "local") say("now run `vf push` to send your versions");
			return;
		}
		console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 11).join("\n").replace(/^\/\/ ?/gm, ""));
		console.log("\nsee docs/SYNC.md");
	} finally {
		release();
	}
}

main().catch((e) => {
	warn(`vf: ${e.message}`);
	process.exitCode = 1;
});
