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
gw add "Wire the scheduler tick loop"
gw claim T-0001
gw move T-0001 building
gw edit T-0001 --scope "Scheduler tick fires once per tick_s and never overlaps a run in flight"
gw move T-0001 built --evidence abc1234 --evidence test/scheduler.test.js
gw brief
gw open
```

Capture is one command with no required flags: `phase`, `type` and `priority` start out null, because at the moment you write a title down you genuinely may not know them yet, and guessing is worse than leaving them unset. `add` → `claim` → `move … building` is the whole path to "I am working on this" — no mandatory edit stands in the way. Rigor still applies; it just applies where a claim of completion is made. Reaching `built` needs a scope (what "done" means) and evidence, because that is the step where the claim needs to hold up, not the step where the idea got written down.

No global install? Use `npx gatewright <command>` for each command instead. The package ships both `gw` and `gatewright` as binary names so a `gw` collision on your PATH is never a blocker.

In a terminal, `init` then asks a few questions — how work reaches main, how items are numbered, which phases you use, and whether to enable the runner — and writes the answers. Anywhere without a terminal, and with `--yes`, `GW_NO_INPUT` or `CI` set, it skips all of that and installs the defaults unchanged, so agents and CI see exactly what they always did.

The first question is the one that matters most. If you commit straight to main, the pipeline ends at **Built**, and Built is the finish line. If you work through pull requests, it continues into In review, Reviewed, Merged and Verified, and advancing past Built needs a PR URL as evidence. Choosing the wrong one is not fatal — a tracker whose last stage is never reachable simply reports finished work as though it were still in flight.

`init` creates `.gatewright/` (items, events, stages, config, prompt) and writes an instruction block to `AGENTS.md`. The first store write — your first `gw add` or `gw move` — creates `.digest`. `gw open` writes `board.html`. The CLI and the live board's write API are the only write paths; the snapshot board is written on demand.

## The refusal

A card in Built has evidence because it could not have got there without it. `gw move` evaluates the target stage's exit rule from `stages.json` and refuses the move if the rule is unmet.

```
$ gw move T-0001 built
target stage requirements are not met
needs a scope: run `gw edit T-0001 --scope "<what done looks like>"`
needs at least 1 evidence entry: run `gw move T-0001 built --evidence <e>`
$ echo $?
1
```

Add the scope and the evidence and the same command succeeds:

```
$ gw edit T-0001 --scope "Scheduler tick fires once per tick_s and never overlaps a run in flight"
$ gw move T-0001 built --evidence abc1234 --evidence test/scheduler.test.js
T-0001  building → built  ·  evidence: abc1234, test/scheduler.test.js
```

`--force` exists to skip stages, not to skip rules. Use it when the pipeline order is wrong, not when the rule is — reopening finished work and re-entering from a side stage are order, and the refusal prints the forced command for you. No refusal ever asks you to force your way past a gate.

## Opting in is the part instructions cannot enforce

Everything above governs work that is already on the board. Nothing in it stops a person or an agent from editing code and committing without ever touching `gw` — and instructions in `AGENTS.md` are advice, not a gate. `gw hook install` turns that advice into three gates, all of them asking one question: *which item accounts for this change?*

```
$ gw hook install --ci --agent
gw: installed the commit-msg hook at .git/hooks/commit-msg
gw: wrote .github/workflows/gatewright.yml
gw: edits are now gated before they happen — wrote the PreToolUse guard to .claude/settings.json

$ git commit -m "quick fix"
gw: this change is not on the board.
  no item is claimed by human:you, and neither the commit message nor the branch names one.
  Fix one of:
    gw brief — see what is already on the board
    gw claim <id> — take the item this change belongs to
    gw add "<what this change is>" — if it is not on the board yet
    name the item in the commit message, e.g. "P1-07: <subject>"
  Deliberate exception: git commit --no-verify
```

- **Before the edit** (`--agent`): an agent's first `Edit` or `Write` is refused until the work is on the board, so the plan gets written down while it still exists. This is the one that matters most: told at commit time, an agent has already lost the plan it should have recorded.
- **At the commit** (`commit-msg`): a claimed item, an id in the commit message, or an id in the branch name all count. Commits that only touch `.gatewright/` are exempt.
- **In CI** (`--ci`): `gw check` audits the board, and `gw guard --range` audits every commit in the pull request. A claim is local state that does not travel with a commit, so CI judges what the commit itself says.

`--no-verify` still works, on purpose — a tracker that cannot be bypassed is a tracker that gets uninstalled, and a bypass leaves a record. Set `guard.mode` to `"warn"` to report without blocking, or `guard.enabled` to `false` to switch it off.

## How it works

```
.gatewright/                     (created by `gw init`)
  items.jsonl    one item per line, current state
  events.jsonl   append-only, one event per line
  stages.json    stages and their exit rules
  config.json    vocab, labels, policy, runner, memory
  prompt.md      dispatch prompt template

created on the first store write (first add or move):
  .digest        SHA-256 of items.jsonl after each gw write

created by `gw open`:
  board.html     viewer snapshot with the data inlined
```

A change to one item is a one-line diff. `grep P2-01 .gatewright/events.jsonl` is the audit tool. `git log` on `.gatewright/` is the project history.

Three rules keep the data trustworthy:

- Gatewright is the only write path. The CLI, the `serve` API, `sync`, and the scheduler all call the same `store` module, so every stage move evaluates the same exit rules whether a human dragged a card or an agent ran a command.
- Agents never edit files in `.gatewright/` directly. `store` writes a hash of `items.jsonl` to `.gatewright/.digest` after every successful write; `gw check` reports a mismatch and re-baselines so the same edit is reported once, not on every run.
- The board is a snapshot, not a live page. `gw open` takes the pinned `viewer/board.html`, injects the current data as `<script type="application/json">` blocks, and writes `.gatewright/board.html`. A `file://` page cannot fetch its own data because Chrome and Firefox give it an opaque origin; inlining works in every browser with no server and no flags.

## The board

Board view:

![Board](docs/img/board.png)

Overview view:

![Overview](docs/img/overview.png)

The board is read-only when opened from a snapshot. `gw serve` makes it live, with editors, live run logs, triage and resume controls, global pause, and a 2-second poll for new events.

## Live board

`gw serve` serves the board on loopback and polls the store for new items and events every two seconds. Edits, moves, notes, Play, Stop, triage, resume, and global pause write back through the same rules as the CLI. When the runner is enabled, its scheduler starts eligible dispatched items and the board exposes their live logs.

```
$ gw serve --port 17888
Gatewright live board: http://127.0.0.1:17888/
```

Cards drag between columns. A column that would refuse the move says so while you drag rather than letting the card snap back, and a backward move — correcting a mis-drag — is offered separately and styled differently so it is never done by accident.

A refused move is explained in English rather than in rule syntax, and where the board can clear the condition itself it offers the action instead of a command to type:

```
Not met yet:
  Someone must have claimed it     [Claim]
  Needs at least one piece of evidence
```

Stages, gates and settings are editable from the board. "Stages & rules" adds, renames, reorders and removes stages, and builds a gate from a form — evidence counts, an owner requirement, a dependency stage — showing the same English read-back the board uses when it refuses a move. The Settings view is generated from the same schema `gw config` validates against, so the two cannot drift.

**Those three are loopback only.** Moving a card is available wherever the board is reachable, which is what `--host` is for; changing the rules of the board is not. Off loopback the controls are not drawn at all rather than offered and refused, and there is no authentication to configure — reachability is the whole mechanism.

Finished columns collapse to a count with the most recent items visible, so a board that is mostly archive still shows the work that is live.

Play queues a dispatch event. The scheduler can act on that event only when its runner controls permit it. Stop cancels a queued dispatch or stops a recorded run. Global pause stops new dispatches.

## Runner and safety

The runner is a scheduler for dispatched items. Each run gets its own git worktree and `gw/<id>` branch, and its combined output is recorded under `.gatewright/runs/`.

Nothing spawns without two deliberate acts: configure a provider in `runner.providers` and set `runner.enabled: true`. A default install runs nothing; `gw serve` alone never spawns.

Turning it on, without editing files by hand:

```sh
gw config runner.provider claude   # must match a key in runner.providers
gw config runner.enabled true
# restart `gw serve` — config is read once, at startup
```

Or run `gw config` with no arguments in a terminal to be walked through every setting. `gw config --list` prints the current values. The vocabularies are settable as comma-separated lists (`gw config vocab.phase "P0,P1,P2"`); `runner.providers` and the stage pipeline are structures rather than values and are still edited in `.gatewright/config.json` and `stages.json` directly.

Work created by an agent is held with `needs-triage` by default. A different agent or any human can approve it with `gw triage <id> --approve`; its creator can only drop it. This prevents a run from filing three items, each of which starts a run that files three more. Identity is declared, not authenticated.

`max_children_per_item`, `max_depth`, `max_concurrent`, and `run_timeout_min` are enforced before a run starts. The runner also has three kill switches: per-run stop, `gw stop --all`, and global pause. `gw stop --all` works from any terminal with no browser and no `serve` process running, including after `serve` has crashed.

Use `gw resume <id>` to re-dispatch a paused item in its existing worktree with the previous log tail in its prompt. Use `gw gc --dry-run` to see terminal-stage worktrees that can be removed; omit `--dry-run` to remove them, or add `--force` for a dirty worktree.

## GitHub sync

Gatewright uses the GitHub CLI; it shells out to `gh` and never handles your tokens. Authenticate and enable a board for a repository, then preview and run synchronization:

```sh
gh auth login
gw init --gh --repo owner/repo
gw sync --dry-run
gw sync
```

GitHub owns intake fields; Gatewright owns execution fields, and sync never writes the latter. `agent/go` is the dispatch label, moves can post issue comments, and conflicts are flagged for review.

## Optional memory backend

Memory is off by default. When enabled, Gatewright makes only the calls in this table; the text is composed by the tracker from item fields, not generated by an agent, so enabling it cannot create an extra summarisation call or inflate a bill.

| Event | What is written |
| --- | --- |
| A run ends successfully | One deterministic line: `<repo> · <id> <title> · <from>→<to> · changed: <first line of commit message> · why: <last note or scope, up to 200 chars> · evidence: <safe evidence list>` |
| An item reaches `github.close_on` | One line in the same shape, tagged `verified`; decision items are canonical and durable |

Example memory line:

```text
owner/widget · P5-06 Record completed work · building→verified · changed: Add deterministic memory writer · why: chose deterministic text · evidence: deadbeef, lib/memory/write.js, https://ci.example.test/run/1, README.md, (+2 evidence omitted)
```

Evidence is retained only when it is a commit SHA, a repository path, or an `http(s)` URL. Other evidence is dropped and reported as `(+N evidence omitted)`; it does not silently disappear. The honest edge case is that a 32-character hexadecimal API key matches the SHA pattern and would be kept. Do not paste secrets as evidence.

Nothing else is written: not stage changes, dispatches, run lifecycle events, prompts, file contents, environment values, or evidence that is not a SHA, path, or `http(s)` URL. Recall is separate: it is used for dispatch context only when configured, and plain `gw brief` never recalls memory.

To turn memory off, set `memory.enabled` to `false` in `.gatewright/config.json` (or remove the `memory` block). Off means the provider module is not loaded and no network or transport call is made.

The complete contract, including configuration and failure behavior, is in [docs/memory.md](docs/memory.md).

On an enabled board without an authenticated GitHub CLI, the observed dry run was:

```
$ gw sync --dry-run
GitHub CLI is not authenticated. Run `gh auth login`.
```

## Commands

Every command exits 0 on success, 1 on a rule violation, 2 on a usage error, 3 on an I/O error. Every command that writes appends one event.

| Command | What it does |
| --- | --- |
| `gw init [--gh] [--repo owner/name] [--force]` | Create `.gatewright/` and write the instruction block to `AGENTS.md`; `--gh` enables GitHub sync, and `--repo` supplies the repository when no GitHub origin is available |
| `gw init --mirror claude,cursor,copilot` | Also write the instruction block to `CLAUDE.md`, `.cursor/rules/gatewright.mdc`, and `.github/copilot-instructions.md` |
| `gw brief [--me <owner>] [--json] [--recall]` | Print in-flight, blocked, owned, and next-unblocked items in 25 lines or fewer. `--json` returns that digest structured (buckets with id, title, stage, owner, waiting-on), not the raw board. `--recall` is accepted but has no effect until the v0.5 memory backend is enabled. |
| `gw add "<title>" [--parent ID] [--type T] [--phase P] [--priority P] [--scope "..."] [--by <who>]` | Create an item; print its id |
| `gw claim <id> [--by <who>]` | Take ownership |
| `gw release <id>` | Drop ownership |
| `gw move <id> <stage> [--evidence <e>...] [--by <who>] [--force]` | Advance a stage; refused if its exit rule is unmet |
| `gw next <id> [--json]` | Show the stage(s) an item can move to right now, and the unmet conditions in plain English for the rest |
| `gw edit <id> [--title ...] [--scope ...] [--priority P] [--type T] [--phase P] [--deps a,b\|""] [--refs a,b\|""] [--force] [--by <who>]` | Change non-stage, non-evidence, non-notes fields. An empty `--deps ""` or `--refs ""` clears the list; a forced `--scope` edit on finished work is recorded in the item's notes |
| `gw note <id> "<text>" [--by <who>]` | Append a timestamped line to the item's notes |
| `gw show <id> [--json]` | Print one item and its events |
| `gw list [--stage S] [--phase P] [--flag F] [--json]` | Print items as a flat list |
| `gw check [--json]` | Report rule violations, vocabulary drift, and out-of-band writes; exit 1 on any report |
| `gw guard [--message-file F] [--range A..B] [--pretool] [--warn] [--json]` | Refuse a change no board item accounts for: a commit (via the hook), every commit in a range (via CI), or an agent's edit before it happens |
| `gw hook install [--ci] [--agent] [--force]` | Install the enforcement points: a `commit-msg` hook, a pull-request workflow, and the agent pre-edit guard. Also `gw hook status` and `gw hook uninstall` |
| `gw help <command>`, `gw <command> --help` | Print that command's own usage and flags |
| `gw config [<key> [<value>]] [--list]` | Show or change a setting. With no arguments in a terminal it walks every setting; anywhere else it lists them, so it never blocks a script |
| `gw import <file> [--format md\|csv\|json] [--dry-run]` | Ingest a task list. The format is inferred from the extension. CSV needs `id` and `title` columns and understands common aliases; JSON takes a bare array or an `items` wrapper. A source stage is honoured only if the item's evidence actually earns it, and every downgrade is reported |
| `gw open [--no-browser] [--watch]` | Write `board.html` and open it; `--watch` rewrites the snapshot when items or events change |
| `gw upgrade [--templates]` | Replace the CLI and the viewer, never the data |
| `gw serve [--port 7777] [--host H] [--open]` | Serve the live board; loopback unless `--host` says otherwise, with its write API and, when explicitly enabled and configured, its scheduler |
| `gw sync [--dry-run]` | Pull linked GitHub issues through `gh`; `--dry-run` previews synchronization |
| `gw stop <id> \| --all` | Stop one recorded run, or all recorded runs from any terminal |
| `gw resume <id>` | Resume a paused item in its existing worktree with the previous log tail |
| `gw triage <id> --approve \| --drop` | Approve or drop an agent-created item held for review |
| `gw gc [--dry-run] [--force]` | Remove terminal-stage worktrees; dry-run previews and force permits dirty worktrees |

The full contract, including field ownership, the move algorithm, and the brief layout, is in `specs.md`.

## Using it with agents

`gw init` writes a fenced block into `AGENTS.md`. Every mainstream agent reads it. Claude Code, Codex, Cursor, and GitHub Copilot all read their own rules file, so the same content lands in the right place for each: `CLAUDE.md`, `.cursor/rules/gatewright.mdc`, and `.github/copilot-instructions.md`. `init` writes to whichever of those files already exists.

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

Every command that writes records who did it: `--by <who>` if given, else `$GW_ACTOR`, else `human:<user>`. Agents must identify as `agent:<name>` — a bare `agent` names nobody and is refused, and anything else without the prefix is recorded as a human.

The agent's whole interface is `brief`, `show`, `claim`, `move`, `note`, `add`, and `edit`. It never reads the JSONL directly or GitHub. `brief` is capped at 25 lines so an agent's first action costs under 500 tokens; `show <id>` is the way to get detail on one item. `brief --json` returns the same digest structured — bucket membership, titles, stage, owner, and what each blocked item waits on — not the raw board, so a polling agent pays for the answer, not for the database.

Gatewright includes adapters for Claude Code, Cursor, and Codex. The Claude Code adapter provides a `SessionStart` hook that runs `gw brief` and a `PreToolUse` hook that runs `gw guard --pretool` before any edit; Cursor uses its rules file; Codex reads `AGENTS.md` directly.

## Choosing a workflow shape

A stage may declare `"role": "done"`, which marks it as the finish line: work standing there is finished, and `gw brief` stops counting it as in flight. The shipped pipeline ends at Verified and does not need it. A trunk pipeline that ends at Built does, and `gw init` writes it for you when you say you commit straight to main.

To move an existing board, truncate `stages.json` after the stage you actually finish at and give that stage `"role": "done"`. Without it every completed item is reported as still in flight forever, which is how `gw brief` degrades from a digest into a list of everything ever done. Only an explicit role counts — the last stage in a pipeline is not assumed to be an ending, because plenty of pipelines end in a waiting room.

## Stages and gates

`.gatewright/stages.json` defines the pipeline. The default is:

```
backlog → building → built → in_review → reviewed → merged → verified
```

with `paused` and `dropped` as side states. Each stage has:

- `label` — shown on the board.
- `exit` — a human-readable description of what "done" means at this stage. Shown in the brief and the board. No machine meaning.
- `auto` — when `true`, the scheduler (v0.4) may move items into this stage. When `false`, only a human can. The default is `auto: false` for `reviewed`, `merged`, and `verified`.
- `requires` — the machine-checked rule for **entering** the next stage. Keys: `scope: true`, `owner: true`, `evidence_min: n`, `evidence_match: regex`, `deps_at_least: stage`.

`stages.json` is the entire process definition. There is no hardcoded logic outside it. Add a stage, rename a stage, change the rule for entering `built`, mark `reviewed` as auto, drop a stage entirely — edit the JSON and `gw check` will pick it up. The board re-renders from it; `brief` reads the same file; the scheduler (when it lands) will too.

## Platforms

Linux, macOS and Windows, each tested in CI on Node 22 and 24. Line endings are LF everywhere: a board created on one platform and checked out on another produces no spurious out-of-band report.

Two runner guarantees are genuinely weaker on Windows, and are weaker by the platform's design rather than by omission:

- **Stopping a run** uses `taskkill /T`, then `/T /F` once `stop_timeout_s` expires, to reach the whole process tree. That is the closest Windows equivalent to signalling a POSIX process group, but a child that ignores the first request is reached only by the forceful second one.
- **The pid-reuse guard** identifies a recorded run by its process start time. On Linux and macOS the guard reads `/proc/<pid>/cwd` (or its equivalent) and can prove a pid is the process it claims to be; start time makes reuse very unlikely rather than impossible. When identity cannot be confirmed, `gw` fails open and records `identity_unverified` on the run rather than killing a process it cannot vouch for.

`gw serve` is the recommended live board on every platform. `gw open --watch` depends on `fs.watch`, which is the least consistent filesystem API across the three.

## Status

Gatewright is at v0.11.0.

Shipped in v0.1: `init`, `brief`, `add`, `claim`, `release`, `move`, `edit`, `note`, `show`, `list`, `check`, `import` (markdown only at the time; CSV and JSON arrived in v0.9), `open`, `upgrade`. Snapshot viewer with board, table, and overview views. Out-of-band write detection via `.digest`.

Shipped in v0.2: `gw serve`: a live board with write-back, editing, Play/Stop queuing, and global pause.

Shipped in v0.3: `gw sync`: GitHub issue pull/push, the `agent/go` dispatch label, comments on move, conflict flagging, and `init --gh`.

Shipped in v0.4: the runner and scheduler; one git worktree, branch, and log per run; `stop`, `resume`, `triage`, and `gc`; pre-spawn concurrency, depth, child-count, and timeout limits; held agent-created work; global and offline kill switches; Claude Code, Cursor, and Codex adapters; and live board run logs, triage, and resume.

Shipped in v0.5: an optional memory backend. Prior decisions are recalled into a dispatch prompt, and completed work and verified decisions are remembered when a run ends or an item closes. Off by default, and off means the adapter is never imported and no network call is made. The memory text is composed by the tracker from item fields, never generated by an agent, so enabling it cannot add to a model bill. See [docs/memory.md](docs/memory.md) for exactly what is written and what never is.

Shipped in v0.6: Windows support. Path comparison normalises 8.3 short names and drive-letter case through the Win32 API, process termination and liveness go through `taskkill` and the OS process list with timeouts on every external call, LF line endings are contractual, and the full suite runs green on windows-latest alongside Linux and macOS.

Shipped in v0.7: `gw config`, so settings can be changed without hand-editing `.gatewright/` — which the instruction block has always told agents never to do. Scripted (`gw config runner.enabled true`) and interactive (`gw config` in a terminal) are the same code path, and interactivity is never required: no TTY, `--yes`, `GW_NO_INPUT` or `CI` all take the non-interactive path, so nothing in an agent or CI pipeline can block on a prompt. `gw serve --host` binds an address other than loopback, and says plainly what that exposes. Also fixes a bug present in every earlier version: piping any command — `gw list | head`, `gw brief | less` — ended in an unhandled `EPIPE` and a Node stack trace.

Shipped in v0.8: `gw init` asks how you work — whether work reaches main directly or through pull requests, how items are numbered, which phases you use, and whether to arm the runner — and writes a pipeline that ends where you actually finish. A stage can now declare `"role": "done"`, and `gw brief` believes it: before this, a board whose pipeline assumed pull requests reported every completed item as still in flight forever, which turned the digest into a list of everything ever done. `gw config` also gained list-valued settings, so the vocabularies are settable without opening a file. Every non-interactive path is unchanged: no TTY, `--yes`, `GW_NO_INPUT` or `CI` all leave `init` byte-identical.

Shipped in v0.9: `gw check` now reports items holding values the vocabulary no longer allows, which was only ever enforced when an item was created — so a direct write, an import, or narrowing a vocabulary later left drift the board called clean. `gw import` accepts CSV and JSON as well as markdown, carrying evidence through so finished work is not silently downgraded. `gw help <command>` and `gw <command> --help` print that command's own flags, rendered from the spec the parser uses. `mirror_children` opens an issue for an agent-created child of a linked parent. The `Specified` stage now requires the scope it is named after. On the live board, a card's button reflects what is actually true of it — nothing on finished work, Cancel on a queued dispatch, Stop run on a run already in progress — and stopping a run no longer blocks the server while it waits out the grace period.

Shipped in v0.10: the board became something a human can manage the tracker with, rather than only read. Stages are added, renamed, reordered and removed from the UI; gates are built from a form showing the English read-back the board uses when it refuses a move; settings are edited from a view generated from the same schema `gw config` validates against. Those three are loopback only — moving a card is what `--host` is for, rewriting the rules of the board is not. Cards drag between columns, backward moves are offered separately for correcting a mis-drag, an unmet gate offers the action that clears it instead of a command to type, finished columns collapse so an archive-heavy board still shows live work, and `config.glossary` gives codes like `G0` a meaning wherever they appear.

Agents got the larger fix. Following the shipped instruction block literally, an agent could not get an item through the pipeline: `gw move` refused a skipped stage with "use --force to skip stages", the one action the block forbids, and never named the stage to pass through first. It now names it and gives the command. `gw next <id>` answers what the browser could already ask and the CLI could not — the next stage and exactly what it needs. A child item inherits its parent's phase instead of being born into a different one, `brief` no longer counts a claimed-but-unstarted item as in flight, and it explains the codes it prints.

Shipped in v0.11, and it breaks things on purpose. Capturing work costs one command: `gw add "Fix the login bug"` produces an item you can work on immediately, and phase, type and priority stay empty because they are genuinely unknown rather than guessed. That needed the default id scheme to become `seq` (`T-0001`), since `phase-seq` mints ids as `<phase>-<NN>` and so could not let a phase be absent — which is why an unlabelled GitHub issue and a bare `gw add` both used to land in P0. Unclassified work is now visibly untriaged instead of silently mislabelled, and `gw check` reports it without failing, because an inbox is not a defect.

The `Specified` stage is gone and its scope rule moved to `Built`, beside the evidence rule: rigor belongs where completion is claimed, not where an idea is written down. Five commands became three.

The item field `gate` was deleted rather than renamed. It was read by no rule, and its vocabulary duplicated `priority` — `G0` "the phase cannot be called done while this is open" against `P1` "do it in this phase". What remains is `requires` on a stage, which is what actually gates and is now the only thing the word means.

Everything in the original plan is now built. Known gaps are tracked on the board rather than listed here.

Node 22+, on Linux, macOS and Windows. The published package has zero runtime dependencies. MIT.
