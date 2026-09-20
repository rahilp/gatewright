# Gatewright for Codex

Codex reads the repository's `AGENTS.md` automatically. No Codex-specific
configuration is needed; install Gatewright and follow that file.

## The board as tools: `gw mcp`

Codex speaks MCP. Registering the board as a server gives Codex `gw_brief`,
`gw_show`, `gw_next`, `gw_list`, `gw_add`, `gw_claim`, `gw_move`, `gw_note`,
`gw_edit` and `gw_triage` as native tools, instead of asking it to remember
the CLI contract from `AGENTS.md`.

```sh
codex mcp add gw -- gw mcp
```

Or add it to `~/.codex/config.toml` (a trusted project may use its own
`.codex/config.toml`) by hand:

```toml
[mcp_servers.gw]
command = "gw"
args = ["mcp"]

[mcp_servers.gw.env]
GW_ACTOR = "agent:codex"
```

`GW_ACTOR` is what the board records for every write made through the server;
without it the writes are recorded as `agent:mcp`. Check the registration with
`codex mcp list`.

The server is launched in the directory Codex is working in, and finds the
board the same way the CLI does: the nearest `.gatewright/` at or above the
working directory, or the project root named by `GW_ROOT`.
