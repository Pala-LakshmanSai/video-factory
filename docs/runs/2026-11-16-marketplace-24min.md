# Test run: 24 min flatglow video (2026-11-16)

"NEVER Buy These 9 Things on Facebook Marketplace (Resellers Say Why!)", voiceover 24:20 (1460.4 s), style `flatglow`, 1920x1080 @ 30 fps, 259 scenes.
Result: job `j_986bde208a484c29`, 488 MB mp4, public Drive link, total GPU spend $0.8774 over 3 jobs (two failed on pipeline bugs, fixed below).

## Timeline of the successful job (UTC, from D1 events)
| Step | Start | End | Took |
|---|---|---|---|
| acquire_gpu → pod created (RTX PRO 4500 Blackwell, EU-RO-1, $0.72/h) | 09:05:52 | 09:05:59 | 7 s |
| Pod boot (create → agent /hello) | 09:05:59 | 09:06:56 | 57 s |
| Preview render (777 frames) + upload | 09:06:56 | 09:10:59 | 4 min 03 s |
| Preview QA (2 parallel subagents) + approve | 09:10:59 | 09:12:29 | 1 min 30 s |
| Final render (24:20 of video) | 09:12:29 | 09:42:05 | 29 min 36 s (0.82x real time) |
| Drive upload 488 MB | 09:42:05 | 09:42:22 | 17 s |
| Verify md5 + share | 09:42:22 | 09:42:24 | 2 s |
| **acquire → done** | 09:05:52 | 09:42:24 | **36 min 32 s**; 2187 GPU-s, $0.4374 |

## Prep (local, before the first job)
| Step | Took |
|---|---|
| Transcribe the voiceover (whisper.cpp small.en, M-series Mac) | 57 s (08:03:10 → 08:04:07) |
| Group into 259 timed scenes (script) | < 1 s |
| Scene plan: 4 parallel subagents, 64–65 scenes each | 46–65 s each; 08:06:23 merged |
| Plan validation (control-plane validatePlan) | < 1 s; 107 KB |
| Earlier job 1 boot (RTX 4090, EU-RO-1) for comparison | 25 s |

## Failures found and fixed
| # | Symptom | Root cause | Fix (commit) |
|---|---|---|---|
| 1 | Planner had to split the video into ≤ 3 min parts (one GPU each) | `MAX_VIDEO_MIN: 3` and per-style docs said "split long videos" | One job = one GPU at any length; TTL and budget scale with the plan (f3cfd8a) |
| 2 | Could not pass the user's mp3 to a job | Worker's Drive token is `drive.file` scope: it reads only files it created | `POST /upload/input` (token-gated) uploads audio to Drive (f3cfd8a) |
| 3 | 107 KB plan too big to paste into an MCP tool call | — | `POST /upload/plan` = submit_job over HTTP (f3cfd8a) |
| 4 | Job 1 failed: `/previews` TimeoutError | 777 D1 inserts one at a time > agent's 70 s timeout | D1 batches of 40 (f3cfd8a) |
| 5 | Job 2: Cloudflare 503 at 0 frames | `formData()` buffered ~40 MB → Worker memory | Streaming multipart parser (97befe2) |
| 6 | Job 2: 503 after ~600 frames | Workers Free plan CPU per request; `cpu_ms` can't be raised on Free | Renderer posts previews in 60-frame chunks (7758399) |
| 7 | Each upload failure re-rendered every preview (~5 min) | Stage-level retry only | Per-chunk retry with 2/4/8 s backoff (0a00653) |
| 8 | Character labels drawn over the head (14+ scenes) | flatglow placed labels at `y - r`; characters reach ~1.3 r | Labels clear the head; name labels lift for underline (0a00653) |
| 9 | `wait_job` would return 777 images | No cap | At most 90 mid-scene frames (f3cfd8a) |

Image `sha256:62882afa…d797` (0a00653) passed renderer CI 43832677299 and qualify-image 43836679190 (blockworld=true); Worker eb3df26a.

## Speed-up (0f06781, image sha256:12d1424f…7de8, Worker af92c182)
Cause: the GeForce NVENC 4-session cap also capped frame capture (CPU-bound Chromium raster), one Chromium served all pages, and previews rendered one scene at a time.
Fix: capture workers = 3/4 of the cores (max 24); x264 when more workers fit than NVENC sessions; one Chromium per 6 pages; previews on a worker pool.

Measured on a real pod: job `j_1cb5f87a752942a3`, first 181.3 s of this video, 31 scenes, RTX PRO 4500 Blackwell, 48 vCPU, $0.037.
| Step | Before (24 min job, 4 workers) | After (0f06781) |
|---|---|---|
| Boot (create → hello) | 57 s | 44 s |
| Previews | 0.94 s/scene (259 in 4:03) | 0.42 s/scene (31 in 13 s) |
| Final render | 0.82x real time (24.7 fps) | **1.59x real time** (181 s in 114 s, ~48 fps) |
| A 24 min video, final render | 29 min 36 s | ~15 min (projected) |
Output check: md5 matches the Drive file, 1920x1080 h264 + aac, 181.33 s, no black frames, spot frame clean.

## Open
- QA left one cosmetic issue: scene 132's grey "Pavement" box sits low on the dusk background.
