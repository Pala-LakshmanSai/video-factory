// Test harness: D1 over node:sqlite, KV over a Map, and a fetch router for RunPod / Drive.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { vi } from "vitest";

const norm = (a: unknown[]) => a.map((v) => (v === undefined ? null : typeof v === "boolean" ? Number(v) : v)) as never[];

class Stmt {
	constructor(private db: DatabaseSync, private sql: string, private args: unknown[] = []) {}
	bind(...a: unknown[]) { return new Stmt(this.db, this.sql, a); }
	async first<T>() { return (this.db.prepare(this.sql).get(...norm(this.args)) ?? null) as T | null; }
	async all<T>() { return { results: this.db.prepare(this.sql).all(...norm(this.args)) as T[] }; }
	async run() { const r = this.db.prepare(this.sql).run(...norm(this.args)); return { meta: { changes: Number(r.changes) } }; }
}

export function makeDb(): D1Database {
	const db = new DatabaseSync(":memory:");
	db.exec(readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
	return { prepare: (sql: string) => new Stmt(db, sql) } as unknown as D1Database;
}

export function makeEnv(db = makeDb()): Env {
	const kv = new Map<string, string>();
	return {
		DB: db,
		OAUTH_KV: {
			get: async (k: string) => kv.get(k) ?? null,
			put: async (k: string, v: string) => void kv.set(k, v),
			delete: async (k: string) => void kv.delete(k),
		},
		CP_URL: "https://cp.test",
		MCP_RESOURCE: "https://cp.test/mcp",
		RENDERER_IMAGE: "docker.io/me/video-renderer:abc",
		ALLOWED_GITHUB_LOGIN: "me",
		FAULTS_ENABLED: "1",
		DEV_ROUTES: "1",
		RUNPOD_API_KEY: "rp",
		RUNPOD_REGISTRY_AUTH_ID: "reg",
		GOOGLE_CLIENT_ID: "gid",
		GOOGLE_CLIENT_SECRET: "gsec",
		GOOGLE_REFRESH_TOKEN: "grt",
		DRIVE_FOLDER_ID: "folder",
		GITHUB_CLIENT_ID: "x",
		GITHUB_CLIENT_SECRET: "x",
		COOKIE_ENCRYPTION_KEY: "k",
		TELEGRAM_BOT_TOKEN: "",
		TELEGRAM_CHAT_ID: "",
	} as unknown as Env;
}

export type Route = (url: string, init: RequestInit & { body?: string }) => Response | undefined | Promise<Response | undefined>;

/** Replace global fetch with a router; records every call. Unrouted calls fail the test. */
export function mockFetch(...routes: Route[]) {
	const calls: { url: string; method: string; body: unknown }[] = [];
	const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const url = String(input);
		const body = typeof init.body === "string" ? init.body : undefined;
		calls.push({ url, method: init.method ?? "GET", body: body && body.startsWith("{") ? JSON.parse(body) : body });
		for (const r of routes) {
			const res = await r(url, init as never);
			if (res) return res;
		}
		throw new Error(`unrouted fetch ${init.method ?? "GET"} ${url}`);
	});
	vi.stubGlobal("fetch", fn);
	return calls;
}

export const json = (o: unknown, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", ...headers } });

type Avail = "NONE" | "LOW" | "MEDIUM" | "HIGH";
export function catalogOf(dcs: Record<string, Record<string, Avail>>) {
	return {
		dataCenters: Object.entries(dcs).map(([id, gpus]) => ({
			id, name: id, region: "X",
			gpuAvailability: Object.entries(gpus).map(([g, availability]) => ({ id: g, name: g, availability })),
		})),
	};
}

export const RTX4090 = "NVIDIA GeForce RTX 4090";
export const L40S = "NVIDIA L40S";
