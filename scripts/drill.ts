// Phase 9 drills: arm one fault against a live job and report how it recovered.
//   CP_URL=https://<worker> ADMIN_COOKIE='vf_admin=...' node scripts/drill.ts <job_id|*> <fault> [minutes=15]
// ADMIN_COOKIE: sign in at <CP_URL>/admin/login, then copy the vf_admin cookie from the browser.
// Needs Worker var FAULTS_ENABLED="1" (set it back to "0" afterwards).
const [jobId, fault, minutes = "15"] = process.argv.slice(2);
const CP = process.env.CP_URL?.replace(/\/$/, "");
const cookie = process.env.ADMIN_COOKIE ?? "";
if (!jobId || !fault || !CP) {
	console.error("usage: CP_URL=... ADMIN_COOKIE=... node scripts/drill.ts <job_id|*> <fault> [minutes]");
	process.exit(2);
}
const get = async (path: string) => {
	const r = await fetch(CP + path, { headers: { Cookie: cookie } });
	if (!r.ok || r.redirected) throw new Error(`${path}: ${r.status} (is ADMIN_COOKIE valid?)`);
	return r.json();
};
const armed = await fetch(CP + "/admin/fault", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ job_id: jobId, fault }) });
console.error(await armed.text());
if (!armed.ok || jobId === "*") process.exit(armed.ok ? 0 : 1);

const RECOVERY = ["boot_timeout", "heartbeat_lost", "cost_reject", "create_failed", "pod_created", "render_error", "verify", "upload_session", "reaper_delete", "state"];
const t0 = Date.now();
let state = "";
const deadline = t0 + Number(minutes) * 60_000;
while (Date.now() < deadline) {
	state = ((await get(`/admin/job/${jobId}`)) as { state: string }).state;
	if (["done", "failed", "cancelled"].includes(state)) break;
	await new Promise((r) => setTimeout(r, 10_000));
}
const events = (await get(`/admin/events/${jobId}`)) as { ts: number; kind: string; data_json: string | null }[];
const after = events.filter((e) => e.ts >= t0 && RECOVERY.includes(e.kind));
const pods = ((await get("/admin/pods")) as { job_id: string }[]).filter((p) => p.job_id === jobId).length;
const job = await get(`/admin/job/${jobId}`);
console.log(`### Drill: \`${fault}\` on \`${jobId}\`\n`);
console.log(`| t+s | event | data |\n|---|---|---|`);
for (const e of after) console.log(`| ${Math.round((e.ts - t0) / 1000)} | ${e.kind} | ${(e.data_json ?? "").replace(/\|/g, "\\|").slice(0, 160)} |`);
console.log(`\n- Final state: **${state}** ${JSON.stringify(job)}`);
console.log(`- Seconds to recover: ${after.length ? Math.round((after.at(-1)!.ts - t0) / 1000) : "n/a"}`);
console.log(`- Pods alive for this job at the end: **${pods}** ${pods === 0 ? "(OK)" : "(should be 0 once the job is terminal)"}`);
