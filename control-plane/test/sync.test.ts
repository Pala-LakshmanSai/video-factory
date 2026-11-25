// /sync/* (docs/SYNC.md): GitHub-token auth against the private repo, compare-and-set file commits, paging, prefs, docs.
import { beforeEach, describe, expect, it } from "vitest";
import { syncRoute, validPath, validTarget } from "../src/sync";
import { json, makeEnv, mockFetch } from "./helpers";
import { createKey, revokeKey } from "../src/access";

let env: Env;
let canPush = true;
const req = (path: string, init: RequestInit & { json?: unknown } = {}, token = "good") =>
	syncRoute(
		new Request("https://cp.test" + path, {
			method: init.method ?? (init.json ? "POST" : "GET"),
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-VF-Client": "test" },
			body: init.json ? JSON.stringify(init.json) : undefined,
		}),
		env,
	);
const A = "a".repeat(64), B = "b".repeat(64), C = "c".repeat(64);

beforeEach(() => {
	env = { ...makeEnv(), SYNC_REPO: "me/repo" } as Env;
	canPush = true;
	mockFetch((u, i) => {
		if (u === "https://api.github.com/user") return json({ login: new Headers(i.headers).get("Authorization") === "Bearer good" ? "me" : "someone" });
		if (u.startsWith("https://s3.us-west-004.backblazeb2.com/bkt/blobs/")) return new Response(null, { status: u.endsWith("a".repeat(64)) ? 200 : 404, headers: { "Content-Length": "5" } });
		if (u !== "https://api.github.com/repos/me/repo") return undefined;
		const tok = new Headers(i.headers).get("Authorization");
		if (tok === "Bearer good" || tok === "Bearer ci") return json({ private: false, permissions: { pull: true, push: canPush } });
		return tok === "Bearer reader" ? json({ private: false, permissions: { pull: true, push: false } }) : json({ message: "Not Found" }, 404);
	});
});

describe("auth", () => {
	it("needs Write access: rejects missing, unknown and read-only tokens", async () => {
		expect((await req("/sync/roots", {}, "")).status).toBe(401);
		expect((await req("/sync/roots", {}, "bad")).status).toBe(401);
		expect((await req("/sync/roots", {}, "reader")).status).toBe(401);
		canPush = false;
		expect((await req("/sync/roots", {}, "ci")).status).toBe(401);
		canPush = true;
		expect((await req("/sync/roots", {}, "ci")).status).toBe(200);
	});

	it("the CI docs token publishes docs and nothing else", async () => {
		(env as unknown as Record<string, string>).DOCS_PUBLISH_TOKEN = "docs-secret";
		expect((await req("/sync/docs", { method: "PUT", json: { docs: [{ name: "a.md", body: "A" }] } }, "docs-secret")).status).toBe(200);
		expect((await req("/sync/prefs", {}, "docs-secret")).status).toBe(401);
		expect((await req("/sync/roots", { method: "PUT", json: { name: "x", target: "@repo/x" } }, "docs-secret")).status).toBe(401);
		expect((await req("/sync/docs", { method: "PUT", json: { docs: [] } }, "docs-secreT")).status).toBe(401);
	});
});

describe("roots + files", () => {
	beforeEach(async () => {
		expect((await req("/sync/roots", { method: "PUT", json: { name: "gta", target: "~/.claude/skills/gta", exclude: ["node_modules"] } })).status).toBe(200);
	});

	it("validates root targets to the two allowed places", async () => {
		for (const target of ["~/.ssh/x", "/etc/x", "@repo/../x", "~/.claude/skills/", "@repo"]) {
			expect((await req("/sync/roots", { method: "PUT", json: { name: "x", target } })).status).toBe(400);
		}
		expect(validTarget("@repo/style-kits")).toBe(true);
		expect(["a/../b", "/a", "a//b", "./a", ""].map(validPath)).toEqual([false, false, false, false, false]);
	});

	it("commits with compare-and-set, pages changes since a version, tombstones deletes", async () => {
		const c1 = await (await req("/sync/commit", { json: { changes: [
			{ root: "gta", path: "SKILL.md", sha: A, size: 3, mode: 0o644, asset: 11, prev: null },
			{ root: "gta", path: "scripts/run.py", sha: B, size: 5, mode: 0o755, asset: 12, off: 4096, prev: null },
		] } })).json() as { ok: boolean; ver: number };
		expect(c1).toMatchObject({ ok: true, ver: 1 });
		const packed = (await (await req("/sync/files?since=0")).json() as { rows: { path: string; off: number | null }[] }).rows;
		expect(packed.map((r) => [r.path, r.off])).toEqual([["SKILL.md", null], ["scripts/run.py", 4096]]);
		// a second machine still thinks SKILL.md is new: conflict, nothing applied
		const stale = await req("/sync/commit", { json: { changes: [{ root: "gta", path: "SKILL.md", sha: C, size: 1, asset: 13, prev: null }, { root: "gta", path: "x", sha: C, size: 1, asset: 13, prev: null }] } });
		expect(stale.status).toBe(409);
		expect(((await stale.json()) as { conflicts: unknown[] }).conflicts).toEqual([{ root: "gta", path: "SKILL.md", current: A }]);
		const c2 = await (await req("/sync/commit", { json: { changes: [{ root: "gta", path: "SKILL.md", sha: C, size: 1, asset: 13, prev: A }, { root: "gta", path: "scripts/run.py", sha: null, prev: B }] } })).json() as { ver: number };
		expect(c2.ver).toBe(2);
		const all = await (await req("/sync/files?since=0")).json() as { head: number; rows: { path: string; sha: string | null; ver: number }[] };
		expect(all.head).toBe(2);
		expect(all.rows.map((r) => [r.path, r.sha, r.ver])).toEqual([["SKILL.md", C, 2], ["scripts/run.py", null, 2]]);
		const since1 = await (await req("/sync/files?since=2")).json() as { rows: unknown[] };
		expect(since1.rows).toEqual([]);
		// paging: limit 1 then continue after the cursor
		const p1 = await (await req("/sync/files?since=0&limit=1")).json() as { rows: { ver: number; rid: number }[]; more: boolean };
		expect(p1.more).toBe(true);
		const p2 = await (await req(`/sync/files?since=0&limit=1&after=${p1.rows[0].ver}:${p1.rows[0].rid}`)).json() as { rows: { path: string }[] };
		expect(p2.rows.map((r) => r.path)).toEqual(["scripts/run.py"]);
	});

	it("rejects unknown roots, bad paths, duplicates and missing assets", async () => {
		const bad = async (c: Record<string, unknown>) => (await req("/sync/commit", { json: { changes: [c] } })).status;
		expect(await bad({ root: "nope", path: "a", sha: A, size: 1, asset: 1, prev: null })).toBe(400);
		expect(await bad({ root: "gta", path: "../a", sha: A, size: 1, asset: 1, prev: null })).toBe(400);
		expect(await bad({ root: "gta", path: "a", sha: A, size: 1, prev: null })).toBe(400);
		expect(await bad({ root: "gta", path: "a", sha: "zz", size: 1, asset: 1, prev: null })).toBe(400);
		const dup = { root: "gta", path: "a", sha: A, size: 1, asset: 1, prev: null };
		expect((await req("/sync/commit", { json: { changes: [dup, dup] } })).status).toBe(400);
	});
});

describe("prefs + docs", () => {
	it("adds, lists, dedupes and retires preferences", async () => {
		const a = await (await req("/sync/prefs", { json: { scope: "flatglow", text: "bigger titles" } })).json() as { id: number };
		await req("/sync/prefs", { json: { scope: "global", text: "no overlaps" } });
		expect(((await (await req("/sync/prefs", { json: { scope: "flatglow", text: "bigger titles" } })).json()) as { duplicate?: boolean }).duplicate).toBe(true);
		let list = (await (await req("/sync/prefs")).json() as { prefs: { scope: string; text: string }[] }).prefs;
		expect(list.map((p) => `${p.scope}:${p.text}`)).toEqual(["flatglow:bigger titles", "global:no overlaps"]);
		expect((await req("/sync/prefs/retire", { json: { id: a.id, reason: "nope" } })).status).toBe(200);
		expect((await req("/sync/prefs/retire", { json: { id: a.id } })).status).toBe(404);
		list = (await (await req("/sync/prefs")).json() as { prefs: { scope: string }[] }).prefs;
		expect(list.map((p) => p.scope)).toEqual(["global"]);
		expect((await (await req("/sync/prefs?all=1")).json() as { prefs: unknown[] }).prefs).toHaveLength(2);
	});

	it("publishes docs and prunes the ones removed from git", async () => {
		await req("/sync/docs", { method: "PUT", json: { docs: [{ name: "styles/a.md", body: "A" }, { name: "styles/b.md", body: "B" }], prune: true } });
		await req("/sync/docs", { method: "PUT", json: { docs: [{ name: "styles/a.md", body: "A2" }], prune: true } });
		const rows = (await env.DB.prepare("SELECT name, body FROM docs ORDER BY name").all()).results;
		expect(rows).toEqual([{ name: "styles/a.md", body: "A2" }]);
		expect((await req("/sync/docs", { method: "PUT", json: { docs: [{ name: "../x", body: "" }] } })).status).toBe(400);
	});
});

describe("access keys + Backblaze storage", () => {
	const b2env = () => Object.assign(env as unknown as Record<string, string>, { B2_KEY_ID: "kid", B2_APP_KEY: "secret", B2_BUCKET: "bkt", B2_ENDPOINT: "s3.us-west-004.backblazeb2.com" });

	it("only the owner manages keys; a key then works for sync until revoked", async () => {
		expect((await req("/sync/access", { method: "POST", json: { name: "Sam" } }, "ci")).status).toBe(403); // Write access, not the owner
		const made = await req("/sync/access", { method: "POST", json: { name: "Sam" } });
		expect(made.status).toBe(200);
		const { key } = (await made.json()) as { key: string };
		expect(key).toMatch(/^vfk_[A-Za-z0-9]{32}$/);
		expect((await req("/sync/roots", {}, key)).status).toBe(200);
		expect(((await (await req("/sync/info", {}, key)).json()) as { user: string }).user).toBe("key:Sam");
		expect((await req("/sync/access", {}, key)).status).toBe(403); // a key can't manage keys
		expect((await req("/sync/access/revoke", { method: "POST", json: { name: "Sam" } })).status).toBe(200);
		expect((await req("/sync/roots", {}, key)).status).toBe(401);
		expect((await req("/sync/roots", {}, "vfk_" + "x".repeat(32))).status).toBe(401);
	});

	it("hands out signed Backblaze links and accepts b2 assets in commits", async () => {
		expect((await req("/sync/blob/" + "b".repeat(64))).status).toBe(503); // storage not configured yet
		b2env();
		expect(((await (await req("/sync/info")).json()) as { storage: string }).storage).toBe("b2");
		const get = await req("/sync/blob/" + "b".repeat(64));
		expect(get.status).toBe(302);
		expect(get.headers.get("Location")).toMatch(/^https:\/\/s3\.us-west-004\.backblazeb2\.com\/bkt\/blobs\/b{64}\?.*X-Amz-Signature=/);
		const up = (await (await req("/sync/blob/" + "b".repeat(64) + "/upload", { method: "POST" })).json()) as { exists: boolean; url: string; asset: string };
		expect(up.exists).toBe(false);
		expect(up.asset).toBe("b2:" + "b".repeat(64));
		expect(up.url).toContain("X-Amz-Signature=");
		expect(((await (await req("/sync/blob/" + "a".repeat(64) + "/upload", { method: "POST" })).json()) as { exists: boolean }).exists).toBe(true);
		expect((await req("/sync/blob/nope")).status).toBe(400);
		// R2 secrets set: R2 wins over B2 (region "auto"; endpoint pasted with or without https://)
		const r2 = { R2_ENDPOINT: "acct123.r2.cloudflarestorage.com/vf-files/ ", R2_KEY_ID: "rk", R2_SECRET: "rs" };
		Object.assign(env as unknown as Record<string, string>, r2);
		const r2get = await req("/sync/blob/" + "b".repeat(64));
		expect(r2get.headers.get("Location")).toMatch(/^https:\/\/acct123\.r2\.cloudflarestorage\.com\/vf-files\/blobs\/b{64}\?.*X-Amz-Credential=rk%2F\d{8}%2Fauto%2Fs3/);
		for (const k of Object.keys(r2)) delete (env as unknown as Record<string, string>)[k];
		await req("/sync/roots", { method: "PUT", json: { name: "kits", target: "@repo/style-kits" } });
		const ok = await req("/sync/commit", { json: { changes: [{ root: "kits", path: "a.md", sha: A, size: 5, asset: "b2:" + A, prev: null }] } });
		expect(ok.status).toBe(200);
		const badAsset = await req("/sync/commit", { json: { changes: [{ root: "kits", path: "b.md", sha: B, size: 5, asset: "s3:" + B, prev: null }] } });
		expect(badAsset.status).toBe(400);
	});

	it("revokeKey and createKey keep one active key per name", async () => {
		const a = await createKey(env.DB, "Ana");
		const b = await createKey(env.DB, "Ana");
		expect("key" in a && "key" in b && a.key !== b.key).toBe(true);
		expect((await req("/sync/roots", {}, (a as { key: string }).key)).status).toBe(401); // replaced
		expect((await req("/sync/roots", {}, (b as { key: string }).key)).status).toBe(200);
		expect(await revokeKey(env.DB, "nobody")).toEqual({ error: "no active key named nobody" });
	});
});
