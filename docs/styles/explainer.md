# Style: `explainer`

Clean, friendly, educational. Warm off-white background, dark ink text, one blue accent, Inter throughout, soft slide-up entrances. Built for 16:9 (`1920x1080`) teaching videos; it also renders correctly at `1080x1920`.

**Use it for:** how-it-works videos, tutorials, science/finance/product explainers, "3 things you should know" content, anything where the viewer is learning and needs to read calmly.

**Don't use it for:** hype/viral shorts (use `bold-shorts`), history or narrative storytelling with a serious tone (use `documentary`).

## Plan rules (all styles)

- `style: "explainer"`, `fps: 30`, `resolution: "1920x1080"` (preferred) or `"1080x1920"`.
- `scenes[].n` runs 1..N with no gaps, in playback order. Any length: one job (one GPU) renders the whole video. Never split a video into parts.
- `template` is one of the six ids below; `transition` is one of `cut`, `fade`, `slide` (the transition *into the next scene*; use `cut` on the last scene).
- `narration` is the exact voiceover text the scene covers. Every word of the voiceover belongs to exactly one scene, in order.
- `duration_s` is your estimate; the renderer rescales all durations proportionally to the real audio, so keep the *ratios* right.
- All text props are plain strings (no HTML/Markdown). Text auto-shrinks to fit, but shorter text renders bigger and reads better: respect the length hints.
- A missing **required** prop renders a visible `[missing <prop>]` placeholder, so always supply them.

## Pacing

From `tokens.pacing`: **2.6 words per second**, scenes **2.5 s min, 9 s max**.

- `duration_s = max(2.5, words_in_narration / 2.6)`, rounded up to the nearest 0.5 s.
- If a narration chunk would need more than 9 s (≈ 23 words), split it across two scenes.
- Entrances take 0.5 s and exits 0.35 s, so scenes under ~3 s feel rushed; prefer 4–7 s.
- Change scene at sentence or clause boundaries; one idea per scene.

## Transitions

`cut`, `fade`, `slide` are all allowed. Default to `fade` between sections, `slide` within a sequence of related points (e.g. kinetic-text → list), `cut` for the last scene and for rapid emphasis.

## Templates

### `title` — opening card
| prop | type | required | notes |
|---|---|---|---|
| `title` | string | **yes** | ≤ 8 words ideal. Huge, left-aligned. |
| `subtitle` | string | no | ≤ 12 words. Muted, under an accent bar. |
| `kicker` | string | no | 1–3 words, shown uppercase in accent colour above the title (topic / series name). |

Good: the video's opening, or a chapter divider. Bad: mid-video facts (use `kinetic-text`), long sentences.

### `kinetic-text` — words appear one by one
| prop | type | required | notes |
|---|---|---|---|
| `text` | string | **yes** | 4–15 words. Revealed word by word, evenly paced across the scene (all words are visible before the exit). CJK text without spaces is revealed per character. |
| `emphasis` | string[] | no | Words to highlight in accent colour with a marker underline. Matched per word, case- and punctuation-insensitive (`"Hot"` matches `hot,`). Multi-word entries highlight each of their words. |

Good: the key statement of a section, a definition, a punchline. Put the sentence the narrator says (or its core) in `text`. Bad: more than ~20 words, lists (use `list`).

### `b-roll-caption` — full-bleed visual with a caption card
| prop | type | required | notes |
|---|---|---|---|
| `caption` | string | **yes** | ≤ 15 words. Shown in a rounded card at the bottom-left. |
| `image` | string | no | **Must be a `data:image/...` URI.** `https:` URLs are not allowed (no network at render) and are ignored. Without an image a soft accent-tinted backdrop is drawn. Slow 8% zoom across the scene. |
| `credit` | string | no | Source/photo credit, small, under the card. |

Good: an example, an illustration of the idea, a moment to breathe. Bad: anything that needs a real photo when you can't supply a data URI (it will just be a backdrop; that is fine, but then `kinetic-text` may be stronger).

### `list` — numbered points revealed one at a time
| prop | type | required | notes |
|---|---|---|---|
| `items` | string[] | **yes** | **2–6** short items (≤ 8 words each). Items beyond 6 are dropped. Numbered badges 1..N. |
| `heading` | string | no | ≤ 8 words. |

Items are revealed in order across the first ~60% of the scene, so the narration should mention them in order. Good: steps, reasons, components. Bad: a single item, paragraphs.

### `quote` — a quotation with attribution
| prop | type | required | notes |
|---|---|---|---|
| `quote` | string | **yes** | ≤ 30 words, without surrounding quote marks (they are added). |
| `author` | string | no | Shown bold as `— Author`. |
| `role` | string | no | Shown muted after the author (`, Role`). |

Good: expert quotes, famous lines, a customer testimonial. Bad: paraphrases presented as quotes; never invent quotes from real people.

### `end-card` — closing card (no required props)
| prop | type | required | notes |
|---|---|---|---|
| `title` | string | no | Default `Thanks for watching!` |
| `cta` | string | no | Default `Subscribe for more`. Shown in a pill button. |
| `handle` | string | no | e.g. `@channel`. Hidden when omitted. |

Good: the last scene. Bad: anywhere else.

## Example scene_plan (~30 s)

This is also `renderer/styles/explainer/example-plan.json`.

```json
{
  "style": "explainer",
  "fps": 30,
  "resolution": "1920x1080",
  "scenes": [
    {"n": 1, "template": "title", "props": {"kicker": "Kitchen physics", "title": "Why Hot Tea Cools So Fast", "subtitle": "Three ways heat escapes your cup"}, "duration_s": 5.0, "narration": "Ever wondered why your tea goes cold so quickly? Let's find out.", "transition": "fade"},
    {"n": 2, "template": "kinetic-text", "props": {"text": "Heat always flows from hot to cold", "emphasis": ["hot", "cold"]}, "duration_s": 5.0, "narration": "First, a simple rule: heat always flows from hot things to cold things.", "transition": "slide"},
    {"n": 3, "template": "list", "props": {"heading": "Where the heat goes", "items": ["Evaporation from the surface", "Conduction into the cup", "Radiation into the room"]}, "duration_s": 7.5, "narration": "Your tea loses heat three ways: steam off the top, warmth into the cup, and radiation into the room.", "transition": "slide"},
    {"n": 4, "template": "b-roll-caption", "props": {"caption": "Evaporation does most of the work in the first few minutes"}, "duration_s": 5.5, "narration": "Evaporation is the big one. Each escaping molecule carries a lot of energy away.", "transition": "fade"},
    {"n": 5, "template": "quote", "props": {"quote": "Nothing in life is to be feared, it is only to be understood.", "author": "Marie Curie", "role": "Physicist and chemist"}, "duration_s": 7.0, "narration": "As Marie Curie put it, nothing in life is to be feared, it is only to be understood.", "transition": "fade"},
    {"n": 6, "template": "end-card", "props": {"title": "Thanks for watching!", "cta": "Subscribe for more kitchen science", "handle": "@kitchenphysics"}, "duration_s": 3.5, "narration": "Thanks for watching, and subscribe for more kitchen science.", "transition": "cut"}
  ]
}
```
