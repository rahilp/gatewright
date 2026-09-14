import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { readConfig, readStages } from '../config.js';
import { injectData } from '../viewer/inject.js';

export const spec = {
  summary: 'write a board snapshot and open it',
  flags: { 'no-browser': { type: 'boolean' } },
  positionals: [],
};

const OPENERS = { darwin: 'open', win32: 'start' };

function openInBrowser(path) {
  const platform = process.platform;
  const cmd = OPENERS[platform] || 'xdg-open';
  const args = platform === 'win32' ? ['', '', path] : [path];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore', shell: platform === 'win32' }).unref();
  } catch {
    // Best effort: the snapshot is already on disk even if no browser could be launched.
  }
}

export function run(ctx) {
  const { store, flags, stdout } = ctx;
  const shell = readFileSync(new URL('../../viewer/board.html', import.meta.url), 'utf8');
  const html = injectData(shell, {
    items: store.readItems(),
    events: store.readEvents(),
    stages: readStages(store),
    config: readConfig(store),
    generatedAt: new Date().toISOString(),
  });
  writeFileSync(store.paths.board, html);
  stdout.write(`${store.paths.board}\n`);
  if (!flags['no-browser']) openInBrowser(store.paths.board);
  return 0;
}
