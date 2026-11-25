# Video Factory

Tell Claude what video you want ("a 3-minute video about the Titanic in flatglow style") and get a finished video.
It writes the plan, makes the voice and the visuals, renders it, checks every frame, and hands you the file.

This page explains how it works and how to set it up on a new PC or a new Claude account. You need no technical
knowledge: every step is copy and paste.

---

## How it works

There are two ways a video gets made, and both are set up by the same steps below.

```
 1. In the cloud (any device, even a phone)

   You, in claude.ai ──► Video Factory server ──► rents a RunPod GPU ──► finished video in Google Drive
                         (keeps the rules, the       (only for this
                          styles, your preferences    video, then it
                          and all the secret keys)    switches off)

 2. On your own computer (Windows or Mac)

   You, in the Claude app ──► skills, style kits and engines on your computer ──► video file on your computer
                              (downloaded and kept up to date for you)
```

- **The server** is the brain: it knows every style, every rule, and the owner's preferences, and it holds the
  keys for RunPod (GPUs), Google Drive and alerts. Those keys never go on anyone's computer, so a new PC needs none.
- **RunPod** is where cloud videos are rendered: one GPU per video, rented for the minutes it takes. That costs a
  little money per video, so Claude asks before it rents one.
- **Your computer** gets the whole project: the code, every skill (gta, aviation, paper-style, doomsday, the
  Premiere tools), every style kit, the render engines and the voice and speech models.
- **Everything stays in sync.** A preference you give in one account ("flatglow titles always in capitals"), a new
  style, or a fix to a skill reaches every computer and every Claude account on its own. Nothing to copy by hand.

---

## Set up a new computer: one line

You need a Claude account and a GitHub account that has been invited to this project (see "Give someone access").

**Windows 10 or 11:** press Start, type `PowerShell`, open it, paste this and press Enter:

```powershell
irm https://video-factory.lakshmansai121.workers.dev/install.ps1 | iex
```

**Mac:** open Spotlight (Cmd+Space), type `Terminal`, open it, paste this and press Enter:

```bash
curl -fsSL https://video-factory.lakshmansai121.workers.dev/install | bash
```

It installs everything and downloads the whole project to a `video-factory` folder in your home folder. It only
asks you for three things:

1. your computer password (once, to install the tools),
2. a **GitHub sign-in** page in the browser (copy the code it shows into that page),
3. a **Claude sign-in** page in the browser.

It takes 20-40 minutes the first time (big downloads) and ends with **Done**. If it shows **still to fix**
instead, do what it says (or ask Claude to) and paste the same line again: it only redoes what is missing, and a
re-run takes seconds. It never gets stuck.

**Then:** open the Claude app → **Code** tab → choose the **video-factory** folder → say **yes** when it asks to
trust the folder (that turns on the automatic sync). Type `/mcp`, pick **video-factory**, and sign in with
GitHub once: that connects your computer to the cloud factory and RunPod.

---

## Set up a new Claude account (claude.ai, any device)

1. claude.ai → **Settings → Connectors → Add custom connector**. Name `Video Factory`, address
   `https://video-factory.lakshmansai121.workers.dev/mcp`. Click **Connect** and sign in with GitHub.
2. **Projects → New project**, name it `Video Factory`, turn the connector on, and paste this as its instructions:

```
At the start of every chat, call the Video Factory tool project_brief and follow what it returns.
```

3. Test it: in a new chat, ask "which styles can you make?".

That's all. Everything else (instructions, style guides, preferences) comes from the server live.

---

## What you can ask

- "Which styles can you make?"
- "Make a 2-minute video about how volcanoes work in flatglow style." (cloud: asks before renting a GPU)
- "Make a gta video from this voiceover." / "Make an aviation video about this crash." (on your computer)
- "From now on, doomsday videos never use music under dialogue." (saved for every account)
- "Create a new style like this channel: <link>" → follows `docs/prompts/STYLE_CREATION.md`
- "Refine the stickman style against this channel: <link>" → follows `docs/prompts/STYLE_REFINEMENT.md`

## Styles

| Where it renders | Styles |
|---|---|
| Cloud (RunPod GPU), from claude.ai or the Claude app | Explainer, Bold Shorts, Documentary, Stickman Explainer, Flatglow, POV Escalation, Blockworld, Discovery Documentary, Custom kit package |
| Your computer (Claude app), from skills | gta, aviation, paper-style, doomsday, plus Premiere Pro helpers (align-images, cut-silences) and youtube-video-style-analyze |

Style kits (references and design bibles for building styles) are in `style-kits/`.

## Give someone access

1. On GitHub: this repository → **Settings → Collaborators → Add people** → their GitHub name or email, role
   **Write**. They accept the email invite. That gives them the code, skills, kits and sync.
2. For the cloud factory, the owner adds their GitHub name or email to the server's allowed list (Claude can do it:
   "give <email> access to the connector"). See `docs/SYNC.md`.

## If something goes wrong

- Paste the same install line again: it fixes what is missing.
- Or open the Claude app in the video-factory folder and say: "Setup is not working: run `node scripts/vf.mjs setup`
  and fix what it lists."
- Sync status: `node scripts/vf.mjs status`. Preferences: `node scripts/vf.mjs prefs`.

---

## For developers

Spec: `docs/SPEC.md`; typed contract: `docs/CONTRACT.md`; server setup: `docs/SETUP.md`; sync design: `docs/SYNC.md`.

| Dir | What |
|---|---|
| `control-plane/` | Cloudflare Worker: MCP server (the connector), agent API, GPU selector, Drive broker, sync API, crons |
| `renderer/` | Pod image: agent, Chromium + ffmpeg render engine, Kokoro TTS, registry styles |
| `engines/flat2d/` | Flat 2D kit engine (per-video custom looks) |
| `packages/contract/` | Shared types (generated from `docs/CONTRACT.md`) and the style registry |
| `bench/` | 60 s standard test video for the weekly GPU re-rank |
| `scripts/` | `install.sh` / `install.ps1` (one-line setup), `vf` (sync, docs/SYNC.md), `google_oauth.py`, `drill.ts` |
| `renderer/tools/lab.ts` | Style lab: reference download, local sample render, side-by-side comparison |
| `docs/styles/` | Style docs, served live to claude.ai (`style_guide`); `docs/PROJECT_INSTRUCTIONS.md` is the live runbook |
| `docs/prompts/` | Reusable prompts: new account setup, style creation, style refinement against a channel |
| `style-kits/` | Style kits and refinement logs (synced by `vf`, not git) |
