import { readStages } from '../config.js';
import { stageList } from '../rules.js';
import { UsageError } from '../cli/errors.js';
import { sanitizeTitle, tamperBanner } from '../brief.js';
import { sameOwner } from '../owner.js';

export const spec = {
  summary: 'list items, filtered by stage, phase, flag, owner, or free text',
  flags: { stage: { type: 'string' }, phase: { type: 'string' }, flag: { type: 'string' }, owner: { type: 'string' }, limit: { type: 'string' }, json: { type: 'boolean' } },
  // T-0138 — `gw list` on a 2,000-item board printed 2,001 lines into an
  // agent's context, and the only way to see less of it was to know a stage
  // or phase to filter by. The free-text argument is the search an agent
  // actually has: some words from the title, or part of an id.
  positionals: [{ name: 'text', required: false }],
};

// The spelling `gw config` already uses for "no value": an explicit way to ask
// for the unowned items, which no owner name can express.
const UNOWNED = new Set(['none', 'nobody', 'unowned']);

function parseLimit(raw) {
  if (raw === undefined) return null;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new UsageError(`--limit needs a whole number of items, at least 1, not ${JSON.stringify(String(raw))}.`);
  }
  return limit;
}

// Case-insensitive, substring, over the two fields a person or an agent
// actually remembers: what it was called, and what it was numbered.
function matchesText(item, needle) {
  return `${item.id ?? ''}`.toLowerCase().includes(needle)
    || `${item.title ?? ''}`.toLowerCase().includes(needle);
}

function matchesOwner(item, owner) {
  if (UNOWNED.has(owner.toLowerCase())) return !item.owner;
  return sameOwner(item.owner, owner);
}

export function run(ctx) {
  // T-0044 — an unknown stage used to filter to zero rows and exit 0,
  // indistinguishable from an empty stage. `move` refuses an unknown stage at
  // exit 2; list must give the same answer, naming the stages that do exist.
  if (ctx.flags.stage) {
    const stages = readStages(ctx.store);
    const known = stageList(stages).map((stage) => stage.id);
    if (!known.includes(ctx.flags.stage)) {
      throw new UsageError(`unknown stage: ${ctx.flags.stage}; valid stages: ${known.join(', ')}`);
    }
  }
  const limit = parseLimit(ctx.flags.limit);
  const text = ctx.positionals[0]?.toLowerCase();
  const matched = ctx.store.readItems().filter((item) => (
    (!ctx.flags.stage || item.stage === ctx.flags.stage)
    && (!ctx.flags.phase || item.phase === ctx.flags.phase)
    && (!ctx.flags.flag || item.flag === ctx.flags.flag)
    && (!ctx.flags.owner || matchesOwner(item, ctx.flags.owner))
    && (!text || matchesText(item, text))
  ));
  // A limit applies to --json too. The budget it exists to protect is the
  // reader's, and on this board the reader is usually a program. The shape is
  // unchanged — an array, as it has always been — because a wrapper object
  // would break every script that already parses this.
  const items = limit === null ? matched : matched.slice(0, limit);
  if (ctx.flags.json) { ctx.stdout.write(`${JSON.stringify(items)}\n`); return; }
  const warning = tamperBanner(ctx.store.verifyDigest());
  if (warning) ctx.stdout.write(`${warning}\n`);
  // Titles go through the same one-row-per-item sanitiser the brief uses, so
  // a title holding a newline (T-0009) renders as one row, not two.
  for (const item of items) ctx.stdout.write(`${item.id}  ${item.stage ?? '-'}  ${sanitizeTitle(item.title)}\n`);
  // Truncation is never silent: a cut-off list that looks complete is how a
  // reader concludes an item does not exist.
  if (items.length < matched.length) {
    ctx.stdout.write(`(+${matched.length - items.length} more of ${matched.length} matched — raise --limit, or narrow the filter)\n`);
  }
}
