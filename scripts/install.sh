#!/bin/bash
# Video Factory: one-command setup for a new Mac (docs/prompts/NEW_ACCOUNT_SETUP.md).
#   curl -fsSL https://video-factory.lakshmansai121.workers.dev/install | bash
# Safe to run again: it skips whatever is already installed and only fills gaps.
# You will be asked for: your Mac password (Homebrew, first time only) and a GitHub sign-in in the browser.
set -euo pipefail
DIR="${VF_DIR:-$HOME/video-factory}"
REPO="Pala-LakshmanSai/video-factory"
step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
tty() { if [ -r /dev/tty ]; then "$@" </dev/tty; else "$@"; fi; } # curl | bash: prompts read the keyboard, not the pipe

step "Homebrew"
for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$("$b" shellenv)"; done
if ! command -v brew >/dev/null; then
	echo "Installing Homebrew (type your Mac password when asked)..."
	tty /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
	for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$("$b" shellenv)"; done
fi
brew --version | head -1

step "Tools"
want="git:git gh:gh node:node ffmpeg:ffmpeg yt-dlp:yt-dlp python3.12:python@3.12 uv:uv whisper-cli:whisper-cpp" # command:formula
missing=()
for w in $want; do command -v "${w%%:*}" >/dev/null || missing+=("${w#*:}"); done
if [ ${#missing[@]} -gt 0 ]; then brew install "${missing[@]}"; else echo "all present"; fi
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if (a<22||(a===22&&b<18)) process.exit(1)' || brew upgrade node
[ -d "/Applications/Google Chrome.app" ] || brew install --cask google-chrome

step "GitHub sign-in"
if ! gh auth status >/dev/null 2>&1; then
	echo "A browser page opens: sign in as the Video Factory owner and paste the code shown here."
	tty gh auth login --hostname github.com --git-protocol https --web
fi
gh auth setup-git
gh auth status 2>&1 | grep -m1 "Logged in" || true

step "Project code -> $DIR"
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only || echo "(could not fast-forward; continuing with the local copy)"
else gh repo clone "$REPO" "$DIR"; fi

step "Claude Code command"
command -v claude >/dev/null || [ -x "$HOME/.local/bin/claude" ] || curl -fsSL https://claude.ai/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"

step "Sync skills, style kits, preferences, dependencies, voice and transcription models"
cd "$DIR"
node scripts/vf.mjs setup

cat <<EOF

Done. Open Claude Code in $DIR (desktop app: Code tab > choose that folder, or in a terminal: cd "$DIR" && claude).
Say yes when it asks to trust the folder: that turns on the automatic sync.
EOF
