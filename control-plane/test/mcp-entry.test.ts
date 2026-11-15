// Worker entry (src/index.ts): path routing, the OAuth gate on /mcp (401 + RFC 9728 metadata), and the full
// GitHub OAuth dance (register -> authorize -> consent -> GitHub callback -> token) ending in an MCP call.
import { env as stubEnv } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { json, makeEnv, mockFetch } from "./helpers";

const ORIGIN = "https://cp.test";
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
let worker: typeof import("../src/index").default;
let e: Env;
let ghLogin = "me";

beforeAll(async () => {
	// index.ts reads env.MCP_RESOURCE at import time (resourceMetadata), so set the stub env first.
	Object.assign(stubEnv, makeEnv());
	worker = (await import("../src/index")).default;
});
beforeEach(() => {
	e = { ...makeEnv(), OAUTH_KV: memKv() } as Env;
	Object.assign(stubEnv, e); // github-handler reads secrets from the cloudflare:workers env
	ghLogin = "me";
	mockFetch(
		(u) => (u === "https://github.com/login/oauth/access_token" ? new Response("access_token=gho_x&token_type=bearer", { headers: { "Content-Type": "application/x-www-form-urlencoded" } }) : undefined),
		(u) => (u === "https://api.github.com/user" ? json({ login: ghLogin, name: "Me", email: null }) : undefined),
	);
});

/** KV over a Map with the bits OAuthProvider uses (get type:"json", list by prefix). */
function memKv() {
	const m = new Map<string, string>();
	return {
		get: async (k: string, o?: { type?: string } | string) => {
			const v = m.get(k) ?? null;
			return v !== null && (o === "json" || (typeof o === "object" && o?.type === "json")) ? JSON.parse(v) : v;
		},
		put: async (k: string, v: string) => void m.set(k, v),
		delete: async (k: string) => void m.delete(k),
		list: async ({ prefix = "" }: { prefix?: string } = {}) => ({ keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }),
	} as unknown as KVNamespace;
}

const req = (path: string, init: RequestInit = {}) => worker.fetch(new Request(ORIGIN + path, init), e, ctx);

describe("routing", () => {
	it("/agent/* goes to the agent API (job token, not OAuth)", async () => {
		const r = await req("/agent/j1/spec");
		expect(r.status).toBe(401);
		expect(await r.json()).toEqual({ error: "unauthorized" });
	});

	it("/admin*, /callback/admin and /dev/* go to the admin app", async () => {
		for (const p of ["/admin", "/admin/status", "/admin/pods"]) {
			const r = await req(p);
			expect([p, r.status, r.headers.get("location")]).toEqual([p, 302, "/admin/login"]);
		}
		const login = await req("/admin/login");
		expect(login.headers.get("location")).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize\?.*redirect_uri=https%3A%2F%2Fcp\.test%2Fcallback%2Fadmin/);
		expect(await (await req("/callback/admin?code=c&state=s")).text()).toBe("bad state");
		e = { ...e, DEV_ROUTES: "0" } as Env;
		expect((await req("/dev/acquire", { method: "POST" })).status).not.toBe(200); // old unauthenticated path is gone
		const dev = await req("/admin/dev/acquire", { method: "POST" });
		expect(dev.status).toBe(302); // dev route sits behind the GitHub admin sign-in
		expect(dev.headers.get("location")).toContain("/admin/login");
	});

	it("everything else goes to the OAuth provider / GitHub handler", async () => {
		const meta = await req("/.well-known/oauth-authorization-server");
		expect(meta.status).toBe(200);
		expect(await meta.json()).toMatchObject({ issuer: ORIGIN, authorization_endpoint: `${ORIGIN}/authorize`, token_endpoint: `${ORIGIN}/token`, registration_endpoint: `${ORIGIN}/register` });
		expect((await req("/nope")).status).toBe(404);
	});
});

describe("/mcp OAuth gate", () => {
	it("no token: 401 with a Bearer challenge pointing at the protected-resource metadata", async () => {
		const r = await req("/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
		expect(r.status).toBe(401);
		const www = r.headers.get("www-authenticate")!;
		expect(www).toMatch(/^Bearer /);
		const url = /resource_metadata="([^"]+)"/.exec(www)![1];
		expect(url).toBe(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`);
		const prm = await req(new URL(url).pathname);
		expect(prm.status).toBe(200);
		expect(await prm.json()).toMatchObject({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN] });
	});

	it("a made-up token: 401 invalid_token", async () => {
		const r = await req("/mcp", { method: "POST", headers: { Authorization: "Bearer a:b:c" }, body: "{}" });
		expect(r.status).toBe(401);
		expect(r.headers.get("www-authenticate")).toMatch(/invalid_token/);
	});
});

/** Minimal browser cookie jar. */
const jar = new Map<string, string>();
const keep = (r: Response) => {
	for (const c of r.headers.getSetCookie()) {
		const [kv] = c.split(";");
		const i = kv.indexOf("=");
		jar.set(kv.slice(0, i), kv.slice(i + 1));
	}
	return r;
};
const cookie = () => [...jar].filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join("; ");

async function oauthDance() {
	jar.clear();
	const redirect_uri = "https://claude.ai/api/mcp/auth_callback";
	const reg = await req("/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: [redirect_uri], token_endpoint_auth_method: "none", client_name: "Claude" }) });
	expect(reg.status).toBe(201);
	const { client_id } = (await reg.json()) as { client_id: string };

	const verifier = "v".repeat(50);
	const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
	const q = new URLSearchParams({ response_type: "code", client_id, redirect_uri, code_challenge: challenge, code_challenge_method: "S256", state: "claude-state", resource: `${ORIGIN}/mcp` });
	const dialog = keep(await req(`/authorize?${q}`));
	expect(dialog.status).toBe(200);
	const html = await dialog.text();
	const field = (n: string) => new RegExp(`name="${n}" value="([^"]+)"`).exec(html)![1];

	const consent = keep(await req("/authorize", { method: "POST", headers: { Cookie: cookie() }, body: new URLSearchParams({ state: field("state"), csrf_token: field("csrf_token") }) }));
	expect(consent.status).toBe(302);
	const gh = new URL(consent.headers.get("location")!);
	expect(gh.origin + gh.pathname).toBe("https://github.com/login/oauth/authorize");

	const cb = keep(await req(`/callback?code=ghcode&state=${gh.searchParams.get("state")}`, { headers: { Cookie: cookie() } }));
	return { cb, consent, client_id, redirect_uri, verifier };
}

describe("GitHub OAuth flow", () => {
	it("the allowed login gets a token that opens /mcp; the consent remembers the client", async () => {
		const { cb, consent, client_id, redirect_uri, verifier } = await oauthDance();
		// Both cookies must survive (the approved-client one was lost to Object.fromEntries(headers)).
		expect(consent.headers.getSetCookie().map((c) => c.split("=")[0]).sort()).toEqual(["__Host-APPROVED_CLIENTS", "__Host-CONSENTED_STATE"]);
		expect(cb.status).toBe(302);
		const back = new URL(cb.headers.get("location")!);
		expect(back.origin + back.pathname).toBe(redirect_uri);
		expect(back.searchParams.get("state")).toBe("claude-state");

		const tok = await req("/token", {
			method: "POST",
			body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code")!, redirect_uri, client_id, code_verifier: verifier, resource: `${ORIGIN}/mcp` }),
		});
		expect(tok.status).toBe(200);
		const { access_token } = (await tok.json()) as { access_token: string };

		const mcp = await req("/mcp", {
			method: "POST",
			headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" } } }),
		});
		expect(mcp.status).toBe(200);
		expect(await mcp.text()).toContain('"serverInfo":{"name":"Video Factory"');

		// Remembered consent: the next /authorize from this client skips the dialog and goes straight to GitHub.
		const q = new URLSearchParams({ response_type: "code", client_id, redirect_uri, code_challenge: "x".repeat(43), code_challenge_method: "S256", state: "s2" });
		const again = await req(`/authorize?${q}`, { headers: { Cookie: cookie() } });
		expect(again.status).toBe(302);
		expect(again.headers.get("location")).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize/);
	});

	it("any other GitHub login is refused before a token is issued", async () => {
		ghLogin = "mallory";
		const { cb } = await oauthDance();
		expect(cb.status).toBe(403);
		expect(await cb.text()).toBe("GitHub user mallory is not allowed");
	});
});
