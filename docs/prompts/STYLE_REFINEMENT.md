# Reusable prompt: refine a style against a YouTube channel (sample → compare → improve, in rounds)

Paste into Claude Code opened in the Video Factory repo. Fill in the lines at the top. It downloads the
channel's most popular videos, makes a sample in our style, compares it with those videos, fixes the gaps, makes
a new sample, compares again, and repeats until the style matches or the rounds run out.

```
Refine one of our video styles against a reference channel, in rounds, until our samples hold up next to the
channel's most popular videos.

STYLE: <style id, e.g. flatglow, stickman, paper-style, gta, aviation>
CHANNEL: <YouTube channel URL, e.g. https://www.youtube.com/@kurzgesagt>
ROUNDS: <max rounds, default 4>
SAMPLE TOPIC: <optional; otherwise pick one typical for the channel>

Work on your own through every round; ask me only before anything that costs money (cloud GPU renders, renderer
image qualification) or needs a sign-in. Render samples on this machine at full parallelism; never lower the
renderer's worker count or resolution to save time.

SETUP
1. `scripts/vf pull`. Read CLAUDE.md, the live preferences (`scripts/vf prefs`: global + this style), the style's
   doc (docs/styles/<style>.md) and its code (renderer/styles/<style>/, or for skill styles
   ~/.claude/skills/<style>/ with its SKILL.md and style/ folder, or for flat2d looks engines/flat2d/).
   Make a log folder style-kits/_refine/<style>/<YYYY-MM-DD>/ (it syncs to every machine).
2. References: `node renderer/tools/lab.ts refs <CHANNEL> --top 5 --first 600` (most-viewed long videos, first
   10 minutes each, with captions; add --shorts for a Shorts channel). Study them properly:
   - frame sheets and numbers: `node renderer/tools/lab.ts compare --sample <one ref mp4> --refs <refs dir> --out <log>/refs-study`;
     Read side-by-side.jpg and hooks-first-12s.jpg, and pull extra full-size frames at moments that matter
     (`ffmpeg -ss <t> -i <mp4> -frames:v 1 <png>`), especially the first 30 seconds;
   - the captions (script voice, hook lines, sentence length, how facts and numbers are said);
   - the youtube-video-style-analyze skill for a deeper breakdown if it is available.
   Write <log>/reference-notes.md: what the channel's popular videos do in each dimension of the rubric below, with
   concrete, checkable rules (hex colours, seconds per shot, words per minute, text sizes and positions, how
   characters are drawn, camera moves, transition types, music/effects/loudness, hook structure in the first
   15 s, retention devices). Learn the grammar only: never copy their characters, logos, art, music, scripts or
   exact frames, and keep the owner's uniqueness and layout rules.
3. Write an original 60-90 s script on SAMPLE TOPIC in the channel's voice, and turn it into a sample in our style:
   - registry style: a scene plan per docs/styles/<style>.md, rendered with
     `node renderer/tools/lab.ts sample <plan.json> --out <log>/round-0`;
   - skill style (paper-style, gta, aviation): follow the skill's own SKILL.md on a 60-90 s voiceover (only the
     first part), and copy its output video to <log>/round-0/final.mp4;
   - flat2d look: build and render per docs/ENGINE_FLAT2D.md, output to <log>/round-0/final.mp4.
   Keep this same script for every round so rounds are comparable.

EACH ROUND k (starting at 1)
a. Compare: `node renderer/tools/lab.ts compare --sample <log>/round-(k-1)/final.mp4 --refs <refs dir> --out <log>/round-(k-1)/compare`.
   Read report.md, side-by-side.jpg and hooks-first-12s.jpg, and watch our sample's own frames at the same key
   moments you studied in the references.
b. Score references vs our sample from 1 to 10 in each rubric dimension, with one line of evidence each:
   1 palette and colour grade · 2 typography and on-screen text · 3 layout, composition, use of space ·
   4 illustration/character/prop drawing · 5 motion and camera · 6 transitions and pacing (seconds per shot) ·
   7 voice pacing and script voice (words per minute, sentence shape) · 8 sound: music, effects, loudness
   (YouTube plays at about -14 LUFS) · 9 hook (first 15 s) · 10 overall "would a fan think it's the same channel's
   production quality". Any overlap, clipped graphic or hard-to-read text caps dimension 3 at 4.
c. List the gaps, ranked by how much a viewer would notice them. Pick at most 5 for this round, biggest first.
d. Fix them at the right layer, keeping templates generic (nothing hard-coded to this topic):
   style code (templates, tokens, kit drawing functions, motion/easing, audio mix), the style doc's planning rules
   (pacing, words per second, which templates to use when), or the skill's files for skill styles. Run the style's
   tests after code changes (`cd renderer && node --test test/style-<style>.test.ts`; flat2d: qa.mjs 0 errors).
e. Re-render the same script into <log>/round-k (same command as step 3).
f. Write <log>/round-k.md: the score table (previous → now), the gaps chosen, what you changed (files), the
   metric table from report.md, and paths to the before/after sheets.
g. Stop when every dimension is 8 or more and no metric is flagged without a good reason, when ROUNDS is reached,
   or after two rounds in a row with no score gain (then note what blocks progress). Otherwise next round.

FINISH
- Final compare of the last round; write <log>/SUMMARY.md: start vs end scores, what changed, what still differs
  and why (or what it would take).
- Save each lasting rule you learned as a preference so every account follows it:
  `scripts/vf pref add <style> "<rule>"` (retire any it replaces). Update docs/styles/<style>.md for planning rules.
- Commit code and docs to git with a clear message and push to main (CI tests it and publishes the doc to claude.ai).
  Skill and style-kit changes and the log folder sync by themselves (check `scripts/vf status` shows nothing pending,
  or run `scripts/vf push`). A registry style's look reaches cloud renders only after a new renderer image is
  qualified: tell me that step and its cost and wait for my OK.
- Send me the first and last sample videos and the final side-by-side sheet, with a short report: scores
  before → after per dimension, the top changes, and what's left.
```
