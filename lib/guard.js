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

// The example in the last fix must name an id this board would actually
// accept: "P1-07" was a leftover from the phase-seq scheme, refused by this
// same guard on the default `seq` board -- advice that fails its own test.
// A real OPEN id from the board beats any invented one; a finished one is no
// longer an option, since T-0132 made naming it its own refusal -- proposing
// it here would be the same advice-that-fails-its-own-test bug again.
//
// Returns null when the board holds items but none of them is open, because
// then there is no id this guard would accept and every candidate is wrong:
// a real id would be a finished one, and the minted id collides with it --
// on a `seq` board whose only item is a finished T-0001, "e.g. T-0001" is
// literally the id the refusal rejected two lines above. The caller drops
// the line; the `gw add` fix above it is the honest way out of that board.
// An EMPTY board is different: nothing is being rejected, and the minted id
// is exactly what the next `gw add` will produce.
function exampleMessageId(items, config, isFinished) {
  const open = items.find((item) => !isFinished(item.stage));
  if (open) return open.id;
  if (items.length) return null;
  if ((config.id_scheme ?? 'seq') === 'seq') return 'T-0001';
  const phase = Array.isArray(config.vocab?.phase) && config.vocab.phase.length ? config.vocab.phase[0] : 'P1';
  return `${phase}-01`;
}

function ok(via, id, detail, warnings = []) {
  return warnings.length ? { ok: true, via, id: id ?? null, detail, warnings } : { ok: true, via, id: id ?? null, detail };
}

// The sentence a refusal owes a finished item: which item, which stage it
// reached, and a way out that is not `--no-verify`. The ways out are ordered
// by what is actually true most of the time -- follow-up work after a finish
// line is new work -- and the last one names the board's own parking stage,
// which is how this project reopens a finished item (`gw move <id> <paused>
// --force`, then move it forward again). A board with no parked role is
// simply not offered that line rather than offered a stage it does not have.
function finishedRefusal(done, { items, config, isFinished, stages }) {
  const [firstId, firstEntry] = done[0];
  const list = done.map(([id, { item }]) => `${id} (${item.stage})`).join(', ');
  const reason = done.length === 1
    ? `${firstId} is already ${firstEntry.item.stage}, and finished work does not account for a new change`
    : `every item named -- ${list} -- is already finished, and finished work does not account for a new change`;
  const paused = resolveRoles(stages).paused;
  const example = exampleMessageId(items, config, isFinished);
  return {
    ok: false,
    via: null,
    id: null,
    detail: '',
    headline: 'nothing open on the board accounts for this change.',
    reason,
    fixes: [
      'gw brief — see what is already on the board',
      'gw add "<what this change is>" — follow-up work after a finish line is new work',
      ...(example ? [`name an open item in the commit message, e.g. "${example}: <subject>"`] : []),
      ...(paused ? [`gw move ${firstId} ${paused} --force — reopen it instead, if this change really is part of ${firstId}`] : []),
    ],
  };
}

/**
 * @returns {{ok: boolean, via: string|null, id: string|null, detail: string, warnings?: string[], reason?: string, fixes?: string[]}}
 */
export function guardCommit({
  message = '', branch = '', files = [], items = [], actor = null, stages = {}, config = {}, history = false,
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
    const entries = [...named];
    const done = entries.filter(([, { item }]) => isFinished(item.stage));
    const live = entries.filter(([, { item }]) => !isFinished(item.stage));

    // T-0132 — specs §6.5: "an id whose item is in a terminal stage [is]
    // refused with [its] own sentence ... [it means] the author believes
    // they are tracked and is not". T-0028 had softened this to a warning
    // to rescue one flow -- landing a rollup of already-built work -- and
    // the softening reached further than the flow did: while every named
    // item is finished, nothing open on the board is tracking the change
    // being made, which is the one thing guard exists to notice.
    //
    // The rescued flow keeps its two escapes, and both are the spec's:
    // `--range` (below, and §6.5: "an item that has since been finished
    // still accounts for its own commits, since a pull request is reviewed
    // after its work is done"), and the exempt-paths check above, which
    // returns before this one -- a bookkeeping commit that only writes
    // `.gatewright/` still passes however finished the items it names are.
    // A commit that names a finished item ALONGSIDE an open one passes too,
    // and still says out loud which of them were finished.
    if (history || live.length) {
      const [firstId, first] = (live.length ? live : entries)[0];
      const warnings = done.map(([id, { item }]) => `${id} is already ${item.stage}`);
      return ok(first.name, firstId, `${first.label} names ${firstId}`, warnings);
    }
    return finishedRefusal(done, { items, config, isFinished, stages });
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
  const example = exampleMessageId(items, config, isFinished);
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
      ...(example ? [`name the item in the commit message, e.g. "${example}: <subject>"`] : []),
    ],
  };
}
