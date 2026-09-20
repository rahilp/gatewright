// T-0137 — `gw mcp`: the board as an MCP server over stdio.
//
// The point is to stop asking an agent to remember a CLI contract from
// AGENTS.md and instead hand it the board as tools it can see. Nothing about
// the board changes: every tool call lands in lib/commands/* through
// lib/serve/invoke.js, the same adapter the live board's HTTP writes use, so
// there is exactly one write path and the rules are enforced in exactly one
// place. A refusal comes back as the command's own sentence, byte for byte,
// because those sentences are what teach an agent what the board wants.

import { readFileSync } from 'node:fs';
import { invoke } from '../serve/invoke.js';
import { actor as resolveActor } from '../cli/root.js';
import { RuleError } from '../cli/errors.js';
import {
  INTERNAL_ERROR, INVALID_PARAMS, INVALID_REQUEST, METHOD_NOT_FOUND, PARSE_ERROR,
  classify, createLineReader, failure, result, serialize,
} from './jsonrpc.js';
import { findTool, printedCommand, toolDescriptors, validateArguments } from './tools.js';

const PKG = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url)));

// The revision this server implements, pinned on purpose. 2025-06-18 is the
// last revision whose lifecycle is the `initialize` handshake, which is what
// every shipping client speaks today; the 2026-07-28 revision replaces that
// handshake with per-request metadata and is a different server. A modern
// client that probes with `server/discover` first gets a JSON-RPC error that
// is not a recognized modern error, which is precisely the signal its spec
// tells it to read as "legacy server" before falling back to `initialize`.
export const PROTOCOL_VERSION = '2025-06-18';

// Older revisions this server is also correct for: it publishes nothing that
// postdates them except the optional `title` on a tool, which an older client
// ignores. Newest first, because the version returned for an unknown request
// SHOULD be the latest one supported.
export const SUPPORTED_PROTOCOL_VERSIONS = [PROTOCOL_VERSION, '2025-03-26', '2024-11-05'];

// The default identity for board writes made through this server. An MCP
// server is always driven by an agent, so falling back to `human:<user>` the
// way the bare CLI does would sign an agent's work with a person's name. The
// name is a real one rather than a bare kind, which the CLI refuses outright.
export const DEFAULT_ACTOR = 'agent:mcp';

const INSTRUCTIONS = `This board is gatewright. Work is tracked as items that advance through stages, and a stage only accepts an item when its rule is met.

Start with gw_brief and act on it. Before your first edit of a task, put the plan on the board yourself: gw_add one item per step you intend to take (parent for sub-steps), then gw_claim the one you are starting. A commit hook and a pre-edit guard refuse changes no item accounts for, so this is not optional bookkeeping.

When you reach a stage, gw_move with the evidence it asks for. If a move is refused, the refusal names what is missing — fix that. Do not retry with force: force is only ever for pipeline order, and only when the refusal itself printed it. gw_next tells you the legal moves on this board, whose stage names may differ from the default pipeline.

Writes made here are recorded under this server's actor, which defaults to agent:mcp and is set by GW_ACTOR. Identity is declared, not authenticated.`;

// A refusal, rendered exactly as `gw` renders it on stderr: the message, then
// a RuleError's individual failures one per line. Reproducing the CLI's own
// bytes is the requirement, not an approximation of them -- an agent that
// learns the board from these sentences must read the same sentences here.
export function refusalText(error) {
  const failures = error instanceof RuleError ? error.failures ?? [] : [];
  return [error.message, ...failures].map((line) => `${line}\n`).join('');
}

// GW_ACTOR and --by are honoured through the same resolver every CLI command
// uses, so a bare "agent" is refused here with the CLI's wording and a bare
// name is qualified the same way. Only the empty default differs.
export function mcpActor(flags = {}, env = {}) {
  const declared = String(flags.by ?? env.GW_ACTOR ?? '').trim();
  return declared === '' ? DEFAULT_ACTOR : resolveActor(flags, env);
}

export function createMcpServer({ store, root = store?.root, actor = DEFAULT_ACTOR, env = process.env, cwd = root, send }) {
  let initialized = false;
  let negotiatedVersion = PROTOCOL_VERSION;
  // Tool calls are serialized. A client may pipeline requests, and two board
  // writes running at once in one process would race for the store's lock for
  // no benefit: these calls are milliseconds long and strictly ordered by the
  // agent that issued them anyway.
  let queue = Promise.resolve();

  function negotiate(requested) {
    // "If the server supports the requested protocol version, it MUST respond
    // with the same version. Otherwise, the server MUST respond with another
    // protocol version it supports" -- not an error: an error here would
    // strand a client that could have stepped down.
    return SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSION;
  }

  function initialize(params) {
    negotiatedVersion = negotiate(params.protocolVersion);
    initialized = true;
    return {
      protocolVersion: negotiatedVersion,
      capabilities: {
        // The catalogue is static: it is the CLI's own surface, which cannot
        // change while the process is running. Saying so lets a client cache
        // it instead of listening for a notification that will never come.
        tools: { listChanged: false },
      },
      serverInfo: { name: 'gatewright', title: 'Gatewright board', version: PKG.version },
      instructions: INSTRUCTIONS,
    };
  }

  async function callTool(params) {
    const { name } = params;
    if (typeof name !== 'string') {
      return { protocolError: [INVALID_PARAMS, 'tools/call requires a string "name"'] };
    }
    const tool = findTool(name);
    // An unknown tool is a protocol error, not a tool error: there is nothing
    // for a model to correct inside arguments it never got to send.
    if (!tool) {
      return { protocolError: [INVALID_PARAMS, `Unknown tool: ${name}`, { available: toolDescriptors().map((entry) => entry.name) }] };
    }
    const args = params.arguments ?? {};
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      return { protocolError: [INVALID_PARAMS, 'tools/call "arguments" must be an object'] };
    }
    // Input validation is a tool error: it is exactly the class of mistake a
    // model can read and retry, which is what isError exists for.
    const problems = validateArguments(tool, args);
    if (problems.length) return toolError(problems.map((line) => `${line}\n`).join(''));

    const { flags, positionals } = tool.build(args);
    // `by` is set for the commands that declare it so the identity is a
    // declared one rather than a default the command has to guess at -- the
    // same thing `gw serve` does for a write arriving over HTTP. ctx.actor is
    // passed separately and is what actually gets recorded.
    const withActor = tool.writes ? { ...flags, by: actor } : flags;
    try {
      const run = await invoke(tool.command, { flags: withActor, positionals, store, root, actor, env, cwd });
      // stdout then stderr, in that order, because that is what a person
      // running the same command sees: a warning the command printed on the
      // way to succeeding is part of the answer, not noise to drop.
      const text = `${run.stdout}${run.stderr}`;
      if (run.code !== 0) return toolError(text || `gw ${tool.command} exited ${run.code}\n`);
      // Silence is how several commands report success (`gw note`, `gw edit`,
      // an uncontested `gw claim`). An empty content block would read as a
      // failed call, so say plainly that it worked and name the command it
      // was, which is also the command a human can run to see for themselves.
      return toolOk(text === '' ? `ok — \`${printedCommand(tool, { flags: withActor, positionals })}\` succeeded and printed nothing.\n` : text);
    } catch (error) {
      // UsageError, RuleError and IOError are the board refusing, and the
      // refusal is the product. Anything else is a bug in gw, and its message
      // is still more use to the caller than a generic internal error.
      return toolError(refusalText(error));
    }
  }

  function toolOk(text) {
    return { value: { content: [{ type: 'text', text }], isError: false } };
  }

  function toolError(text) {
    return { value: { content: [{ type: 'text', text }], isError: true } };
  }

  async function dispatch(method, params, { isRequest }) {
    // Notifications first: they never produce a response, and answering one
    // is itself a protocol violation.
    if (!isRequest) {
      if (method === 'notifications/initialized') initialized = true;
      // Every other notification -- cancellation, progress, anything a future
      // client sends -- is ignored on purpose. There is nothing to cancel: a
      // tool call here is a local file write that has already happened or is
      // about to.
      return null;
    }
    if (method === 'initialize') return { value: initialize(params) };
    if (method === 'ping') return { value: {} };
    // The client MUST NOT send other requests before initialize is answered.
    // Refusing plainly beats serving a client that has not agreed a version:
    // the response shape would then be a guess.
    if (!initialized) {
      return { protocolError: [INVALID_REQUEST, `received ${method} before initialize; send an initialize request first`] };
    }
    if (method === 'tools/list') {
      // The catalogue is one page. A cursor could only have come from another
      // server, and honouring it silently would return page one as page two.
      if (params.cursor !== undefined) {
        return { protocolError: [INVALID_PARAMS, 'tools/list is a single page and issues no cursor'] };
      }
      return { value: { tools: toolDescriptors() } };
    }
    if (method === 'tools/call') {
      const run = queue.then(() => callTool(params));
      // The queue must survive a rejected call, or one thrown error would
      // wedge every later tool call behind it forever.
      queue = run.then(() => undefined, () => undefined);
      return run;
    }
    return { protocolError: [METHOD_NOT_FOUND, `Method not found: ${method}`] };
  }

  async function handle(text) {
    const message = classify(text);
    if (message.kind === 'ignore') return;
    if (message.kind === 'parse-error') {
      // id is null: the request it belonged to cannot be identified, which is
      // exactly the case JSON-RPC reserves a null id for.
      send(failure(null, PARSE_ERROR, `Parse error: ${message.detail}`));
      return;
    }
    if (message.kind === 'invalid') {
      send(failure(message.id, INVALID_REQUEST, `Invalid Request: ${message.detail}`));
      return;
    }
    let outcome;
    try {
      outcome = await dispatch(message.method, message.params, { isRequest: message.kind === 'request' });
    } catch (error) {
      // A throw from here is a defect in this server, not a refusal from the
      // board. It must still answer the request: a client that gets no
      // response at all hangs until its own timeout.
      if (message.kind === 'request') send(failure(message.id, INTERNAL_ERROR, `Internal error: ${error?.message ?? error}`));
      return;
    }
    if (!outcome || message.kind !== 'request') return;
    if (outcome.protocolError) {
      const [code, text2, data] = outcome.protocolError;
      send(failure(message.id, code, text2, data));
      return;
    }
    send(result(message.id, outcome.value));
  }

  return {
    handle,
    get initialized() { return initialized; },
    get protocolVersion() { return negotiatedVersion; },
  };
}

// Bind the server to a pair of streams. Split out from createMcpServer so the
// dispatcher can be driven directly in tests without a pipe in the way.
export function serveStdio({ store, root, actor, env = process.env, cwd, stdin, stdout, stderr }) {
  const server = createMcpServer({
    store,
    root,
    actor,
    env,
    cwd,
    send: (message) => { stdout.write(serialize(message)); },
  });
  // Responses are written in completion order, which JSON-RPC allows, but
  // each message must still be one whole line: await the previous handler so
  // two concurrent writes cannot interleave inside a line.
  let pending = Promise.resolve();
  const reader = createLineReader({
    onMessage: (text) => { pending = pending.then(() => server.handle(text)); },
    onOverflow: (limit) => {
      stdout.write(serialize(failure(null, PARSE_ERROR, `Parse error: message exceeded ${limit} characters and was discarded`)));
    },
  });

  return new Promise((resolve, reject) => {
    stdin.on('data', (chunk) => reader.push(chunk));
    stdin.on('error', reject);
    stdin.on('end', () => {
      reader.end();
      // The client closing stdin is how MCP says shut down. Let whatever is
      // in flight finish writing before the process exits under us.
      pending.then(() => resolve(0), reject);
    });
    stderr?.write?.(`gw mcp: serving ${store?.root ?? root} over stdio (MCP ${PROTOCOL_VERSION}).\n`);
  });
}
