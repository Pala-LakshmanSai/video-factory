import { env } from "cloudflare:workers";
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { Octokit } from "octokit";
import { checkAccessKey } from "./access";
import { fetchUpstreamAuthToken, getUpstreamAuthorizeUrl, type Props } from "./utils";
import {
	addApprovedClient,
	bindStateToSession,
	createOAuthState,
	generateCSRFProtection,
	isClientApproved,
	OAuthError,
	renderApprovalDialog,
	validateCSRFToken,
	validateOAuthState,
} from "./workers-oauth-utils";

const app = new Hono<{ Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } }>();

app.get("/authorize", async (c) => {
	const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
	const { clientId } = oauthReqInfo;
	if (!clientId) {
		return c.text("Invalid request", 400);
	}

	// Check if client is already approved
	if (await isClientApproved(c.req.raw, clientId, env.COOKIE_ENCRYPTION_KEY)) {
		// Skip approval dialog but still create secure state and bind to session
		const { stateToken } = await createOAuthState(oauthReqInfo, c.env.OAUTH_KV);
		const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);
		return redirectToGithub(c.req.raw, stateToken, { "Set-Cookie": sessionBindingCookie });
	}

	return consentPage(c.req.raw, c.env.OAUTH_PROVIDER, oauthReqInfo);
});

/** The consent dialog with a fresh one-time CSRF token (a new cookie replaces any earlier one). */
async function consentPage(request: Request, provider: OAuthHelpers, oauthReqInfo: AuthRequest, error?: string, status = 200) {
	const { token: csrfToken, setCookie } = generateCSRFProtection();
	const page = renderApprovalDialog(request, {
		client: await provider.lookupClient(oauthReqInfo.clientId),
		csrfToken,
		error,
		server: {
			description: "Video Factory render control plane.",
			logo: "https://avatars.githubusercontent.com/u/314135?s=200&v=4",
			name: "Video Factory",
		},
		setCookie,
		state: { oauthReqInfo },
	});
	return new Response(page.body, { headers: page.headers, status });
}

app.post("/authorize", async (c) => {
	try {
		// Read form data once
		const formData = await c.req.raw.formData();

		// Validate CSRF token
		const { clearCookie: clearCsrf } = validateCSRFToken(formData, c.req.raw);

		// Extract state from form data
		const encodedState = formData.get("state");
		if (!encodedState || typeof encodedState !== "string") {
			return c.text("Missing state in form data", 400);
		}

		let state: { oauthReqInfo?: AuthRequest };
		try {
			state = JSON.parse(atob(encodedState));
		} catch (_e) {
			return c.text("Invalid state data", 400);
		}

		if (!state.oauthReqInfo || !state.oauthReqInfo.clientId) {
			return c.text("Invalid request", 400);
		}

		// Access-key form (team members without GitHub): same CSRF + state checks as above, then authorize here.
		// completeAuthorization re-checks the redirect URI against the registered client and PKCE.
		const key = formData.get("access_key");
		if (key !== null) {
			const who = typeof key === "string" ? await checkAccessKey(c.env.DB, key.trim()) : null;
			if (!who) return consentPage(c.req.raw, c.env.OAUTH_PROVIDER, state.oauthReqInfo, "That key isn't valid. Ask the owner for a new one.", 401);
			const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
				metadata: { label: who.name },
				props: { accessToken: "", email: null, login: `key:${who.name}`, name: who.name } satisfies Props,
				request: state.oauthReqInfo,
				scope: state.oauthReqInfo.scope,
				userId: `key_${encodeURIComponent(who.name)}`, // no ":" allowed; "_" never appears in a GitHub login
			});
			return new Response(null, { status: 302, headers: { Location: redirectTo, "Set-Cookie": clearCsrf } });
		}

		// Add client to approved list
		const approvedClientCookie = await addApprovedClient(
			c.req.raw,
			state.oauthReqInfo.clientId,
			c.env.COOKIE_ENCRYPTION_KEY,
		);

		// Create OAuth state and bind it to this user's session
		const { stateToken } = await createOAuthState(state.oauthReqInfo, c.env.OAUTH_KV);
		const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);

		// Set both cookies: approved client list + session binding
		const headers = new Headers();
		headers.append("Set-Cookie", approvedClientCookie);
		headers.append("Set-Cookie", sessionBindingCookie);

		return redirectToGithub(c.req.raw, stateToken, headers); // not Object.fromEntries: it keeps only the last Set-Cookie
	} catch (error: any) {
		console.error("POST /authorize error:", error);
		if (error instanceof OAuthError) {
			return error.toResponse();
		}
		// Unexpected non-OAuth error
		return c.text(`Internal server error: ${error.message}`, 500);
	}
});

async function redirectToGithub(
	request: Request,
	stateToken: string,
	headersInit: HeadersInit = {},
) {
	const headers = new Headers(headersInit);
	headers.set(
		"location",
		getUpstreamAuthorizeUrl({
			client_id: env.GITHUB_CLIENT_ID,
			redirect_uri: new URL("/callback", request.url).href,
			scope: "read:user user:email", // user:email: lets MCP_USERS name people by a verified email
			state: stateToken,
			upstream_url: "https://github.com/login/oauth/authorize",
		}),
	);
	return new Response(null, { headers, status: 302 });
}

/**
 * OAuth Callback Endpoint
 *
 * This route handles the callback from GitHub after user authentication.
 * It exchanges the temporary code for an access token, then stores some
 * user metadata & the auth token as part of the 'props' on the token passed
 * down to the client. It ends by redirecting the client back to _its_ callback URL
 *
 * SECURITY: This endpoint validates that the state parameter from GitHub
 * matches both:
 * 1. A valid state token in KV (proves it was created by our server)
 * 2. The __Host-CONSENTED_STATE cookie (proves THIS browser consented to it)
 *
 * This prevents CSRF attacks where an attacker's state token is injected
 * into a victim's OAuth flow.
 */
app.get("/callback", async (c) => {
	// Validate OAuth state with session binding
	// This checks both KV storage AND the session cookie
	let oauthReqInfo: AuthRequest;
	let clearSessionCookie: string;

	try {
		const result = await validateOAuthState(c.req.raw, c.env.OAUTH_KV);
		oauthReqInfo = result.oauthReqInfo;
		clearSessionCookie = result.clearCookie;
	} catch (error: any) {
		if (error instanceof OAuthError) {
			return error.toResponse();
		}
		// Unexpected non-OAuth error
		return c.text("Internal server error", 500);
	}

	if (!oauthReqInfo.clientId) {
		return c.text("Invalid OAuth request data", 400);
	}

	// Exchange the code for an access token
	const [accessToken, errResponse] = await fetchUpstreamAuthToken({
		client_id: c.env.GITHUB_CLIENT_ID,
		client_secret: c.env.GITHUB_CLIENT_SECRET,
		code: c.req.query("code"),
		redirect_uri: new URL("/callback", c.req.url).href,
		upstream_url: "https://github.com/login/oauth/access_token",
	});
	if (errResponse) return errResponse;

	// Fetch the user info from GitHub
	const user = await new Octokit({ auth: accessToken }).rest.users.getAuthenticated();
	const { login, name, email } = user.data;
	// Auth lock: the owner, plus anyone in the MCP_USERS secret (comma-separated GitHub logins or verified emails).
	if (!(await connectorAllowed(c.env, login, accessToken))) {
		return c.text(`GitHub user ${login} is not allowed`, 403);
	}

	// Return back to the MCP client a new token
	const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
		metadata: {
			label: name,
		},
		// This will be available through getMcpAuthContext() in MCP handlers.
		props: {
			accessToken,
			email,
			login,
			name,
		} as Props,
		request: oauthReqInfo,
		scope: oauthReqInfo.scope,
		userId: login,
	});

	// Clear the session binding cookie (one-time use) by creating response with headers
	const headers = new Headers({ Location: redirectTo });
	if (clearSessionCookie) {
		headers.set("Set-Cookie", clearSessionCookie);
	}

	return new Response(null, {
		status: 302,
		headers,
	});
});

export { app as GitHubHandler };

/** Owner, or listed in MCP_USERS (wrangler secret, not in git): GitHub logins or verified emails, comma-separated. */
export async function connectorAllowed(e: Env, login: string, accessToken: string) {
	const norm = (x: string) => x.trim().toLowerCase();
	if (norm(login) === norm(e.ALLOWED_GITHUB_LOGIN)) return true;
	const users = new Set(((e as unknown as Record<string, string | undefined>).MCP_USERS ?? "").split(",").map(norm).filter(Boolean));
	if (!users.size) return false;
	if (users.has(norm(login))) return true;
	const r = await fetch("https://api.github.com/user/emails", { headers: { Authorization: `Bearer ${accessToken}`, "User-Agent": "video-factory", Accept: "application/vnd.github+json" } });
	if (!r.ok) return false;
	return ((await r.json()) as { email: string; verified: boolean }[]).some((m) => m.verified && users.has(norm(m.email)));
}
