import assert from "node:assert/strict";
import { test } from "node:test";
import { retryLocked } from "../engine/voice.ts";

test("retryLocked retries a locked model file, then succeeds", async () => {
	let n = 0;
	const r = await retryLocked(async () => {
		if (++n < 3) throw new Error("Load model from C:\\m.onnx failed:system error number 13");
		return "ok";
	}, [1, 1, 1]);
	assert.equal(r, "ok");
	assert.equal(n, 3);
});

test("retryLocked throws other errors at once, and gives up after its waits", async () => {
	let n = 0;
	await assert.rejects(retryLocked(async () => (n++, Promise.reject(new Error("bad model"))), [1]), /bad model/);
	assert.equal(n, 1);
	await assert.rejects(retryLocked(() => Promise.reject(new Error("EACCES")), [1, 1]), /EACCES/);
});
