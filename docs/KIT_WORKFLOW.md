# Kit workflow: unique per-video code from style kits

Use this when each video must look its own (new cast, new sets, new shots), not assembled from fixed templates.
The registry templates (`list_styles`) stay available for quick or simple videos.

## Where things live

- **Kits** (source of truth): `style-kits/` in this project (not in git; synced to every machine and Claude account by
  `scripts/vf`, see docs/SYNC.md). One folder or standalone `.md` per style, each with its `AUDIT*.md`. Add a style by dropping its kit here and auditing it
  (no Remotion, offline, `window.__seek(t)` contract).
- **Per-video packages**: built in a scratch/work folder, uploaded per job, kept 7 days in the control plane.

## Uniqueness rule (owner's requirement)

A style is a *look*: line weight, palette, proportions, type, camera grammar, pacing. It is **not** a cast.
Every video designs its own characters, props and sets for its topic using the kit's drawing primitives.
Example (stickman look): a CEO-affair video draws its CEO, partner, boardroom and night office; a Dubai
future-city video draws its developer, planners, desert and skyline. Kit "recurring hero" characters
(e.g. the hoodie figure) appear only when the owner asks for a recurring host. Never reuse a previous video's
cast or sets unless asked (a series' Part 2 keeps Part 1's cast on purpose).

## Layout rule (owner, every style)

Layout rule for EVERY style (owner, 2026-11-16): never overlap two or more infographics or texts (titles, labels, numbers/counters, charts, boards, cards, arrows, props used as graphics, images); give each its own clear space, fully inside the safe area and never under the letterbox bars; every text must stand out clearly from what is behind it (contrast at least 4.5:1, use a solid plate behind text on light or busy backgrounds).
For flat2d videos this is enforced by `engines/flat2d/tools/qa.mjs`: packing waits until it reports 0 errors; failing scenes go back to their scene writer with the QA lines, then QA runs again.

## Steps per video (run from Claude Code, which can read `style-kits/`)

1. Read the chosen kit and its AUDIT file. Write the voiceover (or take the user's) and a shot list.
2. Build a package folder: the kit runtime (drawing library, fonts with licences) + this video's code,
   exposing one `<template>.html` per shot type, each following `renderer/styles/README.md`
   (`window.__scene`, synchronous pure `window.__seek(t)`, optional `__ready`, no network, `data:` images only)
   + `tokens.json`.
3. Write `scene_plan.json` with `"style": "custom"`, template ids = your html names, transitions cut|fade|slide,
   one job (one GPU) per video, any length.
4. Check stills locally (render a few frames through `renderer/engine` with `stylesDir` = parent of the package).
5. `node scripts/pack-style.mjs <package-dir> scene_plan.json` → `.tar.gz` + `.b64` (≤ 8 MiB, no symlinks, no URLs).
6. MCP: `upload_package {name, data_b64}` → `package_id`; `acquire_gpu {style: "custom", …}`;
   `submit_job` with `scene_plan.package = package_id`; `wait_job` preview → review → `revise_scene` if needed →
   `approve` → `wait_job` done → Drive link.

## Connecting Claude Code to the factory (once)

`claude mcp add --transport http video-factory https://video-factory.lakshmansai121.workers.dev/mcp`,
then sign in with GitHub when prompted (only the allowed login gets in).

## Footage styles on RunPod (doomsday, gta, aviation, paper-style)

The skill styles render with their own scripts (ffmpeg/python/node) over downloaded footage, not in the Chromium
engine. Registry style `footage` runs that same script on a pod: one GPU job per video at any length, every vCPU
(`VF_THREADS`, which the scripts use instead of `os.cpu_count()`). Local render stays the fallback.

1. Make the edit as usual (doomsday: `edit.json`; others: the part's work folder with its render command).
2. `node scripts/vf.mjs footage <job>/edit.json --plan-out <job>/cloud/scene_plan.json` (doomsday: ships only what
   the edit uses: voice, words, the clips it cuts from plus their `.crop` caches and catalog `shots.json`, the music
   bed, the skill's scripts/overlays/sfx; absolute paths are rewritten into the bundle).
   Any other skill: `node scripts/vf.mjs footage --dir <folder> --cmd '["node","render.js"]' --out broll.mp4 --skill gta [--seconds N]`
   (ships the folder without node_modules/.git; the command runs inside it and must write `--out`).
   Files go to R2 `footage/<sha256>` through signed links; already-stored files are skipped, so after a dropped
   connection the same command resumes. It prints the bundle sha and writes the scene_plan.
3. MCP: `acquire_gpu {style:"footage", title, voiceover:{none:true}, chat_key}` → `submit_job {job_id, scene_plan}`
   → `wait_job until:"preview"` (12 frames of the finished render) → `approve` → `wait_job until:"done"` → Drive link.
   A fix: re-run `vf footage` and `revise_scene {scene:1, patch:{props:{bundle:"<new sha>"}}}`; the pod fetches only
   the files that changed and renders again.

Pod image needs for a skill: ffmpeg (BtbN static, x264 + NVENC), python3 with numpy/scipy, node 22, Chromium
(Playwright headless shell, also on PATH as `chromium`), Noto/DejaVu fonts. A skill needing more (pip/npm packages) must install them in its command or the image.
Bundles are not garbage-collected by `vf gc` (prefix `footage/`, separate from synced files); delete old ones in R2 by
hand if storage grows (ponytail: add an R2 lifecycle rule on `footage/` if that happens).
