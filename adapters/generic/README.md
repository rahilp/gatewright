# Gatewright for other providers

Copy the repository's `AGENTS.md` Gatewright block into the provider's rules
file, if it has one. Providers without a native rules file can follow
`AGENTS.md` directly.

## The board as tools: `gw mcp`

Any MCP-capable client can take the board as tools rather than as prose.
`gw mcp` is an MCP server that speaks the protocol over stdin and stdout, so
the registration is the same everywhere — a command and its arguments:

```json
{
  "mcpServers": {
    "gw": {
      "command": "gw",
      "args": ["mcp"],
      "env": {
        "GW_ACTOR": "agent:<name>"
      }
    }
  }
}
```

Clients that keep their configuration in TOML spell the same thing this way:

```toml
[mcp_servers.gw]
command = "gw"
args = ["mcp"]
```

Two things are worth setting deliberately:

- **`GW_ACTOR`** — who the board records for every write made through the
  server. Unset, writes are recorded as `agent:mcp`.
- **the working directory** — the server finds the board the way the CLI does,
  by walking up from where it was launched. A client that starts its servers
  somewhere other than the project needs `GW_ROOT` set to the project root
  (the directory containing `.gatewright/`, not `.gatewright/` itself).

The server implements MCP revision 2025-06-18 and negotiates down to
2025-03-26 and 2024-11-05. See `docs/mcp.md` for the tool list and the full
wire behaviour.
