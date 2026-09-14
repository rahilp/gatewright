# Gatewright

Evidence-gated work tracking for coding agents. File-first, provider-agnostic, zero dependencies.

**Work that earns its way forward.**

## The problem

Every coding-agent session starts from zero: the agent doesn't know what is in flight, what is blocked, or what it was supposed to pick up next, so the human re-explains it, or the agent re-reads a wall of markdown and burns context before writing a line of code. When the session ends, the record of what happened lives in a chat transcript nobody will open again.

## The 60-second quickstart

Install once, then use `gw` from anywhere:

```sh
npm install -g gatewright        # puts `gw` on PATH
gw init
gw add "Wire the scheduler tick loop" --phase P1 --type feature --gate G0
gw claim P1-01
gw move P1-01 specified
gw move P1-01 building
gw move P1-01 built --evidence abc1234 --evidence test/scheduler.test.js
gw brief
gw open
```

No global install? Use `npx gatewright <command>` for each command instead. The package ships both `gw` and `gatewright` as binary names so a `gw` collision on your PATH is never a blocker.

`init` creates `.gatewright/` (items, events, stages, config, prompt) and writes an instruction block to `AGENTS.md`. The first store write — your first `gw add` or `gw move` — creates `.digest`. `gw open` writes `board.html`. From then on the CLI is the only write path; the board is a snapshot the tool writes on demand.

## The refusal

A card in Built has evidence because it could not have got there without it. `gw move` evaluates the target stage's exit rule from `stages.json` and refuses the move if the rule is unmet.

```
$ gw move P1-01 built
target stage requirements are not met
needs at least 1 evidence entry: run `gw move P1-01 built --evidence <e>`
$ echo $?
1
```

Add the evidence and the same command succeeds:

```
$ gw move P1-01 built --evidence abc1234 --evidence test/scheduler.test.js
P1-01  building → built  ·  evidence: abc1234, test/scheduler.test.js
```

`--force` exists to skip stages, not to skip rules. Use it when the pipeline order is wrong, not when the rule is.

## How it works

```
.gatewright/                     (created by `gw init`)
  items.jsonl    one item per line, current state
  events.jsonl   append-only, one event per line
  stages.json    stages and their exit rules
  config.json    vocab, labels, policy, runner, memory
  prompt.md      dispatch prompt template (v0.2)

created on the first store write (first add or move):
  .digest        SHA-256 of items.jsonl after each gw write

created by `gw open`:
  board.html     viewer snapshot with the data inlined
```

A change to one item is a one-line diff. `grep P2-01 .gatewright/events.jsonl` is the audit tool. `git log` on `.gatewright/` is the project history.

Three rules keep the data trustworthy:

- The CLI is the only write path. The CLI, the `serve` API, `sync`, and the scheduler all call the same `store` module, so every stage move evaluates the same exit rules whether a human dragged a card or an agent ran a command.
- Agents never edit files in `.gatewright/` directly. `store` writes a hash of `items.jsonl` to `.gatewright/.digest` after every successful write; `gw check` reports a mismatch and re-baselines so the same edit is reported once, not on every run.
- The board is a snapshot, not a live page. `gw open` takes the pinned `viewer/board.html`, injects the current data as `<script type="application/json">` blocks, and writes `.gatewright/board.html`. A `file://` page cannot fetch its own data because Chrome and Firefox give it an opaque origin; inlining works in every browser with no server and no flags.

## The board

Board view:

![Board](docs/img/board.png)

Overview view:

![Overview](docs/img/overview.png)

The board is read-only when opened from a snapshot. Under `gw serve` (v0.2) it becomes live, with editors, Play and Stop, and a 2-second poll for new events.

## Commands

Every command exits 0 on success, 1 on a rule violation, 2 on a usage error, 3 on an I/O error. Every command that writes appends one event.

| Command | What it does |
| --- | --- |
| `gw init [--force]` | Create `.gatewright/` and write the instruction block to `AGENTS.md` (and `CLAUDE.md`, `.cursor/rules`, `.github/copilot-instructions.md` if present) |
| `gw brief [--me <owner>] [--json] [--recall]` | Print in-flight, blocked, owned, and next-unblocked items in 25 lines or fewer. `--recall` is accepted but has no effect until the v0.5 memory backend is enabled. |
| `gw add "<title>" [--parent ID] [--type T] [--phase P] [--priority P] [--gate G] [--scope "..."] [--by <who>]` | Create an item; print its id |
| `gw claim <id> [--by <who>]` | Take ownership |
| `gw release <id>` | Drop ownership |
| `gw move <id> <stage> [--evidence <e>...] [--by <who>] [--force]` | Advance a stage; refused if its exit rule is unmet |
| `gw edit <id> [--title ...] [--scope ...] [--priority P] [--type T] [--phase P] [--gate G] [--deps a,b] [--refs a,b] [--by <who>]` | Change non-stage, non-evidence, non-notes fields |
| `gw note <id> "<text>" [--by <who>]` | Append a timestamped line to the item's notes |
| `gw show <id> [--json]` | Print one item and its events |
| `gw list [--stage S] [--phase P] [--flag F] [--json]` | Print items as a flat list |
| `gw check [--json]` | Report rule violations and out-of-band writes; exit 1 on any report |
| `gw import <file> [--format md]` | Ingest a markdown task list. CSV and JSON are planned but not yet accepted; `--format csv` or `--format json` returns exit 2 today. |
| `gw open [--no-browser]` | Write `board.html` and open it |
| `gw upgrade [--templates]` | Replace the CLI and the viewer, never the data |
| `gw serve [--port 7777] [--open]` | Serve the board with a write API and (v0.4) a scheduler — **not yet, v0.2** |
| `gw sync [--dry-run]` | Pull and push GitHub issues through `gh` — **not yet, v0.3** |
| `gw stop <id> \| --all` | Stop a run, or stop all runs — **not yet, v0.4** |
| `gw resume <id>` | Resume a paused run with the log tail in the prompt — **not yet, v0.4** |
| `gw triage <id> --approve \| --drop` | Approve or drop an agent-created item — **not yet, v0.4** |

The full contract, including field ownership, the move algorithm, and the brief layout, is in `specs.md`.

## Using it with agents

`gw init` writes a fenced block into `AGENTS.md`. Every mainstream agent reads it. Claude Code, Codex, Cursor, and GitHub Copilot all read their own rules file, so the same content lands in the right place for each: `CLAUDE.md`, `.cursor/rules/gatewright.mdc`, and `.github/copilot-instructions.md`. `init` writes to whichever of those files already exists.

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

The agent's whole interface is `brief`, `show`, `claim`, `move`, `note`, `add`, and `edit`. It never reads the JSONL directly, never reads GitHub, and never sees the scheduler. `brief` is capped at 25 lines so an agent's first action costs under 500 tokens; `show <id>` is the way to get detail on one item.

## Stages and gates

`.gatewright/stages.json` defines the pipeline. The default is:

```
backlog → specified → building → built → in_review → reviewed → merged → verified
```

with `paused` and `dropped` as side states. Each stage has:

- `label` — shown on the board.
- `exit` — a human-readable description of what "done" means at this stage. Shown in the brief and the board. No machine meaning.
- `auto` — when `true`, the scheduler (v0.4) may move items into this stage. When `false`, only a human can. The default is `auto: false` for `reviewed`, `merged`, and `verified`.
- `requires` — the machine-checked rule for **entering** the next stage. Keys: `owner: true`, `evidence_min: n`, `evidence_match: regex`, `deps_at_least: stage`.

`stages.json` is the entire process definition. There is no hardcoded logic outside it. Add a stage, rename a stage, change the rule for entering `built`, mark `reviewed` as auto, drop a stage entirely — edit the JSON and `gw check` will pick it up. The board re-renders from it; `brief` reads the same file; the scheduler (when it lands) will too.

## Status

Gatewright is at v0.1.

Shipped in v0.1: `init`, `brief`, `add`, `claim`, `release`, `move`, `edit`, `note`, `show`, `list`, `check`, `import` (markdown only — CSV and JSON return exit 2 today), `open`, `upgrade`. Snapshot viewer with board, table, and overview views. Out-of-band write detection via `.digest`.

Coming:

- v0.2 — `serve` with a write API and live board (Play and Stop write events; no runner yet).
- v0.3 — `gw sync` for GitHub issues, label-driven dispatch, comments on move, child mirroring.
- v0.4 — scheduler, git worktrees per run, runner, stop and resume, triage gate, kill switch, provider adapters.
- v0.5 — optional memory backend: recall prior context into dispatch prompts, remember on completion. Off by default; off means no network calls.

Node 18+. Zero runtime dependencies. MIT.

```
$ npm ls --prod
npm warn Expanding --prod to --production. This will stop working in the next major version of npm.
npm warn config production Use `--omit=dev` instead.
gatewright@0.1.0-dev /home/rahil/Projects/gatewright
└── (empty)
```