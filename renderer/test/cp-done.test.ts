// /done is retried on timeout/network/5xx and never throws for them (a throw would post /error and re-render).
import assert from "node:assert/strict";
import { test } from "node:test";
import { ControlPlane, Gone } from "../agent/cp.ts";

async function withFetch(replies: (() => Response)[], fn: (cp: ControlPlane, calls: () => number) => Promise<void>) {
	const real = globalThis.fetch;
	let n = 0;
	globalThis.fetch = (async () => replies[n++]()) as typeof fetch;
	try {
		await fn(new ControlPlane("https://cp.test", "j1", "tok"), () => n);
	} finally {
		globalThis.fetch = real;
	}
}
const timeout = () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); };
const body = { file_id: "f1", md5: "abc", size: 1 };

test("/done: timeout then 200 -> retried, resolves", () =>
	withFetch([timeout, () => new Response("{}")], async (cp, calls) => {
		await cp.done(body, 0);
		assert.equal(calls(), 2);
	}));

test("/done: network error, 500, then 410 -> success (job finished by the earlier attempt)", () =>
	withFetch([() => { throw new TypeError("fetch failed"); }, () => new Response("x", { status: 500 }), () => new Response("gone", { status: 410 })], async (cp, calls) => {
		await cp.done(body, 0);
		assert.equal(calls(), 3);
	}));

test("/done: 410 on the first attempt -> Gone; 400 -> Error (real failures still surface)", async () => {
	await withFetch([() => new Response("gone", { status: 410 })], (cp) => assert.rejects(cp.done(body, 0), (e) => e instanceof Gone));
	await withFetch([() => new Response("bad", { status: 400 })], (cp) => assert.rejects(cp.done(body, 0), (e) => e instanceof Error && !(e instanceof Gone)));
});

test("/done: 409 (another file holds the claim) -> resolves, no retry", () =>
	withFetch([() => new Response("claimed", { status: 409 })], async (cp, calls) => {
		await cp.done(body, 0);
		assert.equal(calls(), 1);
	}));
