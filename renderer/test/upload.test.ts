// Pod-side resumable upload (SPEC §7) against a fake Drive session server.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resumableUpload } from "../agent/upload.ts";

const CHUNK = 256 * 1024;

function fakeDrive(opts: { killFirstSessionAfter?: number } = {}) {
	const sessions = new Map<string, { buf: Buffer[]; got: number; dead: boolean; puts: number }>();
	let n = 0;
	const newSession = async () => {
		const uri = `https://upload.test/s${++n}`;
		sessions.set(uri, { buf: [], got: 0, dead: false, puts: 0 });
		return uri;
	};
	const fetch = (async (uri: string, init: RequestInit) => {
		assert.equal((init.headers as Record<string, string>).Authorization, undefined, "no auth header on session PUTs");
		const s = sessions.get(uri)!;
		if (s.dead) return new Response("gone", { status: 404 });
		const range = (init.headers as Record<string, string>)["Content-Range"];
		const m = /bytes (\*|(\d+)-(\d+))\/(\d+)/.exec(range)!;
		const size = Number(m[4]);
		const r308 = () => new Response(null, { status: 308, headers: s.got ? { Range: `bytes=0-${s.got - 1}` } : {} });
		if (m[1] === "*") return s.got === size ? Response.json({ id: "file1" }, { status: 200 }) : r308();
		assert.equal(Number(m[2]), s.got, "chunk starts where the server left off");
		s.buf.push(Buffer.from(init.body as Uint8Array));
		s.got = Number(m[3]) + 1;
		s.puts++;
		if (opts.killFirstSessionAfter && uri.endsWith("/s1") && s.puts >= opts.killFirstSessionAfter) s.dead = true;
		return s.got === size ? Response.json({ id: "file1" }, { status: 201 }) : r308();
	}) as typeof globalThis.fetch;
	return { sessions, newSession, fetch };
}

async function file(bytes: number) {
	const dir = await mkdtemp(join(tmpdir(), "vfup-"));
	const data = Buffer.alloc(bytes, 7).map((_, i) => (i * 31) % 251);
	const p = join(dir, "v.mp4");
	await writeFile(p, data);
	return { p, data };
}

const md5 = (b: Uint8Array) => createHash("md5").update(b).digest("hex");

test("uploads in chunks and resumes after a simulated drop via bytes */size", async () => {
	const { p, data } = await file(CHUNK * 3 + 1000);
	const d = fakeDrive();
	const id = await resumableUpload(p, data.length, { newSession: d.newSession, fetch: d.fetch, chunk: CHUNK, dropAfterChunk: 1, log: () => {} });
	assert.equal(id, "file1");
	assert.equal(d.sessions.size, 1, "same session resumed");
	assert.equal(md5(Buffer.concat(d.sessions.get("https://upload.test/s1")!.buf)), md5(data));
});

test("a dead session (404) opens a new one and restarts from byte 0", async () => {
	const { p, data } = await file(CHUNK * 3);
	const d = fakeDrive({ killFirstSessionAfter: 1 });
	await resumableUpload(p, data.length, { newSession: d.newSession, fetch: d.fetch, chunk: CHUNK, log: () => {} });
	assert.equal(d.sessions.size, 2);
	assert.equal(md5(Buffer.concat(d.sessions.get("https://upload.test/s2")!.buf)), md5(data));
});
