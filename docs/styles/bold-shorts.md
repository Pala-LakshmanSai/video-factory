# Style: `bold-shorts`

Loud, high-contrast, fast. Black background, white **Bebas Neue** all-caps type, electric-yellow accent boxes, punchy scale-in pops (backOut easing). Designed for vertical shorts (`1080x1920`: TikTok / Reels / YouTube Shorts); it also works at `1920x1080`.

**Use it for:** viral facts, hot takes, tips, listicles, hooks, anything under ~60 s that must stop the scroll.

**Don't use it for:** calm teaching with lots of on-screen text (use `explainer`), serious or sensitive topics, history/storytelling (use `documentary`).

## Plan rules (all styles)

- `style: "bold-shorts"`, `fps: 30`, `resolution: "1080x1920"` (preferred) or `"1920x1080"`.
- `scenes[].n` runs 1..N with no gaps, in playback order. Total length ≤ 3 minutes (shorts: keep it ≤ 60 s).
- `template` is one of the six ids below; `transition` is one of `cut`, `fade`, `slide` (into the next scene; use `cut` on the last scene).
- `narration` is the exact voiceover text the scene covers; every voiceover word belongs to exactly one scene, in order.
- `duration_s` is your estimate; the renderer rescales all durations proportionally to the real audio.
- All text props are plain strings. Everything is shown UPPERCASE (except the handle). Keep on-screen text **short**: big type is the point.
- A missing **required** prop renders a visible `[missing <prop>]` placeholder.
- Safe margins are 7% sides / 12% top and bottom, so platform UI (captions, buttons) doesn't cover text.

## Pacing

From `tokens.pacing`: **3.0 words per second**, scenes **1.5 s min, 5 s max**.

- `duration_s = max(1.5, words_in_narration / 3.0)`, rounded up to the nearest 0.5 s.
- Never exceed 5 s on one scene: split long sentences into several `kinetic-text` scenes. Change the picture every 2–5 s.
- The first scene is the hook: ≤ 3 s, a `title` or `kinetic-text` with a provocative claim.

## Transitions

`cut` is the default and should be used for most scenes. `slide` occasionally for a change of topic (e.g. into a `list`). Avoid `fade` (too soft for this style) except possibly into the `end-card`.

## Templates

### `title` — hook card
| prop | type | required | notes |
|---|---|---|---|
| `title` | string | **yes** | ≤ 6 words. Giant centred Bebas, punches in. |
| `subtitle` | string | no | ≤ 8 words, yellow, under a yellow bar. |
| `kicker` | string | no | 1–3 words in a yellow tag above the title (e.g. `Did you know?`). |

Good: the hook, a section divider. Bad: long sentences.

### `kinetic-text` — the workhorse: words pop in one by one
| prop | type | required | notes |
|---|---|---|---|
| `text` | string | **yes** | 3–10 words. Words pop in evenly paced across the scene; the newest word is yellow. CJK text without spaces pops per character. |
| `emphasis` | string[] | no | Words drawn as black-on-yellow boxes. Matched per word, case- and punctuation-insensitive. Use 1–2 words per scene. |

Good: most scenes of a short; put the narrated sentence (or its core) on screen. Bad: > 12 words (type gets small).

### `b-roll-caption` — visual with a boxed caption
| prop | type | required | notes |
|---|---|---|---|
| `caption` | string | **yes** | ≤ 8 words, white on black boxed lines, lower-middle. |
| `image` | string | no | **Must be a `data:image/...` URI** (`https:` URLs are ignored, no network). Without one, a black backdrop with yellow diagonal stripes is drawn. Slow zoom-out. |
| `credit` | string | no | Tiny grey credit line. |

Good: showing the thing being talked about. Bad: long captions.

### `list` — numbered items slam in
| prop | type | required | notes |
|---|---|---|---|
| `items` | string[] | **yes** | **2–6** items, ≤ 4 words each. Items beyond 6 are dropped. Yellow `1.` `2.` numbers. |
| `heading` | string | no | ≤ 4 words, black on a yellow box. |

Items slam in from the right across the first ~60% of the scene, in narration order. Good: "3 ways to…", tips. Bad: sentences as items.

### `quote` — big quote
| prop | type | required | notes |
|---|---|---|---|
| `quote` | string | **yes** | ≤ 15 words, without quote marks (a giant yellow mark is drawn). |
| `author` | string | no | Yellow, beside a yellow rule. |
| `role` | string | no | Grey, under the author. |

Good: a striking line from an expert or famous person. Never invent quotes from real people.

### `end-card` — follow card (no required props)
| prop | type | required | notes |
|---|---|---|---|
| `title` | string | no | Default `Follow for more`. Black on full-yellow screen. |
| `cta` | string | no | Default `Like & share`. Yellow on a black tag, gently pulsing. |
| `handle` | string | no | e.g. `@channel` (case kept). Hidden when omitted. |

## Example scene_plan (~30 s)

This is also `renderer/styles/bold-shorts/example-plan.json`.

```json
{
  "style": "bold-shorts",
  "fps": 30,
  "resolution": "1080x1920",
  "scenes": [
    {"n": 1, "template": "title", "props": {"kicker": "Did you know?", "title": "Your tea is cooling wrong"}, "duration_s": 3.0, "narration": "Your tea is cooling wrong, and here's why.", "transition": "cut"},
    {"n": 2, "template": "kinetic-text", "props": {"text": "Most heat escapes through the top", "emphasis": ["top"]}, "duration_s": 4.0, "narration": "Most of the heat escapes straight through the top of your mug.", "transition": "cut"},
    {"n": 3, "template": "kinetic-text", "props": {"text": "Steam steals the energy fast", "emphasis": ["steam", "fast"]}, "duration_s": 4.5, "narration": "Steam steals that energy really, really fast, way faster than the mug does.", "transition": "cut"},
    {"n": 4, "template": "list", "props": {"heading": "Keep it hot", "items": ["Use a lid", "Preheat the mug", "Pick ceramic"]}, "duration_s": 4.5, "narration": "Want it hot longer? Use a lid, preheat the mug, and pick ceramic.", "transition": "slide"},
    {"n": 5, "template": "b-roll-caption", "props": {"caption": "A lid doubles your hot time"}, "duration_s": 4.0, "narration": "Just adding a lid can double how long your tea stays hot.", "transition": "cut"},
    {"n": 6, "template": "kinetic-text", "props": {"text": "Cheapest upgrade in your kitchen", "emphasis": ["cheapest"]}, "duration_s": 3.5, "narration": "A lid is honestly the cheapest upgrade in your kitchen.", "transition": "cut"},
    {"n": 7, "template": "kinetic-text", "props": {"text": "Try it tomorrow morning", "emphasis": ["tomorrow"]}, "duration_s": 3.0, "narration": "Try it tomorrow morning and feel the difference.", "transition": "cut"},
    {"n": 8, "template": "end-card", "props": {"title": "Follow for more", "cta": "Daily kitchen hacks", "handle": "@kitchenphysics"}, "duration_s": 2.0, "narration": "Follow for more daily kitchen hacks.", "transition": "cut"}
  ]
}
```
