# Style templates — the contract between styles and the render engine

Each style is a folder `renderer/styles/<style>/` with:

- `tokens.json` — palette, fonts, safe margins, motion timings (shape below).
- One HTML file per template id listed in `packages/contract/src/styles.ts` (`TEMPLATES`): `title.html`, `kinetic-text.html`, `b-roll-caption.html`, `list.html`, `quote.html`, `end-card.html`.

A matching doc `docs/styles/<style>.md` tells Claude what the style is for and what each template's props are.

## How the engine drives a template

1. The engine opens `file:///.../styles/<style>/<template>.html` in headless Chromium at exactly the plan's resolution (e.g. 1920×1080 or 1080×1920), device scale 1.
2. Before any page script runs it defines:
   ```js
   window.__scene = {
     props,        // the scene's props from scene_plan (template-specific, see docs/styles/<style>.md)
     tokens,       // parsed tokens.json of the style
     duration,     // scene length in seconds (after rescaling to the audio)
     width, height,
     fps,
     n, total,     // scene number and scene count
     narration,    // the words this scene covers
   };
   ```
   Time is frozen: `Date.now()`, `performance.now()`, `requestAnimationFrame` and timers never advance on their own.
3. The page must define `window.__seek = (t) => void` that draws the frame at `t` seconds from scene start (0 ≤ t < duration), synchronously, purely from `t` and `__scene` (no randomness unless seeded from props, no network).
4. The page may define `window.__ready` as a Promise (e.g. `document.fonts.ready`); the engine awaits it once before the first seek.
5. The engine calls `__seek(t)` for every frame and screenshots the viewport. Output must be byte-identical for the same plan.

Shared helpers live in `renderer/styles/_shared/runtime.js` (load with `<script src="../_shared/runtime.js"></script>`): easing, clamp, `fitText(el, maxW, maxH, maxPx, minPx)`.

## Rules for every template

- Text auto-fits inside the safe margins from `tokens.safe` (fractions of width/height); never clipped, never overlapping.
- Works at both 16:9 and 9:16.
- Missing optional props fall back to sensible defaults; missing required props render a visible placeholder rather than throwing.
- Fonts come from the image (`Inter`, `Noto Serif`, `Noto Sans CJK`, `Noto Color Emoji`, `Bebas Neue`, installed system-wide) or from OFL font files inside the style folder (`fonts/`, loaded by relative `@font-face`, licence file included). No web fonts, no network.
- `b-roll-caption` takes an optional `image` prop: an `https:` URL is NOT allowed (no network at render time); it takes a `data:` URI or omits the image and draws a tokens-coloured backdrop.

## tokens.json shape

```json
{
  "palette": { "bg": "#0e1116", "fg": "#f5f7fa", "accent": "#ffb000", "muted": "#8a93a3" },
  "fonts": { "display": "Inter", "body": "Inter", "weightDisplay": 800, "weightBody": 500 },
  "safe": { "x": 0.08, "y": 0.1 },
  "motion": { "in": 0.45, "out": 0.35, "stagger": 0.12, "ease": "cubicOut" },
  "pacing": { "wordsPerSecond": 2.6, "minScene": 2.0, "maxScene": 9.0 }
}
```
