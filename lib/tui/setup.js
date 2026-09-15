// The `gw init` walkthrough.
//
// A tracker whose defaults do not match how you work is worse than no tracker,
// because it reports things that are not true. The shipped pipeline assumes
// pull requests; a repo that commits to main cannot legitimately advance past
// `built`, so finished work piles up there and `gw brief` reports all of it as
// still in flight. That is not a bug a new user can diagnose, so this asks
// once, at the only moment the answer is cheap to act on.
//
// Everything here is skipped unless a real terminal is present. See
// lib/tui/prompt.js: init runs inside agents, CI and npx one-liners, and a
// prompt there is a hang with nothing to explain it.
import { readFileSync, writeFileSync } from 'node:fs';
import { AbortedError, createPrompter } from './prompt.js';
import { coerce } from '../settings.js';

// Truncating the shipped pipeline rather than defining a second one keeps
// stage ids, labels and exit rules identical across both shapes, so a board
// can be moved from one to the other by editing the pipeline alone.
export function trunkStages(shipped) {
  const cut = shipped.stages.findIndex((stage) => stage.id === 'built');
  const stages = shipped.stages.slice(0, cut + 1).map((stage) => ({ ...stage }));
  const last = stages.at(-1);
  last.role = 'done';
  last.exit = 'Evidence recorded: commit and test path. This is the finish line.';
  return {
    ...shipped,
    stages,
    // `built` is terminal through its role, so naming it here too would be a
    // second place to keep in step for no gain.
    terminal: (shipped.terminal ?? []).filter((id) => id === 'dropped'),
  };
}

const WORKFLOWS = [
  {
    value: 'trunk',
    label: 'Commit straight to main',
    detail: 'Backlog → Specified → Building → Built. Built is the finish line.',
  },
  {
    value: 'review',
    label: 'Work through pull requests',
    detail: 'Adds In review → Reviewed → Merged → Verified. Advancing past Built needs a PR URL as evidence.',
  },
];

const ID_SCHEMES = [
  { value: 'phase-seq', label: 'Grouped by phase', detail: 'P1-01, P1-02, P2-01. Needs a phase on every item.' },
  { value: 'seq', label: 'One running sequence', detail: 'T-0001, T-0002. No phases to maintain.' },
];

export async function runSetup({ store, stdout, stdin, shippedStages }) {
  const prompter = createPrompter({ input: stdin, output: stdout });
  const config = JSON.parse(readFileSync(store.paths.config, 'utf8'));
  let stages = shippedStages;

  try {
    stdout.write('\nA few questions so the board matches how you work.\n');
    stdout.write('Press enter to take the default; everything here is changeable later with `gw config`.\n\n');

    const workflow = await prompter.select('How does work reach main?', WORKFLOWS, { fallback: 0 });
    if (workflow === 'trunk') stages = trunkStages(shippedStages);

    const scheme = await prompter.select('\nHow should items be numbered?', ID_SCHEMES, { fallback: 0 });
    config.id_scheme = scheme;

    if (scheme === 'phase-seq') {
      const setting = { key: 'vocab.phase', type: 'list' };
      const answer = await prompter.text('\nWhich phases? (comma-separated)', {
        fallback: (config.vocab?.phase ?? []).join(', '),
        validate: (raw) => coerce(setting, raw).error,
      });
      config.vocab = { ...config.vocab, phase: coerce(setting, answer).value };
    }

    // Defaulting to "no" is the whole safety posture, not a preference: the
    // runner spawns real processes that cost real money, and someone running
    // `gw init` to look around should never end up with that armed.
    stdout.write('\nThe runner lets the board start agent runs on this machine.\n');
    const enableRunner = await prompter.confirm('Enable it now?', { fallback: false });
    config.runner = { ...config.runner, enabled: enableRunner };
    if (enableRunner) {
      const providers = Object.keys(config.runner?.providers ?? {});
      if (providers.length) {
        config.runner.provider = await prompter.select('  Which provider?', providers.map((name) => ({ label: name, value: name })), {
          fallback: Math.max(0, providers.indexOf(config.runner?.provider)),
        });
      }
      stdout.write(`  The runner will invoke: ${(config.runner.providers?.[config.runner.provider]?.cmd ?? []).join(' ')}\n`);
      stdout.write('  Nothing runs until an item is dispatched, and `gw stop --all` stops everything.\n');
    }

    writeFileSync(store.paths.config, `${JSON.stringify(config, null, 2)}\n`);
    writeFileSync(store.paths.stages, `${JSON.stringify(stages, null, 2)}\n`);
    stdout.write('\ngw: saved your answers to .gatewright/config.json and stages.json\n');
    return { completed: true, workflow, scheme, runner: enableRunner };
  } catch (error) {
    if (error instanceof AbortedError) {
      // The shipped templates are already on disk and are a working board, so
      // an abort leaves something usable rather than a half-configured root.
      stdout.write('\ngw: setup cancelled — the defaults are in place. Run `gw config` to change them.\n');
      return { completed: false };
    }
    throw error;
  } finally {
    prompter.close();
  }
}
