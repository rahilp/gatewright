# Gatewright — Specifications

**Status:** Draft v0.2 · **Date:** 2026-09-14 (decisions D1–D6 closed)

This is the contract. If the code and this document disagree while work is in flight, the document wins and the code gets fixed (or the document is revised deliberately first). After acceptance, the tests are the contract and this becomes the record of why.

## 1. Layout on disk

```
.gatewright/
  items.jsonl           one item per line, current state
  events.jsonl          append-only log, one event per line
  events-archive.jsonl  events moved out of events.jsonl by `gw gc --events`;
                        append-only, committed (v0.13)
  stages.json           stage definitions and exit rules
  config.json           tool config: providers, labels, policy
  prompt.md             dispatch prompt template (v0.2); user-editable
  .digest               hashes of items.jsonl, stages.json and config.json
                        after the last gw write
  .gitignore            written by `init`; names the five throwaway paths below
  board.html            viewer snapshot written by `gw open`
  runs/                 per-run logs (v0.4), gitignored
  .worktrees/           git worktrees for runs (v0.4), gitignored
```

Everything except the paths named in `.gatewright/.gitignore` is committed —
`.digest` included, because the out-of-band write check in §6.4 has to work in a
fresh clone, and `events-archive.jsonl` included, because an archive that is not
in git is not an audit trail.

**Amended 2026-09-20 (T-0136).** "gitignored by default" was a claim about a file
that did not exist. Nothing shipped ignored anything, so every board that had run
an agent offered its run logs, its worktrees and its lock file to the next
`git add -A`. `init` now writes `.gatewright/.gitignore`, and writes it on an
existing board too if it is absent:

```
runs/
.worktrees/
.lock
*.tmp
*.pid
```

Those five are exactly what gw creates and then throws away. It only ever
creates the file: a `.gitignore` already on disk may have been edited
deliberately, and overwriting it would be the hand-edit this tool tells everyone
else not to make.

`board.html` is an installed artifact, never agent-written. The source lives at `viewer/board.html` in the package; `gw open` copies it and injects the current data (§7), and `upgrade` replaces the copied shell.

**Amended 2026-09-20 (T-0139).** Two claims in that sentence had drifted from the
code. `gw serve` does **not** write `board.html`: it holds the same pinned shell
in memory and serves it with empty data blocks for the page to hydrate from
`/api/state` (§7, §8), so a board that has never been `gw open`ed has no
`board.html` on disk at all — and the live board is not a file anyone can be
looking at a stale copy of. And the shell's version header comment
(`<!-- gatewright board v1 -->`) is *printed* by `upgrade` in its report, so the
user can see which shell they now have; nothing compares it to the package
version. The comparison was never built, and the header is a shell-format marker
rather than a release number, so there is nothing for it to be compared against.

`prompt.md` is shipped by `init` from `templates/` and is expected to be edited. Plain `upgrade` never touches it; `upgrade --templates` replaces it and says so.

## 2. items.jsonl

One JSON object per line. Lines are rewritten in place on change (read all, mutate one, write all, atomic rename). Keep the file small enough that this is cheap; it's a tracker, not a database.

```json
{
  "id": "P2-01",
  "title": "Operation Enabled group readiness barrier before the plan clock starts",
  "phase": "P2",
  "priority": "P2",
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
| `id` | string | tracker | Unique. Format set in config (`id_scheme`); default `seq` → `T-0001`. Boards that choose `phase-seq` mint `<phase>-<nn>` instead (children `<parent>.<n>` under either scheme), and cannot mint an id for an item with no phase. Never reused, and never rewritten: an item that changes `phase` keeps the ID it was created with, because evidence links and the event log point at it. The prefix records where the item started, `phase` records where it is. |
| `title` | string | github if linked, else human/agent | ≤120 chars |
| `phase`, `priority`, `type` | string | github if linked (via label map), else human/agent | Values are free-form but validated against `config.vocab` if present |
| `stage` | string | tracker | Must be a key in `stages.json` |
| `flag` | `null` \| `"blocked"` \| `"needs-triage"` \| `"unclassified"` \| `"paused"` \| `"conflict"` | tracker | One flag at a time. **Any** flag keeps an item off the scheduler (`isSchedulable` refuses a non-null flag outright). Only `needs-triage` also refuses `move`: `unclassified` is an inbox marker, not a hold — see §6.3. |
| `owner` | string \| null | tracker | `human:<name>` or `agent:<run-id>` |
| `scope` | string | github (body) if linked | What "done" means. Shown in dispatch prompt. |
| `deps` | string[] | human/agent | Item IDs. Cycles rejected on write. |
| `evidence` | `{ text, stage }[]` | agent/human | Each entry: `text` is the free-form string (commit SHAs, test paths, CI URLs, PR URLs), `stage` names the stage whose move supplied it — so a gate is judged on what its own move supplied, and the board can show what justified each gate after the fact. `stage` is `null` on entries migrated from the pre-0.12 flat-string shape; such entries count for gates at or before the stage the item already occupies, never for a gate the item is entering. Validated by exit rules only (§4). |
| `notes` | string | agent/human | Running notes. Checklists live here as markdown. |
| `refs` | string[] | human | Requirement IDs, ticket refs. Not interpreted. |
| `parent` | string \| null | tracker | Set by `add --parent`. |
| `created_by` | `"human"` \| `"github"` \| `"agent:<run-id>"` | tracker | Immutable |
| `gh` | object \| null | tracker | `{number, url, updated_at}` when linked |
| `prev_stage` | string | tracker | The stage the item stood in when a run was stopped or timed out, written alongside `flag: "paused"`. `resume` restores the stage from it. Absent on an item no run has ever stopped. |
| `last_commit` | string \| null | tracker | HEAD of the run's worktree when the run ended, resolved through the worktree's `commondir` so a linked worktree reports its own branch rather than the main checkout's. Written on the item at the same moment as the `run_ended` event that carries it. Absent until a run has ended. |
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
| `stages` | by | serve (Stages & rules editor) |
| `config` | by, keys (the settings that changed) | serve (Settings view) |
| `compact` | by, kept, archived, keep, archive | CLI (`gc --events`) |
| `pause_all` / `resume_all` | by | serve |

`by` is always one of `human:<name>`, `agent:<name>`, `github`, `scheduler`, `sync`. The `<name>` on an agent is whatever that agent declared: a run id (`agent:r-0042`) for a run the scheduler spawned, `agent:mcp` for the MCP server's default (§6.9), or anything `GW_ACTOR`/`--by` supplied. Identity is declared, not authenticated.

**Amended 2026-09-20 (T-0139).** `pause_all` was listed as written by "serve,
CLI". Only `serve` writes it. `gw stop --all` sets `runner.paused` in
`config.json` through `writeConfig` — which re-baselines the digest, so the
change is a legitimate gw write — and appends no event: it persists the pause
*before* it signals anything, so an offline kill switch closes the scheduler's
restart window even if the process running it dies mid-sweep. The consequence to
know about is that a board paused from a terminal shows the paused state,
because the state is read from config, but carries no `pause_all` line in its
history. Recorded here rather than changed.

The event log is the source of truth for "what happened." `items.jsonl` is a materialised view that could be rebuilt from events plus the initial import. v0.1 doesn't implement the rebuild; the format allows it.

## 4. stages.json

```json
{
  "stages": [
    {
      "id": "backlog",
      "label": "Backlog"
    },
    {
      "id": "building",
      "label": "Building",
      "exit": "Change is complete locally with tests passing.",
      "auto": true,
      "requires": {
        "owner": true
      }
    },
    {
      "id": "built",
      "label": "Built",
      "exit": "Scope is written and evidence recorded: commit and test path.",
      "auto": true,
      "requires": {
        "scope": true,
        "evidence_min": 1,
        "evidence_match": "^(?:[0-9a-fA-F]{7,64}|[A-Za-z][A-Za-z0-9+.-]*://\\S+|\\S+/\\S*|\\S+\\.[A-Za-z][A-Za-z0-9_-]*)$",
        "deps_at_least": "built"
      }
    },
    {
      "id": "in_review",
      "label": "In review",
      "exit": "PR opened and reviewer assigned.",
      "auto": true,
      "requires": {
        "evidence_match": "^https://github.com/.+/pull/\\d+"
      }
    },
    {
      "id": "reviewed",
      "label": "Reviewed",
      "exit": "Reviewer approved.",
      "auto": false
    },
    {
      "id": "merged",
      "label": "Merged",
      "exit": "PR merged to main.",
      "auto": false,
      "requires": {
        "deps_at_least": "merged"
      }
    },
    {
      "id": "verified",
      "label": "Verified",
      "exit": "Behaviour confirmed on target; VALIDATION entry linked.",
      "auto": false,
      "requires": {
        "evidence_min": 2,
        "children_done": true
      }
    }
  ],
  "terminal": [
    "verified",
    "dropped"
  ],
  "extra": [
    {
      "id": "dropped",
      "label": "Dropped"
    },
    {
      "id": "paused",
      "label": "Paused"
    }
  ]
}
```

Semantics:

- `exit` is the human-readable rule shown in the board and the brief. It has no machine meaning.
- `requires` is the machine-checked rule for **entering** the next stage. `gw move X <stage>` evaluates the `requires` block of the *target* stage. Keys:
  - `owner: true` — item must have an owner
  - `evidence_min: n` — at least n DISTINCT evidence entries supplied with this move for this stage. Entries are trimmed and de-duplicated against each other and against every entry already recorded on the item, so pasting the same string twice counts once, and evidence recorded at an earlier stage never satisfies a later gate. Forcing an item backward and re-moving it forward therefore demands fresh evidence — intended.
  - `evidence_match: regex` — at least one distinct entry supplied with this move matches. Both shipped pipelines (§4.3) put the *same* pattern on the stage where completion is claimed — `built` on team, `done` on solo. It is `ARTIFACT_EVIDENCE`, exported from `lib/gates/describe.js` and read from there by both templates, so the rule, the English the board reads it back as, and the placeholder a refusal prints cannot drift apart. It is anchored at both ends and admits no whitespace, and so accepts a commit SHA (7–64 hex), a scheme-qualified URL, a path containing `/`, or a dotted filename — and refuses a sentence.
  - `deps_at_least: stage` — every dep must be at that stage or later (by list order)
  - `children_done: true` — every direct child item must be in a terminal stage. This is normally set on the done stage; a board that does not want parent completion to wait for children omits it. Descendants are covered transitively because each child must clear its own gate before it can finish.

  **Migration.** Boards written before evidence carried its stage hold flat
  strings; those read as `{ text, stage: null }`. Normalisation happens on
  read, so an old board works at once and nothing on disk changes until the
  next gw write — which persists the new shape and re-baselines `.digest` in
  the same breath. A migration that rewrote `items.jsonl` at read time would
  make the next `gw check` report an out-of-band write that the tool itself
  just made; it must never do that. Migrated (`stage: null`) entries were
  recorded under the old lifetime-array rule, so their justification is
  unknown: they count for every gate at or before the stage the item already
  stands in — keeping an upgraded board's `gw check` clean — and for no gate
  the item is entering.
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
- **Evidence has a shape as well as a count (added 2026-09-20, T-0129).** The default `built` gate above gained `evidence_match`. The defect it closes is specific and was reproducible: `gw move T-0001 built` refused for want of evidence and printed an example of what evidence looks like, and the example passed the gate — so the fastest way through the gate was to paste the refusal back at it. `evidence_min` counts strings, and any string is a string. Gating the shape as well means the count now counts artifacts: something a reviewer can open. Every value a refusal prints is an angle-bracketed placeholder for the same reason. Loosening or removing the rule is a per-board edit like any other rule here; the point is what the shipped default claims.
- `paused` and `dropped` are side states. `paused` remembers `prev_stage` in the item so resume can restore it.

Order in the array is the pipeline order. Users edit this file to change their process; nothing is hardcoded.

### 4.1 Stage roles

Some behaviour needs to know what a stage *means*, not what it is called: where
new items start, what a source marking work "done" maps to, which stage means
abandoned. Naming those stages in code — `stage === 'backlog'` — silently breaks
every pipeline that does not use our words, which contradicts the sentence above.

A stage may declare a `role`:

| role | meaning | used by |
|---|---|---|
| `initial` | where new items start | `add`, `import` |
| `done` | what a source "done" marker maps to | `import` |
| `dropped` | abandoned; a dependency here can never be satisfied | `check`, `brief` |
| `paused` | parked; leaving it clears the `paused` flag | `move` |

```json
{ "id": "icebox", "label": "Icebox", "role": "initial" },
{ "id": "shipped", "label": "Shipped", "role": "done" }
```

The role is a property of the stage rather than a mapping in `config.json`,
because a mapping is a reference and a reference can name a stage that does not
exist. A `role` key cannot be wrong about which stage it belongs to. It is the
same choice already made for `auto`.

**Defaults, so that the common case needs no configuration:**

- `initial` — the first stage in pipeline order.
- `done` — the last stage in pipeline order.
- `dropped` and `paused` — a stage with that `id`, if one exists, whether in the
  pipeline or in `extra`.

The shipped seven-stage default therefore declares no roles at all: `backlog` is
first, `verified` is last, and `dropped` and `paused` are found by id. An
existing board keeps working with no migration.

A role that resolves to nothing disables the behaviour that needs it rather than
failing: a pipeline with no `dropped` stage simply never reports a dropped
dependency. A role may be declared at most once; two stages claiming the same
role is a configuration error, not a race to be resolved.

### 4.2 Validating the process definition

`stages.json` is user-edited, so it is checked like any other input. `gw check`
validates it and reports, before it looks at any item:

- a `role` that is not one of the four above, or claimed by two stages
- `terminal` naming a stage that does not exist
- `requires.deps_at_least` naming a stage that is not in the pipeline
- `requires.evidence_match` that is not a valid regular expression
- an empty pipeline, or duplicate stage ids

A board whose rules are malformed cannot be trusted to enforce anything, so
this runs first and exits non-zero on any finding.

### 4.3 The two shipped pipelines

Added 2026-09-20 (T-0139). This was the largest single gap between this document
and the product: `init` has shipped two pipeline presets since v0.8, and §4
described only one of them as though it were the only thing `init` could write.

`init` does not copy a fixed `stages.json`. It reads a **preset** from
`templates/pipeline-<name>.json`, writes the preset's `stages` block to
`.gatewright/stages.json`, and merges the preset's `policy` block over the
`policy` block in `config.json` (§5). A preset is therefore two things: a
pipeline, and the policy that pipeline implies.

| | **solo** | **team** |
|---|---|---|
| file | `templates/pipeline-solo.json` | `templates/pipeline-team.json` |
| stages | `backlog → building → done` | `backlog → building → built → in_review → reviewed → merged → verified` (the block in §4, by reference: the preset names `stages_template: "stages.json"` rather than copying it) |
| terminal | `done`, `dropped` | `verified`, `dropped` |
| roles | declared: `done` on Done, `dropped` on Dropped, `paused` on Paused | none declared; resolved by the §4.1 defaults |
| the completion gate | `done` — `scope`, `evidence_min: 1`, `evidence_match` (§4), `deps_at_least: building`, `children_done` | `built` — `scope`, `evidence_min: 1`, `evidence_match` (§4), `deps_at_least: built`; and `verified` — `evidence_min: 2`, `children_done` |
| review | none | `in_review` gates on a GitHub PR link; `reviewed`, `merged`, `verified` are `auto: false` |
| `policy.triage_required_for` | `[]` — nothing is held | `["agent", "github"]` |

**The default is solo.** Not "the eight-stage default", and not the block in §4:
`gw init` with no flags and no terminal chooses `team` only when the checkout has
a GitHub origin, and `solo` everywhere else. `--pipeline solo|team` decides it
explicitly and an unknown name is a usage error naming the two. In a terminal,
`init`'s first screen asks the same question in English and offers a third
answer, "Team, linked to GitHub", which is `team` plus `--gh`.

Solo is the default because the pipeline has to end where the user actually
finishes. A pipeline that assumes pull requests, given to someone who does not
open them, leaves every completed item parked one stage short of its finish line
— and `gw brief`, which reads `role: "done"`, then reports all of it as still in
flight forever. That is how a digest degrades into a list of everything ever
done. Solo's `done` carries the role explicitly for the same reason §4.1 gives:
only an explicit role counts, because plenty of pipelines end in a waiting room.

**Why the policy differs, and why it is part of the preset rather than a second
question.** A hold is only worth its cost when someone other than the author
will look at what is held. On a solo board nobody will, so
`triage_required_for: []` means a capture is workable the moment it is written
down. On a team board the two actor kinds whose work arrives from outside the
room — `agent` and, since T-0128, `github` — are held for a human. Everything
about *how* a hold behaves is in §6.3 and §10.1; the preset only decides who is
subject to one.

**`github` in that list is new (2026-09-20, T-0128).** A GitHub issue body is
written by whoever opened it and flows into an item's `scope`, and from there
into the dispatch prompt of an unattended agent (§5, §10). Before this, a pulled
issue was schedulable the moment it landed: `gw sync` hardcoded `flag: null`
while `gw add` went through the capture-flag rule, so the two disagreed about
what a bare capture looks like. Both now call the one function, so a team board
puts a human between what a stranger opened upstream and what a runner starts
working on. A solo board holds nothing, and is unchanged.

## 5. config.json

`vocab` lists the codes a board allows; `glossary` explains them. It is
optional and additive — `glossary.<field>.<code>` is a sentence in plain
language, and a code with no entry renders exactly as it always has. This is
help text, never a requirement: nothing validates against it, and a missing or
malformed `glossary` block means "no descriptions", not an error. Set one
entry with `gw config glossary.phase.P1 "..."`; an empty value removes it.

The block below is `templates/config.json` byte for byte: what `init` copies
*before* it merges the chosen pipeline preset's `policy` block over it (§4.3).
So the file that actually lands has `"triage_required_for": []` on a solo board
and `["agent", "github"]` on a team one; everything else is as shown. `gw config`
reads and writes these values, and the live board's Settings view is generated
from the same schema `gw config` validates against, so the two cannot offer
different settings.

One key is read but not shipped: `gc.events_keep` (§6.10), how many events a
finished item keeps in `events.jsonl`. It defaults to 20 when absent, which is
why the default file carries no `gc` block.

```json
{
  "version": 1,
  "id_scheme": "seq",
  "vocab": {
    "phase": [
      "P0",
      "P1",
      "P2",
      "P3"
    ],
    "priority": [
      "P0",
      "P1",
      "P2",
      "P3"
    ],
    "type": [
      "decision",
      "defect",
      "feature",
      "test",
      "doc"
    ]
  },
  "glossary": {
    "phase": {
      "P0": "Decisions and groundwork that have to be settled before code can depend on them.",
      "P1": "The first working version: the core this product is useless without.",
      "P2": "The work that makes the core usable day to day.",
      "P3": "Later work: worth doing, not needed to call the product usable."
    },
    "priority": {
      "P0": "Drop other work for this.",
      "P1": "Do it in this phase.",
      "P2": "Do it when the P1 work is clear.",
      "P3": "Do it if there is room; fine to never do."
    },
    "type": {
      "decision": "A choice to make and write down, so later work can rely on it.",
      "defect": "Something already shipped and it is wrong.",
      "feature": "New behaviour someone using the product can see.",
      "test": "Work whose product is evidence that something behaves as claimed.",
      "doc": "Writing that explains the product to a human."
    }
  },
  "brief": {
    "max_lines": 25
  },
  "check": {
    "stale_days": 7,
    "stale_exempt_stages": [
      "merged"
    ]
  },
  "guard": {
    "enabled": true,
    "mode": "block",
    "accept": [
      "message",
      "branch",
      "owner"
    ],
    "exempt_paths": [
      ".gatewright/"
    ]
  },
  "github": {
    "enabled": false,
    "repo": null,
    "sync_interval_min": 5,
    "dispatch_label": "agent/go",
    "mirror_children": false,
    "comment_on_move": true,
    "close_on": "verified",
    "labels": {
      "priority/P0": {
        "priority": "P0"
      },
      "type/defect": {
        "type": "defect"
      },
      "phase/2": {
        "phase": "P2"
      }
    },
    "milestone_to": "phase"
  },
  "runner": {
    "enabled": false,
    "provider": "claude",
    "providers": {
      "claude": {
        "cmd": [
          "claude",
          "-p",
          "{prompt}",
          "--allowedTools",
          "Edit,Bash"
        ]
      },
      "codex": {
        "cmd": [
          "codex",
          "exec",
          "{prompt}"
        ]
      },
      "custom": {
        "cmd": [
          "./scripts/run-agent.sh",
          "{item}"
        ]
      }
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
    "max_depth": 3,
    "triage_required_for": [
      "agent"
    ]
  },
  "memory": {
    "enabled": false,
    "provider": "second-brain",
    "providers": {
      "second-brain": {
        "url": "https://second-brain.example.workers.dev/mcp",
        "token_env": "SECOND_BRAIN_TOKEN"
      }
    },
    "project_id": null,
    "recall": {
      "on_dispatch": true,
      "top_k": 5,
      "max_chars": 2000
    },
    "remember": {
      "on_run_ok": true,
      "on_close": true,
      "max_chars": 800,
      "extra_tags": []
    }
  }
}
```

## 6. CLI commands

```
gw init [--pipeline solo|team] [--gh] [--repo owner/name]
        [--mirror claude,cursor,copilot|all] [--no-hook] [--yes] [--no-input] [--force]
gw brief [--me [<owner>]] [--json] [--recall]        (--recall: v0.5, opt-in)
gw add "<title>" [--parent ID] [--type T] [--phase P] [--priority P] [--scope "..."] [--by <who>]
gw claim <id> [--force] [--by <who>]
gw release <id> [--force] [--by <who>]
gw move <id> <stage> [--evidence <e>...] [--by <who>] [--force]
gw next <id> [--json]
gw edit <id> [--title "..."] [--scope "..."] [--priority P] [--type T] [--phase P] [--deps a,b] [--refs a,b] [--force] [--by <who>]
gw note <id> "<text>" [--by <who>]
gw check [--json]
gw doctor [--json] [--port P]                                       (§6.8)
gw repair [--write] [--force]
gw guard [--message-file F | --message "..."] [--branch B] [--range A..B]
         [--pretool] [--tool T] [--file F] [--warn] [--json]
gw hook install [--ci] [--agent] [--force]
gw hook status | gw hook uninstall [--ci] [--agent]
gw config [<key> [<value>]] [--list] [--yes] [--no-input]
gw show <id> [--json]
gw list [<text>] [--stage S] [--phase P] [--flag F] [--owner W] [--limit N] [--json]
gw import <file> [--format md|csv|json] [--dry-run]
gw open [--no-browser] [--watch] [--port P] [--all-events]
gw upgrade [--templates]
gw serve [--port 7777] [--host H] [--open] [--no-browser]
gw mcp [--by <who>]                                                 (§6.9)
gw sync [--dry-run]                       (v0.3)
gw stop <id> | --all                      (v0.4)
gw resume <id>                            (v0.4)
gw triage <id> --approve | --drop [--force] [--by <who>]            (v0.4)
gw gc [--events] [--dry-run] [--force]    (v0.4; --events v0.13, §6.10)
gw help <command>  |  gw <command> --help
```

**Amended 2026-09-20 (T-0139).** This list had fallen four versions behind the
parser. `config` (v0.7), `next` (v0.10), `repair` (v0.12) and `gc` (v0.4) were
missing outright, as were `doctor` and `mcp`, shipped in this sweep; several
commands had flags the list did not carry. Each entry above is the flag set in
that command's own `spec` in `lib/commands/<name>.js`, which is also what
`gw <command> --help` renders — so the three places a reader can look now agree
by construction rather than by upkeep.

Exactly two commands run without a board — `init` and `doctor`, the only two
whose `spec` sets `needsRoot: false`. Everything else resolves a project root
first, so a missing board ends the command before it starts. `doctor` is in that
pair deliberately: "there is no board here" is one of the things it exists to
tell you, and a diagnostic that cannot run on a broken setup is no diagnostic.

`--by` defaults to `$GW_ACTOR`, then `human:$USER`. Runs set `GW_ACTOR=agent:<run-id>` in the spawned environment, so agents never pass `--by` themselves.

### 6.1 brief

Output format (fixed order, sections omitted when empty):

```
gw · 12 open · 3 in flight · 1 blocked · main@895e249

DISPATCHED TO YOU
  P2-01  Operation Enabled group readiness barrier   backlog → building

IN FLIGHT
  P0-03  Budgets: input age, Stop response...        building   agent:r-0041
  P2-07  ...                                          in_review  human:rahil

BLOCKED
  P2-12  ...                                          waiting on P2-01 (backlog)

NEEDS TRIAGE (2)
  P2-01.1  Jog timeout not reset on abort            created by agent:r-0040

NEXT UNBLOCKED
  P0-04  Reject / clamp / halt / fault / disarm policy table   P0
  P0-05  Jog network transport and clock conversion policy    P0

Rules: use `gw add` for work someone else could pick up; checklists go in notes.
       Gates ask for evidence where a stage's rules require it: `gw next <id>` names the gate. Never edit .gatewright/ by hand.
```

Hard cap from `config.brief.max_lines`. Sections are truncated with `(+n more)` rather than the whole thing growing.

### 6.2 move

1. Load item and target stage.
2. If target is not the next stage in order and `--force` is absent → exit 1, naming the stage that must be passed through first and the command to get there: `building: move here first: run \`gw move P1-01 building\``. A backward target says so and names `--force`, which is the only lawful way to move backward. The refusal must never answer with a bare `--force`: it prints the whole command, and the shipped AGENTS.md block permits `--force` exactly when a refusal names it — for order, never for a gate — so that a compliant agent is never left without a next step.
3. Evaluate target's `requires`. Any failure → exit 1 with each failed rule on its own line.
4. Update `stage`, `updated`; append provided evidence, each entry recorded as `{ text, stage: <target stage> }` (§2, §4); clear `flag` if it was `paused`.
5. Append `move` event.
6. If `github.enabled` and item is linked and `comment_on_move` → queue a comment (written on next `sync` or immediately if `serve` is running).

#### Refusing a move

Two refusals, and they are different kinds of thing. A **gate** refusal (`target stage requirements are not met`) is fixed by meeting the rule; `--force` past a gate is never the answer, and no refusal ever suggests it. An **order** refusal is fixed by taking a different step, and the message names the exact command to take it.

`stageOrderMessage` is bound by one property, which is the whole reason it exists: **`move` must accept the command the refusal prints.** The cases, in the order they must be tested:

1. The current stage is outside the pipeline (any `extra` stage — the shipped board's own `paused` and `dropped`): nothing follows it, so every pipeline target is a jump → name the forced command.
2. The target comes before the current stage — which includes *every* pipeline target when the item stands in the last stage → name the forced command.
3. Otherwise → name the immediate next stage, unforced, and say how many stages lie beyond it.

Order 1 before 2 before 3 is load-bearing. Reading "no next stage" as "outside the pipeline" put an item standing in the final stage outside the pipeline it was in, and answered a side stage with `gw move <id> <first-stage>` — a command this same rule then refused in the same words, forever. Both were dead ends, which is the one outcome this function exists to prevent.

### 6.3 add

1. Validate parent exists if given.
2. If `--by` is `agent:*`: enforce `max_children_per_item` on the parent.
3. Decide the capture flag. One function owns this (`captureFlag`), and `gw add`, `gw sync` (§9) and a `policy.triage_required_for` change all call it, so they cannot disagree about what a bare capture looks like:
   - **A policy hold wins.** If `policy.triage_required_for` names the actor's kind (`agent`, `github`, `human`) and `auto_dispatch_children` is false → `flag: needs-triage`.
   - **Otherwise, a non-agent capture with no `phase`, `type` *and* no `priority`** → `flag: unclassified`.
   - Otherwise → `flag: null`.

   **Amended 2026-09-20 (T-0139); the behaviour changed in v0.13 (T-0113).** This
   step used to say a bare capture "also gets `flag: needs-triage`", and that is
   what the code did — with the consequence that `gw move` refused a human's own
   two-second capture until somebody approved it. Two different things were
   wearing one flag. They are separate now, and they differ in the one way that
   matters, whether the item may be *worked*:

   | flag | what it means | scheduler | `claim` | `move` |
   |---|---|---|---|---|
   | `needs-triage` | a policy hold: work nobody has reviewed | held | allowed | **refused** until `gw triage --approve` |
   | `unclassified` | capture with no classification yet | held | allowed | allowed |

   Both sit in the triage inbox and both are reported by `check` without failing
   it — an inbox is not a defect. `unclassified` clears itself the moment
   `gw edit --phase|--type|--priority` supplies any one of the three, or
   `gw triage --approve` takes the item as it is. Agent-created work is never
   flagged `unclassified`: the policy decides whether it is held, and
   `auto_dispatch_children` exists to say it is not.
4. Assign ID per `id_scheme`. `seq` (default): `T-<nnnn>`. `phase-seq`: `<phase>-<nn>`, and refuses when `phase` is null. Children get `<parent>.<n>` under either scheme.
5. Append item line, append `add` event, print the new ID on stdout (and only the ID, so agents can capture it).

### 6.4 check

First, the out-of-band write check. `store` writes `.gatewright/.digest` after every successful CLI or API write, holding a SHA-256 of `items.jsonl` and the timestamp of that write. `check` re-hashes the file and compares:

- Match → nothing reported.
- Differ → report the modified file(s) and preserve the prior digest. `check` is an audit, never an acknowledgement: a stale digest remains stale until a legitimate `gw` write restores it or `gw repair --write --force` deliberately re-baselines it after review.
- `.digest` missing (fresh clone that predates it, or first run after upgrade) → write it silently and report nothing. A missing digest is not evidence of an edit.

Then the board itself. Two different scopes, and the difference matters:

**Every item, terminal included:**
- exit-rule violations at its current stage (should not happen through the CLI; catches the hand edits the digest just flagged)
- a parent already in the done-role stage while any direct child is open (including boards created before `children_done` was introduced)
- deps that don't exist, dep cycles, deps in `dropped`
- `flag: needs-triage` — reported, never silent. It is invisible to the *scheduler* by design (§10), but a board is not; `check` names the item and offers both outs, classifying it or claiming it as-is.

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

### 6.5 guard

Every other rule in this document governs work that is already on the board. `guard` governs whether it got there at all — it is the only command whose failure is meant to stop something outside `gw` from happening, and it is the only enforcement point that is opt-in per repository (§6.6 installs it).

One question: **which item accounts for this change?** Answered against the board's own ids, in this order, stopping at the first hit:

1. **Exempt** — every changed path is under `guard.exempt_paths` (default `.gatewright/`). A commit that only records the board needs no item about itself.
2. **Message** — the commit message names an id that exists on the board.
3. **Branch** — the branch name names one. `feat/P1-07-thing` counts; `P1-011` is a different item and does not count as `P1-01`.
4. **Owner** — the actor (§6, `--by` resolution) holds a claim on a non-terminal item.

`guard.accept` (default `["message","branch","owner"]`) narrows the list.

**An id whose item is finished is refused, in its own sentence.** "Finished" is
the board's own definition — a `terminal` stage, or the stage holding
`role: "done"` — not a hardcoded word. The refusal names which item and which
stage it reached, and gives three ways out that are not `--no-verify`:
`gw brief`, `gw add` (follow-up work after a finish line is new work), and,
when the board has a parked role, `gw move <id> <paused> --force` to reopen it.
It never offers a finished id as the "e.g." in its own advice, which on a `seq`
board whose only item is a finished `T-0001` would have proposed the very id it
had just rejected two lines above.

Two escapes survive, and both are this section's own: `--range`, below, where an
item that has since been finished still accounts for its own commits; and the
exempt-paths check above, which returns first, so a bookkeeping commit touching
only `.gatewright/` passes however finished the items it names are. A commit
that names a finished item *alongside* an open one passes too, and still says
out loud which of them were finished.

**Amended 2026-09-20 (T-0132).** This rule had been softened to a warning to
rescue one flow — landing a rollup of already-built work — and the softening
reached further than the flow did. While every named item is finished, nothing
open on the board is tracking the change being made, which is the one thing
guard exists to notice. The two escapes above cover the rescued flow without
covering everything else.

**An id that is not on the board is refused only conditionally, and this
document used to claim otherwise.** Guard cannot tell an invented item id from
prose: a commit citing `CVE-2024-5678`, or an HTTP status, is an ordinary
commit. So a token that matches no board item is never *by itself* a refusal
while something else — an open id elsewhere in the message or branch, or a claim
held by the actor — accounts for the change. The tokens guard tried and could
not match are reported only inside a refusal, where they are the fastest thing
to show an author who thought a name tracked their work and it did not. The
sentence this replaces read as unconditional, and the code has been the
conditional form since T-0028; the spec is being made to say what the code does
rather than the other way round, because the unconditional reading is the one
that refuses honest commits.

Weak evidence is accepted deliberately. Any of the four proves someone opened the board before touching code, which is the whole claim being enforced. Anything stricter becomes the kind of hook people delete.

Three modes, one decision module:

- **commit** (default, or `--message-file` from the hook) — judges the staged files and the message. Exit 1 refuses the commit; `git commit --no-verify` remains available, and remains visible in the log.
- **`--range A..B`** — judges every non-merge commit in the range on its own message and paths. Two differences from the commit case, both because this reads history rather than gating an action: a claim is local state that does not travel with a commit, so `owner` never applies; and an item that has since been finished still accounts for its own commits, since a pull request is reviewed *after* its work is done. An id that is not on the board is still refused.
- **`--pretool`** — judges an editor tool call read as JSON on stdin (a path outside the repository, or inside `.gatewright/`, is not gated; containment goes through `isWithin` for the reason in §10.2's path rule, never a `..` prefix test), *before* the edit happens, and answers on stdout in the provider hook contract (`permissionDecision: deny` with a reason naming `gw add` and `gw claim`). Exit is always 0: a refused edit is a decision, and a non-zero exit would read as a broken hook. This is the gate that keeps a plan from being written down only after the code is.

`guard.mode: "warn"` reports and permits everywhere. `guard.enabled: false` is silent. A passing guard prints nothing at all.

### 6.6 hook

Installs the places `guard` can stand. Nothing here decides anything; each installation is a thin route to `gw guard`, so an old hook still asks the current CLI.

- `gw hook install` — a `commit-msg` hook, fenced by `# gatewright:start`/`# gatewright:end` markers so it can live inside a hook the repository already had, and be removed again without taking that hook with it. Installed under `core.hooksPath` when the repository sets one, and `chmod +x`, because git skips a non-executable hook silently. If `gw` is not on `PATH` the block steps aside: a missing tool must never make a repository uncommittable.
- `gw hook install --ci` — `.github/workflows/gatewright.yml`, running `gw check` and `gw guard --range` over a pull request, pinned to the installing version.
- `gw hook install --agent` — the `PreToolUse` guard in the project's `.claude/settings.json`, merged into whatever hooks are already there and matched by command so re-running replaces rather than stacks. The Claude Code plugin in `adapters/claude-code` ships the same hook.

`gw hook status` reports all three. `gw hook uninstall` reverses them, and deletes a hook file only when nothing but the shebang `gw` wrote is left.

### 6.7 edit

Changes item fields that aren't stage, owner, evidence, or notes — those have their own commands, because they have their own rules.

1. Load the item. Unknown ID → exit 2.
2. Collect the flags given. None → exit 2.
3. **Field ownership is enforced here exactly as it is in the API (§2, §9).** If the item is GitHub-linked (`gh` is not null) and any given field is GitHub-owned (`title`, `scope`, `priority`, `type`, `phase` — whatever the label map covers), refuse the whole command: exit 1, naming each refused field and printing the issue URL. Edit it on the issue and let `sync` bring it back; otherwise the next sync silently reverts the edit, which is worse than a refusal.
4. Validate against `config.vocab` where a list exists for that field. `--deps` and `--refs` take comma-separated lists and replace the array; deps are checked for existence and cycles as on `add`.
5. Write the changed fields and `updated`, append one `edit` event whose `fields` is the list of changed keys (not their values; the values are in `items.jsonl` and its history).

Nothing is partially applied: a command that touches three fields and fails validation on one writes none of them.

### 6.8 doctor

New 2026-09-20 (T-0138). Twelve checks, in this order: `gw` on PATH · newest
release · git repository · board · board digest · `stages.json` · `config.json` ·
commit hook · agent pre-edit guard · GitHub CLI · runner provider · serve on
port. Each answers in one shape — what was looked at, what was found, and the
exact command that fixes it — and each ends PASS, FAIL or SKIP. Three outcomes
only, because a reader scanning for what to do next should not also have to
grade a severity. A SKIP is never a failure; it means the check does not apply
here (GitHub sync is off, the runner is off, no `--port` was given), which is
also why `doctor` works on a plane.

**`doctor` writes nothing at all.** No board lock, so no `.lock` file; the
digest is read through `verifyDigest` and never re-baselined; the `--port` probe
never starts a server. A diagnostic that quietly repairs what it finds cannot be
run twice and believed, so a board it reported as edited outside gw is still
reported the next time. Re-baselining belongs to `gw check` (for a *missing*
digest only, §6.4) and to `gw repair --write --force`.

It runs without a board (`needsRoot: false`), so "there is no board here" is a
CHECK rather than the command dying before it can say so.

Every outbound call is bounded, because each of them is something that can hang
— a registry, a wedged server, a `gh` waiting on a device-auth prompt — and a
diagnostic that hangs is the failure it was run to explain.

`--port P` additionally probes a `gw serve` already running, on **both**
`127.0.0.1` and `localhost`, and fails when the same board answers differently
depending on the name it is asked by: a browser picks the name, so a
disagreement is what a person would actually see.

Exit 0 when nothing failed, 1 when anything did. `--json` renders the same
report for a program.

### 6.9 mcp

New 2026-09-20 (T-0137). `gw mcp` speaks the Model Context Protocol over stdin
and stdout, publishing the board as ten tools: `gw_brief`, `gw_show`, `gw_next`,
`gw_list`, `gw_add`, `gw_claim`, `gw_move`, `gw_note`, `gw_edit`, `gw_triage`.
It is registered once in a client's config and never run by hand. Zero runtime
dependencies: the JSON-RPC 2.0 transport is written by hand, like the `gh`
wrapper and the runner's spawn.

This is an affordance, not an enforcement point, and it does not replace one.
`gw guard` still refuses an agent's first edit when nothing on the board
accounts for it (§6.5). What changes is what the agent does next: instead of
shelling out to a command it half-remembers, it calls `gw_add` and `gw_claim`.

Four properties are the contract:

- **One write path, unchanged.** Every tool call goes through `lib/serve/invoke.js`
  — the same adapter `gw serve`'s HTTP writes use — into the same
  `lib/commands/*` module the CLI loads, with a synthesized ctx. No rule is
  reimplemented and no rule can live in two places.
- **Refusals come back byte for byte.** A board refusal is an `isError: true`
  result carrying the command's own stderr exactly: the message, then each
  `RuleError` failure on its own line. Those sentences are the teaching surface;
  paraphrasing them would make the MCP surface a worse teacher than the terminal.
  A silent CLI success (a note, an edit, an uncontested claim) returns
  ``ok — `gw <command>` succeeded and printed nothing.``, because an empty
  content block reads as a failure.
- **Protocol errors and board refusals are different things.** An unknown tool,
  an unknown method or a malformed message is a JSON-RPC error (-32602, -32601,
  -32600, -32700). Bad arguments and board refusals are `isError: true`, which
  is what a model can read and retry.
- **Actor.** Writes default to `agent:mcp`, not the CLI's `human:$USER`
  fallback: an MCP server is always agent-driven, and attributing its writes to
  a person would be a lie the event log then keeps. `GW_ACTOR` and `--by`
  override it through the same `actor()` resolution as every other command, so a
  bare `agent` is refused in the CLI's own words before a single byte of
  protocol is read.

The server implements revision `2025-06-18` and also accepts `2025-03-26` and
`2024-11-05`. An unknown version is answered with the pinned one — a
negotiation, never an error. Batched JSON-RPC is refused by name, having been
removed in `2025-06-18`. Wire details are in `docs/mcp.md`.

### 6.10 gc

`gw gc` has two jobs, and `--events` picks the second.

**Worktrees (v0.4, default).** Removes the run worktrees of items in a terminal
stage or the `done`-role stage. `--dry-run` previews; `--force` permits a dirty
worktree, which is otherwise refused with the uncommitted files listed. Needs a
git checkout, and says so in the tool's own voice when there isn't one.

**`--events` (new 2026-09-20, T-0135).** `events.jsonl` only ever grew, and the
snapshot inlines it, so the log's growth was the document's growth: at the
audited 2,000-item / 100k-event scale a `gw open` produced a 13 MB `board.html`,
nearly all of it the history of items that finished months ago.

Compaction **moves** history to `events-archive.jsonl`. It never deletes: the
audit trail is the entire point of an append-only log, and a greppable sibling
file is still an audit trail. The split is:

- every event of an **open** item — an item not in a terminal stage and not in
  the `done`-role stage — is kept, whole;
- for every other bucket, the **last `gc.events_keep`** events (default 20) are
  kept and the rest archived. Board-level events that name no item (`sync`,
  `pause_all`, `config`, `stages`, `compact`) share one bucket and are capped
  the same way.

Order and locking are load-bearing. The archive is **appended before**
`events.jsonl` is rewritten: a crash between the two leaves events in both
files, which is a duplicate a human can see, where the other order loses them.
The whole operation runs under the board lock, so a concurrent `gw move` cannot
have its event read before the split and appended after it, where the rewrite
would drop it. A `compact` event records what was kept, what was archived, the
keep value, and the archive's name.

`--dry-run` reports what would move and writes nothing.

**One cap, three readers.** `gw open` inlines the same partition rather than the
whole log, and so does `GET /api/state` when it is asked with no `?since`
cursor (§8) — a full page reload is not a poll and used to carry the entire
history. Sharing one helper is the point: a snapshot, a compacted board and the
live board must not disagree about which history is hot. Nothing an open item
needs is ever capped away, so a card's Play/Cancel control still reads its own
dispatches. `gw open --all-events` is the escape hatch for anyone who wants the
whole log in one file. When something really was left out, `eventsOmitted` and
`eventsArchive` are written into the config block the viewer already reads (§7)
so the board can say so; an uncompacted board's snapshot and `/api/state`
response are byte-unchanged.

### 6.11 The reading commands

`next`, `show` and `list` are the surface an agent reads the board through, and
each was corrected in this sweep (2026-09-20, T-0138).

- **`next <id>`** names the immediate next stage and, when it is blocked, every
  unmet rule on its own line — a triage hold first, because it is a policy
  boundary and not just another gate; then the gate reasons; then the dependency
  being waited on, named, with the command that unsticks a dependency that can
  never advance. Stages further than one hop ahead are collapsed to a count that
  **names them**, capped at four plus "and N more": the line used to read
  "1 further stage need this first", which was ungrammatical and, worse, never
  said which stages, so the one fact it carried could not be acted on.
- **`show <id>`** renders every unset value as a single em dash (`—`). The block
  used to print `phase: null` on one line and `scope: ` on the next: two
  spellings of the same absence, one of them raw JSON reading as a value called
  "null". `0` and `false` are values, not absences, and keep their own spelling.
  `--json` is untouched — scripts parse that, and a dash is not data.
- **`list`** takes a free-text positional matching an id or a title,
  case-insensitively; `--owner`, which accepts either spelling of a name
  (`rahil` or `human:rahil`) and `none`/`nobody`/`unowned` for the unowned; and
  `--limit N`, which caps the rows **in `--json` too** and says how many it held
  back. The budget a limit protects is the reader's, and on this board the reader
  is usually a program; the JSON shape stays a bare array, because a wrapper
  object would break every script that already parses it. With no argument and
  no flag the output is unchanged. An unknown `--stage` is a usage error naming
  the stages that do exist, not an empty list and exit 0.

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
- Under `serve`, the same shell is served with empty data blocks and hydrates from `GET /api/state` instead, then polls. One shell, two data sources. `serve` never writes `.gatewright/board.html`: it holds the shell in memory (§1).
- The snapshot inlines a **capped** slice of the event log — every event of an open item, the tail of each finished one — and `gw open --all-events` inlines the whole log instead. When anything was left out, the config block carries `eventsOmitted` (a count) and `eventsArchive` (the archive's filename) so the page can say so. They travel in the config block rather than beside the events precisely so the events block stays a plain array and an uncompacted board's snapshot is byte-identical to the one it has always produced. `GET /api/state` with no `?since` reports the same two fields in the same place, so the viewer has one place to read them whichever way the board was loaded. See §6.10.
- Views: Overview (counts by stage/phase/type), Board (columns from `stages.json`, filters by phase/type/stage/flag), Table (sortable), Stages & rules (rendered from `stages.json`), Export/import (JSON download; import only under `serve`).
- Item panel: all fields, stage buttons (disabled when `requires` fails, with the reason), evidence and notes editors, Play/Stop/Resume buttons (v0.2+), triage approve/drop (v0.4), run log tail (v0.4).
- Under `file://` (a `gw open` snapshot), every editor is read-only and a banner says so, with the `gw` command that would make the change.
- Under `serve`, writes go to `POST /api/items/:id`, `POST /api/items/:id/move`, `POST /api/items`, `POST /api/events` and the page re-fetches after each.
- Polls `/api/state?since=<ts>` every 2s under `serve` for live updates from runs.

## 8. serve API (v0.2+)

Binds `127.0.0.1` unless `--host` names another address, and answers only on
the addresses it is actually reachable at. No auth: reachability is the whole
mechanism (§8.2).

```
GET  /                            viewer shell, with empty data blocks
GET  /api/state?since=            { items, events, stages (+gates), config, runs, scheduler }
GET  /api/items/:id/transitions   per-stage { ok, failures, force? }        (§8.3)
GET  /api/runs/:run/log?tail=200  (v0.4)

POST /api/items                   add
POST /api/items/:id               edit (human/agent-owned fields only)
POST /api/items/:id/edit          the same command, explicitly named
POST /api/items/:id/move          { to, evidence[], force? }  runs the same rules as CLI
POST /api/items/:id/note          { text }
POST /api/items/:id/claim         claim                                      (v0.10)
POST /api/items/:id/release       release                                    (v0.10)
POST /api/items/:id/dispatch      queue a dispatch (Play)
POST /api/items/:id/cancel        cancel a queued dispatch
POST /api/items/:id/stop          stop a run already in progress             (v0.9)
POST /api/items/:id/resume        (v0.4)
POST /api/items/:id/triage        { action: approve|drop }                   (v0.4)
POST /api/pause  /api/resume      global

POST /api/stages                  replace the pipeline      ADMIN: loopback only  (v0.10)
POST /api/config                  change settings           ADMIN: loopback only  (v0.10)
```

**Amended 2026-09-20 (T-0139).** Six routes were missing from this list and the
two administrative ones had no entry at all. `claim`/`release` exist because the
board explains an unmet gate in English and offers the action that clears it:
"Someone must have claimed it" is answered by a Claim button, not by telling a
person with a mouse to open a terminal. `stop` exists because `cancel` could
only ever cancel a dispatch that had not started, so an item whose agent was
genuinely running could not be stopped from the very screen showing it running;
it uses the asynchronous stop, because the grace period between the polite kill
and the forceful one is `stop_timeout_s` — 30 seconds by default — and blocking
on it would stop the board answering anything at all, the scheduler's own tick
included.

**The two ADMIN routes are loopback-only, whatever `--host` says.** `--host`
widens who may move a card, which is the feature it exists for. It never widens
who may rewrite the rules of the board: `/api/stages` and `/api/config` compare
the same headers against loopback itself rather than against the widened
allow-list, so no argument can reach them from off-machine. There is no
authentication in this product, so this stays a separate and stricter test that
never collapses back into the ordinary write check. Off loopback the board does
not draw those controls at all, rather than offering them and refusing.

`GET /api/state` with **no** `?since` cursor returns events capped by the same
partition `gw gc --events` and `gw open` use, and carries `eventsOmitted` and
`eventsArchive` in the config block when anything was left out (§6.10). An
incremental poll — one that *does* carry `?since` — is never capped: capping it
would drop events the viewer appends rather than replaces, and it would never
see them again.

### 8.1 Writes invoke the CLI command modules

A write endpoint does not reimplement its command, and does not "use the store
the same way". It loads the same module in `lib/commands/` that the CLI loads
and calls its `run(ctx)` with a synthesized ctx — flags and positionals built
from the request body, stdout and stderr captured. One implementation, therefore
one behaviour: every rule the CLI enforces the board enforces, and every refusal
the CLI gives the board can show. The one-write-path property stops being a
discipline anyone can erode and becomes a fact about the code.

Errors map by class, so the board can react to each meaningfully:

| thrown | status | body |
|---|---|---|
| `RuleError` | 409 | `{ error, failures: [...] }` — the board shows each unmet rule on the card |
| `UsageError` | 400 | `{ error }` |
| `IOError` or anything else | 500 | `{ error }` |

A 409 is the interesting one: it is not a failure of the request, it is the
board working. "needs at least 1 evidence entry" belongs next to the stage
button that refused, in the same words the CLI would have used.

### 8.3 Transitions are asked for, not broadcast

The board needs to know which stages an item can enter and why the others are
refused. That question is answered by the rules engine on the server —
never by a copy of the rules in the viewer. A client-side mirror is a second
implementation, and the one that existed had already drifted: it predated
cumulative gates and went on greying out buttons by the old rule.

```
GET /api/items/:id/transitions
{ "built":     { "ok": true,  "failures": [] },
  "in_review": { "ok": false, "failures": ["in_review: needs matching evidence: ..."] },
  "merged":    { "ok": false, "failures": [...], "force": true } }
```

`force: true` marks a target reachable only by skipping stage order — allowed,
but never by skipping a rule. The failure strings are the ones the CLI prints
and the ones a POST would return, because all three come from the same call.

It is a per-item endpoint rather than a field on `/api/state` for a plain
reason: stage buttons exist only in the open item panel, so exactly one item
needs this at a time, while `/api/state` is polled every two seconds for the
whole board. Measured on the 100-item fixture, embedding transitions in state
took the payload from 46 KiB to 149 KiB — 68% of every poll spent on data for
99 items nobody is looking at. The viewer fetches transitions when a panel
opens and refreshes them while it stays open.

### 8.2 Guarding writes

`serve` binds loopback and has no auth, which is fine while every request is a
GET. It is not fine once writes exist: any page you visit can send a
cross-origin `POST` to `127.0.0.1:7777`. The browser hides the response from the
attacker, but the write has already happened, and the attacker does not need to
read it — moving someone's cards is damage enough.

Every state-changing request (anything not GET or HEAD) must therefore satisfy
all three:

1. `Host` is loopback. This is what defeats DNS rebinding, where an attacker's
   domain resolves to 127.0.0.1: the Host header still carries their name.
2. `Origin` is present AND loopback. Browsers always send `Origin` on
   cross-origin POSTs, so a **missing** Origin on a write is rejected rather than
   waved through — the permissive reading is the one that gets exploited.
3. `Content-Type: application/json`. A form POST cannot set that header without
   triggering a CORS preflight, and the preflight will fail. This is belt and
   braces on top of the Origin check, and it costs one line.

No CORS headers are ever sent in response. There is no legitimate cross-origin
caller.

All writes go through the same module the CLI uses. There is one write path.

**How a header becomes a hostname (amended 2026-09-20, T-0130).** Both checks
reduce a header to a hostname and compare it against a fixed set, and that
reduction is where an allow-list gets talked around, so it is specified rather
than left to a `split(':')`:

- A **`Host`** header is a bare authority, never a URL. It is given an
  `http://` scheme and parsed with `URL`, and IPv6 brackets are stripped so
  `[::1]:7777` and `--host ::1` land on the same canonical name. A Host
  containing a scheme, a path, a query, a fragment, userinfo, a backslash or
  whitespace is malformed and is rejected outright rather than guessed at:
  `attacker@localhost` must never be read as `localhost`.
- An **`Origin`** must be an absolute URL. The literal `null` (an opaque
  origin) and a bare authority are both refused rather than coerced — every
  real browser sends a scheme, so anything else is not a browser and has no
  CSRF story to protect.
- `--host` names an address to **bind**, so it arrives in whichever form a shell
  accepts: `192.168.1.37`, `mybox`, or a bare IPv6 literal `fd00::1` that a
  browser will later send bracketed. It is bracketed before parsing so both
  spellings canonicalise to one entry.

Reads accept a **missing** Origin, because an ordinary same-origin page load
sends none; a supplied one still has to be permitted. A write still requires the
Origin to be present, per rule 2 above.

Getting this wrong was not theoretical. Splitting a bare authority on `:` and
taking the first field is correct only for a dotted IPv4 literal, so `localhost`,
`--host <name>` and `[::1]` each answered 403 on the very URL `gw serve` had
just printed.

## 9. GitHub sync (v0.3)

Uses the `gh` CLI. Never handles tokens.

Pull:
1. `gh issue list --repo <r> --state all --search "updated:>=<last_sync>" --json number,title,body,labels,milestone,state,updatedAt,url --limit 200`
2. For each issue: find item by `gh.number`. If none and state is open → create item (`created_by: github`, stage `backlog`). If found → merge GitHub-owned fields only (`title`, `scope` from body, mapped labels, `phase` from milestone by default — see `github.milestone_to`).
3. If issue state is `closed` and item stage is not terminal → `flag: conflict`, event `flag`, do not change stage.
4. If issue has `dispatch_label` and item has no dispatch event since the label was applied → append `dispatch` event, remove label via `gh issue edit --remove-label`.

Push:
1. Queued move comments: `gh issue comment <n> --body "→ Built · evidence: abc123 · by agent:r-0042"`.
2. Items reaching `close_on` stage → `gh issue close <n>`.
3. If `mirror_children` and an agent-created child has a linked parent → `gh issue create --title ... --body "Opened by agent run r-0042 while working on #42.\n\n<scope>"`, store `gh` on the child.

Conflict rule: GitHub-owned fields take the newer `updated_at`. Tracker-owned fields are never written by sync. There is no three-way merge.

### 9.1 How sync is built, so it can be trusted

**One injectable wrapper.** Every `gh` invocation goes through a single function
that takes the argv and returns stdout. Nothing else in the codebase shells out
to `gh`. That function is injectable, so the entire sync layer is tested against
a stub that returns recorded fixtures and the test suite never touches the
network or needs a GitHub account. A sync that can only be tested by syncing is
a sync nobody will refactor.

**`--dry-run` prints what it would do and touches nothing** — neither GitHub nor
`.gatewright/`. It is the first thing a cautious user runs against a real repo,
so it is not an afterthought.

**Sync is idempotent.** `last_sync` is a watermark, not a checkpoint: running
sync twice with no intervening change produces no writes and no events, and a
test asserts exactly that by hashing the data files. A sync that churns the
board on every run makes `git log` on `.gatewright/` useless, which is one of
the reasons the data is in git at all.

**An incoming issue lands in the stage it has earned.** Issues arrive in the
`initial` role's stage regardless of how finished they look on GitHub — closed,
labelled done, whatever. This is the same invariant import already enforces
(§6): nothing mints a stage that was never earned, or the board means nothing.
A closed issue with no corresponding work is flagged for a human, not silently
marked verified.

**A label that maps to a value outside `config.vocab` is a warning, not a
write.** The item keeps its previous value and sync reports the mismatch, naming
the label and the field. Writing an unvalidated value would let GitHub put the
board into a state the CLI would refuse to create, and `gw check` would then
report an item the user cannot fix from the board's own tools.

**`gh` missing or unauthenticated is a clear error naming the fix** (`gh auth
login`), not a stack trace. We never handle tokens; that is the whole reason
this shells out rather than calling the API.

## 10. Runner (v0.4)

Scheduler loop in `serve`, every `tick_s` (default 5):

1. If `runner.paused` → skip.
2. Running count ≥ `max_concurrent` → skip.
3. Candidates: items where the next stage has `auto: true`, `flag` is null, deps satisfy the next stage's `deps_at_least`, and either a `dispatch` event exists with no later `run_ended`/`cancel`, or the stage before is `auto` (continuation).
4. Pick by index in `config.vocab.priority` (position 0 first), then oldest `updated`. An item whose `priority` is absent from that array, or null, sorts after every item whose priority is in it — an unclassified item never jumps the queue.
5. Start: create worktree `git worktree add <root>/<id> -b gw/<id>` (reuse if exists). If `memory.enabled` and `recall.on_dispatch`: call `memory.recall("<title>. <scope>", top_k)`, trim to `max_chars`, fill `{{prior_context}}`; if `project_id` is set, fill `{{capsule}}`. A memory failure logs a warning and leaves both empty; it never blocks the run. Render prompt (§10.3), spawn provider `cmd` with `cwd` = worktree and env `GW_ACTOR=agent:<run>`, `GW_ITEM=<id>`, `GW_ROOT=<repo>`. Pipe stdout+stderr to `runs/<id>-<run>.log`. Append `run_started`. Set `owner`.
6. On exit — **normal exit included, which is the common case** — append `run_ended`
   with the outcome (`ok` when the process exits 0, otherwise `error`) and
   `git -C <worktree> rev-parse HEAD`, clear the registry record, and release
   `owner`. Exactly one `run_ended` per run: a run that was stopped or timed out
   has already written one, and the exit handler must not write a second.
   **The owner is released on every outcome, not only on failure.** `owner` means
   "someone is working on this now", and when the process is gone nobody is; the
   event log keeps the attribution. Leaving a finished run's owner in place would
   also make the item look stale to `check` and keep it out of the scheduler's
   sight for no reason.
   Without this step the runner starts `max_concurrent` runs and then reports
   `at_capacity` forever, which no unit test notices because each mechanism works
   in isolation — only ticking the scheduler after a completed run reveals it. If outcome is `ok` and `memory.remember.on_run_ok`: write one memory (see §14).
7. On `cancel` event for a running item: SIGTERM, wait `stop_timeout_s`, SIGKILL. Set `flag: paused`, store `prev_stage` and `last_commit` on the item. Append `run_ended` with `cancelled`.
8. On `resume`: clear flag, restore stage, append `dispatch`; next tick starts with `{{log_tail}}` filled from the last log.
9. `run_timeout_min` exceeded → same as cancel with outcome `timeout`.

The agent inside a run uses the normal CLI. `GW_ROOT` points it at the main repo (the directory holding `.gatewright/`), not the worktree's copy, so all runs write to one board.

### 10.2 Windows

The runner's controls are POSIX constructs: SIGTERM, process groups, and
`/proc`. Windows has none of them, so the behaviour is reproduced rather than
translated, and where it cannot be reproduced exactly the difference is
documented instead of hidden.

**Termination.** Node's `process.kill` on Windows terminates immediately at any
signal name — there is no graceful stop. The escalation is therefore
`taskkill /PID <pid> /T` (request close, whole tree) followed after
`stop_timeout_s` by `taskkill /PID <pid> /T /F` (force, whole tree). `/T` is what
replaces the process group: it reaches the children an agent spawned, which is
the property that matters, since an orphaned child keeps costing money.

**Liveness and pid reuse.** `/proc/<pid>/cwd` cannot be consulted. Liveness uses
the OS process list; the pid-reuse guard compares the recorded start time
against the live process's start time rather than its working directory. That is
a weaker guard than the POSIX path — it cannot prove the process is *ours*, only
that it is the same process that was recorded — and the weakening is stated here
rather than discovered by someone reading the source. It is weaker in a second
way too: under a wedged start-time probe the guard is not merely weak, it is
skipped entirely (see Command timeouts, next), and `/T` means an unverified
kill can take an entire process tree with it, not just one pid.

**Command timeouts.** `taskkill` and the `Get-Process` start-time probe are
both bounded — a value derived from `stop_timeout_s`, clamped to [250ms, 5s] —
so a wedged copy of either can never hang `gw stop`, which must keep working as
a kill switch even when the host is otherwise unhealthy (§10.1). The two
timeouts are handled differently, because a wedged *query* and a wedged
*kill command* mean different things:

- If the start-time probe times out, the pid-reuse guard fails **open**: the
  live process is treated as the recorded run and escalation proceeds. A
  wedged probe is evidence the host is unhealthy, not evidence about the
  target process, and refusing to signal on that basis would make the switch
  go silently inert exactly when it is needed most. A *confirmed* answer —
  the process is gone, or its start time doesn't match — still fails closed,
  same as always: an unrelated process is never signalled on a guess. Failing
  open is never a silent decision: it is printed to stderr, naming the pid,
  the moment it happens, and the resulting `run_ended` event (if the run
  does end up reported stopped) carries `identity_unverified: true` — absent
  entirely on an ordinary confirmed stop, so `grep identity_unverified
  events.jsonl` is a real incident-review tool, not a field nobody checks.
  This is how "we killed pid 4123 having confirmed it" stays distinguishable
  from "we killed pid 4123 hoping it was ours."
- If the force `taskkill` times out, that is never reported as a stop: the
  run is put back in the registry (untouched, for a later attempt) and the
  item's stage/owner are left as they were, rather than claiming a kill that
  may not have happened. `gw stop` surfaces this as
  `stop_unconfirmed` and exits non-zero. A timed-out *graceful* `taskkill`
  does not get this treatment — it simply doesn't stop escalation to force.

**Line endings.** Files whose bytes are part of a contract — the templates and
the instruction block — are LF in the repository and written as LF by `init` on
every platform. A board is git-tracked and frequently shared between machines;
a file that changes bytes depending on who ran `init` would make `gw check`
report an out-of-band write after an innocent checkout.

**Paths.** Anything compared against a path the OS produced is compared after
normalisation. `git` reports forward slashes even on Windows while `path.join`
produces backslashes, and a raw comparison between them fails for no reason a
user could act on.

Normalisation also expands 8.3 short components (`LONGNA~1`) and corrects
drive-letter case, via `realpathSync.native`, and that is load-bearing for more
than comparison: libuv's Windows filesystem-event backend *asserts* that the
filename `ReadDirectoryChangesW` reports begins with the directory string it
was given. Handing `fs.watch` an unnormalised path therefore does not produce a
catchable error — it fail-fasts the process with `0xC0000409` and no message on
stderr. A short component is ordinary on Windows, since any account name over
eight characters produces one, so the path passed to `fs.watch` is normalised
first. Node 22 tolerated the mismatch and Node 24 asserts, which is the kind of
difference that appears only on the runtime a user happens to have.

### 10.1 Rules for spawning things

Everything before v0.4 could only lose work. The runner can spend money and
leave processes behind, so it gets stricter rules than the rest of the tool.

**Nothing spawns without two deliberate acts.** A provider must be configured
AND the scheduler must be started. A default install has no provider and no
running scheduler; `serve` alone never spawns. An unconfigured provider is an
error at start, not a silent no-op that surprises someone later.

**The spawn function is injectable, like `gh`.** One module owns process
creation; everything else calls it. Tests pass a stub and **no test may ever
spawn a real agent** — a suite that bills the person running it is a suite
nobody runs. The same rule that made the sync layer testable applies here with
more force.

**`--dry-run` renders the prompt and logs the exact argv without spawning.**
This is how a user sees what their configuration will actually do before it does
it, and it is the first thing anyone sane tries.

> **Not shipped (as of 2026-09-20, v0.13.2).** This paragraph has always
> described an intention, not a command. `createRunner({ dryRun: true })` is
> real and returns `{ prompt, argv, provider, log, env }` without spawning — but
> it is reachable only from a test, and nothing in `lib/cli/` or
> `lib/commands/serve.js` passes the flag. There is no `gw serve --dry-run` and
> no `gw dispatch --dry-run`. The promise is left standing rather than deleted
> because the seam it needs already exists and the reason for it is unchanged;
> it is marked here so nobody reads it as a feature. The equivalent promise for
> `gh` in §9.1 *is* shipped: `gw sync --dry-run` is a real flag.

**Every run is recorded on disk before the process starts**, in
`.gatewright/runs/<run>.json` with its pid, item, worktree and start time. Not
in the server's memory. `gw stop --all` must work from any terminal, with no
browser and no `serve` — including when `serve` has died and left runs behind.
A kill switch that depends on the thing that might have crashed is not a kill
switch.

**Orphans are reconciled on startup.** A run whose recorded pid is no longer
alive gets a `run_ended` event with outcome `error`, and its item's owner is
cleared. Otherwise a crash strands items owned by a run that will never finish,
and the board lies about what is happening.

**Caps are refused before spawning, not after.** `max_concurrent`,
`run_timeout_min`, and `max_children_per_item` are checked at the point of
decision. A cap enforced after the money is spent is a report, not a cap.

**Agent-created work is held by default.** `needs-triage` is not an advisory
flag: a held item is invisible to the scheduler's eligibility check. The failure
mode being prevented is a run that files three items, each of which starts a run
that files three more.

**One run, one worktree, one branch, one log.** Killing a run never dirties the
main checkout, and two runs cannot stomp each other's files.

### 10.3 Rendering the dispatch prompt

New 2026-09-20 (T-0128). `prompt.md` (§1) is rendered by substituting ten
placeholders: `{{title}}`, `{{scope}}`, `{{deps}}`, `{{notes}}`,
`{{log_tail}}`, `{{prior_context}}`, `{{capsule}}`, `{{stage}}`,
`{{target_stage}}`, `{{exit}}`.

**The first seven are written by someone who is not the person running the
agent.** A GitHub issue body anyone can open reaches `{{scope}}` through
`gw sync`; a previous run's output reaches `{{log_tail}}`; a memory backend
reaches `{{prior_context}}` and `{{capsule}}`. Splicing that text straight into
the template put a stranger's `## When done` at the same structural level as the
template's own, in a prompt handed to an unattended
`claude -p ... --allowedTools Edit,Bash`. The last three are different: `stage`,
`target_stage` and `exit` come from `stages.json`, which is written by whoever
owns the board, so they are substituted plainly.

Each of the seven is quoted as data:

```
<<<GW-DATA:scope>>>
...the field's text...
<<<END-GW-DATA:scope>>>
```

- **Marker forgery is neutralised.** Every `<<<` in the quoted text is escaped
  to `\<\<\<`, wherever it appears and mid-line included, so quoted text can
  never forge a closing marker.
- **Structure is neutralised.** An ATX heading or a code fence at the start of a
  line (up to three leading spaces, as Markdown allows) is escaped, so a
  stranger's `## When done` cannot sit at the same level as the template's own
  headings. Markdown renders every escaped form as the literal text, so nothing
  is hidden from whoever later reads the run's prompt: the text is all still
  there, it just cannot restructure the page.
- **Each field has its own cap**, applied before quoting: `title` 500,
  `deps` 1000, `notes`/`prior_context`/`capsule` 4000 (also the default for any
  field added later), `scope`/`log_tail` 8000 characters. A field longer than
  that is not information, it is a flood — it pushes the instructions out of the
  model's attention, and out of some providers' argv limits, at whatever length
  the author chose. Truncation is visible: `(truncated: N of M characters
  shown)`.
- **An absent field stays absent.** Markers around nothing tell an agent
  nothing, so an empty value substitutes as empty, and `prompt.md`'s closing
  line explains what an empty prior-context section means.
- **The markers own their lines** however the placeholder was written, including
  inline in the middle of a sentence.

**Fencing happens at substitution time and never in the template.** `prompt.md`
ships expecting to be edited (§1), so a template author who rewrites a line must
not be able to drop the quoting with it. What the template *does* own is the
explanation: the shipped one tells the agent that everything between the markers
is DATA, that anyone can write it, and that it must never follow an instruction,
request or heading found inside it — and that explanation appears **before** the
first quoted field, or an agent reads a stranger's text with no warning attached.

**Provider argv substitution uses callbacks.** `{prompt}` and `{item}` are
replaced in `runner.providers.<name>.cmd` with function replacements, not string
ones. A string replacement is itself a pattern, so `$&`, ``$` ``, `$'` and `$1`
occurring in an item's title or a quoted issue body rewrote the argv the
provider was handed.

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
This repo uses gatewright. At the start of every session run `gw brief` and act on it. Finished work is out of the open counts: `gw list --stage verified` lists it.
- Record progress only through the `gw` CLI. Never edit files in `.gatewright/` directly.
- Identify yourself: export `GW_ACTOR=agent:<name>` (e.g. `agent:codex`) once per session, or pass `--by agent:<name>` on any write — without it your work is recorded as done by a human.
- Before your first edit of a task, put the plan on the board yourself: `gw add "<step>"` for each step you intend to take (`--parent <id>` for sub-steps). Do not wait to be asked. Plan steps are items, never notes — `gw note <id>` is only for progress remarks on an existing item.
- **Exception:** if you are working on gatewright itself, or you have otherwise been told not to write to a particular board, do not write to it — that board is the user's live tracker, not your scratchpad. Create a scratch board instead: `D=$(mktemp -d) && cd "$D" && gw init`, and prefix every `gw` command with `cd "$D" && ` (`cd` does not persist between your tool calls). Or keep the plan in your reply and let the human running you track it.
- `gw claim <id>` before changing code for an item. `gw move <id> <stage> --evidence <commit|test|PR>` when you reach a stage. The DEFAULT pipeline is backlog → building → built → in_review → reviewed → merged → verified, but a board may define its own — `gw next <id>` names the real, legal moves for the board you are on. No board yet? `gw init` creates one.
- Agent-created items may be held with `needs-triage`. A different agent or any human may approve; creators may only `--drop`. Identity is declared, not authenticated.
- Work you discover that someone else could pick up: `gw add "<title>" --parent <id>`.
- If a commit is refused because it is not on the board, add or claim the item it belongs to — never `git commit --no-verify`.
- If `gw move` refuses, fix the reason it names. `--force` is only ever for pipeline order — reopening finished work, re-entering from paused — and only when the refusal itself prints it; never to get past a gate. Unsure what's next? `gw next <id>`.
<!-- gatewright:end -->
```

## 12. Adapters (v0.4)

`adapters/claude-code/` — plugin manifest with a `SessionStart` hook running `gw brief`, a `PreToolUse` hook running `gw guard --pretool` before any edit or write (§6.5), a skill file pointing at the AGENTS.md rules, and `.mcp.json` registering `gw mcp` (§6.9).
`adapters/cursor/` — `.cursor/rules/gatewright.mdc` with the same block, and the `.cursor/mcp.json` snippet.
`adapters/codex/` — snippet for `AGENTS.md` (Codex already reads it), and the `config.toml` `[mcp_servers.gw]` snippet.
`adapters/generic/` — the block above, for anything else.

Adapters contain no logic. If a provider can't run a command at session start, the AGENTS.md instruction is the fallback and is sufficient.

**Amended 2026-09-20 (T-0137).** Every adapter now also carries the one-line MCP
registration for its provider — the same `{"command": "gw", "args": ["mcp"]}`
in whatever shape that client's config takes. The Claude Code plugin registers
it through its own `.mcp.json` rather than the manifest's `mcpServers` field.
This remains no logic: a registration is a path and two strings.

The `PreToolUse` hook does not call `gw guard` directly. It first probes for a
guard-capable `gw` and steps aside when there is none, because an older `gw`
first on `PATH` answers `gw guard --pretool` with a usage error, which Claude
Code reads as a refusal — and that blocked every edit in the repository. On
Windows it finds `gw.cmd`. A project set up before v0.13 keeps the old hook
until `gw hook install --agent` is run again; `gw hook status` and
`gw doctor` (§6.8) each report a stale one.

`adapters/second-brain/` is the exception: it is a memory provider (see §14) and contains the client code for that backend. Provider adapters and memory adapters are different kinds of thing and live in the same folder only for discoverability.

## 13. Non-functional

- `brief` on 500 items: under 100ms.
- `items.jsonl` writes: atomic **and durable** — write a sibling temp file, `fsync` it, rename over the target, then `fsync` the directory that now holds the new name. Appends to `events.jsonl` are `fsync`ed too. A crash therefore leaves either the old file or the new one, never a renamed file whose contents were still in the page cache (amended 2026-09-20, T-0136; the version this replaces did no `fsync` at all). Windows has no fsync-a-directory concept and refuses the open outright, so the directory step degrades to a no-op there rather than failing the write. Measured cost on btrfs: `gw add` 67ms → 77ms.
- Concurrent CLI writes from multiple runs: advisory lock file `.gatewright/.lock` with 2s retry, 10s give-up.
- No telemetry. No network except `gh` in `sync` and the loopback server.
- Node 22+. No native modules. `npm ls --prod` is empty. 18 and 20 are EOL
  (April 2025 and April 2026); the CI matrix covers the two supported LTS lines.

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

**Transport (P5-01, decided).** MCP over plain HTTP — JSON-RPC POSTs built with
`fetch`, no SDK. An MCP SDK would be the first runtime dependency in the project
and would arrive in every install to serve a feature that is off by default;
R7's zero-dependency promise is worth more than the convenience. MCP rather than
a bespoke HTTP API because it is the interface the backend already exposes and
the one other backends are most likely to speak, so the adapter stays thin and
replaceable.

**The interface is injectable and no test touches the network.** The provider
takes its transport as a parameter, exactly as `gh` and the runner's spawn do.
The suite proves the default install makes zero network calls, and the adapter's
own tests run against recorded responses. This is the third subsystem built this
way; by now it is the house pattern rather than a precaution.

**A memory failure is never fatal.** Every call has a 5s timeout and a failure
logs to `runs/memory.log` and returns empty. A run starts without prior context,
a move completes without a memory being written, a brief renders. The tracker's
job does not depend on a service it does not own — and a memory backend that can
block the board would be worse than no memory backend.
