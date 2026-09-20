import './helpers/isolate-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, createLineReader, serialize } from '../lib/mcp/jsonrpc.js';
import { DEFAULT_ACTOR, mcpActor, refusalText } from '../lib/mcp/server.js';
import { TOOLS, printedCommand, validateArguments } from '../lib/mcp/tools.js';
import { RuleError, UsageError } from '../lib/cli/errors.js';

// T-0137 — the framing cases a client is unlikely to produce on purpose but
// which take the whole session down when they happen: a chunk boundary in the
// middle of a character, a line that never ends, CRLF from a Windows client.
// test/mcp.test.js covers the protocol over a real pipe; this covers the edges
// of the reader that a pipe will not reproduce on demand.

function collect(chunks, options) {
  const messages = [];
  const overflows = [];
  const reader = createLineReader({ onMessage: (line) => messages.push(line), onOverflow: (limit) => overflows.push(limit), ...options });
  for (const chunk of chunks) reader.push(chunk);
  reader.end();
  return { messages, overflows };
}

test('the reader splits on newlines and ignores the whitespace between messages', () => {
  const { messages } = collect(['{"a":1}\n', '\n', '   \n', '{"b":2}\n']);
  assert.deepEqual(messages, ['{"a":1}', '{"b":2}']);
});

test('a message split across chunks, including mid-character, is reassembled intact', () => {
  const whole = Buffer.from('{"title":"café ☕"}\n', 'utf8');
  // Every possible split point: one of them lands inside a multi-byte
  // character, which a plain String(chunk) turns into replacement characters
  // and a silently corrupted item title.
  for (let cut = 1; cut < whole.length; cut += 1) {
    const { messages } = collect([whole.subarray(0, cut), whole.subarray(cut)]);
    assert.deepEqual(messages, ['{"title":"café ☕"}'], `split at ${cut}`);
  }
});

test('CRLF framing and a final line with no newline are both accepted', () => {
  assert.deepEqual(collect(['{"a":1}\r\n{"b":2}\r\n']).messages, ['{"a":1}', '{"b":2}']);
  assert.deepEqual(collect(['{"a":1}\n{"b":2}']).messages, ['{"a":1}', '{"b":2}']);
});

test('a line past the size limit is dropped whole, and the next line still parses', () => {
  const { messages, overflows } = collect([`${'x'.repeat(200)}\n{"after":1}\n`], { limit: 64 });
  assert.deepEqual(overflows, [64]);
  // The point is that the oversized line's tail is not read as a message of
  // its own: an 8 MiB paste must cost one error, not a thousand.
  assert.deepEqual(messages, ['{"after":1}']);
});

test('every frame this server writes is exactly one line', () => {
  const line = serialize({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'two\nlines\n' }] } });
  assert.equal(line.endsWith('\n'), true);
  assert.equal(line.slice(0, -1).includes('\n'), false, 'an embedded newline would split one message into two');
  assert.deepEqual(JSON.parse(line).result.content[0].text, 'two\nlines\n');
});

test('classify tells requests, notifications and junk apart', () => {
  assert.equal(classify('{').kind, 'parse-error');
  assert.equal(classify('[]').kind, 'invalid');
  assert.equal(classify('{"jsonrpc":"2.0","method":"ping"}').kind, 'notification');
  assert.equal(classify('{"jsonrpc":"2.0","id":1,"method":"ping"}').kind, 'request');
  assert.equal(classify('{"jsonrpc":"2.0","id":1,"result":{}}').kind, 'ignore');
  assert.equal(classify('{"jsonrpc":"2.0","id":1,"method":"ping","params":[]}').kind, 'invalid');
  assert.equal(classify('{"jsonrpc":"2.0","id":"a","method":"ping"}').id, 'a');
  // An id the server can recover travels out with the refusal, so the client
  // can settle the request instead of waiting out its timeout.
  assert.equal(classify('{"jsonrpc":"1.0","id":7,"method":"ping"}').id, 7);
});

test('a refusal is rendered exactly as the CLI renders it on stderr', () => {
  assert.equal(refusalText(new UsageError('unknown item: T-9')), 'unknown item: T-9\n');
  assert.equal(
    refusalText(new RuleError('target stage requirements are not met', ['built: needs evidence', 'built: needs an owner'])),
    'target stage requirements are not met\nbuilt: needs evidence\nbuilt: needs an owner\n',
  );
});

test('the MCP actor defaults to an agent, and otherwise resolves exactly as the CLI does', () => {
  assert.equal(mcpActor({}, {}), DEFAULT_ACTOR);
  assert.equal(mcpActor({}, { GW_ACTOR: '  ' }), DEFAULT_ACTOR);
  assert.equal(mcpActor({}, { GW_ACTOR: 'agent:codex' }), 'agent:codex');
  assert.equal(mcpActor({ by: 'agent:opencode' }, { GW_ACTOR: 'agent:codex' }), 'agent:opencode');
  // A bare name is qualified, a bare kind is refused -- both by lib/cli/root.js,
  // so there is one definition of who an actor is.
  assert.equal(mcpActor({ by: 'rahil' }, {}), 'human:rahil');
  assert.throws(() => mcpActor({}, { GW_ACTOR: 'agent' }), UsageError);
  assert.throws(() => mcpActor({ by: 'agent:' }, {}), UsageError);
});

test('every tool maps onto a real command module and declares itself fully', async () => {
  for (const tool of TOOLS) {
    assert.match(tool.name, /^gw_[a-z_]+$/);
    const module = await import(new URL(`../lib/commands/${tool.command}.js`, import.meta.url));
    assert.ok(module.spec, `${tool.command} is a command module`);
    // Nothing is invented: every flag a tool sets must be one the command
    // actually declares, or it would be silently ignored at the far end.
    const declared = new Set([...Object.keys(module.spec.flags ?? {})]);
    const example = Object.fromEntries(Object.entries(tool.inputSchema.properties).map(([key, definition]) => [
      key, definition.type === 'boolean' ? true : definition.type === 'array' ? ['x'] : definition.type === 'integer' ? 1 : 'x',
    ]));
    const { flags, positionals } = tool.build(example);
    for (const flag of Object.keys(flags)) assert.ok(declared.has(flag), `gw ${tool.command} has no --${flag}`);
    assert.ok(positionals.length <= (module.spec.positionals?.length ?? 0), `gw ${tool.command} takes fewer positionals than ${tool.name} supplies`);
    // Only a command that declares --by can be told who is acting, and every
    // tool that writes must be one of them.
    if (tool.writes) assert.ok(declared.has('by'), `gw ${tool.command} cannot record an actor`);
  }
});

test('argument validation names the problem without guessing at the command', () => {
  const move = TOOLS.find((tool) => tool.name === 'gw_move');
  assert.deepEqual(validateArguments(move, { id: 'T-1', stage: 'built', evidence: ['a'] }), []);
  assert.deepEqual(validateArguments(move, { id: 'T-1' }), ['missing required argument "stage"']);
  assert.match(validateArguments(move, { id: 'T-1', stage: 'b', nope: 1 })[0], /unknown argument "nope"/);
  assert.match(validateArguments(move, { id: 1, stage: 'b' })[0], /"id" must be a string/);
  assert.match(validateArguments(move, { id: 'T-1', stage: 'b', evidence: [7] })[0], /every entry of "evidence" must be a string/);
  const list = TOOLS.find((tool) => tool.name === 'gw_list');
  assert.match(validateArguments(list, { limit: 0 })[0], /"limit" must be an integer of 1 or more/);
  assert.match(validateArguments(list, { limit: 1.5 })[0], /"limit" must be an integer/);
});

test('the command a tool call stands for is printed the way it would be typed', () => {
  const note = TOOLS.find((tool) => tool.name === 'gw_note');
  assert.equal(
    printedCommand(note, { flags: { by: 'agent:mcp' }, positionals: ['T-1', 'a remark'] }),
    'gw note T-1 "a remark" --by agent:mcp',
  );
  const move = TOOLS.find((tool) => tool.name === 'gw_move');
  assert.equal(
    printedCommand(move, { flags: { evidence: ['a1b2c3d', 'docs/x.md'], force: true }, positionals: ['T-1', 'built'] }),
    'gw move T-1 built --evidence a1b2c3d --evidence docs/x.md --force',
  );
});
