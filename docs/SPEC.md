# Video Factory — Render System Specification (v2)

> Verbatim transcription of `docs/Video_Factory_System_Spec.pdf` (7 pages). The PDF is the source of truth; this file exists so prompts and code can cite it as text. Only formatting (Markdown headings, tables, code fences) was added.

**Purpose of this document:** a complete, machine-readable specification of a system that turns one chat message (title + voiceover + style) into a finished video stored in Google Drive, rendered on a fresh RunPod GPU per video, with zero human prompts during the run. It is written to be pasted into an LLM (ChatGPT, Claude) to generate the architecture, the prompts and the full code.

**Instructions for the LLM reading this:** treat sections 4–9 as hard contracts (names, endpoints, fields, timeouts). Where something is marked [DECIDE], choose a sensible default and state it. Do not add services that are not listed here (no other GPU providers, no other storage hosts).

## 1. Goal and hard requirements

- Throughput target: up to 50 videos per hour.
- Input per video: title, voiceover (text, or a Google Drive file id), style (name from the style library).
- Output per video: one Google Drive link (anyone-with-link, reader), posted in the chat.
- One chat = one job = one brand-new RunPod pod. Pods are never shared between jobs.
- Zero compute on the user's computer. Claude runs in Anthropic's cloud; rendering runs on RunPod only.
- GPU boot must overlap with Claude's scene planning (acquire the GPU at t = 0).
- No questions or approvals during a run. Claude decides with defaults and reports issues only at the end.
- Price cap: never keep a pod costing more than $2.00/hr.
- Provider: RunPod only. Storage: Google Drive only (user's paid account).
- Pod is terminated (deleted, not stopped) after the upload is verified.

## 2. Components

| Component | Runs on | Responsibility |
|---|---|---|
| Claude chat (Project 'Video Factory') | Anthropic cloud | Reads style library + runbook, plans scenes, writes scene plan, self-QA of preview frames, calls MCP tools. |
| Control plane (custom MCP connector) | Cloudflare Worker + D1 (SQLite) + Cron trigger | MCP server for Claude; GPU selector; job store; agent API for pods; Google Drive broker; terminator + reaper. Holds all secrets. |
| RunPod API | rest.runpod.io/v1, api.runpod.io/v2 | Live catalog, create / get / list / delete pods. |
| Pod agent | Inside each RunPod pod (Docker image from Docker Hub) | Fetches job spec, renders (Chromium frames + ffmpeg NVENC, x264 on CPU pods), sends heartbeats + previews, uploads to Drive, self-destructs at TTL. |
| Renderer image | Docker Hub private repo (built by GitHub Actions) | All styles, fonts, Chromium, ffmpeg, agent. Nothing installed at boot. |
| Google Drive | User's Google account | Final storage. Resumable upload via session URI. |

## 3. End-to-end flow (happy path)

1. User opens a new chat in the Project and sends title + voiceover + style.
2. Claude immediately calls acquire_gpu. Control plane creates a job (state=provisioning) and starts the GPU selector asynchronously; returns job_id in under 1 s.
3. GPU selector reads the live RunPod catalog, then creates a pod (one call per region tier until one succeeds). Pod pulls the image and starts the agent.
4. Meanwhile Claude plans scenes and writes the scene plan (parallel with step 3).
5. Agent calls /hello; Claude calls submit_job with the scene plan; agent long-polls /spec and starts rendering.
6. Agent renders key preview frames and posts them; Claude calls wait_job(until=preview), inspects frames itself, then calls approve or revise_scene (max 2 rounds).
7. Agent renders the final video, asks control plane for a Drive upload session, uploads in 32 MB chunks to the session URI.
8. Agent calls /done. Control plane verifies size + md5 in Drive, sets sharing to anyone-with-link, then DELETEs the pod.
9. Claude calls wait_job(until=done) and posts the Drive link (plus GPU minutes and cost).

## 4. Contract A — MCP tools (Claude → control plane)

Transport: MCP Streamable HTTP at `https://<worker>/mcp`, JSON-RPC method `tools/call`. All tools set to 'Always allow' in Claude's connector settings so no permission prompts appear.

```
acquire_gpu   in : {style, title, voiceover: {text?|drive_file_id?}, chat_key}
              out: {job_id, state:"provisioning"}
              # idempotent on chat_key: same chat -> same job
submit_job    in : {job_id, scene_plan}
              out: {state:"rendering", gpu:"RTX 4090 · AP-IN-1"}
wait_job      in : {job_id, until:"preview"|"done", timeout_s<=50}
              out: {state, pct, previews:[image...], drive_link?, gpu_minutes?, cost_usd?, error?}
              # long-poll; Claude repeats until state matches. Returns images as MCP image content.
approve       in : {job_id}                    out: {state:"final_render"}
revise_scene  in : {job_id, scene, patch}      out: {state:"rerendering", scene}
release       in : {job_id}                    out: {state:"cancelled"}   # manual abort only
```

## 5. Contract B — Agent API (pod → control plane)

Base `https://<worker>/agent/{job_id}`. Auth: `Authorization: Bearer JOB_TOKEN` (random per job, passed to the pod as env; valid only for that job; expires at TTL).

```
POST /hello            {gpu, vcpu, ram_gb, pod_id, data_center}
                       -> 200 {state:"waiting_for_plan"}
GET  /spec             long-poll <= 50 s
                       -> 200 {style, scenes[], voiceover} | 204 (retry)
POST /heartbeat        {stage, pct, scene?} every 15 s
                       -> 200 {cmd: continue | render_final | rerender:n | cancel}
POST /previews         multipart JPEG key frames -> 201
POST /upload-session   {name, size, md5} -> 200 {session_uri}
POST /done             {file_id, md5, size} -> 200
POST /error            {stage, scene?, log_tail} -> 200 {cmd: retry | cancel}
GET  /input/voiceover  only if voiceover is a Drive file (streamed by control plane)
                       -> 200 audio bytes
```

## 6. Contract C — RunPod API calls (control plane / pod → RunPod)

```
# 1. Live catalog (cache 60 s)
GET https://api.runpod.io/v2/catalog/datacenters?include=GPU_AVAILABILITY
-> {dataCenters:[{id, name, region,
     gpuAvailability:[{id, name, availability: NONE|LOW|MEDIUM|HIGH}]}]}

# 2. Create pod (one call per region tier, per cloud type)
POST https://rest.runpod.io/v1/pods
{
  "name": "vf-{job_id}",
  "imageName": "docker.io/<user>/video-renderer:<pinned-tag>",
  "containerRegistryAuthId": "<docker hub credential id>",
  "computeType": "GPU",
  "cloudType": "SECURE" | "COMMUNITY",
  "gpuTypeIds": [ranked list, filtered by live availability],
  "gpuTypePriority": "custom",
  "dataCenterIds": [ids of this region tier],
  "dataCenterPriority": "custom",
  "gpuCount": 1,
  "minVCPUPerGPU": 8,
  "containerDiskInGb": 30,
  "volumeInGb": 0,                  # stopped pod then costs nothing
  "env": {"JOB_ID": "...", "JOB_TOKEN": "...", "CP_URL": "https://<worker>", "TTL_MIN": "30"}
}
-> 201 {id, costPerHr, machine:{gpuTypeId, dataCenterId, cpuCount}}   if costPerHr > 2.00 -> DELETE immediately, continue.
 | 4xx/5xx -> next tier

# 2b. CPU fallback (no GPU anywhere): same body with
"computeType":"CPU", "cpuFlavorIds":["cpu5c","cpu3c"],
"cpuFlavorPriority":"custom", "vcpuCount": 16

# 3. Terminate (control plane, after verified upload or on failure)
DELETE https://rest.runpod.io/v1/pods/{pod_id} -> 200

# 4. Self-destruct backup (inside pod, at TTL)
DELETE https://rest.runpod.io/v1/pods/$RUNPOD_POD_ID
Authorization: Bearer $RUNPOD_API_KEY   (pod-scoped, injected by RunPod)
fallback: POST https://rest.runpod.io/v1/pods/$RUNPOD_POD_ID/stop

# 5. Reaper (Cron trigger every 5 min)
GET https://rest.runpod.io/v1/pods
-> DELETE every pod named "vf-*" whose job is done/failed or older than TTL
```

## 7. Contract D — Google Drive calls

```
# Control plane only (holds the refresh token)
POST https://oauth2.googleapis.com/token
grant_type=refresh_token&refresh_token=...&client_id=...&client_secret=...
-> {access_token, expires_in: 3599}

POST https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable
Authorization: Bearer <access_token>
X-Upload-Content-Length: <size>   X-Upload-Content-Type: video/mp4
{"name": "<title>.mp4", "parents": ["<Video Factory folder id>"]}
-> 200, header Location: <session_uri>   # valid 1 week, needs no auth header

# Pod (only receives session_uri — never Google credentials)
PUT <session_uri>  Content-Range: bytes a-b/size   (32 MB chunks, multiple of 256 KiB)
-> 308 Range: bytes=0-b ... last chunk -> 200/201 {id}
on drop:   PUT <session_uri> Content-Range: bytes */size -> 308 Range -> resume at b+1
on 404/4xx: session dead -> ask /upload-session again, restart from byte 0

# Control plane verification + sharing
GET https://www.googleapis.com/drive/v3/files/{id}?fields=size,md5Checksum,webViewLink
-> must match agent md5 + size, else re-upload before terminating pod
POST https://www.googleapis.com/drive/v3/files/{id}/permissions {"role":"reader","type":"anyone"}
```

## 8. GPU selector algorithm

```
catalog = cached GET /v2/catalog/datacenters?include=GPU_AVAILABILITY
for compute_tier in ["GPU/SECURE", "GPU/COMMUNITY", "CPU"]:
  for region_tier in REGION_TIERS:                 # nearest first (section 9)
    dcs  = [dc in region_tier if dc in catalog]
    gpus = [g for g in GPU_RANK if any(avail(dc,g) != NONE for dc in dcs)]   # GPU tiers only
    if empty: continue
    resp = POST /v1/pods(dataCenterIds=dcs, gpuTypeIds=gpus, cloudType=..., priorities="custom")
           with retry: 429/5xx -> backoff 1s,2s,4s (+jitter), max 3
    if resp.ok:
      if resp.costPerHr > 2.00: DELETE pod; continue
      record pod; start boot timer (6 min until /hello); return
mark job failed_no_capacity; tell Claude (only case where the user is informed mid-run)
```

## 9. Fallback order (top tried first)

### 9.1 Compute tier (outermost)

| # | Tier | Note |
|---|---|---|
| 1 | GPU pod, Secure Cloud | default |
| 2 | GPU pod, Community Cloud | cheaper, less stable |
| 3 | CPU pod, x264 encoding | slower, but the video still finishes |

### 9.2 Region tier (nearest to user in India first)

| # | Region tier | Data center ids |
|---|---|---|
| 1 | India | AP-IN-1 |
| 2 | Romania | EU-RO-1 |
| 3 | Rest of Europe | EU-CZ-1, EU-SE-1, EU-NL-1, EU-FR-1, EUR-NO-1, EUR-IS-1/2/3 |
| 4 | Japan | AP-JP-1 |
| 5 | Australia | OC-AU-1 |
| 6 | North America | US-* , CA-MTL-* |

Data center ids change; always intersect with the live catalog. The v1 create-pod enum may lag new data centers (e.g. AP-IN-1).

### 9.3 GPU rank (inner). Must have NVENC, must be ≤ $2/hr

| # | GPU (exact gpuTypeId) | Why |
|---|---|---|
| 1 | NVIDIA GeForce RTX 4090 | fast, cheap |
| 2 | NVIDIA GeForce RTX 5090 | fastest consumer card |
| 3 | NVIDIA RTX PRO 4500 Blackwell | new, cheap, 32 GB |
| 4 | NVIDIA L40S | 16 vCPU, large pool |
| 5 | NVIDIA RTX 6000 Ada Generation | 10 vCPU |
| 6 | NVIDIA L40 | L40S sibling |
| 7 | NVIDIA L4 | cheap, AV1 encoder |
| 8 | NVIDIA RTX 4000 Ada Generation | very cheap |
| 9 | NVIDIA RTX A4500 | very cheap, 12 vCPU |
| 10 | NVIDIA RTX A5000 | very cheap |
| 11 | NVIDIA GeForce RTX 3090 / RTX 3090 Ti | cheap backup |
| 12 | NVIDIA A40 / NVIDIA RTX A6000 | 48 GB backup |
| 13 | NVIDIA RTX 5000 Ada Generation / GeForce RTX 4080 (SUPER) / RTX 5080 | backup |
| 14 | NVIDIA RTX 2000 Ada Generation / NVIDIA RTX A4000 | last resort |
| x | A100, H100, H200, B200, B300, A30, AMD MI300X | excluded: no NVENC, AMD, or over cap |

Re-rank weekly by measured $ per standard test video (render the same 60 s test video on each GPU type). Rendering is partly CPU-bound (Chromium frame drawing), so vCPU count matters as much as the GPU model.

## 10. Job state machine

```
provisioning -> booting -> waiting_for_plan -> rendering -> preview_ready
  -> final_render -> uploading -> verifying -> done
any state -> retrying (pod replaced) -> back to booting
any state -> failed (no capacity / 3 render errors / budget) -> pod deleted, Claude reports
```

## 11. Timeouts and constants

| Constant | Value |
|---|---|
| Boot timeout (create -> /hello) | 6 min -> DELETE pod, skip that data center, next option |
| Heartbeat interval / dead after | 15 s / 60 s silent -> replace pod, same job spec |
| Pod TTL (self-destruct) | 30 min (raise for long videos) [DECIDE per video length] |
| Reaper interval | 5 min |
| Catalog cache | 60 s |
| RunPod API retries | 3 per tier, exponential backoff + jitter |
| Self-QA rounds | max 2, then ship and list issues |
| Render error retries | max 3 per scene |
| Drive chunk size | 32 MB (multiple of 256 KiB) |
| Max pods running at once | [DECIDE] e.g. 15; extra jobs queue |
| Max cost per job | [DECIDE] e.g. $1.00 -> cancel |

## 12. Failure -> automatic recovery (no user prompts)

| Failure | Automatic recovery |
|---|---|
| Nearest region has no GPU | next region tier (Secure, then Community) |
| No GPU ≤ $2/hr anywhere | RunPod CPU pod with x264 |
| Pod created above $2/hr | DELETE at once, try next option |
| Pod stuck booting > 6 min | DELETE, skip that data center, retry |
| Pod dies mid-render | heartbeat silent 60 s -> new pod, same spec, re-render |
| Docker Hub pull limit / outage | authenticated pulls; backoff; retry in next data center |
| RunPod API 429 / 5xx | exponential backoff + jitter, 3 tries per tier |
| Render error in a scene | log -> Claude auto-fixes -> resubmit (max 3) |
| Self-QA keeps failing | ship after 2 rounds, list issues in final message |
| Drive upload drops | resume same session (PUT bytes */size) |
| Drive session 4xx / expired | new session, upload again |
| md5 mismatch | re-upload before terminating pod |
| Chat or tab closed | job keeps running; wait_job works from any chat |
| Orphan / forgotten pod | 30-min self-destruct + 5-min reaper |
| RunPod balance low | auto-pay + alert (RunPod may delete pods at $0 balance) |
| Tool permission prompt | connector tools set to Always allow |
| Drive token revoked | alert; re-authorise once (OAuth app in Production) |

## 13. Security

- All secrets (RunPod key, Docker Hub credential id, Google OAuth client + refresh token) live only in Cloudflare Worker secrets. Never in chat, Project docs or the image.
- Pod receives only JOB_ID, JOB_TOKEN (per job, expires at TTL), CP_URL and a Drive session URI. No Google or account-wide RunPod keys.
- Google OAuth scope: drive.file (only files the app created). Do not use a service account: service accounts have no Drive storage quota.
- OAuth app publishing status must be Production; in Testing, refresh tokens expire after 7 days.
- MCP connector protected by OAuth or a secret path; agent endpoints check JOB_TOKEN + job state.
- Pod names prefixed vf- so the reaper only touches this system's pods.

## 14. Known external limits

| Item | Limit / fact |
|---|---|
| Docker Hub free (authenticated) | 200 pulls / 6 h ≈ 33 pods/hr -> Docker Pro needed for 50/hr |
| Google Drive upload | 750 GB per user per 24 h; max file 5 TB; session URI valid 1 week |
| RunPod billing | per second; stopped pod with volumeInGb=0 costs nothing; always DELETE |
| RunPod pod env | RUNPOD_POD_ID and pod-scoped RUNPOD_API_KEY injected automatically |
| Claude chat | plan usage limits cap chats/hour; for sustained 50/hr consider a batch chat or the API |

## 15. One-time setup checklist

1. RunPod: add credit, enable auto-pay, create API key, add Docker Hub registry credential (get its id).
2. Docker Hub: private repo; Pro plan if > ~33 videos/hr.
3. GitHub: repo with renderer + agent; Actions builds and pushes a pinned image tag on each release.
4. Google Cloud: enable Drive API; OAuth client; scope drive.file; publish to Production; sign in once to get the refresh token; create the 'Video Factory' folder.
5. Cloudflare: deploy Worker (MCP server + agent API + cron reaper) with D1; store all secrets.
6. Claude: add Worker URL as a custom connector; set every tool to Always allow.
7. Claude Project: upload style library docs + runbook (see section 16).
8. Run one test video end to end; then run the GPU benchmark to set the rank.

## 16. Project runbook (system prompt for the Claude Project)

```
You produce videos end to end with no questions to the user.
1. On a new request (title, voiceover, style): call acquire_gpu FIRST, before planning.
2. Plan scenes from the style doc for that style. Call submit_job with the scene plan.
3. Call wait_job(until="preview"). Inspect the frames yourself. Fix with revise_scene
   (max 2 rounds), then approve.
4. Call wait_job(until="done") repeatedly until done. Post only the Drive link,
   duration, GPU used, cost, and any unresolved issues.
5. Never ask the user anything mid-job. Use defaults. Only report if the job fails.
```

## 17. Suggested repository layout and build order

```
/control-plane         Cloudflare Worker (TypeScript)
  src/mcp.ts           MCP server: tools in section 4
  src/agent.ts         agent API: section 5
  src/selector.ts      GPU selector: sections 6, 8, 9
  src/drive.ts         Drive broker: section 7
  src/reaper.ts        cron: section 6 step 5
  src/db/schema.sql    jobs, pods, events tables (D1)
/renderer              Docker image
  Dockerfile           Chromium, ffmpeg (NVENC + x264), fonts, styles
  agent/               Python or Node agent: hello, spec, heartbeat, render, upload, done, TTL
  styles/<name>/       templates per style
/ci                    GitHub Actions: build + push pinned tag
/bench                 60 s test video + script to rank GPUs
```

1. D1 schema + job state machine.
2. RunPod client + selector (test with a dummy image).
3. Agent skeleton (hello/heartbeat/TTL) + Docker image.
4. Drive broker + resumable upload.
5. MCP tools.
6. Renderer + styles.
7. Reaper, alerts, benchmark.

## 18. Open decisions [DECIDE]

- Voiceover input: text -> TTS on the pod (which TTS model/voice?) vs. an uploaded audio file in Drive.
- Video length range (sets TTL and per-job cost cap).
- Max concurrent pods and alert channel (email / Telegram).
- Whether to keep finished scene files for faster recovery (re-render is the default).
