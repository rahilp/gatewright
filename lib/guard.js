// Every other rule in this project governs work that is already on the board.
// This module governs the one thing they cannot reach: whether the work was
// put on the board at all. It answers a single question about a commit --
// which item is this change accounted for by? -- and it answers it with pure
// data so the same verdict can be reached from a git hook, from CI, or from a
// test with no checkout at all.
//
// It deliberately accepts weak evidence. A claimed item, an id in the branch
// name, or an id in the commit message are all proof that a human or an agent
// opened the board before touching code, which is the whole point. Anything
// stricter turns into the kind of pre-commit hook people rip out.

import { isTerminalStage, resolveRoles } from './stages.js';

const DEFAULT_ACCEPT = ['message', 'branch', 'owner'];
const DEFAULT_EXEMPT = ['.gatewright/'];

export function guardSettings(config = {}) {
  const guard = config.guard ?? {};
  return {
    enabled: guard.enabled !== false,
    mode: guard.mode === 'warn' ? 'warn' : 'block',
    accept: Array.isArray(guard.accept) ? guard.accept : DEFAULT_ACCEPT,
    exemptPaths: Array.isArray(guard.exempt_paths) ? guard.exempt_paths : DEFAULT_EXEMPT,
  };
}

// "Finished" is the board's own definition, not just the `terminal` list: a
// stage carrying `role: "done"` is a finish line too. Getting this wrong is not
// academic -- on a trunk board whose last stage is Built, every item anyone
// ever finished is still claimed by them, and each one would vouch for any
// commit they made afterwards forever.
function finished(stages) {
  const roles = resolveRoles(stages);
  const cache = new Map();
  return (stageId) => {
    if (!cache.has(stageId)) cache.set(stageId, isTerminalStage(stageId, stages, roles));
    return cache.get(stageId);
  };
}

// Ids are matched against the board's own ids rather than a pattern, so a
// commit cannot buy its way past the guard by naming an item that was never
// created. `P1-01` must not match inside `P1-011` or `P1-01.2` -- the second
// is a different item and matches itself -- but it must match in
// `feat/P1-01-human-board`, which is how branches are actually named.
function mentions(text, id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9.])${escaped}($|[^A-Za-z0-9.])`, 'i').test(text);
}

// Longest first: `P1-01.2` wins over its parent `P1-01` when both would match.
export function findItemId(text, ids) {
  if (!text) return null;
  return [...ids].sort((a, b) => b.length - a.length).find((id) => mentions(text, id)) ?? null;
}

// An id-shaped token that is not on the board is a different failure from no
// id at all, and it deserves a different sentence: the author thinks they are
// tracked and is not.
const ID_SHAPE = /(^|[^A-Za-z0-9.])([A-Z]+[0-9]*-[0-9]+(?:\.[0-9]+)*)($|[^A-Za-z0-9.])/i;
function idShapedToken(text) {
  return ID_SHAPE.exec(text ?? '')?.[2] ?? null;
}

function isExempt(file, exemptPaths) {
  const path = file.replace(/\\/g, '/');
  return exemptPaths.some((prefix) => {
    const cleaned = prefix.replace(/\\/g, '/');
    return cleaned.endsWith('/') ? path.startsWith(cleaned) : path === cleaned || path.startsWith(`${cleaned}/`);
  });
}

function ok(via, id, detail) { return { ok: true, via, id: id ?? null, detail }; }

/**
 * @returns {{ok: boolean, via: string|null, id: string|null, detail: string, reason?: string, fixes?: string[]}}
 */
export function guardCommit({
  message = '', branch = '', files = [], items = [], actor = null, stages = {}, config = {},
  // Judging a commit that already exists is a different question from judging
  // one being made. "That item is finished" is the right refusal for work
  // happening now and the wrong one for history: by the time CI reads a pull
  // request, the item its commits name has usually -- correctly -- been
  // finished. Requiring otherwise would fail every completed pull request.
  retrospective = false,
} = {}) {
  const settings = guardSettings(config);
  const isFinished = finished(stages);
  const ids = items.map((item) => item.id).filter(Boolean);
  const byId = new Map(items.map((item) => [item.id, item]));

  // A commit that only records the board is the board doing its job; making it
  // name an item would mean every `gw` write needed an item about itself.
  if (files.length && files.every((file) => isExempt(file, settings.exemptPaths))) {
    return ok('exempt', null, 'this commit only touches tracked-board files');
  }

  const sources = [
    { name: 'message', text: message, label: 'the commit message' },
    { name: 'branch', text: branch, label: 'the branch name' },
  ].filter((source) => settings.accept.includes(source.name));

  for (const source of sources) {
    const id = findItemId(source.text, ids);
    if (!id) continue;
    const item = byId.get(id);
    if (isFinished(item.stage) && !retrospective) {
      return {
        ok: false, via: null, id, detail: '',
        reason: `${source.label} names ${id}, which is already ${item.stage}`,
        fixes: [
          `gw add "<what this change is>" — track it as new work`,
          `gw move ${id} <stage> — if ${id} really is still in flight, put it back in flight`,
        ],
      };
    }
    return ok(source.name, id, `${source.label} names ${id}`);
  }

  if (settings.accept.includes('owner') && actor) {
    const owned = items.filter((item) => item.owner === actor && !isFinished(item.stage));
    if (owned.length) {
      const [first] = owned;
      const detail = owned.length === 1
        ? `${first.id} is claimed by ${actor}`
        : `${owned.length} items are claimed by ${actor} (${owned.map((item) => item.id).join(', ')}); name one in the commit message to be unambiguous`;
      return ok('owner', first.id, detail);
    }
  }

  const stray = idShapedToken(message) ?? idShapedToken(branch);
  const reason = stray
    ? `${stray} is not an item on this board`
    : actor
      ? `no item is claimed by ${actor}, and neither the commit message nor the branch names one`
      : 'neither the commit message nor the branch names an item on this board';
  return {
    ok: false,
    via: null,
    id: null,
    detail: '',
    reason,
    fixes: [
      'gw brief — see what is already on the board',
      'gw claim <id> — take the item this change belongs to',
      'gw add "<what this change is>" — if it is not on the board yet',
      'name the item in the commit message, e.g. "P1-07: <subject>"',
    ],
  };
}
