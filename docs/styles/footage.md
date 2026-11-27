# Style: `footage`

Not a look of its own: it renders a **skill style** (doomsday, gta, aviation, paper-style) on a RunPod GPU pod by
running that skill's own render script over a footage bundle. The look, rules and owner preferences are the skill's
(`style_guide {style: "doomsday"}` etc. and the skill's SKILL.md). One job per video at any length; local render is
the fallback.

## Plan rules

- Never write this plan by hand: `node scripts/vf.mjs footage <edit.json>` (doomsday) or
  `node scripts/vf.mjs footage --dir <folder> --cmd '<argv json>' --out <mp4> --skill <id>` (others) uploads the
  bundle and writes the scene_plan. Steps: docs/KIT_WORKFLOW.md "Footage styles on RunPod".
- `acquire_gpu {style: "footage", voiceover: {none: true}}`: the sound is in the bundle.
- One scene, `template: "bundle"`, `props: {bundle, skill}`, `duration_s` = the video's length, `transition: "cut"`.
- Previews are 12 frames of the finished render. To fix something, change the edit locally, run `vf footage` again
  and `revise_scene {scene: 1, patch: {props: {bundle: "<new sha>"}}}`.
