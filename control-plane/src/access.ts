// Access keys: one secret per team member ("vfk_" + 32 letters/digits) that replaces a GitHub account for sync,
// the one-line installers and the connector sign-in (docs/SYNC.md). Only its SHA-256 is stored; revoking is instant.

export const KEY_RE = /^vfk_[A-Za-z0-9]{32}$/;
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._@-]{0,39}$/;
const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export async function sha256hex(s: string) {
	const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
	return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function newKey() {
	const out: string[] = [];
	while (out.length < 32) for (const b of crypto.getRandomValues(new Uint8Array(64))) if (b < 248 && out.length < 32) out.push(ALPHA[b % 62]); // no modulo bias
	return "vfk_" + out.join("");
}

/** The key's owner name, or null if the key is unknown or revoked. */
export async function checkAccessKey(db: D1Database, key: string): Promise<{ name: string } | null> {
	if (!KEY_RE.test(key)) return null;
	const h = await sha256hex(key);
	const row = await db.prepare("SELECT name FROM access_keys WHERE key_hash = ? AND revoked_at IS NULL").bind(h).first<{ name: string }>();
	if (row) await db.prepare("UPDATE access_keys SET last_used_at = ? WHERE key_hash = ?").bind(Date.now(), h).run();
	return row ?? null;
}

/** New key for a name; replaces any earlier key for that name (the old one stops working). */
export async function createKey(db: D1Database, name: string) {
	if (!NAME_RE.test(name)) return { error: "name: 1-40 letters, digits, spaces or . _ @ -" };
	const key = newKey();
	await db
		.prepare("INSERT INTO access_keys (name, key_hash, created_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET key_hash = excluded.key_hash, created_at = excluded.created_at, revoked_at = NULL, last_used_at = NULL")
		.bind(name, await sha256hex(key), Date.now())
		.run();
	return { name, key };
}

export async function listKeys(db: D1Database) {
	return (await db.prepare("SELECT name, created_at, revoked_at, last_used_at FROM access_keys ORDER BY name").all()).results;
}

export async function revokeKey(db: D1Database, name: string) {
	const r = await db.prepare("UPDATE access_keys SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL").bind(Date.now(), name).run();
	return r.meta.changes ? { ok: true } : { error: `no active key named ${name}` };
}
