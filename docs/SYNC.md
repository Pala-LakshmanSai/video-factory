# Sync: the same project in every Claude account

Every Claude account (Claude Code on any Mac, and claude.ai Projects) sees the same styles, skills, kits,
preferences and instructions, kept current automatically. One credential: the owner's GitHub login, or a personal access key per team member
(no GitHub account needed).

## What lives where

| What | Source of truth | How it reaches every account |
|---|---|---|
| Code, registry styles (`renderer/styles/`), engines, docs, `CLAUDE.md`, prompts | git (`main` on GitHub) | Claude Code: SessionStart hook fast-forwards `main`. claude.ai: CI publishes `docs/**` live (below). |
| Owner preferences ("flatglow: captions never cover characters") | D1 table `prefs` in the control plane | Claude Code: printed into every session by the SessionStart hook. claude.ai: `project_brief` / `style_guide` MCP tools. Changes are instant. |
| Skills (`~/.claude/skills/aviation`, `gta`, `paper-style`, `align-images`, `cut-silences`, `youtube-video-style-analyze`) and `style-kits/` | file index in D1 (`sync_files`), bytes in Backblaze B2 (bucket `video-factory-files`; older versions in GitHub release assets) | `scripts/vf` pulls on session start, pushes on every Stop (background). |
| Live instructions for claude.ai Projects (`docs/PROJECT_INSTRUCTIONS.md`), style docs (`docs/styles/*.md`), prompts | git, published to D1 table `docs` by `.github/workflows/docs-sync.yml` | `project_brief`, `style_guide` |
| Ops facts about the live factory | `docs/OPS_STATE.md` (git) | git |

Not synced on purpose: rendered videos and job folders (they go to Drive), YouTube reference downloads
(`~/.cache/vf-refs`, other people's videos), dependency folders (`node_modules`, `.venv`, `venv`), and secrets.

## Commands (`scripts/vf <cmd>`, or `node scripts/vf.mjs <cmd>`)

| Command | What it does |
|---|---|
| `setup` | New machine (the one-command installer `curl -fsSL <api>/install \| bash` runs it): checks tools, pulls everything, installs npm deps (repo + skill engines), Playwright browser, whisper/Kokoro models and paper-style's audio venv (`--no-models` skips them), adds the Claude Code connector, runs every skill's check and lists what is still missing. |
| `pull` | Fast-forward git, then download every synced file that changed elsewhere. |
| `push` | Upload local changes in skills/kits and commit them to the index (also runs automatically after each Claude Code turn). |
| `status` | Local changes not pushed yet, conflicts, tracked roots. |
| `prefs` | List live preferences. `pref add <global\|style-id> "<rule>"`, `pref retire <id> "<why>"`. |
| `track <name> <~/.claude/skills/x \| @repo/dir> [--exclude a,b]` | Start syncing a new skill or folder (for every machine). `untrack <name>` stops (files stay). |
| `resolve <root:path> --keep local\|remote` (or `--all`) | Settle a conflict (both machines changed the same file). The remote copy waits in `.vf/local/conflicts/`. |
| `docs publish` | Publish docs to claude.ai now (CI does this on every push to `main`). |
| `gc [--days 30] [--yes]` | Delete stored file versions nothing uses any more (keeps storage small). |
| `access add "<name>"` / `access list` / `access remove "<name>"` | Owner: give a team member a personal access key (prints their Windows/Mac install line and connector steps), list keys, revoke one. |
| `migrate-storage` | Owner, once: move stored files from GitHub release assets to Backblaze B2. Safe to re-run. |

## How it stays reliable
- **Compare-and-set commits.** Each change says which version it replaces; if another machine changed that file
  first, the commit is refused and `pull` marks a conflict instead of overwriting anyone's work.
- **Verified downloads.** Every file is checked against its sha256 before it replaces anything (atomic rename).
- **Safety guards.** A missing folder (unmounted drive, skill not installed yet) is never read as "delete
  everything"; deleting more than half of a folder's files needs `--allow-mass-delete`. Files can only ever be
  written inside `~/.claude/skills/` or this repo (enforced by both the server and the client).
- **Incremental.** The index is versioned; a pull asks only for changes since the last one. Unchanged files are
  recognised by size + mtime without rehashing. Transfers run 8 at a time with retries.
- **Auth.** `/sync/*` accepts a personal access key (`vfk_...`, stored only as a SHA-256 hash in D1 `access_keys`,
  revocable), or a GitHub token with **Write** access to this repo (the owner or a Write collaborator; read access
  is not enough, so the repo can be public). Managing keys is owner-only. CI publishes docs with its own
  `VF_DOCS_TOKEN` secret (Worker: `DOCS_PUBLISH_TOKEN`), which can publish docs and nothing else. The connector
  accepts a GitHub sign-in or the access key (pasted on its sign-in page, or `Authorization: Bearer vfk_...`).
- **File bytes never pass through the server.** It hands out signed Backblaze links valid for 1 hour; clients
  upload and download directly. Backblaze keys are Worker secrets (`B2_KEY_ID`, `B2_APP_KEY`), never on a PC.
- **Hooks never block work.** SessionStart waits at most 40 s, then lets a big download finish in the background;
  Stop starts a background push at most every 90 s. Logs: `.vf/local/sync.log`.

## Giving a team member access (no GitHub needed)
Owner runs `node scripts/vf.mjs access add "Priya"` (or asks Claude to). It prints a ready-to-send message with
their personal install line for Windows and Mac and the connector steps; the key is in the line. They paste it,
sign in to Claude, done. Revoke any time: `node scripts/vf.mjs access remove "Priya"` (sync and connector stop
working for that key at once). One key per name; `access add` again replaces it.

## Giving another GitHub account access (alternative)
1. GitHub → the repo → Settings → Collaborators → Add people (username or email) with the **Write** role. Write is
   needed: synced file bytes live in draft releases, which only Write collaborators can see. They accept the invite.
   That alone covers git, `scripts/vf` sync and the installer.
2. The claude.ai / Claude Code connector: add their GitHub login or verified email to the Worker secret `MCP_USERS`
   (comma-separated; `cd control-plane && npx wrangler secret put MCP_USERS`). Not in git on purpose.
The owner (`ALLOWED_GITHUB_LOGIN`) always has access; the /admin page stays owner-only.

## Limits
- One file up to 1.9 GB (Backblaze allows 5 GB per upload). Backblaze: first 10 GB stored free, downloads free up to 3x the stored amount per month; run `vf gc --yes` now and then.
- Backblaze caps: an account with no card on file stops downloads after about 1 GB a day (`cap exceeded`, resets
  00:00 UTC), which is about one new computer per day (a full sync is ~1 GB). With a card, set a daily cap in
  Backblaze > Caps & Alerts; past the free allowance downloads cost about $0.01/GB.
- Skills edited from a Claude Code session started outside this repo are pushed on the next `vf push` or the next
  session in this repo.
- An existing claude.ai Project created before 2026-11-18 should replace its instructions with the one-line bootstrap in
  `docs/prompts/NEW_ACCOUNT_SETUP.md` (part B) once. Even without it, the connector's server instructions tell
  Claude to call `project_brief` first, and `acquire_gpu` / `list_styles` point at the live `style_guide`.
- `GET /team` serves the team guide `docs/team-setup.html`; `GET /install` serves `scripts/install.sh` as published by `docs publish` (CI, on every push to main touching it).
