// Per-job custom style package: GET /input/package (.tar.gz) -> WORK/pkg/custom/, rendered with stylesDir = WORK/pkg.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { must } from "../engine/ffmpeg.ts";

export const PACKAGE_MAX_BYTES = 64 * 1024 * 1024;
export const PACKAGE_ID = /^pk_[0-9a-f]{24}$/;
export const PACKAGE_MAX_ENTRIES = 5000;

/**
 * Preflight from the raw ustar headers, before anything is written: bounded gunzip (never inflates past
 * maxBytes + header overhead), at most PACKAGE_MAX_ENTRIES entries, only plain files ('0'/NUL) and
 * directories ('5') (no links, devices, pax/GNU extension records), safe relative paths, and the sum of the
 * declared file sizes <= maxBytes. Owner/group text never affects the size (it is read from its own field).
 */
export function scanArchive(gz: Buffer, maxBytes: number): void {
	let tar: Buffer;
	try {
		tar = gunzipSync(gz, { maxOutputLength: maxBytes + 512 * (PACKAGE_MAX_ENTRIES + 4) });
	} catch (e) {
		throw new Error(`style package rejected: not a gzip archive within the size limit (${(e as Error).message})`);
	}
	const str = (o: number, n: number) => tar.subarray(o, o + n).toString("utf8").replace(/\0.*$/s, "");
	let off = 0;
	let entries = 0;
	let total = 0;
	while (off + 512 <= tar.length) {
		if (tar.subarray(off, off + 512).every((b) => b === 0)) return; // end-of-archive marker
		if (++entries > PACKAGE_MAX_ENTRIES) throw new Error(`style package rejected: more than ${PACKAGE_MAX_ENTRIES} entries`);
		const type = String.fromCharCode(tar[off + 156] || 0x30);
		const prefix = str(off + 345, 155);
		const name = (prefix ? prefix + "/" : "") + str(off + 0, 100);
		const sizeField = str(off + 124, 12).trim();
		if (!/^[0-7]+$/.test(sizeField)) throw new Error(`style package rejected: bad size field for "${name}"`);
		const size = parseInt(sizeField, 8);
		if (type !== "0" && type !== "5") throw new Error(`style package rejected: entry "${name}" type '${type}' is not a plain file or directory`);
		if (!name || name.startsWith("/") || name.split(/[\\/]/).includes("..")) throw new Error(`style package rejected: unsafe path "${name}"`);
		total += size;
		if (total > maxBytes) throw new Error(`style package rejected: ${total} bytes declared, limit ${maxBytes}`);
		off += 512 + Math.ceil(size / 512) * 512;
	}
	throw new Error("style package rejected: truncated tar (no end-of-archive marker)");
}

/**
 * Validate and extract a style package archive into `${root}/custom/` (wiped first). Returns `root`, the
 * stylesDir to render with. Rejects absolute paths, `..` components, and any entry that is not a plain file or
 * directory (symlinks, hardlinks, devices); checks the extracted size against `maxBytes`; requires tokens.json.
 */
export async function extractPackage(archive: string, root: string, maxBytes = PACKAGE_MAX_BYTES): Promise<string> {
	scanArchive(await readFile(archive), maxBytes);
	const dir = join(root, "custom");
	await rm(dir, { recursive: true, force: true });
	await mkdir(dir, { recursive: true });
	await must("tar", ["-xzf", archive, "-C", dir]);
	let total = 0;
	for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) {
		if (e.isSymbolicLink()) throw new Error(`style package rejected: symlink ${e.name}`);
		if (e.isFile()) total += (await stat(join(e.parentPath, e.name))).size;
	}
	if (total > maxBytes) throw new Error(`style package rejected: ${total} bytes extracted, limit ${maxBytes}`);
	if (!existsSync(join(dir, "tokens.json"))) throw new Error("style package rejected: tokens.json missing at the archive root");
	return root;
}

/** Download the package for `id` to `${work}/pkg.tar.gz` and extract it to `${work}/pkg`. Returns the stylesDir. */
export async function fetchPackage(id: string, sha256: string | undefined, work: string, get: () => Promise<Response>): Promise<string> {
	if (!PACKAGE_ID.test(id)) throw new Error(`invalid style package id "${id}"`);
	const res = await get();
	if (!res.ok) throw new Error(`GET /input/package ${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`);
	const bytes = new Uint8Array(await res.arrayBuffer());
	// Content-addressed: the bytes must be the package the spec named, never another plan's (nothing written otherwise).
	const got = createHash("sha256").update(bytes).digest("hex");
	if ((sha256 && got !== sha256.toLowerCase()) || "pk_" + got.slice(0, 24) !== id) throw new Error("style package rejected: content hash mismatch");
	await mkdir(work, { recursive: true });
	const archive = join(work, "pkg.tar.gz");
	await writeFile(archive, bytes);
	return extractPackage(archive, join(work, "pkg"));
}
