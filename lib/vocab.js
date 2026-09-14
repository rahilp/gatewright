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
