import { readConfig } from '../config.js';
import { findCycles } from '../rules.js';
import { UsageError, RuleError } from '../cli/errors.js';
import { validateVocab } from '../vocab.js';

export const spec = {
  summary: 'edit an item',
  flags: {
    title: { type: 'string' },
    scope: { type: 'string' },
    priority: { type: 'string' },
    type: { type: 'string' },
    phase: { type: 'string' },
    deps: { type: 'string' },
    refs: { type: 'string' },
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
    ctx.store.writeItems(proposed);
    ctx.store.appendEvent({
      type: 'edit',
      item: item.id,
      by: ctx.actor,
      fields: changed,
    });
  });
}
