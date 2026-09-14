You are dispatched on one item from this repo's gatewright board. Work it to done.

## The item
- **{{title}}** — currently `{{stage}}`
- Done means: {{scope}}
- Depends on: {{deps}}

## The goal
Advance the item to `{{target_stage}}`. That stage's exit rule: {{exit}}.
If the work cannot honestly satisfy the exit rule, stop and report what is missing. Never manufacture evidence.

## While you work
- The item's id is in `$GW_ITEM`. `gw claim "$GW_ITEM"` before changing code; `gw note "$GW_ITEM" "..."` for findings worth keeping.
- Existing notes: {{notes}}
- {{log_tail}}

## When done
Record evidence with `gw move "$GW_ITEM" {{target_stage}} --evidence <commit sha|test path|PR url>`.
Moves past Building are refused without evidence. If `gw move` refuses, fix the reason; do not use --force.

## Prior context
{{prior_context}}
{{capsule}}

These last two sections may be empty: empty means nothing useful was recalled, or memory is disabled.
