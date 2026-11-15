# Video Factory control plane

Cloudflare Worker (SPEC §2): MCP tools for Claude (`/mcp`, GitHub OAuth locked to `ALLOWED_GITHUB_LOGIN`),
agent API for pods (`/agent/{job}/*`, per-pod Bearer token), admin (`/admin/status`, `/admin/fault`),
crons: watchdog (1 min), reaper + bench finish (5 min), GPU benchmark (Sunday 03:00 UTC).

| File | What |
|---|---|
| `src/mcp.ts` | §4 tools: acquire_gpu, submit_job, wait_job, approve, revise_scene, release |
| `src/agent.ts` | §5 agent API: hello, spec, heartbeat, previews, upload-session, done, error, input/voiceover, bench |
| `src/selector.ts`, `src/runpod.ts` | §6/§8/§9 GPU selector and RunPod client (v1, v2 fallback) |
| `src/drive.ts` | §7 Drive broker |
| `src/state.ts` | §10 state machine |
| `src/watchdog.ts`, `src/reaper.ts`, `src/bench.ts` | crons |
| `src/faults.ts`, `src/admin.ts` | Phase 9 fault injection, status page, dev route |
| `migrations/0001_init.sql` | D1 schema |

```bash
npm ci --legacy-peer-deps
npx tsc --noEmit && npx vitest run          # unit + protocol tests
E2E=1 npx vitest run test/e2e*.test.ts      # real pod agent + Chromium (needs ffmpeg, Playwright Chromium)
```

Deploy and secrets: `../docs/SETUP.md`. Before deploying set `CP_URL` and `MCP_RESOURCE` (`<URL>/mcp`) in
`wrangler.jsonc`; OAuth tokens are bound to `MCP_RESOURCE`.
