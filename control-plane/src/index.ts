// Video Factory control plane: Cloudflare Worker (SPEC §2).
//   /mcp            MCP tools (§4), behind GitHub OAuth (template) locked to ALLOWED_GITHUB_LOGIN
//   /agent/{job}/*  agent API (§5), per-job Bearer token, no OAuth
//   /admin/*        status page + fault injection, GitHub sign-in cookie
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

export default {
	fetch(req: Request, e: Env, ctx: ExecutionContext) {
		const path = new URL(req.url).pathname;
		if (path.startsWith("/agent/")) return agentApp.fetch(req, e, ctx);
		if (path.startsWith("/admin") || path === "/callback/admin") return adminApp.fetch(req, e, ctx);
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
