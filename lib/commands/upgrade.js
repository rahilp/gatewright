// upgrade — bring an existing install up to the current package: a fresh board
// snapshot from the pinned shell and a refreshed AGENTS.md block. The data —
// items, events, stages, config, and the user's prompt template — is never
// touched; `--templates` is the explicit, loud exception for prompt.md.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readConfig, readStages } from '../config.js';
import { injectData } from '../viewer/inject.js';
import { readTemplate, upsertBlock } from '../templates.js';

export const spec = {
  summary: 'replace the viewer shell and the instruction block, never the data',
  flags: { templates: { type: 'boolean' } },
  positionals: [],
};

export function run(ctx) {
  const { store, flags, stdout } = ctx;

  // The installed board is the pinned shell with the current data injected, so
  // replacing the shell means regenerating that snapshot, not copying the
  // shell over it.
  const shell = readFileSync(new URL('../../viewer/board.html', import.meta.url), 'utf8');
  const html = injectData(shell, {
    items: store.readItems(),
    events: store.readEvents(),
    stages: readStages(store),
    config: readConfig(store),
    generatedAt: new Date().toISOString(),
  });
  writeFileSync(store.paths.board, html);
  const header = shell.match(/^<!--\s*(.+?)\s*-->/);
  stdout.write(`gw: replaced ${store.paths.board} with the current viewer shell${header ? ` (${header[1]})` : ''}\n`);

  const agentsPath = join(store.root, 'AGENTS.md');
  const agentsText = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8') : '';
  writeFileSync(agentsPath, upsertBlock(agentsText, readTemplate('agents-block.md')));
  stdout.write('gw: refreshed the work-tracking block in AGENTS.md\n');

  if (flags.templates) {
    writeFileSync(join(store.dir, 'prompt.md'), readTemplate('prompt.md'));
    stdout.write('gw: prompt.md REPLACED with the shipped default — your edits to the template were overwritten\n');
  }
  stdout.write('gw: data files were not touched\n');
  return 0;
}
