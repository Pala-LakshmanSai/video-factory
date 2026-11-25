// Video Factory control plane: Cloudflare Worker (SPEC §2).
//   /mcp            MCP tools (§4), behind GitHub OAuth (template) locked to ALLOWED_GITHUB_LOGIN
//   /agent/{job}/*  agent API (§5), per-job Bearer token, no OAuth
//   /admin/*        status page + fault injection, GitHub sign-in cookie
//   /sync/*         cross-account sync: file index, owner preferences, docs (docs/SYNC.md); GitHub-token auth
//   crons           watchdog (1 min), reaper + bench finish (5 min), benchmark (Sunday 03:00 UTC)
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { env } from "cloudflare:workers";
import { adminApp } from "./admin";
import { agentApp } from "./agent";
import { finishBench, startBench } from "./bench";
import { GitHubHandler } from "./github-handler";
import { createServer } from "./mcp";
import { balanceCheck, reaper } from "./reaper";
import { watchdog } from "./watchdog";
import { constantTimeEqual } from "./db";
import { uploadInput } from "./drive";
import { putPackageBytes } from "./packages";
import { submitJob } from "./mcp";
import { getDoc, syncRoute } from "./sync";
import { KEY_RE, checkAccessKey } from "./access";
import type { Props } from "./utils";

const mcpHandler = createMcpHandler(createServer);

const oauth = new OAuthProvider<Env>({
	apiHandler: {
		async fetch(req: Request, e: Env, ctx: ExecutionContext) {
			// Access-key sign-ins (login "key:<name>") end when the owner revokes the key, not when the token expires.
			const login = (ctx as unknown as { props?: Props }).props?.login ?? "";
			if (login.startsWith("key:") && !(await e.DB.prepare("SELECT 1 FROM access_keys WHERE name = ? AND revoked_at IS NULL").bind(login.slice(4)).first()))
				return new Response("access key revoked", { status: 401 });
			return mcpHandler(req, e, ctx);
		},
	} satisfies ExportedHandler<Env>,
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: GitHubHandler as any,
	tokenEndpoint: "/token",
	resourceMetadata: { resource: env.MCP_RESOURCE },
});

// POST /upload/plan?job=<id> (scene_plan JSON) or /upload/input?name=<file name>, body = audio bytes, Bearer UPLOAD_TOKEN (wrangler secret; unset = route off).
// Returns {drive_file_id} for acquire_gpu's voiceover. Drive's drive.file scope only reads files this app created.
async function uploadRoute(req: Request, e: Env) {
	const token = (e as unknown as Record<string, string | undefined>).UPLOAD_TOKEN;
	const got = req.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
	if (!token || !constantTimeEqual(got, token)) return new Response("unauthorized", { status: 401 });
	const q = new URL(req.url).searchParams;
	// /upload/plan?job=<id>, body = scene_plan JSON: same as MCP submit_job, for plans too big to paste into a tool call.
	if (new URL(req.url).pathname === "/upload/plan") return Response.json(await submitJob(e.DB, q.get("job") ?? "", await req.json(), e.OAUTH_KV));
	// /upload/package?name=<name>, body = .tar.gz bytes: same as MCP upload_package, for packages too big to paste as base64.
	if (new URL(req.url).pathname === "/upload/package") {
		const name = q.get("name") ?? "";
		if (!/^[a-z0-9-]{1,64}$/.test(name)) return Response.json({ error: "name must match ^[a-z0-9-]{1,64}$" }, { status: 400 });
		return Response.json(await putPackageBytes(e.OAUTH_KV, name, new Uint8Array(await req.arrayBuffer())));
	}
	const name = q.get("name") || "voiceover.mp3";
	const id = await uploadInput(e, name, req.headers.get("Content-Type") || "audio/mpeg", await req.arrayBuffer());
	return Response.json({ drive_file_id: id });
}

// GET /install (Mac: scripts/install.sh) and /install.ps1 (Windows: scripts/install.ps1), published with the docs. Public: it holds no secrets,
// and everything it fetches from the factory needs the owner's GitHub sign-in.
// ?key=vfk_... (a team member's personal line) fills the script's one placeholder line with that key.
async function installScript(e: Env, name: string, key: string | null) {
	const doc = await getDoc(e.DB, name);
	if (!doc) return new Response("echo 'install script not published yet'; exit 1\n", { status: 503, headers: { "Content-Type": "text/plain" } });
	let body = doc.body;
	if (key && KEY_RE.test(key)) body = name.endsWith(".ps1") ? body.replace('$VfKeyFromLink = ""', `$VfKeyFromLink = "${key}"`) : body.replace('VF_KEY_FROM_LINK=""', `VF_KEY_FROM_LINK="${key}"`);
	return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

// GET /team: the production team's setup guide (docs/team-setup.html, published with the docs). Public, no secrets.
async function teamGuide(e: Env) {
	const doc = await getDoc(e.DB, "team-setup.html");
	if (!doc) return new Response("team guide not published yet", { status: 503 });
	return new Response(doc.body, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline'; img-src data:" } });
}

// Claude Code on a team member's computer connects with its access key as a header (scripts/vf.mjs setup adds it),
// so it needs no browser sign-in. Same identity as a key sign-in through the OAuth page.
async function mcpWithKey(req: Request, e: Env, ctx: ExecutionContext, key: string) {
	const who = await checkAccessKey(e.DB, key);
	if (!who) return new Response("access key not valid", { status: 401 });
	const props = { login: `key:${who.name}`, name: who.name, accessToken: "", email: null };
	return mcpHandler(req, e, { waitUntil: ctx.waitUntil.bind(ctx), passThroughOnException: ctx.passThroughOnException.bind(ctx), props } as unknown as ExecutionContext);
}

export default {
	fetch(req: Request, e: Env, ctx: ExecutionContext) {
		const path = new URL(req.url).pathname;
		if (path.startsWith("/agent/")) return agentApp.fetch(req, e, ctx);
		if (path.startsWith("/admin") || path === "/callback/admin") return adminApp.fetch(req, e, ctx);
		if (path.startsWith("/sync/")) return syncRoute(req, e);
		if ((path === "/install" || path === "/install.ps1") && req.method === "GET") return installScript(e, path === "/install.ps1" ? "install.ps1" : "install.sh", new URL(req.url).searchParams.get("key"));
		if (path === "/team" && req.method === "GET") return teamGuide(e);
		const bearer = req.headers.get("Authorization")?.replace(/^Bearer /i, "") ?? "";
		if (path === "/mcp" && bearer.startsWith("vfk_")) return mcpWithKey(req, e, ctx, bearer);
		if ((path === "/upload/input" || path === "/upload/plan" || path === "/upload/package") && req.method === "POST") return uploadRoute(req, e);
		return oauth.fetch(req, e, ctx);
	},

	async scheduled(controller: ScheduledController, e: Env, ctx: ExecutionContext) {
		const run = async (name: string, fn: () => Promise<unknown>) => {
			try {
				await fn();
			} catch (err) {
				console.error(`${name} failed`, err);
			}
		};
		switch (controller.cron) {
			case "* * * * *":
				await run("watchdog", () => watchdog(e, e.DB));
				break;
			case "*/5 * * * *":
				await run("reaper", () => reaper(e, e.DB));
				await run("bench finish", () => finishBench(e, e.DB));
				if (new Date(controller.scheduledTime).getUTCHours() === 6 && new Date(controller.scheduledTime).getUTCMinutes() < 5) {
					await run("balance", () => balanceCheck(e));
				}
				break;
			case "0 3 * * SUN":
				await run("bench start", () => startBench(e, e.DB));
				break;
		}
	},
} satisfies ExportedHandler<Env>;
