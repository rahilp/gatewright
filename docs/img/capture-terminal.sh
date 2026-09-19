#!/usr/bin/env bash
# Captures the README terminal screenshots: the full-screen `gw init` (steps 1
# and 2) and the `gw config` settings screen. Runs the real gw in a detached
# tmux pane (a real pty, on a private tmux socket), dumps each screen with its
# colours, and renders the dumps as terminal-window PNGs.
#
# usage: docs/img/capture-terminal.sh [outdir]     (default: this directory)
# needs: tmux, node 22+, chromium (CHROME=<path> to pick another)
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
GW_JS=${GW_JS:-$(cd "$HERE/../.." && pwd)/bin/gw.js}
OUT=$(cd "${1:-$HERE}" && pwd)
COLS=80 ROWS=26
SOCK=gw-shots-$$
T="tmux -L $SOCK"
WORK=$(mktemp -d /tmp/gw-term-shots-XXXX)
trap '$T kill-server 2>/dev/null || true; rm -rf "$WORK"' EXIT

# An agent session exports these, and gw would take the actor from them.
unset CLAUDECODE AI_AGENT CURSOR_AGENT GW_ACTOR GW_ROOT GW_TUI NO_COLOR

# wait_for <text>: until the pane shows <text> (10 s at most), then let the
# screen finish drawing.
wait_for() {
  for _ in $(seq 100); do
    if $T capture-pane -p -t gw | grep -qF -- "$1"; then sleep 0.3; return 0; fi
    sleep 0.1
  done
  echo "timed out waiting for: $1" >&2
  $T capture-pane -p -t gw >&2
  return 1
}
snap() { $T capture-pane -e -p -t gw > "$WORK/$1.ansi"; }
key() { $T send-keys -t gw "$@"; }

# A fresh project, as someone would first run gw in it: a git repository that
# already uses Claude Code, so step 2 shows a detected tool ticked.
PROJ=$WORK/beacon
mkdir -p "$PROJ/.claude"
git -C "$PROJ" init -q

$T new-session -d -s gw -x $COLS -y $ROWS -c "$PROJ" \
  "env TERM=xterm-256color PS1='$ ' bash --norc --noprofile"
$T set-option -t gw status off
sleep 0.3

key "clear; node $GW_JS init" Enter
wait_for "Step 1 of 3"
snap gw-init-step1
key Enter
wait_for "Step 2 of 3"
snap gw-init-step2
key Escape
wait_for "nothing was written"

# gw config needs a board; make one without the full-screen init.
key "clear; node $GW_JS init --pipeline team --yes --no-input >/dev/null; clear; node $GW_JS config" Enter
wait_for "Settings"
snap gw-config
key q

node "$HERE/render-terminal.mjs" "$OUT" \
  "$WORK/gw-init-step1.ansi=~/beacon — gw init" \
  "$WORK/gw-init-step2.ansi=~/beacon — gw init" \
  "$WORK/gw-config.ansi=~/beacon — gw config"
