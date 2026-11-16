#!/usr/bin/env node
// Build a per-video style package for style "custom" (see docs/KIT_WORKFLOW.md).
//   node scripts/pack-style.mjs <package-dir> [scene_plan.json]
// <package-dir> root must hold tokens.json and one <template>.html per template id the plan uses.
// Writes <package-dir>.tar.gz and <package-dir>.b64 (the data_b64 for upload_package). No symlinks, ≤ 8 MiB.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const [dirArg, planArg] = process.argv.slice(2);
if (!dirArg) throw new Error("usage: node scripts/pack-style.mjs <package-dir> [scene_plan.json]");
const dir = resolve(dirArg);
const fail = (m) => { console.error(`pack-style: ${m}`); process.exit(1); };

if (!existsSync(join(dir, "tokens.json"))) fail("tokens.json missing at package root");
JSON.parse(readFileSync(join(dir, "tokens.json"), "utf8"));
const walk = (d) => readdirSync(d).flatMap((f) => {
	const p = join(d, f);
	const st = lstatSync(p);
	if (st.isSymbolicLink()) fail(`symlink not allowed: ${p}`);
	return st.isDirectory() ? walk(p) : [p];
});
const files = walk(dir);
if (planArg) {
	const plan = JSON.parse(readFileSync(resolve(planArg), "utf8"));
	if (plan.style !== "custom") fail('scene_plan.style must be "custom"');
	for (const s of plan.scenes ?? []) {
		if (!/^[a-z0-9-]{1,40}$/.test(s.template)) fail(`bad template id "${s.template}"`);
		if (!existsSync(join(dir, `${s.template}.html`))) fail(`scene ${s.n}: ${s.template}.html missing from package`);
	}
	for (const s of JSON.stringify(plan).matchAll(/https?:\/\//g)) fail("plan contains a URL; render time has no network (inline data: URIs)");
}
const out = `${dir}.tar.gz`;
execFileSync("tar", ["-czf", out, "-C", dir, "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
const bytes = statSync(out).size;
if (bytes > 8 * 1024 * 1024) fail(`package is ${(bytes / 1048576).toFixed(1)} MiB > 8 MiB`);
writeFileSync(`${dir}.b64`, readFileSync(out).toString("base64"));
console.log(JSON.stringify({ package: out, b64: `${dir}.b64`, files: files.length, bytes, name: basename(dir).toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 64) }));
