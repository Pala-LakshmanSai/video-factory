# Video Factory — setup status and the steps only you can do

**Live control plane:** https://video-factory.lakshmansai121.workers.dev (`URL` below).

## Already done

| Step | Status |
|---|---|
| Repo | Private GitHub repo `Pala-LakshmanSai/video-factory`, CI green (control-plane + renderer tests, image build + smoke, golden refs) |
| Cloudflare | KV `OAUTH_KV`, D1 `video-factory` (schema applied), Worker deployed with crons; `CP_URL`/`MCP_RESOURCE` set |
| Secrets | `COOKIE_ENCRYPTION_KEY`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` set. The other eight hold the placeholder `UNSET` until you replace them below |
| GitHub OAuth App | Registered: https://github.com/settings/applications/4023620 (homepage `URL`, callbacks below); live `/admin/login` reaches GitHub consent |
| Claude Project | **Video Factory** (private): instructions saved; knowledge complete: `explainer.md`, `bold-shorts.md`, `documentary.md`, `scene-plan-contract.md` |
| Renderer image | Builds in CI (6.2 GB), smoke-tested (h264_nvenc + libx264, non-root `--selftest`, offline Kokoro), pushed to private GHCR |

Until the secrets are real, GitHub sign-in to `/mcp` and `/admin` fails and the 5-min reaper logs RunPod 401s. Harmless.

## 1. Drive token + folder (Phase 2)

Google Cloud project: `video-factory-514817` (dedicated; Drive API already enabled). Still to do there: OAuth consent screen **In production**, scope `drive.file`, OAuth client type
**Desktop app**. Save its JSON as `scripts/client_secret.json` (git-ignored), then:
```bash
pip3 install google-auth-oauthlib requests
```
```bash
python3 scripts/google_oauth.py auth
```
```bash
python3 scripts/google_oauth.py smoketest --refresh-token <TOKEN>
```
Done when every step prints PASS and the link opens in a private window. Keep the refresh token and `DRIVE_FOLDER_ID`.

## 2. GitHub OAuth App — done

The app must list both exact callback URLs:

- `https://video-factory.lakshmansai121.workers.dev/callback` (Claude connector sign-in)
- `https://video-factory.lakshmansai121.workers.dev/callback/admin` (`/admin` status page and fault drills)

Its client id and secret are already Worker secrets; skip them in step 3.

## 3. Put the real secrets in (one prompt each)

```bash
cd control-plane && for s in RUNPOD_API_KEY RUNPOD_REGISTRY_AUTH_ID GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GOOGLE_REFRESH_TOKEN DRIVE_FOLDER_ID TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID; do npx wrangler secret put $s; done
```
`RUNPOD_REGISTRY_AUTH_ID`: RunPod → Settings → Container Registry Auth → your Docker Hub `runpod-pull` entry's id.

## 4. Renderer image (Phase 4) — private GHCR

CI now pushes every green `main` build to the private package `ghcr.io/pala-lakshmansai/video-renderer:<sha12>`
(no Docker Hub secrets needed; the summary prints the pinned tag and digest). Still needed:
1. GitHub → Settings → Developer settings → Fine-grained tokens → new token, resource owner `Pala-LakshmanSai`,
   permission **Packages: Read-only** (or a classic token with only `read:packages`).
2. RunPod → Settings → Container Registry Auth → add: registry `ghcr.io`, username `Pala-LakshmanSai`, password =
   that token. Copy the entry's id, then `npx wrangler secret put RUNPOD_REGISTRY_AUTH_ID`.
3. Put the pinned tag in `RENDERER_IMAGE` (`control-plane/wrangler.jsonc`) and deploy, still with `ADMISSION_ENABLED` `"0"`.
4. RunPod console: one pod on a cheap NVENC GPU, image = that tag, registry auth = the ghcr.io entry, start command
   `--selftest`; the log must show `encoder: h264_nvenc`. Terminate it. (Paid: a few cents.)

## 5. Connect Claude (Phase 8)

Claude → Customize → Connectors → Add custom connector: name **Video Factory**, URL `URL/mcp`, sign in with
GitHub (only `ALLOWED_GITHUB_LOGIN` = `Pala-LakshmanSai` gets in). Set every tool to **Always allow**.
The **Video Factory** Project already exists with its instructions and all four knowledge files.
Done when a new chat with title + a 30 s voiceover + a style ends with a Drive link.

## 6. Prove it (Phase 9)

Set `FAULTS_ENABLED` to `"1"` in `wrangler.jsonc`, deploy, sign in at `URL/admin/login`, copy the `vf_admin`
cookie, then per drill:
```bash
CP_URL=https://video-factory.lakshmansai121.workers.dev ADMIN_COOKIE='vf_admin=…' node scripts/drill.ts <job_id> kill_pod
```
Faults: `kill_pod`, `silence_heartbeat`, `slow_boot`, `price_cap:0.01`, `block_region:AP-IN-1`,
`drop_upload_after_chunk:1`, `expire_upload_session`, `corrupt_md5`, `render_error:2`, `revoke_drive`.
`slow_boot`, `price_cap`, `block_region` must be armed before the pod exists: use `*` as job id (applies to the
next job). Set `FAULTS_ENABLED` back to `"0"` afterwards. Status page: `URL/admin/status`.

## Deploying a control-plane change

Order matters: the code needs the new columns.
```bash
cd control-plane && npx wrangler d1 migrations apply video-factory --remote && npx wrangler deploy
```
`ADMISSION_ENABLED` stays `"0"` in `wrangler.jsonc` (no pod is ever rented, no benchmark runs) until a paid test is
explicitly approved; then set it to `"1"` and deploy.

## Local dev (optional)

Copy `control-plane/.dev.vars.example` to `.dev.vars` (sets `DEV_ROUTES=1`), then
`npx wrangler d1 migrations apply video-factory --local && npx wrangler dev`, and
`curl -X POST localhost:8788/dev/acquire -H 'content-type: application/json' -d '{"image":"dummy"}'` rents a
real pod with a public CUDA image (deleted after ~60 s by the watchdog).
