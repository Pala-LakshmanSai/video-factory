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
| Renderer image | Builds in CI (6.2 GB): ffmpeg has h264_nvenc + libx264, `--selftest` works as non-root, Kokoro TTS works offline |

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

## 4. Renderer image to Docker Hub (Phase 4)

GitHub repo → Settings → Secrets and variables → Actions: `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN` (`gha-push`).
Re-run the latest `renderer` workflow (or push). Its summary prints `docker.io/<user>/video-renderer:<sha>`:
put that in `RENDERER_IMAGE` in `control-plane/wrangler.jsonc`, then `npx wrangler deploy`.
In the RunPod console, start one pod on a cheap NVENC GPU with start command `--selftest`; its log must show
`encoder: h264_nvenc`. Terminate it. (Done 2026-11-16 on an A40: see Phase 9 below.)

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
`POST /admin/dev/acquire` (signed in at `/admin/login`; `curl -X POST localhost:8788/admin/dev/acquire -H 'content-type: application/json' -d '{"image":"dummy"}'` rents a
real pod with a public CUDA image (deleted after ~60 s by the watchdog).

## Production qualification — passed (2026-11-16)

One owner-approved render through the Claude Video Factory Project, $0.50 budget, single submitter, no replay.

| Item | Result |
|---|---|
| Job | `j_60e660d0ac1947b0` → `done` automatically at 19:48:31 UTC (no manual step; done-before-delete fix live) |
| Pod | `wmtqzvibe7gmy6`, NVIDIA A40, EU-SE-1, $0.59/hr; created 19:44:36, deleted 19:48:32 UTC (RunPod Audit Log; Pods view empty) |
| Output | Drive `1m5N2XlwaAZyS5ldPfpqsHvI8zbiQjSdg`: 4,424,566 bytes, md5 `31edd7f98ab77613c53648b64ca5b83f` (= Worker receipt), 1920×1080 30 fps H.264 + AAC mono, 25.7 s |
| Cost | $0.0385 (235 GPU-seconds) |
| Admission | Opened 19:43:41, closed 19:45:11 UTC after the pod was accepted; faults and dev routes off throughout |

Visual follow-up, resolved: the one-frame black flash at each `fade` scene join (incoming fade started at full black) was fixed in 675f7d7 (fade/slide use the style background); that fix is in every pinned image since, and later drill downloads showed zero black joins.

## Phase 9 fault drills — exact upload proof passed (2026-11-16)

Single operator, owner-approved, $3 cap; spent **$0.4937** tracked (incl. B8). Every drill pod has a RunPod Audit Log deletion
receipt (independent check). After the last run: `ADMISSION_ENABLED`/`FAULTS_ENABLED`/`DEV_ROUTES` all `"0"`,
zero open jobs, zero live pods, zero armed faults. Renderer pin at B7: `sha256:2913b893…926b` (a9e41fa); then `sha256:1ad06161…79be` (912a8c0, NVENC fallback diagnostics); now `sha256:65af4b0b…66af` (05d866c).

**Exact injection (named fault fired and the observed event matches):**

| Fault | Job | Observed |
|---|---|---|
| `block_region:AP-IN-1` | `j_ed566cf306fb41e0` | region skipped (caveat: AP-IN-1 may have had no capacity anyway) |
| `price_cap:0.01` | `j_8e5a089cc3994c8d` | 6 offers rejected → `failed_no_capacity` |
| `kill_pod`, `corrupt_md5` | `j_3a652cdb53b24183` (B2) | pod replaced; md5 mismatch caught by verify |
| `expire_upload_session` | `j_afa7f33820024043` (B3) | 2 upload sessions, restart from 0 |
| `revoke_drive` | `j_8ad5a784467044f3` (B4) | `drive_auth` failure + Telegram alert |
| `slow_boot` | `j_bea7ab5845f74a9f` (B1) | boot_timeout → replacement pod |
| `render_error` + scene repair | `j_bea7ab5845f74a9f` (B1) | final-render scene error, `revise_scene` repair, done (RTX 3090) |
| `silence_heartbeat` | `j_62299e36d97d4564` (B6) | healthy L40S lost heartbeat → deleted `heartbeat_lost`; replacement RTX 4090 accepted + heartbeating |
| `drop_upload_after_chunk:1` | `j_0c4d12aba6cb4efc` (B7) | Drive 308, `upload_resumed` offset 1048576; size 2,366,936 + md5 `80a023ab…` verified; auto `done`; pod deleted `done` |

**Equivalent coverage only:** chat closed mid-job (B3: server-side turn kept running), orphan reap (an untracked
`vf-` pod, not a hand-made `vf-test`), CPU x264 finish (B2 replacement was CPU, not caused by `price_cap`).
**Unplanned extra:** crash mid-create → held, no replay (`j_bb15243dd4b24261` → `failed_no_capacity`).

**Not qualified / open risks:**
- **NVENC on RunPod GPUs.** B6 used `h264_nvenc` and failed with "could not open encoder" (-22) at segment 29
  (likely the GeForce concurrent NVENC session limit with many parallel segment encoders; not proven by
  provider driver diagnostics); a9e41fa caps NVENC workers at 4. B7 ran on an RTX 4090 but the H.264 SEI
  says x264: the 1-frame NVENC probe fell back, so the cap is **not** qualified. B7's fallback cause is unknown
  (that image did not log the probe stderr); 912a8c0 onward logs the probe stderr, driver version and
  `libnvidia-encode` presence on fallback, so the next fallback will show why.
- **Standalone NVENC selftest — passed (2026-11-16).** One owner-approved pod (`$0.15` cap), `8fi8a6k8akisv3`,
  NVIDIA A40, EU-SE-1 Secure Cloud, image `sha256:1ad06161…79be`, command `--selftest`. Log:
  `encoder: h264_nvenc`, `encoded 150 frames of 1080p with h264_nvenc in 1.07 s = 139.9 fps`; driver 595.91.07,
  CUDA 13.2. RunPod Audit Log: created 03:37:53, stopped 03:39:39, deleted 03:39:49 UTC (116 s; ≈ $0.02 at
  quoted $0.59/hr + disk, no settled invoice checked). Scope: standalone NVENC on one A40 only. It does not
  qualify GeForce concurrency or the 4-worker cap under a full render, and B7 remains an x264 render.
- **B8 qualification (2026-11-16), image `sha256:65af4b0b…66af` (05d866c).** Job `j_0323c69825c8424b`, RTX 4090
  pod `cx4380hwfgdt6i` (EU-RO-1): preview, chat `approve`, final, upload 2,407,708 bytes + md5 `4910981b…` verified,
  auto `done` 04:13:50 UTC, pod deleted `done`, $0.0278. Encoder: **libx264 fallback**; the new diagnostics logged
  `nvenc probe failed (187)` with `OpenEncodeSessionEx failed: unsupported device (2)` / `No capable devices found`
  before any parallel encode. So this host's GeForce exposes no usable NVENC session to the container, while the
  A40 selftest passed. **GeForce 4-worker NVENC remains unqualified.**
- **Heartbeat gap — fixed and qualified on B8.** B7's pod sent no heartbeat for 79 s (threshold 60 s); it survived
  only because of watchdog tick timing. 05d866c runs Kokoro TTS in a child process (local event-loop lag 2 ms) and
  logs late heartbeat ticks with the stage; on B8, D1 received heartbeats about every 15 s through TTS and preview.
- **Fault slot — fixed (5986f92).** `armFault` claims `pending_cmd` only when empty and returns 409 otherwise,
  before storing fault config or logging `fault_armed`; regression test covers a queued `render_final`.
- **Cold boot — mitigated.** `BOOT_TIMEOUT_S` raised from 6 to 10 min for 6.2 GB cold pulls (2026-11-16).
- **GeForce NVENC — accepted fallback.** RunPod GeForce hosts may refuse NVENC ("unsupported device"); the renderer
  falls back to libx264 and still completes (B8). A40-class GPUs encode with NVENC. Revisit only if render speed matters.

**Production status (2026-11-16):** `ADMISSION_ENABLED="1"` committed in `wrangler.jsonc`; faults and dev routes stay
`"0"`. Admission also lets the Sunday 03:00 UTC benchmark run (capped at $2 per run).

