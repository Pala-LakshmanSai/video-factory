// A deliberate hold (503 + X-VF-Hold) is Held (control plane reachable); a plain 503 is an ordinary error (outage).
import assert from "node:assert/strict";
import { test } from "node:test";
import { ControlPlane, Held, PREVIEW_CHUNK, setPreviewBackoff } from "../agent/cp.ts";

test("hello: X-VF-Hold 503 -> Held, plain 503 -> Error", async () => {
	const real = globalThis.fetch;
	try {
		const cp = new ControlPlane("https://cp.test", "j1", "tok");
		globalThis.fetch = (async () => new Response('{"error":"slow_boot"}', { status: 503, headers: { "X-VF-Hold": "slow_boot" } })) as typeof fetch;
		await assert.rejects(cp.hello({} as never), (e) => e instanceof Held);
		globalThis.fetch = (async () => new Response("bad gateway", { status: 503 })) as typeof fetch;
		await assert.rejects(cp.hello({} as never), (e) => e instanceof Error && !(e instanceof Held));
	} finally {
		globalThis.fetch = real;
	}
});

test("previews: 777 frames go out in chunks of PREVIEW_CHUNK, every frame once", async () => {
	const real = globalThis.fetch;
	const seen: string[] = [];
	let posts = 0;
	try {
		globalThis.fetch = (async (_u: string, init: RequestInit) => {
			posts++;
			for (const [k] of (init.body as FormData).entries()) seen.push(k);
			return new Response(null, { status: 201 });
		}) as typeof fetch;
		const frames = new Map(Array.from({ length: 777 }, (_, i) => [`scene-${Math.floor(i / 3) + 1}-${i % 3}`, Buffer.from([i % 256])] as const));
		await new ControlPlane("https://cp.test", "j1", "tok").previews(frames);
		assert.equal(posts, Math.ceil(777 / PREVIEW_CHUNK));
		assert.deepEqual(seen, [...frames.keys()]);
	} finally {
		globalThis.fetch = real;
	}
});

test("previews: a 503 chunk is retried alone; a 4xx fails at once", async () => {
	const real = globalThis.fetch;
	setPreviewBackoff(1);
	try {
		let calls = 0;
		globalThis.fetch = (async () => (++calls === 2 ? new Response("busy", { status: 503 }) : new Response(null, { status: 201 }))) as typeof fetch;
		const frames = new Map(Array.from({ length: PREVIEW_CHUNK * 2 }, (_, i) => [`scene-${i + 1}-0`, Buffer.from([1])] as const));
		await new ControlPlane("https://cp.test", "j1", "tok").previews(frames);
		assert.equal(calls, 3); // chunk 1, chunk 2 (503), chunk 2 again
		calls = 0;
		globalThis.fetch = (async () => (calls++, new Response("too big", { status: 413 }))) as typeof fetch;
		await assert.rejects(new ControlPlane("https://cp.test", "j1", "tok").previews(frames), /413/);
		assert.equal(calls, 1);
	} finally {
		globalThis.fetch = real;
	}
});
