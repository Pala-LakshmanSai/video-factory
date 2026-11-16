// Per-job style packages (style "custom"): a .tar.gz of the video's own templates, kept in KV for 7 days.

export const MAX_PACKAGE_BYTES = 8 * 1024 * 1024;
const TTL_S = 7 * 24 * 3600;
export const pkgKey = (id: string) => `pkg:${id}`;

export async function putPackage(kv: KVNamespace, name: string, dataB64: string) {
	let bytes: Uint8Array;
	try {
		bytes = Uint8Array.from(atob(dataB64.replace(/\s/g, "")), (c) => c.charCodeAt(0));
	} catch {
		return { error: "data_b64 is not valid base64" };
	}
	if (bytes.length > MAX_PACKAGE_BYTES) return { error: `package is ${bytes.length} bytes; max ${MAX_PACKAGE_BYTES} (8 MiB) compressed` };
	if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return { error: "package must be a gzip'd tar (.tar.gz): missing gzip magic bytes" };
	const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
	const package_id = "pk_" + sha256.slice(0, 24);
	await kv.put(pkgKey(package_id), bytes, { expirationTtl: TTL_S, metadata: { name, bytes: bytes.length, sha256, created_at: Date.now() } });
	return { package_id, bytes: bytes.length, sha256 };
}

/** The package bytes, or null when the key never existed or expired. */
export const getPackage = (kv: KVNamespace, id: string) => kv.get(pkgKey(id), "arrayBuffer");

/** Full hex sha256 of a stored package, computed from the bytes; undefined if gone. */
export async function packageSha256(kv: KVNamespace, id: string): Promise<string | undefined> {
	const bytes = await getPackage(kv, id);
	return bytes ? [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("") : undefined;
}
