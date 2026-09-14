// init — the one command that creates the root. It installs the shipped
// templates, writes the fenced agent-instruction block into AGENTS.md, and
// mirrors the block into the other agent instruction files only where the user
// is already in that tool's world: never a CLAUDE.md, .cursor/rules/, or
// .github/ file that was not there to invite it.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStore } from '../store.js';
import { readTemplate, upsertBlock } from '../templates.js';

export const spec = {
  summary: 'create .gatewright/ and the agent instruction block',
  flags: { force: { type: 'boolean' } },
  positionals: [],
  needsRoot: false,
};

// `file` is written when it exists; `parent` extends the invitation to a
// pre-existing parent directory (CLAUDE.md has no such escape hatch: creating
// it at a repo root is never invited by the root existing).
const BLOCK_TARGETS = [
  { file: 'CLAUDE.md', parent: null },
  { file: join('.cursor', 'rules', 'gatewright.mdc'), parent: join('.cursor', 'rules') },
  { file: join('.github', 'copilot-instructions.md'), parent: '.github' },
];

function upsertBlockIn(root, { file, parent }) {
  const path = join(root, file);
  if (!existsSync(path) && !(parent && existsSync(join(root, parent)))) return false;
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  writeFileSync(path, upsertBlock(text, readTemplate('agents-block.md')));
  return true;
}

export function run(ctx) {
  const { flags, stdout } = ctx;
  const root = process.cwd();
  const initialized = existsSync(join(root, '.gatewright'));

  if (initialized && !flags.force) {
    stdout.write('gw: .gatewright/ already exists — nothing changed. Run `gw init --force` to refresh the agent-instruction block.\n');
    return 0;
  }

  // Instruction files first: they are user-owned. A malformed AGENTS.md fails
  // here, before anything is created, so the repo is never half-initialized.
  const touched = [];
  const agentsPath = join(root, 'AGENTS.md');
  const agentsText = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8') : '';
  writeFileSync(agentsPath, upsertBlock(agentsText, readTemplate('agents-block.md')));
  touched.push('AGENTS.md');
  for (const target of BLOCK_TARGETS) {
    if (upsertBlockIn(root, target)) touched.push(target.file);
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
  writeFileSync(join(store.dir, 'prompt.md'), readTemplate('prompt.md'));
  stdout.write('gw: initialized .gatewright/\n');
  for (const file of touched) stdout.write(`gw: wrote the work-tracking block to ${file}\n`);
  stdout.write('Next: `gw add "<title>"` to add work, `gw open` to see the board.\n');
  return 0;
}
