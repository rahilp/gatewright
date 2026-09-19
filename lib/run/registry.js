// Run state must survive the process that launched it.  Keep this deliberately
// file-first: stop and serve can both inspect the same records.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomic } from '../store.js';

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM'; // alive, just not ours to signal
  }
}

export function createRunRegistry({ store }) {
  if (!store) throw new TypeError('createRunRegistry requires a store.');
  const dir = join(store.dir, 'runs');
  const pathFor = (run) => join(dir, `${run}.json`);

  function ensure() { mkdirSync(dir, { recursive: true }); }

  function list() {
    if (!existsSync(dir)) return { records: [], malformed: [] };
    const records = []; const malformed = [];
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.json')).sort()) {
      const path = join(dir, file);
      try {
        const record = JSON.parse(readFileSync(path, 'utf8'));
        if (!record || typeof record !== 'object' || typeof record.run !== 'string' || typeof record.item !== 'string') throw new Error('missing run or item');
        records.push(record);
      } catch {
        malformed.push(path);
      }
    }
    return { records, malformed };
  }

  function record(run) {
    if (!run || typeof run.run !== 'string' || !run.run || typeof run.item !== 'string' || !run.item) {
      throw new TypeError('run record requires run and item ids.');
    }
    ensure();
    const entry = {
      run: run.run,
      item: run.item,
      pid: run.pid ?? null,
      provider: run.provider ?? null,
      worktree: run.worktree ?? null,
      started: run.started ?? new Date().toISOString(),
      log: run.log ?? null,
    };
    writeAtomic(pathFor(entry.run), JSON.stringify(entry, null, 2) + '\n');
    return entry;
  }

  function clear(run) {
    const id = typeof run === 'string' ? run : run?.run;
    if (!id) throw new TypeError('clear requires a run id.');
    rmSync(pathFor(id), { force: true });
  }

  // Claiming is the terminal-state compare-and-swap. The first observer of a
  // run (normal exit, stop, or timeout) removes its durable record while under
  // the board lock and receives the record to finalize. Every later observer
  // sees null and must write nothing.
  function take(run) {
    const expected = typeof run === 'string' ? { run } : run;
    if (!expected?.run) throw new TypeError('take requires a run id.');
    return store.withLock(() => {
      const path = pathFor(expected.run);
      if (!existsSync(path)) return null;
      let entry;
      try { entry = JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
      if (!entry || entry.run !== expected.run || (expected.pid != null && entry.pid !== expected.pid) || (expected.item && entry.item !== expected.item)) return null;
      rmSync(path, { force: true });
      return entry;
    });
  }

  function reconcile() {
    const { records, malformed } = list();
    const cleaned = [];
    for (const run of records) {
      if (alive(run.pid)) continue;
      const claimed = take(run);
      if (!claimed) continue;
      store.withLock(() => {
        const items = store.readItems();
        const item = items.find((candidate) => candidate.id === claimed.item);
        if (item) {
          item.owner = null;
          item.updated = new Date().toISOString();
          store.writeItems(items);
        }
        store.appendEvent({ type: 'run_ended', item: claimed.item, run: claimed.run, outcome: 'error', by: `agent:${claimed.run}` });
      });
      cleaned.push(claimed);
    }
    return { cleaned, malformed };
  }

  return { list, record, clear, take, reconcile };
}
