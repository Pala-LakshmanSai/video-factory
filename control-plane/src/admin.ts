// Prompt 7.4 GET /admin/status and Prompt 9 POST /admin/fault, behind a GitHub sign-in limited to
// ALLOWED_GITHUB_LOGIN. Uses the same GitHub OAuth App; its callback /callback/admin is a sub-path of the
// registered /callback, which GitHub allows. Session = HMAC-signed cookie (COOKIE_ENCRYPTION_KEY), 12 h.
// Dev-only POST /dev/acquire lives here too (enabled only when DEV_ROUTES="1").
import { Hono } from "hono";
import { getUpstreamAuthorizeUrl, fetchUpstreamAuthToken } from "./utils";
import { selectAndCreate } from "./selector";
import { acquireGpu } from "./mcp";
import { armFault } from "./faults";
import { now, randomId } from "./db";

type Ctx = { Bindings: Env };
export const adminApp = new Hono<Ctx>();

const COOKIE = "vf_admin";
const enc = new TextEncoder();

async function hmac(key: string, msg: string) {
	const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const sig = await crypto.subtle.sign("HMAC", k, enc.encode(msg));
	return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sessionLogin(c: { req: { header: (n: string) => string | undefined }; env: Env }) {
	const m = /(?:^|;\s*)vf_admin=([^;]+)/.exec(c.req.header("Cookie") ?? "");
	if (!m) return null;
	const [login, exp, sig] = decodeURIComponent(m[1]).split("|");
	if (!login || Number(exp) < now() || sig !== (await hmac(c.env.COOKIE_ENCRYPTION_KEY, `${login}|${exp}`))) return null;
	return login === c.env.ALLOWED_GITHUB_LOGIN ? login : null;
}

adminApp.get("/admin/login", (c) => {
	const state = randomId("s_");
	return new Response(null, {
		status: 302,
		headers: {
			Location: getUpstreamAuthorizeUrl({
				upstream_url: "https://github.com/login/oauth/authorize",
				client_id: c.env.GITHUB_CLIENT_ID,
				redirect_uri: new URL("/callback/admin", c.req.url).href,
				scope: "read:user",
				state,
			}),
			"Set-Cookie": `vf_admin_state=${state}; Path=/callback/admin; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
		},
	});
});

adminApp.get("/callback/admin", async (c) => {
	const state = /(?:^|;\s*)vf_admin_state=([^;]+)/.exec(c.req.header("Cookie") ?? "")?.[1];
	if (!state || state !== c.req.query("state")) return c.text("bad state", 400);
	const [token, err] = await fetchUpstreamAuthToken({
		upstream_url: "https://github.com/login/oauth/access_token",
		client_id: c.env.GITHUB_CLIENT_ID,
		client_secret: c.env.GITHUB_CLIENT_SECRET,
		code: c.req.query("code"),
		redirect_uri: new URL("/callback/admin", c.req.url).href,
	});
	if (err) return err;
	const user = (await (await fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${token}`, "User-Agent": "video-factory" } })).json()) as { login?: string };
	if (user.login !== c.env.ALLOWED_GITHUB_LOGIN) return c.text("forbidden", 403);
	const exp = now() + 12 * 3600_000;
	const value = encodeURIComponent(`${user.login}|${exp}|${await hmac(c.env.COOKIE_ENCRYPTION_KEY, `${user.login}|${exp}`)}`);
	return new Response(null, {
		status: 302,
		headers: { Location: "/admin/status", "Set-Cookie": `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200` },
	});
});

adminApp.use("/admin/*", async (c, next) => {
	if (c.req.path === "/admin/login") return next();
	if (!(await sessionLogin(c))) return c.redirect("/admin/login");
	await next();
});

adminApp.get("/admin/status", async (c) => {
	const db = c.env.DB;
	const jobs = (await db.prepare("SELECT id, state, title, style, gpu_label, pct, cost_usd, created_at FROM jobs WHERE state NOT IN ('done','failed','cancelled') OR created_at > ? ORDER BY created_at DESC LIMIT 100").bind(now() - 86400_000).all()).results;
	const pods = (await db.prepare("SELECT id, job_id, gpu_type_id, data_center_id, cost_per_hr, created_at, last_heartbeat_at FROM pods WHERE deleted_at IS NULL").all()).results;
	const dayStart = new Date().setUTCHours(0, 0, 0, 0);
	const spend = await db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM jobs WHERE created_at >= ?").bind(dayStart).first<{ usd: number }>();
	const table = (rows: Record<string, unknown>[]) =>
		rows.length
			? `<table><tr>${Object.keys(rows[0]).map((k) => `<th>${esc(k)}</th>`).join("")}</tr>${rows.map((r) => `<tr>${Object.values(r).map((v) => `<td>${esc(fmt(v))}</td>`).join("")}</tr>`).join("")}</table>`
			: "<p>none</p>";
	return c.html(`<!doctype html><meta charset=utf-8><meta http-equiv=refresh content=15><title>Video Factory status</title>
<style>body{font:14px system-ui;margin:24px}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px;text-align:left}</style>
<h1>Video Factory</h1><p>Spend today (UTC): <b>$${(spend?.usd ?? 0).toFixed(2)}</b></p>
<h2>Live pods (${pods.length})</h2>${table(pods)}<h2>Jobs (live + last 24 h)</h2>${table(jobs)}`);
});

adminApp.post("/admin/fault", async (c) => {
	if (String(c.env.FAULTS_ENABLED) !== "1") return c.json({ error: "FAULTS_ENABLED is not 1" }, 403);
	const { job_id, fault } = await c.req.json<{ job_id: string; fault: string }>();
	try {
		return c.json({ ok: await armFault(c.env, job_id, fault) });
	} catch (e) {
		return c.json({ error: String((e as Error).message) }, 400);
	}
});

adminApp.get("/admin/pods", async (c) => {
	const rows = (await c.env.DB.prepare("SELECT id, job_id, created_at FROM pods WHERE deleted_at IS NULL").all()).results;
	return c.json(rows);
});

adminApp.get("/admin/job/:job", async (c) => c.json(await c.env.DB.prepare("SELECT id, state, error_json, drive_link, cost_usd, attempts FROM jobs WHERE id = ?").bind(c.req.param("job")).first()));

adminApp.get("/admin/events/:job", async (c) => {
	const rows = (await c.env.DB.prepare("SELECT ts, kind, data_json FROM events WHERE job_id = ? ORDER BY id").bind(c.req.param("job")).all()).results;
	return c.json(rows);
});

/** Dev only (Prompt 3b / 4b): rent a pod with the dummy CUDA image (deleted after 60 s) or RENDERER_IMAGE. */
adminApp.post("/dev/acquire", async (c) => {
	if (String(c.env.DEV_ROUTES) !== "1") return c.notFound();
	const { image } = await c.req.json<{ image?: "dummy" | "renderer" }>().catch(() => ({ image: undefined }));
	const mode = image === "renderer" ? "renderer" : "dummy";
	const { job_id } = await acquireGpu(c.env, c.env.DB, { style: "explainer", title: `dev ${mode}`, voiceover: { text: "dev" }, chat_key: randomId("dev-") }, { dev_mode: mode });
	const result = await selectAndCreate(c.env, c.env.DB, job_id);
	const events = (await c.env.DB.prepare("SELECT ts, kind, data_json FROM events WHERE job_id = ? ORDER BY id").bind(job_id).all()).results;
	return c.json({ job_id, result, events });
});

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const fmt = (v: unknown) => (typeof v === "number" && v > 1e12 ? new Date(v).toISOString().replace("T", " ").slice(0, 19) : String(v ?? ""));
