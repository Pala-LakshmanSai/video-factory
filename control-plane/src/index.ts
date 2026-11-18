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
import { syncRoute } from "./sync";

const mcpHandler = createMcpHandler(createServer);

const oauth = new OAuthProvider<Env>({
	apiHandler: { fetch: (req: Request, e: Env, ctx: ExecutionContext) => mcpHandler(req, e, ctx) } satisfies ExportedHandler<Env>,
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

export default {
	fetch(req: Request, e: Env, ctx: ExecutionContext) {
		const path = new URL(req.url).pathname;
		if (path.startsWith("/agent/")) return agentApp.fetch(req, e, ctx);
		if (path.startsWith("/admin") || path === "/callback/admin") return adminApp.fetch(req, e, ctx);
		if (path.startsWith("/sync/")) return syncRoute(req, e);
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
