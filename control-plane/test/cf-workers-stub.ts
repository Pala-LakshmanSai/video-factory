// Node stand-in for the "cloudflare:workers" module in unit tests.
export const env = { MCP_RESOURCE: "http://localhost/mcp" } as unknown as Env;
export const pending: Promise<unknown>[] = [];
export const waitUntil = (p: Promise<unknown>) => void pending.push(p);
export class WorkerEntrypoint {} // imported (unused here) by @cloudflare/workers-oauth-provider
