// The one write path. Every command, the serve API, sync, and the scheduler go
// through this module, so the rules can only be enforced in one place.
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync, rmSync } from 'node:fs';
import { linkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { IOError } from './cli/errors.js';

// Wait without an event loop: every store operation is synchronous, so a
// CLI that is queued behind another one simply blocks.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Windows cannot replace a destination file while another process has it
// open. Watchers normally release their handle within a few milliseconds, so
// retry briefly before reporting an actionable I/O error. Keep this
// synchronous: all store callers are synchronous.
const RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80, 160];
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

function renameOverExistingFile(tmp, path, rename) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rename(tmp, path);
      return;
    } catch (err) {
      if (!RETRYABLE_RENAME_CODES.has(err?.code)) throw err;
      if (attempt === RENAME_RETRY_DELAYS_MS.length) {
        throw new IOError(
          `Could not replace ${path}: the file is held open by another process (for example a running gw serve or gw open --watch).`,
          { cause: err },
        );
      }
      sleepSync(RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
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

// The protected files, keyed by digest field. A missing file hashes as empty
// content, same convention as an empty items.jsonl.
const DIGESTED_FILES = { items: 'items.jsonl', stages: 'stages.json', config: 'config.json' };
const DIGESTED = Object.keys(DIGESTED_FILES);

function hashFor(path) {
  const contents = existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
  return createHash('sha256').update(contents).digest('hex');
}

function hashesFor(paths) {
  return Object.fromEntries(DIGESTED.map((name) => [name, hashFor(paths[name])]));
}

function readLines(path, label) {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  if (raw === '') return [];
  return raw.split('\n').reduce((out, line, i) => {
    if (line.trim() === '') return out;
    try {
      out.push(JSON.parse(line));
    } catch {
      throw new Error(`${label}: line ${i + 1} is not valid JSON. Run 'gw repair' to quarantine the bad line(s), or restore the file from git.`);
    }
    return out;
  }, []);
}

// Atomic: write a sibling temp file, fsync-free rename over the target. A crash
// leaves either the old file or the new one, never a half-written board.
// `rename` is injectable for deterministic tests of Windows file-handle races.
export function writeAtomic(path, contents, { rename = renameSync } = {}) {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, contents);
    renameOverExistingFile(tmp, path, rename);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

// A permission failure on the board directory is a condition the user can
// act on ("make it writable"), not a mystery temp file. EPERM covers
// Windows's refusal semantics alongside POSIX EACCES and read-only mounts.
function asNotWritable(err, dir) {
  if (err && (err.code === 'EACCES' || err.code === 'EROFS' || err.code === 'EPERM')) {
    return new IOError(`${dir} is not writable (permission denied); gw writes its lock and board files there. Check the directory's write permissions.`);
  }
  return err;
}

// Evidence entries are `{ text, stage }`: `text` is the free-form string, and
// `stage` names the stage whose move supplied it — which is what lets a gate
// count only the evidence supplied for it, and lets the board show what
// justified each gate after the fact (T-0029). Boards written before stages
// were recorded carry flat strings; those read as `{ text, stage: null }`.
// The normalisation happens on read, so an old board keeps working at once
// and its on-disk shape is rewritten — with the digest re-baselined — by the
// next gw write, never by a read. A migration that rewrote items.jsonl on
// read would make the very next `gw check` report an out-of-band write that
// the tool itself just made.
function normalizeEvidenceEntry(entry) {
  if (typeof entry === 'string') return { text: entry, stage: null };
  if (entry && typeof entry === 'object' && typeof entry.text === 'string'
    && (entry.stage === undefined || typeof entry.stage === 'string' || entry.stage === null)) {
    return { text: entry.text, stage: entry.stage ?? null };
  }
  return null;
}

function normalizeEvidenceEntries(item) {
  if (!Array.isArray(item.evidence) || item.evidence.length === 0) return item;
  const evidence = item.evidence.map(normalizeEvidenceEntry).filter((entry) => entry !== null);
  return { ...item, evidence };
}

export function createStore(root, { rename = renameSync } = {}) {
  const dir = join(root, DIR);
  const paths = {
    items: join(dir, 'items.jsonl'),
    events: join(dir, 'events.jsonl'),
    stages: join(dir, 'stages.json'),
    config: join(dir, 'config.json'),
    prompt: join(dir, 'prompt.md'),
    digest: join(dir, '.digest'),
    quarantine: join(dir, 'quarantine.jsonl'),
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
      return readLines(paths.items, 'items.jsonl').map(normalizeEvidenceEntries);
    },

    readEvents() {
      return readLines(paths.events, 'events.jsonl');
    },

    writeItems(items) {
      writeAtomic(paths.items, items.map((i) => JSON.stringify(i)).join('\n') + (items.length ? '\n' : ''), { rename });
      store.rebaselineDigest();
    },

    // Configuration is board data too. Commands that update a watermark use
    // this rather than reaching around the store with writeFileSync. It
    // re-baselines the digest, because a legitimate config write must not be
    // reported on the next check as an out-of-band edit.
    writeConfig(config) {
      writeAtomic(paths.config, JSON.stringify(config, null, 2) + '\n', { rename });
      store.rebaselineDigest();
    },

    // Agents are told never to touch .gatewright/ by hand. The digest is how we
    // find out when one did anyway. It is committed, so the check survives a clone.
    //
    // stages.json and config.json are hashed beside items.jsonl because they
    // DEFINE the gates: an edit that deletes a `requires` block is exactly the
    // tampering this digest exists to catch. events.jsonl is deliberately not
    // digested — it is append-only, so adding a line is normal operation, not
    // tampering.
    rebaselineDigest() {
      writeAtomic(paths.digest, JSON.stringify({
        ...hashesFor(paths),
        ts: new Date().toISOString(),
      }) + '\n', { rename });
    },

    verifyDigest() {
      if (!existsSync(paths.digest)) return { status: 'unknown' };
      let digest;
      try {
        digest = JSON.parse(readFileSync(paths.digest, 'utf8'));
      } catch {
        return { status: 'unknown' };
      }
      // A digest written before stages.json and config.json were protected has
      // only the `items` key. A missing per-file hash means "unknown, baseline
      // it silently" — otherwise every board upgraded from an older gw would
      // be accused of tampering on its first check.
      if (DIGESTED.some((name) => typeof digest[name] !== 'string')) return { status: 'unknown' };
      const modified = DIGESTED.filter((name) => hashFor(paths[name]) !== digest[name]).map((name) => DIGESTED_FILES[name]);
      return modified.length ? { status: 'modified', since: digest.ts, files: modified } : { status: 'clean' };
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
      // T-0049 — a read-only board directory surfaced as
      // "EACCES: permission denied, open '.../.lock.<pid>.tmp'": exit code
      // 3 was right, but the message named a temp file the user never
      // created and never said the actual problem, which is that gw cannot
      // write into .gatewright/ at all.
      let lockWriteFailed = null;
      try {
        writeFileSync(claim, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }));
      } catch (err) {
        lockWriteFailed = err;
      }
      if (lockWriteFailed) {
        rmSync(claim, { force: true });
        throw asNotWritable(lockWriteFailed, dir);
      }

      for (;;) {
        try {
          linkSync(claim, paths.lock);
          break;
        } catch (err) {
          if (err.code !== 'EEXIST') {
            rmSync(claim, { force: true });
            throw asNotWritable(err, dir);
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
