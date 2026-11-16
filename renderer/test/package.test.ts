// Per-job style package: extraction + validation, and a real-engine preview from an extracted package.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { extractPackage, fetchPackage } from "../agent/package.ts";
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
	execFileSync("tar", ["-czf", out, ...extra, "-C", src, ...members]);
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
	// Member "sub/../tokens.json" keeps the ".." component in the stored name.
	const a = pack((d) => { good(d); mkdirSync(join(d, "sub")); }, ["sub/../tokens.json"]);
	await assert.rejects(extractPackage(a, join(tmp(), "pkg")), /unsafe path/);
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
