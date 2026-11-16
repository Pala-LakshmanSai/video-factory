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
