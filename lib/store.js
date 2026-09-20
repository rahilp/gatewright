// The one write path. Every command, the serve API, sync, and the scheduler go
// through this module, so the rules can only be enforced in one place.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { closeSync, fsyncSync, linkSync, openSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { IOError } from './cli/errors.js';
import { isTerminalStage, resolveRoles } from './stages.js';

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

// T-0136 — the directory fsync that some platforms simply do not offer.
// Windows has no fsync-a-directory concept and refuses the open outright;
// network and virtualised filesystems answer EINVAL or ENOTSUP. By the time
// this runs the data is already renamed into place, so a refusal here is a
// durability guarantee we could not get, never a failed write.
const UNSUPPORTED_DIR_FSYNC = new Set(['EISDIR', 'EPERM', 'EBADF', 'EACCES', 'EINVAL', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP']);

function fsyncDir(dir, fsync) {
  let fd;
  try {
    fd = openSync(dir, 'r');
  } catch (err) {
    if (UNSUPPORTED_DIR_FSYNC.has(err?.code)) return;
    throw err;
  }
  try {
    fsync(fd);
  } catch (err) {
    if (!UNSUPPORTED_DIR_FSYNC.has(err?.code)) throw err;
  } finally {
    closeSync(fd);
  }
}

// Atomic AND durable: write a sibling temp file, fsync it, rename over the
// target, then fsync the directory that now holds the new name. A crash leaves
// either the old file or the new one, never a half-written board -- and,
// unlike the fsync-free version this replaces, never a renamed file whose
// CONTENT was still in the page cache when the power went out.
// `rename` and `fsync` are injectable for deterministic tests of Windows
// file-handle races and of platforms that refuse a directory fsync.
export function writeAtomic(path, contents, { rename = renameSync, fsync = fsyncSync } = {}) {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    const fd = openSync(tmp, 'w');
    try {
      writeFileSync(fd, contents);
      fsync(fd);
    } finally {
      closeSync(fd);
    }
    renameOverExistingFile(tmp, path, rename);
    fsyncDir(dirname(path), fsync);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

// T-0135 — which events stay in events.jsonl (and which `gw open` inlines).
// Every event of an item that is still open stays: that is the history
// someone is actively working with, and capping it would hide the very
// evidence a gate was argued from. A terminal item keeps its last `keep`
// events; so do the board-level events that name no item (sync, pause_all,
// compact), which otherwise form one bucket that could never be compacted.
// Nothing is deleted -- the rest moves to events-archive.jsonl -- so this
// decides what is HOT, not what is kept.
export const DEFAULT_EVENTS_KEEP = 20;

// The items whose history stays hot. Terminal is decided exactly as
// `gw gc` decides it for worktrees, so one board never has two answers to
// "is this item finished": a declared terminal or dropped stage, a stage
// with role "done", or the pipeline's resolved done stage.
export function openItemIds(items, stages) {
  const roles = resolveRoles(stages);
  return new Set(items
    .filter((item) => !isTerminalStage(item.stage, stages, roles) && item.stage !== roles.done)
    .map((item) => item.id));
}

// How many events a terminal item keeps in events.jsonl. One setting, read by
// both `gw gc --events` (what it archives) and `gw open` (what it inlines), so
// a compacted board and a fresh snapshot show the same history.
export function eventsKeep(config) {
  const value = config?.gc?.events_keep;
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_EVENTS_KEEP;
}

export function partitionEvents(events, { open, keep = DEFAULT_EVENTS_KEEP } = {}) {
  const openIds = open instanceof Set ? open : new Set(open ?? []);
  const limit = Number.isInteger(keep) && keep >= 0 ? keep : DEFAULT_EVENTS_KEEP;
  const seen = new Map();
  const hot = new Array(events.length);
  // Backwards, so "the last N" needs no sort and no timestamp arithmetic:
  // events.jsonl is append-ordered, and that order is the one the board shows.
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const key = typeof events[i]?.item === 'string' ? events[i].item : '';
    if (openIds.has(key)) { hot[i] = true; continue; }
    const count = seen.get(key) ?? 0;
    hot[i] = count < limit;
    seen.set(key, count + 1);
  }
  const kept = [];
  const archived = [];
  for (let i = 0; i < events.length; i += 1) (hot[i] ? kept : archived).push(events[i]);
  return { kept, archived };
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

export function createStore(root, { rename = renameSync, fsync = fsyncSync } = {}) {
  const dir = join(root, DIR);
  const paths = {
    items: join(dir, 'items.jsonl'),
    events: join(dir, 'events.jsonl'),
    eventsArchive: join(dir, 'events-archive.jsonl'),
    stages: join(dir, 'stages.json'),
    config: join(dir, 'config.json'),
    prompt: join(dir, 'prompt.md'),
    digest: join(dir, '.digest'),
    quarantine: join(dir, 'quarantine.jsonl'),
    lock: join(dir, '.lock'),
    gitignore: join(dir, '.gitignore'),
    board: join(dir, 'board.html'),
  };

  // One fd, one fsync, however many lines: gc --events archives tens of
  // thousands at a time. The write loops because write(2) is allowed to
  // accept fewer bytes than it was given, and a 7MB archive batch is exactly
  // the size at which "it has always written all of it" stops being a
  // guarantee -- a short write there would truncate the audit trail.
  function appendLines(path, lines) {
    const payload = Buffer.from(`${lines.join('\n')}\n`);
    const fd = openSync(path, 'a');
    try {
      let written = 0;
      while (written < payload.length) written += writeSync(fd, payload, written, payload.length - written);
      fsync(fd);
    } finally {
      closeSync(fd);
    }
  }

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
      writeAtomic(paths.items, items.map((i) => JSON.stringify(i)).join('\n') + (items.length ? '\n' : ''), { rename, fsync });
      store.rebaselineDigest();
    },

    // Configuration is board data too. Commands that update a watermark use
    // this rather than reaching around the store with writeFileSync. It
    // re-baselines the digest, because a legitimate config write must not be
    // reported on the next check as an out-of-band edit.
    writeConfig(config) {
      writeAtomic(paths.config, JSON.stringify(config, null, 2) + '\n', { rename, fsync });
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
      }) + '\n', { rename, fsync });
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

    // The append is fsynced before it returns. An event is the audit trail's
    // only record that something happened, and `gw move` writes items.jsonl
    // durably; an event that is still in the page cache when the machine dies
    // leaves a board whose state no event explains.
    appendEvent(event) {
      const stamped = { ts: new Date().toISOString(), ...event };
      appendLines(paths.events, [JSON.stringify(stamped)]);
      return stamped;
    },

    // gc --events only; every other caller appends through appendEvent.
    // Append-only, like events.jsonl itself: the audit trail is moved here,
    // never deleted, and stays greppable line by line.
    archiveEvents(events) {
      if (!events.length) return 0;
      appendLines(paths.eventsArchive, events.map((event) => JSON.stringify(event)));
      return events.length;
    },

    // The one write that rewrites events.jsonl rather than appending to it.
    // Callers must hold the lock and must have archived whatever they drop.
    replaceEvents(events) {
      writeAtomic(paths.events, events.map((event) => JSON.stringify(event)).join('\n') + (events.length ? '\n' : ''), { rename, fsync });
    },
  };

  return store;
}
