# Video Factory — Contract

Typed form of `docs/SPEC.md` §4–§7, §10, §11. Names, fields and timeouts match SPEC.md exactly; anything SPEC.md does not define lives in **Extensions** (bottom) and nowhere else.

The ` ```ts ` blocks in this file are the whole of `packages/contract/src/index.ts`, in order. Change them here, then regenerate:

```bash
awk '/^```ts$/{f=1;next} /^```$/{f=0} f' docs/CONTRACT.md > packages/contract/src/index.ts
```

## Shared

```ts
// ---- generated from docs/CONTRACT.md — edit there, not here ----

/** SPEC §10 states, plus "rerendering" (named in §4 revise_scene) and Extensions "queued" / "cancelled". */
export type JobState =
  | "queued"            // Extension
  | "provisioning"
  | "booting"
  | "waiting_for_plan"
  | "rendering"
  | "preview_ready"
  | "rerendering"       // SPEC §4 (missing from §10, see Contradictions)
  | "final_render"
  | "uploading"
  | "verifying"
  | "done"
  | "retrying"
  | "failed"
  | "cancelled";        // Extension (SPEC §4 release returns it)

export const TERMINAL_STATES = ["done", "failed", "cancelled"] as const;

/** SPEC §4: voiceover is text OR a Google Drive file id, never both. */
export type Voiceover =
  | { text: string; drive_file_id?: never }
  | { drive_file_id: string; text?: never };

/** Error codes carried in `error` (SPEC §8, §10 + Extensions). */
export type ErrorCode =
  | "failed_no_capacity"     // SPEC §8
  | "render_errors"          // SPEC §10 "3 render errors"
  | "budget"                 // SPEC §10 "budget" / §11 max cost per job
  | "drive_auth"             // Extension
  | "pod_replacements"       // Extension
  | "md5_mismatch";          // Extension
```

## §4 Contract A — MCP tools (Claude → control plane)

Transport: MCP Streamable HTTP at `https://<worker>/mcp`, JSON-RPC `tools/call`. Every tool set to Always allow.

```ts
export interface AcquireGpuIn {
  style: string;
  title: string;
  voiceover: Voiceover;
  chat_key: string;          // Extension: random id Claude makes once per chat; idempotency key
}
export interface AcquireGpuOut { job_id: string; state: JobState }   // "provisioning" on first call; current state on repeat (Contradiction #5)

export interface SubmitJobIn { job_id: string; scene_plan: ScenePlan }
export interface SubmitJobOut { state: JobState; gpu: string }   // "rendering" once the pod is up; gpu e.g. "RTX 4090 · AP-IN-1", "" until chosen (Contradiction #4)

export interface WaitJobIn {
  job_id: string;
  until: "preview" | "done";
  timeout_s?: number;        // <= 50
}
export interface WaitJobOut {
  state: JobState;
  pct: number;
  previews: PreviewLabel[];  // one label per MCP image content block, same order
  drive_link?: string;
  gpu_minutes?: number;
  cost_usd?: number;
  error?: string;            // "<ErrorCode>: <detail>", or a render error "scene <n>: <log tail>"
}
/** SPEC §4 "previews:[image...]": the JPEGs ride as MCP `image` content blocks; this labels each. */
export interface PreviewLabel { scene: number; idx: number; round: number }

export interface ApproveIn { job_id: string }
export interface ApproveOut { state: "final_render" }

export interface ReviseSceneIn {
  job_id: string;
  scene: number;             // Scene.n
  patch: Partial<Scene>;     // JSON merge patch (RFC 7386) applied to that scene
}
export interface ReviseSceneOut { state: "rerendering"; scene: number }

export interface ReleaseIn { job_id: string }
export interface ReleaseOut { state: "cancelled" }    // manual abort only
```

```json
{"tool":"acquire_gpu","in":{"style":"explainer","title":"Why Tea Cools","voiceover":{"text":"Tea cools because..."},"chat_key":"qhtrzmwa"},
 "out":{"job_id":"j_01JD3K7Q","state":"provisioning"}}
{"tool":"submit_job","in":{"job_id":"j_01JD3K7Q","scene_plan":{"style":"explainer","fps":30,"resolution":"1920x1080","scenes":[{"n":1,"template":"title","props":{"title":"Why Tea Cools"},"duration_s":4,"narration":"Tea cools because...","transition":"cut"}]}},
 "out":{"state":"rendering","gpu":"RTX 4090 · AP-IN-1"}}
{"tool":"wait_job","in":{"job_id":"j_01JD3K7Q","until":"preview","timeout_s":50},
 "out":{"state":"preview_ready","pct":100,"previews":[{"scene":1,"idx":0,"round":1},{"scene":1,"idx":1,"round":1},{"scene":1,"idx":2,"round":1}]}}
{"tool":"wait_job","in":{"job_id":"j_01JD3K7Q","until":"done","timeout_s":50},
 "out":{"state":"done","pct":100,"previews":[],"drive_link":"https://drive.google.com/file/d/1AbC/view","gpu_minutes":6.4,"cost_usd":0.07}}
{"tool":"revise_scene","in":{"job_id":"j_01JD3K7Q","scene":1,"patch":{"props":{"title":"Why Hot Tea Cools"}}},
 "out":{"state":"rerendering","scene":1}}
{"tool":"approve","in":{"job_id":"j_01JD3K7Q"},"out":{"state":"final_render"}}
{"tool":"release","in":{"job_id":"j_01JD3K7Q"},"out":{"state":"cancelled"}}
```

### scene_plan (Extension — SPEC §4 names it, never defines it)

```ts
export interface ScenePlan {
  style: string;             // must equal the job's style
  fps: number;               // e.g. 30
  resolution: string;        // "<width>x<height>", e.g. "1920x1080" or "1080x1920"
  scenes: Scene[];
}
export interface Scene {
  n: number;                 // 1-based, contiguous, in playback order
  template: string;          // a template id from renderer/styles/<style>/
  props: Record<string, unknown>;   // template inputs, defined in docs/styles/<style>.md
  duration_s: number;        // > 0
  narration: string;         // the voiceover words this scene covers
  transition: string;        // into the next scene, e.g. "cut"; ids defined per style
}
```

Validation (submit_job rejects with precise errors): `style` matches the job; `n` runs 1..N with no gaps; every `template` and `transition` exists in that style (`packages/contract/src/styles.ts`); total ≤ 3 min. The control plane never decodes audio, so for BOTH voiceover kinds `duration_s` are Claude's best estimate and the renderer rescales them proportionally to the real audio length (see Contradictions #6).

## §5 Contract B — Agent API (pod → control plane)

Base `https://<worker>/agent/{job_id}`. Auth `Authorization: Bearer JOB_TOKEN` (random per job, pod env, valid only for that job, expires at TTL). D1 stores only its SHA-256.

```ts
export interface HelloIn { gpu: string; vcpu: number; ram_gb: number; pod_id: string; data_center: string }
export interface HelloOut { state: "waiting_for_plan" | "rendering" }   // "rendering" when a plan is already stored (Contradiction #3)

/** GET /spec, long-poll <= 50 s. 200 with this body, or 204 (retry). */
export interface SpecOut {
  style: string;
  scenes: Scene[];
  voiceover: Voiceover;
  fps: number;               // Extension: rest of scene_plan, needed to render
  resolution: string;        // Extension
}

/** POST /heartbeat every 15 s. */
export interface HeartbeatIn { stage: string; pct: number; scene?: number }
export type Cmd =
  | "continue"
  | "render_final"
  | `rerender:${number}`
  | "cancel"
  | "reupload";              // Extension
export interface HeartbeatOut { cmd: Cmd }

/** POST /previews: multipart/form-data, JPEG parts named "scene-<n>-<idx>" -> 201. */

export interface UploadSessionIn { name: string; size: number; md5: string }
export interface UploadSessionOut { session_uri: string }

export interface DoneIn { file_id: string; md5: string; size: number }   // -> 200

export interface ErrorIn { stage: string; scene?: number; log_tail: string }
export interface ErrorOut { cmd: "retry" | "cancel" }

/** GET /input/voiceover: only when voiceover is a drive_file_id; 200 audio bytes streamed from Drive. */

/** POST /bench (Extension, BENCH=1 pods only): {render_s} -> 200 {cmd:"cancel"}. */
export interface BenchIn { render_s: number }
```

```json
{"POST /hello":{"gpu":"NVIDIA GeForce RTX 4090","vcpu":16,"ram_gb":62,"pod_id":"abc123xyz","data_center":"AP-IN-1"},"->":{"state":"waiting_for_plan"}}
{"GET /spec":"->","200":{"style":"explainer","fps":30,"resolution":"1920x1080","scenes":[{"n":1,"template":"title","props":{"title":"Why Tea Cools"},"duration_s":4,"narration":"Tea cools because...","transition":"cut"}],"voiceover":{"text":"Tea cools because..."}}}
{"POST /heartbeat":{"stage":"final_render","pct":42,"scene":3},"->":{"cmd":"continue"}}
{"POST /upload-session":{"name":"Why Tea Cools.mp4","size":73400320,"md5":"9e107d9d372bb6826bd81d3542a419d6"},"->":{"session_uri":"https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=ABC"}}
{"POST /done":{"file_id":"1AbC","md5":"9e107d9d372bb6826bd81d3542a419d6","size":73400320},"->":{}}
{"POST /error":{"stage":"preview","scene":2,"log_tail":"TypeError: props.items is undefined"},"->":{"cmd":"retry"}}
```

## §6 Contract C — RunPod API

```ts
/** GET https://api.runpod.io/v2/catalog/datacenters?include=GPU_AVAILABILITY (cache 60 s) */
export type Availability = "NONE" | "LOW" | "MEDIUM" | "HIGH";
export interface Catalog {
  dataCenters: {
    id: string; name: string; region: string;
    gpuAvailability: { id: string; name: string; availability: Availability }[];
  }[];
}

/** POST https://rest.runpod.io/v1/pods */
export interface CreatePodBody {
  name: `vf-${string}`;                      // "vf-{job_id}"
  imageName: string;                          // "docker.io/<user>/video-renderer:<pinned-tag>"
  containerRegistryAuthId: string;
  computeType: "GPU" | "CPU";
  cloudType?: "SECURE" | "COMMUNITY";         // GPU tiers
  gpuTypeIds?: string[];                      // ranked, filtered by live availability
  gpuTypePriority?: "custom";
  dataCenterIds: string[];
  dataCenterPriority: "custom";
  gpuCount?: 1;
  minVCPUPerGPU?: 8;
  cpuFlavorIds?: ["cpu5c", "cpu3c"];          // §6.2b CPU fallback
  cpuFlavorPriority?: "custom";
  vcpuCount?: 16;
  containerDiskInGb: 30;
  volumeInGb: 0;
  ports: [];                                  // Extension
  env: {
    JOB_ID: string; JOB_TOKEN: string; CP_URL: string; TTL_MIN: string;
    NVIDIA_DRIVER_CAPABILITIES?: "compute,utility,video";   // Extension (GPU pods)
    BENCH?: "1";                                            // Extension: weekly benchmark pods
  };
}
export interface CreatePodResp {
  id: string;
  costPerHr: number;                          // > 2.00 -> DELETE immediately, continue
  machine: { gpuTypeId: string; dataCenterId: string; cpuCount: number };
}
// DELETE https://rest.runpod.io/v1/pods/{pod_id} -> 200
// Pod self-destruct: DELETE .../v1/pods/$RUNPOD_POD_ID with pod-scoped $RUNPOD_API_KEY; fallback POST .../stop
// Reaper: GET https://rest.runpod.io/v1/pods -> DELETE "vf-*" pods whose job is done/failed/cancelled/missing or past TTL
```

```json
{"name":"vf-j_01JD3K7Q","imageName":"docker.io/<user>/video-renderer:3f9c2ab","containerRegistryAuthId":"<RUNPOD_REGISTRY_AUTH_ID>",
 "computeType":"GPU","cloudType":"SECURE","gpuTypeIds":["NVIDIA GeForce RTX 4090","NVIDIA L40S"],"gpuTypePriority":"custom",
 "dataCenterIds":["AP-IN-1"],"dataCenterPriority":"custom","gpuCount":1,"minVCPUPerGPU":8,"containerDiskInGb":30,"volumeInGb":0,"ports":[],
 "env":{"JOB_ID":"j_01JD3K7Q","JOB_TOKEN":"<random>","CP_URL":"https://<worker>","TTL_MIN":"30","NVIDIA_DRIVER_CAPABILITIES":"compute,utility,video"}}
```

## §7 Contract D — Google Drive (control plane holds the refresh token; pod gets only session_uri)

```ts
export interface GoogleTokenResp { access_token: string; expires_in: number }   // 3599
/** POST .../upload/drive/v3/files?uploadType=resumable, headers X-Upload-Content-Length, X-Upload-Content-Type: video/mp4 */
export interface DriveSessionBody { name: string; parents: [string] }          // "<title>.mp4", [DRIVE_FOLDER_ID]
// -> 200, header Location: <session_uri> (valid 1 week, no auth header needed)
// Pod: PUT <session_uri> 32 MiB chunks, Content-Range bytes a-b/size -> 308 Range: bytes=0-b ... last -> 200/201 {id}
//      drop: PUT Content-Range bytes */size -> 308 Range -> resume at b+1; 404/4xx: new /upload-session, restart at 0
export interface DriveFileMeta { size: string; md5Checksum: string; webViewLink: string }   // GET files/{id}?fields=size,md5Checksum,webViewLink
export interface DrivePermissionBody { role: "reader"; type: "anyone" }                  // POST files/{id}/permissions
```

## §10 State machine

Every change writes an `events` row. Illegal transitions throw. Terminal: `done`, `failed`, `cancelled`.

| From | To | Triggered by | When |
|---|---|---|---|
| (new) | provisioning | MCP `acquire_gpu` | pods running < max pods at once |
| (new) | queued | MCP `acquire_gpu` | pods running = max pods at once (Extension) |
| queued | provisioning | cron watchdog | a pod slot frees |
| provisioning | booting | selector | pod created, costPerHr ≤ 2.00 |
| provisioning | failed | selector | no capacity anywhere (`failed_no_capacity`) |
| booting | waiting_for_plan | agent `POST /hello` | no plan stored yet |
| booting | rendering | agent `POST /hello` | plan already stored (submitted during boot, or replacement pod) — see Contradictions #3 |
| waiting_for_plan | rendering | MCP `submit_job` | plan stored |
| rendering | preview_ready | agent `POST /previews` | every scene's 3 key frames for this round are in |
| rendering, preview_ready, rerendering | rerendering | MCP `revise_scene` | plan patched; heartbeat cmd `rerender:<n>` |
| rerendering | preview_ready | agent `POST /previews` | revised scene's frames are in |
| preview_ready | final_render | MCP `approve` | heartbeat cmd `render_final` |
| final_render | uploading | agent `POST /upload-session` | session created |
| uploading | verifying | agent `POST /done` | — |
| verifying | uploading | control plane | md5/size mismatch → cmd `reupload` (max 2) |
| verifying | done | control plane | md5 + size match, shared anyone/reader, pod DELETEd |
| any non-terminal with a pod | retrying | cron watchdog | no /hello 6 min after create, or heartbeat silent 60 s in rendering/final_render/uploading |
| retrying | booting | selector | replacement pod created (same plan) |
| retrying | failed | selector / watchdog | no capacity, or more than 2 replacements (`pod_replacements`) |
| any non-terminal | failed | agent `POST /error` / watchdog / Drive broker | 3 render errors (`render_errors`), cost > max (`budget`), `invalid_grant` (`drive_auth`); pod DELETEd |
| any non-terminal | cancelled | MCP `release` | pod DELETEd |

## §11 Constants

```ts
export const CONSTANTS = {
  BOOT_TIMEOUT_S: 6 * 60,            // create -> /hello, then DELETE, skip that data center
  HEARTBEAT_INTERVAL_S: 15,
  HEARTBEAT_DEAD_S: 60,
  POD_TTL_MIN: 30,                   // see Decisions for the per-length formula
  REAPER_INTERVAL_MIN: 5,
  CATALOG_CACHE_S: 60,
  RUNPOD_RETRIES: 3,                 // per tier; backoff 1 s, 2 s, 4 s + jitter
  SELF_QA_ROUNDS_MAX: 2,
  RENDER_ERROR_RETRIES_MAX: 3,       // per scene
  DRIVE_CHUNK_BYTES: 32 * 1024 * 1024,   // multiple of 256 KiB
  PRICE_CAP_USD_PER_HR: 2.0,
  SPEC_LONG_POLL_S: 50,
  WAIT_JOB_TIMEOUT_MAX_S: 50,
  MAX_PODS_AT_ONCE: 15,              // Decision
  MAX_COST_PER_JOB_USD: 1.0,         // Decision
  MAX_VIDEO_MIN: 3,                  // Decision
} as const;

/** Decision: TTL_MIN = 30, +10 per started minute of video beyond 3. */
export const ttlMinFor = (videoSeconds: number): number =>
  30 + 10 * Math.max(0, Math.ceil(videoSeconds / 60) - 3);
```

## Decisions (resolves every [DECIDE] in SPEC §11 and §18)

| Item | Value |
|---|---|
| Voiceover input | Both. Drive audio file streamed via `GET /input/voiceover`; or text → on-pod TTS with **Kokoro-82M**, weights baked into the image (no extra service, SPEC §1). |
| Max video length | 3 min |
| Pod TTL | `TTL_MIN` = 30, +10 per extra minute (`ttlMinFor`) |
| Max pods at once | 15; extra jobs wait in state `queued` before provisioning |
| Max cost per job | $1.00 → cancel + report (`budget`) |
| Alert channel | Telegram bot |
| Keep finished scene files | No; re-render on recovery |
| Styles | `explainer`, `bold-shorts`, `documentary` |

## Extensions (needed, not spelled out in SPEC.md)

1. **Heartbeat cmd `reupload`** — §12 requires re-upload on md5 mismatch; §5's cmd list lacks it. Max 2, then `failed`.
2. **Pod env `NVIDIA_DRIVER_CAPABILITIES=compute,utility,video`** (NVENC fails in containers without `video`) and **`ports: []`** (RunPod's default exposes 8888/22).
3. **`chat_key`** — a random 8-letter id Claude makes once per chat and reuses; makes `acquire_gpu` idempotent. `jobs.chat_key` is UNIQUE.
4. **Preview JPEGs stored in D1**, ≤ 500 KB each, 3 per scene per round (start/mid/end, 1280 px). Multipart part names `scene-<n>-<idx>`.
5. **States `queued` and `cancelled`.**
6. **`scene_plan` schema** — `ScenePlan` / `Scene` above. `/spec` returns the full plan (`fps`, `resolution` too) plus `voiceover`.
7. **Error codes `drive_auth`, `pod_replacements` and `md5_mismatch`** — added beyond Prompt 1's list; Prompts 4a and 5a fail jobs with these reasons (md5 still wrong after 2 re-uploads) and Phase 7 alerts on them.
9. **Benchmark pods** — env `BENCH=1`, `POST /agent/{job}/bench {render_s}`; jobs with `dev_mode` `bench` end `cancelled` (SPEC §9.3 re-rank).
10. **RunPod v2 compatibility and safe pod lifecycle** — scoped keys can be refused by v1 REST (403) while `api.runpod.io/v2` works.
    - Create: v1 first; v1 400/401/403 → same attempt via `POST /v2/pods`, one GPU type (or CPU flavor `{id, vcpuCount:16}`) per call in rank order; after v1 401/403 creates skip v1 in that isolate.
    - Create claim (`jobs.create_claim`, a unique token; migration 0002): taken atomically before the first POST, re-checked immediately before **every** provider POST (v2 makes one POST per GPU type), released only on a definite outcome and only by its owner. A 5xx, network error, unreadable 2xx or uncancellable 202 QueuedPod is never replayed and never followed by another candidate: the claim stays and the job is **held**. A held job only looks its pod up by name `vf-{job_id}` (excluding its earlier pod ids): exactly one match → adopted; anything else (absent, unknown, several) → still held. A negative list never clears a hold. Unresolved for 15 min → `failed_no_capacity`; a pod appearing later is reaped as an orphan.
    - Admission: `ADMISSION_ENABLED` must be `"1"` for any create (and for the weekly benchmark); otherwise the selector stops before reading the catalog. The watchdog re-checks held jobs every minute and retries unclaimed admissions 90 s after `jobs.admission_at` (never `updated_at`, which cost writes bump). A catalog outage is read before the claim, so it leaves no hold.
    - Price cap: a missing, non-numeric or negative cost counts as over the cap; the cap itself is never NaN and never above $2/hr. A rejected pod is always recorded first; if its delete is not confirmed the job is held by the pending delete (no replacement).
    - Delete: `DELETE /v2/pods/{id}` first (204/404 = accepted), then v1 on 401/403/405. A delete-pending pod (`delete_reason` set, `deleted_at` NULL) stays tracked and is cleared **only on direct provider absence** (`GET /v2/pods/{id}` → 404 or `TERMINATED`), never on a 204 or a list omission; retried every minute, with one alert after 10 min of failures. A heartbeat/boot replacement waits for a confirmed delete; no job admits a new pod while one of its pods is delete-pending.
    - List: `GET /v2/pods`, cursor pagination, every page validated against `ListPodsResponse`/`Pod` (OpenAPI); malformed or incomplete → error, so the reaper does nothing that run. The reaper skips untracked `vf-` pods younger than 5 min or belonging to a held job, never marks a pod younger than 5 min or delete-pending as "gone", and its own deletes leave pods delete-pending.
    - Diagnostics: provider bodies are reduced to problem-detail strings with token-shaped values masked; raw pod JSON (which carries `env`) never reaches events, alerts or errors.
    - Pod self-destruct: v1 DELETE → v2 DELETE → v1 stop.
11. **Renderer registry: private GHCR instead of Docker Hub** (SPEC §2/§6 name Docker Hub; Docker Hub sign-in failed for this account). CI pushes `ghcr.io/pala-lakshmansai/video-renderer:<git sha12>` with the workflow's own `GITHUB_TOKEN` (`packages: write`), only from `main` and only the image that passed the smoke test. The package stays private. RunPod pulls it through a Container Registry Auth entry for `ghcr.io` holding a GitHub fine-grained token with **read-only package access**; that entry's id is `RUNPOD_REGISTRY_AUTH_ID`. `RENDERER_IMAGE` is any full image reference, so the control plane needs no code change. §14's Docker Hub pull limit (≈33 pods/hr) no longer applies; GHCR's own limits for private pulls are not yet measured.
8. **Replacement after approve** — if a pod dies after `approve`, the new pod re-renders previews and the job moves straight on to `final_render` without asking Claude again (`jobs.approved`).

## Contradictions and gaps in SPEC.md

Resolved 2026-11-15: the user accepted every proposal below; the types above already reflect them.

1. **Fallback nesting.** §8 and §9.1 loop compute tier outermost (Secure everywhere → Community everywhere → CPU). The diagram says "tiers inside each region", and §12 row 1 ("next region tier (Secure, then Community)") reads the same way. This contract follows §8: a Secure pod in the US beats a Community pod in India. For nearest-first, swap the loops in Prompt 3b and update §8.
2. **`rerendering` is missing from §10.** §4 `revise_scene` returns it. Added to `JobState` and the transition table.
3. **`/hello` always returns `waiting_for_plan`,** but the plan is usually stored before the pod boots (§3 runs planning in parallel), and always for a replacement pod (§12). The table goes `booting → rendering` on /hello when a plan exists; `HelloOut` is widened to `"waiting_for_plan" | "rendering"`.
4. **`submit_job` returns `{state:"rendering", gpu}`** even when called during boot (state `provisioning`/`booting`), when the GPU may not be chosen yet. Proposed: return the job's real state and `gpu` once known (`""` before the selector finishes).
5. **`acquire_gpu` is idempotent but returns `state:"provisioning"`.** A repeat call from the same chat finds a job that has moved on. Proposed: return the current state.
6. **Text voiceover length is unknown at plan time.** §18 allows TTS on the pod, so Claude cannot make durations sum to the audio. Proposed: for text, `duration_s` are weights the renderer rescales to the TTS audio; exact sum enforced only for Drive audio.
7. **Reaper covers only done/failed jobs** (§6 step 5). `cancelled` and missing jobs added (Prompt 7).
8. **"JOB_TOKEN expires at TTL"** is ambiguous once a pod is replaced. Proposed: expiry = current pod's create time + `TTL_MIN`.
9. **Re-upload needs the agent alive after `/done`.** §5 doesn't say; the agent keeps heartbeating through `verifying` until it gets `cancel` or the pod is deleted.
