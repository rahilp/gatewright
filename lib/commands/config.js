// config — read and change settings without hand-editing .gatewright/.
//
// This command exists because the tool told people two contradictory things:
// every `gw brief` ends with "Never edit .gatewright/ by hand", while the only
// documented way to enable the runner was to hand-edit
// .gatewright/config.json. One of those had to give, and it should not be the
// rule that keeps the board's integrity checkable.
//
// Scripted and interactive forms are the same code path deliberately. An agent
// runs `gw config runner.enabled true`; a human runs `gw config` and is walked
// through it. Neither is a second-class citizen, and neither can set something
// the other could not.
import { writeFileSync } from 'node:fs';
import { UsageError } from '../cli/errors.js';
import { readConfig } from '../config.js';
import { SETTINGS, SETTINGS_BY_KEY, coerce, getValue, setValue } from '../settings.js';
import { AbortedError, createPrompter, isInteractive } from '../tui/prompt.js';

export const spec = {
  summary: 'show or change settings',
  flags: { list: { type: 'boolean' }, yes: { type: 'boolean' }, 'no-input': { type: 'boolean' } },
  positionals: [{ name: 'key' }, { name: 'value' }],
};

function display(value) {
  return value === undefined ? '(unset)' : JSON.stringify(value);
}

function choicesFor(setting, config) {
  return setting.choices ?? setting.choicesFrom?.(config) ?? null;
}

function persist(store, config) {
  // Through withLock like every other write: `gw serve`'s scheduler reads this
  // file, and a torn config read is the kind of failure that looks like a bug
  // in something else entirely.
  store.withLock(() => {
    writeFileSync(store.paths.config, `${JSON.stringify(config, null, 2)}\n`);
  });
}

function listAll(config, stdout) {
  for (const setting of SETTINGS) {
    stdout.write(`${setting.key.padEnd(32)} ${display(getValue(config, setting.key))}\n`);
  }
  return 0;
}

async function edit(ctx, config) {
  const { store, stdout } = ctx;
  const prompter = createPrompter({ input: ctx.stdin, output: stdout });
  try {
    stdout.write('gw config — press enter to keep the current value.\n\n');
    for (const setting of SETTINGS) {
      const current = getValue(config, setting.key);
      stdout.write(`${setting.key}\n  ${setting.summary}\n`);
      if (setting.danger) stdout.write(`  ${setting.danger}\n`);
      const choices = choicesFor(setting, config);
      let next;
      if (setting.type === 'boolean') {
        next = await prompter.confirm('  enable?', { fallback: current === true });
      } else if (choices?.length) {
        next = await prompter.select('  choose:', choices.map((choice) => ({ label: choice, value: choice })), {
          fallback: Math.max(0, choices.indexOf(current)),
        });
      } else if (setting.type === 'list') {
        const answer = await prompter.text('  values (comma-separated)', {
          fallback: Array.isArray(current) ? current.join(', ') : '',
          validate: (raw) => (raw === '' ? 'enter at least one value' : coerce(setting, raw).error),
        });
        next = coerce(setting, answer).value;
      } else {
        const answer = await prompter.text('  value', {
          fallback: current === undefined ? '' : String(current),
          validate: (raw) => (raw === '' ? 'enter a value' : coerce(setting, raw).error),
        });
        next = coerce(setting, answer).value;
      }
      setValue(config, setting.key, next);
      stdout.write('\n');
    }
    persist(store, config);
    stdout.write('Saved to .gatewright/config.json.\n');
    if (getValue(config, 'runner.enabled') === true) {
      stdout.write('Restart `gw serve` for the scheduler change to take effect.\n');
    }
    return 0;
  } catch (error) {
    if (error instanceof AbortedError) {
      // Nothing has been written at this point, so saying so is a fact rather
      // than a reassurance.
      stdout.write('\nCancelled; nothing was changed.\n');
      return 1;
    }
    throw error;
  } finally {
    prompter.close();
  }
}

export async function run(ctx) {
  const { store, flags, positionals, stdout } = ctx;
  const config = readConfig(store);
  const [key, value] = positionals;

  if (flags.list || (!key && !isInteractive({ flags, env: ctx.env, input: ctx.stdin, output: stdout }))) {
    return listAll(config, stdout);
  }
  if (!key) return edit(ctx, config);

  const setting = SETTINGS_BY_KEY.get(key);
  if (!setting) {
    throw new UsageError(`unknown setting: ${key}\nrun \`gw config --list\` to see every settable key.`);
  }
  if (value === undefined) {
    stdout.write(`${display(getValue(config, key))}\n`);
    return 0;
  }
  const result = coerce(setting, value);
  if (result.error) throw new UsageError(result.error);
  const choices = choicesFor(setting, config);
  if (choices?.length && !choices.includes(result.value)) {
    throw new UsageError(`${key} must be one of: ${choices.join(', ')}`);
  }
  setValue(config, key, result.value);
  persist(store, config);
  stdout.write(`${key} = ${display(result.value)}\n`);
  if (key === 'runner.enabled' && result.value === true) {
    stdout.write('Restart `gw serve` for the scheduler to pick this up.\n');
  }
  return 0;
}
