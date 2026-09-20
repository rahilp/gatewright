import './helpers/isolate-env.js';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withoutCallerState } from './helpers/isolate-env.js';
import { PROTOCOL_VERSION } from '../lib/mcp/server.js';

// T-0137 — the server is exercised the way a client exercises it: a real
// child process, real pipes, real newline framing. Driving the dispatcher
// in-process would test the dispatcher and not the transport, and the
// transport is the half that is written by hand here.

const BIN = fileURLToPath(new URL('../bin/gw.js', import.meta.url));
const REQUEST_TIMEOUT_MS = 20_000;

const boards = [];
after(() => { for (const root of boards) rmSync(root, { recursive: true, force: true }); });

// Every child gets the caller's environment minus the state gw reads from it,
// so a shell with GW_ROOT or GW_ACTOR exported cannot point these boards --
// or these actors -- anywhere but where the test says. NODE_TEST_CONTEXT goes
// too: a child that inherits it reports into this worker instead of running.
function childEnv(extra = {}) {
  const env = { ...withoutCallerState(process.env), ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function board() {
  const root = mkdtempSync(join(tmpdir(), 'gw-mcp-'));
  boards.push(root);
  const created = spawnSync(process.execPath, [BIN, 'init', '--yes'], { cwd: root, env: childEnv(), encoding: 'utf8' });
  assert.equal(created.status, 0, `gw init failed: ${created.stderr}`);
  return root;
}

function cli(root, args, extra = {}) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd: root, env: childEnv(extra), encoding: 'utf8' });
}

function client(root, extra = {}) {
  const child = spawn(process.execPath, [BIN, 'mcp'], {
    cwd: root, env: childEnv(extra), stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  const unsolicited = [];
  const malformed = [];
  let stderr = '';
  let buffer = '';
  let exited = null;

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf('\n');
      if (index === -1) break;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { malformed.push(line); continue; }
      const waiting = pending.get(message.id);
      if (waiting) { pending.delete(message.id); waiting(message); } else unsolicited.push(message);
    }
  });
  child.on('close', (code) => {
    exited = code;
    for (const resolve of pending.values()) resolve({ error: { message: `server exited (${code}) before answering` } });
    pending.clear();
  });

  let nextId = 0;
  const api = {
    child,
    get stderr() { return stderr; },
    get unsolicited() { return unsolicited; },
    get malformed() { return malformed; },
    raw(line) { child.stdin.write(`${line}\n`); },
    notify(method, params) { api.raw(JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })); },
    request(method, params) {
      const id = (nextId += 1);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), REQUEST_TIMEOUT_MS);
        pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
        api.raw(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }));
      });
    },
    async handshake(protocolVersion = PROTOCOL_VERSION) {
      const response = await api.request('initialize', {
        protocolVersion, capabilities: {}, clientInfo: { name: 'gatewright-test', version: '0' },
      });
      api.notify('notifications/initialized');
      return response;
    },
    call(name, args = {}) { return api.request('tools/call', { name, arguments: args }); },
    async close() {
      child.stdin.end();
      if (exited === null) await new Promise((resolve) => child.once('close', resolve));
      return exited;
    },
  };
  return api;
}

// A tool result's single text block, which is where the CLI's own bytes land.
function text(response) {
  assert.ok(response.result, `expected a result, got ${JSON.stringify(response.error)}`);
  assert.equal(response.result.content.length, 1);
  assert.equal(response.result.content[0].type, 'text');
  return response.result.content[0].text;
}

test('initialize answers with the pinned revision, tool capability and serverInfo', async () => {
  const mcp = client(board());
  try {
    const response = await mcp.handshake();
    assert.equal(response.jsonrpc, '2.0');
    assert.equal(response.result.protocolVersion, PROTOCOL_VERSION);
    assert.deepEqual(response.result.capabilities, { tools: { listChanged: false } });
    assert.equal(response.result.serverInfo.name, 'gatewright');
    assert.match(response.result.instructions, /gw_brief/);
    // A notification must never draw a response.
    const listed = await mcp.request('tools/list');
    assert.ok(listed.result.tools.length > 0);
    assert.deepEqual(mcp.unsolicited, []);
  } finally { await mcp.close(); }
});

test('version negotiation echoes a supported revision and steps down from an unknown one', async () => {
  for (const [requested, expected] of [['2025-06-18', '2025-06-18'], ['2024-11-05', '2024-11-05'], ['1900-01-01', PROTOCOL_VERSION], [undefined, PROTOCOL_VERSION]]) {
    const mcp = client(board());
    try {
      const response = await mcp.request('initialize', { protocolVersion: requested, capabilities: {}, clientInfo: { name: 't', version: '0' } });
      assert.equal(response.result.protocolVersion, expected, `requested ${requested}`);
      // Stepping down is a negotiation, never an error: a client that gets an
      // error here has no version left to try.
      assert.equal(response.error, undefined);
    } finally { await mcp.close(); }
  }
});

test('tools/list publishes the agent CLI surface and nothing else', async () => {
  const mcp = client(board());
  try {
    await mcp.handshake();
    const { tools } = (await mcp.request('tools/list')).result;
    // The catalogue, snapshotted by shape rather than by prose: a tool added,
    // removed, renamed, or given a new argument has to be a deliberate edit
    // here, because a client's whole view of the board is this list.
    const snapshot = Object.fromEntries(tools.map((tool) => [
      tool.name, { required: tool.inputSchema.required ?? [], properties: Object.keys(tool.inputSchema.properties).sort() },
    ]));
    assert.deepEqual(snapshot, {
      gw_brief: { required: [], properties: ['json', 'me'] },
      gw_show: { required: ['id'], properties: ['id', 'json'] },
      gw_next: { required: ['id'], properties: ['id', 'json'] },
      gw_list: { required: [], properties: ['flag', 'limit', 'owner', 'phase', 'stage', 'text'] },
      gw_add: { required: ['title'], properties: ['parent', 'phase', 'priority', 'scope', 'title', 'type'] },
      gw_claim: { required: ['id'], properties: ['force', 'id'] },
      gw_move: { required: ['id', 'stage'], properties: ['evidence', 'force', 'id', 'stage'] },
      gw_note: { required: ['id', 'text'], properties: ['id', 'text'] },
      gw_edit: { required: ['id'], properties: ['deps', 'force', 'id', 'phase', 'priority', 'refs', 'scope', 'title', 'type'] },
      gw_triage: { required: ['id'], properties: ['approve', 'drop', 'force', 'id'] },
    });
    // Deterministic order, so a client may cache the list.
    assert.deepEqual(tools.map((tool) => tool.name), Object.keys(snapshot));
    for (const tool of tools) {
      assert.equal(tool.inputSchema.type, 'object', tool.name);
      assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
      assert.ok(tool.description.length > 40, `${tool.name} needs a description an agent can act on`);
      assert.ok(tool.title, tool.name);
      for (const [key, definition] of Object.entries(tool.inputSchema.properties)) {
        assert.ok(definition.description, `${tool.name}.${key} needs a description`);
      }
    }
  } finally { await mcp.close(); }
});

test('a full workflow runs over the wire: add, claim, refused move, evidenced move, brief', async () => {
  const root = board();
  const mcp = client(root);
  try {
    await mcp.handshake();
    const added = text(await mcp.call('gw_add', { title: 'wire up the board', scope: 'tools reach the CLI' }));
    const id = added.trim();
    assert.match(id, /^\S+$/);

    const claimed = await mcp.call('gw_claim', { id });
    assert.equal(claimed.result.isError, false);

    // The pipeline is the board's, not this test's: ask which stage is next
    // rather than hard-coding a stage name a custom board may not have.
    const stage = text(await mcp.call('gw_next', { id })).match(/next: (\S+)/)[1];
    assert.equal((await mcp.call('gw_move', { id, stage })).result.isError, false);
    const gated = text(await mcp.call('gw_next', { id })).match(/next: (\S+)/)[1];

    // In flight and owned: the brief is how the next session finds this.
    const inFlight = text(await mcp.call('gw_brief', {}));
    assert.match(inFlight, /wire up the board/);
    assert.match(inFlight, /agent:mcp/);

    const refused = await mcp.call('gw_move', { id, stage: gated });
    assert.equal(refused.result.isError, true, 'a move with no evidence must be refused');
    assert.match(text(refused), /evidence/i);

    const moved = await mcp.call('gw_move', { id, stage: gated, evidence: ['test/mcp.test.js'] });
    assert.equal(moved.result.isError, false, text(moved));
    assert.match(text(moved), new RegExp(`${id}\\s+\\S+ → ${gated}`));

    // Finished work leaves the open counts and is found by stage, which is
    // exactly the distinction the brief exists to draw.
    assert.match(text(await mcp.call('gw_brief', {})), /finished/);
    assert.match(text(await mcp.call('gw_list', { stage: gated })), /wire up the board/);
    // The write is recorded under the MCP server's declared identity.
    assert.match(text(await mcp.call('gw_show', { id })), /agent:mcp/);
  } finally { await mcp.close(); }
});

test('a refusal is the CLI refusal, byte for byte, on the same board state', async () => {
  const root = board();
  const mcp = client(root);
  try {
    await mcp.handshake();
    const id = text(await mcp.call('gw_add', { title: 'refusal parity' })).trim();
    const stage = text(await mcp.call('gw_next', { id })).match(/next: (\S+)/)[1];
    await mcp.call('gw_move', { id, stage });
    const gated = text(await mcp.call('gw_next', { id })).match(/next: (\S+)/)[1];

    const refused = await mcp.call('gw_move', { id, stage: gated });
    assert.equal(refused.result.isError, true);
    // A refusal changes nothing, so the CLI can be asked the identical
    // question afterwards and must produce the identical sentence. That
    // sentence is what teaches an agent what the board wants; paraphrasing
    // it here would make the MCP surface a worse teacher than the CLI.
    const sameQuestion = cli(root, ['move', id, gated], { GW_ACTOR: 'agent:mcp' });
    assert.equal(sameQuestion.status, 1);
    assert.equal(text(refused), sameQuestion.stderr);

    const unknownItem = await mcp.call('gw_show', { id: 'NOPE-1' });
    assert.equal(unknownItem.result.isError, true);
    assert.equal(text(unknownItem), cli(root, ['show', 'NOPE-1']).stderr);

    const bothWays = await mcp.call('gw_triage', { id, approve: true, drop: true });
    assert.equal(text(bothWays), cli(root, ['triage', id, '--approve', '--drop']).stderr);
  } finally { await mcp.close(); }
});

test('malformed and out-of-order JSON-RPC is answered, not crashed on', async () => {
  const mcp = client(board());
  try {
    await mcp.handshake();

    mcp.raw('this is not json');
    mcp.raw('   ');
    mcp.raw('[{"jsonrpc":"2.0","id":99,"method":"ping"}]');
    mcp.raw('{"jsonrpc":"1.0","id":98,"method":"ping"}');
    mcp.raw('{"jsonrpc":"2.0","id":97}');
    mcp.raw('{"jsonrpc":"2.0","id":null,"method":"ping"}');
    mcp.raw('{"jsonrpc":"2.0","id":96,"method":"tools/call","params":{"name":"gw_brief","arguments":[]}}');
    mcp.notify('notifications/some/unknown/thing');

    // The server is still serving after all of that, which is the assertion
    // that matters: a stdio server that dies on a bad line takes the whole
    // session with it.
    const alive = await mcp.request('ping');
    assert.deepEqual(alive.result, {});

    const errors = mcp.unsolicited.filter((message) => message.error);
    const codes = errors.map((message) => message.error.code).sort((a, b) => a - b);
    assert.deepEqual(codes, [-32700, -32602, -32600, -32600, -32600, -32600].sort((a, b) => a - b));
    // A batch has no single id to answer under, so the refusal is correlated
    // with nothing -- which is the case JSON-RPC reserves a null id for.
    const batched = errors.find((message) => /batched requests are not supported/.test(message.error.message));
    assert.ok(batched, 'a JSON-RPC batch is refused by name');
    assert.equal(batched.id, null);
    assert.equal(mcp.malformed.length, 0, 'every frame the server writes is one line of JSON');
    // A notification is answered with silence, always.
    assert.equal(mcp.unsolicited.some((message) => message.result !== undefined), false);
  } finally {
    const code = await mcp.close();
    assert.equal(code, 0, 'the server exits cleanly when the client closes stdin');
  }
});

test('protocol errors and tool errors are kept apart', async () => {
  const mcp = client(board());
  try {
    const early = await mcp.request('tools/list');
    assert.equal(early.error.code, -32600, 'requests before initialize are refused');
    assert.match(early.error.message, /before initialize/);

    await mcp.handshake();
    // Unknown tool and unknown method are protocol errors: there is nothing
    // in the arguments for a model to correct.
    assert.equal((await mcp.call('gw_nope')).error.code, -32602);
    assert.equal((await mcp.request('resources/list')).error.code, -32601);
    assert.equal((await mcp.request('tools/list', { cursor: 'made-up' })).error.code, -32602);

    // Bad arguments are a tool error: that is what a model can read and fix.
    const unknownArgument = await mcp.call('gw_brief', { nope: true });
    assert.equal(unknownArgument.result.isError, true);
    assert.match(text(unknownArgument), /unknown argument "nope"/);

    const wrongType = await mcp.call('gw_move', { id: 'T-1', stage: 'x', evidence: 'not-an-array' });
    assert.equal(wrongType.result.isError, true);
    assert.match(text(wrongType), /"evidence" must be an array of strings/);

    // A missing required positional is the CLI's own refusal, not one this
    // server invented, so there is one source of truth for that wording.
    const missing = await mcp.call('gw_move', { id: 'T-1' });
    assert.equal(missing.result.isError, true);
    assert.match(text(missing), /missing required argument "stage"/);
  } finally { await mcp.close(); }
});

test('identity defaults to agent:mcp, honours GW_ACTOR, and refuses a bare kind', async () => {
  const root = board();
  const mcp = client(root, { GW_ACTOR: 'agent:codex' });
  try {
    await mcp.handshake();
    const id = text(await mcp.call('gw_add', { title: 'whose work is this' })).trim();
    assert.match(text(await mcp.call('gw_show', { id })), /agent:codex/);
  } finally { await mcp.close(); }

  const bare = cli(root, ['mcp'], { GW_ACTOR: 'agent' });
  assert.equal(bare.status, 2, bare.stderr);
  assert.match(bare.stderr, /the actor names no agent/);
  // Refused before a byte of protocol is spoken: an identity error inside a
  // stream nobody reads is an identity error nobody sees.
  assert.equal(bare.stdout, '');
});

test('gw_list filters, searches and caps through the CLI, not around it', async () => {
  const root = board();
  const mcp = client(root);
  try {
    await mcp.handshake();
    for (const title of ['alpha one', 'beta two', 'alpha three']) await mcp.call('gw_add', { title });

    // Every one of these is the command's own output, byte for byte: the tool
    // maps arguments onto flags and adds nothing of its own.
    assert.equal(text(await mcp.call('gw_list', {})), cli(root, ['list']).stdout);
    assert.equal(text(await mcp.call('gw_list', { limit: 2 })), cli(root, ['list', '--limit', '2']).stdout);
    assert.equal(text(await mcp.call('gw_list', { text: 'alpha' })), cli(root, ['list', 'alpha']).stdout);
    assert.equal(text(await mcp.call('gw_list', { owner: 'none' })), cli(root, ['list', '--owner', 'none']).stdout);

    const capped = text(await mcp.call('gw_list', { limit: 2 }));
    assert.equal(capped.trimEnd().split('\n').length, 3, 'two rows and the line that says what was cut');
    assert.match(capped, /\(\+1 more of 3 matched/);

    const refused = await mcp.call('gw_list', { stage: 'no-such-stage' });
    assert.equal(refused.result.isError, true);
    assert.equal(text(refused), cli(root, ['list', '--stage', 'no-such-stage']).stderr);
  } finally { await mcp.close(); }
});

test('silent CLI success is reported as success, not as an empty result', async () => {
  const root = board();
  const mcp = client(root);
  try {
    await mcp.handshake();
    const id = text(await mcp.call('gw_add', { title: 'quiet commands' })).trim();
    const noted = await mcp.call('gw_note', { id, text: 'a remark' });
    assert.equal(noted.result.isError, false);
    assert.match(text(noted), /^ok — `gw note /);
    assert.match(text(await mcp.call('gw_show', { id })), /a remark/);
  } finally { await mcp.close(); }
});

test('the Claude Code plugin registers the server, and the adapters document it', async () => {
  const { readFileSync } = await import('node:fs');
  const mcpJson = JSON.parse(readFileSync(new URL('../adapters/claude-code/.mcp.json', import.meta.url), 'utf8'));
  const server = mcpJson.mcpServers.gw;
  // The same launch the plugin's hooks assume: `gw` on PATH, `mcp` as its
  // only argument. A registration that named anything else would be a second
  // way to start the server, and only one of them would get fixed.
  assert.equal(server.command, 'gw');
  assert.deepEqual(server.args, ['mcp']);
  for (const adapter of ['claude-code', 'codex', 'cursor', 'generic']) {
    const readme = readFileSync(new URL(`../adapters/${adapter}/README.md`, import.meta.url), 'utf8');
    assert.match(readme, /gw mcp/, `${adapter} adapter documents the MCP server`);
  }
});
