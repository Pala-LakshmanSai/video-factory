# Set up Video Factory in a new Claude account

Two parts, a few minutes each. After setup nothing needs re-pasting: preferences, instructions, styles, skills
and kits stay in sync on their own (docs/SYNC.md).

---

## A. Mac (Claude Code, where videos, styles and skills are built): one command

Open **Terminal** and paste:

```bash
curl -fsSL https://video-factory.lakshmansai121.workers.dev/install | bash
```

It installs every tool (Homebrew, git, gh, node, ffmpeg, yt-dlp, Python 3.12, uv, whisper, Chrome, the `claude`
command), signs in to GitHub, downloads the project to `~/video-factory`, syncs every skill, style kit and preference,
installs dependencies and the voice and transcription models, adds the Video Factory connector to Claude Code, and
checks every skill. It asks you for three things only: your Mac password (first Homebrew install only), a GitHub
sign-in in the browser (sign in as Pala-LakshmanSai) and a Claude sign-in in the browser. It ends with "Done", or a
short "still to fix" list. Never hangs, and safe to run again at any time: a re-run takes about 10 seconds and only
fills gaps.

Then open Claude Code in `~/video-factory` (desktop app: Code tab, choose that folder) and say yes when it asks to
trust the folder; that turns on the automatic sync. The first time Claude uses the connector it asks you to sign
in with GitHub.

Prefer Claude to do it? Paste into Claude Code: `Run curl -fsSL https://video-factory.lakshmansai121.workers.dev/install | bash
in my Terminal, then fix anything it lists under "still to fix".`

---

## B. claude.ai (videos ordered by chat)

1. claude.ai → Settings → Connectors → **Add custom connector**: name `Video Factory`, URL
   `https://video-factory.lakshmansai121.workers.dev/mcp`. Connect and sign in with GitHub (Pala-LakshmanSai).
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
