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

## The board as tools: `gw mcp`

The plugin also registers an MCP server, declared in `.mcp.json` at the plugin
root:

```json
{
  "mcpServers": {
    "gw": {
      "command": "gw",
      "args": ["mcp"]
    }
  }
}
```

It starts with the plugin and exposes the board as ten tools — `gw_brief`,
`gw_show`, `gw_next`, `gw_list`, `gw_add`, `gw_claim`, `gw_move`, `gw_note`,
`gw_edit`, `gw_triage` — so Claude Code reads and writes the board with tools
it can see rather than a CLI contract it has to remember. Like the hooks, it
expects `gw` on `PATH`.

Without the plugin, the same server registers with one command:

```sh
claude mcp add gw -- gw mcp
```

The hooks and the MCP server do different jobs and are meant to run together.
The `PreToolUse` guard is what *stops* an untracked edit; MCP is what makes
putting the work on the board a native tool call instead of a shell command.
Writes are recorded as `agent:mcp` unless `GW_ACTOR` says otherwise.
