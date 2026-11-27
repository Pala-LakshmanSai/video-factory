// Style "footage": bundle download (sha-verified, kept across rounds), the skill command run, preview frames.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { FootageManifest } from "../../packages/contract/src/index.ts";
import { checkManifest, fetchBundle, previewFrames, runBundle } from "../agent/footage.ts";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
// A tiny "skill": a python script that reads the job's edit and writes an mp4 with ffmpeg, using VF_THREADS.
const SCRIPT = Buffer.from(`import json, os, subprocess, sys
e = json.load(open(sys.argv[1]))
os.makedirs(os.path.dirname(e["out"]), exist_ok=True)
assert int(os.environ["VF_THREADS"]) >= 1
subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=" + str(e["seconds"]),
  "-c:v", "libx264", "-pix_fmt", "yuv420p", e["out"]], check=True)
print("wrote", e["out"])
`);
const EDIT = Buffer.from(JSON.stringify({ seconds: 2, out: "out/final.mp4" }));

function serve(files: Map<string, Buffer>) {
	const hits: string[] = [];
	const srv = createServer((req, res) => {
		const k = req.url!.slice(1);
		hits.push(k);
		const b = files.get(k);
		res.writeHead(b ? 200 : 404).end(b);
	});
	return new Promise<{ base: string; hits: string[]; close: () => void }>((r) => srv.listen(0, () => r({ base: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, hits, close: () => srv.close() })));
}

test("manifest checks reject unsafe paths and bad argv", () => {
	const m = { v: 1, skill: "x", cwd: ".", cmd: ["python3"], out: "job/o.mp4", files: {} } as FootageManifest;
	checkManifest(m);
	assert.throws(() => checkManifest({ ...m, out: "../o.mp4" }), /unsafe path/);
	assert.throws(() => checkManifest({ ...m, files: { "/etc/passwd": { sha256: "0".repeat(64), size: 1 } } }), /unsafe path/);
	assert.throws(() => checkManifest({ ...m, cmd: [] }), /argv/);
	assert.throws(() => checkManifest({ ...m, cwd: "a/../.." }), /unsafe cwd/);
});

test("fetch, verify, keep across rounds, run, preview", async () => {
	const blobs = new Map([[sha(SCRIPT), SCRIPT], [sha(EDIT), EDIT]]);
	const s = await serve(blobs);
	try {
		const manifest: FootageManifest = {
			v: 1, skill: "demo", cwd: "job", cmd: ["python3", "../skill/render.py", "edit.json"], out: "job/out/final.mp4",
			files: { "skill/render.py": { sha256: sha(SCRIPT), size: SCRIPT.length }, "job/edit.json": { sha256: sha(EDIT), size: EDIT.length } },
		};
		const links = Object.fromEntries([...blobs.keys()].map((k) => [k, `${s.base}/${k}`]));
		const dir = mkdtempSync(join(tmpdir(), "vf-footage-"));
		const have = new Map<string, string>();
		await fetchBundle(dir, async () => ({ manifest, links }), have, () => {});
		assert.deepEqual(readFileSync(join(dir, "job/edit.json")), EDIT);
		assert.equal(s.hits.length, 2);
		await fetchBundle(dir, async () => ({ manifest, links }), have, () => {}); // same bundle again: nothing re-fetched
		assert.equal(s.hits.length, 2);
		const out = await runBundle(dir, manifest, () => {});
		assert.equal(out, join(dir, "job/out/final.mp4"));
		const frames = await previewFrames(out, 2, join(dir, "pv"), 4);
		assert.deepEqual([...frames.keys()], ["scene-1-0", "scene-1-1", "scene-1-2", "scene-1-3"]);
		for (const f of frames.values()) assert.equal(f[0], 0xff); // JPEG
		// A corrupted download is rejected (and retried with fresh links, then reported).
		blobs.set(sha(SCRIPT), Buffer.from("tampered"));
		await assert.rejects(fetchBundle(mkdtempSync(join(tmpdir(), "vf-footage-")), async () => ({ manifest, links }), new Map(), () => {}), /does not match/);
		// A failing command reports its output tail.
		await assert.rejects(runBundle(dir, { ...manifest, cmd: ["python3", "-c", "import sys; print('boom'); sys.exit(3)"] }, () => {}), /exited 3 \(vcpus [\s\S]*boom/);
	} finally {
		s.close();
	}
});
