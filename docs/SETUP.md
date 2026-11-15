# Video Factory — what's built, and the steps only you can do

All code for Phases 1–9 is in this repo and tested offline (fake RunPod / Drive). Everything below needs
your accounts, a browser click, a secret, or real money, so it is yours. Do the steps in order; each ends
with the guide's **Done when** check.

Values to have ready (Phase 0): RunPod API key, RunPod registry-auth id, Docker Hub username + `gha-push`
token, Google OAuth Desktop client (`client_secret.json`), Telegram bot token + chat id.

## 1. Push the repo to GitHub

```bash
gh repo create video-factory --private --source . --push
```

## 2. Drive token + folder (Phase 2)

```bash
pip3 install google-auth-oauthlib requests
```
Put the Desktop client file at `scripts/client_secret.json` (git-ignored), then:
```bash
python3 scripts/google_oauth.py auth
```
```bash
python3 scripts/google_oauth.py smoketest --refresh-token <TOKEN>
```
Done when every step prints PASS and the link opens in a private window. Keep `GOOGLE_REFRESH_TOKEN`
and `DRIVE_FOLDER_ID`.

## 3. Cloudflare Worker + D1 (Phase 3)

```bash
cd control-plane && npx wrangler kv namespace create OAUTH_KV
```
```bash
npx wrangler d1 create video-factory
```
Paste both ids into `control-plane/wrangler.jsonc`, then:
```bash
npx wrangler d1 migrations apply video-factory --remote
```
```bash
npx wrangler deploy
```
Note the URL `https://video-factory.<subdomain>.workers.dev`; set `CP_URL` and `MCP_RESOURCE` (`…/mcp`)
in `wrangler.jsonc`. On GitHub → Settings → Developer settings → OAuth Apps → New: homepage = that URL,
callback = `<URL>/callback`. Then set every secret (one command each; paste the value when asked):
```bash
for s in GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET COOKIE_ENCRYPTION_KEY RUNPOD_API_KEY RUNPOD_REGISTRY_AUTH_ID GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GOOGLE_REFRESH_TOKEN DRIVE_FOLDER_ID TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID; do npx wrangler secret put $s; done
```
(`COOKIE_ENCRYPTION_KEY`: `openssl rand -hex 32`.) Redeploy: `npx wrangler deploy`.

Local dummy-pod test: copy `.dev.vars.example` to `.dev.vars`, fill it, then
```bash
npx wrangler d1 migrations apply video-factory --local && npx wrangler dev
```
```bash
curl -X POST localhost:8788/dev/acquire -H 'content-type: application/json' -d '{"image":"dummy"}'
```
Done when it rents a real pod in the expected region and the pod is gone ~60–120 s later (the
per-minute watchdog deletes it; `wrangler dev` runs crons only if you hit `/__scheduled?cron=*+*+*+*+*`).

## 4. Renderer image (Phase 4)

GitHub repo → Settings → Secrets → Actions: `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN` (gha-push). Push to
main; the `renderer` workflow tests, builds and pushes `docker.io/<user>/video-renderer:<sha>` and prints it
in the job summary. Put it in `RENDERER_IMAGE` (wrangler.jsonc) and redeploy. In the RunPod console, start
one pod on a cheap NVENC GPU with start command `--selftest`; the log must show `h264_nvenc`. Then
`POST /dev/acquire {"image":"renderer"}` and watch it hello + heartbeat; kill the agent and the watchdog
replaces it ~60 s later.

## 5. Connect Claude (Phase 8)

Claude → Customize → Connectors → Add custom connector: name **Video Factory**, URL `<URL>/mcp`, sign in
with GitHub (only `ALLOWED_GITHUB_LOGIN` gets in). Set every tool to **Always allow**. Create the Project
from `docs/PROJECT_INSTRUCTIONS.md`.

## 6. Prove it (Phase 9)

Set `FAULTS_ENABLED` to `"1"`, deploy, sign in at `<URL>/admin/login`, copy the `vf_admin` cookie, then per drill:
```bash
CP_URL=<URL> ADMIN_COOKIE='vf_admin=…' node scripts/drill.ts <job_id> kill_pod
```
Faults: `kill_pod`, `silence_heartbeat`, `slow_boot`, `price_cap:0.01`, `block_region:AP-IN-1`,
`drop_upload_after_chunk:1`, `expire_upload_session`, `corrupt_md5`, `render_error:2`, `revoke_drive`.
Faults that must be in place before the pod exists (`slow_boot`, `price_cap`, `block_region`) take
`*` as job id: they apply to the next job. Set `FAULTS_ENABLED` back to `"0"` afterwards.

## Status page

`<URL>/admin/status` (GitHub sign-in): live jobs, pods, today's spend.
