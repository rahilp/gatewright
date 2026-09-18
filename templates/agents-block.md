<!-- gatewright:start -->
## Work tracking
This repo uses gatewright. At the start of every session run `gw brief` and act on it. Finished work is out of the open counts: `gw list --stage verified` lists it.
- Record progress only through the `gw` CLI. Never edit files in `.gatewright/` directly.
- Identify yourself: export `GW_ACTOR=agent:<name>` (e.g. `agent:codex`) once per session, or pass `--by agent:<name>` on any write — without it your work is recorded as done by a human.
- Before your first edit of a task, put the plan on the board yourself: `gw add "<step>"` for each step you intend to take (`--parent <id>` for sub-steps). Do not wait to be asked. Plan steps are items, never notes — `gw note <id>` is only for progress remarks on an existing item.
- **Exception:** if you are working on gatewright itself, or you have otherwise been told not to write to a particular board, do not write to it — that board is the user's live tracker, not your scratchpad. Create a scratch board instead: `D=$(mktemp -d) && cd "$D" && gw init`, and prefix every `gw` command with `cd "$D" && ` (`cd` does not persist between your tool calls). Or keep the plan in your reply and let the human running you track it.
- `gw claim <id>` before changing code for an item. `gw move <id> <stage> --evidence <commit|test|PR>` when you reach a stage. The DEFAULT pipeline is backlog → building → built → in_review → reviewed → merged → verified, but a board may define its own — `gw next <id>` names the real, legal moves for the board you are on. No board yet? `gw init` creates one.
- Items created by an agent may be held with a `needs-triage` flag until reviewed. An agent-created item needs approval from a different human; agents and the creator's `human:<name>` alias cannot lift it. A human-created item may be self-approved. You may always `gw triage <id> --drop` your own item. NEEDS TRIAGE rows in `gw brief` name the command.
- Work you discover that someone else could pick up: `gw add "<title>" --parent <id>`.
- If a commit is refused because it is not on the board, add or claim the item it belongs to — never `git commit --no-verify`.
- If `gw move` refuses, fix the reason it names. `--force` is only ever for pipeline order — reopening finished work, re-entering from paused — and only when the refusal itself prints it; never to get past a gate. Unsure what's next? `gw next <id>`.
<!-- gatewright:end -->
