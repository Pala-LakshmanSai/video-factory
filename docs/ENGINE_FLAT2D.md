# flat2d — shared scene engine for the flat 2D kits

One engine for the **stickman**, **gta** and **kurg** (Kurzgesagt-like) kits. (citygrow is a 3D WebGL timelapse and belongs to the 3D family.) A kit adds only its
*look*. Each video designs its own cast, props and sets **as data**, and the AI writes a short scene spec per
scene instead of hundreds of lines of drawing code. The engine holds drawing basics only, never ready-made
scenes, so it is not a template system (see "Guards").

Lives in `engines/flat2d/` (committed). Kits stay in `style-kits/` (gitignored, on the Mac) and are read at
authoring time; nothing from a kit becomes a registry template.

## Files

```
engines/flat2d/
  engine.js          interpreter: scene spec -> Canvas 2D frame; window.FLAT2D
  rig.js             stick-figure rig: appearance spec, poses, gestures, walk, faces, holding
  shapes.js          shape-spec renderer (data-drawn props, sets, accessories)
  ui.js              text, labels, pills, boards, counters, maps, arrows, webs, quote cards
  scene.html         the ONE template every scene uses ("template": "scene")
  looks/<kit>.json   look tokens per kit (palette, line weight, rig proportions, fonts, letterbox, finish, motion)
  looks/<kit>.js     optional look-only drawing extras (e.g. kurg glow, citygrow buildings); no scenes
  fonts/             OFL fonts + licences
  tools/build-package.mjs   video.json + scenes -> package dir + scene_plan.json (style "custom")
  tools/validate.mjs        schema + reference checks (ids exist, times inside scene, safe area by estimate)
  tools/qa.mjs              automatic QA: renders sample frames locally, reads window.__qa, reports problems
  tools/repeat-check.mjs    uniqueness guard against earlier videos (history in style-kits/_history/)
  examples/<kit>/           a small example video per kit (video.json + scenes.json) used by tests
```

## Per-video input

### video.json
```json
{
  "id": "gta6-story-recap",
  "look": "gta",
  "size": [1920, 1080], "fps": 30,
  "cast":   { "jason": { ActorSpec }, "lucia": { ActorSpec } },
  "props":  { "boatyard-sign": { ShapeSpec }, "radio": { ShapeSpec } },
  "sets":   { "keys-dock": { SetSpec }, "prison-gate": { SetSpec } },
  "images": { "cover": "data:image/jpeg;base64,..." },
  "notes":  "why this cast/sets look the way they do (for the repeat check report)"
}
```
Cast, props and sets are designed fresh for each video (Guard 1).

### scenes.json
`[{ "n": 1, "start": 0.0, "duration": 3.4, "narration": "...", "spec": SceneSpec }, ...]`
`build-package.mjs` turns this into `scene_plan.json` (`style: "custom"`, every scene `template: "scene"`,
`props: { video: <inlined subset>, spec }`) and copies the engine, the look and fonts into the package.
Times inside a SceneSpec are **seconds from scene start**.

## ActorSpec (a character designed as data)
```json
{
  "build": { "height": 1.0, "width": 1.0, "head": 1.0, "headShape": "round|oval|square|egg" },
  "ink": "#16161a",
  "top":    { "kind": "tee|hoodie|jacket|suit|hawaii|open|vest|dress|lab|none", "color": "#f4f4f0", "dark": "#cfd1cb", "pattern": "none|stripes|dots|flowers|camo" },
  "bottom": { "kind": "trousers|shorts|skirt", "color": "#4a5f86" },
  "shoes":  { "color": "#5a4636" },
  "hair":   { "style": "none|short|slick|ponytail|bun|long|curly|afro|white|bald|braids", "color": "#111" },
  "hat":    { "kind": "none|cap|capBack|beanie|fedora|homburg|headband|crown", "color": "#3c4458" },
  "acc":    ["glasses", "sunglasses", "chain", "headset", "headphones", "bandana", "beard", "mustache", "watch", "badge"],
  "extra":  [{ "anchor": "head|neck|chest|hip|handL|handR", "shape": ShapeSpec }],
  "face":   { "eyes": "dot|wide|happy|sleepy|angry|smug", "mouth": "flat|smile|grin|o|frown|smirk", "brows": "none|up|down|worried" }
}
```
Every field is optional with look defaults. `extra` lets a video draw anything the list lacks (a scar, a
pendant, a parrot on a shoulder) as data. Unknown `acc` values are a validation error, never silently dropped.

## ShapeSpec (props, sets, accessories, icons drawn as data)
A list of primitives, drawn in order inside a local box (`"box": [w, h]`, origin top-left, units px):
```json
{ "box": [220, 140], "parts": [
  { "rect": [0, 20, 220, 120], "r": 12, "fill": "@navy", "stroke": "@ink", "lw": 6 },
  { "circle": [40, 80, 22], "fill": "@coral" },
  { "ellipse": [110, 80, 40, 20], "fill": "#fff" },
  { "path": "M10 10 L200 10 Q210 60 200 120 Z", "fill": "@gold" },
  { "poly": [[0,0],[30,40],[60,0]], "stroke": "@ink", "lw": 5, "close": false },
  { "line": [0, 0, 220, 0], "stroke": "@ink", "lw": 6 },
  { "text": "BRIAN'S", "at": [110, 70], "size": 34, "weight": 800, "fill": "@white", "align": "center" },
  { "image": "cover", "at": [0, 0, 220, 140] },
  { "group": [ ...parts ], "at": [x, y], "rot": 0, "scale": 1 }
]}
```
Colours: hex, or `@token` from the look palette. `lw` defaults to the look's line weight.
`anim` on any part: `{ "rot": [[t,v,ease],...], "opacity": ..., "dx": ..., "dy": ..., "scale": ... }` for
blinking lights, spinning wheels, etc.

## SetSpec (a background/stage)
```json
{ "sky": ["#7fb2e0", "#f6d3ac"], "ground": { "y": 880, "color": "#c98f6a" },
  "layers": [ { "shape": ShapeSpec, "at": [x, y], "scale": 1, "depth": 0.3 } ],
  "light": { "rim": "warm|cool|none", "vignette": 0.5 },
  "board": false }
```
`board: true` makes the look's diagram board (navy board, grid, etc.). `depth` 0..1 drives parallax with the
camera (0 = far, 1 = with the actors).

## SceneSpec
```json
{
  "set": "keys-dock",
  "camera": [[0, {"x": 960, "y": 540, "zoom": 1}], [3.2, {"zoom": 1.15, "x": 1040}, "ioC"]],
  "shake": [[2.1, 0.4, 8]],
  "items": [ Item, ... ],
  "fx": [ { "t": 1.2, "kind": "flash|whoosh-lines|confetti|dust|rain|stars|smoke|sparkle", "at": [x,y], "dur": 0.6 } ]
}
```

### Item (common fields)
`id`, `type`, `at: [x, y]`, `scale`, `rot`, `z`, `depth` (parallax, default 1),
`enter: { "t": 0.4, "how": "pop|fade|slide-l|slide-r|slide-u|slide-d|draw|wipe|type|grow", "dur": 0.4 }`,
`exit: { "t": 3.0, "how": ..., "dur": 0.3 }`,
`anim: { "x": [[t, v, ease]...], "y": ..., "scale": ..., "rot": ..., "opacity": ... }` (keyframes override `at`).

### Item types
| type | extra fields |
|---|---|
| `actor` | `cast` (id), `face` (dir -1/1), `do`: action timeline (below), `say`: `[[t0, t1]]` mouth flaps |
| `prop` | `prop` (id from video.json) or inline `shape` |
| `image` | `image` (id), `fit: cover|contain`, `frame: none|polaroid|tv|phone|board`, `kenburns: [z0, z1]` |
| `text` | `str`, `size`, `weight`, `fill`, `align`, `maxW`, `hi` (words to colour accent) |
| `label` | `str`, short uppercase tag with the look's label style; `point: [x, y]` draws a leader line |
| `pill` | `str`, `color` |
| `tag` | `str` (e.g. THEORY), stamp style |
| `board` | `w`, `h`, `title`, `items`: nested Items laid out inside |
| `counter` | `from`, `to`, `t0`, `t1`, `prefix`, `suffix`, `decimals`; always ends exactly on `to` |
| `quote` | `str`, `by`; typewriter card |
| `card` | character card: `cast`, `name`, `role` |
| `map` | `outline` (ShapeSpec path or built-in `florida`), `pins: [{at, label}]`, `routes: [{pts, t0, t1}]` |
| `arrow` | `from`, `to`, `t0`, `t1`, `curve` |
| `web` | `nodes: [{id, at, cast|label}]`, `links: [[a, b, t]]` relationship web drawing on in order |
| `chart` | `kind: bar|line|pie`, `data`, `t0`, `t1` |
| `split` | `left` / `right`: nested SceneSpecs drawn side by side |
| `custom` | `fn` (name in the package's `custom.js`), `params` — the escape hatch (Guard 2) |

### Actor action timeline (`do`)
`[[t, action, args], ...]`, actions blend over ~0.2 s:
`stand`, `walk {to, dur}`, `run {to, dur}`, `pose {name}` with names
`point|wave|cheer|shrug|think|facepalm|cross-arms|hands-hips|sit|lie|crouch|fight|punch|kick|fall|jump|celebrate|phone|drink|type|carry|hands-up|hug|sneak|talk`,
`face {eyes, mouth, brows}`, `look {dir}`, `hold {prop, hand}`, `drop {hand}`, `joints {la, ra, ll, rl, lean}`
(raw joint angles for anything not named).

## Determinism and contract
`scene.html` follows `renderer/styles/README.md`: reads `window.__scene.props`, defines a synchronous pure
`window.__seek(t)`, `window.__ready = document.fonts.ready`, no network, `data:` images only, seeded randomness
only (`rng(seed)` from item id). Output for the same plan is byte-identical.

### QA hook
After each `__seek`, the engine fills `window.__qa = { texts: [{str, box:[x,y,w,h], size}], items: [{id, type, box}], blank: bool }`.
`tools/qa.mjs` reads it to flag: text outside the safe area or the letterbox, text boxes overlapping each other,
text under 28 px at 1080p, actors cut by the frame edge (unless entering/exiting), frames that are blank or flat,
items whose ids are unknown, counters not landing on `to` at `t1`.

## Guards (owner's uniqueness rule, docs/KIT_WORKFLOW.md)
1. **Design pass first.** Before any scene, the AI writes `video.json` cast/props/sets for this topic.
   The engine ships no named characters and no ready sets; looks give only defaults (line weight, colours).
2. **Escape hatch.** A scene the language cannot express uses a `custom` item with hand-written code in the
   package's `custom.js`; `FLAT2D.custom[fn] = (ctx, t, params, api) => {}` where `api` exposes the engine's
   primitives (rig, shapes, ui, ease, rng). Only that scene costs code-writing time.
3. **Library grows.** A prop or move worth keeping is promoted into the look's `looks/<kit>.js` extras or a
   new named pose in `rig.js`, by explicit commit, never automatically.
4. **Repeat check.** `tools/repeat-check.mjs video.json` fingerprints the cast (outfit kinds + colours + hair +
   hat + accessories), props and sets (primitive structure + palette) and compares them with
   `style-kits/_history/*.json`; anything closer than the threshold is reported by name and blocks packing
   unless `--allow <id>` (series parts keep their cast on purpose). After a render it appends the video.
5. **Automatic QA** (`tools/qa.mjs`) replaces looking at every still: one contact sheet + the RunPod preview
   are the only visual checks.

## Authoring speed target
About 15 lines of SceneSpec per scene. A 30-minute video (~320 scenes) is written by 12–16 parallel
subagents of ~20 scenes each, all reading the same `video.json`.

## Look-level extensions (added with the stickman and kurg looks)
- `look.rig.body`: body style drawn by `FLAT2D.extras.body[name]` (kurg: `"blob"`, rounded people); same ActorSpec and pose names.
- `look.rig.NECK`, `look.rig.FACE {scale, dy}`, `palette.eye`; shoe colour `"none"` ends limbs in round caps.
- Hooks a look's `looks/<kit>.js` may set: `FLAT2D.extras.tops[kind]`, `.rim`, `.pill`, `.number`, `.paint` (part `glow`/`shade`), `.setBack`, `.finish`.
- ShapeSpec parts: `glow`, `shade` (two-tone). SetSpec: `stars`, `bokeh`, `glows`, `motes`; layers take `blur` and may reference a prop by id (`{"prop": "id", "at": [...]}`).
- `look.motion.push` (slow push-in on every camera), `look.text.glowColor`, `look.board.outline`, `tokens.letterbox` (0 = none).
- Actors may face front: `face: 0`, `look {dir: 0}`. Rotations are in degrees. A prop's `at` is its bottom-centre.

## Footage (open)
Packages are capped at 8 MiB and render time has no network, so trailer/gameplay *video* inserts (gta kit)
cannot ride in a package yet. Stills work as `images`. Video inserts need a media channel (upload clips with
the job, renderer exposes them as local files) — a separate change.
