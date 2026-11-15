# Video Factory

One chat message (title + voiceover + style) → a finished video in Google Drive, rendered on a fresh RunPod GPU,
zero prompts mid-run. Spec: `docs/SPEC.md`; typed contract: `docs/CONTRACT.md`; setup steps: `docs/SETUP.md`.

| Dir | What |
|---|---|
| `control-plane/` | Cloudflare Worker: MCP server, agent API, selector, Drive broker, crons |
| `renderer/` | Pod image: agent, Chromium + ffmpeg render engine, Kokoro TTS, styles |
| `packages/contract/` | Shared types (generated from `docs/CONTRACT.md`) and style index |
| `bench/` | 60 s standard test video for the weekly GPU re-rank |
| `scripts/` | `google_oauth.py` (Drive token + smoke test), `drill.ts` (Phase 9 faults) |
| `docs/styles/` | Style docs for the Claude Project; `docs/PROJECT_INSTRUCTIONS.md` is the runbook |
