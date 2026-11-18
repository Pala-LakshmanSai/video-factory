# Sync: the same project in every Claude account

Every Claude account (Claude Code on any Mac, and claude.ai Projects) sees the same styles, skills, kits,
preferences and instructions, kept current automatically. One credential: the owner's GitHub login.

## What lives where

| What | Source of truth | How it reaches every account |
|---|---|---|
| Code, registry styles (`renderer/styles/`), engines, docs, `CLAUDE.md`, prompts | git (`main` on GitHub) | Claude Code: SessionStart hook fast-forwards `main`. claude.ai: CI publishes `docs/**` live (below). |
| Owner preferences ("flatglow: captions never cover characters") | D1 table `prefs` in the control plane | Claude Code: printed into every session by the SessionStart hook. claude.ai: `project_brief` / `style_guide` MCP tools. Changes are instant. |
| Skills (`~/.claude/skills/aviation`, `gta`, `paper-style`, `align-images`, `cut-silences`, `youtube-video-style-analyze`) and `style-kits/` | file index in D1 (`sync_files`), bytes in GitHub release assets | `scripts/vf` pulls on session start, pushes on every Stop (background). |
| Live instructions for claude.ai Projects (`docs/PROJECT_INSTRUCTIONS.md`), style docs (`docs/styles/*.md`), prompts | git, published to D1 table `docs` by `.github/workflows/docs-sync.yml` | `project_brief`, `style_guide` |
| Ops facts about the live factory | `docs/OPS_STATE.md` (git) | git |

Not synced on purpose: rendered videos and job folders (they go to Drive), YouTube reference downloads
(`~/.cache/vf-refs`, other people's videos), dependency folders (`node_modules`, `.venv`, `venv`), and secrets.

## Commands (`scripts/vf <cmd>`, or `node scripts/vf.mjs <cmd>`)

| Command | What it does |
|---|---|
| `setup` | New machine: checks tools, pulls everything, installs npm deps (repo + skill engines), Playwright browser, prints the skill checks to run and the connector command. |
| `pull` | Fast-forward git, then download every synced file that changed elsewhere. |
| `push` | Upload local changes in skills/kits and commit them to the index (also runs automatically after each Claude Code turn). |
| `status` | Local changes not pushed yet, conflicts, tracked roots. |
| `prefs` | List live preferences. `pref add <global\|style-id> "<rule>"`, `pref retire <id> "<why>"`. |
| `track <name> <~/.claude/skills/x \| @repo/dir> [--exclude a,b]` | Start syncing a new skill or folder (for every machine). `untrack <name>` stops (files stay). |
| `resolve <root:path> --keep local\|remote` (or `--all`) | Settle a conflict (both machines changed the same file). The remote copy waits in `.vf/local/conflicts/`. |
| `docs publish` | Publish docs to claude.ai now (CI does this on every push to `main`). |
| `gc [--days 30] [--yes]` | Delete stored file versions nothing uses any more (keeps storage small). |

## How it stays reliable
- **Compare-and-set commits.** Each change says which version it replaces; if another machine changed that file
  first, the commit is refused and `pull` marks a conflict instead of overwriting anyone's work.
- **Verified downloads.** Every file is checked against its sha256 before it replaces anything (atomic rename).
- **Safety guards.** A missing folder (unmounted drive, skill not installed yet) is never read as "delete
  everything"; deleting more than half of a folder's files needs `--allow-mass-delete`. Files can only ever be
  written inside `~/.claude/skills/` or this repo (enforced by both the server and the client).
- **Incremental.** The index is versioned; a pull asks only for changes since the last one. Unchanged files are
  recognised by size + mtime without rehashing. Transfers run 8 at a time with retries.
- **Auth.** `/sync/*` accepts any GitHub token that can read this private repo (fails closed if the repo is ever
  made public). claude.ai uses the connector's GitHub sign-in.
- **Hooks never block work.** SessionStart waits at most 40 s, then lets a big download finish in the background;
  Stop starts a background push at most every 90 s. Logs: `.vf/local/sync.log`.

## Limits
- One file up to 1.9 GB. Release assets: about 1000 per shard × 16 shards; run `vf gc --yes` now and then.
- Skills edited from a Claude Code session started outside this repo are pushed on the next `vf push` or the next
  session in this repo.
- An existing claude.ai Project created before 2026-11-18 should replace its instructions with the bootstrap in
  `docs/prompts/NEW_ACCOUNT_SETUP.md` (part B) once. Even without it, `acquire_gpu` and `list_styles` now point
  every chat at the live `style_guide`, so preferences still apply.
