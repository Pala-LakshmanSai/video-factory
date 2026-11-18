# Reusable prompt: create a new video style

Paste into Claude Code opened in the Video Factory repo. Fill in the three lines at the top. When the new style
exists, run docs/prompts/STYLE_REFINEMENT.md on it to tune it against the reference channel.

```
Create a new Video Factory style.

STYLE NAME: <short id, lowercase-with-dashes, e.g. money-noir>
WHAT IT SHOULD LOOK LIKE: <one paragraph: genre, mood, what's on screen, who it's for>
REFERENCES: <YouTube channel URL and/or video URLs and/or a kit file in style-kits/, or "none">

Work on your own from start to finish; ask me only before anything that costs money (cloud GPU renders, image
qualification) or needs a sign-in. Never reduce render parallelism.

0. Ground yourself. Run `scripts/vf pull`, then read: CLAUDE.md, docs/SYNC.md, the live preferences
   (`scripts/vf prefs`; global ones apply to this style too), renderer/styles/README.md (template contract),
   packages/contract/src/styles.ts (registry), docs/KIT_WORKFLOW.md, and one finished style end to end as the model
   for quality and structure: renderer/styles/flatglow/ + docs/styles/flatglow.md + renderer/test/style-flatglow.test.ts.

1. Study the references. If a channel or videos are given:
   `node renderer/tools/lab.ts refs <channel-url> --top 5 --first 600` (or pass each video URL's channel), then look
   at their frames: `node renderer/tools/lab.ts compare --sample <any ref mp4> --refs <refs dir>` makes frame sheets
   (side-by-side.jpg, hooks-first-12s.jpg) and pacing/colour/loudness numbers; read the captions for script voice.
   Use the youtube-video-style-analyze skill too if it is available. Write the style bible to
   style-kits/_styles/<id>/STYLE-BIBLE.md (synced): palette (hex), typography, layout grid and safe areas,
   characters/props and how they are drawn, camera and motion grammar, transitions, pacing (seconds per shot,
   words per minute), on-screen text rules, sound (music, effects, loudness), hook and story structure, and what
   makes it recognisable in one frame. Learn the grammar only: never copy their characters, logos, art, music,
   scripts or exact frames.

2. Choose the build type and say why in one line:
   - Registry style (default): fixed templates rendered by the factory (cloud GPU or locally). Right for most looks.
   - Kit/skill style: per-video drawn art and code (like paper-style); only when every video needs its own cast,
     sets or heavy custom animation. Build it as a skill in ~/.claude/skills/<id>/ (SKILL.md + scripts + style
     assets, modelled on ~/.claude/skills/paper-style) and run `scripts/vf track <id> ~/.claude/skills/<id>`
     so every machine gets it.

3. Build (registry style):
   - renderer/styles/<id>/: tokens.json, one HTML file per template (4-7 templates that cover title, main visual
     scene, kinetic/quote text, list or diagram, end card, plus whatever the look needs), shared runtime in a kit.js,
     fonts as OFL files in fonts/ with licences. Follow the template contract exactly: deterministic
     window.__seek(t), no network, text auto-fits, 16:9 and 9:16.
   - The owner's layout rule is a hard requirement: no overlapping texts/graphics, everything inside the safe
     area, 4.5:1 text contrast with plates on busy backgrounds.
   - renderer/styles/<id>/example-plan.json (one scene per template, 15-25 s) and docs/styles/<id>.md in the same
     format as docs/styles/flatglow.md (use it for, don't use it for, plan rules, pacing, every template's props).
   - Register it in packages/contract/src/styles.ts with status "pending" and a one-line summary.
   - renderer/test/style-<id>.test.ts mirroring the flatglow test; run `cd renderer && node --test test/style-<id>.test.ts`
     until it passes, and the control-plane tests (`cd control-plane && npx vitest run`).

4. Make a real sample: write a 60-90 s script on a topic typical for this style, turn it into a plan from the new
   doc, render it with `node renderer/tools/lab.ts sample <plan.json> --out style-kits/_styles/<id>/samples/v1`,
   and check every scene's frames yourself (Read the sheet and a few full frames): layout rule, legibility, on-style.
   Fix and re-render until it is clean. If references exist, run lab.ts compare against them and fix the biggest
   gaps (at least one improvement round).

5. Finish:
   - Save lasting rules you established as preferences: `scripts/vf pref add <id> "<rule>"`.
   - Commit everything in git with a clear message and push to main (CI tests the renderer and publishes the doc
     to claude.ai). Do not flip the style to "ready", dispatch qualify-image or deploy a new renderer image
     without asking me: that rents a GPU. Tell me the exact step to approve.
   - Send me the sample video and its frame sheet, and a short report: build type, templates, what it matches
     in the references, what is still different, and what approval (if any) is needed to make it orderable from
     claude.ai.
```
