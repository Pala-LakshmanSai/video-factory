#!/bin/bash
# Video Factory: one-command setup for a new Mac (docs/prompts/NEW_ACCOUNT_SETUP.md).
#   curl -fsSL https://video-factory.lakshmansai121.workers.dev/install | bash
# Team members get a personal line (".../install?key=vfk_..."): the server fills in VF_KEY_FROM_LINK below, and
# the key replaces GitHub entirely (no GitHub account needed). Without a key it signs in with GitHub (the owner).
# Safe to run again: it skips whatever is already installed and only fills gaps.
# You will be asked for: your Mac password (Homebrew, first time only), a GitHub sign-in in the browser (no key
# only) and a Claude sign-in.
# Everything is inside main(), called on the last line: a cut-off download runs nothing.
set -euo pipefail
DIR="${VF_DIR:-$HOME/video-factory}"
REPO="Pala-LakshmanSai/video-factory"
export GIT_TERMINAL_PROMPT=0 # git fails with a message instead of waiting for a password nobody sees
VF_KEY_FROM_LINK=""
KEY_FILE="$HOME/.video-factory/key" # scripts/vf.mjs reads it

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }
# curl | bash: prompts must read the keyboard, not the pipe. -r /dev/tty is true even with no terminal, so try opening it.
tty() { if (: </dev/tty) 2>/dev/null; then "$@" </dev/tty; else "$@"; fi; }
brew_env() { for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do if [ -x "$b" ]; then eval "$("$b" shellenv)"; return; fi; done; }
# Real Command Line Tools, not the /usr/bin/git stub that only pops an "install" dialog (also broken by macOS upgrades).
clt_ok() { [ -x "$(xcode-select -p 2>/dev/null)/usr/bin/git" ]; }
add_line() { grep -qsF "$2" "$HOME/.zprofile" || printf '%s\n' "$1" >>"$HOME/.zprofile"; } # line, marker
# Sets KEY: env VF_KEY, else the key from the personal install line, else the one saved last time; saves it.
resolve_key() {
	KEY="${VF_KEY:-$VF_KEY_FROM_LINK}"
	if [ -z "$KEY" ] && [ -f "$KEY_FILE" ]; then KEY="$(tr -d '[:space:]' <"$KEY_FILE")"; fi
	if [ -z "$KEY" ]; then return 0; fi
	[[ "$KEY" =~ ^vfk_[A-Za-z0-9]{32}$ ]] ||
		die "That access key does not look right (it starts with vfk_ and is 36 characters). Ask the owner for your install line again."
	mkdir -p "$(dirname "$KEY_FILE")"
	(umask 077 && printf '%s' "$KEY" >"$KEY_FILE")
	chmod 600 "$KEY_FILE"
}

main() {
	trap 'rc=$?; [ $rc -eq 0 ] || printf "\n\033[1;31mSetup stopped before the end. Fix what is shown above if you can, then run the same command again:\033[0m\n  curl -fsSL https://video-factory.lakshmansai121.workers.dev/install | bash\n" >&2' EXIT

	resolve_key
	if [ -n "$KEY" ]; then echo "Using your Video Factory access key (no GitHub account needed)."; else echo "Signing in with GitHub."; fi

	step "Homebrew"
	brew_env
	if ! command -v brew >/dev/null || ! clt_ok; then
		# Also the repair path for missing Command Line Tools: the Homebrew installer installs them.
		echo "Installing Homebrew and Apple's command line tools (type your Mac password when asked)..."
		tty /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
		brew_env
	fi
	command -v brew >/dev/null || die "Homebrew did not install."
	add_line "eval \"\$($(command -v brew) shellenv)\"" "brew shellenv" # new Terminal windows and Claude Code find the tools
	brew --version | head -1

	step "Tools"
	want="git:git node:node ffmpeg:ffmpeg yt-dlp:yt-dlp python3.12:python@3.12 uv:uv whisper-cli:whisper-cpp" # command:formula
	[ -n "$KEY" ] || want="$want gh:gh" # the GitHub CLI only without a key
	missing=""
	for w in $want; do command -v "${w%%:*}" >/dev/null || missing="$missing ${w#*:}"; done
	# shellcheck disable=SC2086 # unquoted on purpose: one word per formula
	if [ -n "$missing" ]; then brew install $missing; else echo "all present"; fi
	# Node 22.18+; brew install also upgrades an outdated brew node (brew upgrade fails if node came from elsewhere).
	node -e 'const [a,b]=process.versions.node.split(".").map(Number); if (a<22||(a===22&&b<18)) process.exit(1)' || brew install node
	[ -d "/Applications/Google Chrome.app" ] || brew install --cask google-chrome ||
		echo "(Chrome did not install; get it later from google.com/chrome. Continuing.)"

	if [ -z "$KEY" ]; then
		step "GitHub sign-in"
		if ! gh auth token >/dev/null 2>&1; then
			echo "A browser page opens: sign in as the Video Factory owner and paste the code shown here."
			tty gh auth login --hostname github.com --git-protocol https --web || die "GitHub sign-in did not finish."
		fi
		gh auth setup-git
		gh auth status 2>&1 | grep -m1 "Logged in" || true
	fi

	step "Project code -> $DIR"
	if [ -d "$DIR/.git" ]; then
		git -C "$DIR" pull -q --ff-only || echo "(could not fast-forward; continuing with the local copy)"
	else
		if [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then # a folder that is not the project: keep it, out of the way
			old="$DIR.old-$(date +%Y%m%d-%H%M%S)"
			mv "$DIR" "$old" && echo "An older folder was in the way; moved it to $old"
		fi
		if [ -n "$KEY" ]; then # public repo: no GitHub account, and GIT_TERMINAL_PROMPT=0 means no password prompt
			git clone -q "https://github.com/$REPO.git" "$DIR" || die "Could not download the project. Check the internet connection."
		else
			gh repo clone "$REPO" "$DIR" ||
				die "Could not download the project. Check the internet, and that GitHub is signed in as the owner (to switch: gh auth logout)."
		fi
	fi

	step "Claude Code command"
	if ! command -v claude >/dev/null && [ ! -x "$HOME/.local/bin/claude" ]; then
		curl -fsSL https://claude.ai/install.sh | bash || echo "(Claude Code command did not install; the desktop app still works. Continuing.)"
	fi
	export PATH="$HOME/.local/bin:$PATH"
	# shellcheck disable=SC2016 # expands at login, not now
	add_line 'export PATH="$HOME/.local/bin:$PATH"' '.local/bin'
	if command -v claude >/dev/null && ! claude auth status 2>/dev/null | grep -q '"loggedIn": true'; then
		echo "A browser page opens: sign in to your Claude account (the skills use the claude command)."
		tty claude auth login || echo "(Claude sign-in skipped; later run: claude auth login)"
	fi

	step "Sync skills, style kits, preferences, dependencies, voice and transcription models"
	cd "$DIR"
	node scripts/vf.mjs setup </dev/null || die "Setup is not finished yet: see what still needs fixing just above."

	cat <<EOF

Done. Open Claude Code in $DIR (desktop app: Code tab > choose that folder, or in a new terminal window: cd "$DIR" && claude).
Say yes when it asks to trust the folder: that turns on the automatic sync.
EOF
}

main "$@"
