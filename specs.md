# Gatewright — Specifications

**Status:** Draft v0.2 · **Date:** 2026-09-14 (decisions D1–D6 closed)

This is the contract. If the code and this document disagree while work is in flight, the document wins and the code gets fixed (or the document is revised deliberately first). After acceptance, the tests are the contract and this becomes the record of why.

## 1. Layout on disk

```
.gatewright/
  items.jsonl        one item per line, current state
  events.jsonl       append-only log, one event per line
  stages.json        stage definitions and exit rules
  config.json        tool config: providers, labels, policy
  prompt.md          dispatch prompt template (v0.2); user-editable
  .digest            hash of items.jsonl after the last gw write
  board.html         viewer snapshot written by `gw open` and `gw serve`
  runs/              per-run logs (v0.4), gitignored by default
  .worktrees/        git worktrees for runs (v0.4), gitignored
```

Everything except `runs/` and `.worktrees/` is committed, `.digest` included — the out-of-band write check in §6.4 has to work in a fresh clone.

`board.html` is an installed artifact, never agent-written. The source lives at `viewer/board.html` in the package; `gw open` copies it and injects the current data (§7), and `upgrade` replaces the copied shell. It carries a version header comment that `upgrade` compares to the package version.

`prompt.md` is shipped by `init` from `templates/` and is expected to be edited. Plain `upgrade` never touches it; `upgrade --templates` replaces it and says so.

## 2. items.jsonl

One JSON object per line. Lines are rewritten in place on change (read all, mutate one, write all, atomic rename). Keep the file small enough that this is cheap; it's a tracker, not a database.

```json
{
  "id": "P2-01",
  "title": "Operation Enabled group readiness barrier before the plan clock starts",
  "phase": "P2",
  "priority": "P2",
  "gate": "G0",
  "type": "defect",
  "stage": "specified",
  "flag": null,
  "owner": null,
  "scope": "axes_ready and Ready→Active must require fresh per-axis OperationEnabled...",
  "deps": ["P2-12"],
  "evidence": [],
  "notes": "src/main.cpp:2396 and :3590 today check mode display, config, home lease only.",
  "refs": ["R01"],
  "parent": null,
  "created_by": "human",
  "gh": null,
  "created": "2026-09-11T10:00:00Z",
  "updated": "2026-09-11T10:00:00Z"
}
```

Field rules:

| Field | Type | Owner | Notes |
|---|---|---|---|
| `id` | string | tracker | Unique. Format set in config (`id_scheme`); default `phase-seq` → `P2-01`, children `P2-01.1`. Never reused, and never rewritten: an item that changes `phase` keeps the ID it was created with, because evidence links and the event log point at it. The prefix records where the item started, `phase` records where it is. |
| `title` | string | github if linked, else human/agent | ≤120 chars |
| `phase`, `priority`, `gate`, `type` | string | github if linked (via label map), else human/agent | Values are free-form but validated against `config.vocab` if present |
| `stage` | string | tracker | Must be a key in `stages.json` |
| `flag` | `null` \| `"blocked"` \| `"needs-triage"` \| `"paused"` \| `"conflict"` | tracker | One flag at a time. Blocked and needs-triage prevent scheduling. |
| `owner` | string \| null | tracker | `human:<name>` or `agent:<run-id>` |
| `scope` | string | github (body) if linked | What "done" means. Shown in dispatch prompt. |
| `deps` | string[] | human/agent | Item IDs. Cycles rejected on write. |
| `evidence` | string[] | agent/human | Commit SHAs, test paths, CI URLs, PR URLs. Free-form strings, validated by exit rules only. |
| `notes` | string | agent/human | Running notes. Checklists live here as markdown. |
| `refs` | string[] | human | Requirement IDs, ticket refs. Not interpreted. |
| `parent` | string \| null | tracker | Set by `add --parent`. |
| `created_by` | `"human"` \| `"github"` \| `"agent:<run-id>"` | tracker | Immutable |
| `gh` | object \| null | tracker | `{number, url, updated_at}` when linked |
| `created`, `updated` | ISO 8601 | tracker | |

"Owner" in the table means who is allowed to change it. `sync` may only write GitHub-owned fields. The CLI may only write tracker-owned and human/agent-owned fields.

## 3. events.jsonl

Append-only. Never rewritten. One line per event.

```json
{"ts":"2026-09-13T14:02:11Z","type":"move","item":"P2-01","from":"specified","to":"building","by":"agent:r-0042","evidence":[],"note":null}
```

Event types:

| type | fields | written by |
|---|---|---|
| `add` | item, by, parent | CLI |
| `edit` | item, by, fields (changed keys) | CLI, serve |
| `move` | item, from, to, by, evidence | CLI, serve |
| `claim` | item, by | CLI |
| `release` | item, by | CLI |
| `note` | item, by, note | CLI, serve |
| `flag` | item, flag, by, reason | CLI, serve, sync, scheduler |
| `dispatch` | item, by | serve (board play), sync (`agent/go` label), scheduler |
| `cancel` | item, by | serve (board stop), CLI (`stop`) |
| `run_started` | item, run, provider, worktree | scheduler |
| `run_ended` | item, run, outcome (`ok` \| `error` \| `cancelled` \| `timeout`), last_commit | scheduler |
| `sync` | pulled, pushed, conflicts | sync |
| `pause_all` / `resume_all` | by | serve, CLI |

`by` is always one of `human:<name>`, `agent:<run-id>`, `github`, `scheduler`, `sync`.

The event log is the source of truth for "what happened." `items.jsonl` is a materialised view that could be rebuilt from events plus the initial import. v0.1 doesn't implement the rebuild; the format allows it.

## 4. stages.json

```json
{
  "stages": [
    { "id": "backlog",   "label": "Backlog" },
    { "id": "specified", "label": "Specified",
      "exit": "Someone picks it up and starts changing code or the owning document.",
      "auto": true },
    { "id": "building",  "label": "Building",
      "exit": "Change is complete locally with tests passing.",
      "auto": true,
      "requires": { "owner": true } },
    { "id": "built",     "label": "Built",
      "exit": "Evidence recorded: commit and test path.",
      "auto": true,
      "requires": { "evidence_min": 1, "deps_at_least": "built" } },
    { "id": "in_review", "label": "In review",
      "exit": "PR opened and reviewer assigned.",
      "auto": true,
      "requires": { "evidence_match": "^https://github.com/.+/pull/\\d+" } },
    { "id": "reviewed",  "label": "Reviewed",
      "exit": "Reviewer approved.",
      "auto": false },
    { "id": "merged",    "label": "Merged",
      "exit": "PR merged to main.",
      "auto": false,
      "requires": { "deps_at_least": "merged" } },
    { "id": "verified",  "label": "Verified",
      "exit": "Behaviour confirmed on target; VALIDATION entry linked.",
      "auto": false,
      "requires": { "evidence_min": 2 } }
  ],
  "terminal": ["verified", "dropped"],
  "extra": [ { "id": "dropped", "label": "Dropped" }, { "id": "paused", "label": "Paused" } ]
}
```

Semantics:

- `exit` is the human-readable rule shown in the board and the brief. It has no machine meaning.
- `requires` is the machine-checked rule for **entering** the next stage. `gw move X <stage>` evaluates the `requires` block of the *target* stage. Keys:
  - `owner: true` — item must have an owner
  - `evidence_min: n` — at least n evidence entries
  - `evidence_match: regex` — at least one evidence entry matches
  - `deps_at_least: stage` — every dep must be at that stage or later (by list order)
- **Gates are cumulative.** To stand in stage N, an item must satisfy the `requires`
  of every pipeline stage up to and including N — not just N's own block. A single
  stage's `requires` is an entry gate for that stage; the pipeline as a whole is the
  claim. Without this, `gw move X merged --force` succeeds on an item with no owner
  and no evidence, because `merged` only requires `deps_at_least` and an item with no
  deps satisfies it vacuously. `move` evaluates cumulatively to the target, and
  `check` evaluates cumulatively to the item's current stage, so a card that skipped
  a gate is reported rather than blessed. `--force` skips stage ORDER; it has never
  been allowed to skip evidence, and cumulative evaluation is what makes that true
  for skips as well as for single steps.
- `auto: true` on a stage means: when an item is in the *previous* stage and eligible, the scheduler may start a run whose goal is to reach this stage. The human-gated stages are whatever has `auto: false`.
- `paused` and `dropped` are side states. `paused` remembers `prev_stage` in the item so resume can restore it.

Order in the array is the pipeline order. Users edit this file to change their process; nothing is hardcoded.

## 5. config.json

```json
{
  "version": 1,
  "id_scheme": "phase-seq",
  "vocab": {
    "phase": ["P0", "P1", "P2", "P3"],
    "priority": ["P0", "P1", "P2", "P3"],
    "gate": ["G0", "G1", "G2"],
    "type": ["decision", "defect", "feature", "test", "doc"]
  },
  "brief": { "max_lines": 25 },
  "check": { "stale_days": 7, "stale_exempt_stages": ["merged"] },
  "github": {
    "enabled": false,
    "repo": null,
    "dispatch_label": "agent/go",
    "mirror_children": false,
    "comment_on_move": true,
    "close_on": "verified",
    "labels": {
      "priority/P0": { "priority": "P0" },
      "type/defect": { "type": "defect" },
      "phase/2": { "phase": "P2" }
    },
    "milestone_to": "gate"
  },
  "runner": {
    "provider": "claude",
    "providers": {
      "claude": { "cmd": ["claude", "-p", "{prompt}", "--allowedTools", "Edit,Bash"] },
      "codex":  { "cmd": ["codex", "exec", "{prompt}"] },
      "custom": { "cmd": ["./scripts/run-agent.sh", "{item}"] }
    },
    "prompt_template": ".gatewright/prompt.md",
    "tick_s": 5,
    "max_concurrent": 1,
    "stop_timeout_s": 30,
    "run_timeout_min": 60,
    "worktree_root": ".gatewright/.worktrees",
    "paused": false
  },
  "policy": {
    "auto_dispatch_children": false,
    "max_children_per_item": 10,
    "triage_required_for": ["agent"]
  },
  "memory": {
    "enabled": false,
    "provider": "second-brain",
    "providers": {
      "second-brain": { "url": "https://second-brain.example.workers.dev/mcp", "token_env": "SECOND_BRAIN_TOKEN" }
    },
    "project_id": null,
    "recall": { "on_dispatch": true, "top_k": 5, "max_chars": 2000 },
    "remember": { "on_run_ok": true, "on_close": true, "max_chars": 800, "extra_tags": [] }
  }
}
```

`vocab.priority` is an **ordered** array, highest priority first. It is the scheduler's pick order (§10) as well as a validation list; the other vocab arrays are validation only.

Staleness is about work that should still be moving, so stages representing finished work are exempt through `check.stale_exempt_stages`.

`memory` is ignored entirely when `enabled` is false; the adapter module is not even loaded. Tokens come from an environment variable named in `token_env`, never from the file.

`{prompt}` and `{item}` are substituted at spawn. The prompt template is a markdown file with `{{title}}`, `{{scope}}`, `{{deps}}`, `{{stage}}`, `{{target_stage}}`, `{{exit}}`, `{{notes}}`, `{{log_tail}}`, `{{prior_context}}`, and `{{capsule}}` placeholders. The last two render empty when memory is disabled. Default template shipped by `init`.

## 6. CLI contract

All commands: exit 0 on success, 1 on rule violation, 2 on usage error, 3 on I/O error. Output is plain text by default; `--json` gives machine output. Every command that writes appends an event.

```
gw init [--gh] [--force]
gw brief [--me <owner>] [--json] [--recall]        (--recall: v0.5, opt-in)
gw add "<title>" [--parent ID] [--type T] [--phase P] [--priority P] [--gate G] [--scope "..."] [--by <who>]
gw claim <id> [--by <who>]
gw release <id>
gw move <id> <stage> [--evidence <e>...] [--by <who>] [--force]
gw edit <id> [--title "..."] [--scope "..."] [--priority P] [--type T] [--phase P] [--gate G] [--deps a,b] [--refs a,b] [--by <who>]
gw note <id> "<text>" [--by <who>]
gw check [--json]
gw show <id> [--json]
gw list [--stage S] [--phase P] [--flag F] [--json]
gw import <file> [--format md|csv|json]
gw open [--no-browser]
gw upgrade [--templates]
gw serve [--port 7777] [--open]
gw sync [--dry-run]                       (v0.3)
gw stop <id> | --all                      (v0.4)
gw resume <id>                            (v0.4)
gw triage <id> --approve | --drop         (v0.4)
```

`--by` defaults to `$GW_ACTOR`, then `human:$USER`. Runs set `GW_ACTOR=agent:<run-id>` in the spawned environment, so agents never pass `--by` themselves.

### 6.1 brief

Output format (fixed order, sections omitted when empty):

```
gw · 12 open · 3 in flight · 1 blocked · main@895e249

DISPATCHED TO YOU
  P2-01  Operation Enabled group readiness barrier   specified → building

IN FLIGHT
  P0-03  Budgets: input age, Stop response...        building   agent:r-0041
  P2-07  ...                                          in_review  human:rahil

BLOCKED
  P2-12  ...                                          waiting on P2-01 (specified)

NEEDS TRIAGE (2)
  P2-01.1  Jog timeout not reset on abort            created by agent:r-0040

NEXT UNBLOCKED
  P0-04  Reject / clamp / halt / fault / disarm policy table   P0 G0
  P0-05  Jog network transport and clock conversion policy    P0 G0

Rules: use `gw add` for work someone else could pick up; checklists go in notes.
       `gw move` needs evidence past Building. Never edit .gatewright/ by hand.
```

Hard cap from `config.brief.max_lines`. Sections are truncated with `(+n more)` rather than the whole thing growing.

### 6.2 move

1. Load item and target stage.
2. If target is not the next stage in order and `--force` is absent → exit 1, "use --force to skip stages".
3. Evaluate target's `requires`. Any failure → exit 1 with each failed rule on its own line.
4. Update `stage`, `updated`; append provided evidence; clear `flag` if it was `paused`.
5. Append `move` event.
6. If `github.enabled` and item is linked and `comment_on_move` → queue a comment (written on next `sync` or immediately if `serve` is running).

### 6.3 add

1. Validate parent exists if given.
2. If `--by` is `agent:*`: enforce `max_children_per_item` on the parent; set `flag: needs-triage` if `policy.triage_required_for` includes `agent` and `auto_dispatch_children` is false.
3. Assign ID per `id_scheme`. `phase-seq`: `<phase>-<nn>`, children get `<parent>.<n>`.
4. Append item line, append `add` event, print the new ID on stdout (and only the ID, so agents can capture it).

### 6.4 check

First, the out-of-band write check. `store` writes `.gatewright/.digest` after every successful CLI or API write, holding a SHA-256 of `items.jsonl` and the timestamp of that write. `check` re-hashes the file and compares:

- Match → nothing reported.
- Differ → report `items.jsonl modified outside gw since <ts>`, then re-baseline the digest so the same edit is reported once rather than on every run.
- `.digest` missing (fresh clone that predates it, or first run after upgrade) → write it silently and report nothing. A missing digest is not evidence of an edit.

Then the board itself. Two different scopes, and the difference matters:

**Every item, terminal included:**
- exit-rule violations at its current stage (should not happen through the CLI; catches the hand edits the digest just flagged)
- deps that don't exist, dep cycles, deps in `dropped`

Terminal items are checked precisely *because* they are terminal. Editing an
item into `verified` by hand is the cheapest way to fake a finished board, so
excluding terminal items would leave the one stage that most needs auditing
unaudited. An item sitting in `verified` with no evidence is the clearest
possible signal that something wrote the file directly.

**Non-terminal items only:**
- items with `owner` set but no run and no activity in `stale_days` (config, default 7)
- items linked to a closed GitHub issue not in a terminal stage → `flag: conflict`

Staleness and conflict are about work that should still be moving. A merged
item that hasn't been touched in a month is finished, not stale.

Exit 1 if anything is reported.

### 6.5 edit

Changes item fields that aren't stage, owner, evidence, or notes — those have their own commands, because they have their own rules.

1. Load the item. Unknown ID → exit 2.
2. Collect the flags given. None → exit 2.
3. **Field ownership is enforced here exactly as it is in the API (§2, §9).** If the item is GitHub-linked (`gh` is not null) and any given field is GitHub-owned (`title`, `scope`, `priority`, `type`, `phase`, `gate` — whatever the label map covers), refuse the whole command: exit 1, naming each refused field and printing the issue URL. Edit it on the issue and let `sync` bring it back; otherwise the next sync silently reverts the edit, which is worse than a refusal.
4. Validate against `config.vocab` where a list exists for that field. `--deps` and `--refs` take comma-separated lists and replace the array; deps are checked for existence and cycles as on `add`.
5. Write the changed fields and `updated`, append one `edit` event whose `fields` is the list of changed keys (not their values; the values are in `items.jsonl` and its history).

Nothing is partially applied: a command that touches three fields and fails validation on one writes none of them.

## 7. Viewer contract (board.html)

- Single file. No build. No external requests. Inline CSS and JS.
- **The viewer never fetches its own data from `file://`.** Chrome and Firefox treat a `file://` document as an opaque origin and block `fetch` on relative paths, so a viewer that loaded its own JSONL would work only in Safari and only sometimes.
- Instead, `gw open` writes `.gatewright/board.html` = the pinned shell from `viewer/board.html` with the current data injected as four elements immediately before the closing `</body>`:

  ```html
  <script type="application/json" id="gw-items">[ ...one object per item... ]</script>
  <script type="application/json" id="gw-events">[ ... ]</script>
  <script type="application/json" id="gw-stages">{ ... }</script>
  <script type="application/json" id="gw-config">{ ... }</script>
  ```

  JSONL becomes a JSON array in the block; `</` inside any string is escaped as `<\/` so a title can never close the script element. The shell reads these with `JSON.parse(document.getElementById('gw-items').textContent)` and renders. No network, no build, works from `file://` in every browser.
- The injected snapshot carries the timestamp it was written at, shown in the header: this is a snapshot, and the board says so rather than pretending to be live.
- Under `serve`, the same shell is served with empty data blocks and hydrates from `GET /api/state` instead, then polls. One shell, two data sources.
- Views: Overview (counts by stage/phase/gate), Board (columns from `stages.json`, filters by phase/gate/type/stage/flag), Table (sortable), Stages & rules (rendered from `stages.json`), Export/import (JSON download; import only under `serve`).
- Item panel: all fields, stage buttons (disabled when `requires` fails, with the reason), evidence and notes editors, Play/Stop/Resume buttons (v0.2+), triage approve/drop (v0.4), run log tail (v0.4).
- Under `file://` (a `gw open` snapshot), every editor is read-only and a banner says so, with the `gw` command that would make the change.
- Under `serve`, writes go to `POST /api/items/:id`, `POST /api/items/:id/move`, `POST /api/items`, `POST /api/events` and the page re-fetches after each.
- Polls `/api/state?since=<ts>` every 2s under `serve` for live updates from runs.

## 8. serve API (v0.2+)

Local only, binds `127.0.0.1`. No auth (it's your machine). Rejects non-loopback origins.

```
GET  /                      viewer
GET  /api/state?since=      { items, events (since), stages, config, runs }
POST /api/items             add
POST /api/items/:id         edit (human/agent-owned fields only)
POST /api/items/:id/move    { to, evidence[] }  runs the same rules as CLI
POST /api/items/:id/note
POST /api/items/:id/dispatch
POST /api/items/:id/cancel
POST /api/items/:id/resume          (v0.4)
POST /api/items/:id/triage          { action: approve|drop }  (v0.4)
POST /api/pause  /api/resume        global
GET  /api/runs/:run/log?tail=200    (v0.4)
```

All writes go through the same module the CLI uses. There is one write path.

## 9. GitHub sync (v0.3)

Uses the `gh` CLI. Never handles tokens.

Pull:
1. `gh issue list --repo <r> --state all --search "updated:>=<last_sync>" --json number,title,body,labels,milestone,state,updatedAt,url --limit 200`
2. For each issue: find item by `gh.number`. If none and state is open → create item (`created_by: github`, stage `backlog`). If found → merge GitHub-owned fields only (`title`, `scope` from body, mapped labels, `gate` from milestone).
3. If issue state is `closed` and item stage is not terminal → `flag: conflict`, event `flag`, do not change stage.
4. If issue has `dispatch_label` and item has no dispatch event since the label was applied → append `dispatch` event, remove label via `gh issue edit --remove-label`.

Push:
1. Queued move comments: `gh issue comment <n> --body "→ Built · evidence: abc123 · by agent:r-0042"`.
2. Items reaching `close_on` stage → `gh issue close <n>`.
3. If `mirror_children` and an agent-created child has a linked parent → `gh issue create --title ... --body "Opened by agent run r-0042 while working on #42.\n\n<scope>"`, store `gh` on the child.

Conflict rule: GitHub-owned fields take the newer `updated_at`. Tracker-owned fields are never written by sync. There is no three-way merge.

## 10. Runner (v0.4)

Scheduler loop in `serve`, every `tick_s` (default 5):

1. If `runner.paused` → skip.
2. Running count ≥ `max_concurrent` → skip.
3. Candidates: items where the next stage has `auto: true`, `flag` is null, deps satisfy the next stage's `deps_at_least`, and either a `dispatch` event exists with no later `run_ended`/`cancel`, or the stage before is `auto` (continuation).
4. Pick by index in `config.vocab.priority` (position 0 first), then oldest `updated`. An item whose `priority` is absent from that array, or null, sorts after every item whose priority is in it — an unclassified item never jumps the queue.
5. Start: create worktree `git worktree add <root>/<id> -b gw/<id>` (reuse if exists). If `memory.enabled` and `recall.on_dispatch`: call `memory.recall("<title>. <scope>", top_k)`, trim to `max_chars`, fill `{{prior_context}}`; if `project_id` is set, fill `{{capsule}}`. A memory failure logs a warning and leaves both empty; it never blocks the run. Render prompt, spawn provider `cmd` with `cwd` = worktree and env `GW_ACTOR=agent:<run>`, `GW_ITEM=<id>`, `GW_ROOT=<repo>/.gatewright`. Pipe stdout+stderr to `runs/<id>-<run>.log`. Append `run_started`. Set `owner`.
6. On exit: append `run_ended` with outcome and `git -C <worktree> rev-parse HEAD`. Clear `owner` if outcome is not `ok`. If outcome is `ok` and `memory.remember.on_run_ok`: write one memory (see §14).
7. On `cancel` event for a running item: SIGTERM, wait `stop_timeout_s`, SIGKILL. Set `flag: paused`, store `prev_stage` and `last_commit` on the item. Append `run_ended` with `cancelled`.
8. On `resume`: clear flag, restore stage, append `dispatch`; next tick starts with `{{log_tail}}` filled from the last log.
9. `run_timeout_min` exceeded → same as cancel with outcome `timeout`.

The agent inside a run uses the normal CLI. `GW_ROOT` points it at the main repo's `.gatewright/`, not the worktree's copy, so all runs write to one board.

## 11. AGENTS.md block

Written by `init`. Fenced so `init --force` can replace it and `upgrade` can update it.

### 11.1 Where the block is written

`AGENTS.md` is always created or updated. It is the provider-agnostic contract
and every mainstream agent reads it, so a repo that has only this file is fully
set up. In a brand-new or empty repo, it is the only file `init` writes outside
`.gatewright/`.

Provider-specific mirrors are written **only when that provider's own artifact
already exists**, because the mirror is worthless to someone who does not use
that provider and writing it is presumptuous:

| Target | Written when |
|---|---|
| `CLAUDE.md` | the file already exists |
| `.cursor/rules/gatewright.mdc` | the file exists, or `.cursor/rules/` exists |
| `.github/copilot-instructions.md` | **the file already exists** |

The asymmetry is deliberate. `.cursor/rules/` exists only if someone uses
Cursor, so the directory is real evidence. `.github/` exists in almost every
repo that has CI and is evidence of nothing at all — keying off it writes a
Copilot instructions file for people who have never opened Copilot. A parent
directory is only a signal when the directory belongs to the provider.

`init --mirror <claude|cursor|copilot|all>` creates a mirror the user asks for
even when its file is absent, which covers the case of "I use Cursor but this
repo has no rules directory yet". `init` reports what it wrote and what it
skipped, naming the flag, so the choice is visible rather than silent.

`upgrade` refreshes every mirror that exists and creates none.

```
<!-- gatewright:start -->
## Work tracking
This repo uses gatewright. At the start of every session run `gw brief` and act on it.
- Record progress only through the `gw` CLI. Never edit files in `.gatewright/` directly.
- `gw claim <id>` before changing code for an item. `gw move <id> <stage> --evidence <commit|test|PR>` when you reach a stage.
- Work you discover that someone else could pick up: `gw add "<title>" --parent <id>`. Your own plan steps: `gw note <id>`.
- If `gw move` refuses, fix the reason; do not use --force.
<!-- gatewright:end -->
```

## 12. Adapters (v0.4)

`adapters/claude-code/` — plugin manifest with a `SessionStart` hook running `gw brief`, and a skill file pointing at the AGENTS.md rules.
`adapters/cursor/` — `.cursor/rules/gatewright.mdc` with the same block.
`adapters/codex/` — snippet for `AGENTS.md` (Codex already reads it; adapter is docs only).
`adapters/generic/` — the block above, for anything else.

Adapters contain no logic. If a provider can't run a command at session start, the AGENTS.md instruction is the fallback and is sufficient.

`adapters/second-brain/` is the exception: it is a memory provider (see §14) and contains the client code for that backend. Provider adapters and memory adapters are different kinds of thing and live in the same folder only for discoverability.

## 13. Non-functional

- `brief` on 500 items: under 100ms.
- `items.jsonl` writes: atomic via temp file + rename.
- Concurrent CLI writes from multiple runs: advisory lock file `.gatewright/.lock` with 2s retry, 10s give-up.
- No telemetry. No network except `gh` in `sync` and the loopback server.
- Node 18+. No native modules. `npm ls --prod` is empty.

## 14. Memory provider (v0.5)

Interface, in `lib/memory/provider.js`:

```js
// returns [{ text, tags, date }] ordered by relevance, at most n
async recall(query, n)
// stores one memory; returns an id or null
async remember(text, tags, { volatility, canonical })
// optional; returns a string prefix or null
async capsule(projectId)
```

Loading: `memory.provider` names a module in `lib/memory/providers/<name>.js` or `adapters/<name>/memory.js`. Loaded only when `memory.enabled` is true. Missing module → warning at `serve` start, memory treated as disabled.

Calls and content:

| trigger | call | content |
|---|---|---|
| scheduler step 5 | `recall("<title>. <scope>", top_k)` | hits rendered as `- (<date>) <text>` lines under a "Prior context" heading, trimmed to `max_chars` |
| scheduler step 5 | `capsule(project_id)` | verbatim prefix |
| `run_ended` ok | `remember(...)` | `"<repo> · <id> <title> · <from>→<to> · changed: <first line of last commit message> · why: <last note or scope, ≤200 chars> · evidence: <list>"` tags: `["gatewright", "<repo>", "<type>", "<phase>", ...extra_tags]`, volatility `state` |
| item reaches `close_on` stage | `remember(...)` | same shape with `verified` in tags; `canonical: true` when `type` is `decision`, volatility `durable` |
| `brief --recall` | `recall("<in-flight titles joined>", 3)` | appended as a final "Related memory" section, subject to the brief line cap |

Rules:

- Every memory call has a 5s timeout. Failure never blocks a run, a move, or a brief; it logs to `runs/memory.log`.
- Nothing about stage, dispatch, or run lifecycle is written to memory. Only completed work and verified decisions.
- `remember` text is capped at `remember.max_chars`. It is written by the tracker from item fields, not by asking the agent to summarise; that keeps it deterministic and free.
- Secrets never enter memory text: evidence entries are commit SHAs, paths, and URLs only.

Second Brain adapter (`adapters/second-brain/memory.js`): MCP client over HTTP to the configured `url`, bearer token from `token_env`. Maps `recall` → `recall` tool, `remember` → `remember` with `source: "gatewright"`, `capsule` → `get_prompt_capsule` with `kind: "project"`.
