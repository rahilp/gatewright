# Gatewright — Tasks

**Status:** Draft v0.2 · **Date:** 2026-09-14 (decisions D1–D6 closed)

Written in the tracker's own shape so `gw import --format md` can ingest this file once v0.1 exists. Phase = version. Gate G0 = must land before the version is called done. Type is one of decision, feature, test, doc.

Format per item: `ID · title · type · gate · deps · done when`.

## P0 — decisions before code

All closed 2026-09-14. Rationale in `PRD.md` § Decisions.

- **P0-01** · Item ID scheme · decision · G0 · — · **Decided:** phase-seq (`P2-01`, children `P2-01.1`); an item that changes phase keeps its ID. Recorded in `specs.md` §2 and `config.json.id_scheme`. ✅
- **P0-02** · License · decision · G0 · — · **Decided:** MIT. LICENSE lands with P1-01. ✅
- **P0-03** · Package name and domain · decision · G0 · — · **Decided:** `gatewright@0.0.1` placeholder published, `gatewright.dev` registered, `bin` exposes both `gw` and `gatewright` so a PATH collision on `gw` never blocks anyone. ✅
- **P0-04** · Default stages for `init` · decision · G0 · — · **Decided:** `templates/stages.json` ships the eight-stage default (Backlog → Specified → Building → Built → In review → Reviewed → Merged → Verified) with `auto` flags set per `design.md`. ✅
- **P0-05** · Read-only board delivery · decision · G0 · — · **Decided:** `gw open` writes a snapshot with data inlined as JSON blocks; no `file://` fetch, no File System Access API, `serve` is the only write path. Recorded in `specs.md` §7. ✅

## P1 — v0.1 · CLI core, read-only board, import

- **P1-01** · Repo scaffold · feature · G0 · P0-02, P0-03 · `package.json` with `bin`, no deps, `node --test` runs, CI on push.
- **P1-02** · `store.js`: load/save items, append events · feature · G0 · P0-01 · Atomic write via temp+rename; lock file with retry; unit tests for concurrent appends.
- **P1-03** · `rules.js`: `requires` evaluation · feature · G0 · P1-02 · All four rule keys implemented; dep cycle detection; tests for each rule passing and failing.
- **P1-04** · `init` · feature · G0 · P1-02, P0-04 · Creates `.gatewright/` from templates, writes AGENTS.md block (fenced), detects and updates CLAUDE.md, `.cursor/rules`, copilot-instructions. Idempotent. `--force` replaces the block.
- **P1-05** · `add` · feature · G0 · P1-02 · Assigns ID, validates parent, prints only the ID to stdout, appends event.
- **P1-06** · `claim` / `release` · feature · G0 · P1-02 · Sets/clears owner; refuses claim if owned by someone else without `--force`.
- **P1-07** · `move` · feature · G0 · P1-03 · Enforces next-stage-only, evaluates target `requires`, prints each failed rule; `--force` bypasses ordering but never `requires`.
- **P1-08** · `note` · feature · G0 · P1-02 · Appends to notes with timestamp line; event recorded.
- **P1-08a** · `edit` · feature · G0 · P1-02 · Per `specs.md` §6.5: vocab-validated, deps re-checked for cycles, all-or-nothing, one `edit` event listing changed keys. Refuses GitHub-owned fields on a linked item with the issue URL in the message (test with a fixture item carrying `gh`, even though sync is v0.3).
- **P1-09** · `brief` · feature · G0 · P1-02 · Renders the fixed layout in `specs.md` §6.1; hard cap on lines with `(+n more)`; `--me` filters dispatched/in-flight; `--json` variant.
- **P1-10** · `check` · feature · G0 · P1-03 · Reports rule violations, bad deps, cycles, stale owners (`config.check.stale_days`); exit 1 on any.
- **P1-10a** · Out-of-band write detection · feature · G0 · P1-02, P1-10 · `store` writes `.gatewright/.digest` (SHA-256 of `items.jsonl` + ts) after every write; `check` compares, reports `items.jsonl modified outside gw since <ts>` once, then re-baselines. Missing digest is written silently, not reported. Tests: hand edit → reported once, clean on the second run; fresh clone with a committed digest → clean.
- **P1-11** · `show` / `list` · feature · G0 · P1-02 · Plain and `--json` output.
- **P1-12** · `import --format md` · feature · G0 · P1-05 · Imports this file's item format with stage, deps, evidence, notes, refs intact; a 100-item fixture round-trips.
- **P1-13** · Viewer shell: read-only board and table from injected data · feature · G0 · P1-02 · Reads the four `<script type="application/json">` blocks per `specs.md` §7 — never fetches. Columns from `stages.json`, filters, item panel read-only with a banner naming the `gw` command, Stages & rules tab, snapshot timestamp in the header, JSON export. No network.
- **P1-13a** · `gw open` · feature · G0 · P1-13 · Injects items/events/stages/config into the pinned shell, escapes `</` inside strings, writes `.gatewright/board.html`, opens the default browser (`--no-browser` skips). Acceptance: `gw open` in a fresh repo renders the board in Chrome, Firefox and Safari with the network disabled; a title containing `</script>` does not break the page.
- **P1-14** · `upgrade` · feature · G0 · P1-13 · Replaces the viewer shell and refreshes the AGENTS.md block; leaves `prompt.md` alone unless `--templates`; data files byte-identical (test).
- **P1-15** · `GW_ACTOR` env handling · feature · G0 · P1-05 · `--by` defaults from env then `human:$USER`.
- **P1-16** · Test: brief token budget · test · G0 · P1-09, P1-12 · On the 100-item fixture, `brief` output ≤25 lines and ≤500 tokens (approximate by chars/4).
- **P1-17** · README with 60-second quickstart · doc · G0 · P1-04 · Install, init, brief, add, move, `gw open`. Screenshot from the fixture data.
- **P1-18** · Dogfood: Gatewright tracks itself · test · G0 · P1-12, P1-13 · This `tasks.md` is imported into `.gatewright/` and used for a full week; gaps filed as items.
- **P1-19** · `import --format csv|json` · feature · G1 · P1-12 · Common export shapes from other trackers.
- **P1-20** · Publish v0.1 to npm · feature · G0 · P1-16, P1-17, P1-18, P1-13a, P1-10a · `npx gatewright init` works in a fresh repo; both `gw` and `gatewright` are on PATH after install.

## P2 — v0.2 · serve, board write-back, play/stop events

- **P2-01** · `serve`: static viewer + `/api/state` · feature · G0 · P1-13 · Loopback only; rejects non-loopback origin; `--open` launches browser.
- **P2-02** · Write endpoints through `store` · feature · G0 · P2-01 · add, edit, move, note; move uses `rules.js`; every write appends an event.
- **P2-03** · Viewer: editors enabled under serve · feature · G0 · P2-02 · Stage buttons disabled with reason when `requires` fails; evidence/notes editable; create item form.
- **P2-04** · Viewer: Play and Stop on cards · feature · G0 · P2-02 · Play appends `dispatch` by `human:<name>`; Stop appends `cancel`. No runner yet; `brief` surfaces dispatched items.
- **P2-05** · Viewer: 2s polling for live state · feature · G0 · P2-01 · Changes from CLI appear on the board without reload.
- **P2-06** · Global pause/resume · feature · G1 · P2-02 · Toggles `runner.paused` in config; banner on board.
- **P2-07** · Default `prompt.md` template · feature · G1 · P1-04 · Shipped by `init` into `.gatewright/prompt.md` (committed, user-editable, untouched by plain `upgrade`); placeholders per `specs.md` §5; documented.
- **P2-08** · Test: one write path · test · G0 · P2-02 · A move via API and via CLI produce identical item and event lines.
- **P2-09** · Publish v0.2 · feature · G0 · P2-03, P2-04, P2-08 · —

## P3 — v0.3 · GitHub sync

- **P3-01** · `gh` wrapper with dry-run · feature · G0 · P1-02 · Every `gh` call goes through one function; `--dry-run` prints instead of executing; missing/unauth'd `gh` gives a clear error.
- **P3-02** · Pull: issues → items, GitHub-owned fields only · feature · G0 · P3-01 · Label map from config; milestone → gate; new open issues create backlog items with `created_by: github`; `last_sync` stored.
- **P3-03** · Conflict flag on closed-while-open · feature · G0 · P3-02 · Closed issue with non-terminal item → `flag: conflict`, event, stage untouched; shown in brief and board.
- **P3-04** · `agent/go` → dispatch · feature · G0 · P3-02 · Label produces dispatch event once and is removed.
- **P3-05** · Push: move comments · feature · G0 · P3-01 · One-line comment per move on linked issues; queued when serve isn't running, flushed on next sync.
- **P3-06** · Push: close on `close_on` stage · feature · G0 · P3-05 · —
- **P3-07** · `mirror_children` · feature · G1 · P3-02 · Agent-created child of a linked parent gets its own issue with provenance line.
- **P3-08** · `init --gh` · feature · G0 · P3-01 · Enables github block, writes default label map, runs `gh auth status`.
- **P3-09** · Sync in `serve` on interval · feature · G1 · P2-01, P3-02 · Configurable; off by default.
- **P3-10** · Test: sync never writes tracker-owned fields · test · G0 · P3-02 · Fixture with local stage/evidence; sync with changed labels; stage/evidence unchanged.
- **P3-11** · Publish v0.3 · feature · G0 · P3-04, P3-06, P3-10 · —

## P4 — v0.4 · scheduler, worktrees, runner, triage, adapters

- **P4-01** · Item tree fields: `parent`, `created_by`; brief and board show children · feature · G0 · P1-05 · Children nest under parent on board; brief shows "n open children".
- **P4-02** · `needs-triage` on agent-created items; `triage --approve|--drop` · feature · G0 · P4-01 · Held items not scheduler-eligible; board has approve/drop; `auto_dispatch_children` bypass.
- **P4-03** · `max_children_per_item` enforcement · feature · G0 · P4-01 · 11th child with cap 10 refused at `add`.
- **P4-04** · Scheduler loop: eligibility and pick order · feature · G0 · P2-02 · Implements `specs.md` §10 steps 1–4; unit-tested against fixture states.
- **P4-05** · Worktree create/reuse per item · feature · G0 · P4-04 · `git worktree add` on branch `gw/<id>`; reuse if present; gitignored root.
- **P4-06** · Spawn provider with rendered prompt, env, log · feature · G0 · P4-05, P2-07 · `GW_ACTOR`, `GW_ITEM`, `GW_ROOT` set; stdout+stderr to `runs/`; `run_started`/`run_ended` events.
- **P4-07** · Stop: SIGTERM → SIGKILL, Paused with last commit · feature · G0 · P4-06 · Hung fake process killed within `stop_timeout_s` in test; worktree intact.
- **P4-08** · Resume with log tail · feature · G0 · P4-07 · Prompt contains last N lines; stage restored from `prev_stage`.
- **P4-09** · `run_timeout_min` · feature · G0 · P4-06 · Same path as stop, outcome `timeout`.
- **P4-10** · `gw stop --all` · feature · G0 · P4-07 · Terminates all runs, sets `paused: true`, works without serve's browser.
- **P4-11** · Viewer: run log tail, Resume, triage buttons · feature · G0 · P4-06, P4-02 · —
- **P4-12** · Providers config: claude, codex, custom · feature · G0 · P4-06 · Each spawns correctly in a smoke test with a stub binary.
- **P4-13** · Adapter: Claude Code plugin with SessionStart hook · feature · G0 · P1-09 · Installs with one command; `gw brief` runs at session start.
- **P4-14** · Adapter: Cursor rules file · feature · G1 · P1-04 · —
- **P4-15** · Adapter: Codex and generic docs · doc · G1 · P1-04 · —
- **P4-16** · `gw gc` for worktrees · feature · G1 · P4-05 · Removes worktrees for Merged/Verified/Dropped items.
- **P4-17** · Test: overnight queue · test · G0 · P4-04, P4-10 · Five eligible items, `max_concurrent: 2`, stub provider; all complete; events consistent; no orphan processes.
- **P4-18** · Test: runaway guard · test · G0 · P4-02, P4-03 · Stub agent that adds children in a loop; board ends with cap-many held items and no auto-runs.
- **P4-19** · Publish v0.4 · feature · G0 · P4-17, P4-18, P4-13 · —

## P5 — v0.5 · memory backend (optional)

- **P5-01** · Memory transport decision · decision · G0 · — · MCP-over-HTTP client vs plain HTTP API for the Second Brain adapter, recorded in `specs.md` §14.
- **P5-02** · `memory/provider.js` interface and loader · feature · G0 · P4-06 · `recall`, `remember`, `capsule`; not loaded when disabled; missing module → warning, treated as disabled; 5s timeout wrapper.
- **P5-03** · `config.memory` block in templates and validation · feature · G0 · P5-02 · Token read from `token_env` only; config with a literal token is refused by `check`.
- **P5-04** · Recall into dispatch prompt · feature · G0 · P5-02, P2-07 · `{{prior_context}}` filled from top-k hits, trimmed to `max_chars`; empty when disabled or on failure; run never blocked.
- **P5-05** · Capsule prefix · feature · G1 · P5-02 · `{{capsule}}` from `project_id`; byte-stable across runs.
- **P5-06** · Remember on `run_ended: ok` · feature · G0 · P5-02 · One deterministic line per §14; tags include repo, type, phase; capped at `max_chars`.
- **P5-07** · Remember on close; canonical for decisions · feature · G0 · P5-06 · Verified `decision` items stored canonical, volatility durable.
- **P5-08** · `brief --recall` · feature · G1 · P5-02, P1-09 · "Related memory" section within the line cap; plain `brief` makes no calls (test).
- **P5-09** · Second Brain adapter · feature · G0 · P5-01, P5-02 · `adapters/second-brain/memory.js`; configure in under a minute per README; smoke test against a stub server.
- **P5-10** · Test: memory never blocks · test · G0 · P5-04, P5-06 · Stub provider that hangs and one that throws; runs start and end normally; warnings in `runs/memory.log`.
- **P5-11** · Test: exactly one remember per event · test · G0 · P5-06, P5-07 · Fixture run + close → two calls total, content matches template.
- **P5-12** · Docs: memory section in README, "what gets stored" table · doc · G0 · P5-09 · Users can tell before enabling what will be written to their brain.
- **P5-13** · Dogfood: enable on the Gatewright repo for two weeks · test · G0 · P5-09 · Compare recall quality before and after; decide default for `on_run_ok`.
- **P5-14** · Publish v0.5 · feature · G0 · P5-10, P5-11, P5-12, P5-13 · —

## Parking lot (not scheduled)

- Rebuild `items.jsonl` from events.
- `events.jsonl` rotation.
- Multi-repo aggregation.
- Websocket instead of polling.
- Metrics: cycle time per stage, agent vs human moves.
