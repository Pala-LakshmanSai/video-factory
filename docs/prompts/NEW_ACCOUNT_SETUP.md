# Set up Video Factory in a new Claude account

Works on Windows 10/11 and any Mac (Apple Silicon or Intel), with any Claude account. The plain-language overview is
the project README.

**Who signs in how:** a team member uses the **personal install line** the owner sends (it carries their access
key; no GitHub account needed; owner creates it with `node scripts/vf.mjs access add "<name>"`). The owner signs in
with GitHub (Pala-LakshmanSai). A GitHub account with **Write** access also works (docs/SYNC.md).

Two parts, a few minutes each. After setup nothing needs re-pasting: preferences, instructions, styles, skills
and kits stay in sync on their own (docs/SYNC.md).

---

## A. Computer (Claude Code, where videos, styles and skills are built): one command

**Windows:** Start → type `PowerShell` → open it, paste your personal line and press Enter:

```powershell
irm "https://video-factory.lakshmansai121.workers.dev/install.ps1?key=vfk_..." | iex
```

**Mac:** open **Terminal** and paste your personal line:

```bash
curl -fsSL "https://video-factory.lakshmansai121.workers.dev/install?key=vfk_..." | bash
```

(Owner: the same lines without `?key=...` sign in with GitHub instead.)

It installs every tool (Homebrew on Mac / winget on Windows, git, node, ffmpeg, yt-dlp, Python 3.12, uv, whisper,
Chrome, the `claude` command), saves the access key to `~/.video-factory/key`, downloads the project to
`~/video-factory`, syncs every skill, style kit and preference, installs dependencies and the voice and
transcription models, adds the Video Factory connector to Claude Code (signed in with the key), and checks every
skill. It asks for your computer password (Mac, first tool install only) and a Claude sign-in in the browser. It
ends with "Done", or a short "still to fix" list. Never hangs, and safe to run again at any time: a re-run takes
about 10 seconds and only fills gaps.

Then open Claude Code in `~/video-factory` (desktop app: Code tab, choose that folder) and say yes when it asks to
trust the folder; that turns on the automatic sync.

Prefer Claude to do it? Paste into Claude Code: `Run the Video Factory one-line installer for this computer (see
the project README), then fix anything it lists under "still to fix".`

---

## B. claude.ai (videos ordered by chat)

1. claude.ai → Settings → Connectors → **Add custom connector**: name `Video Factory`, URL
   `https://video-factory.lakshmansai121.workers.dev/mcp`. Connect; on the sign-in page paste your access key (the `vfk_...` part of your
   install line) under "Or paste your access key" (owner: sign in with GitHub).
   Optional: set its tools to **Always allow** so chats don't stop to ask.
2. Create a Project named **Video Factory**, turn the connector on, and paste this one line as its instructions
   (no knowledge files; everything else arrives live):

```
At the start of every chat, call the Video Factory tool project_brief and follow what it returns.
```

That's all. The connector also tells Claude to do this by itself, so even a plain chat with the connector on
follows the live rules. A Project made before 2026-11-18: replace its instructions with the line above and delete
its old knowledge files.

Test: new chat in the Project, ask "which styles can you make?". It calls project_brief, then list_styles.
