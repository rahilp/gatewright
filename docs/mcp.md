# `gw mcp` — the board over MCP

`gw mcp` is a Model Context Protocol server. It speaks JSON-RPC 2.0 over
stdin and stdout and publishes the board as ten tools. It is registered once
in an MCP client's configuration and launched by that client; it is not a
command to type.

Zero dependencies, like the rest of gatewright: the transport is
`lib/mcp/jsonrpc.js`, about a hundred lines, and there is no SDK.

## What it is for

The CLI contract in `AGENTS.md` is an instruction. An agent has to read it,
remember it, and choose to follow it. MCP turns the same contract into a
capability: the tools appear in the agent's own tool list, with schemas and
descriptions written for it, and calling one is as ordinary as reading a file.

It does not replace the enforcement. `gw guard` still refuses an edit no item
accounts for, and the commit hook still refuses a commit. MCP is what makes
complying cheap; the guard is what makes it necessary. Run both.

## Registering it

Every client takes the same two facts — a command and its arguments.

```sh
claude mcp add gw -- gw mcp     # Claude Code (also ships in the plugin)
codex mcp add gw -- gw mcp      # Codex
```

JSON clients (Cursor's `.cursor/mcp.json`, and most others):

```json
{
  "mcpServers": {
    "gw": {
      "command": "gw",
      "args": ["mcp"],
      "env": { "GW_ACTOR": "agent:cursor" }
    }
  }
}
```

TOML clients (Codex's `config.toml`):

```toml
[mcp_servers.gw]
command = "gw"
args = ["mcp"]
```

The server finds the board exactly as the CLI does: the nearest `.gatewright/`
at or above the directory it was launched in, or the project root named by
`GW_ROOT`. A client that starts its servers somewhere other than the project
needs `GW_ROOT` set.

## The tools

Each one is a command, not a reimplementation of one. Arguments become that
command's positionals and flags, and the result is the text the command
printed.

| Tool | Command | Arguments |
| --- | --- | --- |
| `gw_brief` | `gw brief` | `json`, `me` |
| `gw_show` | `gw show` | `id`\*, `json` |
| `gw_next` | `gw next` | `id`\*, `json` |
| `gw_list` | `gw list` | `stage`, `phase`, `flag`, `owner`, `text`, `limit` |
| `gw_add` | `gw add` | `title`\*, `scope`, `parent`, `type`, `priority`, `phase` |
| `gw_claim` | `gw claim` | `id`\*, `force` |
| `gw_move` | `gw move` | `id`\*, `stage`\*, `evidence[]`, `force` |
| `gw_note` | `gw note` | `id`\*, `text`\* |
| `gw_edit` | `gw edit` | `id`\*, `title`, `scope`, `priority`, `type`, `phase`, `deps[]`, `refs[]`, `force` |
| `gw_triage` | `gw triage` | `id`\*, `approve`, `drop`, `force` |

\* required.

Two places where JSON and argv differ, both documented in the tool's own
schema:

- **`gw_brief.me`** — the CLI's bare `--me` means "whoever I am". Its JSON
  spelling is the empty string.
- **`gw_edit.deps` / `.refs`** — arrays, which are joined into the CLI's
  comma-separated list. An empty array is the explicit "clear this list".

`gw_add` has no `deps`, because `gw add` has no `--deps`: dependencies are set
with `gw_edit` after the items they point at exist.

## Results

A tool result is one text block, carrying the command's own bytes.

- **Success** is the command's stdout, followed by its stderr if it wrote any.
  Where a command succeeds silently — `gw note`, `gw edit`, an uncontested
  `gw claim` — the result says so and names the command, because an empty
  result reads as a failure.
- **A refusal** comes back with `isError: true` and the exact text the CLI
  writes to stderr: the message, then a rule error's individual failures, one
  per line. Those sentences name what is missing and often the command that
  fixes it. They are the product, so they are not paraphrased.

Tool errors and protocol errors are kept apart, the way the specification
asks:

| Situation | Answer |
| --- | --- |
| Board refuses the write (gate unmet, unknown item, not your item to approve) | `isError: true`, the CLI's refusal |
| Bad argument (wrong type, unknown key, missing required) | `isError: true`, naming the argument |
| Unknown tool, unknown method, malformed request | JSON-RPC error (`-32602`, `-32601`, `-32600`, `-32700`) |

A model can act on the first two. The third is a client bug, and the
specification says so.

## Identity

Every write is recorded under an actor.

1. `--by <who>` on `gw mcp` itself, if given.
2. `GW_ACTOR` from the environment the client launched the server in.
3. Otherwise `agent:mcp`.

The default is an agent rather than the CLI's `human:<user>` because an MCP
server is always being driven by one, and signing an agent's work with a
person's name is worse than signing it with a generic agent name. A bare
`agent` names nobody and is refused — before the server reads a byte of
protocol, so the error lands where someone will see it rather than inside a
stream nobody is reading.

Identity is declared, not authenticated. The triage rule that follows from
that still applies: an agent may approve another agent's held item, never its
own.

## The wire

The server implements MCP revision **`2025-06-18`** and accepts `2025-03-26`
and `2024-11-05`. Requesting a version it supports gets that version back;
requesting anything else gets `2025-06-18`, which is a negotiation and not an
error — a client that is sent an error here has nothing left to step down to.

Supported methods: `initialize`, `notifications/initialized`, `tools/list`,
`tools/call`, `ping`. Anything else is `-32601`. Notifications are never
answered, including unknown ones.

Framing is one JSON message per line, UTF-8, as the stdio binding requires.
CRLF is tolerated, blank lines are skipped, a final line without a newline is
still read, and a line past 8 million characters is dropped whole with a
parse error rather than buffered until the process dies.

The 2026-07-28 revision replaces the `initialize` handshake with per-request
metadata; that is a different server, and this is not it. A dual-era client
that probes with `server/discover` first gets a JSON-RPC error that is not a
recognized modern error, which its own specification tells it to read as
"legacy server, fall back to `initialize`".

Batched requests are refused by name: JSON-RPC 2.0 has them, and MCP removed
them in this revision.

Tool calls are serialized. A client may pipeline, but two board writes at once
in one process would only contend for the store's lock.

## A session, end to end

A real transcript against a fresh solo board, `instructions` elided:

```
→ {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"example","version":"1"}}}
← {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"gatewright","title":"Gatewright board","version":"0.13.2"},"instructions":"This board is gatewright. …"}}

→ {"jsonrpc":"2.0","method":"notifications/initialized"}

→ {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"gw_add","arguments":{"title":"ship gw mcp","scope":"an MCP client can read this board"}}}
← {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"T-0001\n"}],"isError":false}}

→ {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"gw_claim","arguments":{"id":"T-0001"}}}
← {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"ok — `gw claim T-0001 --by agent:mcp` succeeded and printed nothing.\n"}],"isError":false}}

→ {"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"gw_move","arguments":{"id":"T-0001","stage":"building"}}}
← {"jsonrpc":"2.0","id":4,"result":{"content":[{"type":"text","text":"T-0001  backlog → building  ·  evidence: \n"}],"isError":false}}

→ {"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"gw_move","arguments":{"id":"T-0001","stage":"done"}}}
← {"jsonrpc":"2.0","id":5,"result":{"content":[{"type":"text","text":"target stage requirements are not met\ndone: Needs at least one new piece of evidence, distinct from anything already recorded: run `gw move T-0001 done --evidence \"<commit sha, test path, or URL>\"`\ndone: Evidence supplied with the move must look like a commit, a file path, or a link: run `gw move T-0001 done --evidence \"<commit sha, test path, or URL>\"`\n"}],"isError":true}}

→ {"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"gw_move","arguments":{"id":"T-0001","stage":"done","evidence":["test/mcp.test.js"]}}}
← {"jsonrpc":"2.0","id":6,"result":{"content":[{"type":"text","text":"T-0001  building → done  ·  evidence: test/mcp.test.js\n"}],"isError":false}}
```

Request 5 is the whole idea in one frame: the board refused, `isError` is
true, and the text is the same three lines a person would have read in their
terminal — including the command that fixes it.

## Where the code is

| File | What it holds |
| --- | --- |
| `lib/commands/mcp.js` | The command: identity, streams, and nothing else |
| `lib/mcp/jsonrpc.js` | Framing, message classification, response shapes |
| `lib/mcp/tools.js` | The catalogue: schemas, and how arguments become flags |
| `lib/mcp/server.js` | The dispatcher: lifecycle, negotiation, tool calls |
| `test/mcp.test.js` | The server driven as a subprocess over real pipes |
| `test/mcp-protocol.test.js` | Framing edges a pipe will not reproduce on demand |

No rule lives in any of them. A tool call reaches `lib/commands/*` through
`lib/serve/invoke.js`, the same adapter the live board's HTTP writes use, so
the board has one write path whatever is calling it.
