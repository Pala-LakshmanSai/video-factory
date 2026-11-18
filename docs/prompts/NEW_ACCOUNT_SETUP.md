# Reusable prompt: set up Video Factory in a new Claude account

Two parts. **A** sets up Claude Code on a Mac (where videos, styles and skills are built). **B** sets up a
claude.ai Project (where videos can be ordered by chat). Do both for a new account; each takes a few minutes.
After setup, nothing needs re-pasting: preferences, instructions, styles, skills and kits stay in sync on their own
(docs/SYNC.md).

---

## A. Claude Code: paste this into Claude Code (any folder)

```
Set up the Video Factory project on this Mac for this Claude account. Work on your own; ask me only to finish
sign-ins (GitHub, the connector) and before anything that costs money.

1. Tools. Make sure these exist, installing missing ones with Homebrew (install Homebrew first if needed):
   git, gh, node (22.18 or newer), ffmpeg, yt-dlp, python@3.12, uv.
2. GitHub. If `gh auth status` fails, run `gh auth login --hostname github.com --git-protocol https --web` and ask
   me to finish the browser sign-in as Pala-LakshmanSai. Then `gh auth setup-git`.
3. Code. If ~/video-factory does not exist, `gh repo clone Pala-LakshmanSai/video-factory ~/video-factory`
   (use another folder only if I name one). cd into it.
4. Sync. Run `scripts/vf setup` and wait for it to finish (it downloads every synced skill and style kit,
   about 1 GB the first time, installs dependencies and prints next steps). Then run every
   `python3 .../check_setup.py` it lists and fix whatever they report (they install each skill's own tools).
   paper-style also needs its audio venv: follow ~/.claude/skills/paper-style/audio/README.md.
5. Connector. Run `claude mcp add --transport http --scope user video-factory https://video-factory.lakshmansai121.workers.dev/mcp`
   and ask me to sign in with GitHub when it asks (type /mcp if needed).
6. Check it all works:
   - `scripts/vf status` shows no conflicts and `scripts/vf prefs` lists the owner preferences;
   - `node renderer/tools/lab.ts sample renderer/styles/flatglow/example-plan.json --out ~/vf-check` renders a video
     (look at ~/vf-check/sheet.jpg);
   - the video-factory connector's list_styles and project_brief tools answer.
7. Tell me in a short list: what you installed, which skills and kits synced, how many preferences are live, and
   anything still failing with the exact error.

From now on I open Claude Code inside ~/video-factory. Its hooks pull the latest code, skills, kits and preferences
at every session start and push my skill/kit edits after every turn. When I say how videos or a style should
always be, save it with `scripts/vf pref add` so every account gets it.
```

When Claude Code first opens the repo it asks to trust the folder; say yes, or the sync hooks in
`.claude/settings.json` won't run.

---

## B. claude.ai Project

1. claude.ai → Settings → Connectors → **Add custom connector**: name `Video Factory`, URL
   `https://video-factory.lakshmansai121.workers.dev/mcp`. Connect and sign in with GitHub (Pala-LakshmanSai).
   Open the connector's tool settings and set every tool to **Always allow**.
2. Create a Project named **Video Factory**, turn the connector on for it, and paste the block below as the
   Project's instructions. Add **no** knowledge files: style docs and rules arrive live.
   (Existing Project from before 2026-11-18: replace its instructions with this block and delete its old
   knowledge files.)

```
You are the Video Factory producer. At the start of EVERY chat, before anything else, call the Video Factory
tool project_brief and follow the instructions it returns exactly. They are the live, current rules and the
owner's preferences for every Claude account, and they override anything else in this Project or in memory.
Before planning a video in a style, call style_guide with that style id and follow its doc and preferences.
When I state a lasting preference (always / never / from now on, or a correction to how a style should look,
sound or be made), save it right away with add_preference (scope "global" or the style id, one rule per call)
and retire_preference the one it replaces, so every account gets it. Never keep preferences only in this chat
or in Project memory. If the Video Factory tools are unavailable, say so and stop.
```

3. Test: new chat in the Project, ask "which styles can you make?". It should call project_brief, then list_styles.
