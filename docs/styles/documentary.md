# Style: `documentary`

Calm, serif, cinematic. Near-black warm background, ivory **Noto Serif** text, antique-gold accent, black letterbox bars top and bottom, vignette, slow 1 s fades and a gentle push-in on every scene. Built for 16:9 (`1920x1080`); also renders at `1080x1920` (bars stay at 10% of the height).

**Use it for:** history, biography, nature, true stories, essays, reflective or serious topics, longer-form narration.

**Don't use it for:** fast shorts or hype (use `bold-shorts`), step-by-step tutorials with lots of on-screen text (use `explainer`).

## Plan rules (all styles)

- `style: "documentary"`, `fps: 30`, `resolution: "1920x1080"` (preferred) or `"1080x1920"`.
- `scenes[].n` runs 1..N with no gaps, in playback order. Any length: one job (one GPU) renders the whole video. Never split a video into parts.
- `template` is one of the six ids below; `transition` is one of `cut`, `fade`, `slide` (into the next scene; use `fade` on the last scene for a fade-out).
- `narration` is the exact voiceover text the scene covers; every voiceover word belongs to exactly one scene, in order.
- `duration_s` is your estimate; the renderer rescales all durations proportionally to the real audio.
- All text props are plain strings. On-screen text should be sparse: the narrator carries the story; the screen shows a name, a date, a line worth lingering on.
- A missing **required** prop renders a visible `[missing <prop>]` placeholder.

## Pacing

From `tokens.pacing`: **2.2 words per second**, scenes **4 s min, 12 s max**.

- `duration_s = max(4, words_in_narration / 2.2)`, rounded up to the nearest 0.5 s.
- Split narration longer than ~26 words (12 s) across scenes. Prefer 6–10 s scenes; let images breathe.
- Fades take 1 s in and 0.8 s out, so never go below 4 s.

## Transitions

`fade` is the default and should be used almost everywhere. `cut` is allowed for a deliberate jolt (a date, a turning point). Avoid `slide` (it breaks the cinematic tone).

## Templates

### `title` — opening / chapter card
| prop | type | required | notes |
|---|---|---|---|
| `title` | string | **yes** | ≤ 8 words, centred serif. |
| `subtitle` | string | no | ≤ 14 words, italic, muted, under a thin gold rule. |
| `kicker` | string | no | 1–4 words, small letter-spaced gold caps above the title (e.g. `Chapter II`, `1773`). |

Good: the opening, chapter breaks with a date or place. Bad: facts or sentences mid-story.

### `kinetic-text` — a line that fades in word by word
| prop | type | required | notes |
|---|---|---|---|
| `text` | string | **yes** | 5–20 words. Words fade in slowly, overlapping, evenly paced across the scene. CJK text without spaces fades per character. |
| `emphasis` | string[] | no | Words set in gold italics. Matched per word, case- and punctuation-insensitive. Use sparingly (0–2 words). |

Good: the thesis of the film, a turning-point sentence. Bad: routine narration (it should not mirror every line).

### `b-roll-caption` — the main visual scene
| prop | type | required | notes |
|---|---|---|---|
| `caption` | string | **yes** | ≤ 20 words, lower-left serif, at most ~2/3 of the width on 16:9. |
| `image` | string | no | **Must be a `data:image/...` URI** (`https:` URLs are ignored, no network). Graded slightly warm/desaturated, fades up from black with a slow Ken Burns push-in. Without one, a dark warm gradient backdrop is drawn. |
| `credit` | string | no | Small gold caps under the caption, e.g. `Archive photo, 1902`. |

Good: most narrative scenes; a place, a person, an object. Bad: long paragraphs as captions.

### `list` — a few facts, revealed in turn
| prop | type | required | notes |
|---|---|---|---|
| `items` | string[] | **yes** | **2–6** items, ≤ 12 words each, numbered with roman numerals I.–VI. between hairlines. Items beyond 6 are dropped. |
| `heading` | string | no | ≤ 8 words. |

Items fade in across the first ~60% of the scene in narration order. Good: a timeline, consequences, a few key figures. Use rarely in this style.

### `quote` — a lingering quotation
| prop | type | required | notes |
|---|---|---|---|
| `quote` | string | **yes** | ≤ 40 words, without quote marks (a gold mark is drawn). Italic, centred. |
| `author` | string | no | Letter-spaced caps under a short gold rule. |
| `role` | string | no | Italic, muted, under the author (e.g. dates or title). |

Good: primary-source quotes, letters, diaries. Never invent quotes from real people; attribute precisely.

### `end-card` — closing card (no required props)
| prop | type | required | notes |
|---|---|---|---|
| `title` | string | no | Default `Thank you for watching`. Repeating the film's title works well. |
| `cta` | string | no | Italic line, e.g. `Next: …`. Hidden when omitted. |
| `handle` | string | no | Gold, letter-spaced. Hidden when omitted. |

## Example scene_plan (~30 s)

This is also `renderer/styles/documentary/example-plan.json`.

```json
{
  "style": "documentary",
  "fps": 30,
  "resolution": "1920x1080",
  "scenes": [
    {"n": 1, "template": "title", "props": {"kicker": "A short history", "title": "The Leaf That Crossed Oceans", "subtitle": "How tea shaped trade, empire and the morning cup"}, "duration_s": 6.0, "narration": "It began as a bitter medicine in southern China, thousands of years ago.", "transition": "fade"},
    {"n": 2, "template": "b-roll-caption", "props": {"caption": "By the 1600s, tea was arriving in Europe by the shipload.", "credit": "Illustration: archive"}, "duration_s": 8.5, "narration": "Within centuries it spread along the caravan routes, and by the sixteen hundreds it reached Europe by ship.", "transition": "fade"},
    {"n": 3, "template": "kinetic-text", "props": {"text": "A single leaf would redraw the map of the world", "emphasis": ["redraw"]}, "duration_s": 6.5, "narration": "And that single leaf would go on to redraw the map of the world.", "transition": "fade"},
    {"n": 4, "template": "quote", "props": {"quote": "Thank God for tea! What would the world do without tea?", "author": "Sydney Smith", "role": "Essayist, 1771–1845"}, "duration_s": 7.5, "narration": "As one essayist put it: thank God for tea. What would the world do without it?", "transition": "fade"},
    {"n": 5, "template": "end-card", "props": {"title": "The Leaf That Crossed Oceans", "cta": "Next: the tea clipper races", "handle": "@slowhistory"}, "duration_s": 4.0, "narration": "Next time, the great tea clipper races.", "transition": "fade"}
  ]
}
```
