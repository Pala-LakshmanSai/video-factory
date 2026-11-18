#!/bin/bash
# End-to-end check of scripts/vf against the live sync service with two simulated machines (A = this repo,
# B = a temp copy). Uses a throwaway root under .vf/local/, untracked at the end. Run: scripts/vf-selftest.sh
set -euo pipefail
A="$(cd "$(dirname "$0")/.." && pwd)"
B="$(mktemp -d)"
ROOT="selftest-$(date +%s)"
DIR=".vf/local/$ROOT"
fail() { echo "FAIL: $*"; node "$A/scripts/vf.mjs" untrack "$ROOT" >/dev/null 2>&1 || true; exit 1; }
trap 'rm -rf "$B" "$A/$DIR"' EXIT
mkdir -p "$B/scripts" "$B/.vf" && cp "$A/scripts/vf.mjs" "$B/scripts/" && cp "$A/.vf/config.json" "$B/.vf/"
vfA() { node "$A/scripts/vf.mjs" "$@"; }
vfB() { node "$B/scripts/vf.mjs" "$@"; }

mkdir -p "$A/$DIR/sub" "$A/$DIR/node_modules"
echo hello > "$A/$DIR/a.txt"; printf '#!/bin/sh\necho hi\n' > "$A/$DIR/sub/run.sh"; chmod +x "$A/$DIR/sub/run.sh"
: > "$A/$DIR/empty"; head -c 9000000 /dev/urandom > "$A/$DIR/big.bin"; echo skip > "$A/$DIR/node_modules/x"
vfA track "$ROOT" "@repo/$DIR" >/dev/null

vfB pull >/dev/null
cmp -s "$A/$DIR/big.bin" "$B/$DIR/big.bin" || fail "big file differs on B"
[ "$(cat "$B/$DIR/a.txt")" = hello ] || fail "packed small file differs on B"
[ -x "$B/$DIR/sub/run.sh" ] || fail "exec bit lost"
[ -f "$B/$DIR/empty" ] || fail "empty file missing"
[ ! -e "$B/$DIR/node_modules" ] || fail "excluded folder synced"

echo fromB > "$B/$DIR/a.txt"; rm "$B/$DIR/empty"; echo new > "$B/$DIR/sub/new.md"
vfB push >/dev/null; vfA pull >/dev/null
[ "$(cat "$A/$DIR/a.txt")" = fromB ] && [ ! -e "$A/$DIR/empty" ] && [ -f "$A/$DIR/sub/new.md" ] || fail "B's edit/delete/add not on A"

echo A2 > "$A/$DIR/a.txt"; echo B2 > "$B/$DIR/a.txt"
vfB push >/dev/null; vfA push >/dev/null 2>&1 || true
vfA status | grep -q "CONFLICT $ROOT:a.txt" || fail "conflict not detected"
[ "$(cat "$A/$DIR/a.txt")" = A2 ] || fail "local file overwritten during conflict"
vfA resolve "$ROOT:a.txt" --keep local >/dev/null; vfA push >/dev/null; vfB pull >/dev/null
[ "$(cat "$B/$DIR/a.txt")" = A2 ] || fail "resolved version did not reach B"

mv "$A/$DIR" "$A/$DIR.away"; vfA push 2>&1 | grep -q "is missing" || { mv "$A/$DIR.away" "$A/$DIR"; fail "missing folder not guarded"; }
mv "$A/$DIR.away" "$A/$DIR"
vfA untrack "$ROOT" >/dev/null
echo "PASS: vf two-machine selftest ($ROOT)"
