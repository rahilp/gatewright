# Gatewright — Design

**Status:** Draft v0.2 · **Date:** 2026-09-14 (decisions D1–D6 closed)

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

An agent is instructed never to write to `.gatewright/` directly. Instruction alone is not enforcement, so `store` writes a hash of `items.jsonl` to `.gatewright/.digest` after every write it makes, and `gw check` reports a mismatch. The digest is committed, so the check survives a clone. It reports once and re-baselines: a tool that cries about the same edit every run gets ignored.

## Why one write path

The CLI, the `serve` API, `sync`, and the scheduler all go through the same `store` module. Every stage move evaluates the same `requires` rules whether a human dragged a card or an agent ran a command. This is the property that makes the board trustworthy: a card in Built has evidence because it could not have gotten there without it.

It also means `serve` is thin. It's an HTTP shim over the store plus a scheduler loop. There's no second implementation of the rules to drift.

## Why the agent only sees `brief`

Context is the scarce resource. A 70-item board is several thousand tokens if an agent reads the JSONL. `brief` is capped at 25 lines and structured so the first line an agent needs is the first line it sees: what's dispatched to it. Everything else is one level of summary. If an agent wants detail on one item, `gw show <id>` gives exactly that item.

The agent never reads the files, never reads GitHub, and never sees the scheduler. Its entire interface is a handful of commands — `brief`, `show`, `claim`, `move`, `note`, `add`, `edit`. That's what makes the tool provider-agnostic: there's nothing provider-specific for the agent to do.

## Ownership boundaries

Three parties write, and the design keeps them from fighting:

| Field group | Written by | Never written by |
|---|---|---|
| Intake (title, scope, labels → phase/priority/type, gate) | GitHub via `sync`, or human/agent for local items | anything else, when linked |
| Execution (stage, deps, evidence, notes, owner, flag) | CLI and `serve` | `sync` |
| Provenance (id, created_by, parent, created) | store, at creation | anyone, after |

`sync` merges intake fields with newer-wins and touches nothing else. There's no three-way merge because there's nothing to merge: the two sides own disjoint fields. The one collision that can happen (issue closed on GitHub while the item is mid-flight) is surfaced as a `conflict` flag for a human, not resolved automatically.

## Automation as policy, not code

Everything the scheduler is allowed to do is described in `stages.json` (`auto: true` per stage) and `config.json` (concurrency, timeouts, triage rules, child caps). The scheduler itself is a loop that reads those, finds eligible items, and spawns. Users who want more automation flip booleans. Users who want none never start `serve` with a runner configured.

This is also where the safety properties live:

- **Gates.** `auto: false` on a stage means no run can push an item into it. Default: Reviewed, Merged, Verified are human.
- **Triage.** Agent-created items are held with `needs-triage` until a human approves. The alternative, letting agents dispatch their own children, is a machine that runs until your budget is gone. Opt-in per parent type via `auto_dispatch_children`.
- **Caps.** `max_children_per_item` is a hard refusal at `add` time. `max_concurrent` bounds spend.
- **Kill switches.** Stop on a card, Pause all on the board, `gw stop --all` from any terminal. The last one exists because the browser tab is not a reliable control surface.

## Runs are worktrees

One run is one `git worktree` on its own branch, one agent process with `cwd` in that worktree, and one log file. Consequences:

- Killing a run never dirties the main checkout.
- Two runs on different items can't stomp each other's files.
- Resume is "spawn again in the same directory with the log tail in the prompt." The half-finished work is right there.
- The evidence an agent records (a commit SHA) exists on the run's branch; opening a PR from it is one `gh` call.

All runs write to the main repo's `.gatewright/` (via `GW_ROOT`), not the worktree's copy, so there is one board.

Worktree cleanup is an open question. Leaning: delete on Merged, keep on anything else, `gw gc` for the rest.

## Memory is a neighbour, not a feature

The tracker knows P2-01 is Built with commit abc123. It does not know why that approach was chosen, what was tried and dropped, or that the same problem came up in a different repo last spring. Trying to make the tracker hold that would turn it into a notes app. So it doesn't. It defines a tiny `memory` interface (`recall`, `remember`, optional `capsule`) and hands off at exactly two moments:

- **Before a run starts**, it recalls prior context for the item and puts it in the prompt. This is the hook that matters. An agent picking up jog transport work starts with the clock-conversion decision from three months ago instead of rediscovering it.
- **After work completes** (`run_ended: ok`, or the item is closed), it writes one short, deterministic line: repo, item, what changed, why, evidence. Verified decisions get marked canonical. Nobody writes this up by hand, which is why it actually gets captured.

The boundary rule: the tracker owns what's happening in this repo; memory owns what was learned across repos. Stages, dispatches, and run events never go to memory. They're volatile and already in git; copying them would only make recall noisier.

Two more choices worth stating. Memory is off by default and the adapter isn't loaded unless enabled, so the zero-dependency, no-network install is unchanged. And `brief` stays cheap: no recall unless `--recall` is passed, because the session-start path is the one place we've promised to keep under a few hundred tokens.

Second Brain is the first adapter because it exists, it's Rahil's, and its MCP tools map one-to-one onto the interface. The interface is generic so anyone can drop in another backend, and so the tracker can't quietly become a Second Brain client that other people have to untangle.

## Module layout

```
bin/gw.js                   argv → commands
lib/store.js                load/save items, append events, atomic writes, lock, digest
lib/rules.js                evaluate stages.json requires; dep graph; cycle check
lib/brief.js                render the brief from store state
lib/commands/*.js           one file per CLI command; each calls store + rules
lib/serve/server.js         http.createServer, routes → store
lib/serve/scheduler.js      tick loop, eligibility, spawn, signals   (v0.4)
lib/sync/github.js          gh wrapper, pull/push, field merge       (v0.3)
lib/import/md.js            tasks.md format; csv.js and json.js after
lib/viewer/inject.js        data blocks → pinned shell → .gatewright/board.html
lib/memory/provider.js      interface + loader; no-op when disabled       (v0.5)
adapters/second-brain/      memory.js: MCP client for Second Brain        (v0.5)
viewer/board.html           the pinned shell (source); build-viewer.js inlines CSS/JS into it.
                            The installed copy is .gatewright/board.html, written by open/serve
adapters/                   provider snippets, no logic
templates/                  stages.json, config.json, prompt.md, AGENTS block
```

Zero runtime dependencies. Node's `fs`, `child_process`, `http`, `crypto` cover everything. The viewer is plain HTML/CSS/JS; `build-viewer.js` only inlines a few source files into one for distribution.

## The viewer

Plain JS, no framework. Reasons: no build for users, no dependency to upgrade, and it has to render from `file://`. Hand-built boards of this kind already work this way, and it's fine.

The one thing it must not do is load its own data. The obvious design — a static page that `fetch`es the JSONL sitting next to it — does not work: Chrome and Firefox give a `file://` document an opaque origin and block the request. That would have left the headline promise ("open the file, see your board") working in Safari and nowhere else, and we'd have discovered it the first time someone else tried the quickstart.

So the data comes to the page instead. `gw open` takes the pinned shell, injects the current items, events, stages, and config as `<script type="application/json">` blocks, writes `.gatewright/board.html`, and opens it. No server, no browser flags, no permission prompt, works everywhere. The cost is that it's a snapshot, so the page says when it was taken.

Under `serve` the same shell is served with empty blocks and hydrates from `/api/state`, then polls every 2 seconds, gaining editors, Play/Stop, triage, and a live log tail. Polling over websockets because it's simpler and the load is one client on localhost. One shell, two ways to feed it, and `serve` is the only way to write.

The File System Access API (write to disk from the browser without a server) was considered as a server-less write path. Rejected for v0.x: Chromium-only, permission prompts on every session, and it would be a second implementation of the rules. The snapshot is read-only by construction; `serve` is the write path.

## Provider adapters

The core has no idea what provider is running. Adapters are:

- A hook, where the provider supports one, that runs `gw brief` at session start (Claude Code `SessionStart`).
- A rules file in the provider's native location containing the same AGENTS.md block.
- Nothing else.

If a provider has neither hooks nor rules files, `AGENTS.md` alone works, because every mainstream agent reads it. The adapter folder exists so nobody has to figure out the per-provider file path themselves.

## What we're not building, and why

- **A rebuild-from-events command.** The format supports it; v0.x doesn't need it. Add when someone corrupts `items.jsonl`.
- **Multi-repo boards.** One `.gatewright/` per repo. Aggregation is a different product.
- **Auth on `serve`.** It binds loopback. If someone wants to expose it, that's a reverse proxy problem.
- **A prompt library.** One template, user-editable. Provider-specific tuning belongs in the user's config.

## Risks

- **Agents ignoring the rules.** Mitigation: the rules are short, they're in the file every agent reads, and `check` catches violations. Also, `move` refusing without evidence is a stronger teacher than any instruction.
- **`items.jsonl` merge conflicts across branches.** If two branches both change the tracker, git will conflict on the file. Mitigation: line-per-item makes conflicts small and obvious; the events log is append-only and merges cleanly. Document that tracker changes should land on main quickly.
- **Runaway automation.** Mitigated by triage, caps, gates, and three kill switches. The default config is conservative: `max_concurrent: 1`, children need triage.
- **Memory noise.** If run-end memories are low quality, recall gets worse for everything else in the user's brain, not just the tracker. Mitigation: deterministic short text from item fields, only on completion, and a `remember.on_run_ok: false` switch so users can keep only verified decisions.
- **Scope creep toward a PM tool.** The non-goals in the PRD are the defence. The tracker is for code work with evidence gates. Anything that doesn't serve that gets a `dropped` stage.
