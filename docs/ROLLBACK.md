# Fallback: stable-v1 (before custom styles)

Known-good production state, 2026-11-16, before the style-kit / style-registry work.

| Part | Pinned value |
|---|---|
| Git tag | `stable-v1` (commit 619d8f8) |
| Worker version | `07e4c460-6588-49cc-a950-67efb490f6aa` |
| Renderer image | `docker.io/lakshmansai121/video-renderer@sha256:65af4b0b77ddd434b33c7253f84f60b5f78a8d1e43bd1b63ca88e42567b566af` |
| Styles | `explainer`, `bold-shorts`, `documentary` (baked into the image) |
| Gates | `ADMISSION_ENABLED="1"`, `FAULTS_ENABLED="0"`, `DEV_ROUTES="0"` |

## Roll back (about 1 minute)

```bash
cd control-plane && npx wrangler rollback 07e4c460-6588-49cc-a950-67efb490f6aa
```

That restores the Worker code, vars and image pin at once. Jobs in flight keep their pods.
The old image stays on Docker Hub, so no rebuild is needed.

To restore the source too: `git checkout stable-v1` (or `git revert` the style commits on main).

Style work must keep D1 migrations additive (new tables/columns only), so the stable Worker
still runs against the newer schema. The 3 built-in styles stay in the image as the fallback
if the style registry is unreachable.

## Before rolling back past the style registry

Jobs created after a148db5 may use imported styles that the stable-v1 image lacks. Each job pins its renderer
image (`jobs.renderer_image`, migration 0003), but stable-v1 ignores that column, and jobs created before 0003
(NULL pin) follow the current image on replacement. Order matters:

1. Stop new jobs at the acquire boundary: deploy with `--var ACQUIRE_ENABLED:0` (same-chat replays still answer;
   admission stays on so queued/retrying jobs keep getting pods).
2. Let accepted jobs finish, or `release` them, while the selector can still make progress.
3. Only then set `ADMISSION_ENABLED="0"` and verify zero open jobs:
   `SELECT COUNT(*) FROM jobs WHERE state NOT IN ('done','failed','cancelled')` = 0.
4. `wrangler rollback` to stable-v1.

Turning admission off first can strand queued or retrying jobs. Never delete a registry entry: retire it
(`status: "retired"`) so jobs pinned to it still validate and same-chat replays still answer.
