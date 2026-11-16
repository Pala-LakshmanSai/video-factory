# Style: `pov`

POV Escalation ("What if you ___ and couldn't stop?"). A first-person ride through a flat-shaded low-poly 3D world at golden hour (three.js, software WebGL), a stat HUD top-left (Inter small-caps label, big Newsreader number), an optional second counter top-right, and one italic Newsreader caption at the bottom. The whole video should feel like one escalating journey: street → city → highway → fields → desert/mountains → sky → orbit → space.

**Use it for:** escalation hypotheticals, "how fast / how far / how big" journeys, scale tours where a number keeps growing.
**Don't use it for:** lists, quotes, talking-head explainers (use `explainer` / `documentary`).

## Plan rules

- `style: "pov"`, `fps: 30` (24 is fine for long videos: rendering is software WebGL, ~0.3 s per frame per worker), `resolution: "1920x1080"`. `1080x1920` renders (HUD keeps its 16:9 size at the top) but 16:9 is the designed format.
- `scenes[].n` 1..N, total ≤ 3 minutes. `transition`: use `cut` almost always (the journey is meant to be continuous; consecutive scenes in the next biome read as one ride). `fade` for a time jump. Avoid `slide`.
- `narration` = the exact voiceover words of the scene. `duration_s` ≈ words / 2.4, **3–10 s**.
- Audio: exactly one track. A score must be pre-mixed into the job's Drive audio; the style makes no sound.
- Every number on screen must be true (physics or a sourced fact). Never invent records.

## Shared props (all three templates)

| prop | type | default | notes |
|---|---|---|---|
| `biome` | `suburb` `city` `highway` `fields` `desert` `mountains` `sky` `orbit` `space` | `city` | the world around you. Escalate through them in this order. |
| `speed` | `[from, to]` km/h | per biome (e.g. city 40→110, highway 120→400, orbit 28,000→40,000) | drives motion, blur and FOV; grows exponentially across the scene. Continue from the previous scene's `to`. |
| `rig` | `bike` `run` | none | first-person view model (handlebars / arms). Keep it the same across a video while on the ground. |
| `camera` | `forward` `look-back` `look-down` `look-up` `rise` | `forward` | a move inside the scene. `look-back` in `orbit` shows the Earth behind you. |
| `hud` | `"speed"`, `false`, or `{ label, value \| from,to, unit, sub, next:{ name, value } }` | `"speed"` | top-left stat. `from`/`to` numbers count up across the scene (log scale when they differ 10×+). `sub` = what you just beat (≤ 5 words, caps). `next.value` is a string like `"4.2 km"`. |
| `counter` | `{ label, value \| from,to, sub }` | none | top-right consequence counter. Only when there is a consequence to count. |
| `caption` | string | none | ONE italic line, second person, present tense, **≤ 9 words**. Auto-shrinks if long. |
| `upright` | bool | false | caption upright instead of italic (cold open). |
| `traffic` | bool | true | cars on suburb/city/highway. |
| `seed` | int | 0 | shifts where on the route you are (different buildings). |
| `motionBlur` | bool | false | sub-frame motion blur, ~up to 6× slower render. Only for short hero moments. |

## Templates

### `journey` — the workhorse
Shared props only. Use for nearly every scene.

### `title` — title over the moving world
| prop | required | notes |
|---|---|---|
| `title` | **yes** | string or 1–3 lines (array), e.g. `["What if your bike", "couldn't stop speeding up?"]`. |
Usually with `hud: false`. Open with it (optionally after a 4–5 s `journey` cold open with `upright: true`).

### `end-card` — the ending
| prop | notes |
|---|---|
| `ending` | `whiteout` (default): the light fills the frame cream, then a hard cut to black at ~86% of the scene. `card`: dark card with `lines` (≤ 4) and `small` (≤ 3). |
Best with `biome: "space"`. Captions fade with the light.

## Example
`renderer/styles/pov/example-plan.json` (5 scenes, ~20 s).
