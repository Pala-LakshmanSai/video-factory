# Video Factory — project rules for Claude

## Layout rule for every style (owner, 2026-11-16)
Never overlap two or more infographics or texts (titles, labels, numbers/counters, charts, boards, cards, arrows,
props used as graphics, images). Give each its own clear space, fully inside the safe area and never under the
letterbox bars. Every text must stand out clearly from what is behind it: contrast at least 4.5:1, with a solid
plate behind text on light or busy backgrounds. This applies to registry styles, kit packages and the flat2d engine
alike; flat2d enforces it in `engines/flat2d/tools/qa.mjs` (0 errors before packing) and the engine draws contrast
plates automatically. Details: docs/ENGINE_FLAT2D.md "Layout and contrast".

## Pointers
- Pipeline and kits: docs/KIT_WORKFLOW.md, docs/ENGINE_FLAT2D.md, renderer/styles/README.md.
- Claude.ai project instructions: docs/PROJECT_INSTRUCTIONS.md (paste its block into the Project after changes).
