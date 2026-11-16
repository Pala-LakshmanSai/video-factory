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

/** SPEC §4: voiceover is text OR a Google Drive file id, never both. Extension: {none: true} = no narrator
 *  (caption-led styles only, e.g. blockworld, whose audio is the episode's own score). */
export type Voiceover =
  | { text: string; drive_file_id?: never; none?: never }
  | { drive_file_id: string; text?: never; none?: never }
  | { none: true; text?: never; drive_file_id?: never };

/** Error codes carried in `error` (SPEC §8, §10 + Extensions). */
export type ErrorCode =
  | "failed_no_capacity"     // SPEC §8
  | "render_errors"          // SPEC §10 "3 render errors"
  | "budget"                 // SPEC §10 "budget" / §11 max cost per job
  | "drive_auth"             // Extension
  | "pod_replacements"       // Extension
  | "md5_mismatch";          // Extension
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
export interface ScenePlan {
  style: string;             // must equal the job's style
  fps: number;               // e.g. 30
  resolution: string;        // "<width>x<height>", e.g. "1920x1080" or "1080x1920"
  scenes: Scene[];
  package?: string;          // style "custom" only: package_id from upload_package (pk_ + 24 hex); absent otherwise
}
export interface Scene {
  n: number;                 // 1-based, contiguous, in playback order
  template: string;          // a template id from renderer/styles/<style>/
  props: Record<string, unknown>;   // template inputs, defined in docs/styles/<style>.md
  duration_s: number;        // > 0
  narration: string;         // the voiceover words this scene covers
  transition: string;        // into the next scene, e.g. "cut"; ids defined per style
}
export interface HelloIn { gpu: string; vcpu: number; ram_gb: number; pod_id: string; data_center: string }
export interface HelloOut { state: "waiting_for_plan" | "rendering" }   // "rendering" when a plan is already stored (Contradiction #3)

/** GET /spec, long-poll <= 50 s. 200 with this body, or 204 (retry). */
export interface SpecOut {
  style: string;
  scenes: Scene[];
  voiceover: Voiceover;
  fps: number;               // Extension: rest of scene_plan, needed to render
  resolution: string;        // Extension
  package?: string;          // style "custom": fetch GET /agent/{job}/input/package (application/gzip .tar.gz)
  package_sha256?: string;   // full hex sha256 of that package; the agent verifies the bytes against it and the id
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
export interface GoogleTokenResp { access_token: string; expires_in: number }   // 3599
/** POST .../upload/drive/v3/files?uploadType=resumable, headers X-Upload-Content-Length, X-Upload-Content-Type: video/mp4 */
export interface DriveSessionBody { name: string; parents: [string] }          // "<title>.mp4", [DRIVE_FOLDER_ID]
// -> 200, header Location: <session_uri> (valid 1 week, no auth header needed)
// Pod: PUT <session_uri> 32 MiB chunks, Content-Range bytes a-b/size -> 308 Range: bytes=0-b ... last -> 200/201 {id}
//      drop: PUT Content-Range bytes */size -> 308 Range -> resume at b+1; 404/4xx: new /upload-session, restart at 0
export interface DriveFileMeta { size: string; md5Checksum: string; webViewLink: string }   // GET files/{id}?fields=size,md5Checksum,webViewLink
export interface DrivePermissionBody { role: "reader"; type: "anyone" }                  // POST files/{id}/permissions
export const CONSTANTS = {
  BOOT_TIMEOUT_S: 10 * 60,           // 6.2 GB image cold pulls; create -> /hello, then DELETE, skip that data center
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
