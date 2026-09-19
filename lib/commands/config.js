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
import { UsageError } from '../cli/errors.js';
import { readConfig } from '../config.js';
import { SETTINGS, SETTINGS_BY_KEY, FILE_ONLY, coerce, coerceSetting, getValue, setValue, parseGlossaryKey, applyGlossaryEntry, glossaryFieldError } from '../settings.js';
import { GLOSSARY_FIELDS, glossaryFor } from '../glossary.js';
import { AbortedError, createPrompter, isInteractive, tuiStyle } from '../tui/prompt.js';
import { persistConfigAndReleaseTriageHolds } from '../triage-policy.js';

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

// T-0043's list coercion (the bracketed form this command prints is accepted
// back and validated, not comma-split into garbage) lives in lib/settings.js
// as coerceList/coerceSetting -- the single implementation POST /api/config
// in lib/serve/server.js also goes through, so the CLI and the board cannot
// disagree about what a list setting accepts.

function persist(store, config, { previousConfig, actor }) {
  // Through store.writeConfig: it is the one config write path, atomic, and it
  // re-baselines the digest — a settings change gw itself performed must never
  // be reported by `gw check` as an out-of-band write.
  return store.withLock(() => persistConfigAndReleaseTriageHolds(store, { previousConfig, config, actor }));
}

function reportReleased(stdout, count) {
  if (count) stdout.write(`released ${count} triage hold${count === 1 ? '' : 's'} no longer required by policy\n`);
}

function listAll(config, stdout) {
  for (const setting of SETTINGS) {
    stdout.write(`${setting.key.padEnd(32)} ${display(getValue(config, setting.key))}\n`);
  }
  // Glossary entries are a map keyed by the user's own vocab, so they cannot
  // be declared in SETTINGS. Listing the ones that exist is still the only
  // way someone discovers the key form well enough to change one.
  for (const field of GLOSSARY_FIELDS) {
    for (const [code, description] of Object.entries(glossaryFor(config, field))) {
      stdout.write(`${`glossary.${field}.${code}`.padEnd(32)} ${display(description)}\n`);
    }
  }
  // The structures that have no key form say so here rather than not
  // existing: "unknown setting" must never be the answer for a key that is
  // really in config.json. The glossary is not listed again -- its entries
  // are already above, per code.
  const fileOnly = FILE_ONLY.filter((entry) => entry.key !== 'glossary');
  stdout.write(`not settable here (structures in .gatewright/config.json): ${fileOnly.map((entry) => entry.key).join(', ')}\n`);
  return 0;
}

// Reads and writes one `glossary.<field>.<code>` entry. Kept out of the
// SETTINGS path entirely: there is no type to coerce and no choices to check,
// only a field name that has to be a real vocab field so a typo cannot write
// a description nothing will ever read. The validation and the actual write
// both live in lib/settings.js (applyGlossaryEntry / glossaryFieldError), so
// `POST /api/config` in lib/serve/server.js goes through the identical
// checks and cannot legally accept something this command would refuse.
function glossaryEntry(ctx, config, previousConfig, target, value) {
  const { store, stdout } = ctx;
  const { field, code } = target;
  const key = `glossary.${field}.${code}`;
  if (value === undefined) {
    const error = glossaryFieldError(target);
    if (error) throw new UsageError(error);
    stdout.write(`${display(glossaryFor(config, field)[code])}\n`);
    return 0;
  }
  const result = applyGlossaryEntry(config, target, value);
  if (result.error) throw new UsageError(result.error);
  reportReleased(stdout, persist(store, config, { previousConfig, actor: ctx.actor }));
  stdout.write(result.removed ? `${key} removed\n` : `${key} = ${display(result.description)}\n`);
  if (result.warning) stdout.write(`${result.warning}\n`);
  return 0;
}

async function editClassic(ctx, config, previousConfig) {
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
          validate: (raw) => (raw === '' && !setting.allowEmpty ? 'enter at least one value' : coerceSetting(setting, raw).error),
        });
        next = coerceSetting(setting, answer).value;
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
    reportReleased(stdout, persist(store, config, { previousConfig, actor: ctx.actor }));
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

const SECTIONS = { runner: 'Runner', policy: 'Automation policy', guard: 'Commit guard', id_scheme: 'Board', brief: 'Brief', check: 'Health checks', memory: 'Memory', github: 'GitHub', vocab: 'Vocabulary' };
function sectionFor(key) { return SECTIONS[key.split('.')[0]] ?? key.split('.')[0]; }

function compact(value, width = 34) {
  const shown = value === undefined ? '(unset)' : Array.isArray(value) ? value.join(', ') || '(none)' : typeof value === 'boolean' ? (value ? 'on' : 'off') : String(value);
  return shown.length > width ? `${shown.slice(0, width - 1)}…` : shown;
}

function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

function changedSettings(config, previousConfig) {
  return SETTINGS.filter((setting) => !same(getValue(config, setting.key), getValue(previousConfig, setting.key)));
}

// The settings screen: every setting grouped by section with its current
// value, a marker on the ones changed this session, and the focused one's
// summary (and danger note) underneath. Enter opens one setting's editor; s
// reviews and saves; q or Esc leaves. Nothing is written until the review is
// confirmed, which keeps "cancel" a promise rather than a hope.
function settingsModel(config, previousConfig, focus) {
  const keyWidth = Math.max(...SETTINGS.map((setting) => setting.key.length)) + 2;
  return {
    question: null,
    init: { focus },
    update(state, key) {
      if (key.name === 'enter' || key.name === 'space' || key.name === 'right' || key.name === 'l') return { done: { action: 'edit', focus: state.focus } };
      if (key.name === 's' || key.name === 'S') return { done: { action: 'save', focus: state.focus } };
      if (key.name === 'q' || key.name === 'Q') return { done: { action: 'quit', focus: state.focus } };
      const count = SETTINGS.length;
      const moves = { up: -1, k: -1, down: 1, j: 1, pageup: -8, pagedown: 8 };
      if (key.name in moves) {
        const next = state.focus + moves[key.name];
        return { state: { focus: Math.abs(moves[key.name]) === 1 ? (next + count) % count : Math.min(count - 1, Math.max(0, next)) } };
      }
      if (key.name === 'home' || key.name === 'g') return { state: { focus: 0 } };
      if (key.name === 'end' || key.name === 'G') return { state: { focus: count - 1 } };
      return { state };
    },
    view(state, theme) {
      const body = [];
      let focusLine = 0;
      let section = null;
      SETTINGS.forEach((setting, index) => {
        if (sectionFor(setting.key) !== section) {
          section = sectionFor(setting.key);
          if (body.length) body.push('');
          body.push(`  ${tuiStyle.bold(theme, section.toUpperCase())}`);
        }
        const value = getValue(config, setting.key);
        const changed = !same(value, getValue(previousConfig, setting.key));
        const mark = changed ? tuiStyle.warn(theme, '*') : ' ';
        const shown = changed ? tuiStyle.warn(theme, compact(value)) : typeof value === 'boolean' ? (value ? tuiStyle.good(theme, compact(value)) : tuiStyle.dim(theme, compact(value))) : compact(value);
        if (index === state.focus) {
          focusLine = body.length;
          body.push(`${tuiStyle.accent(theme, theme.g.cursor)}${mark}${tuiStyle.accent(theme, setting.key.padEnd(keyWidth))}${shown}`);
        } else {
          body.push(` ${mark}${setting.key.padEnd(keyWidth)}${shown}`);
        }
      });
      const setting = SETTINGS[state.focus];
      const pending = changedSettings(config, previousConfig).length;
      return {
        body,
        focusLine,
        description: setting.summary,
        warning: setting.danger,
        hints: [`${theme.g.up}${theme.g.down} move`, 'Enter edit', pending ? `s save ${pending} change${pending === 1 ? '' : 's'}` : 's save', 'q quit'],
      };
    },
  };
}

// One setting's editor, as its own screen. Esc here means "back to the list"
// rather than "abandon everything": the list is where a user decides that.
async function editOne(prompter, setting, config) {
  const current = getValue(config, setting.key);
  const choices = choicesFor(setting, config);
  const meta = { step: sectionFor(setting.key), warning: setting.danger, description: setting.summary };
  let next;
  if (setting.type === 'boolean') {
    next = await prompter.select(setting.key, [
      { value: true, label: 'On', detail: setting.summary },
      { value: false, label: 'Off', detail: setting.summary },
    ], { ...meta, fallback: current === true ? 0 : 1 });
  } else if (choices?.length) {
    next = await prompter.select(setting.key, choices.map((choice) => ({ label: choice, value: choice, detail: setting.summary })), { ...meta, fallback: Math.max(0, choices.indexOf(current)) });
  } else if (setting.type === 'list') {
    const answer = await prompter.text(`${setting.key} (comma-separated${setting.allowEmpty ? '; none for empty' : ''})`, {
      ...meta,
      fallback: Array.isArray(current) ? current.join(', ') : '',
      validate: (raw) => (raw === '' && !setting.allowEmpty ? 'enter at least one value' : coerceSetting(setting, raw).error),
    });
    next = coerceSetting(setting, answer).value;
  } else {
    const range = setting.type === 'integer' ? ` (${setting.min}–${setting.max})` : '';
    const answer = await prompter.text(`${setting.key}${range}`, {
      ...meta,
      fallback: current === undefined ? '' : String(current),
      validate: (raw) => (raw === '' ? 'enter a value' : coerce(setting, raw).error),
    });
    next = coerce(setting, answer).value;
  }
  setValue(config, setting.key, next);
}

// Runs inside the full-screen session and returns what happened; the caller
// prints the outcome after the session has handed the normal screen back.
async function settingsScreen(prompter, config, previousConfig) {
  let focus = 0;
  for (;;) {
    const choice = await prompter.screen(settingsModel(config, previousConfig, focus), { title: 'gw config', step: 'Settings' });
    focus = choice.focus;
    const changes = changedSettings(config, previousConfig);
    if (choice.action === 'edit') {
      try { await editOne(prompter, SETTINGS[focus], config); } catch (error) {
        if (!(error instanceof AbortedError) || error.reason !== 'escape') throw error;
      }
      continue;
    }
    if (choice.action === 'quit') {
      if (!changes.length) return { saved: false, changes };
      const discard = await prompter.confirm(`Discard ${changes.length} unsaved change${changes.length === 1 ? '' : 's'}?`, { fallback: false, step: 'Settings' }).catch(backOnEscape);
      if (discard) return { saved: false, changes };
      continue;
    }
    if (!changes.length) return { saved: false, changes };
    const arrow = ` ${prompter.theme().g.right} `;
    const details = changes.map((setting) => `  ${setting.key}: ${compact(getValue(previousConfig, setting.key))}${arrow}${compact(getValue(config, setting.key))}`);
    const save = await prompter.confirm(`Save ${changes.length} change${changes.length === 1 ? '' : 's'} to .gatewright/config.json?`, { fallback: true, details, step: 'Review' }).catch(backOnEscape);
    if (save) return { saved: true, changes };
  }
}

function backOnEscape(error) {
  if (error instanceof AbortedError && error.reason === 'escape') return false;
  throw error;
}

async function editRich(ctx, config, previousConfig, prompter) {
  const { store, stdout } = ctx;
  let outcome;
  try {
    outcome = await settingsScreen(prompter, config, previousConfig);
  } catch (error) {
    prompter.close();
    if (error instanceof AbortedError) {
      stdout.write('Cancelled; nothing was changed.\n');
      return 1;
    }
    throw error;
  }
  prompter.close();
  if (!outcome.saved) {
    stdout.write(outcome.changes.length ? 'Discarded; nothing was changed.\n' : 'No changes.\n');
    return 0;
  }
  reportReleased(stdout, persist(store, config, { previousConfig, actor: ctx.actor }));
  for (const setting of outcome.changes) stdout.write(`${setting.key} = ${display(getValue(config, setting.key))}\n`);
  stdout.write('Saved to .gatewright/config.json.\n');
  if (outcome.changes.some((setting) => setting.key.startsWith('runner.'))) stdout.write('Restart `gw serve` for the scheduler change to take effect.\n');
  return 0;
}

async function edit(ctx, config, previousConfig) {
  const prompter = createPrompter({ input: ctx.stdin, output: ctx.stdout, env: ctx.env ?? process.env, title: 'gw config' });
  if (!prompter.rich()) return editClassic(ctx, config, previousConfig);
  try { return await editRich(ctx, config, previousConfig, prompter); } finally { prompter.close(); }
}

export async function run(ctx) {
  const { store, flags, positionals, stdout } = ctx;
  const config = readConfig(store);
  const previousConfig = structuredClone(config);
  const [key, value] = positionals;

  if (flags.list || (!key && !isInteractive({ flags, env: ctx.env, input: ctx.stdin, output: stdout }))) {
    return listAll(config, stdout);
  }
  if (!key) return edit(ctx, config, previousConfig);

  const glossaryTarget = parseGlossaryKey(key);
  if (glossaryTarget) return glossaryEntry(ctx, config, previousConfig, glossaryTarget, value);

  const setting = SETTINGS_BY_KEY.get(key);
  if (!setting) {
    throw new UsageError(`unknown setting: ${key}\nrun \`gw config --list\` to see every settable key, or set a description with \`gw config glossary.<field>.<code> "..."\`.`);
  }
  if (value === undefined) {
    stdout.write(`${display(getValue(config, key))}\n`);
    return 0;
  }
  const result = coerceSetting(setting, value);
  if (result.error) throw new UsageError(result.error);
  const choices = choicesFor(setting, config);
  if (choices?.length && !choices.includes(result.value)) {
    throw new UsageError(`${key} must be one of: ${choices.join(', ')}`);
  }
  setValue(config, key, result.value);
  reportReleased(stdout, persist(store, config, { previousConfig, actor: ctx.actor }));
  stdout.write(`${key} = ${display(result.value)}\n`);
  if (key === 'runner.enabled' && result.value === true) {
    stdout.write('Restart `gw serve` for the scheduler to pick this up.\n');
  }
  return 0;
}
