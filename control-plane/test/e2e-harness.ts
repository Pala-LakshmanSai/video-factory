// Shared e2e harness: agentApp over real HTTP, fake Drive resumable endpoint, stubbed RunPod/Google fetch,
// and a spawner for the real pod agent (renderer/agent/main.ts, its own Node process).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { expect, vi } from "vitest";
import { agentApp } from "../src/agent";
import { waitJob } from "../src/mcp";
import { RTX4090, catalogOf, json, makeEnv } from "./helpers";

export const RENDERER = fileURLToPath(new URL("../../renderer", import.meta.url));
export const has = (cmd: string, args: string[], cwd?: string) => spawnSync(cmd, args, { cwd, encoding: "utf8" });
export function ready() {
	if (process.env.E2E !== "1") return false;
	if (has("ffmpeg", ["-version"]).status !== 0 || has("ffprobe", ["-version"]).status !== 0) return false;
	const p = has(process.execPath, ["-e", "import('playwright').then(p=>console.log(p.chromium.executablePath()))"], RENDERER);
	return p.status === 0 && existsSync(p.stdout.trim());
}

export const VO_SECONDS = 8;
export const PLAN = {
	style: "explainer", fps: 24, resolution: "640x360",
	scenes: [
		{ n: 1, template: "title", props: { kicker: "Kitchen physics", title: "Why Tea Cools", subtitle: "Three ways heat escapes" }, duration_s: 2, narration: "Why does tea cool?", transition: "fade" },
		{ n: 2, template: "kinetic-text", props: { text: "Heat flows from hot to cold", emphasis: ["hot", "cold"] }, duration_s: 2, narration: "Heat flows.", transition: "slide" },
		{ n: 3, template: "list", props: { heading: "Where it goes", items: ["Evaporation", "Conduction", "Radiation"] }, duration_s: 2.5, narration: "Three ways.", transition: "slide" },
		{ n: 4, template: "end-card", props: { title: "Thanks!", cta: "Subscribe", handle: "@kitchenphysics" }, duration_s: 1.5, narration: "Thanks.", transition: "cut" },
	],
};

export interface Agent { proc: ChildProcess; log: () => string; exited: Promise<number | null> }

export type Harness = Awaited<ReturnType<typeof startHarness>>;

export async function startHarness() {
	const realFetch = globalThis.fetch;
	const work = await mkdtemp(join(tmpdir(), "vf-e2e-"));
	const wav = join(work, "vo.wav");
	const r = has("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=44100:duration=${VO_SECONDS}`, wav]);
	expect(r.status).toBe(0);
	const voiceWav = await readFile(wav);

	const env = makeEnv();
	const createBodies: { env: Record<string, string> }[] = [];
	const deleted: string[] = [];
	// Fake Drive: resumable sessions + finished files, bytes in memory.
	const sessions = new Map<string, { size: number; chunks: Buffer[]; got: number; queries: number }>();
	const files = new Map<string, Buffer>();
	const agents: Agent[] = [];
	let sessionN = 0;
	let base = "";

	const body = async (req: IncomingMessage) => {
		const parts: Buffer[] = [];
		for await (const c of req) parts.push(c as Buffer);
		return Buffer.concat(parts);
	};

	const server: Server = createServer(async (req, res) => {
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
			return json({ id: `pod${createBodies.length}`, costPerHr: 0.6, machine: { gpuTypeId: RTX4090, dataCenterId: "AP-IN-1" } }, 201);
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

	/** Boot a "pod": exactly the env RunPod would inject (latest create call), minus RUNPOD_POD_ID (self-destruct just exits). */
	function spawnAgent(extra: Record<string, string> = {}, workDir = work): Agent {
		const podEnv = createBodies.at(-1)!.env;
		const { RUNPOD_POD_ID: _p, RUNPOD_API_KEY: _k, ...parentEnv } = process.env;
		const proc = spawn(process.execPath, ["agent/main.ts"], {
			cwd: RENDERER,
			env: { ...parentEnv, ...podEnv, TTL_MIN: "10", WORK_DIR: workDir, FORCE_X264: "1", RENDER_WORKERS: "2", HEARTBEAT_MS: "1000", UPLOAD_CHUNK_BYTES: "65536", ...extra },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let log = "";
		proc.stdout!.on("data", (d) => (log += d));
		proc.stderr!.on("data", (d) => (log += d));
		const a: Agent = { proc, log: () => log, exited: new Promise((r) => proc.on("exit", (code) => r(code))) };
		agents.push(a);
		return a;
	}
	const logs = () => agents.map((a, i) => `--- agent ${i + 1}\n${a.log().slice(-3000)}`).join("\n");

	async function waitUntil(id: string, until: "preview" | "done", want: string, maxS = 240) {
		const end = Date.now() + maxS * 1000;
		for (;;) {
			const w = await waitJob(env.DB, id, until, 50);
			if (w.out?.error) throw new Error(`job error: ${w.out.error}\nagent log:\n${logs()}`);
			if (w.out?.state === want) return w;
			if (["failed", "cancelled"].includes(w.out!.state) || Date.now() > end) throw new Error(`state ${w.out?.state}, wanted ${want}\nagent log:\n${logs()}`);
		}
	}

	async function stop() {
		vi.unstubAllGlobals();
		for (const a of agents) a.proc.kill("SIGKILL");
		await new Promise((r) => server.close(r));
		await rm(work, { recursive: true, force: true });
	}

	const states = async (id: string) =>
		(await env.DB.prepare("SELECT data_json FROM events WHERE job_id = ? AND kind = 'state' ORDER BY id").bind(id).all<{ data_json: string }>()).results.map(
			(e) => (JSON.parse(e.data_json) as { to: string }).to,
		);

	/** ffprobe a buffer: duration + streams. */
	async function probe(bytes: Buffer, name = "uploaded.mp4") {
		const { writeFile } = await import("node:fs/promises");
		const f = join(work, name);
		await writeFile(f, bytes);
		const p = has("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height", "-of", "json", f]);
		const info = JSON.parse(p.stdout) as { format: { duration: string }; streams: { codec_type: string; codec_name: string; width?: number; height?: number }[] };
		return { duration: Number(info.format.duration), streams: info.streams };
	}

	return { env, base, work, createBodies, deleted, sessions, files, spawnAgent, waitUntil, stop, logs, states, probe };
}
