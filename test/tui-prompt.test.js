import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import {
  confirmModel, createPrompter, createTheme, multiSelectModel, parseKeys, renderScreen,
  selectModel, stripAnsi, supportsRich, terminalCaps, textModel,
} from '../lib/tui/prompt.js';

// A terminal double: PassThrough streams that claim to be a TTY and record
// every setRawMode call, so the tests can prove the terminal is given back.
function rawTty({ columns = 60, rows = 20 } = {}) {
  const input = new PassThrough();
  input.isTTY = true;
  const raw = [];
  input.setRawMode = (value) => raw.push(value);
  const output = new PassThrough();
  output.isTTY = true;
  output.columns = columns;
  output.rows = rows;
  let text = '';
  output.on('data', (chunk) => { text += chunk; });
  return { input, output, raw, text: () => text };
}

// Drive a pure model with a key string, as the session would.
function drive(model, keys) {
  let state = model.init;
  for (const key of parseKeys(keys)) {
    const result = model.update(state, key);
    if (Object.hasOwn(result, 'done')) return { done: result.done, state };
    state = result.state;
  }
  return { state };
}

const theme = (options = {}) => createTheme({ output: { isTTY: true, columns: options.columns ?? 60, rows: options.rows ?? 20 }, env: options.env ?? { NO_COLOR: '1' }, platform: options.platform ?? 'linux' });
const CHOICES = [
  { value: 'solo', label: 'Solo', detail: 'No pull requests.' },
  { value: 'team', label: 'Team', detail: 'Review through pull requests.' },
  { value: 'big', label: 'Big', detail: 'Many people.' },
];

test('parseKeys splits a batched chunk into arrows, controls and characters', () => {
  assert.deepEqual(parseKeys('\x1b[B\x1b[B\r').map((key) => key.name), ['down', 'down', 'enter']);
  assert.deepEqual(parseKeys('\x1bOA\x1b[5~ jk\x7f\x03').map((key) => key.name), ['up', 'pageup', 'space', 'j', 'k', 'backspace', 'ctrl-c']);
  assert.deepEqual(parseKeys('\x1b').map((key) => key.name), ['escape']);
  assert.deepEqual(parseKeys('\r\n').map((key) => key.name), ['enter'], 'CRLF is one Enter, not two');
  assert.equal(parseKeys('é')[0].ch, 'é');
});

test('select: arrows and j/k wrap, digits jump without choosing, Enter chooses', () => {
  const model = selectModel('Pick', CHOICES);
  assert.equal(drive(model, '\x1b[B\r').done, 'team');
  assert.equal(drive(model, '\x1b[A\r').done, 'big', 'up from the first row wraps to the last');
  assert.equal(drive(model, 'jjj\r').done, 'solo');
  assert.equal(drive(model, 'jk\r').done, 'solo');
  assert.deepEqual(drive(model, '3').state, { focus: 2 }, 'a digit only moves the highlight');
  assert.equal(drive(selectModel('Pick', CHOICES, { fallback: 1 }), '\r').done, 'team');
});

test('select: the view highlights one row and describes it', () => {
  const view = selectModel('Pick', CHOICES).view({ focus: 1 }, theme());
  assert.deepEqual(view.body, ['  Solo', '❯ Team', '  Big']);
  assert.equal(view.description, 'Review through pull requests.');
  assert.ok(view.hints.includes('Enter choose'));
});

test('multi-select: Space toggles, locked rows stay on, Enter returns the checked values', () => {
  const model = multiSelectModel('Set up', [
    { value: 'agents', label: 'AGENTS.md', locked: true },
    { value: 'claude', label: 'Claude', checked: true },
    { value: 'hook', label: 'Hook' },
  ]);
  assert.equal(model.init.focus, 1, 'focus starts on the first row that can change');
  assert.deepEqual(drive(model, '\r').done, ['agents', 'claude']);
  assert.deepEqual(drive(model, ' j \r').done, ['agents', 'hook']);
  assert.deepEqual(drive(model, 'k \r').done, ['agents', 'claude'], 'Space on a locked row does nothing');
  const view = model.view({ focus: 2, checked: [true, true, false] }, theme());
  assert.match(view.body[0], /AGENTS\.md \(always\)/);
  assert.equal(view.body[2], '❯ ○ Hook');
});

test('confirm: arrows switch, y and n answer at once, Enter takes the highlighted button', () => {
  assert.equal(drive(confirmModel('Go?', { fallback: true }), '\r').done, true);
  assert.equal(drive(confirmModel('Go?', { fallback: true }), '\x1b[C\r').done, false);
  assert.equal(drive(confirmModel('Go?', { fallback: false }), 'y').done, true);
  assert.equal(drive(confirmModel('Go?'), 'n').done, false);
});

test('text: typing, cursor movement, deletion and validation', () => {
  assert.equal(drive(textModel('Name', { fallback: 'ab' }), 'c\r').done, 'abc');
  assert.equal(drive(textModel('Name', { fallback: 'ab' }), '\x1b[DX\r').done, 'aXb');
  assert.equal(drive(textModel('Name', { fallback: 'abc' }), '\x7f\x7f\r').done, 'a');
  assert.equal(drive(textModel('Name', { fallback: 'old' }), '\x15new\r').done, 'new');
  assert.equal(drive(textModel('Name', { fallback: 'one two' }), '\x17\r').done, 'one');
  const refusing = textModel('N', { fallback: '5', validate: (raw) => (Number(raw) > 3 ? 'too big' : null) });
  const refused = drive(refusing, '\r');
  assert.equal(refused.done, undefined);
  assert.equal(refused.state.error, 'too big', 'a refused answer keeps the screen up with the reason');
  assert.equal(drive(refusing, '\x7f2\r').done, '2');
});

test('renderScreen fits the terminal, pins the hints to the bottom, and scrolls to keep focus visible', () => {
  const narrow = theme({ columns: 30, rows: 16 });
  const body = Array.from({ length: 40 }, (_, index) => `row ${index}`);
  const lines = renderScreen(narrow, { title: 'gw config', step: 'Step 1 of 3', question: 'A question that is far too long for thirty columns', body, focusLine: 25, description: 'Description.', hints: ['a', 'b'] });
  assert.equal(lines.length, 16, 'exactly one screen of rows');
  assert.ok(lines.every((line) => [...stripAnsi(line)].length <= 30), lines.join('\n'));
  assert.ok(lines.some((line) => line.includes('row 25')), 'the focused row is on screen');
  assert.match(lines.at(-1), /a {2}· {2}b/);
  assert.ok(lines.some((line) => /↑ \d+ more/.test(line)) && lines.some((line) => /↓ \d+ more/.test(line)));
});

test('colour follows NO_COLOR and FORCE_COLOR; old Windows consoles get ASCII', () => {
  assert.equal(theme({ env: {} }).colour, true);
  assert.equal(theme({ env: { NO_COLOR: '' } }).colour, false);
  assert.equal(theme({ env: { FORCE_COLOR: '0' } }).colour, false);
  assert.equal(theme({ env: {}, platform: 'win32' }).g.cursor, '>');
  assert.equal(theme({ env: { WT_SESSION: '1' }, platform: 'win32' }).g.cursor, '❯');
  assert.equal(theme({ env: { TERM: 'xterm-256color' }, platform: 'win32' }).g.cursor, '❯', 'the glyphs follow the same detection as the full screen');
});

test('Windows capabilities: announced terminals get VT and Unicode, a bare modern console VT and ASCII, legacy conhost neither', () => {
  const caps = (env, release = '10.0.22631') => terminalCaps({ env, platform: 'win32', release });
  for (const env of [{ WT_SESSION: 'x' }, { TERM_PROGRAM: 'vscode' }, { ConEmuANSI: 'ON' }, { ANSICON: '80x25' }, { TERMINAL_EMULATOR: 'JetBrains-JediTerm' }, { TERM: 'xterm-256color' }]) {
    assert.deepEqual(caps(env), { vt: true, unicode: true }, JSON.stringify(env));
    assert.deepEqual(caps(env, '6.1.7601'), { vt: true, unicode: true }, 'an announced terminal is trusted on any Windows');
  }
  assert.deepEqual(caps({ ConEmuANSI: 'OFF' }), { vt: true, unicode: false }, 'ConEmu with ANSI off is treated as the bare host it wraps');
  assert.deepEqual(caps({ TERM: 'dumb' }), { vt: true, unicode: false });
  assert.deepEqual(caps({}, '10.0.10586'), { vt: true, unicode: false });
  assert.deepEqual(caps({}, '10.0.10240'), { vt: false, unicode: false }, 'Windows 10 before 1511 has no VT');
  assert.deepEqual(caps({}, '6.3.9600'), { vt: false, unicode: false });
  assert.deepEqual(terminalCaps({ env: {}, platform: 'linux', release: '6.0.0' }), { vt: true, unicode: true });
  assert.deepEqual(terminalCaps({ env: {}, platform: 'darwin', release: '24.0.0' }), { vt: true, unicode: true });
});

test('rich mode needs raw mode and a capable terminal', () => {
  const tty = rawTty();
  assert.equal(supportsRich({ input: tty.input, output: tty.output, env: { TERM: 'xterm' }, platform: 'linux' }), true);
  assert.equal(supportsRich({ input: tty.input, output: tty.output, env: { TERM: 'dumb' }, platform: 'linux' }), false);
  assert.equal(supportsRich({ input: tty.input, output: tty.output, env: { GW_TUI: '0' }, platform: 'linux' }), false);
  assert.equal(supportsRich({ input: tty.input, output: tty.output, env: {}, platform: 'win32', release: '6.3.9600' }), false, 'legacy conhost keeps the numbered prompts');
  assert.equal(supportsRich({ input: tty.input, output: tty.output, env: {}, platform: 'win32', release: '10.0.19045' }), true, 'a modern console host understands VT');
  assert.equal(supportsRich({ input: tty.input, output: tty.output, env: { WT_SESSION: 'x' }, platform: 'win32', release: '6.3.9600' }), true);
  assert.equal(supportsRich({ input: { isTTY: true }, output: tty.output, env: {}, platform: 'linux' }), false, 'no setRawMode, no picker');
});

test('a session draws full-screen, accepts batched keys, and restores the terminal on Enter', async () => {
  const tty = rawTty();
  const prompt = createPrompter({ input: tty.input, output: tty.output, env: { TERM: 'xterm-256color' }, platform: 'linux', title: 'gw init' });
  const answer = prompt.select('Choose a workflow:', CHOICES, { step: 'Step 1 of 2' });
  tty.input.write('\x1b[B\x1b[B\x1b[A\r');
  assert.equal(await answer, 'team');
  prompt.close();
  const text = tty.text();
  assert.deepEqual(tty.raw, [true, false]);
  assert.match(text, /^\x1b\[\?1049h\x1b\[\?25l/, 'enters the alternate screen with the cursor hidden');
  assert.match(text, /\x1b\[\?25h\x1b\[\?1049l$/, 'shows the cursor and leaves the alternate screen last');
  assert.match(stripAnsi(text), /Gatewright {2}· {2}gw init/);
  assert.match(stripAnsi(text), /Step 1 of 2/);
  assert.match(stripAnsi(text), /Review through pull requests/);
});

test('several screens share one raw-mode session', async () => {
  const tty = rawTty();
  const prompt = createPrompter({ input: tty.input, output: tty.output, env: { TERM: 'xterm' }, platform: 'linux' });
  const first = prompt.select('One', CHOICES);
  tty.input.write('\r');
  assert.equal(await first, 'solo');
  const second = prompt.confirm('Two?');
  tty.input.write('n');
  assert.equal(await second, false);
  const third = prompt.text('Three', { fallback: 'x' });
  tty.input.write('yz\r');
  assert.equal(await third, 'xyz');
  prompt.close();
  assert.deepEqual(tty.raw, [true, false]);
});

for (const [name, key, reason] of [['Ctrl-C', '\x03', 'interrupt'], ['Esc', '\x1b', 'escape'], ['Ctrl-D', '\x04', 'interrupt']]) {
  test(`${name} rejects with AbortedError and restores raw mode and cursor`, async () => {
    const tty = rawTty();
    const prompt = createPrompter({ input: tty.input, output: tty.output, env: { TERM: 'xterm' }, platform: 'linux' });
    const choice = prompt.select('Choose:', CHOICES);
    tty.input.write(key);
    await assert.rejects(choice, { name: 'AbortedError', reason });
    prompt.close();
    assert.deepEqual(tty.raw, [true, false]);
    assert.match(tty.text(), /\x1b\[\?25h/);
  });
}

test('input ending mid-screen cancels instead of hanging', async () => {
  const tty = rawTty();
  const prompt = createPrompter({ input: tty.input, output: tty.output, env: { TERM: 'xterm' }, platform: 'linux' });
  const choice = prompt.select('Choose:', CHOICES);
  tty.input.end();
  await assert.rejects(choice, { name: 'AbortedError', reason: 'eof' });
  await assert.rejects(prompt.confirm('Again?'), { name: 'AbortedError' });
  prompt.close();
  assert.deepEqual(tty.raw, [true, false]);
});

test('an exception inside a screen still gives the terminal back', async () => {
  const tty = rawTty();
  const prompt = createPrompter({ input: tty.input, output: tty.output, env: { TERM: 'xterm' }, platform: 'linux' });
  const broken = { question: 'x', init: {}, update() { throw new Error('boom'); }, view: () => ({ body: [], hints: [] }) };
  const shown = prompt.screen(broken);
  tty.input.write('j');
  await assert.rejects(shown, /boom/);
  prompt.close();
  assert.deepEqual(tty.raw, [true, false]);
  assert.match(tty.text(), /\x1b\[\?25h\x1b\[\?1049l$/);
});

test('an external SIGINT restores the terminal before exiting', async () => {
  const tty = rawTty();
  const prompt = createPrompter({ input: tty.input, output: tty.output, env: { TERM: 'xterm' }, platform: 'linux' });
  const choice = prompt.select('Choose:', CHOICES);
  choice.catch(() => {});
  const exit = process.exit;
  let code;
  process.exit = (value) => { code = value; };
  try { process.emit('SIGINT', 'SIGINT'); } finally { process.exit = exit; }
  assert.equal(code, 130);
  assert.deepEqual(tty.raw, [true, false]);
  assert.match(tty.text(), /\x1b\[\?25h\x1b\[\?1049l$/);
  assert.equal(process.listenerCount('SIGINT') >= 0, true);
  prompt.close();
});

test('a plain stream keeps the numbered prompt and never receives escapes', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  const output = new PassThrough();
  output.isTTY = true;
  let text = '';
  output.on('data', (chunk) => { text += chunk; if (/: $/.test(String(chunk))) setImmediate(() => input.write('2\n')); });
  const prompt = createPrompter({ input, output, env: { TERM: 'xterm' }, platform: 'linux' });
  assert.equal(prompt.rich(), false);
  assert.equal(await prompt.select('Choose a workflow:', CHOICES), 'team');
  prompt.close();
  assert.match(text, /1\) Solo/);
  assert.doesNotMatch(text, /\x1b\[\?1049h/);
});
