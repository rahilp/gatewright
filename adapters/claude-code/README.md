# Gatewright for Claude Code

Install the local plugin with one command:

```sh
claude plugin install ./adapters/claude-code
```

Two hooks come with it:

- `SessionStart` runs `gw brief`, so the session opens on the board.
- `PreToolUse` runs `gw guard --pretool` before any edit or write. An edit that
  no board item accounts for is refused, with instructions to put the work on
  the board first. This is what stops an agent from working for an hour and
  only then discovering nothing was tracked.

The skill points Claude Code at the repository's `AGENTS.md` contract.

Without the plugin, `gw hook install --agent` writes the same `PreToolUse` hook
into the project's `.claude/settings.json`.
