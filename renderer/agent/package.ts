// Per-job custom style package: GET /input/package (.tar.gz) -> WORK/pkg/custom/, rendered with stylesDir = WORK/pkg.
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { must } from "../engine/ffmpeg.ts";

export const PACKAGE_MAX_BYTES = 64 * 1024 * 1024;
export const PACKAGE_ID = /^pk_[0-9a-f]{24}$/;

/**
 * Validate and extract a style package archive into `${root}/custom/` (wiped first). Returns `root`, the
 * stylesDir to render with. Rejects absolute paths, `..` components, and any entry that is not a plain file or
 * directory (symlinks, hardlinks, devices); checks the extracted size against `maxBytes`; requires tokens.json.
 */
export async function extractPackage(archive: string, root: string, maxBytes = PACKAGE_MAX_BYTES): Promise<string> {
	const names = (await must("tar", ["-tzf", archive])).stdout.split("\n").filter(Boolean);
	for (const n of names) {
		if (n.startsWith("/") || n.split(/[\\/]/).includes("..")) throw new Error(`style package rejected: unsafe path "${n}"`);
	}
	// Whitelist entry types by the mode column ('-' file, 'd' dir); GNU and bsd tar both print 'l'/'h' for links.
	for (const line of (await must("tar", ["-tvzf", archive])).stdout.split("\n").filter(Boolean)) {
		if (!"-d".includes(line[0]) || / link to | -> /.test(line)) throw new Error(`style package rejected: not a plain file or directory: ${line}`);
	}
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
export async function fetchPackage(id: string, work: string, get: () => Promise<Response>): Promise<string> {
	if (!PACKAGE_ID.test(id)) throw new Error(`invalid style package id "${id}"`);
	const res = await get();
	if (!res.ok) throw new Error(`GET /input/package ${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`);
	await mkdir(work, { recursive: true });
	const archive = join(work, "pkg.tar.gz");
	await writeFile(archive, new Uint8Array(await res.arrayBuffer()));
	return extractPackage(archive, join(work, "pkg"));
}
