// The one write path. Every command, the serve API, sync, and the scheduler go
// through this module, so the rules can only be enforced in one place.
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync, rmSync } from 'node:fs';
import { linkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

// Wait without an event loop: every store operation is synchronous, so a
// CLI that is queued behind another one simply blocks.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // alive, just not ours to signal
  }
}

const DIR = '.gatewright';

function readLines(path, label) {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  if (raw === '') return [];
  return raw.split('\n').reduce((out, line, i) => {
    if (line.trim() === '') return out;
    try {
      out.push(JSON.parse(line));
    } catch {
      throw new Error(`${label}: line ${i + 1} is not valid JSON. Repair it by hand or restore it from git.`);
    }
    return out;
  }, []);
}

// Atomic: write a sibling temp file, fsync-free rename over the target. A crash
// leaves either the old file or the new one, never a half-written board.
function writeAtomic(path, contents) {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, contents);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export function createStore(root) {
  const dir = join(root, DIR);
  const paths = {
    items: join(dir, 'items.jsonl'),
    events: join(dir, 'events.jsonl'),
    stages: join(dir, 'stages.json'),
    config: join(dir, 'config.json'),
    digest: join(dir, '.digest'),
    lock: join(dir, '.lock'),
    board: join(dir, 'board.html'),
  };

  const store = {
    root,
    dir,
    paths,

    ensure() {
      mkdirSync(dir, { recursive: true });
      for (const path of [paths.items, paths.events]) {
        if (!existsSync(path)) writeFileSync(path, '');
      }
    },

    readItems() {
      return readLines(paths.items, 'items.jsonl');
    },

    readEvents() {
      return readLines(paths.events, 'events.jsonl');
    },

    writeItems(items) {
      writeAtomic(paths.items, items.map((i) => JSON.stringify(i)).join('\n') + (items.length ? '\n' : ''));
      store.rebaselineDigest();
    },

    // Agents are told never to touch .gatewright/ by hand. The digest is how we
    // find out when one did anyway. It is committed, so the check survives a clone.
    rebaselineDigest() {
      const contents = existsSync(paths.items) ? readFileSync(paths.items) : Buffer.alloc(0);
      writeAtomic(paths.digest, JSON.stringify({
        items: createHash('sha256').update(contents).digest('hex'),
        ts: new Date().toISOString(),
      }) + '\n');
    },

    verifyDigest() {
      if (!existsSync(paths.digest)) return { status: 'unknown' };
      let digest;
      try {
        digest = JSON.parse(readFileSync(paths.digest, 'utf8'));
      } catch {
        return { status: 'unknown' };
      }
      const contents = existsSync(paths.items) ? readFileSync(paths.items) : Buffer.alloc(0);
      const actual = createHash('sha256').update(contents).digest('hex');
      return actual === digest.items ? { status: 'clean' } : { status: 'modified', since: digest.ts };
    },

    // Advisory lock. Polls every `pollMs`, says something at `warnMs` so a wait
    // never looks like a hang, and gives up at `giveUpMs` rather than blocking a
    // session forever. A lock whose holder is gone is stale and gets broken.
    withLock(fn, { pollMs = 50, warnMs = 2000, giveUpMs = 10000 } = {}) {
      const startedAt = Date.now();
      let warned = false;

      // The lock has to appear already populated. Creating an empty file and
      // then writing the pid leaves a window in which another process reads a
      // blank lock, calls it stale, and deletes it — which loses writes.
      // link() is atomic and fails if the target exists, so the file is never
      // observable without its holder.
      const claim = `${paths.lock}.${process.pid}.tmp`;
      writeFileSync(claim, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }));

      for (;;) {
        try {
          linkSync(claim, paths.lock);
          break;
        } catch (err) {
          if (err.code !== 'EEXIST') {
            rmSync(claim, { force: true });
            throw err;
          }

          let holder = null;
          try {
            holder = JSON.parse(readFileSync(paths.lock, 'utf8'));
          } catch {
            holder = null; // unreadable or half-written: treat as stale
          }
          if (!holder || !processAlive(holder.pid)) {
            rmSync(paths.lock, { force: true });
            continue;
          }

          const waited = Date.now() - startedAt;
          if (waited >= giveUpMs) {
            rmSync(claim, { force: true });
            throw new Error(
              `.gatewright/.lock is held by another gw process (pid ${holder.pid}) and did not clear in ${Math.round(giveUpMs / 1000)}s. ` +
              'If nothing else is running, delete the lock file.',
            );
          }
          if (!warned && waited >= warnMs) {
            warned = true;
            process.stderr.write(`gw: waiting for another gw process (pid ${holder.pid}) to finish writing...\n`);
          }
          sleepSync(pollMs);
        }
      }

      try {
        return fn();
      } finally {
        rmSync(paths.lock, { force: true });
        rmSync(claim, { force: true });
      }
    },

    appendEvent(event) {
      const stamped = { ts: new Date().toISOString(), ...event };
      appendFileSync(paths.events, JSON.stringify(stamped) + '\n');
      return stamped;
    },
  };

  return store;
}
