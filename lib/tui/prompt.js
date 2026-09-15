// The interactive layer, and the only place this tool reads from stdin.
//
// Two rules hold everywhere here. First, zero dependencies: these are built on
// node:readline because a setup wizard is not worth a dependency tree in a
// package that promises not to have one. Second, and more important, nothing
// in gw may *require* a human. `gw init` is run by agents, by CI, and inside
// `npx` one-liners, and a prompt that blocks there is a hang with no
// explanation. So interactivity is opt-in by circumstance: a real TTY on both
// ends, no --yes, no CI marker. Everywhere else the caller's defaults are
// taken silently and the command behaves exactly as it did before this
// existed.
import { createInterface } from 'node:readline/promises';

// Thrown when the user aborts (Ctrl-C, Ctrl-D, or EOF). The caller catches it
// and leaves the filesystem untouched -- a half-written config is worse than
// no config, because the next run cannot tell the difference.
export class AbortedError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'AbortedError';
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

function render(output, text) {
  output.write(text);
}

// One readline interface per session rather than per question: opening a new
// one for each prompt loses buffered input and, on Windows, can drop the first
// keypress of the next question.
export function createPrompter({ input = process.stdin, output = process.stdout } = {}) {
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

  return {
    async text(question, { fallback = '', validate } = {}) {
      for (;;) {
        const shown = fallback ? `${question} [${fallback}]: ` : `${question}: `;
        const answer = (await ask(shown)) || fallback;
        const problem = validate?.(answer);
        if (!problem) return answer;
        render(output, `  ${problem}\n`);
      }
    },

    async confirm(question, { fallback = true } = {}) {
      for (;;) {
        const answer = (await ask(`${question} ${fallback ? '[Y/n]' : '[y/N]'}: `)).toLowerCase();
        if (!answer) return fallback;
        if (['y', 'yes'].includes(answer)) return true;
        if (['n', 'no'].includes(answer)) return false;
        render(output, '  Answer y or n.\n');
      }
    },

    // Choices are numbered rather than arrow-key driven on purpose: raw-mode
    // key handling is where cross-platform terminal code goes wrong, and a
    // number is typeable over ssh, in a mangled terminal, and on Windows
    // conhost without any of it.
    async select(question, choices, { fallback = 0 } = {}) {
      render(output, `${question}\n`);
      choices.forEach((choice, index) => {
        render(output, `  ${index + 1}) ${choice.label}\n`);
        if (choice.detail) render(output, `     ${choice.detail}\n`);
      });
      for (;;) {
        const answer = await ask(`  choose 1-${choices.length} [${fallback + 1}]: `);
        if (!answer) return choices[fallback].value;
        const index = Number(answer) - 1;
        if (Number.isInteger(index) && index >= 0 && index < choices.length) return choices[index].value;
        render(output, `  Enter a number from 1 to ${choices.length}.\n`);
      }
    },

    close() {
      rl?.close();
      rl = null;
    },
  };
}
