// A deliberate hold (503 + X-VF-Hold) is Held (control plane reachable); a plain 503 is an ordinary error (outage).
import assert from "node:assert/strict";
import { test } from "node:test";
import { ControlPlane, Held } from "../agent/cp.ts";

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
