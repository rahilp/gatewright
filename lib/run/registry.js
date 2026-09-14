// Run state must survive the process that launched it.  Keep this deliberately
// file-first: stop and serve can both inspect the same records.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM'; // alive, just not ours to signal
  }
}

function writeAtomic(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n');
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
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
    writeAtomic(pathFor(entry.run), entry);
    return entry;
  }

  function clear(run) {
    const id = typeof run === 'string' ? run : run?.run;
    if (!id) throw new TypeError('clear requires a run id.');
    rmSync(pathFor(id), { force: true });
  }

  function reconcile() {
    const { records, malformed } = list();
    const cleaned = [];
    for (const run of records) {
      if (alive(run.pid)) continue;
      store.withLock(() => {
        const items = store.readItems();
        const item = items.find((candidate) => candidate.id === run.item);
        if (item) {
          item.owner = null;
          item.updated = new Date().toISOString();
          store.writeItems(items);
        }
        store.appendEvent({ type: 'run_ended', item: run.item, run: run.run, outcome: 'error', by: `agent:${run.run}` });
        clear(run.run);
      });
      cleaned.push(run);
    }
    return { cleaned, malformed };
  }

  return { list, record, clear, reconcile };
}
