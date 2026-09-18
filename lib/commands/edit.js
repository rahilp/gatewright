import { readConfig, readStages } from '../config.js';
import { findCycles } from '../rules.js';
import { UsageError, RuleError } from '../cli/errors.js';
import { isTerminalStage } from '../stages.js';
import { validateVocab } from '../vocab.js';

export const spec = {
  summary: 'edit an item',
  flags: {
    title: { type: 'string' },
    scope: { type: 'string' },
    priority: { type: 'string' },
    type: { type: 'string' },
    phase: { type: 'string' },
    // T-0040 — allowEmpty is what makes `--deps ""` and `--deps=` parse as an
    // explicit value: without it args.js refuses '' before this command ever
    // sees it, and the clear-the-list branch below was unreachable, so a
    // dependency could be replaced but never removed. A genuinely missing
    // value (no next token, or the next token is another flag) still errors.
    deps: { type: 'string', allowEmpty: true },
    refs: { type: 'string', allowEmpty: true },
    force: { type: 'boolean' },
    by: { type: 'string' },
  },
  positionals: [{ name: 'id', required: true }],
};

const fields = ['title', 'scope', 'priority', 'type', 'phase', 'deps', 'refs'];
const githubOwnedFields = ['title', 'scope', 'priority', 'type', 'phase'];
const vocabValidatedFields = githubOwnedFields.slice(2);
const arrayFields = new Set(['deps', 'refs']);

export function run(ctx) {
  return ctx.store.withLock(() => {
    const items = ctx.store.readItems();
    const item = items.find((candidate) => candidate.id === ctx.positionals[0]);
    if (!item) throw new UsageError(`unknown item: ${ctx.positionals[0]}`);

    const changed = fields.filter((field) => ctx.flags[field] !== undefined);
    if (!changed.length) {
      throw new UsageError('edit requires at least one field flag');
    }

    // Sync owns these fields for linked issues, so a local change would be
    // silently overwritten on the next pull.
    const refused = item.gh && changed.filter((field) => githubOwnedFields.includes(field));
    if (refused?.length) {
      throw new RuleError(
        `cannot edit GitHub-owned field(s) ${refused.join(', ')}; edit it on the issue instead because the next sync would silently revert a local edit: ${item.gh.url}`,
      );
    }

    if (ctx.flags.title !== undefined) {
      if (!ctx.flags.title.trim()) throw new UsageError('title must not be empty');
      if (/[\r\n]/.test(ctx.flags.title)) throw new UsageError('title must not contain newlines');
    }
    if (ctx.flags.title?.length > 120) {
      throw new UsageError('title must be 120 characters or fewer');
    }

    // T-0035 — scope is what the evidence gate judged the work against. Once
    // an item stands in a terminal stage, rewriting scope would quietly
    // invalidate that judgement with no trace: the evidence still reads as
    // proof of a definition of done that no longer exists. So the rewrite is
    // refused, and the two lawful outs are both named in the refusal: reopen
    // the item with a recorded, forced move (which puts it back in the
    // pipeline where re-verification is owed), or --force here, which
    // proceeds but stamps the change into the item's notes and its event.
    const stages = readStages(ctx.store);
    if (changed.includes('scope') && isTerminalStage(item.stage, stages) && !ctx.flags.force) {
      throw new RuleError(
        `cannot rewrite --scope while ${item.id} sits in terminal stage '${item.stage}': the recorded evidence was judged against the old scope. Reopen it first with \`gw move ${item.id} <stage> --force\` (that move is recorded), or pass --force to this edit to proceed and record the change in the item's notes.`,
      );
    }

    const config = readConfig(ctx.store);
    validateVocab(config, ctx.flags, vocabValidatedFields);

    // Work on copies so a rejected dependency graph leaves the stored board untouched.
    const proposed = items.map((candidate) => (
      candidate === item ? { ...candidate } : candidate
    ));
    const next = proposed.find((candidate) => candidate.id === item.id);
    for (const field of changed) {
      next[field] = arrayFields.has(field)
        ? (ctx.flags[field] === '' ? [] : ctx.flags[field].split(',').map((value) => value.trim()))
        : ctx.flags[field];
    }

    if (changed.includes('deps')) {
      const ids = new Set(items.map((candidate) => candidate.id));
      const missing = next.deps.filter((id) => !ids.has(id));
      if (missing.length) {
        throw new UsageError(`unknown dependency: ${missing.join(', ')}`);
      }

      const cycles = findCycles(proposed);
      if (cycles.length) {
        throw new RuleError(`dependency cycle: ${cycles[0].join(' -> ')}`);
      }
    }

    next.updated = new Date().toISOString();
    // T-0035 — a forced scope change on verified work is recorded loudly, in
    // the two places a reader can see: the item's notes (visible to `gw show`
    // and the board) and the event log. A --force elsewhere is a no-op here
    // and leaves no such mark.
    const forcedOnTerminal = ctx.flags.force && changed.includes('scope') && isTerminalStage(item.stage, stages);
    if (forcedOnTerminal) {
      const stamp = new Date().toISOString();
      const note = `[${stamp}] scope rewritten after verification by ${ctx.actor}: ${next.scope}`;
      next.notes = next.notes ? `${next.notes}\n${note}` : note;
    }
    ctx.store.writeItems(proposed);
    ctx.store.appendEvent({
      type: 'edit',
      item: item.id,
      by: ctx.actor,
      fields: changed,
      ...(forcedOnTerminal ? { scope_forced: true } : {}),
    });
  });
}
