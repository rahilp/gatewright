import { UsageError } from './cli/errors.js';

// Both creation and editing accept the same vocab-backed fields. Keeping the
// message here prevents an agent seeing different recovery advice per command.
export function validateVocab(config, flags, fields) {
  for (const field of fields) {
    const allowed = config.vocab?.[field];
    if (
      flags[field] !== undefined
      && Array.isArray(allowed)
      && !allowed.includes(flags[field])
    ) {
      throw new UsageError(
        `invalid --${field} '${flags[field]}'; allowed values: ${allowed.join(', ')}`,
      );
    }
  }
}

// The fields a vocabulary governs. Declared once so `add`, `edit` and `check`
// cannot disagree about what is vocabulary-controlled.
export const VOCAB_FIELDS = ['type', 'phase', 'priority', 'gate'];

// Validation at creation time is not enough on its own. `add` and `edit`
// refuse a bad value, but a direct file write, an import, or simply narrowing
// a vocabulary later leaves items holding values the config no longer allows
// -- and `check` exists precisely to catch what happened outside the CLI.
//
// Grouped by value rather than reported per item on purpose: this repo's own
// board carried 33 items with an out-of-vocab priority, and 33 near-identical
// lines would bury every other finding in the report. One line per offending
// value, with the count, says the same thing and stays readable.
export function vocabDrift(config, items) {
  const findings = [];
  for (const field of VOCAB_FIELDS) {
    const allowed = config.vocab?.[field];
    if (!Array.isArray(allowed) || !allowed.length) continue;
    const counts = new Map();
    for (const item of items) {
      const value = item[field];
      if (value === null || value === undefined || allowed.includes(value)) continue;
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    for (const [value, count] of [...counts].sort((a, b) => b[1] - a[1])) {
      findings.push({
        field,
        value,
        count,
        // Both remedies, because only the user knows which is true: the
        // vocabulary is too narrow, or the items are wrong.
        fix: `${count} item${count === 1 ? '' : 's'} have ${field} ${JSON.stringify(value)}, which is not in vocab.${field} (${allowed.join(', ')}). Either widen it with \`gw config vocab.${field} "${[...allowed, value].join(',')}"\` or correct the items with \`gw edit <id> --${field} <value>\`.`,
      });
    }
  }
  return findings;
}
