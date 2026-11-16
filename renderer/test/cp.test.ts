// A deliberate hold (503 + X-VF-Hold) is Held (control plane reachable); a plain 503 is an ordinary error (outage).
import assert from "node:assert/strict";
import { test } from "node:test";
import { ControlPlane, Held, PREVIEW_CHUNK } from "../agent/cp.ts";

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
