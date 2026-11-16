// Per-job style package: extraction + validation, and a real-engine preview from an extracted package.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PACKAGE_MAX_ENTRIES, extractPackage, fetchPackage, scanArchive } from "../agent/package.ts";
import { renderPreviews } from "../engine/render.ts";
import { run } from "../engine/ffmpeg.ts";

process.env.FORCE_X264 = "1";
const tmp = () => mkdtempSync(join(tmpdir(), "vf-pkg-"));
const TITLE = `<!doctype html><html><body style="margin:0;background:#fff">
<div id="box" style="position:absolute;left:10%;top:10%;width:50%;height:50%;background:#e0218a"></div>
<script>window.__seek = (t) => { document.getElementById("box").style.transform = "translateX(" + t * 10 + "px)"; };</script>
</body></html>`;

/** tar -czf of a fresh dir populated by `fill`; extra tar args go before the member list. */
function pack(fill: (dir: string) => void, members = ["."], extra: string[] = []): string {
	const src = tmp();
	fill(src);
	const out = join(tmp(), "p.tar.gz");
	execFileSync("tar", ["--format", "ustar", "-czf", out, ...extra, "-C", src, ...members]);
	return out;
}
const good = (d: string) => {
	writeFileSync(join(d, "tokens.json"), JSON.stringify({ palette: { bg: "#ffffff" } }));
	writeFileSync(join(d, "title.html"), TITLE);
};

test("good package extracts to <root>/custom", async () => {
	const root = await extractPackage(pack(good), join(tmp(), "pkg"));
	assert.ok(execFileSync("ls", [join(root, "custom")], { encoding: "utf8" }).includes("title.html"));
});

test("archive with a ../ entry is rejected", async () => {
	// Raw ustar headers: GNU tar normalizes "sub/../x" when creating, so build the hostile names by hand.
	for (const name of ["sub/../tokens.json", "../escape.txt", "/etc/evil"]) {
		const dir = tmp();
		const a = join(dir, "evil.tar.gz");
		writeFileSync(a, ustar([{ name: "tokens.json", size: 2 }, { name, size: 1 }]));
		await assert.rejects(extractPackage(a, join(dir, "pkg")), /unsafe path/, name);
		assert.equal(existsSync(join(dir, "pkg", "custom")), false);
	}
});

test("symlink is rejected", async () => {
	const a = pack((d) => { good(d); symlinkSync("/etc/passwd", join(d, "evil")); });
	await assert.rejects(extractPackage(a, join(tmp(), "pkg")), /not a plain file/);
});

test("oversize package is rejected", async () => {
	const a = pack((d) => { good(d); writeFileSync(join(d, "big.bin"), Buffer.alloc(2048)); });
	await assert.rejects(extractPackage(a, join(tmp(), "pkg"), 1024), /limit 1024/);
});

test("missing tokens.json is rejected; bad id rejected before fetch", async () => {
	await assert.rejects(extractPackage(pack((d) => writeFileSync(join(d, "title.html"), TITLE)), join(tmp(), "pkg")), /tokens\.json missing/);
	await assert.rejects(fetchPackage("pk_nope", tmp(), () => { throw new Error("fetched"); }), /invalid style package id/);
});

test("fetchPackage + renderPreviews with style custom draws the box", { timeout: 120_000 }, async () => {
	const bytes = execFileSync("cat", [pack(good)]);
	const stylesDir = await fetchPackage("pk_" + "a".repeat(24), tmp(), async () => new Response(new Uint8Array(bytes)));
	const plan = { style: "custom", fps: 30, resolution: "640x360", scenes: [{ n: 1, template: "title", props: {}, duration_s: 3, narration: "hi", transition: "cut" }] };
	const frames = await renderPreviews({ plan, stylesDir, workDir: tmp(), audioPath: "", audioSeconds: 3 }, [1]);
	const jpg = join(tmp(), "f.jpg");
	writeFileSync(jpg, frames.get("scene-1-1")!);
	// Mean saturation > 0 only if the magenta box rendered (white background alone is 0).
	const r = await run("ffmpeg", ["-hide_banner", "-i", jpg, "-vf", "signalstats,metadata=print", "-f", "null", "-"]);
	const sat = Number(/SATAVG=([\d.]+)/.exec(r.stderr)?.[1]);
	assert.ok(sat > 5, `frame looks blank (SATAVG=${sat})`);
});

// Hand-built ustar so owner/group text can be hostile (bsdtar -tv prints them space-separated).
function ustar(entries: { name: string; size: number; type?: string; uname?: string; gname?: string }[]): Buffer {
	const blocks: Buffer[] = [];
	for (const e of entries) {
		const h = Buffer.alloc(512);
		h.write(e.name, 0);
		h.write("0000644\0", 100);
		h.write("0000000\0", 108);
		h.write("0000000\0", 116);
		h.write(e.size.toString(8).padStart(11, "0") + "\0", 124);
		h.write("00000000000\0", 136);
		h.write(e.type ?? "0", 156);
		h.write("ustar\0" + "00", 257);
		h.write(e.uname ?? "x y 0", 265);
		h.write(e.gname ?? "y", 297);
		h.write("        ", 148);
		let sum = 0;
		for (const b of h) sum += b;
		h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
		blocks.push(h, Buffer.alloc(Math.ceil(e.size / 512) * 512, 0x61));
	}
	blocks.push(Buffer.alloc(1024));
	return gzipSync(Buffer.concat(blocks));
}

test("crafted owner text cannot hide a file's real size (rejected before extraction)", async () => {
	const dir = tmp();
	const a = join(dir, "evil.tar.gz");
	writeFileSync(a, ustar([{ name: "tokens.json", size: 2 }, { name: "big.bin", size: 4096, uname: "x y 0" }]));
	const root = join(dir, "pkg");
	await assert.rejects(extractPackage(a, root, 1024), /4098 bytes declared, limit 1024/);
	assert.equal(existsSync(join(root, "custom")), false); // nothing written
});

test("too many entries and pax/link records are rejected before extraction", () => {
	const many = ustar(Array.from({ length: PACKAGE_MAX_ENTRIES + 1 }, (_, i) => ({ name: `f${i}`, size: 0 })));
	assert.throws(() => scanArchive(many, 1 << 30), /more than \d+ entries/);
	assert.throws(() => scanArchive(ustar([{ name: "p", size: 0, type: "x" }]), 1024), /type 'x'/);
	assert.throws(() => scanArchive(ustar([{ name: "l", size: 0, type: "2" }]), 1024), /type '2'/);
});

test("gzip bomb is cut off by the bounded inflate", () => {
	const bomb = gzipSync(Buffer.alloc(32 * 1024 * 1024));
	assert.throws(() => scanArchive(bomb, 1024 * 1024), /within the size limit/);
});
