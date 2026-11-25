// Cross-account sync API (docs/SYNC.md): live file index for skills/style kits, owner preferences, published docs.
// Auth: Bearer <GitHub token> with Write (push) access to SYNC_REPO: the owner or a Write collaborator, the same login
// every machine already uses for git. The repo may be public: read access alone is never enough. CI publishes docs with
// the DOCS_PUBLISH_TOKEN secret, which only works for PUT /sync/docs. Team members without GitHub use an access key
// ("vfk_...", src/access.ts) instead of a GitHub token; managing keys and storage cleanup is owner-only. File bytes never pass through the Worker: clients move them to/from Backblaze B2 with signed links (src/blobs.ts), or GitHub release assets for older entries.

import { checkAccessKey, createKey, listKeys, revokeKey } from "./access";
import { B2_ASSET, b2, blobGc, blobRoute } from "./blobs";
import { constantTimeEqual } from "./db";

const SHA = /^[0-9a-f]{64}$/;
const ROOT = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SCOPE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_CHANGES = 200;
const PAGE = 1000;

type E = Env & { SYNC_REPO?: string };
export type Pref = { id: number; scope: string; text: string; source: string | null; created_at: number; retired_at?: number | null; retired_reason?: string | null };

const bad = (msg: string, status = 400) => Response.json({ error: msg }, { status });

// ---- auth: a token is accepted if it can push to the sync repo (cached per isolate for 10 min)
const authCache = new Map<string, number>();
async function sha256hex(s: string) {
	const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
	return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export async function repoAuth(req: Request, e: E): Promise<boolean> {
	const tok = req.headers.get("Authorization")?.replace(/^(Bearer|token) /i, "") ?? "";
	const repo = e.SYNC_REPO;
	if (!repo || !tok || tok.length > 1024) return false;
	const h = await sha256hex(tok);
	if ((authCache.get(h) ?? 0) > Date.now()) return true;
	const r = await fetch(`https://api.github.com/repos/${repo}`, {
		headers: { Authorization: `Bearer ${tok}`, "User-Agent": "video-factory-sync", Accept: "application/vnd.github+json" },
	});
	if (r.status !== 200) return false;
	const j = (await r.json()) as { permissions?: { push?: boolean } };
	if (j.permissions?.push !== true) return false; // read access is anyone's on a public repo: require Write
	authCache.set(h, Date.now() + 600_000);
	return true;
}

// ---- validation shared with the client's rules (scripts/vf.mjs)
export function validPath(p: unknown): p is string {
	if (typeof p !== "string" || !p || p.length > 1024 || p.startsWith("/") || p.includes("\0") || p.includes("\\")) return false;
	return p.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}
export function validTarget(t: unknown): t is string {
	if (typeof t !== "string" || t.length > 256) return false;
	const m = /^(~\/\.claude\/skills|@repo)\/(.+)$/.exec(t);
	return !!m && validPath(m[2]);
}

// ---- preferences
export async function listPrefs(db: D1Database, all = false): Promise<Pref[]> {
	const r = await db.prepare(`SELECT * FROM prefs ${all ? "" : "WHERE retired_at IS NULL"} ORDER BY scope, id`).all<Pref>();
	return r.results;
}
export async function addPref(db: D1Database, scope: string, text: string, source: string) {
	if (!SCOPE.test(scope)) return { error: 'scope must be "global" or a style id (lowercase letters, digits, dashes)' };
	text = text.trim();
	if (!text || text.length > 2000) return { error: "text must be 1-2000 characters" };
	const dup = await db.prepare("SELECT id FROM prefs WHERE scope = ? AND text = ? AND retired_at IS NULL").bind(scope, text).first<{ id: number }>();
	if (dup) return { id: dup.id, scope, duplicate: true };
	const r = await db
		.prepare("INSERT INTO prefs (scope, text, source, created_at) VALUES (?, ?, ?, ?) RETURNING id")
		.bind(scope, text, source.slice(0, 200), Date.now())
		.first<{ id: number }>();
	return { id: r!.id, scope };
}
export async function retirePref(db: D1Database, id: number, reason: string) {
	const r = await db
		.prepare("UPDATE prefs SET retired_at = ?, retired_reason = ? WHERE id = ? AND retired_at IS NULL")
		.bind(Date.now(), reason.slice(0, 500) || null, id)
		.run();
	return r.meta.changes ? { id, retired: true } : { error: `no active preference ${id}` };
}
/** Active preferences grouped: global first, then one list per scope. */
export function groupPrefs(prefs: Pref[]) {
	const out: Record<string, { id: number; text: string }[]> = {};
	for (const p of prefs) (out[p.scope] ??= []).push({ id: p.id, text: p.text });
	return out;
}

// ---- docs
export async function getDoc(db: D1Database, name: string) {
	return (await db.prepare("SELECT body, sha, updated_at FROM docs WHERE name = ?").bind(name).first<{ body: string; sha: string; updated_at: number }>()) ?? null;
}
export async function docNames(db: D1Database) {
	return (await db.prepare("SELECT name FROM docs ORDER BY name").all<{ name: string }>()).results.map((r) => r.name);
}

// ---- files
type Change = { root: string; path: string; sha: string | null; size?: number; mode?: number; asset?: number | string | null; off?: number | null; prev: string | null };

async function commit(db: D1Database, changes: Change[], by: string) {
	if (!Array.isArray(changes) || !changes.length || changes.length > MAX_CHANGES) return { error: `changes must be 1-${MAX_CHANGES} items` };
	const roots = new Set((await db.prepare("SELECT name FROM sync_roots").all<{ name: string }>()).results.map((r) => r.name));
	const seen = new Set<string>();
	for (const c of changes) {
		if (!roots.has(c.root)) return { error: `unknown root ${c.root}` };
		if (!validPath(c.path)) return { error: `bad path ${JSON.stringify(c.path)}` };
		if (seen.has(c.root + "\0" + c.path)) return { error: `duplicate change for ${c.root}:${c.path}` };
		seen.add(c.root + "\0" + c.path);
		if (c.sha !== null && !(typeof c.sha === "string" && SHA.test(c.sha))) return { error: `bad sha for ${c.path}` };
		if (c.prev !== null && !(typeof c.prev === "string" && SHA.test(c.prev))) return { error: `bad prev for ${c.path}` };
		if (c.sha !== null && !((Number.isInteger(c.asset) && (c.asset as number) >= 0) || (typeof c.asset === "string" && B2_ASSET.test(c.asset)))) return { error: `missing asset for ${c.path}` };
		if (c.sha !== null && !(Number.isInteger(c.size) && (c.size as number) >= 0)) return { error: `bad size for ${c.path}` };
		if (c.off != null && !(Number.isInteger(c.off) && c.off >= 0)) return { error: `bad off for ${c.path}` };
	}
	const cur = await db.batch(changes.map((c) => db.prepare("SELECT sha, size, asset FROM sync_files WHERE root = ? AND path = ?").bind(c.root, c.path)));
	const conflicts = changes.flatMap((c, i) => {
		const row = (cur[i].results[0] ?? null) as { sha: string | null; size: number; asset: number | string | null } | null;
		const now = row?.sha ?? null;
		return now === c.prev ? [] : [{ root: c.root, path: c.path, current: now }];
	});
	if (conflicts.length) return { ok: false, conflicts };
	const t = Date.now();
	const res = await db.batch([
		db.prepare("UPDATE sync_meta SET ver = ver + 1 WHERE id = 1"),
		...changes.map((c) =>
			db
				.prepare(
					`INSERT INTO sync_files (root, path, sha, size, mode, asset, off, ver, updated_at, updated_by)
					 VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT ver FROM sync_meta WHERE id = 1), ?, ?)
					 ON CONFLICT(root, path) DO UPDATE SET sha = excluded.sha, size = excluded.size, mode = excluded.mode,
					   asset = excluded.asset, off = excluded.off, ver = excluded.ver, updated_at = excluded.updated_at, updated_by = excluded.updated_by
					 WHERE sync_files.sha IS ?`,
				)
				.bind(c.root, c.path, c.sha, c.sha === null ? 0 : c.size, (c.mode ?? 0o644) & 0o777, c.sha === null ? null : c.asset, c.sha === null ? null : (c.off ?? null), t, by, c.prev),
		),
	]);
	const ver = (await db.prepare("SELECT ver FROM sync_meta WHERE id = 1").first<{ ver: number }>())!.ver;
	// A guarded write that changed nothing lost a race with another commit after our check: report it as a conflict.
	const raced = changes.filter((_, i) => !res[i + 1].meta.changes).map((c) => ({ root: c.root, path: c.path, current: "changed" }));
	return raced.length ? { ok: false, ver, conflicts: raced, applied: changes.length - raced.length } : { ok: true, ver, applied: changes.length };
}

async function files(db: D1Database, q: URLSearchParams) {
	const since = Math.max(0, Number(q.get("since")) || 0);
	const [cv, cr] = (q.get("after") ?? "").split(":").map(Number);
	const limit = Math.min(PAGE, Math.max(1, Number(q.get("limit")) || PAGE));
	const head = (await db.prepare("SELECT ver FROM sync_meta WHERE id = 1").first<{ ver: number }>())!.ver;
	const rows = cv
		? await db
				.prepare("SELECT rowid AS rid, root, path, sha, size, mode, asset, off, ver FROM sync_files WHERE ver > ? AND (ver > ? OR (ver = ? AND rowid > ?)) ORDER BY ver, rowid LIMIT ?")
				.bind(since, cv, cv, cr || 0, limit)
				.all()
		: await db.prepare("SELECT rowid AS rid, root, path, sha, size, mode, asset, off, ver FROM sync_files WHERE ver > ? ORDER BY ver, rowid LIMIT ?").bind(since, limit).all();
	return { head, rows: rows.results, more: rows.results.length === limit };
}

// Owner-only actions (access keys, storage cleanup): a GitHub token whose user is ALLOWED_GITHUB_LOGIN.
const ownerCache = new Map<string, number>();
async function ownerAuth(tok: string, e: E): Promise<boolean> {
	if (!tok || tok.startsWith("vfk_")) return false;
	const h = await sha256hex(tok);
	if ((ownerCache.get(h) ?? 0) > Date.now()) return true;
	const r = await fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${tok}`, "User-Agent": "video-factory-sync", Accept: "application/vnd.github+json" } });
	if (r.status !== 200) return false;
	const login = ((await r.json()) as { login?: string }).login ?? "";
	if (login.toLowerCase() !== String(e.ALLOWED_GITHUB_LOGIN ?? "").toLowerCase()) return false;
	ownerCache.set(h, Date.now() + 600_000);
	return true;
}

export async function syncRoute(req: Request, e: E): Promise<Response> {
	const url = new URL(req.url);
	const p = url.pathname;
	const docsToken = (e as unknown as Record<string, string | undefined>).DOCS_PUBLISH_TOKEN;
	const tok = req.headers.get("Authorization")?.replace(/^(Bearer|token) /i, "") ?? "";
	const ciDocs = p === "/sync/docs" && req.method === "PUT" && !!docsToken && constantTimeEqual(tok, docsToken);
	const keyUser = tok.startsWith("vfk_") ? await checkAccessKey(e.DB, tok) : null;
	if (!ciDocs && !keyUser && !(await repoAuth(req, e))) return bad("unauthorized: send your access key, or a GitHub token with Write access to the sync repo", 401);
	const ownerOnly = async () => !keyUser && !ciDocs && (await ownerAuth(tok, e));
	const db = e.DB;
	const by = (req.headers.get("X-VF-Client") ?? "unknown").slice(0, 120);
	const body = async () => {
		try {
			return (await req.json()) as Record<string, unknown>;
		} catch {
			return {} as Record<string, unknown>;
		}
	};
	try {
		if (p === "/sync/info" && req.method === "GET") return Response.json({ storage: b2(e) ? "b2" : "github", user: keyUser ? `key:${keyUser.name}` : "github" });
		if (p.startsWith("/sync/blob/")) return blobRoute(req, b2(e), p.slice("/sync/blob/".length).split("/"));
		if (p === "/sync/blobs/gc" && req.method === "POST") {
			if (!(await ownerOnly())) return bad("owner only", 403);
			const s = b2(e);
			if (!s) return bad("file storage (Backblaze B2) is not configured", 503);
			const b = await body();
			return Response.json(await blobGc(db, s, Number(b.days ?? 30), b.dry !== false));
		}
		if (p === "/sync/access" || p === "/sync/access/revoke") {
			if (!(await ownerOnly())) return bad("owner only", 403);
			if (req.method === "GET") return Response.json({ keys: await listKeys(db) });
			const b = await body();
			const r = p === "/sync/access" ? await createKey(db, String(b.name ?? "").trim()) : await revokeKey(db, String(b.name ?? ""));
			return "error" in r ? bad(r.error!) : Response.json(r);
		}
		if (p === "/sync/roots" && req.method === "GET") {
			const r = await db.prepare("SELECT name, target, exclude_json FROM sync_roots ORDER BY name").all<{ name: string; target: string; exclude_json: string }>();
			return Response.json({ roots: r.results.map((x) => ({ name: x.name, target: x.target, exclude: JSON.parse(x.exclude_json) })) });
		}
		if (p === "/sync/roots" && req.method === "PUT") {
			const b = await body();
			const exclude = Array.isArray(b.exclude) ? b.exclude : [];
			if (!ROOT.test(String(b.name))) return bad("name must match " + ROOT);
			if (!validTarget(b.target)) return bad('target must be "~/.claude/skills/<dir>" or "@repo/<dir>"');
			if (exclude.length > 50 || !exclude.every((x) => typeof x === "string" && x.length > 0 && x.length <= 100)) return bad("exclude: up to 50 patterns");
			await db
				.prepare("INSERT INTO sync_roots (name, target, exclude_json, updated_at, updated_by) VALUES (?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET target = excluded.target, exclude_json = excluded.exclude_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by")
				.bind(b.name, b.target, JSON.stringify(exclude), Date.now(), by)
				.run();
			return Response.json({ ok: true });
		}
		if (p === "/sync/roots" && req.method === "DELETE") {
			const name = url.searchParams.get("name") ?? "";
			await db.batch([db.prepare("DELETE FROM sync_roots WHERE name = ?").bind(name), db.prepare("DELETE FROM sync_files WHERE root = ?").bind(name)]);
			return Response.json({ ok: true }); // machines keep their local copy; nothing syncs for this root any more
		}
		if (p === "/sync/files" && req.method === "GET") return Response.json(await files(db, url.searchParams));
		if (p === "/sync/commit" && req.method === "POST") {
			const r = await commit(db, (await body()).changes as Change[], by);
			return "error" in r ? bad(r.error!) : Response.json(r, { status: r.ok ? 200 : 409 });
		}
		if (p === "/sync/prefs" && req.method === "GET") return Response.json({ prefs: await listPrefs(db, url.searchParams.get("all") === "1") });
		if (p === "/sync/prefs" && req.method === "POST") {
			const b = await body();
			const r = await addPref(db, String(b.scope ?? ""), String(b.text ?? ""), `cli:${by}`);
			return "error" in r ? bad(r.error!) : Response.json(r);
		}
		if (p === "/sync/prefs/retire" && req.method === "POST") {
			const b = await body();
			const r = await retirePref(db, Number(b.id), String(b.reason ?? ""));
			return "error" in r ? bad(r.error!, 404) : Response.json(r);
		}
		if (p === "/sync/docs" && req.method === "PUT") {
			const b = await body();
			const docs = b.docs as { name: string; body: string }[];
			if (!Array.isArray(docs) || docs.length > 80) return bad("docs: up to 80 items");
			for (const d of docs) if (!validPath(d?.name) || typeof d.body !== "string" || d.body.length > 400_000) return bad(`bad doc ${d?.name}`);
			const t = Date.now();
			const stmts = [];
			for (const d of docs) {
				const sha = await sha256hex(d.body);
				stmts.push(db.prepare("INSERT INTO docs (name, body, sha, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET body = excluded.body, sha = excluded.sha, updated_at = excluded.updated_at WHERE docs.sha != excluded.sha").bind(d.name, d.body, sha, t));
			}
			// prune: docs no longer in git main disappear (the publisher always sends the full set)
			if (b.prune === true) {
				const keep = new Set(docs.map((d) => d.name));
				for (const n of await docNames(db)) if (!keep.has(n)) stmts.push(db.prepare("DELETE FROM docs WHERE name = ?").bind(n));
			}
			if (stmts.length) await db.batch(stmts);
			return Response.json({ ok: true, docs: docs.length });
		}
		return bad("not found", 404);
	} catch (err) {
		console.error("sync", p, err);
		return bad("internal error", 500);
	}
}
