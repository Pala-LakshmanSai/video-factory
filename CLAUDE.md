# Video Factory — project rules for Claude

## Sync: one source of truth for every Claude account and machine (docs/SYNC.md)
- **Owner preferences are live in the cloud**, not in local memory. The SessionStart hook prints them; read them
  and follow them. `node scripts/vf.mjs prefs` lists them again.
- When the owner states a lasting preference (always/never/from now on, or a correction to how a style should
  look or be made), save it at once: `node scripts/vf.mjs pref add <global|style-id> "<one clear rule>"`, and
  `node scripts/vf.mjs pref retire <id> "<why>"` for the one it replaces. Never save preferences only in auto-memory
  or CLAUDE.md; claude.ai Projects read the same store through the connector (`project_brief`, `style_guide`).
- Skills (`~/.claude/skills/{aviation,gta,paper-style,align-images,cut-silences,youtube-video-style-analyze}`) and
  `style-kits/` are synced files: edit them in place; the Stop hook pushes changes in the background
  (`node scripts/vf.mjs push` to do it now, `status` to see pending changes). A new skill or kit folder that should
  sync: `node scripts/vf.mjs track <name> ~/.claude/skills/<name>` (or `@repo/<dir>`).
- If the session-start context reports SYNC CONFLICTS, resolve them first (`vf resolve <root:path> --keep local|remote`).
- Code, registry styles, docs and these rules sync through git (the hook fast-forwards `main`); commit and push them as
  usual. `docs/**` changes on main are published live to claude.ai by CI.
- Ops facts about the live factory: docs/OPS_STATE.md (keep it current instead of writing them to local memory).

## Layout rule for every style (owner, 2026-11-16)
Never overlap two or more infographics or texts (titles, labels, numbers/counters, charts, boards, cards, arrows,
props used as graphics, images). Give each its own clear space, fully inside the safe area and never under the
letterbox bars. Every text must stand out clearly from what is behind it: contrast at least 4.5:1, with a solid
plate behind text on light or busy backgrounds. This applies to registry styles, kit packages and the flat2d engine
alike; flat2d enforces it in `engines/flat2d/tools/qa.mjs` (0 errors before packing) and the engine draws contrast
plates automatically. Details: docs/ENGINE_FLAT2D.md "Layout and contrast".

## Rendering
Never reduce render parallelism to save effort: local renders go through `renderer/engine/render.ts` (`renderFinal`
sizes capture workers from the CPU count); cloud renders are one GPU job per video at any length.
Local samples: `node renderer/tools/lab.ts sample <plan.json>`; reference comparison: `lab.ts refs` / `lab.ts compare`.

## Pointers
- Reusable prompts: docs/prompts/ (new account setup, style creation, style refinement against a channel).
- Pipeline and kits: docs/KIT_WORKFLOW.md, docs/ENGINE_FLAT2D.md, renderer/styles/README.md.
- claude.ai Project: docs/PROJECT_INSTRUCTIONS.md is served live; Projects only need the bootstrap in
  docs/prompts/NEW_ACCOUNT_SETUP.md.
