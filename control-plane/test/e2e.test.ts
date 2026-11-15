// End-to-end: the real pod agent (renderer/agent/main.ts, its own Node process, real Chromium + ffmpeg)
// talks HTTP to the real agent API (agentApp) while this process drives the MCP functions.
// Fakes: RunPod, Google token/Drive metadata (stubbed fetch here) and the Drive resumable session (HTTP below).
// Slow (~1 min): runs only with E2E=1, and only when ffmpeg and Playwright's Chromium are installed.
//   cd control-plane && E2E=1 npx vitest run test/e2e.test.ts
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agentApp } from "../src/agent";
import { getJob } from "../src/db";
import { armFault } from "../src/faults";
import { acquireGpu, approve, reviseScene, submitJob, waitJob } from "../src/mcp";
import { selectAndCreate } from "../src/selector";
import { RTX4090, catalogOf, json, makeEnv } from "./helpers";

const RENDERER = fileURLToPath(new URL("../../renderer", import.meta.url));
const has = (cmd: string, args: string[], cwd?: string) => spawnSync(cmd, args, { cwd, encoding: "utf8" });
function ready() {
	if (process.env.E2E !== "1") return false;
	if (has("ffmpeg", ["-version"]).status !== 0 || has("ffprobe", ["-version"]).status !== 0) return false;
	const p = has(process.execPath, ["-e", "import('playwright').then(p=>console.log(p.chromium.executablePath()))"], RENDERER);
	return p.status === 0 && existsSync(p.stdout.trim());
}

const VO_SECONDS = 8;
const PLAN = {
	style: "explainer", fps: 24, resolution: "640x360",
	scenes: [
		{ n: 1, template: "title", props: { kicker: "Kitchen physics", title: "Why Tea Cools", subtitle: "Three ways heat escapes" }, duration_s: 2, narration: "Why does tea cool?", transition: "fade" },
		{ n: 2, template: "kinetic-text", props: { text: "Heat flows from hot to cold", emphasis: ["hot", "cold"] }, duration_s: 2, narration: "Heat flows.", transition: "slide" },
		{ n: 3, template: "list", props: { heading: "Where it goes", items: ["Evaporation", "Conduction", "Radiation"] }, duration_s: 2.5, narration: "Three ways.", transition: "slide" },
		{ n: 4, template: "end-card", props: { title: "Thanks!", cta: "Subscribe", handle: "@kitchenphysics" }, duration_s: 1.5, narration: "Thanks.", transition: "cut" },
	],
};

describe.skipIf(!ready())("e2e: pod agent process <-> agent API over HTTP", () => {
	const realFetch = globalThis.fetch;
	let env: Env;
	let server: Server;
	let base = "";
	let work = "";
	let voiceWav: Buffer;
	let agent: ChildProcess | null = null;
	let agentLog = "";
	let exited: Promise<number | null>;
	const createBodies: { env: Record<string, string> }[] = [];
	const deleted: string[] = [];
	// Fake Drive: resumable sessions + finished files, bytes in memory.
	const sessions = new Map<string, { size: number; chunks: Buffer[]; got: number; queries: number }>();
	const files = new Map<string, Buffer>();
	let sessionN = 0;

	const body = async (req: IncomingMessage) => {
		const parts: Buffer[] = [];
		for await (const c of req) parts.push(c as Buffer);
		return Buffer.concat(parts);
	};

	beforeAll(async () => {
		work = await mkdtemp(join(tmpdir(), "vf-e2e-"));
		const wav = join(work, "vo.wav");
		const r = has("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=44100:duration=${VO_SECONDS}`, wav]);
		expect(r.status).toBe(0);
		voiceWav = await readFile(wav);

		env = makeEnv();
		server = createServer(async (req, res) => {
			try {
				const m = /^\/drive-session\/(\w+)$/.exec(req.url ?? "");
				if (m) {
					// Drive resumable PUT: "bytes a-b/size" appends, "bytes */size" queries; 308 + Range until complete.
					const s = sessions.get(m[1]);
					if (!s || req.method !== "PUT") return void res.writeHead(404).end();
					const cr = /bytes (\*|(\d+)-(\d+))\/(\d+)/.exec(String(req.headers["content-range"]));
					const data = await body(req);
					if (!cr || Number(cr[4]) !== s.size) return void res.writeHead(400).end("bad Content-Range");
					if (cr[1] === "*") s.queries++;
					else {
						if (Number(cr[2]) !== s.got || data.length !== Number(cr[3]) - Number(cr[2]) + 1) return void res.writeHead(400).end("bad chunk");
						s.chunks.push(data);
						s.got += data.length;
					}
					if (s.got === s.size) {
						const id = `file${m[1]}`;
						files.set(id, Buffer.concat(s.chunks));
						res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id }));
					} else res.writeHead(308, s.got ? { Range: `bytes=0-${s.got - 1}` } : {}).end();
					return;
				}
				// Node req -> Fetch Request -> agentApp -> Node res, streaming both ways.
				const headers = new Headers();
				for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
				const hasBody = req.method !== "GET" && req.method !== "HEAD";
				const out = await agentApp.fetch(
					new Request(base + req.url, { method: req.method, headers, body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined, duplex: "half" } as RequestInit),
					env,
				);
				res.writeHead(out.status, Object.fromEntries(out.headers));
				if (out.body) for await (const c of out.body as unknown as AsyncIterable<Uint8Array>) res.write(c);
				res.end();
			} catch (e) {
				console.error("e2e server:", e);
				if (!res.headersSent) res.writeHead(500);
				res.end(String(e));
			}
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		(env as { CP_URL: string }).CP_URL = base;

		// Everything off-box is faked here; 127.0.0.1 goes to the real fetch.
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
			const url = String(input instanceof Request ? input.url : input);
			const method = init.method ?? "GET";
			const hdr = new Headers(init.headers);
			if (url.startsWith("http://127.0.0.1:")) return realFetch(input, init);
			if (url.includes("/v2/catalog/datacenters")) return json(catalogOf({ "AP-IN-1": { [RTX4090]: "HIGH" } }));
			if (url === "https://rest.runpod.io/v1/pods" && method === "POST") {
				createBodies.push(JSON.parse(init.body as string));
				return json({ id: "pod1", costPerHr: 0.6, machine: { gpuTypeId: RTX4090, dataCenterId: "AP-IN-1" } }, 201);
			}
			if (url.startsWith("https://rest.runpod.io/v1/pods/") && method === "DELETE") {
				deleted.push(url.split("/").at(-1)!);
				return json({});
			}
			if (url === "https://oauth2.googleapis.com/token") return json({ access_token: "at", expires_in: 3599 });
			if (hdr.get("Authorization") !== "Bearer at") return new Response("no auth", { status: 401 });
			if (url.startsWith("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable") && method === "POST") {
				const id = String(++sessionN);
				sessions.set(id, { size: Number(hdr.get("X-Upload-Content-Length")), chunks: [], got: 0, queries: 0 });
				return new Response(null, { status: 200, headers: { Location: `${base}/drive-session/${id}` } });
			}
			const DRIVE = "https://www.googleapis.com/drive/v3/files/";
			if (url === `${DRIVE}vo1?alt=media`) return new Response(voiceWav, { headers: { "Content-Type": "audio/wav" } });
			if (url.startsWith(DRIVE) && url.endsWith("/permissions") && method === "POST") return json({ id: "anyoneWithLink" });
			const meta = /^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/([^/?]+)\?fields=/.exec(url);
			if (meta) {
				const bytes = files.get(meta[1]);
				if (!bytes) return new Response("not found", { status: 404 });
				return json({ size: String(bytes.length), md5Checksum: createHash("md5").update(bytes).digest("hex"), webViewLink: `https://drive.test/${meta[1]}` });
			}
			throw new Error(`e2e: unrouted fetch ${method} ${url}`);
		});
	});

	afterAll(async () => {
		vi.unstubAllGlobals();
		agent?.kill("SIGKILL");
		await new Promise((r) => server?.close(r));
		if (work) await rm(work, { recursive: true, force: true });
	});

	async function waitUntil(id: string, until: "preview" | "done", want: string, maxS = 240) {
		const end = Date.now() + maxS * 1000;
		for (;;) {
			const w = await waitJob(env.DB, id, until, 50);
			if (w.out?.error) throw new Error(`job error: ${w.out.error}\nagent log:\n${agentLog.slice(-3000)}`);
			if (w.out?.state === want) return w;
			if (["failed", "cancelled"].includes(w.out!.state) || Date.now() > end) {
				throw new Error(`state ${w.out?.state}, wanted ${want}\nagent log:\n${agentLog.slice(-3000)}`);
			}
		}
	}

	it("acquire -> pod agent renders previews -> revise -> approve -> final mp4 uploaded (drop + resume, md5 re-upload), verified, pod deleted", async () => {
		const { job_id: id, state } = await acquireGpu(env, env.DB, { style: "explainer", title: "Why Tea Cools", voiceover: { drive_file_id: "vo1" }, chat_key: "e2echat1" });
		expect(state).toBe("provisioning");
		expect(await selectAndCreate(env, env.DB, id)).toBe("created");
		expect(await submitJob(env.DB, id, PLAN)).toMatchObject({ state: "booting" });

		// Boot the "pod": exactly the env RunPod would inject, minus RUNPOD_POD_ID (self-destruct just exits).
		const podEnv = createBodies.at(-1)!.env;
		expect(podEnv.CP_URL).toBe(base);
		const { RUNPOD_POD_ID: _p, RUNPOD_API_KEY: _k, ...parentEnv } = process.env;
		agent = spawn(process.execPath, ["agent/main.ts"], {
			cwd: RENDERER,
			env: { ...parentEnv, ...podEnv, TTL_MIN: "10", WORK_DIR: work, FORCE_X264: "1", RENDER_WORKERS: "2", HEARTBEAT_MS: "1000", UPLOAD_CHUNK_BYTES: "65536" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		agent.stdout!.on("data", (d) => (agentLog += d));
		agent.stderr!.on("data", (d) => (agentLog += d));
		exited = new Promise((r) => agent!.on("exit", (code) => r(code)));

		// First round: 3 key frames per scene, real JPEGs.
		const p1 = await waitUntil(id, "preview", "preview_ready");
		expect(p1.out!.previews).toHaveLength(12);
		const imgs = p1.images.filter((c) => c.type === "image") as { data: string }[];
		expect(imgs).toHaveLength(12);
		for (const im of imgs) expect([...Buffer.from(im.data, "base64").subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);

		// QA fix on scene 2 -> only scene 2 re-renders, in the next round.
		expect(await reviseScene(env.DB, id, 2, { props: { text: "Heat always flows hot to cold" } })).toEqual({ state: "rerendering", scene: 2 });
		const p2 = await waitUntil(id, "preview", "preview_ready");
		const r0 = p1.out!.previews[0].round;
		expect(p1.out!.previews.every((l) => l.round === r0)).toBe(true);
		expect(p2.out!.previews).toHaveLength(12);
		expect(p2.out!.previews.filter((l) => l.round !== r0)).toEqual([0, 1, 2].map((idx) => ({ scene: 2, idx, round: r0 + 1 })));

		// Faults: the agent drops the connection after upload chunk 1 (must query "bytes */size" and resume),
		// and the first verify sees a bad md5 (cmd reupload -> a second session). Agent faults ride the heartbeat.
		await armFault(env, id, "drop_upload_after_chunk:1");
		for (let i = 0; (await getJob(env.DB, id))!.pending_cmd && i < 50; i++) await new Promise((r) => setTimeout(r, 200));
		expect((await getJob(env.DB, id))!.pending_cmd).toBeNull();
		await armFault(env, id, "corrupt_md5");

		expect(await approve(env.DB, id)).toEqual({ state: "final_render" });
		const done = await waitUntil(id, "done", "done", 300);
		const job = (await getJob(env.DB, id))!;
		expect(job.state).toBe("done");
		expect(job.reuploads).toBe(1);
		expect(done.out!.drive_link).toBe(`https://drive.test/${job.drive_file_id}`);
		expect([...sessions.values()].map((s) => s.queries)).toEqual([1, 0]); // resumed once in session 1; session 2 clean
		expect(sessions.get("1")!.chunks.length).toBeGreaterThan(2); // really chunked
		expect(files.get("file1")).toEqual(files.get("file2"));

		// The bytes Drive received are the agent's mp4: md5/size match what /done reported, duration = voiceover.
		const bytes = files.get(job.drive_file_id!)!;
		expect(bytes.length).toBe(job.size);
		expect(createHash("md5").update(bytes).digest("hex")).toBe(job.md5);
		const mp4 = join(work, "uploaded.mp4");
		await writeFile(mp4, bytes);
		const probe = has("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height", "-of", "json", mp4]);
		const info = JSON.parse(probe.stdout) as { format: { duration: string }; streams: { codec_type: string; codec_name: string; width?: number; height?: number }[] };
		expect(Math.abs(Number(info.format.duration) - VO_SECONDS)).toBeLessThanOrEqual(0.15);
		expect(info.streams.find((s) => s.codec_type === "video")).toMatchObject({ codec_name: "h264", width: 640, height: 360 });
		expect(info.streams.find((s) => s.codec_type === "audio")).toMatchObject({ codec_name: "aac" });

		// Pod deleted by the control plane; the agent gets 410 on its next heartbeat and exits.
		expect(deleted).toEqual(["pod1"]);
		const pod = await env.DB.prepare("SELECT deleted_at, delete_reason FROM pods WHERE id = 'pod1'").first<{ deleted_at: number | null; delete_reason: string }>();
		expect(pod).toMatchObject({ delete_reason: "done" });
		expect(pod!.deleted_at).not.toBeNull();
		const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r("timeout"), 15_000))]);
		expect(code, agentLog.slice(-2000)).toBe(0);
		expect(agentLog).toContain("self-destruct: cancel");

		const states = (
			await env.DB.prepare("SELECT data_json FROM events WHERE job_id = ? AND kind = 'state' ORDER BY id").bind(id).all<{ data_json: string }>()
		).results.map((e) => (JSON.parse(e.data_json) as { to: string }).to);
		expect(states).toEqual(["provisioning", "booting", "rendering", "preview_ready", "rerendering", "preview_ready", "final_render", "uploading", "verifying", "uploading", "verifying", "done"]);
		const kinds = (await env.DB.prepare("SELECT kind FROM events WHERE job_id = ?").bind(id).all<{ kind: string }>()).results.map((e) => e.kind);
		expect(kinds).toEqual(expect.arrayContaining(["pod_created", "plan_submitted", "hello", "upload_session", "verify"]));
	}, 600_000);
});
