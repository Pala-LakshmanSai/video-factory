# Video Factory · Render Architecture v2

Text export of the whiteboard https://claude.ai/artifact/CnSarvBmWsxwMCFWSiznFT (exported 2026-11-15).

> One chat, one GPU, one Drive link, zero prompts.

## ① Claude · your Project

- New chat — title + voiceover + style
- Plan scenes & story — while the GPU boots (parallel)
- Self-QA preview frames — Claude checks and fixes, no prompts
- Drive link in chat — GPU already terminated

## ② Control plane · Cloudflare Worker (MCP)

- GPU selector — live catalog → region tier → GPU rank
- Job store (D1) + secrets — plan · state · keys never in chat
- Status + Drive broker — heartbeat · previews · upload session
- Terminator + reaper — on done · boot timeout · orphans

## ③ RunPod pod · one per chat

- Pod boots — Docker Hub image · no installs
- Render agent — Chromium frames + ffmpeg NVENC
- Upload to Google Drive — resumable · md5 verified
- Terminate pod — volume 0 GB · 30-min self-destruct
- Google Drive — /Video Factory/ folder

### Overview arrows

- New chat — title + voiceover + style → GPU selector — live catalog → region tier → GPU rank: `acquire_gpu()`
- GPU selector — live catalog → region tier → GPU rank → Pod boots — Docker Hub image · no installs: `POST /v1/pods`
- Plan scenes & story — while the GPU boots (parallel) → Job store (D1) + secrets — plan · state · keys never in chat: `submit_job()`
- Job store (D1) + secrets — plan · state · keys never in chat → Render agent — Chromium frames + ffmpeg NVENC: `GET /agent/spec`
- Upload to Google Drive — resumable · md5 verified → Status + Drive broker — heartbeat · previews · upload session: `upload-session · done`
- Status + Drive broker — heartbeat · previews · upload session → Self-QA preview frames — Claude checks and fixes, no prompts: `wait_job()`
- Terminator + reaper — on done · boot timeout · orphans → Terminate pod — volume 0 GB · 30-min self-destruct: `DELETE /v1/pods/{id}`
- Upload to Google Drive — resumable · md5 verified → Google Drive — /Video Factory/ folder: `PUT session_uri`

## ④ Request / response sequence · time runs down

Lanes: Claude chat · Control plane (Worker) · RunPod API · Pod agent · Google Drive API. First line = request, second = response.


### A · Acquire
- tools/call · `acquire_gpu {style, title, voiceover}`
- {job_id, state: "provisioning"} · one pod per chat
- `GET https://api.runpod.io/v2/catalog/datacenters` / `?include=GPU_AVAILABILITY`
- {dataCenters[{id, gpuAvailability[…]}]} · cache 60 s
- `POST https://rest.runpod.io/v1/pods` / imageName · containerRegistryAuthId (Docker Hub) / gpuTypeIds[ranked] · dataCenterIds[tier] · "custom" / minVCPUPerGPU:8 · volumeInGb:0 · env{JOB_ID,TOKEN}
- 201 {id, costPerHr, machine} · error → next tier
- pull image from Docker Hub · start container
- agent starts · nothing to install
- `POST /agent/{job}/hello` · Bearer JOB_TOKEN · {gpu, vcpu}
- 200 {state: "waiting_for_plan"} · no hello in 6 min → DELETE pod, next tier

### B · Render
- tools/call · `submit_job {job_id, scene_plan}`
- {state: "rendering", gpu: "RTX 4090 · AP-IN-1"}
- `GET /agent/{job}/spec` (long-poll)
- 200 {style, scenes[], voiceover: text or Drive file id}
- `POST /agent/{job}/heartbeat` {stage, pct} · every 15 s
- 200 {cmd: continue | render_final | rerender:n | cancel}
- `POST /agent/{job}/previews` · key frames (JPEG)
- 201 · kept with the job
- tools/call · `wait_job {job_id, until: preview}`
- {state: "preview_ready", previews: [images]} · ≤ 50 s
- Claude checks frames itself, then tools/call · / `approve {job_id}` or `revise_scene {scene, patch}`
- {state: "final_render"} · sent to pod via heartbeat

### C · Upload
- `POST /agent/{job}/upload-session` {name, size, md5}
- 200 {session_uri} · the pod never holds Google keys
- `POST https://oauth2.googleapis.com/token` · grant_type=refresh_token
- 200 {access_token, expires_in: 3599}
- `POST https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable` / Bearer access_token · {name, parents: [folder_id]} · X-Upload-Content-Length
- 200 · Location: session_uri (valid 1 week)
- `PUT {session_uri}` · 32 MB chunks / Content-Range: bytes a-b/size
- 308 Range: 0-b … last chunk → 200 {id} / drop → PUT bytes */size → resume at b+1
- `POST /agent/{job}/done` {file_id, md5}
- 200 · control plane verifies, then terminates the pod
- `GET https://www.googleapis.com/drive/v3/files/{id}?fields=size,md5Checksum,webViewLink`
- 200 {md5Checksum = agent md5 ✓, webViewLink} · mismatch → re-upload
- `POST https://www.googleapis.com/drive/v3/files/{id}/permissions` {role: reader, type: anyone}
- 200 · link opens for anyone you send it to

### D · Shutdown
- `DELETE https://rest.runpod.io/v1/pods/{pod_id}`
- 200 · GPU billing stops
- backup at 30-min TTL (if no DELETE came): / `DELETE /v1/pods/$RUNPOD_POD_ID`
- pod-scoped $RUNPOD_API_KEY · fallback `POST …/stop`
- tools/call · `wait_job {job_id, until: done}`
- {state: "done", drive_link, gpu_minutes, cost_usd}
- reaper, every 5 min: `GET https://rest.runpod.io/v1/pods`
- [{id, name: "vf-…"}] → DELETE orphans / past TTL

## ⑤ Fallback order (top row tried first)

| # | Compute tier · outer |
|---|---|
| 1 | GPU pod · Secure |
| 2 | GPU pod · Community |
| 3 | CPU pod (x264, slower) |
| ↳ | live catalog read first |

| # | Region · nearest first |
|---|---|
| 1 | AP-IN-1 · India |
| 2 | EU-RO-1 · Romania |
| 3 | EU-CZ/SE/NL/FR/NO · IS |
| 4 | AP-JP-1 · Japan |
| 5 | OC-AU-1 · Australia |
| 6 | US-* · CA-* |
| ↳ | tiers inside each region |

| # | GPU · NVENC · ≤ $2/hr | Why |
|---|---|---|
| 1 | RTX 4090 | fast · cheap |
| 2 | RTX 5090 | fastest consumer |
| 3 | RTX PRO 4500 Blackwell | new · cheap · 32 GB |
| 4 | L40S | 16 vCPU · big pool |
| 5 | RTX 6000 Ada | 10 vCPU |
| 6 | L40 | L40S sibling |
| 7 | L4 | cheap · AV1 |
| 8 | RTX 4000 Ada | very cheap |
| 9 | RTX A4500 | very cheap · 12 vCPU |
| 10 | RTX A5000 | very cheap |
| 11 | RTX 3090 / 3090 Ti | cheap backup |
| 12 | A40 / RTX A6000 | 48 GB backup |
| 13 | RTX 5000 Ada · 4080 · 5080 | backup |
| 14 | RTX 2000 Ada · A4000 | last resort |
| ✕ | A100 · H100 · H200 · B200 | no NVENC · skip |
| ↳ | re-rank weekly | by $ per test video |

| Google Drive | Limit / setting |
|---|---|
| Auth | OAuth refresh token (you) |
| Scope | drive.file only |
| Upload cap | 750 GB per 24 h |
| File size cap | 5 TB |
| Session URI | resumable · valid 1 week |
| Service account | ✕ no storage quota |

## ⑥ Failure → automatic recovery (no prompts)

| Failure | Automatic recovery |
|---|---|
| Nearest region has no GPU | next region tier, nearest first (Secure → Community) |
| No GPU ≤ $2/hr anywhere | RunPod CPU pod renders with x264 (slower, still finishes) |
| Pod created above $2/hr | DELETE at once, try next option |
| Pod stuck booting > 6 min | DELETE, skip that data center, retry |
| Pod dies mid-render | heartbeat silent 60 s → new pod, same job spec, re-render |
| Docker Hub pull limit / outage | authenticated pulls · backoff, retry in next data center |
| RunPod API 429 / 5xx | exponential backoff with jitter, 3 tries per tier |
| Render error in a scene | log → Claude auto-fixes → resubmit (max 3) |
| Self-QA keeps failing | ship after 2 rounds, list issues in the final message |
| Drive upload drops | resume same session (PUT bytes */size) |
| Drive session 4xx / expired | open a new session, upload again |
| md5 mismatch | re-upload before the pod is terminated |
| Chat or tab closed | job keeps running · wait_job from any chat |
| Orphan / forgotten pod | 30-min self-destruct + 5-min reaper |
| RunPod balance low | auto-pay + alert (pods are deleted at $0) |
| Tool permission prompt | connector tools set to Always allow |
| Drive token revoked | alert · re-authorise once (OAuth app published) |

## ⑦ One-time setup

- Claude Project — runbook: never ask mid-job
- Renderer image — GitHub → Docker Hub
- MCP connector — Cloudflare Worker + D1
- Keys & alerts — RunPod auto-pay · Drive OAuth
- Connector tools — set to Always allow
