# Style: `discovery`

Calm, real-media documentary for an older (55+) audience watching on a TV: archival photos and footage stills under one warm grade with slow eased camera moves, vignette and still grain; dark satellite-style maps with pulsing gold pins and drawn routes; then/now split reveals; big readable place / date / fact text in cream and gold on dark panels (nothing in the bottom 12 %); title, chapter and quote cards in Noto Serif capitals; Inter for information text. Built for `1920x1080` (the look is specified at 1080p and scales); `1080x1920` renders but is not the target.

**Use it for:** lost towns, wrecks, ancient sites, discoveries, local history, "what happened to X" stories told over real pictures.

**Don't use it for:** hype shorts (`bold-shorts`), teaching/how-to (`explainer`).

## Plan rules

- `style: "discovery"`, `fps: 30`, `resolution: "1920x1080"`.
- `scenes[].n` runs 1..N, playback order. **Total ≤ 3 minutes per job.** A long-form film (the style's natural 18–25 min) must be split into parts at chapter cards: one plan + one voiceover file + one job per part, joined afterwards (`ffmpeg -f concat -c copy`).
- `template` is one of the seven ids below. `transition` (into the next scene) is `cut`, `fade` or `slide`. Default `cut` between shots; `fade` into/out of title, chapter and quote cards (the engine fades from black, 0.35 s; there are no cross-dissolves); `slide` sparingly; `cut` on the last scene.
- `narration` = the exact words spoken over the scene; every voiceover word belongs to exactly one scene.
- `duration_s` is rescaled to the real audio length, but **overlay/caption times inside props are NOT rescaled**: keep `duration_s` close to the real spoken time so `at`/`dur` land on the words.
- **Images must be `data:image/...` URIs** (no `https:`, no file paths; no network at render). Re-encode ≤ 1920 px JPEG. A missing image draws a dark grey frame. The whole serialized plan (UTF-8 JSON, every data URI included) must stay **under 1.5 MB**: it is stored in one database row with a hard 2 MB limit. Size images before renting: ≤ 1280 px, JPEG quality ~75, about 60–150 KB each, so roughly 8–15 images per plan; flipbooks spend this budget fast (use few, small frames).
- Every template accepts `props.kind` to override its default shot kind, but use the matching template instead.
- Audio: the job has exactly one audio track. Score and sound effects only exist if pre-mixed into the voiceover file supplied from Drive (`voiceover: { drive_file_id }`); a Kokoro `{ text }` voiceover gives voice only.

## Pacing

`tokens.pacing`: 2.33 words/s, shots **2 s min** (after the renderer stretches the plan to the real audio, so plan ≥ 2.2 s), 12 s max. Cold open: 2.5–4 s shots; body: 5–8 s. Cut on spoken words. On-screen text needs `1 s + 0.45 s × words` (2.5–8 s) to be read.

## Shared props (all media templates: `photo`, `map`, `compare`, `end`; overlays/captions on any template)

| prop | type | notes |
|---|---|---|
| `credit` | string | small source credit, top-right (required on screen for CC BY media). |
| `recon` | string | e.g. `"Reconstruction"`: red-edged label top-left. **Required** on any AI image / illustration / reconstruction. |
| `overlays` | Overlay[] | documentary text, times in seconds from scene start (below). |
| `captions` | `{t, end, text}[]` | burned-in captions, lower centre, relative times. |
| `endDim` | number | from this second the picture dims to 55 % (YouTube end screen). |
| `fadeOut` | number | from this second the film fades to black over 1.1 s (last scene). |

**Overlay** `{ at, dur, kind, text, ... }` (`at`/`dur` seconds; fades in 0.45 s, out 0.4 s):
- `place` — `text` place name (≤ 4 words, caps), `sub` date/region. Lower-left stamp with a gold rule.
- `fact` — `big` the figure exactly as spoken (≤ 9 chars stays full size), `text` ≤ 8 words. `pos`: `left` (default) / `right` / `center`.
- `key` — `text` one key line ≤ 12 words, lower centre panel.
- `source` — `text` a citation, lower-right.
- `tag` — `text` 1–3 words top-left (words like "record"/"documented" get a teal edge, else gold), `sub` optional.
- `circle` — draws a gold ring on a detail: `x`, `y`, `r` in 1920×1080 pixels, `text` + `sub` label, `pos` `right`/`left`.
- `timeline` — `text` heading, `points: [{x: 0..1, label}]`, `hi` index lit in gold.

## Templates

### `title` — opening title card
| prop | type | req | notes |
|---|---|---|---|
| `text` | string | **yes** | ≤ 6 words, set in serif capitals, auto-fits. |
| `kicker` | string | no | 1–4 words in gold above. |
| `src` | data URI | no | background picture, dimmed and slightly blurred. |
| `grade` | string | no | `doc` (default) · `warm` · `cool` · `night` · `archival` · `none`. |

Fades up 0.5–1.6 s, out over the last 0.7 s: give it ≥ 3 s.

### `chapter` — chapter card
| prop | type | req | notes |
|---|---|---|---|
| `text` | string | **yes** | ≤ 5 words. |
| `num` | string | no | e.g. `"CHAPTER 2"`, gold, letter-spaced. |
| `src`, `grade` | | no | dimmed, blurred background. |

2–4 s. A good place to split a long film into ≤ 3-min parts.

### `photo` — a photo or footage still, moved slowly
| prop | type | req | notes |
|---|---|---|---|
| `src` | data URI | **yes** | the picture. |
| `size` | `[w, h]` | yes for moves | source pixel size (focus math). |
| `move` | preset or `{from:[fx,fy,zoom], to:[...]}` | no | `in` (default) · `in-slow` · `in-fast` · `out` · `left` · `right` · `up` · `down` · `still`. |
| `grade` | string | no | default `doc`; `archival` for old prints. |
| `fit` | `"cover"` \| `"print"` | no | `print` = the picture as a mounted print over a blurred copy of itself (portraits, documents). |
| `kind` | `"clip"` | no | footage poster: default move `in-slow`. |
| `frames`, `framesFps`, `rate` | data URI[], number, number | no | flipbook of footage stills, cross-faded (slow drone/archival motion). Costs plan size. |

The workhorse: most scenes are `photo` with an overlay.

### `map` — satellite map with pins and a route
`props.map`:
| field | type | req | notes |
|---|---|---|---|
| `lon`, `lat` | number | **yes** | centre of the shot. |
| `wide` | `{src, z, x0, y0, w, h}` | no | a web-mercator image: tile zoom `z`, top-left world pixel `x0,y0`, size `w×h`. Without it the map is a dark navy field (pins and route still draw). |
| `close` | same | no | a closer image that fades in as the push reaches it. |
| `zoom` | `[from, to]` | no | push-in scale relative to `wide.z`; without `wide`, pick values so the pins spread (≈ 20–40 for points 0.3° apart). |
| `pins` | `{lon, lat, label, sub?, at?, side?}[]` | no | pulsing gold pin; `at` seconds it appears; `side: "left"` puts the label left. |
| `route` | `[lon, lat][]` | no | gold line drawn 0.6 → 3.5 s. |
| `label` | string | no | region name top-left. |

### `compare` — then / now reveal
| prop | type | req | notes |
|---|---|---|---|
| `src`, `size` | | **yes** | THEN (left, default grade `archival`). |
| `src2`, `size2` | | **yes** | NOW (right, default grade `doc`). |
| `labels` | `[string, string]` | no | default `["THEN", "NOW"]`. |
| `grade`, `grade2` | string | no | |

A gold divider sweeps from the right to the middle in the first ~40 % of the scene: give it ≥ 3 s.

### `quote` — a quotation card
| prop | type | req | notes |
|---|---|---|---|
| `text` | string | **yes** | ≤ 30 words, without quote marks (added). Italic serif. |
| `by` | string | no | shown as `— by` in gold. |
| `src`, `grade` | | no | dimmed blurred background. |

Never invent quotes from real people.

### `end` — end screen
| prop | type | req | notes |
|---|---|---|---|
| `src`, `size`, `move` (default `still`), `grade` | | no | a calm wide picture, no text (YouTube end cards go on top). |

Use `endDim: 0` to dim it and `fadeOut` on the last seconds. 5–20 s in a real film.

## Example (abridged; images shortened)

```json
{ "style": "discovery", "fps": 30, "resolution": "1920x1080", "scenes": [
  { "n": 1, "template": "title", "duration_s": 3, "transition": "fade", "narration": "The town that vanished under the sea.",
    "props": { "text": "The Drowned Town", "kicker": "A Discovery Story", "src": "data:image/jpeg;base64,...", "grade": "warm" } },
  { "n": 2, "template": "photo", "duration_s": 3, "transition": "cut", "narration": "In 1362 a storm tide swept over the North Frisian coast.",
    "props": { "src": "data:image/jpeg;base64,...", "size": [1920, 1080], "move": "in", "credit": "Wikimedia, CC BY 4.0",
      "overlays": [{ "at": 0.3, "dur": 2.6, "kind": "place", "text": "Rungholt", "sub": "North Frisia · 1362" }] } },
  { "n": 3, "template": "map", "duration_s": 3, "transition": "fade", "narration": "Its ruins lie somewhere in these mudflats.",
    "props": { "map": { "lon": 8.6, "lat": 54.5, "zoom": [24, 34], "label": "Wadden Sea",
      "pins": [{ "lon": 8.6, "lat": 54.5, "label": "Rungholt", "sub": "lost 1362", "at": 0.4 }],
      "route": [[8.9, 54.62], [8.6, 54.5]] } } },
  { "n": 4, "template": "end", "duration_s": 2, "transition": "cut", "narration": "Thanks for watching.",
    "props": { "src": "data:image/jpeg;base64,...", "endDim": 0, "fadeOut": 0.9 } }
]}
```

Full runnable example (all seven templates): `renderer/styles/discovery/example-plan.json`.
