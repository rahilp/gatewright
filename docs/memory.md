# Gatewright memory contract

Gatewright's memory backend is an optional neighbour to the tracker. It carries a small record of completed work to a configured memory system; it does not mirror the board into that system.

## What gets stored

The tracker writes exactly one memory for each successful `run_ended` event when `memory.remember.on_run_ok` is enabled, and exactly one memory when an item reaches `github.close_on` when `memory.remember.on_close` is enabled. If both events happen, there are two memories: one per event. A repeated completion notification or repeated scheduler tick does not write a second memory for the same event.

| Trigger | Text shape | Tags and options |
| --- | --- | --- |
| Successful run | `<repo> · <id> <title> · <from>→<to> · changed: <first line of last commit message> · why: <last note or scope, ≤200 chars> · evidence: <list>` | `gatewright`, repo, item type, phase, configured extra tags; volatility `state` |
| Close-on stage | The same shape | The same tags plus `verified`; volatility `durable`; decision items also get `canonical: true` |

The line is deterministic and tracker-composed from the item's repo, ID, title, stage, scope, notes, evidence, phase, type, and the first line of the commit message. It is not an agent-generated summary and does not require a second model or provider call, so enabling memory cannot inflate an agent or summarisation bill. The configured `memory.remember.max_chars` cap applies (800 by default).

Example:

```text
owner/widget · P5-06 Record completed work · building→verified · changed: Add deterministic memory writer · why: chose deterministic text · evidence: deadbeef, lib/memory/write.js, https://ci.example.test/run/1, README.md, (+2 evidence omitted)
```

Evidence is filtered before the line is built. Kept forms are commit SHAs, repository paths, and `http(s)` URLs. Every dropped entry is counted in the visible marker `(+N evidence omitted)`, including entries excluded because of the character cap. The marker is deliberately not omitted.

The honest residual risk: a 32-character hexadecimal API key pasted as evidence matches the SHA pattern and would be kept. Do not use evidence as a secret store; review evidence before enabling a real knowledge base.

## What is never written

The memory text never contains stage-change events, dispatches, run lifecycle events, prompts, file contents, environment values, or any evidence that is not a SHA, path, or `http(s)` URL. In particular, stage changes and run events remain in `.gatewright/events.jsonl`, where they belong; they are not copied into memory as noise.

Recall is also bounded. Dispatch recall is only enabled by `memory.recall.on_dispatch`; `brief` makes no memory call unless the explicit `--recall` flag is passed. Recall hits are prompt context, not new memories.

## Failure and off switch

Every memory call has a five-second timeout by default. A configured `memory.timeout_ms` can be used for a shorter test timeout (the safety suite uses `25` ms). A timeout, thrown transport error, or malformed recall response never blocks a run start, move, or brief. Failures are logged in `.gatewright/runs/memory.log`; malformed recall data is treated as no hits.

Memory is disabled by default. To turn it off, set:

```json
{ "memory": { "enabled": false } }
```

Removing the `memory` block has the same effect. Off means the provider adapter module is not loaded and no network or injected transport call is made across dispatch, run completion, close, or brief. All tests for this contract use temporary directories and injected stubs; they do not contact a real backend or start a real agent.
