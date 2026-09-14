// init — the one command that creates the root. It installs the shipped
// templates, writes the fenced agent-instruction block into AGENTS.md, and
// mirrors the block into the other agent instruction files only where the user
// is already in that tool's world: never a CLAUDE.md, .cursor/rules/, or
// .github/ file that was not there to invite it.
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStore } from '../store.js';
import { BLOCK_TARGETS, readTemplate, upsertBlockFile } from '../templates.js';

export const spec = {
  summary: 'create .gatewright/ and the agent instruction block',
  flags: { force: { type: 'boolean' } },
  positionals: [],
  needsRoot: false,
};

export function run(ctx) {
  const { flags, cwd, stdout } = ctx;
  const root = cwd;
  const initialized = existsSync(join(root, '.gatewright'));

  if (initialized && !flags.force) {
    stdout.write('gw: .gatewright/ already exists — nothing changed. Run `gw init --force` to refresh the agent-instruction block.\n');
    return 0;
  }

  // Instruction files first: they are user-owned. A malformed AGENTS.md fails
  // here, before anything is created, so the repo is never half-initialized.
  const touched = [];
  upsertBlockFile(join(root, 'AGENTS.md'));
  touched.push('AGENTS.md');
  for (const target of BLOCK_TARGETS) {
    const path = join(root, target.file);
    if (existsSync(path) || (target.parent && existsSync(join(root, target.parent)))) {
      upsertBlockFile(path);
      touched.push(target.file);
    }
  }

  if (initialized) {
    for (const file of touched) stdout.write(`gw: refreshed the work-tracking block in ${file}\n`);
    stdout.write('gw: data files in .gatewright/ were not touched\n');
    return 0;
  }

  const store = createStore(root);
  store.ensure();
  writeFileSync(store.paths.stages, readTemplate('stages.json'));
  writeFileSync(store.paths.config, readTemplate('config.json'));
  writeFileSync(store.paths.prompt, readTemplate('prompt.md'));
  stdout.write('gw: initialized .gatewright/\n');
  for (const file of touched) stdout.write(`gw: wrote the work-tracking block to ${file}\n`);
  stdout.write('Next: `gw add "<title>"` to add work, `gw open` to see the board.\n');
  return 0;
}
