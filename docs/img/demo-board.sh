#!/usr/bin/env bash
# Builds the demo board used for the README screenshots, through the real CLI
# only (never by writing .gatewright/ files). The project is a made-up small
# uptime monitor, "Beacon", worked by two people and two coding agents on the
# team pipeline.
#
# usage: docs/img/demo-board.sh [dir]     (default: a fresh mktemp -d)
# prints the directory it built, last, on stdout.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
GW_JS=${GW_JS:-$HERE/../../bin/gw.js}
DIR=${1:-$(mktemp -d /tmp/gw-demo-XXXX)}

# A coding-agent session exports these; left set, every write below would be
# recorded as that agent instead of the actor named with --by.
unset CLAUDECODE AI_AGENT CURSOR_AGENT GW_ACTOR GW_ROOT

cd "$DIR"
git init -q
# Each call runs on a clock set back by $ago minutes (see demo-clock.mjs), and
# the clock moves forward between calls, so the history spans about two
# weeks in the order it is written, rather than all landing in one second.
ago=$((14 * 24 * 60)); tick=0
clock() {
  tick=$((tick + 1))
  ago=$((ago - 120 - (tick * 37) % 160))
  [ "$ago" -lt 20 ] && ago=20
  export GW_DEMO_CLOCK_MS=$((ago * 60 * 1000))
}
gwjs() { clock; node --import "$HERE/demo-clock.mjs" "$GW_JS" "$@"; }
gw() { gwjs "$@" >/dev/null; }
# add <var> <args...>: create an item and keep its id in $<var>.
add() { local var=$1; shift; clock; printf -v "$var" %s "$(node --import "$HERE/demo-clock.mjs" "$GW_JS" add "$@")"; }
MAYA=(--by human:maya)
JONAS=(--by human:jonas)
CLAUDE=(--by agent:claude)
CODEX=(--by agent:codex)
PR=https://github.com/beacon-hq/beacon/pull

gw init --pipeline team --yes --no-input --no-hook

# walk <id> <actor-flags...> -- <stage> [<stage> ...]: one move per stage, in
# pipeline order, the way the work really happened. Evidence rides on the
# stage that needs it, via the E_<stage> variables set just before the call.
walk() {
  local id=$1; shift
  local by=()
  while [ "$1" != "--" ]; do by+=("$1"); shift; done; shift
  for stage in "$@"; do
    local var="E_$stage" ev=()
    if [ -n "${!var:-}" ]; then
      IFS='|' read -ra list <<<"${!var}"
      for e in "${list[@]}"; do ev+=(--evidence "$e"); done
    fi
    gw move "$id" "$stage" "${ev[@]}" "${by[@]}"
  done
}
reset_ev() { unset E_built E_in_review E_reviewed E_merged E_verified; }

# A decision, settled and verified.
add ADR "Store check results in SQLite, not Postgres" --phase P0 --type decision --priority P0 \
  --scope "One file on disk, no server to run: a self-hosted monitor must install in one command. ADR records the write-rate ceiling we accept." "${MAYA[@]}"
gw claim "$ADR" "${MAYA[@]}"
reset_ev
E_built="docs/adr/0003-sqlite.md|3f9c2e1"
E_in_review="$PR/12"
E_verified="bench/write-rate.md: 4,800 inserts/s on a Pi 4|$PR/12#pullrequestreview-2011"
walk "$ADR" "${MAYA[@]}" -- building built in_review reviewed merged verified
gw note "$ADR" "Benchmarked WAL mode on a Raspberry Pi 4: 4,800 inserts/s, forty times what 500 checks a minute needs." "${MAYA[@]}"

# The check worker, a parent with three children.
add WORKER "HTTP check worker" --phase P1 --type feature --priority P0 \
  --scope "Runs every enabled check on its interval, records status, latency and error, and never lets one slow endpoint delay the others." "${JONAS[@]}"
gw claim "$WORKER" "${JONAS[@]}"
gw move "$WORKER" building "${JONAS[@]}"
gw note "$WORKER" "Split into three children so the retry and timeout work can land separately." "${JONAS[@]}"

add RETRY "Retry failed checks with exponential backoff" --parent "$WORKER" --phase P1 --type feature --priority P1 \
  --scope "A failed check retries after 2s, 4s and 8s before it counts as down; a success resets the counter." "${JONAS[@]}"
gw claim "$RETRY" "${JONAS[@]}"
reset_ev
E_built="a41d7b0|test/worker/retry.test.ts"
E_in_review="$PR/18"
E_verified="staging: 3 forced 503s recovered on the 2nd retry|grafana: zero false downs over 48h"
walk "$RETRY" "${JONAS[@]}" -- building built in_review reviewed merged verified

add TIMEOUT "Per-check timeout, default 10 seconds" --parent "$WORKER" --phase P1 --type feature --priority P1 \
  --scope "Each check aborts at its own timeout (default 10s) and is recorded as down with reason 'timeout'." "${JONAS[@]}"
gw claim "$TIMEOUT" "${CODEX[@]}"
reset_ev
E_built="c7e0922|test/worker/timeout.test.ts"
E_in_review="$PR/21"
walk "$TIMEOUT" "${CODEX[@]}" -- building built in_review reviewed merged

add PCTL "Record response time percentiles per check" --parent "$WORKER" --phase P1 --type feature --priority P2 \
  --scope "Store p50, p95 and p99 latency per check per hour; the status page reads the hourly rows, never raw results." "${CODEX[@]}"
gw triage "$PCTL" --approve "${MAYA[@]}"
gw claim "$PCTL" "${CODEX[@]}"
gw move "$PCTL" building "${CODEX[@]}"
gw note "$PCTL" "Using a t-digest per hour rather than keeping raw samples: 2 KB a check a day instead of 170 KB." "${CODEX[@]}"

# Status page, in review.
add STATUS "Public status page shows current incidents" --phase P1 --type feature --priority P0 \
  --scope "GET /status renders every public check with its last 90 days, and any open incident at the top, in under 200 ms." "${MAYA[@]}"
gw claim "$STATUS" "${MAYA[@]}"
reset_ev
E_built="e18b4a6|test/web/status-page.test.ts"
E_in_review="$PR/24"
walk "$STATUS" "${MAYA[@]}" -- building built in_review

# Timezone defect, reviewed.
add TZ "Status page shows times in UTC, not the visitor's timezone" --phase P1 --type defect --priority P1 \
  --scope "Every timestamp on /status renders in the browser's timezone, with UTC on hover." "${JONAS[@]}"
gw claim "$TZ" "${JONAS[@]}"
reset_ev
E_built="5d02f3c|test/web/timezone.test.ts"
E_in_review="$PR/26"
walk "$TZ" "${JONAS[@]}" -- building built in_review reviewed
gw note "$TZ" "Reported by a user in Auckland: incidents looked like they happened tomorrow." "${JONAS[@]}"

# Email alerts, built, depending on the retry work.
add EMAIL "Email an alert when a check fails twice in a row" --phase P1 --type feature --priority P0 \
  --scope "Two consecutive failures send one email to the check's contacts; recovery sends one 'resolved' email. No repeats while it stays down." "${CLAUDE[@]}"
gw triage "$EMAIL" --approve "${MAYA[@]}"
gw edit "$EMAIL" --deps "$RETRY" "${MAYA[@]}"
gw claim "$EMAIL" "${CLAUDE[@]}"
reset_ev
E_built="9ab61fe|test/alerts/email.test.ts|test/alerts/no-repeat.test.ts"
walk "$EMAIL" "${CLAUDE[@]}" -- building built
gw note "$EMAIL" "Deduplication keys on (check id, incident id) so a flapping check cannot send a burst." "${CLAUDE[@]}"
gw note "$EMAIL" "Opening the PR once the status page merges; both touch the incident model." "${CLAUDE[@]}"

# An integration test an agent is writing.
add DNS "Integration test: the worker survives a DNS outage" --phase P1 --type test --priority P1 \
  --scope "With the resolver returning SERVFAIL for 60s, the worker marks affected checks down, keeps others running, and recovers without a restart." "${MAYA[@]}"
gw claim "$DNS" "${CLAUDE[@]}"
gw move "$DNS" building "${CLAUDE[@]}"

# Alert routing is still in the backlog, so Slack alerts are blocked on it.
add ROUTING "Alert routing rules per check" --phase P1 --type feature --priority P1 \
  --scope "Each check names which contacts and channels hear about it; unrouted checks fall back to the project owner." "${MAYA[@]}"
add SLACK "Slack alerts through an incoming webhook" --phase P1 --type feature --priority P1 \
  --scope "A Slack channel can be a contact: failures and recoveries post one message each, threaded per incident." "${JONAS[@]}"
gw edit "$SLACK" --deps "$ROUTING" "${JONAS[@]}"
gw claim "$SLACK" "${JONAS[@]}"
gw move "$SLACK" building "${JONAS[@]}"
gw note "$SLACK" "Message formatting is done; waiting on routing rules to know which channel a check posts to." "${JONAS[@]}"

# Merged, waiting to be verified in production.
add LOGIN "Dashboard login with magic links" --phase P1 --type feature --priority P1 \
  --scope "Sign-in by emailed link valid for 15 minutes, single use; no passwords stored." "${MAYA[@]}"
gw claim "$LOGIN" "${CODEX[@]}"
reset_ev
E_built="71c3d88|test/auth/magic-link.test.ts"
E_in_review="$PR/15"
walk "$LOGIN" "${CODEX[@]}" -- building built in_review reviewed merged

# Docs, verified.
add GUIDE "Self-hosting guide: Docker and systemd" --phase P1 --type doc --priority P2 \
  --scope "docs/self-hosting.md takes a new user from nothing to a running monitor with Docker or systemd, both tested on a clean VM." "${MAYA[@]}"
gw claim "$GUIDE" "${MAYA[@]}"
reset_ev
E_built="docs/self-hosting.md|b2204c7"
E_in_review="$PR/11"
E_verified="fresh Debian 12 VM: Docker path in 6 min|fresh Debian 12 VM: systemd path in 9 min"
walk "$GUIDE" "${MAYA[@]}" -- building built in_review reviewed merged verified

# P2 — later work in the backlog.
add MAINT "Maintenance windows silence alerts" --phase P2 --type feature --priority P2 "${MAYA[@]}"
add HEARTBEAT "Heartbeat checks for cron jobs" --phase P2 --type feature --priority P2 \
  --scope "A job pings /hb/<token>; no ping within its grace period opens an incident." "${JONAS[@]}"
add BADGE "Badge SVG for READMEs" --phase P2 --type feature --priority P3 "${JONAS[@]}"

# An agent-created item held for approval.
add PRUNE "Cap stored raw results at 30 days and prune nightly" --phase P2 --type feature --priority P1 \
  --scope "A nightly job deletes raw results older than 30 days; hourly percentiles are kept forever." "${CODEX[@]}"
gw note "$PRUNE" "Filed while working on percentiles: raw results grow 40 MB a month per 100 checks." "${CODEX[@]}"

# A quick capture nobody has classified yet.
add CAPTURE "Checks page is slow with 300+ checks" "${MAYA[@]}"

# This week: progress on the work in flight, so every owner has recent activity.
gw note "$PCTL" "p95 and p99 match a raw-sample baseline within 2% on a week of staging data." "${CODEX[@]}"
gw note "$STATUS" "Review asked for the 90-day bars to be keyboard-focusable; pushed a fix to the PR." "${MAYA[@]}"
gw note "$DNS" "Test uses a stub resolver on 127.0.0.2; runs in 4s, no network needed." "${CLAUDE[@]}"
gw note "$TZ" "Approved; merging after the release branch is cut." "${JONAS[@]}"
gw note "$WORKER" "Retry landed; timeout merged. Percentiles are the last child open." "${JONAS[@]}"
gw note "$EMAIL" "Status page is close to merging; rebasing on it next." "${CLAUDE[@]}"
gw note "$SLACK" "Threading works against a test workspace. Still waiting on routing rules." "${JONAS[@]}"
printf '%s\n' "$DIR"
