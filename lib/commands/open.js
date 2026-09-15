import { existsSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { normalizePath } from '../util/paths.js';
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
  // "Best effort" has to include the failure that actually happens. A missing
  // opener -- xdg-open is absent on headless Linux, minimal containers and
  // plain WSL -- is reported by an asynchronous 'error' event, not a throw, so
  // the try/catch alone never saw it and the unhandled event took the whole
  // command down. The board is already on disk by this point; not launching a
  // browser is not a failure worth exiting over.
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', shell: platform === 'win32' });
    child.once('error', () => {});
    child.unref();
  } catch { /* nothing left to do: the board is already written */ }
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

  // The watched directory MUST be the canonical long-form path, not whatever
  // was lexically joined. libuv's Windows backend asserts that the filename
  // ReadDirectoryChangesW hands back starts with the directory string it was
  // given (uv__relative_path, src/win/fs-event.c) -- and that comparison is a
  // hard assert, not an error: it fail-fasts the whole process with
  // 0xC0000409 and no catchable exception, taking `gw open --watch` down on
  // the first file change. An 8.3 short component is enough to trip it, and
  // those are ordinary on Windows: any account whose name exceeds eight
  // characters gets an abbreviated `LONGNA~1` component in its profile path.
  // Node 22 tolerated the mismatch;
  // node 24 asserts. normalizePath expands short names via the same Win32 API
  // the watcher itself reports through, so the two agree.
  const watcher = watch(normalizePath(store.dir), (_eventType, filename) => {
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
