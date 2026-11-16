# Kit workflow: unique per-video code from style kits

Use this when each video must look its own (new cast, new sets, new shots), not assembled from fixed templates.
The registry templates (`list_styles`) stay available for quick or simple videos.

## Where things live

- **Kits** (source of truth): `style-kits/` in this project (gitignored, on the KIOXIA drive). One folder or
  standalone `.md` per style, each with its `AUDIT*.md`. Add a style by dropping its kit here and auditing it
  (no Remotion, offline, `window.__seek(t)` contract).
- **Per-video packages**: built in a scratch/work folder, uploaded per job, kept 7 days in the control plane.

## Uniqueness rule (owner's requirement)

A style is a *look*: line weight, palette, proportions, type, camera grammar, pacing. It is **not** a cast.
Every video designs its own characters, props and sets for its topic using the kit's drawing primitives.
Example (stickman look): a CEO-affair video draws its CEO, partner, boardroom and night office; a Dubai
future-city video draws its developer, planners, desert and skyline. Kit "recurring hero" characters
(e.g. the hoodie figure) appear only when the owner asks for a recurring host. Never reuse a previous video's
cast or sets unless asked (a series' Part 2 keeps Part 1's cast on purpose).

## Steps per video (run from Claude Code, which can read `style-kits/`)

1. Read the chosen kit and its AUDIT file. Write the voiceover (or take the user's) and a shot list.
2. Build a package folder: the kit runtime (drawing library, fonts with licences) + this video's code,
   exposing one `<template>.html` per shot type, each following `renderer/styles/README.md`
   (`window.__scene`, synchronous pure `window.__seek(t)`, optional `__ready`, no network, `data:` images only)
   + `tokens.json`.
3. Write `scene_plan.json` with `"style": "custom"`, template ids = your html names, transitions cut|fade|slide,
   ≤ 3 min per job (longer → parts).
4. Check stills locally (render a few frames through `renderer/engine` with `stylesDir` = parent of the package).
5. `node scripts/pack-style.mjs <package-dir> scene_plan.json` → `.tar.gz` + `.b64` (≤ 8 MiB, no symlinks, no URLs).
6. MCP: `upload_package {name, data_b64}` → `package_id`; `acquire_gpu {style: "custom", …}`;
   `submit_job` with `scene_plan.package = package_id`; `wait_job` preview → review → `revise_scene` if needed →
   `approve` → `wait_job` done → Drive link.

## Connecting Claude Code to the factory (once)

`claude mcp add --transport http video-factory https://video-factory.lakshmansai121.workers.dev/mcp`,
then sign in with GitHub when prompted (only the allowed login gets in).
