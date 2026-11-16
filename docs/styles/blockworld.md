# Style: `blockworld`

Blocky low-poly 3D "What If You Kept Getting ___ and Couldn't Stop?" episodes: pastel blocky characters and
sets (streets, cities, rooms, plazas with instanced crowds), cinematic camera moves, a HUD (gold/red counters
top-left, "YOU ARE <status>" top-right), Libre Caslon italic captions, Inter cards/bubbles/chips, FX (hearts,
confetti, money rain, fireworks, smoke). Rendered with three.js (WebGL; SwiftShader on CPU). 16:9 `1920x1080`.

**Status: pending** — visuals complete (Linux WebGL fixtures pass). Audio candidate: the pod generates the
kit's caption-led score from the episode for every preview/final (below). Before `ready`: bake the samples
tarball into a qualified image, render end to end there, owner/reviewer approval.

**Use it for:** escalating hypothetical "what if" stories with a running counter. **Don't use it for:**
text-heavy explainers, quotes, lists (use `explainer`).

## Plan rules

- `style: "blockworld"`, `fps: 30`, `resolution: "1920x1080"`.
- One template: **`episode`**. Write ONE episode object (below), then emit one plan scene per episode scene:
  plan scene `n` plays `episode.scenes[n-1]`. Plan and episode must have the same number of scenes.
- Every plan scene has `props: {"episode": <the same whole episode object>}`. Do not set `from`.
- `duration_s` of plan scene `n` = `episode.scenes[n-1].dur` exactly (enforced). The episode is caption-led: its
  timing comes from `dur`, never from a voice. The score is exactly sum(`dur`), so the engine's rescale is the identity.
- `narration` = the caption words for that scene (not spoken). If an episode scene has no `captions`/`caption`,
  the narration is shown as its caption.
- `transition`: always `cut` — scene transitions (`dip`, `flash`, `rewind`, `fade_in`) belong in the episode scene.
- A missing or malformed `episode` (no scenes, a scene without positive `dur`) fails the render — it is not a placeholder.
- Optional `props.quality`: `final` (default: shadows, MSAA) or `draft` (no shadows, ~25% faster). Keep `final`.
- Counters and status carry over between scenes, which is why every scene gets the whole episode.

## Pacing

2.6 words/s; scenes 2.5–6 s (typical 3.5–5 s). One beat per scene, change camera/set often.
Keep crowds ≤ 600 actors per scene on CPU render pods (2,600 is possible but slow).

## Writing the episode prop

Declarative JSON only: no code, no URLs, no file paths. The visual template ignores the audio fields (`music`,
`sfx`, `ambience`, `hit`, `musicKey`, `musicSeed`, `audio`); the pod's scorer reads them (see **Audio**). Coordinates are metres, y up, ground y=0; an actor with `rot: 0` faces +z (toward a camera at +z).
See `renderer/styles/blockworld/example-plan.json` for a complete working example.

```jsonc
{
  "meta": {"title": "What If You Kept Getting Taller and Couldn't Stop?", "width": 1920, "height": 1080, "fps": 30,
           "quality": "high",            // "draft" = no shadows (faster previews)
           "fadeOut": true, "voiceover": null},   // must stay null: no narrator
  "hud": {
    "counters": [                         // drawn top-left, in this order
      {"id": "height", "label": "Your height", "color": "gold", "format": "height", "start": 175},
      {"id": "broken", "label": "Things you've broken", "color": "red", "size": 46, "start": 0}
    ],
    "status": {"label": "You are"}        // or {"label": "You could buy", "style": "serif"}
  },
  "audio": {"gap": 0.38, "musicGain": 1.0, "sfxGain": 1.0, "auto": true},
  "scenes": [ /* see below */ ]
}
```

Counter `format`: `int` (commas) · `money` ($, words above a billion) · `words` · `times` (×1,000) ·
`power` (×10ⁿ superscript) · `percent` · `score` (8.5/10) · `iq` · `km` · `height` (cm → 5′9″ → m → km) ·
`years_ago`. Optional `prefix`, `suffix`, `zeroColor` (default white at 0; `false` keeps the colour).

## Scene

```jsonc
{
  "id": "day1", "dur": 4.2,                       // 2.5–6 s typical
  "set": "street", "time": "day",                  // see SKILL.md index
  "setOptions": {"cafe": true, "houses": 7, "background": true},   // set-specific
  "fogNear": 30, "fogFar": 140, "sky": ["#7fb3e0", "#e9eef0"], "fill": 0.45,
  "transition": "dip",                             // cut | dip | rewind | flash | fade_in
  "grade": null,                                   // desat | warm | cold | rewind
  "music": "bright", "hit": true,                  // starts a chapter bed (see 04)

  "actors": [{
    "id": "you", "look": "hero", "pos": [0, 0, 1.6], "rot": 0, "scale": 1,
    "pose": "idle", "expression": "smile", "halo": false, "crown": false, "beard": false, "glasses": false,
    "poses": [{"t": 1.6, "pose": "shrug", "expression": "worried"}],          // timed changes
    "move": {"to": [3, 0, 1.6], "path": [[1,0,1.6],[3,0,2]], "t0": 0, "t1": 3, "pose": "walk", "ease": "linear"},
    "turn": {"t": 2, "rot": 1.57, "d": 0.4},
    "grow": {"from": 1, "to": 3, "t0": 0, "t1": 4, "ease": "inout"}
  }],
  "props": [{"type": "car", "pos": [2, 0, 6], "rot": 3.14, "scale": 1,
             "move": {"to": [2, 0, -6], "t0": 0, "t1": 4}, "pop": 0.8, "from": 0, "to": 3,
             "grow": {"t0": 0.4, "t1": 1.6}, "spin": 0.5}],      // + prop-specific options (w, h, text, color…)
  "crowd": {"count": 600, "area": [20, 10], "center": [0, 0, 4], "mood": "cheer", "faceTarget": "you",
            "rows": null, "spacing": 0.9, "seed": 3},           // may be an array of crowds
  "fx": {"money_rain": {}, "hearts": {}, "confetti": {}, "snow": {}, "rain": {}},   // each takes count/area
  "lights": [{"pos": [0, 3, 0], "color": "#ffd9a8", "intensity": 30, "distance": 12}],

  "camera": {"preset": "push", "target": "you", "dist": 6, "height": 1.8, "angle": 10, "push": 0.12,
             "sweep": 0, "toHeight": null, "targetHeight": 1.4, "fov": 40, "shake": 0, "ease": "inout"},
  // or explicit keyframes:  "camera": {"from": {"pos": [..], "look": [..], "fov": 40}, "to": {...}, "t0": 0, "t1": 4}

  "split": [ {scene-like half: set/time/actors/props/camera}, {…} ],    // optional side-by-side comparison

  "hud": {
    "counters": {"height": 185,                                 // animate from previous value to 185
                 "broken": {"from": 0, "to": 48912, "curve": "exp", "t0": 0.2, "t1": 3.5},
                 "x": {"set": 31000000}},                       // jump: hold this value for the scene
    "status": {"value": "TALL", "tone": "neutral", "sub": "Day 1"},  // tone: neutral | good | bad
    "hidden": false
  },
  "captions": [{"t": 0.2, "d": 3.8, "text": "Day 1. Four inches overnight. People notice."}],
  // or "caption": "text" (spans the scene)
  "cards": [{"type": "bubble", "anchor": "n", "t": 0.6, "d": 2.6, "text": "Did you… grow?"}],
  "sfx": [{"t": 1.5, "name": "thud", "gain": 0.9}],
  "ambience": [{"name": "rain", "gain": 0.4}]
}
```

Counter curves: `out` (default), `linear`, `inout`, `in`, `exp` (geometric — use for huge ranges), `step`.
Counters and status carry over between scenes; only state what changes.

## Cards (all take `t`, `d`; most take `pos: [x, y]` in 1920×1080 space; anchored ones take `anchor`
(actor id) and `anchorY` (metres above the actor's feet, × its scale))

| type | fields |
|---|---|
| bubble | `text`, `anchor`, `size` |
| pill | `text`, `anchor` (use `anchorY: -0.15` to sit at the feet), `color` teal/dark/red/gold/white/green/blue |
| chip | `text` ("Florida · 2014"), `color` dark/red/gold/teal/white, `pos` (default top-centre) |
| phone_call | `name`, `initial`, `status`, `declineAt` (s) or `declined`, `avatar` colour |
| receipt | `title`, `items: [["Coffee","$4.00"]]`, `subtotal`, `tip`, `tipAt`, `total` |
| stat | `label`, `value` or `from`/`to`/`format`/`countDur`, `sub`, `theme` light/dark, `size`, `color` |
| clock | `time`, `sub` |
| bars | `rows: [{"label":"YOU","value":88,"color":"teal"}]`, `max`, `unit` |
| leaderboard | `title`, `rows: [{"name":"YOU","value":"$1.06 trillion","highlight":true}]` |
| notification | `header`, `text`, `sub`, `color` red/teal |
| list_stamp | `items: ["Free bread", …]`, `stampTimes: [0.6, 1.0, 1.4]` |
| schedule | `title`, `days`, `rows`, `cell`, `fillDur` |
| title | `text`, `serif`, `size`, `color` |
| big_number | `label`, `from`, `to`, `format`, `countDur`, `color` |
| arrow_label | `text`, `anchor`, `dx`, `dy` |
| image_text | `title`, `lines: [...]`, `dark`, `w` |

## Set options
- `street`: `cafe`, `houses`, `background`, `snow`; lamps light up at `time: night`.
- `city`: buildings both sides of a road along z (road x∈[-5,5], buildings at |x|≈11).
- `room`: `w`, `d`, `floor`, `wall`, `furniture: ["table","chair","bed","fridge","counter"]`.
- `office`: `rows`, `cols` of desks. `plaza`: palace + crowd (`crowd`, `crowdCount`, `mood`, `dome`).
- `studio`: `dark`, `floor`. `field`: `track`, `stadium`, `trees`. `vault`: money pile room.
- `space`: stars (add `globe`, `moon`, `black_hole` props). `desert`, `underground`, `void`.

## Audio (caption-led score, no narrator)

The original kit has no voiceover: a produced chapter score on recorded instruments, a boom on each chapter
hit, SFX on cards/status changes, ambience beds, mastered to −15.4 LUFS / −1.2 dBTP. We keep that.

- **acquire_gpu** with `voiceover: {"none": true}` (allowed only for `episode-score` styles). Timing comes from
  each scene's `dur`; nothing is retimed. A narrator only if explicitly asked: pass `text` or `drive_file_id`;
  it is mixed under the score from t=0 (kit ducking) and never changes the episode length.
- Write `music` (mood: `whimsical normal_life tension threat wonder cold_open heartwarm melancholy …`, aliases
  `bright curious tense ominous cosmic epic warm sad mystery happy`, or `silence`) and `hit: true` on each
  chapter's first scene; `sfx` / `ambience` by bundled name only (`boom impact sparkle levelup … wind rain birds`).
  Cards and status changes add SFX automatically (`audio.auto`, default on). No `file` keys anywhere.
- **Same episode everywhere.** submit/revise reject a plan whose scenes carry different episodes or whose
  `duration_s` ≠ `dur`. `revise_scene` with a `props.episode` patch (RFC 7386: arrays such as `scenes` are
  replaced whole) applies it to **every** scene in one write, resyncs every `duration_s`, and re-previews all scenes.
- **Score bound to the episode.** The pod (`renderer/agent/score.ts`) keys each score by the sha256 of the
  episode: it starts scoring when a preview round starts (previews time against the episode length, which the
  score matches exactly), and the final awaits the score for the *current* episode and refuses to mux one whose
  sha or length (±1 frame) differs. A revise changes the sha, so an older score can never be muxed.

**Why on the pod.** The control plane is a Cloudflare Worker (no numpy/scipy/ffmpeg), so a control-plane step
would need a new service; a manual Drive upload breaks the Project chat flow. Cost of the pod route:
- image ≈ +230 MB (python3 ≈ 25 MB, numpy 2.2.6 ≈ 40 MB, scipy 1.15.3 ≈ 100 MB, samples 63 MB tarball / 69 MB
  unpacked) — estimate, not yet measured on a built image;
- ≈ 1 s of CPU per second of audio on a Mac (5 s episode in ~5 s; reviewer measured 21 s in a sandbox). Scoring
  runs in parallel with preview frames, so it only adds wall time to the final when it is the slower of the two;
- deterministic per image: fixed seeds + `PYTHONHASHSEED=0` give byte-identical WAVs for the same episode
  (pinned numpy/scipy; a different library version may change bits, not length or loudness).

**Fencing** (`renderer/audio/blockworld/score.py`): rebuilds a minimal episode with only the fields `audio.py`
reads, names checked against the kit's own `SFX_NAMES`/`CUES`/`ALIASES`, numbers bounded (scene ≤ 60 s, episode
≤ 900 s, ≤ 400 scenes, ≤ 32 events per list, gains ≤ 2); `file` entries and `meta.voiceover` are rejected before
Python touches audio or ffmpeg runs. The voice path is the pod's own file, never from the plan.
`renderer/audio/blockworld/scripts/` is an unmodified copy of the kit's `audio.py`, `cues.py`, `audio_lib.py`,
`cue_eq.json`. Operators can still run `python3 renderer/audio/blockworld/score.py plan.json out.wav`.

**Samples in the image.** The tarball of the kit's `assets/samples` (built deterministically: sorted, mtime 0)
is the private repo's release asset `blockworld-samples-v1`. CI (`renderer.yml`, image job) downloads it with the
repository token, checks it against the committed `renderer/audio/blockworld/samples.sha256`, and the Dockerfile
checks it again before extracting; a missing or different archive fails the build. The image smoke test scores the
reviewer baseline offline (exactly 5.000 s, byte-identical twice). Local build:
`gh release download blockworld-samples-v1 -O renderer/audio/blockworld/samples.tar.gz`. Local dev: symlink
`renderer/audio/blockworld/assets/samples` to the kit's samples (gitignored).

**Tests:** `python3 renderer/audio/blockworld/test_score.py` (length, −15.4 LUFS, determinism, hostile inputs,
explicit voice keeps length); `renderer/test/score.test.ts` (re-score on timing revise, preview/final length =
episode, stale score refused; set `BLOCKWORLD_PYTHON` for the real-scorer case); `control-plane/test/blockworld-revise.test.ts`.

**Sample credits** (`renderer/audio/blockworld/CREDITS.txt`; keep with any redistribution):
Salamander Grand Piano by Alexander Holm, CC BY 3.0 · FluidR3_GM by Frank Wen, CC BY 3.0 (per-note renders
from gleitz/midi-js-soundfonts, MIT) · VSCO 2 Community Edition by Versilian Studios, CC0 1.0.
