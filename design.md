# Gatewright — Design

**Status:** Draft v0.2 · **Date:** 2026-09-14 (decisions D1–D6 closed) · **Revised:** 2026-09-20 (T-0139 — module layout regenerated from the tree; the digest, worktree-cleanup and agent-interface entries corrected against v0.13.2)

This document explains the shape of the system and why it's that shape. The field-level contract lives in `specs.md`; the work breakdown lives in `tasks.md`.

## The one-sentence design

Agents and humans both write to a small set of git-tracked JSONL files through one write path; a pinned HTML shell renders a snapshot of them; an optional local server turns the same shell into a live control panel and, later, into an orchestrator.

## Why files, and why JSONL

The tracker has to work in a fresh clone with nothing installed except Node, survive across five agent runtimes that share nothing, and give you history without building a history feature. Git-tracked text files do all three.

JSONL specifically, over a single JSON document or SQLite:

- One item per line means a change to one item is a one-line diff. Reviewing tracker changes in a PR becomes possible.
- Append-only events are trivial: `>>` a line. No locking dance for the common case.
- `grep P2-01 .gatewright/events.jsonl` is a complete audit tool. No query language to learn.
- SQLite would be faster past a few thousand items, but that's not this tool. Trackers with thousands of open items have different problems.

The cost: `items.jsonl` gets rewritten on every change (read all, change one, write all). At 500 items that's a few hundred kilobytes and under 10ms. Acceptable. If it ever isn't, the event log can rebuild any state, so a migration is mechanical.

## Why the HTML is pinned, not generated

The screenshot that started this is a hand-built board. It works, but it can't be reused, and the tempting fix (have the agent regenerate it per project) is exactly the wrong one: it burns context every time, it drifts, and every project ends up with a slightly different board nobody can maintain.

So the viewer is a versioned artifact in the npm package (`viewer/board.html`), and the copy in `.gatewright/board.html` is written by the tool, never by hand and never by an agent. It has no build step and makes no network requests. The board layout, columns, and rules are all driven by `stages.json` and `config.json`, so "customising the board" means editing JSON, never HTML.

An agent is instructed never to write to `.gatewright/` directly. Instruction alone is not enforcement, so `store` writes a hash of `items.jsonl`, `stages.json` and `config.json` to `.gatewright/.digest` after every write it makes, and `gw check` reports a mismatch. The digest is committed, so the check survives a clone.

**Changed 2026-09-12 (v0.12), recorded here 2026-09-20.** The original rule was
"it reports once and re-baselines: a tool that cries about the same edit every
run gets ignored." That was the wrong trade, and the reasoning behind it was
backwards. Re-baselining is an *acknowledgement*, and a check that acknowledges
what it found has blessed it: the second `gw check` after a hand edit reported a
clean board, which is exactly the sentence a reviewer would act on. So the check
is now an audit and nothing else. A stale digest stays stale until a legitimate
`gw` write restores it, or until `gw repair --write --force` re-baselines it
**deliberately, after review** — a separate command, with a flag, because
accepting an unexplained edit is a decision a person makes and not a side effect
of looking. The one case that still re-baselines silently is a *missing* digest
(a fresh clone predating the file, or a first run after upgrade): absence is not
evidence of an edit. `gw doctor` reports the same condition and never writes at
all — a diagnostic that repairs what it finds cannot be run twice and believed.

## Why one write path

The CLI, the `serve` API, `sync`, and the scheduler all go through the same `store` module. Every stage move evaluates the same `requires` rules whether a human dragged a card or an agent ran a command. This is the property that makes the board trustworthy: a card in Built has evidence because it could not have gotten there without it.

It also means `serve` is thin, and it got thinner. It is an HTTP shim plus a
scheduler loop — but a write endpoint no longer "uses the store the same way"
the CLI does. It loads the same module in `lib/commands/` that the CLI loads and
calls its `run(ctx)` with a request-shaped ctx, capturing stdout and stderr. One
implementation, therefore one behaviour: every rule the CLI enforces the board
enforces, and every refusal the CLI gives the board can show, in the same words.
The one-write-path property stopped being a discipline anyone could erode and
became a fact about the code. `gw mcp` reaches the commands through that same
adapter, which is why adding an MCP surface added no rules.

## Why the agent only sees `brief`

Context is the scarce resource. A 70-item board is several thousand tokens if an agent reads the JSONL. `brief` is capped at 25 lines and structured so the first line an agent needs is the first line it sees: what's dispatched to it. Everything else is one level of summary. If an agent wants detail on one item, `gw show <id>` gives exactly that item.

The agent never reads the files, never reads GitHub, and never sees the scheduler. Its entire interface is a handful of commands — `brief`, `show`, `next`, `list`, `claim`, `move`, `note`, `add`, `edit`, `triage`. That's what makes the tool provider-agnostic: there's nothing provider-specific for the agent to do.

`next` joined that list in v0.10 because the set was incomplete in the one place
it mattered. An agent that hit a refusal had `brief` (what exists) and `show`
(one item) and nothing that answered "what may I do with this item right now" —
so it guessed a stage name, or reached for `--force`, which the instruction block
forbids. `next <id>` is the answer, and the refusals point at it.

The same ten are published as MCP tools by `gw mcp` (v0.13), and that is the
whole of the addition: same commands, same rules, same refusal sentences, byte
for byte, reached by a tool call instead of a shell. It changes the *affordance*
and nothing else — the tracked path becomes the easy path — which is why it is
not a second interface to keep in step. It calls the same command modules through
the same adapter `serve` writes through.

## Ownership boundaries

Three parties write, and the design keeps them from fighting:

| Field group | Written by | Never written by |
|---|---|---|
| Intake (title, scope, labels → phase/priority/type) | GitHub via `sync`, or human/agent for local items | anything else, when linked |
| Execution (stage, deps, evidence, notes, owner, flag) | CLI and `serve` | `sync` |
| Provenance (id, created_by, parent, created) | store, at creation | anyone, after |

`sync` merges intake fields with newer-wins and touches nothing else. There's no three-way merge because there's nothing to merge: the two sides own disjoint fields. The one collision that can happen (issue closed on GitHub while the item is mid-flight) is surfaced as a `conflict` flag for a human, not resolved automatically.

## Automation as policy, not code

Everything the scheduler is allowed to do is described in `stages.json` (`auto: true` per stage) and `config.json` (concurrency, timeouts, triage rules, child caps). The scheduler itself is a loop that reads those, finds eligible items, and spawns. Users who want more automation flip booleans. Users who want none never start `serve` with a runner configured.

This is also where the safety properties live:

- **Gates.** `auto: false` on a stage means no run can push an item into it. Default: Reviewed, Merged, Verified are human.
- **Triage.** On the team pipeline, work created by an agent — and, since v0.13, by a GitHub issue — is held with `needs-triage` until a human approves. The alternative, letting agents dispatch their own children, is a machine that runs until your budget is gone. Opt-in per parent type via `auto_dispatch_children`; `policy.triage_required_for` decides whose work is subject to a hold at all, and the solo pipeline sets it to `[]` because on a solo board there is nobody else to do the reviewing. A human's unclassified capture is a different thing and is not held: it is flagged `unclassified`, can be claimed and worked at once, and only waits on the scheduler.
- **Caps.** `max_children_per_item` is a hard refusal at `add` time. `max_concurrent` bounds spend.
- **Kill switches.** Stop on a card, Pause all on the board, `gw stop --all` from any terminal. The last one exists because the browser tab is not a reliable control surface.

## Runs are worktrees

One run is one `git worktree` on its own branch, one agent process with `cwd` in that worktree, and one log file. Consequences:

- Killing a run never dirties the main checkout.
- Two runs on different items can't stomp each other's files.
- Resume is "spawn again in the same directory with the log tail in the prompt." The half-finished work is right there.
- The evidence an agent records (a commit SHA) exists on the run's branch; opening a PR from it is one `gh` call.

All runs write to the main repo (via `GW_ROOT`, which names the project root), not the worktree's copy, so there is one board.

**Worktree cleanup, decided in v0.4.** The question was: delete on Merged, on
Verified, or never? The answer is none of those — nothing is deleted
automatically. `gw gc` removes the worktrees of items that have reached a
terminal stage or the `done`-role stage, when you ask it to; `--dry-run` shows
what it would take and a dirty worktree is refused unless `--force` says
otherwise. Automatic deletion was rejected because a worktree is where a
half-finished run's work lives, and the moment an item is marked finished is
exactly the moment somebody might still want to look at what produced that
claim. Disk is cheap and recoverable; an agent's working tree is not.

## Memory is a neighbour, not a feature

The tracker knows P2-01 is Built with commit abc123. It does not know why that approach was chosen, what was tried and dropped, or that the same problem came up in a different repo last spring. Trying to make the tracker hold that would turn it into a notes app. So it doesn't. It defines a tiny `memory` interface (`recall`, `remember`, optional `capsule`) and hands off at exactly two moments:

- **Before a run starts**, it recalls prior context for the item and puts it in the prompt. This is the hook that matters. An agent picking up jog transport work starts with the clock-conversion decision from three months ago instead of rediscovering it.
- **After work completes** (`run_ended: ok`, or the item is closed), it writes one short, deterministic line: repo, item, what changed, why, evidence. Verified decisions get marked canonical. Nobody writes this up by hand, which is why it actually gets captured.

The boundary rule: the tracker owns what's happening in this repo; memory owns what was learned across repos. Stages, dispatches, and run events never go to memory. They're volatile and already in git; copying them would only make recall noisier.

Two more choices worth stating. Memory is off by default and the adapter isn't loaded unless enabled, so the zero-dependency, no-network install is unchanged. And `brief` stays cheap: no recall unless `--recall` is passed, because the session-start path is the one place we've promised to keep under a few hundred tokens.

Second Brain is the first adapter because it exists, it's Rahil's, and its MCP tools map one-to-one onto the interface. The interface is generic so anyone can drop in another backend, and so the tracker can't quietly become a Second Brain client that other people have to untangle.

## Module layout

**Regenerated 2026-09-20 (T-0139) from the tree, not from memory.** The version
this replaces was a plan: it named `lib/serve/scheduler.js` and
`lib/sync/github.js`, neither of which was ever built under those names, and it
predated eight subsystems. Where a path below carries a version, that is when it
landed.

```
bin/gw.js                     the only entry point; hands argv to the router
lib/cli/router.js             argv → lib/commands/<name>.js, resolved by module name
lib/cli/args.js               parse argv against a command's own `spec`
lib/cli/root.js               find the board (walk up, or GW_ROOT); resolve the actor
lib/cli/errors.js             UsageError / RuleError / IOError → exit 2 / 1 / 3

lib/store.js                  items, events, atomic+durable writes, lock, digest, event compaction
lib/rules.js                  evaluate stages.json `requires`; dep graph; cumulative gates; the flag list
lib/stages.js                 stage roles, terminal stages, validation of stages.json
lib/transitions.js            per item: which stages it can enter, and why not the rest
lib/gates/describe.js         a `requires` block → plain English; ARTIFACT_EVIDENCE lives here
lib/brief.js                  render the brief from store state
lib/policy.js                 isSchedulable: one definition of scheduler eligibility
lib/triage-policy.js          captureFlag; releasing holds when policy changes
lib/guard.js                  the decision module behind `gw guard`
lib/config.js                 read config.json and stages.json
lib/settings.js               the settings schema `gw config` and the board's Settings view share
lib/settings-help.js          what each setting means, in English, in one place
lib/vocab.js lib/glossary.js lib/ids.js lib/owner.js lib/git.js lib/templates.js lib/util/paths.js

lib/commands/*.js             one file per CLI command (27); each calls store + rules

lib/serve/server.js           http.createServer, host/origin guard, routes → invoke
lib/serve/invoke.js           an HTTP or MCP request → the CLI's own command module

lib/run/scheduler.js          tick loop, candidates, admission under the registry lock  (v0.4)
lib/run/spawn.js              prompt rendering and data-fencing, provider argv, spawn   (v0.4)
lib/run/lifecycle.js          stop / timeout / resume, run_ended, last_commit           (v0.4)
lib/run/registry.js           runs recorded on disk before the process starts           (v0.4)
lib/run/worktree.js           git worktree create/reuse per item                        (v0.4)

lib/sync/gh.js                the one injectable `gh` wrapper                            (v0.3)
lib/sync/pull.js              issues → items, GitHub-owned fields only                   (v0.3)
lib/sync/push.js              move comments, close on close_on, mirror children          (v0.3)

lib/mcp/jsonrpc.js            newline-framed JSON-RPC 2.0, written by hand              (v0.13)
lib/mcp/tools.js              the ten tools, their schemas, arg → flag mapping           (v0.13)
lib/mcp/server.js             lifecycle, version negotiation, dispatch                   (v0.13)

lib/import/md.js csv.js json.js       tasks.md format, CSV, JSON
lib/viewer/inject.js          data blocks → pinned shell → .gatewright/board.html
lib/tui/setup.js lib/tui/prompt.js    the full-screen init and config screens            (v0.13)

lib/memory/provider.js        interface + loader; no-op when disabled                    (v0.5)
lib/memory/write.js           the deterministic remember() text                          (v0.5)
lib/memory/providers/transport.js     MCP over plain HTTP, `fetch` only                  (v0.5)
adapters/second-brain/memory.js       the first memory backend                           (v0.5)

viewer/board.html             the pinned shell, authored as one file
adapters/                     provider snippets and MCP registrations, no logic
templates/                    stages.json, config.json, pipeline-solo.json,
                              pipeline-team.json, prompt.md, AGENTS block,
                              commit-msg.sh, workflow.yml
scripts/preflight.mjs         the pre-release check; scripts/test.mjs runs the suite
```

The router dispatches by module name — a new command is a new file in
`lib/commands/` plus a line in the usage text — which is why `gw help <command>`
and `gw <command> --help` can be rendered from the command's own `spec` and
cannot drift from what the parser accepts.

Zero runtime dependencies. Node's `fs`, `child_process`, `http`, `crypto` and
`string_decoder` cover everything, including the MCP transport.

**`build-viewer.js` was never written.** The layout above named it twice, and
this document told you what it did. There is no build step for the viewer:
`viewer/board.html` is authored as a single self-contained file, HTML, CSS and
JS together, and `gw open` and `upgrade` copy that file as-is. That is a real
cost, not a design win — the shell is now the largest file in the repository and
it is edited as one — and splitting it into sources with an inliner remains open
debt. It is recorded here as debt rather than described as a component, because
a design document that names a build step nobody can run sends a contributor
looking for a file that does not exist.

## The viewer

Plain JS, no framework. Reasons: no build for users, no dependency to upgrade, and it has to render from `file://`. Hand-built boards of this kind already work this way, and it's fine.

The one thing it must not do is load its own data. The obvious design — a static page that `fetch`es the JSONL sitting next to it — does not work: Chrome and Firefox give a `file://` document an opaque origin and block the request. That would have left the headline promise ("open the file, see your board") working in Safari and nowhere else, and we'd have discovered it the first time someone else tried the quickstart.

So the data comes to the page instead. `gw open` takes the pinned shell, injects the current items, events, stages, and config as `<script type="application/json">` blocks, writes `.gatewright/board.html`, and opens it. No server, no browser flags, no permission prompt, works everywhere. The cost is that it's a snapshot, so the page says when it was taken.

Under `serve` the same shell is served **from memory** with empty blocks and hydrates from `/api/state`, then polls every 2 seconds, gaining editors, Play/Stop, triage, and a live log tail. `serve` writes no `board.html` at all, which is worth saying plainly because this document and `specs.md` both used to imply it did: a board that has only ever been served has no snapshot on disk, and nobody can be looking at a stale one. Polling over websockets because it's simpler and the load is one client on localhost. One shell, two ways to feed it, and `serve` is the only way to write.

Both feeds cap the history they carry — every event of an open item, the tail of
each finished one — because the log only grows and the snapshot inlines it. The
cap is the same partition `gw gc --events` makes, taken from one helper rather
than reimplemented three times, so a snapshot, a compacted board and the live
board cannot disagree about which history is hot.

The File System Access API (write to disk from the browser without a server) was considered as a server-less write path. Rejected for v0.x: Chromium-only, permission prompts on every session, and it would be a second implementation of the rules. The snapshot is read-only by construction; `serve` is the write path.

## Provider adapters

The core has no idea what provider is running. Adapters are:

- A hook, where the provider supports one, that runs `gw brief` at session start (Claude Code `SessionStart`).
- A hook, where the provider supports one, that runs `gw guard --pretool` before an edit (Claude Code `PreToolUse`) — the gate that keeps a plan from being written down only after the code is.
- A rules file in the provider's native location containing the same AGENTS.md block.
- The one-line registration for `gw mcp`, in whatever shape that client's config takes (v0.13).
- Nothing else.

If a provider has neither hooks nor rules files, `AGENTS.md` alone works, because every mainstream agent reads it. The adapter folder exists so nobody has to figure out the per-provider file path themselves.

The three are deliberately different kinds of thing and none of them replaces
another. The rules file *instructs*, and instruction is advice. The guard hook
*enforces*, and it runs whether or not the agent cooperates. The MCP
registration *affords*: it makes the tracked path the easy path and it stops
nothing. An agent that skips the board is still refused at its first edit; what
changes is that its way out is a tool it can see rather than a command it
half-remembers.

## What we're not building, and why

- **A rebuild-from-events command.** The format supports it; v0.x doesn't need it. Add when someone corrupts `items.jsonl`.
- **Multi-repo boards.** One `.gatewright/` per repo. Aggregation is a different product.
- **Auth on `serve`.** It binds loopback by default, and `--host` widens *reachability* rather than adding a credential: the allow-list of addresses the server answers on is the entire mechanism. Changing the rules of the board — the stages, their gates, the settings — stays loopback-only whatever `--host` says, and off loopback those controls are not drawn at all rather than offered and refused. Anyone who wants real authentication in front of it has a reverse proxy problem.
- **A prompt library.** One template, user-editable. Provider-specific tuning belongs in the user's config.

## Risks

- **Agents ignoring the rules.** Mitigation: the rules are short, they're in the file every agent reads, and `check` catches violations. Also, `move` refusing without evidence is a stronger teacher than any instruction.
- **`items.jsonl` merge conflicts across branches.** If two branches both change the tracker, git will conflict on the file. Mitigation: line-per-item makes conflicts small and obvious; the events log is append-only and merges cleanly. Document that tracker changes should land on main quickly.
- **Runaway automation.** Mitigated by triage, caps, gates, and three kill switches. The default config is conservative: `max_concurrent: 1`, children need triage.
- **Memory noise.** If run-end memories are low quality, recall gets worse for everything else in the user's brain, not just the tracker. Mitigation: deterministic short text from item fields, only on completion, and a `remember.on_run_ok: false` switch so users can keep only verified decisions.
- **Scope creep toward a PM tool.** The non-goals in the PRD are the defence. The tracker is for code work with evidence gates. Anything that doesn't serve that gets a `dropped` stage.
