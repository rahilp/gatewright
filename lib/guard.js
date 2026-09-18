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
import { sameOwner } from './owner.js';

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

// T-0028 — a rollup commit can land several items at once, and judging it by
// the first id that matches would let a nonexistent one ride along unseen.
// Every id the text names, longest-first so the same prefix rule as
// findItemId holds per match.
export function findItemIds(text, ids) {
  if (!text) return [];
  return [...ids].sort((a, b) => b.length - a.length).filter((id) => mentions(text, id));
}

// Id-shaped tokens the board does not know. Guard cannot tell an invented
// item id from prose (a CVE number, an HTTP status), so an unmatched token
// is never a refusal on its own -- it only sharpens the sentence when the
// commit is refused for being accounted for by nothing at all.
const ID_SHAPE = /(^|[^A-Za-z0-9.])([A-Z]+[0-9]*-[0-9]+(?:\.[0-9]+)*)($|[^A-Za-z0-9.])/gi;
function idShapedTokens(text) {
  return [...String(text ?? '').matchAll(ID_SHAPE)].map((match) => match[2]);
}

function isExempt(file, exemptPaths) {
  const path = file.replace(/\\/g, '/');
  return exemptPaths.some((prefix) => {
    const cleaned = prefix.replace(/\\/g, '/');
    return cleaned.endsWith('/') ? path.startsWith(cleaned) : path === cleaned || path.startsWith(`${cleaned}/`);
  });
}

function ok(via, id, detail, warnings = []) {
  return warnings.length ? { ok: true, via, id: id ?? null, detail, warnings } : { ok: true, via, id: id ?? null, detail };
}

/**
 * @returns {{ok: boolean, via: string|null, id: string|null, detail: string, warnings?: string[], reason?: string, fixes?: string[]}}
 */
export function guardCommit({
  message = '', branch = '', files = [], items = [], actor = null, stages = {}, config = {},
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

  // T-0028 — the question is "is this change accounted for on the board", and
  // it is answered YES by any of: an id-shaped token in the message or branch
  // that matches a real board item, or an item claimed by the committing
  // actor. An item that is built IS accounted for -- guard used to refuse a
  // named finished item, which left `--no-verify` -- the off switch for the
  // whole check -- as the only way to land a rollup of already-built work,
  // and a check whose only escape hatch is to turn it off gets turned off
  // habitually, and then it protects nothing.
  //
  // Guard cannot tell an invented item id from prose: a security fix that
  // cites CVE-2024-5678 or an HTTP status is an ordinary commit, so a token
  // that matches no board item is never a refusal while something else
  // accounts for the change. The tokens it tried are listed only in the
  // refusal, where they are genuinely useful.
  const named = new Map();
  for (const source of sources) {
    for (const id of findItemIds(source.text, ids)) {
      if (!named.has(id)) named.set(id, { item: byId.get(id), name: source.name, label: source.label });
    }
  }

  if (named.size) {
    const [firstId, first] = [...named][0];
    const warnings = [...named]
      .filter(([, { item }]) => isFinished(item.stage))
      .map(([id, { item }]) => `${id} is already ${item.stage}`);
    return ok(first.name, firstId, `${first.label} names ${firstId}`, warnings);
  }

  if (settings.accept.includes('owner') && actor) {
    const owned = items.filter((item) => sameOwner(item.owner, actor) && !isFinished(item.stage));
    if (owned.length) {
      const [first] = owned;
      const detail = owned.length === 1
        ? `${first.id} is claimed by ${actor}`
        : `${owned.length} items are claimed by ${actor} (${owned.map((item) => item.id).join(', ')}); name one in the commit message to be unambiguous`;
      return ok('owner', first.id, detail);
    }
  }

// The example in the last fix must name an id this board would actually
// accept: "P1-07" was a leftover from the phase-seq scheme, refused by this
// same guard on the default `seq` board -- advice that fails its own test.
// A real id from the board beats any invented one; with no items at all, the
// example follows the board's id scheme.
function exampleMessageId(items, config, isFinished) {
  const open = items.find((item) => !isFinished(item.stage));
  if (open) return open.id;
  if (items.length) return items[0].id;
  if ((config.id_scheme ?? 'seq') === 'seq') return 'T-0001';
  const phase = Array.isArray(config.vocab?.phase) && config.vocab.phase.length ? config.vocab.phase[0] : 'P1';
  return `${phase}-01`;
}

  // The refusal is the one place the unmatched tokens earn their keep: the
  // author thought a name tracked their work and it did not, and the token
  // they actually typed is the fastest thing to show them.
  const knownIds = new Set(ids.map((id) => id.toLowerCase()));
  const strays = [...new Set(sources.flatMap((source) => idShapedTokens(source.text)))]
    .filter((token) => !knownIds.has(token.toLowerCase()));
  let reason;
  if (strays.length) {
    const list = strays.join(', ');
    const clause = strays.length === 1
      ? `${list} is not an item on this board`
      : `${list} are not items on this board`;
    reason = actor
      ? `no item is claimed by ${actor}, and the only id${strays.length === 1 ? '' : 's'} named, ${list}, ${strays.length === 1 ? 'is not an item' : 'are not items'} on this board`
      : clause;
  } else {
    reason = actor
      ? `no item is claimed by ${actor}, and neither the commit message nor the branch names one`
      : 'neither the commit message nor the branch names an item on this board';
  }
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
      `name the item in the commit message, e.g. "${exampleMessageId(items, config, isFinished)}: <subject>"`,
    ],
  };
}
