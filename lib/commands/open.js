import { existsSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { normalizePath } from '../util/paths.js';
import { spawn } from 'node:child_process';
import { readConfig, readStages } from '../config.js';
import { injectData } from '../viewer/inject.js';
import { describeStage } from '../gates/describe.js';
import { stageList } from '../rules.js';
import { UsageError } from '../cli/errors.js';

export const spec = {
  summary: 'write a board snapshot and open it',
  flags: { 'no-browser': { type: 'boolean' }, watch: { type: 'boolean' }, port: { type: 'string' } },
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

// `gw serve` is intentionally stateless: a second invocation must not need a
// PID file that can go stale.  `open` therefore asks the conventional local
// port whether it is serving *this* board, comparing the complete persisted
// state rather than merely accepting any process that happens to answer HTTP.
// The short timeout makes an absent server indistinguishable from the old,
// immediate snapshot behaviour.
export async function liveBoardUrl(store, { port = 7777, fetchFn = globalThis.fetch } = {}) {
  if (!fetchFn || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const local = {
    items: store.readItems(),
    events: store.readEvents(),
    stages: readStages(store),
    config: readConfig(store),
  };
  try {
    const response = await fetchFn(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(250) });
    if (!response.ok) return null;
    const state = await response.json();
    const remoteItems = (state.items ?? []).map(({ can_release, ...item }) => item);
    const remoteStages = { ...(state.stages ?? {}) };
    delete remoteStages.gates;
    if (JSON.stringify(remoteItems) !== JSON.stringify(local.items)) return null;
    if (JSON.stringify(state.events ?? []) !== JSON.stringify(local.events)) return null;
    if (JSON.stringify(remoteStages) !== JSON.stringify(local.stages)) return null;
    if (JSON.stringify(state.config ?? {}) !== JSON.stringify(local.config)) return null;
    return `http://127.0.0.1:${port}/`;
  } catch { return null; }
}

// The same choice `gw serve` makes (see withGateDescriptions in
// lib/serve/server.js): the plain-English gate sentences are resolved here, in
// Node, and travel inside the stages payload the viewer already reads. The
// viewer is a standalone document that cannot import lib/gates/describe.js, and
// a second copy of this wording in board.html would drift away from the rules
// the CLI actually enforces. Doing it here is what keeps `gw open --no-browser`
// -- a file:// snapshot with no server to ask -- showing the same sentences.
function withGateDescriptions(stages) {
  const gates = {};
  for (const stage of stageList(stages)) gates[stage.id] = describeStage(stage, stages);
  return { ...stages, gates };
}

function snapshot(store) {
  const shell = readFileSync(new URL('../../viewer/board.html', import.meta.url), 'utf8');
  const items = store.readItems();
  const html = injectData(shell, {
    items,
    events: store.readEvents(),
    stages: withGateDescriptions(readStages(store)),
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

export async function run(ctx) {
  const { store, flags, stdout } = ctx;
  const port = flags.port === undefined ? 7777 : Number(flags.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UsageError('--port must be an integer from 1 to 65535');
  const live = await liveBoardUrl(store, { port, fetchFn: ctx.fetch });
  if (live) {
    stdout.write(`Gatewright live board: ${live}\n`);
    if (!flags['no-browser']) openInBrowser(live);
    return 0;
  }
  const items = rebuild(store, stdout);
  stdout.write(`${store.paths.board}\n`);
  if (flags.watch) watchBoard(store, stdout, items);
  if (!flags['no-browser']) openInBrowser(store.paths.board);
  return 0;
}
