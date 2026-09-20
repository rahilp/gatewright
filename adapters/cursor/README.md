# Gatewright for Cursor

`.cursor/rules/gatewright.mdc` holds the instruction block, which is the same
text `gw init --mirror cursor` writes. Copy it into the project, or run that
command.

## The board as tools: `gw mcp`

Cursor reads MCP servers from `.cursor/mcp.json` in the project (or
`~/.cursor/mcp.json` for every project). Registering the board there gives the
agent `gw_brief`, `gw_show`, `gw_next`, `gw_list`, `gw_add`, `gw_claim`,
`gw_move`, `gw_note`, `gw_edit` and `gw_triage` as native tools:

```json
{
  "mcpServers": {
    "gw": {
      "command": "gw",
      "args": ["mcp"],
      "env": {
        "GW_ACTOR": "agent:cursor"
      }
    }
  }
}
```

Set `GW_ACTOR` as shown. Cursor holds agent-created items for triage by
default and refuses to let an unidentified Cursor session approve one, so an
unset actor turns into a refusal at the first approval rather than a
mis-attributed write. Without it, writes are recorded as `agent:mcp`.

The rules file and the server complement each other: the rules explain when to
put work on the board, the tools are how it gets there.
