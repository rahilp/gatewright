import { existsSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { readConfig, readStages } from '../config.js';
import { injectData } from '../viewer/inject.js';

export const spec = {
  summary: 'write a board snapshot and open it',
  flags: { 'no-browser': { type: 'boolean' }, watch: { type: 'boolean' } },
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

function snapshot(store) {
  const shell = readFileSync(new URL('../../viewer/board.html', import.meta.url), 'utf8');
  const items = store.readItems();
  const html = injectData(shell, {
    items,
    events: store.readEvents(),
    stages: readStages(store),
    config: readConfig(store),
    generatedAt: new Date().toISOString(),
  });
  return { html, items };
}

function itemCountLabel(count) {
  return `${count} item${count === 1 ? '' : 's'}`;
}

function changeSummary(previous, current) {
  const changes = [];
  const before = new Map(previous.map((item) => [item.id, item]));
  const after = new Map(current.map((item) => [item.id, item]));
  for (const item of current) {
    const old = before.get(item.id);
    if (!old) changes.push(`${item.id} added`);
    else if (old.stage !== item.stage) changes.push(`${item.id} → ${item.stage}`);
  }
  for (const item of previous) if (!after.has(item.id)) changes.push(`${item.id} removed`);
  return changes.join(', ') || 'data refreshed';
}

function rebuild(store, stdout, { quiet = false, previousItems = [] } = {}) {
  const { html, items } = snapshot(store);
  writeFileSync(store.paths.board, html);
  if (quiet) stdout.write(`${new Date().toISOString()} · ${itemCountLabel(items.length)} · ${changeSummary(previousItems, items)}\n`);
  return items;
}

function watchBoard(store, stdout, previousItems) {
  let timer = null;
  let closed = false;

  const rebuildSoon = () => {
    if (closed || timer) return;
    timer = setTimeout(() => {
      timer = null;
      try {
        previousItems = rebuild(store, stdout, { quiet: true, previousItems });
      } catch (err) {
        // A writer may briefly expose an incomplete JSONL sequence (a torn read),
        // or Windows may refuse the read outright (EPERM/EBUSY) while store.js's
        // temp+rename write is in flight. Either way, keep the last good board
        // and retry when the next filesystem event arrives.
        process.stderr.write(`gw: skipped a board rebuild (${err.code || err.message}); keeping the last good board.\n`);
      }
    }, 150);
  };

  const watcher = watch(store.dir, (_eventType, filename) => {
    if (filename && ['items.jsonl', 'events.jsonl'].includes(filename.toString())) rebuildSoon();
  });
  // fs.watch's FSWatcher can itself emit 'error' (e.g. a watch-buffer overflow,
  // or Windows invalidating the directory handle mid-rename). An EventEmitter
  // with no 'error' listener throws that error as an uncaught exception, which
  // kills the whole process rather than just this rebuild. Without this, a
  // user's board silently stops updating and gw itself disappears.
  watcher.on('error', (err) => {
    process.stderr.write(`gw: file watcher error (${err.code || err.message}); board updates may have stopped, but gw open --watch keeps running.\n`);
  });
  const close = () => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    watcher.close();
    process.removeListener('SIGINT', close);
    process.removeListener('SIGTERM', close);
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);

  stdout.write('Watching items.jsonl and events.jsonl; refresh the browser to see updates.\n');
  if (existsSync(new URL('./serve.js', import.meta.url))) {
    stdout.write('Live alternative: gw serve updates by itself; --watch updates when you refresh.\n');
  }
}

export function run(ctx) {
  const { store, flags, stdout } = ctx;
  const items = rebuild(store, stdout);
  stdout.write(`${store.paths.board}\n`);
  if (flags.watch) watchBoard(store, stdout, items);
  if (!flags['no-browser']) openInBrowser(store.paths.board);
  return 0;
}
