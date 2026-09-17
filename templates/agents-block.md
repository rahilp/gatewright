<!-- gatewright:start -->
## Work tracking
This repo uses gatewright. At the start of every session run `gw brief` and act on it.
- Record progress only through the `gw` CLI. Never edit files in `.gatewright/` directly.
- Before your first edit of a task, put the plan on the board yourself: `gw add "<step>"` for each step you intend to take (`--parent <id>` for sub-steps). Do not wait to be asked.
- `gw claim <id>` before changing code for an item. `gw move <id> <stage> --evidence <commit|test|PR>` when you reach a stage.
- Work you discover that someone else could pick up: `gw add "<title>" --parent <id>`. Your own plan steps: `gw note <id>`.
- If a commit is refused because it is not on the board, add or claim the item it belongs to — never `git commit --no-verify`.
- If `gw move` refuses, fix the reason; do not use --force. Unsure what's next? `gw next <id>`.
<!-- gatewright:end -->
