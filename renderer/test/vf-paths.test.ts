// scripts/vf.mjs sync keys: "/" on the server for every OS, native paths only on disk (Windows must match a Mac).
import assert from "node:assert/strict";
import { posix, win32 } from "node:path";
import { test } from "node:test";

process.env.VF_NO_MAIN = "1";
// @ts-ignore plain JS module
const { diskPath, toKey } = await import("../../scripts/vf.mjs");

test("keys map to native paths on Windows and macOS", () => {
	assert.equal(diskPath("C:\\Users\\a b\\.claude\\skills\\gta", "scripts/x/run.py", win32), "C:\\Users\\a b\\.claude\\skills\\gta\\scripts\\x\\run.py");
	assert.equal(diskPath("/Users/a/.claude/skills/gta", "scripts/x/run.py", posix), "/Users/a/.claude/skills/gta/scripts/x/run.py");
	assert.equal(toKey("gta:scripts\\x\\run.py", win32), "gta:scripts/x/run.py");
	assert.equal(toKey("gta:scripts/x/run.py", posix), "gta:scripts/x/run.py");
});

test("keys cannot escape the root or name an impossible Windows file", () => {
	for (const p of [win32, posix]) assert.throws(() => diskPath(p === win32 ? "C:\\r" : "/r", "a/../../etc/x", p), /escapes/);
	assert.throws(() => diskPath("C:\\r", "a\\..\\..\\x", win32), /Windows/);
	assert.throws(() => diskPath("C:\\r", "a/b:c.txt", win32), /Windows/);
	assert.equal(diskPath("/r", "a/b:c.txt", posix), "/r/a/b:c.txt");
});
