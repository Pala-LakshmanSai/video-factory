import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
	resolve: { alias: { "cloudflare:workers": fileURLToPath(new URL("./test/cf-workers-stub.ts", import.meta.url)) } },
	test: { include: ["test/**/*.test.ts"] },
});
