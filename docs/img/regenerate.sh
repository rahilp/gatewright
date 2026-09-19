#!/usr/bin/env bash
# Regenerates every README screenshot in this directory:
#   board.png, overview.png, stages.png, item-detail.png   (live board)
#   gw-init-step1.png, gw-init-step2.png, gw-config.png    (terminal)
#
# Builds a fresh demo board (demo-board.sh), serves it on a spare port (never
# 7777, the port a developer's own board is likely on), captures the board,
# captures the terminal screens, and shrinks the board PNGs.
#
# usage: docs/img/regenerate.sh
# needs: node 22+, git, tmux, chromium (CHROME=<path>), ImageMagick (optional,
#        for shrinking the board PNGs; without it they are several hundred KB each)
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
GW_JS=$(cd "$HERE/../.." && pwd)/bin/gw.js
PORT=${GW_SHOT_PORT:-7791}
[ "$PORT" = 7777 ] && { echo "refusing port 7777" >&2; exit 1; }
if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
  echo "port $PORT is in use; set GW_SHOT_PORT to a free one" >&2
  exit 1
fi

DEMO=$("$HERE/demo-board.sh")
unset CLAUDECODE AI_AGENT CURSOR_AGENT GW_ACTOR GW_ROOT
(cd "$DEMO" && exec node "$GW_JS" serve --port "$PORT") >/dev/null 2>&1 &
SERVE=$!
trap 'kill $SERVE 2>/dev/null || true; rm -rf "$DEMO"' EXIT
for _ in $(seq 50); do
  (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null && break
  sleep 0.1
done

node "$HERE/capture-board.mjs" "http://127.0.0.1:$PORT/" "$HERE"
"$HERE/capture-terminal.sh" "$HERE"

# 256 colours without dithering keeps text crisp and the board PNGs near
# 200 KB instead of 600-900 KB; the terminal PNGs are small already and keep
# their alpha channel intact.
if command -v magick >/dev/null; then
  for f in board overview stages item-detail; do
    magick "$HERE/$f.png" -strip +dither -colors 256 \
      -define png:compression-level=9 -define png:compression-filter=5 "$HERE/$f.png"
  done
fi
ls -l "$HERE"/*.png
