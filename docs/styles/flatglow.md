# Style: `flatglow`

Kurzgesagt-like narrated science animation, ported from the audited Flatglow Explainer Kit. It uses flat vector shapes with two-tone shading, glow and bloom, and deep saturated worlds (space, biology, tech, daylight, dusk). The camera keeps drifting slowly, objects pop in with a small overshoot, and tags pop on the narrator's words. Text is Poppins, with Space Mono for sources. The style is built for `1920x1080`; `1080x1920` also renders, and the layout reflows to it.

**Use it for:** science, nature, space, biology and "how does X work" explainers, and curious, playful educational videos.
**Don't use it for:** serious documentary or history (use `documentary`), or hype shorts (use `bold-shorts`).

> Limits: every scene ≥ 2 s after stretching to the real audio (plan ≥ 2.2 s; tokens use 2.5 s). Whole plan ≤ 1.5 MB.

## Plan rules
- `style: "flatglow"`, `fps: 30` (any fps from 12 to 60 is accepted), `resolution: "1920x1080"` (preferred) or `"1080x1920"`.
- `n` runs 1..N. The total must be ≤ 3 min. `transition` is `cut`, `fade` or `slide`; use `cut` on the last scene. `narration` holds the exact voiceover words.
- Audio is one track (`voiceover`). Score and SFX only work if they are pre-mixed into the job's Drive audio file.
- Every text prop is a plain string. Text wraps and shrinks to fit. A missing required prop shows a visible `[missing …]` placeholder.
- **Shared optional props:** `world`: `space` | `bio` | `tech` | `day` | `dusk` (each template has a default) and `seed` (a number that varies the decoration).

## Pacing
Use 2.6 words per second, with scenes between 2.5 s and 9 s: `duration_s = max(2.5, words / 2.6)`. Objects and items appear in order across the first ~65% of the scene, so the narration should mention them in that order. Each scene fades to the dark background over its last 0.3 s. Default to `fade` between ideas and `slide` within a sequence.

## Templates

### `title`: opening or chapter card (world default `space`)
| prop | type | req | notes |
|---|---|---|---|
| `title` | string | **yes** | ≤ 8 words. Types on, with a gradient underline. |
| `kicker` | string | no | 1–3 words, in an uppercase tag above the title. |
| `subtitle` | string | no | ≤ 12 words. |
| `emblem` | boolean | no | Default `true`: shows the lens/planet emblem. |

### `scene`: a picture made of kit objects (world default `space`)
| prop | type | req | notes |
|---|---|---|---|
| `objects` | object[] | **yes** | 1–8 objects (extras are dropped). Each object is `{ kind, x, y, size, color?, label?, labelStyle?, labelColor?, sub?, at?, seed?, variant?, mood?, flip? }`. |
| `caption` | string | no | ≤ 15 words, in a rounded card at the bottom. |
| `captionAt` | number | no | The second the caption appears (default 0.6). |
| `camera` | `push` \| `pan-left` \| `pan-right` \| `still` | no | Default `push`: a slow push-in with a float. |
| `push` | number | no | How much the camera pushes in per 10 s (default 0.05). |

Object fields:
- `kind`: one of `planet`, `star` (`variant`: `sun`, `blue`, `white` or `orange`), `moon`, `asteroid`, `galaxy`, `cell`, `virus`, `bacterium`, `blood-cell`, `orb`, `ball`, `critter`, `character` (a person; `mood`: `calm`, `happy`, `sad`, `shock`, `cold` or `look-up`; `flip`), `box` (isometric), `tree`, `dna` or `sparkle`. An unknown kind shows a placeholder.
- `x`, `y`: the centre, as a fraction 0..1 of the frame width and height.
- `size`: the diameter, as a fraction 0..1 of the short side (default 0.22).
- `color`: a hex main colour (optional).
- `at`: the second the object pops in (default 0.15 + 0.25 × index).
- `label`: ≤ 4 words.
- `labelStyle`: `tag` (default: a solid tag with a pointer), `pill` (a gradient), `name` (written on, with an underline; `sub` adds a second line) or `line` (a thin leader line, good for space).
- `labelColor`: `red`, `blue`, `green`, `purple`, `magenta`, `orange`, `ink` or `teal`.

Keep objects inside 0.12–0.88 so their labels fit. Use 1–4 objects for a clear picture.

### `kinetic`: neon kinetic line (world default `tech`)
| prop | type | req | notes |
|---|---|---|---|
| `text` | string | **yes** | 3–12 words, shown uppercase and typed in word by word over ~70% of the scene. |
| `emphasis` | string[] | no | Words drawn in yellow. Matching ignores case and punctuation. |
| `aside` | string | no | A small parenthetical shown after the line, e.g. "(we don't either)". |

### `diagram`: nodes linked by animated arrows (world default `space`)
| prop | type | req | notes |
|---|---|---|---|
| `nodes` | (string \| {label, kind?, color?})[] | **yes** | 2–6 nodes. Labels ≤ 3 words. `kind` is any `scene` object kind (default `ball`). |
| `heading` | string | no | ≤ 8 words. |
| `layout` | `row` \| `column` \| `cycle` | no | Default `row`; portrait uses `column`. `cycle` arranges the nodes in a ring and links the last node back to the first. |
| `links` | [from, to][] | no | Node index pairs. Default: a chain 0→1→2… |

### `list`: numbered points (world default `bio`)
| prop | type | req | notes |
|---|---|---|---|
| `items` | string[] | **yes** | 2–6 items, ≤ 8 words each, each with a glossy numbered ball. |
| `heading` | string | no | ≤ 8 words. |

### `end-card`: closing card (world default `space`; no required props)
| prop | type | notes |
|---|---|---|
| `title` | string | Default `Thanks for watching!` |
| `tagline` | string | ≤ 8 words. |
| `cta` | string | The pill text. Default `Subscribe`. |
| `sources` | string[] | ≤ 4 short citations, in small mono text at the bottom-left. |

## Example
See `renderer/styles/flatglow/example-plan.json`: a 19 s tardigrade video with one scene per template.
