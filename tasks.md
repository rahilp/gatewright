# Gatewright — Tasks

**Status:** Draft v0.2 · **Date:** 2026-09-14 (decisions D1–D6 closed) · **Revised:** 2026-09-20 (T-0139 — P0-03 and P1-20 marked shipped, P1-10a and P1-12 corrected, P7 added)

Written in the tracker's own shape so `gw import --format md` can ingest this file once v0.1 exists. Phase = version. Gate G0 = must land before the version is called done. Type is one of decision, feature, test, doc.

Format per item: `ID · title · type · gate · deps · done when`.

## P0 — decisions before code

All closed 2026-09-14. Rationale in `PRD.md` § Decisions.

- **P0-01** · Item ID scheme · decision · G0 · — · **Decided:** phase-seq (`P2-01`, children `P2-01.1`); an item that changes phase keeps its ID. **Reversed in v0.11 (recorded 2026-09-20):** the default `id_scheme` is `seq` (`T-0001`, children `T-0001.1`); `phase-seq` remains available and is unchanged for boards that chose it, and the keeps-its-ID rule holds under both. `phase-seq` made phase a precondition of having an id, so a bare capture and an unlabelled issue were silently given `P0`. See `PRD.md` D3a; recorded in `specs.md` §2 and §6.3, and `config.json.id_scheme`. ✅
- **P0-02** · License · decision · G0 · — · **Decided:** MIT. LICENSE lands with P1-01. ✅
- **P0-03** · Package name and domain · decision · G0 · — · **Decided:** name `gatewright`, `gatewright.dev` registered, `bin` exposes both `gw` and `gatewright` so a PATH collision on `gw` never blocks anyone. The npm open item is closed: published 2026-09, `gatewright@0.13.2` is the `latest` tag, and the name is claimed. No longer blocks P1-20. ✅
- **P0-04** · Default stages for `init` · decision · G0 · — · **Decided:** `templates/stages.json` ships the eight-stage default (Backlog → Specified → Building → Built → In review → Reviewed → Merged → Verified) with `auto` flags set per `design.md`. **Superseded twice (recorded 2026-09-20):** in v0.11 `Specified` was removed and its scope rule moved to `Built`, leaving seven — rigor belongs where completion is claimed, not where an idea is written down. And since v0.8 `init` does not write one fixed pipeline at all: it writes a preset, `solo` (backlog → building → done) or `team` (the seven above), chosen by `--pipeline`, by the terminal question, or by whether the checkout has a GitHub origin. Solo is the default. See `specs.md` §4.3. ✅
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
- **P1-08a** · `edit` · feature · G0 · P1-02 · Per `specs.md` §6.7: vocab-validated, deps re-checked for cycles, all-or-nothing, one `edit` event listing changed keys. Refuses GitHub-owned fields on a linked item with the issue URL in the message (test with a fixture item carrying `gh`, even though sync is v0.3).
- **P1-09** · `brief` · feature · G0 · P1-02 · Renders the fixed layout in `specs.md` §6.1; hard cap on lines with `(+n more)`; `--me` filters dispatched/in-flight; `--json` variant.
- **P1-10** · `check` · feature · G0 · P1-03 · Reports rule violations, bad deps, cycles, stale owners (`config.check.stale_days`); exit 1 on any.
- **P1-10a** · Out-of-band write detection · feature · G0 · P1-02, P1-10 · `store` writes `.gatewright/.digest` (SHA-256 of `items.jsonl`, `stages.json` and `config.json`, plus ts) after every write; `check` compares and reports `items.jsonl modified outside gw since <ts>`. A missing digest is written silently, not reported. **Changed in v0.12 (recorded 2026-09-20):** the "report once, then re-baseline" half of this task is reversed. A stale digest stays stale on every subsequent run until a legitimate `gw` write restores it, or `gw repair --write --force` re-baselines it deliberately after review — re-baselining is an acknowledgement, and a check that acknowledges what it found has blessed it. Tests: hand edit → reported on every run until accepted; fresh clone with a committed digest → clean. ✅
- **P1-11** · `show` / `list` · feature · G0 · P1-02 · Plain and `--json` output.
- **P1-12** · `import --format md` · feature · G0 · P1-05 · Imports this file's item format with stage, deps, evidence, notes, refs intact; a 100-item fixture round-trips. **Corrected 2026-09-20 (T-0134):** "notes, refs intact" was the requirement and was not the behaviour — all three importers dropped both, CSV read a `notes` column and then threw it away, and PRD R8 made the same promise. They are carried through now in md, CSV and JSON, with CSV aliasing `note`/`comments` → notes and `ref`/`references` → refs. ✅
- **P1-13** · Viewer shell: read-only board and table from injected data · feature · G0 · P1-02 · Reads the four `<script type="application/json">` blocks per `specs.md` §7 — never fetches. Columns from `stages.json`, filters, item panel read-only with a banner naming the `gw` command, Stages & rules tab, snapshot timestamp in the header, JSON export. No network.
- **P1-13a** · `gw open` · feature · G0 · P1-13 · Injects items/events/stages/config into the pinned shell, escapes `</` inside strings, writes `.gatewright/board.html`, opens the default browser (`--no-browser` skips). Acceptance: `gw open` in a fresh repo renders the board in Chrome, Firefox and Safari with the network disabled; a title containing `</script>` does not break the page.
- **P1-14** · `upgrade` · feature · G0 · P1-13 · Replaces the viewer shell and refreshes the AGENTS.md block; leaves `prompt.md` alone unless `--templates`; data files byte-identical (test).
- **P1-15** · `GW_ACTOR` env handling · feature · G0 · P1-05 · `--by` defaults from env then `human:$USER`.
- **P1-16** · Test: brief token budget · test · G0 · P1-09, P1-12 · On the 100-item fixture, `brief` output ≤25 lines and ≤500 tokens (approximate by chars/4).
- **P1-17** · README with 60-second quickstart · doc · G0 · P1-04 · Install, init, brief, add, move, `gw open`. Screenshot from the fixture data.
- **P1-18** · Dogfood: Gatewright tracks itself · test · G0 · P1-12, P1-13 · This `tasks.md` is imported into `.gatewright/` and used for a full week; gaps filed as items.
- **P1-19** · `import --format csv|json` · feature · G1 · P1-12 · Common export shapes from other trackers.
- **P1-20** · Publish v0.1 to npm · feature · G0 · P1-16, P1-17, P1-18, P1-13a, P1-10a · `npx gatewright init` works in a fresh repo; both `gw` and `gatewright` are on PATH after install. Published; the registry has carried every release from 0.1.0 and `latest` is now 0.13.2. ✅

## P2 — v0.2 · serve, board write-back, play/stop events

- **P2-01** · `serve`: static viewer + `/api/state` · feature · G0 · P1-13 · Loopback only; rejects non-loopback origin; `--open` launches browser. **Extended in v0.7:** `--host` binds another address and widens which hosts the server answers on; rewriting the rules of the board stays loopback-only regardless (`specs.md` §8).
- **P2-02** · Write endpoints through `store` · feature · G0 · P2-01 · add, edit, move, note; move uses `rules.js`; every write appends an event.
- **P2-03** · Viewer: editors enabled under serve · feature · G0 · P2-02 · Stage buttons disabled with reason when `requires` fails; evidence/notes editable; create item form.
- **P2-04** · Viewer: Play and Stop on cards · feature · G0 · P2-02 · Play appends `dispatch` by `human:<name>`; Stop appends `cancel`. No runner yet; `brief` surfaces dispatched items.
- **P2-05** · Viewer: 2s polling for live state · feature · G0 · P2-01 · Changes from CLI appear on the board without reload.
- **P2-06** · Global pause/resume · feature · G1 · P2-02 · Toggles `runner.paused` in config; banner on board.
- **P2-07** · Default `prompt.md` template · feature · G1 · P1-04 · Shipped by `init` into `.gatewright/prompt.md` (committed, user-editable, untouched by plain `upgrade`); placeholders per `specs.md` §10.3 (this line read "§5", which is `config.json` and has never described the prompt); documented.
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
- **P5-04** · Recall into dispatch prompt · feature · G0 · P5-02, P2-07 · `{{prior_context}}` filled from top-k hits, trimmed to `max_chars`; empty when disabled or on failure; run never blocked. The "Prior context" heading stays even when the value is empty, and the template says what an empty one means (see PRD R25); the value itself is fenced as data per `specs.md` §10.3.
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

## P6 — v0.6 · Windows support

CI runs windows-latest and 12 of 295 tests fail there. The README promises Node 18+ with no OS caveat, so either the promise or the support has to change; we are changing the support.

- **P6-01** · Line endings are contractual · feature · G0 · — · `.gitattributes` forces LF for templates and the instruction block; `init` writes LF on every platform; the byte-exact template tests pass on Windows. Done when a board initialised on Windows and checked out on Linux produces no `gw check` out-of-band report.
- **P6-02** · Path comparison is normalised · feature · G0 · — · Every comparison against an OS-produced path normalises first (git emits forward slashes on Windows; `path.join` emits backslashes). Covers worktree reuse, root discovery and the structural greps.
- **P6-03** · Windows process termination · feature · G0 · P6-02 · `taskkill /T` then `/T /F` after `stop_timeout_s`, reaching the whole tree in place of a process group. Graceful-then-forceful preserved as far as Windows allows, per specs §10.2.
- **P6-04** · Windows liveness and pid-reuse guard · feature · G0 · P6-03 · Liveness from the OS process list; reuse guarded by recorded start time rather than `/proc/<pid>/cwd`. The weaker guarantee is documented, not hidden.
- **P6-05** · Runner tests pass on Windows · test · G0 · P6-03, P6-04 · overnight, crash-mid-drain and both runaway tests green on windows-latest.
- **P6-06** · Full suite green on windows-latest · test · G0 · P6-01, P6-02, P6-05 · All three platforms green in CI on Node 22 and 24.
- **P6-07** · Docs state the platform support honestly · doc · G0 · P6-06 · README names Windows as supported and specs §10.2 records where its guarantees are weaker.
- **P6-08** · Publish v0.6 · feature · G0 · P6-06, P6-07 · —

## P7 — v0.13.x · the audit sweep (2026-09-20)

Twelve items found by an audit of the shipped product against these four
documents, worked on branch `fix/audit-sweep`. Ids are the board's own (`seq`),
not phase-seq. P7 is not a released version: it is the sweep that closed the gap
between v0.13.2 and what was written down about it.

- **T-0128** · Fence untrusted text out of agent prompts; synced issues go through triage · defect · G0 · — · Every item-derived field is quoted between `<<<GW-DATA:name>>>` markers at substitution time, heading/fence/marker forgeries neutralised, per-field caps applied; `providerArgv` substitutes by callback so `$&` in a title cannot rewrite the argv; `gw sync` routes new items through `captureFlag`, so `policy.triage_required_for` can name `github`. `specs.md` §10.3, §4.3. ✅
- **T-0129** · Evidence gates reject the placeholder the refusal itself prints · defect · G0 · — · Both shipped pipelines gate the stage that claims completion (`built` on team, `done` on solo) on `ARTIFACT_EVIDENCE` as well as a count, so a sentence is not evidence; refusal advice prints an angle-bracketed placeholder that the gate rejects. `specs.md` §4. ✅
- **T-0130** · `serve`: localhost gets 403; host header misparsed · defect · G0 · — · A `Host` authority is parsed as a URL rather than split on `:`, IPv6 brackets are canonicalised, and a header carrying a scheme, path, userinfo or whitespace is refused outright. `localhost`, `--host <name>` and `[::1]` all answer; `attacker@localhost` and `evil.example` do not; admin routes stay loopback-only. `specs.md` §8.2. ✅
- **T-0131** · `last_commit` always null: worktree HEAD resolved in the private git dir · defect · G0 · — · Resolution goes through the worktree's `commondir`, including packed refs, so `run_ended` carries the run's own SHA and `resume` keeps it. `specs.md` §2. ✅
- **T-0132** · guard accepted commits naming finished items · defect · G0 · — · A commit whose only named ids are finished is refused in its own sentence, with reopen advice; a board-only commit under `guard.exempt_paths` still passes, `--range` still accepts a since-finished item, and the refusal never offers a finished id as its own example. `specs.md` §6.5. ✅
- **T-0133** · scheduler: quadratic tick, claim stealing, admission race, fatal async rejection · defect · G0 · — · One-pass dispatch index (2199ms → 5.8ms at 2,000 items / 100k events), admission compare-and-swap under the registry lock so no human claim is stolen and nothing is admitted twice, and a tick that throws or rejects can no longer kill `serve`. ✅
- **T-0134** · import drops notes and refs in all three formats · defect · G0 · P1-12 · md, CSV and JSON all carry notes and refs through, as PRD R8 and P1-12 always claimed; CSV gains the `note`/`comments` and `ref`/`references` aliases. ✅
- **T-0135** · events never compact; `gw open` inlines all of them · feature · G0 · — · `gw gc --events` moves finished items' history to `events-archive.jsonl` — archive appended before the rewrite, all of it under the board lock, a `compact` event recorded, nothing deleted. `gw open` and a no-cursor `/api/state` share the same partition; `--all-events` opts out. `specs.md` §6.10. ✅
- **T-0136** · durability and hygiene: fsync, stale adapter hook, missing gitignore · defect · G0 · — · `writeAtomic` fsyncs the file and its directory and `appendEvent` fsyncs; `init` writes the `.gatewright/.gitignore` §1 had claimed existed for a year; the Claude Code adapter ships the guard-capable probe and a version-synced `plugin.json`. `specs.md` §1, §13. ✅
- **T-0137** · `gw mcp`: the board as MCP tools · feature · G0 · — · Ten tools over a hand-written JSON-RPC 2.0 stdio transport, zero dependencies, every call through `lib/serve/invoke.js` into the same command modules, refusals byte-equal to the CLI's stderr, protocol `2025-06-18` accepting two older revisions, actor `agent:mcp` by default. Adapter registrations and `docs/mcp.md`. `specs.md` §6.9. ✅
- **T-0138** · `gw doctor` plus the first-five-minutes papercuts · feature · G0 · — · Twelve read-only checks, each naming the command that fixes it, exit 1 on any failure, `--json`, `--port` probing both `127.0.0.1` and `localhost`; plus `gw next` grammar and named stages, `gw show` rendering every absence as one em dash, and `gw list` gaining free text, `--owner` and `--limit`. `specs.md` §6.8, §6.11. ✅
- **T-0139** · Founding docs match the shipped product · doc · G0 · T-0128, T-0129, T-0130, T-0131, T-0132, T-0133, T-0134, T-0135, T-0136, T-0137, T-0138 · PRD, specs, design and tasks corrected against v0.13.2: the npm name, the `seq` default, `check` as audit rather than acknowledgement, `board.html` as a `gw open` artifact, the two pipeline presets, the real command and route surfaces, a regenerated module map, and the `--dry-run` promise marked unshipped rather than quietly deleted.

## Parking lot (not scheduled)

- **Markdown import assumes `## P<n>` phase headings.** Deliberate: the parser implements Gatewright's own documented `tasks.md` format, and accepting arbitrary phase tokens would turn a format contract into config-aware parsing. A mismatched file now exits 2 with the expected format rather than importing nothing in silence. Revisit only if people are actually importing from boards with other phase vocabularies. (A plain `- [ ]` / `- [x]` checklist is also accepted, anywhere in the file, since v0.9.)

- Rebuild `items.jsonl` from events. Still not built; the format still allows it.
- ~~`events.jsonl` rotation.~~ **Left the lot in v0.13:** shipped as `gw gc --events`, and as compaction rather than rotation — finished items' history moves to `events-archive.jsonl`, open items keep everything, nothing is deleted. It stopped being parkable when `gw open` started inlining 13 MB.
- Multi-repo aggregation.
- Websocket instead of polling.
- Metrics: cycle time per stage, agent vs human moves.
- **Split `viewer/board.html` into sources with an inliner.** It is authored as one self-contained file and is now the largest file in the repository. `design.md` named a `build-viewer.js` for years that was never written; recording the debt honestly is the first step, and it is nobody's blocker today.
