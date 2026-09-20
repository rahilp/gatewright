// T-0137 — `gw mcp` speaks the Model Context Protocol on stdin/stdout so an
// MCP client can call the board directly. The command itself is only the
// wiring: identity, streams, and the promise that resolves when the client
// closes the pipe. Everything else is lib/mcp/.
import { PROTOCOL_VERSION, mcpActor, serveStdio } from '../mcp/server.js';

export const spec = {
  summary: 'serve the board to an MCP client over stdio',
  flags: { by: { type: 'string' } },
  positionals: [],
};

export async function run(ctx) {
  // Resolved before a byte is read: an unusable actor (`--by agent`, or
  // GW_ACTOR=agent) must fail as a command, where the message is visible, and
  // not once per tool call inside a protocol stream nobody is reading.
  const actor = mcpActor(ctx.flags, ctx.env);
  const stdin = ctx.stdin ?? process.stdin;
  // stdout carries protocol frames and nothing else; every human-facing word
  // this command says goes to stderr, which MCP reserves for exactly that.
  if (stdin.isTTY) {
    ctx.stderr.write(`gw mcp: this speaks MCP ${PROTOCOL_VERSION} on stdin/stdout and is meant to be launched by an MCP client, not typed at.\n`);
    ctx.stderr.write('gw mcp: register it instead — `claude mcp add gw -- gw mcp`, or the equivalent for your client. Ctrl-D ends this session.\n');
  }
  await serveStdio({
    store: ctx.store,
    root: ctx.root,
    actor,
    env: ctx.env,
    cwd: ctx.cwd,
    stdin,
    stdout: ctx.stdout,
    stderr: ctx.stderr,
  });
  return 0;
}
