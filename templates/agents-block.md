<!-- gatewright:start -->
## Work tracking
This repo uses gatewright. At the start of every session run `gw brief` and act on it.
- Record progress only through the `gw` CLI. Never edit files in `.gatewright/` directly.
- `gw claim <id>` before changing code for an item. `gw move <id> <stage> --evidence <commit|test|PR>` when you reach a stage.
- Work you discover that someone else could pick up: `gw add "<title>" --parent <id>`. Your own plan steps: `gw note <id>`.
- If `gw move` refuses, fix the reason; do not use --force.
<!-- gatewright:end -->
