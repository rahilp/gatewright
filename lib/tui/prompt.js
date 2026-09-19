// The interactive layer, and the only place this tool reads from stdin.
//
// Two rules hold everywhere here. First, zero dependencies: these are built on
// node:readline and raw ANSI because a setup wizard is not worth a dependency
// tree in a package that promises not to have one. Second, and more important,
// nothing in gw may *require* a human. `gw init` is run by agents, by CI, and
// inside `npx` one-liners, and a prompt that blocks there is a hang with no
// explanation. So interactivity is opt-in by circumstance: a real TTY on both
// ends, no --yes, no CI marker. Everywhere else the caller's defaults are
// taken silently and the command behaves exactly as it did before this
// existed.
//
// Within an interactive run there are two presentations. A capable terminal
// gets full-screen, arrow-key screens (the "rich" mode below). Dumb
// terminals, streams that only claim to be a TTY, and Windows consoles without
// VT support keep the numbered readline prompts. That fallback is a feature,
// not a compromise: a number is typeable over a mangled ssh session and on an
// old conhost where escape sequences print as garbage.
import { release as osRelease } from 'node:os';
import { createInterface } from 'node:readline/promises';

// Thrown when the user aborts (Esc, Ctrl-C, Ctrl-D, or EOF). The caller
// catches it and leaves the filesystem untouched -- a half-written config is
// worse than no config, because the next run cannot tell the difference.
// `reason` lets a screen treat Esc as "back" where that reads better, while
// Ctrl-C and EOF always mean "stop".
export class AbortedError extends Error {
  constructor(reason = 'interrupt') {
    super('cancelled');
    this.name = 'AbortedError';
    this.reason = reason;
  }
}

// `CI` is checked because CI runners frequently allocate a TTY, so isTTY alone
// is not enough to conclude a human is watching. GW_NO_INPUT is the explicit
// escape hatch for anything else that lies about its terminal.
export function isInteractive({ flags = {}, env = process.env, input = process.stdin, output = process.stdout } = {}) {
  if (flags.yes || flags['no-input']) return false;
  if (env.GW_NO_INPUT) return false;
  if (env.CI) return false;
  return Boolean(input.isTTY && output.isTTY);
}

// What a Windows console can draw, decided in one place so the full-screen
// switch and the glyph set can never disagree (they once did: TERM counted as
// VT support for one and not the other, and a mintty session got the screens
// drawn in ASCII).
//
//   - A terminal that announces itself -- Windows Terminal (WT_SESSION), VS
//     Code and other TERM_PROGRAM hosts, ConEmu/Cmder (ConEmuANSI=ON),
//     ANSICON, JetBrains (TERMINAL_EMULATOR), or mintty/MSYS/Cygwin/ssh
//     (TERM) -- interprets VT sequences and ships fonts with the full glyph
//     set: full screen, Unicode.
//   - A bare console host on Windows 10 1511 (build 10586) or later
//     understands VT, which Node switches on, so it gets the full screen --
//     but its default raster/Consolas fonts have no ❯ ◉ ○ ✓ ◆ and it has no
//     font fallback, so it draws with ASCII rather than boxes of tofu.
//   - Anything older is a legacy conhost with no VT at all: the numbered
//     prompts, ASCII if anything is drawn.
// Everywhere else, VT and Unicode are assumed.
export function terminalCaps({ env = process.env, platform = process.platform, release = osRelease() } = {}) {
  if (platform !== 'win32') return { vt: true, unicode: true };
  const announced = Boolean(env.WT_SESSION || env.TERM_PROGRAM || env.ConEmuANSI === 'ON' || env.ANSICON
    || env.TERMINAL_EMULATOR || (env.TERM && env.TERM !== 'dumb'));
  if (announced) return { vt: true, unicode: true };
  const [major, , build] = String(release).split('.').map(Number);
  return { vt: major > 10 || (major === 10 && build >= 10586), unicode: false };
}

// Whether this pair of streams can run the full-screen picker. Raw mode is the
// deciding capability: a pipe or a test double without setRawMode cannot
// deliver single keypresses, so it gets the line-based prompts. GW_TUI=0 is the
// user's own way out if their terminal renders the screens badly.
export function supportsRich({ input = process.stdin, output = process.stdout, env = process.env, platform = process.platform, release } = {}) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') return false;
  if (env.TERM === 'dumb') return false;
  if (env.GW_TUI === '0' || env.GW_TUI === 'plain') return false;
  return terminalCaps({ env, platform, release }).vt;
}

// https://no-color.org: any NO_COLOR value, even empty, turns colour off.
function colourEnabled({ output, env }) {
  if (env.NO_COLOR !== undefined) return false;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== '0';
  return Boolean(output.isTTY) && env.TERM !== 'dumb';
}

const UNICODE = { rule: '─', cursor: '❯', on: '◉', off: '○', lock: '■', done: '✓', up: '↑', down: '↓', left: '←', right: '→', dot: '·', mark: '◆', more: '…', tl: '┌', tr: '┐', bl: '└', br: '┘', v: '│' };
const ASCII = { rule: '-', cursor: '>', on: '[x]', off: '[ ]', lock: '[x]', done: '*', up: '^', down: 'v', left: '<', right: '>', dot: '/', mark: '*', more: '...', tl: '+', tr: '+', bl: '+', br: '+', v: '|' };

export function createTheme({ output = process.stdout, env = process.env, platform = process.platform, release } = {}) {
  const { unicode } = terminalCaps({ env, platform, release });
  return {
    colour: colourEnabled({ output, env }),
    g: unicode ? UNICODE : ASCII,
    // Read on every frame rather than captured once, so a resized terminal
    // re-lays out on the next redraw.
    get width() { return Math.max(24, Math.min(Number(output.columns) || 80, 100)); },
    get rows() { return Math.max(10, Number(output.rows) || 24); },
  };
}

function paint(theme, code, text) { return theme.colour ? `\x1b[${code}m${text}\x1b[0m` : text; }
const style = {
  bold: (theme, text) => paint(theme, '1', text),
  dim: (theme, text) => paint(theme, '2', text),
  accent: (theme, text) => paint(theme, '36;1', text),
  good: (theme, text) => paint(theme, '32', text),
  warn: (theme, text) => paint(theme, '33', text),
  bad: (theme, text) => paint(theme, '31;1', text),
  // Without colour the selection must still be unmistakable, so the cursor
  // glyph carries it; inverse video is decoration on top.
  inverse: (theme, text) => paint(theme, '7', text),
  // Black on bright cyan: at least 4.5:1 (WCAG AA) in every common palette
  // checked -- xterm, VGA, GNOME Tango, macOS Terminal, Windows Campbell, VS
  // Code dark and light, iTerm2, Solarized, One Half Light, Dracula (lowest
  // 4.8, One Half Light). White on cyan was 1.2-3.3. 46 comes first as the
  // fallback for a terminal without bright backgrounds, which ignores 106
  // and still draws black on cyan. Not bold: terminals that render bold as
  // bright would turn black text grey.
  bar: (theme, text) => paint(theme, '30;46;106', text),
};
export { style as tuiStyle };

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
export function stripAnsi(text) { return String(text).replace(ANSI, ''); }
function visibleLength(text) { return [...stripAnsi(text)].length; }

function clip(text, width, theme) {
  const value = String(text ?? '');
  if (visibleLength(value) <= width) return value;
  // Cutting through an escape sequence would leave a colour open for the rest
  // of the screen, so an over-long line gives up its emphasis instead.
  return `${[...stripAnsi(value)].slice(0, Math.max(0, width - 1)).join('')}${theme.g === ASCII ? '~' : '…'}`;
}

// Wraps one line for a boxed panel, keeping its leading indent and hanging
// continuation lines under the text after a bullet glyph ("✓ ", "- "), so a
// wrapped item still reads as one item.
function wrapHanging(text, width) {
  if (visibleLength(text) <= width) return [text];
  const lead = /^\s*/.exec(text)[0];
  const bullet = /^\s*\S (?=\S)/.test(text) ? 2 : 0;
  const hang = ' '.repeat(Math.min(lead.length + bullet, Math.floor(width / 2)));
  const lines = [];
  let line = lead;
  let fresh = true;
  // Splitting on single spaces keeps runs of spaces (column alignment) intact.
  for (const word of text.trimStart().split(' ')) {
    const next = fresh ? `${line}${word}` : `${line} ${word}`;
    if (!fresh && visibleLength(next) > width) {
      lines.push(line);
      line = `${hang}${word}`;
    } else {
      line = next;
    }
    fresh = false;
  }
  lines.push(line);
  return lines;
}

function wrap(text, width) {
  const lines = [];
  for (const paragraph of String(text ?? '').split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && visibleLength(`${line} ${word}`) > width) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
    }
    lines.push(line);
  }
  return lines;
}

// Keystrokes arrive as data chunks, and a terminal may batch several into one
// (holding an arrow key, or a paste). Each escape sequence is one token, so
// "down down Enter" in a single chunk is three keys, not one unknown string.
const KEY_TOKEN = /\r\n|\x1b\[[0-9;]*[A-Za-z~]|\x1bO[A-Za-z]|\x1b[\s\S]?|[\s\S]/gu;
const KEY_NAMES = {
  '\x1b[A': 'up', '\x1bOA': 'up', '\x1b[B': 'down', '\x1bOB': 'down',
  '\x1b[C': 'right', '\x1bOC': 'right', '\x1b[D': 'left', '\x1bOD': 'left',
  '\x1b[H': 'home', '\x1bOH': 'home', '\x1b[1~': 'home', '\x1b[7~': 'home',
  '\x1b[F': 'end', '\x1bOF': 'end', '\x1b[4~': 'end', '\x1b[8~': 'end',
  '\x1b[5~': 'pageup', '\x1b[6~': 'pagedown', '\x1b[3~': 'delete', '\x1b[Z': 'shift-tab',
  '\r\n': 'enter', '\r': 'enter', '\n': 'enter', '\t': 'tab', ' ': 'space',
  '\x7f': 'backspace', '\b': 'backspace', '\x1b': 'escape',
  '\x03': 'ctrl-c', '\x04': 'ctrl-d', '\x01': 'ctrl-a', '\x05': 'ctrl-e', '\x15': 'ctrl-u', '\x17': 'ctrl-w',
};

export function parseKeys(chunk) {
  return (String(chunk).match(KEY_TOKEN) ?? []).map((sequence) => {
    const name = KEY_NAMES[sequence];
    if (name) return { name, ch: sequence === ' ' ? ' ' : null, sequence };
    const printable = !sequence.startsWith('\x1b') && sequence >= ' ';
    return { name: printable ? sequence : 'unknown', ch: printable ? sequence : null, sequence };
  });
}

function hintLine(theme, hints) {
  return style.dim(theme, hints.join(`  ${theme.g.dot}  `));
}

// One screen of the full-screen UI: a title bar, the question and a short
// explanation of what it decides, the model's body, any note about the
// focused row, and the key hints pinned to the bottom row. A body taller than
// the room left scrolls around the focused block (`focusLine`, `focusSpan`
// lines long) so the highlighted option and its whole description stay on
// screen; the rows lost above and below are marked, never silently dropped.
export function renderScreen(theme, { title = 'Gatewright', step, intro = [], question, explain = [], body = [], focusLine = 0, focusSpan = 1, description, warning, error, hints = [] }) {
  const width = theme.width;
  const inner = width - 4;
  const brand = `${theme.g.mark} Gatewright`;
  const left = title && title !== 'Gatewright' ? `${brand}  ${theme.g.dot}  ${title}` : brand;
  const right = step ?? '';
  const pad = Math.max(1, width - visibleLength(left) - visibleLength(right) - 2);
  const top = [style.bar(theme, ` ${left}${' '.repeat(pad)}${right} `)];
  // Without colour the title bar is just text, so a rule marks where it ends.
  top.push(...(theme.colour ? [] : [theme.g.rule.repeat(width)]), '');
  for (const line of intro) top.push(...wrap(line, inner).map((part) => `  ${style.dim(theme, part)}`));
  if (intro.length) top.push('');
  if (question) top.push(...wrap(question, inner).map((part) => `  ${style.bold(theme, part)}`));
  for (const line of [explain].flat().filter(Boolean)) top.push(...wrap(line, inner).map((part) => `  ${style.dim(theme, part)}`));
  if (question) top.push('');

  const below = [];
  if (description) below.push('', ...wrap(description, inner).map((part) => `  ${style.dim(theme, part)}`));
  if (warning) below.push(...(description ? [] : ['']), ...wrap(`Warning: ${warning}`, inner).map((part) => `  ${style.warn(theme, part)}`));
  if (error) below.push('', ...wrap(error, inner).map((part) => `  ${style.bad(theme, part)}`));
  // The hints are the bottom row, and are kept one column short of it: a
  // character in the bottom-right cell leaves the terminal waiting to wrap,
  // where the next write can scroll the whole screen up a line.
  const footer = [style.dim(theme, theme.g.rule.repeat(width)), clip(`  ${hintLine(theme, hints)}`, width - 1, theme)];

  const room = Math.max(1, theme.rows - top.length - below.length - footer.length);
  let shown = body;
  if (body.length > room && room >= 3) {
    // A "more" marker takes a row, and is only drawn on a side that has
    // something hidden: near the top there is only one below, near the end
    // only one above, and in the middle one on each side.
    const above = style.dim(theme, `    ${theme.g.up} more above`);
    const below = style.dim(theme, `    ${theme.g.down} more below`);
    const span = Math.min(focusSpan, room - 2);
    if (focusLine + span <= room - 1) {
      shown = [...body.slice(0, room - 1), below];
    } else if (focusLine >= body.length - (room - 1)) {
      shown = [above, ...body.slice(body.length - (room - 1))];
    } else {
      const window = room - 2;
      const start = Math.max(1, Math.min(focusLine - Math.floor((window - span) / 2), body.length - window - 1));
      shown = [above, ...body.slice(start, start + window), below];
    }
  }
  // A terminal too short for everything loses the bottom of the content
  // rather than the key hints: those are how you get out.
  const content = [...top, ...shown, ...below].slice(0, Math.max(0, theme.rows - footer.length));
  const filler = Math.max(0, theme.rows - content.length - footer.length);
  return [...content, ...Array(filler).fill(''), ...footer].map((line) => clip(line, width, theme));
}

const MOVE_HINT = (theme) => `${theme.g.up}${theme.g.down} move`;

// An option as a block: its label on the marker row, then its description on
// the rows under it, dim and indented, shown whether or not it is focused so
// the choices can be compared without moving through them. Descriptions wrap
// rather than being cut; a long list scrolls instead (see renderScreen).
function optionBlock(theme, { focused, marker = '', label, detail }) {
  const cursor = focused ? style.accent(theme, theme.g.cursor) : ' ';
  const head = `${cursor} ${marker}${focused ? style.accent(theme, label) : label}`;
  const indent = 2 + visibleLength(marker);
  const lines = [detail].flat().filter(Boolean)
    .flatMap((text) => wrap(text, theme.width - indent - 4))
    .map((part) => `${' '.repeat(indent + 2)}${style.dim(theme, part)}`);
  return [head, ...lines];
}

// Lays out option blocks and reports where the focused one sits.
function optionList(blocks, focus) {
  const body = [];
  let focusLine = 0;
  let focusSpan = 1;
  blocks.forEach((block, index) => {
    if (index === focus) { focusLine = body.length; focusSpan = block.length; }
    body.push(...block);
  });
  return { body, focusLine, focusSpan };
}

function moveFocus(focus, key, count) {
  switch (key.name) {
    case 'up': case 'k': case 'shift-tab': return (focus - 1 + count) % count;
    case 'down': case 'j': case 'tab': return (focus + 1) % count;
    case 'home': case 'g': return 0;
    case 'end': case 'G': return count - 1;
    case 'pageup': return Math.max(0, focus - 5);
    case 'pagedown': return Math.min(count - 1, focus + 5);
    default: return null;
  }
}

// The screens are pure (state, key) -> result models so their behaviour can
// be tested by feeding key names, without a terminal. `update` returns
// { state } to redraw, { done: value } to finish, or { cancel: reason }.
export function selectModel(question, choices, { fallback = 0 } = {}) {
  const count = choices.length;
  return {
    question,
    init: { focus: Math.min(Math.max(0, fallback), count - 1) },
    update(state, key) {
      if (key.name === 'enter' || key.name === 'space') return { done: choices[state.focus].value };
      const moved = moveFocus(state.focus, key, count);
      if (moved !== null) return { state: { focus: moved } };
      // A digit jumps rather than chooses: a stray keypress should never
      // commit an answer the user did not see highlighted.
      if (/^[1-9]$/.test(key.name) && Number(key.name) <= count) return { state: { focus: Number(key.name) - 1 } };
      return { state };
    },
    view(state, theme) {
      return {
        ...optionList(choices.map((choice, index) => optionBlock(theme, { focused: index === state.focus, label: choice.label, detail: choice.detail })), state.focus),
        hints: [MOVE_HINT(theme), 'Enter choose', 'Esc cancel'],
      };
    },
  };
}

export function multiSelectModel(question, choices) {
  const count = choices.length;
  return {
    question,
    init: { focus: Math.max(0, choices.findIndex((choice) => !choice.locked)), checked: choices.map((choice) => Boolean(choice.checked || choice.locked)) },
    update(state, key) {
      if (key.name === 'enter') return { done: choices.filter((_, index) => state.checked[index]).map((choice) => choice.value) };
      if (key.name === 'space' || key.name === 'x') {
        if (choices[state.focus].locked) return { state };
        const checked = [...state.checked];
        checked[state.focus] = !checked[state.focus];
        return { state: { ...state, checked } };
      }
      const moved = moveFocus(state.focus, key, count);
      return { state: moved === null ? state : { ...state, focus: moved } };
    },
    view(state, theme) {
      const blocks = choices.map((choice, index) => {
        const box = choice.locked ? theme.g.lock : state.checked[index] ? theme.g.on : theme.g.off;
        const plainBox = `${box} `;
        const mark = `${state.checked[index] ? style.good(theme, box) : style.dim(theme, box)} `;
        const label = choice.locked ? `${choice.label} (always)` : choice.label;
        const block = optionBlock(theme, { focused: index === state.focus, marker: plainBox, label, detail: choice.detail });
        // The marker is measured plain for the indent, then drawn in colour.
        block[0] = block[0].replace(plainBox, mark);
        return block;
      });
      return {
        ...optionList(blocks, state.focus),
        hints: [MOVE_HINT(theme), 'Space toggle', 'Enter continue', 'Esc cancel'],
      };
    },
  };
}

// Yes and No are laid out as two options, each saying what it will do, since
// "Yes" alone does not tell anyone what they are agreeing to. `yes` and `no`
// are labels or { label, detail }.
export function confirmModel(question, { fallback = true, details = [], yes = 'Yes', no = 'No' } = {}) {
  const options = [yes, no].map((option) => (typeof option === 'string' ? { label: option } : option));
  return {
    question,
    init: { value: Boolean(fallback) },
    update(state, key) {
      if (key.name === 'enter') return { done: state.value };
      if (key.name === 'y' || key.name === 'Y') return { done: true };
      if (key.name === 'n' || key.name === 'N') return { done: false };
      if (['left', 'right', 'tab', 'shift-tab', 'h', 'l', 'space', 'up', 'down', 'k', 'j'].includes(key.name)) return { state: { value: !state.value } };
      return { state };
    },
    view(state, theme) {
      const focus = state.value ? 0 : 1;
      const list = optionList(options.map((option, index) => optionBlock(theme, { focused: index === focus, label: option.label, detail: option.detail })), focus);
      const lead = [...details, ...(details.length ? [''] : [])];
      return {
        body: [...lead, ...list.body],
        focusLine: lead.length + list.focusLine,
        focusSpan: list.focusSpan,
        hints: [MOVE_HINT(theme), 'y/n', 'Enter confirm', 'Esc cancel'],
      };
    },
  };
}

export function textModel(question, { fallback = '', validate, description } = {}) {
  const chars = [...String(fallback)];
  return {
    question,
    init: { chars, cursor: chars.length, error: null },
    update(state, key) {
      const { chars: value, cursor } = state;
      if (key.name === 'enter') {
        const answer = value.join('').trim() || String(fallback);
        const problem = validate?.(answer);
        return problem ? { state: { ...state, error: problem } } : { done: answer };
      }
      const edit = (next, at) => ({ state: { chars: next, cursor: at, error: null } });
      switch (key.name) {
        case 'left': return edit(value, Math.max(0, cursor - 1));
        case 'right': return edit(value, Math.min(value.length, cursor + 1));
        case 'home': case 'ctrl-a': return edit(value, 0);
        case 'end': case 'ctrl-e': return edit(value, value.length);
        case 'backspace': return cursor ? edit([...value.slice(0, cursor - 1), ...value.slice(cursor)], cursor - 1) : { state };
        case 'delete': return edit([...value.slice(0, cursor), ...value.slice(cursor + 1)], cursor);
        case 'ctrl-u': return edit(value.slice(cursor), 0);
        case 'ctrl-w': {
          const head = value.slice(0, cursor).join('').replace(/\S+\s*$/, '');
          return edit([...head, ...value.slice(cursor)], [...head].length);
        }
        default:
          if (key.ch) return edit([...value.slice(0, cursor), key.ch, ...value.slice(cursor)], cursor + 1);
          return { state };
      }
    },
    view(state, theme) {
      const before = state.chars.slice(0, state.cursor).join('');
      const at = state.chars[state.cursor] ?? ' ';
      const after = state.chars.slice(state.cursor + 1).join('');
      // The real cursor is hidden while a screen is up, so the caret is drawn.
      const caret = theme.colour ? style.inverse(theme, at) : (at === ' ' ? '_' : at);
      return {
        body: [`  ${style.accent(theme, theme.g.cursor)} ${before}${caret}${after}`],
        description,
        error: state.error,
        hints: ['Enter save', 'Ctrl-U clear', 'Esc cancel'],
      };
    },
  };
}

// Each line clears whatever an earlier frame left to its right -- except a
// line that already fills the row. After a character lands in the last
// column the terminal is waiting to wrap, and erase-to-end-of-line from there
// clears that last cell in xterm, VTE and Windows Terminal: the title bar and
// the rule under the screen would lose their final column. A full line has
// nothing to its right to clear, so it gets no erase at all.
export function eraseRest(line, width) {
  return visibleLength(line) >= width ? line : `${line}\x1b[K`;
}

// One readline interface per session rather than per question: opening a new
// one for each prompt loses buffered input and, on Windows, can drop the first
// keypress of the next question.
export function createPrompter({ input = process.stdin, output = process.stdout, env = process.env, platform = process.platform, release, title = 'Gatewright' } = {}) {
  const theme = createTheme({ output, env, platform, release });
  const rich = supportsRich({ input, output, env, platform, release });
  let rl = null;
  let ended = null;
  const ABORT = Symbol('aborted');
  const open = () => {
    if (!rl) {
      // terminal mode is decided by whether the input can actually do raw
      // mode, not by isTTY alone. readline in terminal mode does its own line
      // editing and echo, and driving that against a stream that only claims
      // to be a TTY makes it consume a whole buffer as a single line. A real
      // terminal has setRawMode; a pipe or a test double does not.
      const terminal = typeof input.setRawMode === 'function';
      rl = createInterface({ input, output, terminal });
      // question() on an input that has already ended never settles, so
      // waiting on it alone means Ctrl-D, a closed pipe, or a terminal that
      // went away hangs the command forever rather than cancelling it. Race
      // every question against the interface closing.
      ended = new Promise((resolve) => rl.once('close', () => resolve(ABORT)));
      // Ctrl-C during a prompt should cancel the command, not leave a
      // half-answered wizard attached to a dead terminal.
      rl.on('SIGINT', () => rl.close());
    }
    return rl;
  };

  async function ask(question) {
    const answer = await Promise.race([open().question(question), ended]);
    if (answer === ABORT || answer === null || answer === undefined) throw new AbortedError();
    return answer.trim();
  }

  // The rich session. It is entered on the first screen and left by close():
  // raw mode on, the alternate screen buffer (so the user's scrollback is
  // exactly as it was when the wizard ends), and a hidden cursor. Every exit
  // path -- a finished screen, Esc, Ctrl-C, EOF, an exception inside a model,
  // a SIGINT/SIGTERM from outside, or process exit -- runs leave().
  let session = null;
  let active = null;
  let inputEnded = false;

  const write = (text) => { try { output.write(text); } catch { /* a closed terminal cannot be restored */ } };

  function draw() {
    if (!active) return;
    const view = active.model.view(active.state, theme);
    const lines = renderScreen(theme, { title, question: active.model.question, ...active.meta, ...view, hints: view.hints });
    write(`\x1b[H${lines.map((line) => eraseRest(line, theme.width)).join('\r\n')}\x1b[J`);
  }

  function settle(error, value) {
    const current = active;
    if (!current) return;
    active = null;
    error ? current.reject(error) : current.resolve(value);
  }

  function press(key) {
    if (!active) return;
    if (key.name === 'ctrl-c' || key.name === 'ctrl-d') return settle(new AbortedError('interrupt'));
    if (key.name === 'escape') return settle(new AbortedError('escape'));
    let result;
    try { result = active.model.update(active.state, key); } catch (error) { return settle(error); }
    if (result.cancel) return settle(new AbortedError(result.cancel));
    if (Object.hasOwn(result, 'done')) return settle(null, result.done);
    active.state = result.state;
    draw();
  }

  function enter() {
    if (session) return;
    const onData = (chunk) => { for (const key of parseKeys(chunk)) press(key); };
    const onEnd = () => { inputEnded = true; settle(new AbortedError('eof')); };
    const onExit = () => leave();
    // A signal from outside (kill, a closing terminal) arrives here rather
    // than as a keypress, because raw mode turns off the tty's own ISIG. The
    // terminal is put back before the process goes.
    const onSignal = (signal) => { leave(); process.exit(signal === 'SIGTERM' ? 143 : 130); };
    session = { onData, onEnd, onExit, onSignal };
    input.setRawMode(true);
    input.on('data', onData);
    input.on('end', onEnd);
    input.on('close', onEnd);
    process.on('exit', onExit);
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    output.on?.('resize', draw);
    input.resume?.();
    write('\x1b[?1049h\x1b[?25l\x1b[H\x1b[2J');
  }

  function leave() {
    if (!session) return;
    const { onData, onEnd, onExit, onSignal } = session;
    session = null;
    settle(new AbortedError('interrupt'));
    input.removeListener('data', onData);
    input.removeListener('end', onEnd);
    input.removeListener('close', onEnd);
    process.removeListener('exit', onExit);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    output.removeListener?.('resize', draw);
    try { input.setRawMode(false); } catch { /* the terminal may already be gone */ }
    input.pause?.();
    write('\x1b[?25h\x1b[?1049l');
  }

  function show(model, meta = {}) {
    if (inputEnded) return Promise.reject(new AbortedError('eof'));
    try { enter(); } catch (error) { leave(); return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      active = { model, state: model.init, meta, resolve, reject };
      draw();
    });
  }

  const screenMeta = ({ step, intro, explain, warning } = {}) => ({ step, intro, explain, warning });

  return {
    rich: () => rich,
    theme: () => theme,

    // A custom full-screen model (the settings list in `gw config` is one).
    // Resolves to null in plain mode, where the caller keeps its line prompts.
    screen(model, meta) { return rich ? show(model, meta) : Promise.resolve(null); },

    // A boxed summary printed to the normal screen after the session ends.
    // It is sized to its content but never wider than the terminal; long
    // lines wrap inside the border (continuations keep the line's indent)
    // rather than being cut. A line may be { text, tone } to colour it;
    // colour is applied after wrapping so no escape spans a border.
    panel(heading, lines) {
      const { g } = theme;
      const items = lines.map((line) => (typeof line === 'string' ? { text: line } : line));
      const natural = Math.max(visibleLength(heading) + 6, ...items.map((item) => visibleLength(item.text) + 4));
      const width = Math.min(theme.width, natural);
      const inner = width - 4;
      const rows = [];
      for (const { text, tone } of items) {
        for (const part of wrapHanging(text, inner)) {
          const shown = clip(part, inner, theme);
          const pad = ' '.repeat(Math.max(0, inner - visibleLength(shown)));
          rows.push(`${g.v} ${tone ? style[tone](theme, shown) : shown}${pad} ${g.v}`);
        }
      }
      const title = clip(heading, inner - 2, theme);
      const top = `${g.tl}${g.rule} ${style.bold(theme, title)} ${g.rule.repeat(Math.max(0, width - visibleLength(title) - 5))}${g.tr}`;
      write(`\n${[top, ...rows, `${g.bl}${g.rule.repeat(width - 2)}${g.br}`].join('\n')}\n`);
    },

    async text(question, { fallback = '', validate, description, ...meta } = {}) {
      if (rich) return show(textModel(question, { fallback, validate, description }), screenMeta(meta));
      for (;;) {
        const shown = fallback ? `${question} [${fallback}]: ` : `${question}: `;
        const answer = (await ask(shown)) || fallback;
        const problem = validate?.(answer);
        if (!problem) return answer;
        write(`  ${problem}\n`);
      }
    },

    async confirm(question, { fallback = true, details, yes, no, ...meta } = {}) {
      if (rich) return show(confirmModel(question, { fallback, details, yes, no }), screenMeta(meta));
      for (;;) {
        const answer = (await ask(`${question} ${fallback ? '[Y/n]' : '[y/N]'}: `)).toLowerCase();
        if (!answer) return fallback;
        if (['y', 'yes'].includes(answer)) return true;
        if (['n', 'no'].includes(answer)) return false;
        write('  Answer y or n.\n');
      }
    },

    // In plain mode choices are numbered rather than arrow-key driven on
    // purpose: a number is typeable over ssh, in a mangled terminal, and on
    // Windows conhost without any raw-mode key handling.
    async select(question, choices, { fallback = 0, ...meta } = {}) {
      if (rich) return show(selectModel(question, choices, { fallback }), screenMeta(meta));
      write(`${question}\n`);
      choices.forEach((choice, index) => {
        write(`  ${index + 1}) ${choice.label}\n`);
        if (choice.detail) write(`     ${choice.detail}\n`);
      });
      for (;;) {
        const answer = await ask(`  choose 1-${choices.length} [${fallback + 1}]: `);
        if (!answer) return choices[fallback].value;
        const index = Number(answer) - 1;
        if (Number.isInteger(index) && index >= 0 && index < choices.length) return choices[index].value;
        write(`  Enter a number from 1 to ${choices.length}.\n`);
      }
    },

    // Resolves to the values of the checked choices. Plain mode asks one y/n
    // per choice, which is the same decision without needing Space.
    async multiselect(question, choices, meta = {}) {
      if (rich) return show(multiSelectModel(question, choices), screenMeta(meta));
      write(`${question}\n`);
      const picked = [];
      for (const choice of choices) {
        if (choice.locked || await this.confirm(`  ${choice.label}?`, { fallback: Boolean(choice.checked) })) picked.push(choice.value);
      }
      return picked;
    },

    close() {
      leave();
      rl?.close();
      rl = null;
    },
  };
}
