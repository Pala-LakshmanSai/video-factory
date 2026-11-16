# Style: `stickman`

Stickman Explainer: flat vector stick figures (round heads, thick limbs, a hoodie hero with rim light) on simple one-light sets, a cinematic 2:1 letterbox (black bars top and bottom), gold numbers on a navy void, dark label pills that pop in, a gold "WHAT IF YOU COULD / ___?" title card. Fast: a cut on every sentence. Drawn in code on a canvas (the Stickman Explainer kit), Inter ExtraBold for all text. **16:9 only** (`1920x1080`); at 9:16 the 16:9 picture is shown with black above and below.

**Use it for:** "what if…" explainers, science/scale/number videos (how high, how cold, how many), light educational B-roll over a voiceover, shorts and long-form alike.

**Don't use it for:** serious documentary/history (use `documentary`), anything that needs lots of on-screen reading (use `explainer`), vertical-first shorts (use `bold-shorts`).

## Plan rules (all styles)

- `style: "stickman"`, `fps: 24` (the kit's rate), `resolution: "1920x1080"`.
- `scenes[].n` runs 1..N with no gaps, in playback order. Total length ≤ 3 minutes.
- `template` is one of the five ids below; `transition` is `cut`, `fade` or `slide` (the transition *into the next scene*; `cut` on the last scene).
- `narration` is the exact voiceover text the scene covers. Every word belongs to exactly one scene, in order.
- `duration_s` is your estimate; the renderer rescales all durations proportionally to the real audio, so keep the *ratios* right.
- All text props are plain strings. Text auto-shrinks to fit, but short text reads better: respect the length hints.
- A missing **required** prop renders a visible `[missing <prop>]` placeholder, so always supply them.
- Numbers on screen must match the narration exactly. No drawn faces of real people: use `photo` with a real (data: URI) image, or a `hero` scene that doesn't claim to be them.

## Pacing

From `tokens.pacing`: **2.6 words per second**, scenes **2 s min, 6 s max**. The 2 s minimum holds after the renderer stretches the plan to the real audio, so plan each scene at **≥ 2.2 s** and merge very short lines. Whole plan ≤ 1.5 MB including any `photo` data URIs.

- **Cut on every sentence**: one spoken line, one picture. `duration_s = max(1.5, words / 2.6)`, rounded to 0.5 s. Typical shots are 2–4 s; the cold open can go faster (1.5–2.5 s).
- Over ~15 words in one scene? Split it.
- Transitions: **`cut` by default** (the kit's rule). Use `fade` only into or out of the `title` card or between data scenes. Avoid `slide`.
- Vary templates: never more than two `hero` scenes in a row without a `number`/`stages`/`title`/`photo` beat.
- Pills and digits land at fixed fractions of the scene (below), not on exact words: put the line the pill echoes at the start of that scene's narration.

## Templates

### `hero` — the hoodie hero on a set, acting one beat, with label pills
| prop | type | required | notes |
|---|---|---|---|
| `set` | string | no | `void` (navy void with a warm pool of light, default), `night` (void with stars), `dawn` (sky gradient, warm), `kitchen` (blurred kitchen set). |
| `mood` | string | no | Face: `neutral` (default), `happy`, `smug`, `shocked`, `worried`, `talking` (mouth moves), `sleepy`. |
| `action` | string | no | `stand` (default), `wave`, `shrug`, `point` (to the pills), `think`, `walk` (walks across). |
| `hoodie` | string | no | `blue` (default), `red`, `green`, `yellow`, `purple`. Keep one colour for the hero per video; another colour = another character. |
| `pills` | string[] | no | 0–3 labels, ≤ 4 words each, ideally UPPERCASE. Stacked on the right; they pop in evenly between 15 % and 65 % of the scene. Without pills the hero stands centred. |
| `accent` | string | no | Pill accent bar: `teal`, `gold`, `red`, `blue`. Default cycles teal → gold → red. Colour = meaning (red = bad, teal = good/neutral, gold = number/highlight). |

Good: any line about a person, a feeling, a situation ("you're stuck in traffic"). Bad: a line whose point is a number (use `number`).

### `title` — the gold title card
| prop | type | required | notes |
|---|---|---|---|
| `word` | string | **yes** | The payoff, 1–2 words, e.g. `FLY?`. Huge gold letters that rise in one by one (at 25 % of the scene, ≤ 0.6 s) and hover. |
| `line` | string | no | Lead-in line above it. Default `WHAT IF YOU COULD`. ≤ 5 words. |

Good: the hook, once, after a short cold open (3–4 s scene). Bad: chapter titles every minute.

### `number` — a number that lands
| prop | type | required | notes |
|---|---|---|---|
| `value` | string | **yes** | The number with its unit, ≤ 8 characters ideal: `11 km`, `-56°C`, `8 billion`. Drops in character by character in gold. |
| `label` | string | no | ≤ 4 words, a pill under the number after it lands. |
| `caption` | string | no | ≤ 6 words, small cream caps above the number. |
| `accent` | string | no | Label pill accent (see `hero`). |

Good: the one number the line is about. Bad: two numbers (two scenes, or `stages`).

### `stages` — a ruler of 2–6 stages, the camera whips up through them
| prop | type | required | notes |
|---|---|---|---|
| `items` | array | **yes** | 2–6 stages, bottom to top, each `{"value": "4 km", "label": "skydivers"}` (or a plain string label). Value ≤ 8 chars, label ≤ 4 words. The camera dwells on each stage for an equal share of the scene and whips (0.35 s) to the next, so narrate them in order. |
| `heading` | string | no | ≤ 4 words, a pill at the top. |
| `accent` | string | no | Heading pill accent. |

Good: altitudes, distances, sizes, a timeline of 3 dates. Give it ~1.5 s per stage. Bad: unordered lists.

### `photo` — a real photo as a framed print under a picture light
| prop | type | required | notes |
|---|---|---|---|
| `image` | string | **yes** | **Must be a `data:image/...` URI** (jpeg/png/webp). `https:` URLs are ignored (no network at render). Keep it small (< 300 KB). Public domain or openly licensed only. |
| `caption` | string | no | ≤ 6 words, pill under the frame (name, place, year). |
| `credit` | string | no | Photo credit/licence, small in the bottom bar. Always give it for licensed photos. |
| `accent` | string | no | Caption pill accent. |

Good: where the narration names a real person, place or discovery. Bad: decoration; mostly the video should be animation.

## Audio

The engine muxes one voiceover track. The kit's sound effects and music are not drawn by the templates: if the user wants them, they come pre-mixed into the Drive voiceover file.

## Example scene_plan (~22 s)

This is `renderer/styles/stickman/example-plan.json` (its `photo` scene carries a small generated placeholder image; shortened here).

```json
{
  "style": "stickman",
  "fps": 24,
  "resolution": "1920x1080",
  "scenes": [
    {"n": 1, "template": "hero", "props": {"set": "void", "mood": "worried", "action": "stand", "pills": ["2 HOURS A DAY", "IN TRAFFIC"]}, "duration_s": 3.0, "narration": "You spend two hours a day stuck in traffic.", "transition": "cut"},
    {"n": 2, "template": "title", "props": {"line": "WHAT IF YOU COULD", "word": "FLY?"}, "duration_s": 3.0, "narration": "So what if you could fly?", "transition": "cut"},
    {"n": 3, "template": "hero", "props": {"set": "dawn", "mood": "happy", "action": "wave", "hoodie": "red", "pills": ["NO TRAFFIC"], "accent": "teal"}, "duration_s": 2.5, "narration": "No traffic, ever again.", "transition": "cut"},
    {"n": 4, "template": "stages", "props": {"heading": "HOW HIGH?", "items": [{"value": "2.45 m", "label": "highest human jump"}, {"value": "4 km", "label": "skydivers"}, {"value": "11 km", "label": "airliners"}]}, "duration_s": 4.5, "narration": "The highest jump is two point four five metres. Skydivers start at four kilometres. Airliners cruise at eleven.", "transition": "cut"},
    {"n": 5, "template": "number", "props": {"value": "-56°C", "label": "AT 11 KM", "caption": "the air outside", "accent": "red"}, "duration_s": 3.0, "narration": "And up there it's minus fifty-six degrees.", "transition": "cut"},
    {"n": 6, "template": "hero", "props": {"set": "night", "mood": "shocked", "action": "shrug", "pills": ["TOO COLD", "TOO THIN"], "accent": "red"}, "duration_s": 3.0, "narration": "Too cold, and the air is too thin to breathe.", "transition": "cut"},
    {"n": 7, "template": "photo", "props": {"image": "data:image/jpeg;base64,...", "caption": "THE WRIGHT FLYER, 1903", "credit": "Placeholder image (generated)"}, "duration_s": 3.0, "narration": "Humans only got off the ground in 1903, with a machine.", "transition": "cut"}
  ]
}
```
