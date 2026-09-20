# Gatewright — Product Requirements

**Status:** Draft v0.2 · **Owner:** Rahil · **Date:** 2026-09-14 (decisions D1–D6 closed) · **Revised:** 2026-09-20 (T-0139 — the name, D3, R1, R5, R25 and the success metrics corrected against the shipped v0.13.2)

## Name

**Gatewright.** A wright builds a thing well (shipwright, playwright); a gatewright builds gates. The product's differentiator is evidence gates between stages, so the name says what it does. Coined, with no npm, GitHub, or web collisions found on 2026-09-13. Package `gatewright`, binaries `gw` and `gatewright`, folder `.gatewright/`. `gatewright.dev` registered 2026-09-14.

**Updated 2026-09-20.** The npm name is claimed and the package is published:
`gatewright@0.13.2` is the `latest` tag on `registry.npmjs.org/gatewright`, with
every release from 0.1.0 on the registry. The 404 this paragraph used to report
was the state before the first publish, not a permanent condition, and the risk
it described — "until it does, the name is available to anyone" — is closed.

## Landscape

"Kanban for coding agents" is already crowded, and the name and pitch avoid that framing on purpose:

- **KanBot** (PyPI): a board where every card is a task run by local CLI agents (Claude, Codex, Gemini, custom), with a background runner streaming logs to cards.
- **Kanbots** (Product Hunt): runs Claude Code and Codex in parallel from a board; autopilot mode; desktop app with a cloud tier.
- **Punchlist**: a Claude Code planning tool (screenshots and notes handed over via MCP).
- **Detent**: a deterministic hook layer for Claude Code, not a tracker, but it owns that word.

All of these are app-first: the board is the product and the data lives inside it. Gatewright is file-first: the data is git-tracked JSONL any agent can drive through a CLI, the board is a viewer, and stages have machine-checked exit rules. That's the pitch. Where they say "run agents from a board," we say "work that earns its way forward."

Punchlist reaches its agent over MCP, and since v0.13 so does Gatewright — which
is a convergence on a transport, not on a product. `gw mcp` publishes the same
commands, with the same rules and the same refusal sentences, over the interface
an agent already has a tool list for; the board is still files in the repo. The
distinction that matters is unchanged: what an agent can do to the board is
gated by `stages.json`, whichever way it reaches it.

## Problem

Every coding session with an agent starts from zero. The agent doesn't know what's in flight, what's blocked, or what it was supposed to pick up next, so the human re-explains it, or the agent re-reads a wall of markdown and burns context before writing a line of code. When the session ends, the record of what happened lives in a chat transcript nobody will open again.

Hand-built HTML boards (phases, gates, stages with exit rules, dependencies, evidence links) show the shape of the fix. But each one is built once, for one repo, and every new project means rebuilding it. They also can't be driven by an agent, and can't drive one.

The cost of not solving this: repeated context spend at the top of every session, work that gets lost between sessions, and no way to hand a queue of work to agents without a human sitting on top of each one.

## Goals

1. A new project gets a working tracker with one command and one commit. Target: under 60 seconds from `npx` to first `gw brief`.
2. An agent can learn the state of the project in under 500 tokens. `gw brief` output stays under 25 lines by design.
3. The same tracker works for any agent runtime. Claude Code, Codex, Cursor, Copilot, Gemini CLI, or a person at a terminal, with no per-provider code in the core.
4. Work survives sessions. Every stage move, dispatch, stop, and run is an event in git. "What happened to P2-01 last Tuesday" is answerable from history.
5. A human can start, stop, and gate agent work from a board without touching a terminal, and can leave the terminal running unattended within limits they set.
6. Work done in one repo can inform work in another. When a memory backend is configured, an agent starts a run with relevant prior decisions in its prompt, and finished work leaves a condensed record behind without anyone writing it up.

## Non-goals

- **Replacing GitHub Issues or Jira.** The tracker is an execution layer. Intake and team visibility stay in the issue tracker; we sync, we don't compete.
- **A hosted service.** Everything is local files in the repo. No accounts, no server outside the developer's machine. Hosting is a separate product decision if it ever comes. This still holds with `gw mcp` shipped (v0.13): the MCP server is a local process speaking over the client's own stdin and stdout — no port, no account, no network — so it is a way to reach the same local files, not a service anyone connects to.
- **A generic project management tool.** Stages are for code work with evidence gates. If someone wants sprint burndowns, that's out of scope.
- **Prompt engineering per provider.** The dispatch prompt is a plain template. Tuning it for a specific model is the user's job via config, not ours in code.
- **GitHub Projects sync.** Projects is a second status model that overlaps our stages. Labels and comments give the team what they need. Revisit only if users ask.
- **Being a memory system.** The tracker holds state and events for one repo. It does not store decisions, lessons, or cross-repo context itself; it hands those to a memory backend if one is configured. Mirroring tracker state into a memory system is explicitly out: stages and dispatches are volatile and already in git.

## Users

**Solo developer with agents.** Runs two or three agent sessions a day on one repo. Wants to stop re-explaining state and wants a record of what agents did. Primary user for v0.1–v0.2.

**Small team with shared repo.** Files work as GitHub issues. Wants agents to pick from that backlog and wants progress visible in the issue without opening a board. Primary user for v0.3.

**Automation-first operator.** Wants a queue of work to run while they're away, with a kill switch and gates they control. Primary user for v0.4.

**The agent.** Not a person, but the tracker's most frequent caller. Needs: cheap state, clear next action, a way to record evidence and discovered work, and hard rules it can't accidentally break.

## User stories

Ordered by priority.

- As a developer, I want to run one command in a repo and have a tracker in place, so I don't rebuild the board for every project.
- As an agent starting a session, I want a short brief of what's in flight, blocked, and next, so I spend context on the work rather than on orientation.
- As an agent finishing a change, I want to move an item forward with a commit or test path as evidence, and be refused if the stage's exit rule isn't met, so the board stays honest.
- As a developer, I want to open a board in the browser that shows the current state without any build step, so I can see what's going on at a glance.
- As a developer, I want to create an item on the board and press play, so an agent picks it up without me writing a prompt.
- As a developer, I want to press stop on a running item and have the work preserved, so I can interrupt an agent without losing what it did.
- As a team member, I want to file a GitHub issue with a label and have an agent pick it up, so I never have to see the board.
- As a team member, I want progress to show up as comments on the issue, so I know where a task is without asking.
- As an agent mid-task, I want to record a defect I found as a new item linked to what I'm working on, so it doesn't get lost and doesn't derail the current change.
- As an operator, I want agent-created items to wait for my approval before they run, so agents can't generate unbounded work.
- As an operator, I want to leave the tracker running and have it start eligible work automatically within a concurrency cap, so a queue drains overnight.
- As an operator, I want a terminal command that stops everything, so I'm not dependent on a browser tab.
- As a developer with an existing board or task list, I want to import it, so I don't re-enter items by hand.
- As a developer, I want to upgrade the tool without touching my data, so updates are safe.
- As an operator with a memory backend, I want each dispatched run to start with the decisions I've already made about that area of the code, so agents stop re-deriving things I settled months ago.
- As a developer, I want finished work to leave a short record of what changed and why in my memory system, so I have a decision log I never had to write by hand.
- As a developer without a memory backend, I want none of this to exist in my install, so the tool stays small.

Edge cases that are stories in their own right:

- As a developer with no network, I want brief, add, move, and the board to work, so GitHub being down doesn't stop me.
- As a developer, when an issue is closed on GitHub while an agent is mid-run, I want the tracker to flag it rather than silently drop the item.
- As an operator, when an agent process hangs after stop, I want it force-killed after a timeout and the worktree left intact.

## Requirements

### P0 — v0.1 does not ship without these

| ID | Requirement | Acceptance |
|---|---|---|
| R1 | `npx gatewright init` creates `.gatewright/` with items, events, stages and config, and writes the instruction block to `AGENTS.md` always, mirroring it into a provider's own file only when that provider's artifact already exists (specs §11.1), or when `--mirror` asks for it | Fresh repo → run init → four data files exist, plus `prompt.md`, a baselined `.digest` and `.gatewright/.gitignore`; `AGENTS.md` contains the block; running init again is a no-op. **Corrected 2026-09-20:** `board.html` is *not* among them. It is a `gw open` artifact per D1, and `init` never writes it — the acceptance test asked for a file the design says init must not produce |
| R2 | `gw brief` prints in-flight, blocked, owned, and next-unblocked items in ≤25 lines | Board with 100 items (test fixture) → brief output ≤25 lines, ≤500 tokens |
| R3 | `gw add`, `edit`, `claim`, `move`, `note` write to items and events atomically | Each command appends exactly one event; a crash mid-write leaves valid JSONL |
| R4 | `gw move` enforces stage exit rules from `stages.json` (evidence required, deps must be at or past a stage) | Move to Built with no evidence → non-zero exit and reason; with evidence → succeeds |
| R5 | `gw check` reports every item that violates an exit rule or has unmet deps, and reports when `items.jsonl`, `stages.json` or `config.json` was written outside `gw` | Exit code 1 if anything is reported; an out-of-band write is reported **every run** until a legitimate `gw` write restores the digest or `gw repair --write --force` re-baselines it deliberately. **Changed in v0.12, recorded 2026-09-20:** the original acceptance — "reported once, then the digest is re-baselined" — made the second `gw check` after a hand edit report a clean board, which is the sentence a reviewer acts on. `check` is an audit, never an acknowledgement. A *missing* digest is still written silently: absence is not evidence of an edit |
| R6 | `gw open` writes `.gatewright/board.html` with the data files inlined as JSON blocks and opens it; the board renders board and table views with no build step and no network | `gw open` in a fresh repo → board renders in Chrome, Firefox and Safari with the network disabled; filters by phase, type, stage work |
| R7 | Zero runtime dependencies. Node 22+ (18 and 20 are EOL) | `npm ls --prod` shows nothing |
| R8 | `gw import` ingests a markdown task list (this repo's `tasks.md` format) and CSV | All items land with stage, deps, evidence, notes preserved |

### P1 — v0.2 and v0.3

| ID | Requirement | Acceptance |
|---|---|---|
| R9 | `gw serve` serves the viewer and accepts writes (create, edit, move, note) | Edit on board → JSONL line updated + event appended within 1s |
| R10 | Play on a card writes a dispatch event; Stop writes a cancel event | Events appear in `events.jsonl` with `by: human` |
| R11 | `gw sync` pulls changed issues via `gh` and merges GitHub-owned fields only | Label change on GitHub → item priority updates; stage set locally is untouched |
| R12 | Stage moves post a one-line comment to the linked issue; Verified closes it | Move to Built → comment on issue within one sync |
| R13 | `agent/go` label produces a dispatch event on next sync | Label issue → next `gw brief` lists it as dispatched |
| R14 | Items carry `created_by` and optional `parent`; brief and board show the tree | Agent-created child shows under parent on board |
| R15 | `gw upgrade` replaces CLI and viewer only | Data files byte-identical before and after |

### P2 — v0.4

| ID | Requirement | Acceptance |
|---|---|---|
| R16 | Scheduler in `serve` starts eligible items (stage `auto: true`, deps met, flag clear, free slot) | Two eligible items, `max_concurrent: 1` → one runs, one waits |
| R17 | One run = one git worktree = one agent process; output logged to `.gatewright/runs/` | Killing a run leaves main checkout clean |
| R18 | Stop sends SIGTERM, then SIGKILL after `stop_timeout_s`; item goes to Paused with last commit noted | Hung process → killed within timeout |
| R19 | Resume respawns in the same worktree with the log tail in the prompt | Resumed run's prompt contains last N lines of prior log |
| R20 | Agent-created items get `needs-triage` and are not scheduler-eligible until cleared, unless `auto_dispatch_children` allows | Child from a run → not started until approved. **Refined 2026-09-20:** whose work is held is `policy.triage_required_for`, which the pipeline preset sets — `["agent", "github"]` on team, `[]` on solo (specs §4.3). A human's unclassified capture is flagged `unclassified` instead: off the scheduler, but claimable and movable at once |
| R21 | `max_children_per_item` hard cap | Agent's 11th `add --parent X` with cap 10 → refused |
| R22 | `gw stop --all` from any terminal | All runs terminated, `paused: true` set |
| R23 | Provider adapters: Claude Code plugin (SessionStart hook), Cursor rule, Codex config snippet | Each adapter installs with one command and runs `gw brief` at session start |

### P2 — v0.5 · memory backend (optional)

| ID | Requirement | Acceptance |
|---|---|---|
| R24 | A `memory` provider interface with `recall(query, n)` and `remember(text, tags)`; off unless `config.memory.enabled` | Default install makes no memory calls; `npm ls --prod` still empty |
| R25 | Dispatch prompt includes top-N recall hits for the item's title and scope, under a token cap | Run prompt contains a "Prior context" section when hits exist. **Corrected 2026-09-20:** the section is **not** absent when empty. `templates/prompt.md` keeps the heading and closes with a line explaining what an empty one means — "these last two sections may be empty: empty means nothing useful was recalled, or memory is disabled" — because a heading that silently vanishes leaves an agent unable to tell "nothing was recalled" from "this build has no memory support". What is absent when empty is the `<<<GW-DATA>>>` fencing around the value (specs §10.3): markers around nothing tell an agent nothing |
| R26 | On `run_ended: ok` and on reaching `close_on` stage, one condensed memory is written (item, change, why, evidence, repo tag); decision-type items are marked canonical on Verified | Exactly one `remember` call per event in tests; content under 800 chars |
| R27 | `config.memory.project_id` pulls the backend's project prompt capsule as a stable prompt prefix when supported | Prefix present and byte-identical across runs until the capsule changes |
| R28 | `brief --recall` opt-in flag; plain `brief` never calls the backend | `brief` with memory enabled makes zero network calls unless `--recall` |
| R29 | Second Brain adapter as the first implementation, in `adapters/second-brain/` | Configured in under a minute; other backends implementable by the same interface |

## Success metrics

The targets below are as written. Actuals are recorded beside them where they
are knowable, measured 2026-09-20 against v0.13.2; an unmeasured target is
marked as such rather than left to read as met.

Leading (first 30 days after v0.1):

| Target | Actual (2026-09-20) |
|---|---|
| Time from `npx` to first `gw brief` under 60s in 90% of fresh installs | **0.9s** end to end, on one machine. Two orders of magnitude inside the target, which says the target was set against the wrong risk: the cost was never the runtime, it was the decisions `init` used to ask for |
| Median `gw brief` output under 400 tokens on the 100-item test fixture | **~108 tokens** — on a **282-item** board, not the 100-item fixture, so the figure is better than a like-for-like comparison would give. The brief is capped at 25 lines by construction, so it does not grow with the board; this is what that cap costs in practice |
| Zero `gw check` reports of out-of-band writes in dogfood repos | **Not measured.** Left open rather than claimed |

Lagging (90 days):

| Target | Actual (2026-09-20) |
|---|---|
| Used in every new project Rahil starts. Honest target: 100%, because if he skips it, it isn't good enough | Not measured here |
| At least 3 repos outside the author's using it (GitHub search for `.gatewright/stages.json`) | **Not met: 1 repo** on that search. Roughly **1,000 npm downloads a month**, which is traffic rather than adoption — a download is not a board. The honest reading is that the product works and nobody outside has picked it up yet, and that distribution, not capability, is what is missing |
| One v0.4 user running unattended queues overnight without a reported runaway | Not met; follows from the line above |

## Decisions

Closed 2026-09-14. Each was a blocking open question; the rationale is kept because the alternatives will be proposed again.

| ID | Decision | Rationale |
|---|---|---|
| D1 | **Read-only board is a snapshot written by `gw open`**, not a `file://` page that fetches its data. `gw open` injects the four data files into the pinned `board.html` as `<script type="application/json">` blocks and opens it. | Chrome and Firefox treat `file://` as an opaque origin and block the fetch, so the headline "open the file, see your board" promise could not be kept. Inlining needs no server and no browser flags. Live updates stay a `gw serve` feature. |
| D2 | **`serve` is the only write path.** The File System Access API is not used. | Follows from D1: the snapshot is read-only by construction, and a second write path would have to re-implement the rules. Chromium-only with per-session permission prompts on top. |
| D3 | **Item IDs are phase-seq**: `P2-01`, children `P2-01.1`. An item that moves phase keeps its ID. | The prefix reads well on a board and in a brief. Phase is a field; the prefix is just where the item started. Renaming IDs would break evidence links and event history. |
| D3a | **Reversed 2026-09-11 (v0.11): the default `id_scheme` is `seq` — `T-0001`, children `T-0001.1`.** `phase-seq` survives as an opt-in and is unchanged for boards that chose it; the "an item that moves phase keeps its ID" rule in D3 holds under either scheme. Recorded in `specs.md` §2 and §6.3. | D3 made phase a *precondition* of having an id, and capture is the moment you least know the phase. `phase-seq` mints `<phase>-<nn>` and so must refuse an item with no phase — which meant a bare `gw add "Fix the login bug"` and an unlabelled GitHub issue both had to be given a phase, and both were silently given `P0`. Unclassified work was arriving mislabelled as the most urgent work on the board. `seq` lets phase, type and priority stay genuinely empty until someone knows them, which is what made the `unclassified` flag possible. The prefix reading well on a board was worth less than capture costing one command. |
| D4 | **License: MIT.** | This is a CLI people will vendor and fork. Apache-2.0's patent grant buys nothing here and adds adoption friction. |
| D5 | **Package `gatewright`, binary `gw` *and* `gatewright`, domain `gatewright.dev`.** | Shipping both binary names means a `gw` collision on someone's PATH is an annoyance, never a blocker. ~~Publishing the placeholder is still open: it needs an npm login, and the name is unclaimed until then.~~ **Closed 2026-09-20:** published for real, not as a placeholder; `gatewright@0.13.2` is `latest`, and both binaries are on PATH after install. |
| D6 | **`gw check` detects out-of-band writes via a committed `.gatewright/.digest`.** | The "never hand-edit" rule needs enforcement, not just instruction. A hash written after every CLI/API write, committed so it survives a clone, is the cheapest mechanism that works. |

## Open questions

Nothing is blocking v0.1; see Decisions.

All five non-blocking questions below have been answered. They are kept with
their answers rather than deleted, because each will be proposed again.

- **Worktree cleanup policy.** Delete on Merged, on Verified, or never? Disk grows fast with many runs. (Engineering, v0.4) — **Answered v0.4: none of those.** Nothing is deleted automatically; `gw gc` removes terminal-stage and done-stage worktrees when asked, previews with `--dry-run`, and refuses a dirty worktree without `--force`. The moment an item is marked finished is exactly the moment someone may still want to see what produced the claim.
- **Dispatch prompt template.** Ship one generic template or one per provider in `adapters/`? Start generic; revisit after dogfood. (Rahil, v0.2) — **Answered: generic, and it stayed generic.** One `templates/prompt.md`, shipped into `.gatewright/prompt.md`, user-editable, untouched by plain `upgrade`. Per-provider tuning remains a non-goal. The one thing the user cannot edit away is the data-fencing (specs §10.3), which happens at substitution time precisely because the template is expected to be rewritten.
- **Event log growth.** Compact or rotate `events.jsonl` after N thousand lines? Probably never for v0.x. (Engineering) — **Answered v0.13: compact, never rotate, and it was needed inside v0.x after all.** `gw gc --events` moves the history of finished items to `events-archive.jsonl`, keeping every event of an open item and the last 20 of each finished one. Nothing is deleted. "Probably never" was wrong by an order of magnitude: at dogfood pace `gw open` was inlining 13 MB into a single HTML file.
- **Memory transport.** Talk to Second Brain over MCP from Node (stdio/HTTP client in the adapter) or via its plain HTTP API? MCP keeps one integration path; HTTP is fewer moving parts. (Rahil, v0.5) — **Answered v0.5: MCP over plain HTTP**, JSON-RPC POSTs built with `fetch` and no SDK, because an SDK would be the first runtime dependency in the project and would land in every install to serve a feature that is off by default. Recorded in `specs.md` §14.
- **What counts as "why" in the run-end memory.** The agent's own summary, the item notes, or a second short call to the provider to summarise the log? Start with notes + last commit message; measure whether recall quality is good enough. (Engineering, v0.5) — **Answered: notes + last commit message, composed by the tracker.** Never a second call to the provider: the text is deterministic and free, and enabling memory therefore cannot add to a model bill. Recall quality has not been measured against the alternative, so this is a decision that has shipped rather than a question that was settled by evidence.

## Timeline and phasing

No external deadline. Phasing is by usable increments; each version is dogfooded on Gatewright's own repo (using `tasks.md` as the board) before the next starts.

- **v0.1** — CLI core + read-only board + import. Must replace the current HTML tracker fully.
- **v0.2** — `serve`, board write-back, play/stop events (events only; no runner yet).
- **v0.3** — GitHub sync, comments, `agent/go`, child mirroring.
- **v0.4** — scheduler, worktrees, runner, triage gate, `stop --all`, adapters.
- **v0.5** — memory provider interface, recall-in-prompt, remember-on-complete, Second Brain adapter. Depends on v0.4 (the runner is where the hooks live).

Everything in that plan is built. The versions since were not planned here and
are recorded after the fact, because the phasing above stops being a forecast at
v0.5 and a reader needs to know where the road actually went:

- **v0.6** — Windows support.
- **v0.7** — `gw config`; `serve --host`.
- **v0.8** — `init` asks how you work and writes a pipeline that fits; the `done` stage role.
- **v0.9** — vocabulary drift in `check`; CSV and JSON import; per-command `--help`.
- **v0.10** — the board manages the tracker: stages, gates and settings editable from the UI; `gw next`.
- **v0.11** — capture costs one command; `seq` ids by default; `Specified` removed; the `gate` field deleted.
- **v0.12** — evidence gates count evidence supplied *with the move*; `gw repair`; onboarding as one choice.
- **v0.13** — full-screen `init` and `config`; `gw doctor`; `gw mcp`; `gw gc --events`; untrusted text fenced out of dispatch prompts.

Dependency: v0.3 relies on the `gh` CLI being installed and authenticated. We don't handle tokens ourselves.
