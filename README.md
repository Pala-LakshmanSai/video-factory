# Video Factory

One chat message (title + voiceover + style) → a finished video in Google Drive, rendered on a fresh RunPod GPU,
zero prompts mid-run. Spec: `docs/SPEC.md`; typed contract: `docs/CONTRACT.md`; setup steps: `docs/SETUP.md`.

**New Claude account or new Mac:** follow `docs/prompts/NEW_ACCOUNT_SETUP.md`. Everything (preferences, styles,
skills, kits, instructions) stays in sync across accounts: `docs/SYNC.md`. Reusable prompts: `docs/prompts/`.

| Dir | What |
|---|---|
| `control-plane/` | Cloudflare Worker: MCP server, agent API, selector, Drive broker, crons |
| `renderer/` | Pod image: agent, Chromium + ffmpeg render engine, Kokoro TTS, styles |
| `packages/contract/` | Shared types (generated from `docs/CONTRACT.md`) and style index |
| `bench/` | 60 s standard test video for the weekly GPU re-rank |
| `scripts/` | `vf` (cross-account sync, docs/SYNC.md), `google_oauth.py` (Drive token + smoke test), `drill.ts` (Phase 9 faults) |
| `renderer/tools/lab.ts` | Style lab: reference download, local sample render, side-by-side comparison |
| `docs/styles/` | Style docs, served live to claude.ai (`style_guide`); `docs/PROJECT_INSTRUCTIONS.md` is the live runbook |
| `docs/prompts/` | Reusable prompts: new account setup, style creation, style refinement against a channel |
