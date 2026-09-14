import { UsageError } from './cli/errors.js';

const SUPPORTED_SCHEMES = ['phase-seq', 'seq'];

export function nextId(items, { scheme = 'phase-seq', phase, parent } = {}) {
  if (!SUPPORTED_SCHEMES.includes(scheme)) {
    throw new UsageError(`unsupported id scheme: ${scheme}; supported schemes: ${SUPPORTED_SCHEMES.join(', ')}`);
  }
  if (parent) {
    const prefix = `${parent}.`;
    const highest = items.reduce((n, item) => {
      if (!item.id?.startsWith(prefix)) return n;
      const suffix = item.id.slice(prefix.length);
      return /^\d+$/.test(suffix) ? Math.max(n, Number(suffix)) : n;
    }, 0);
    return `${parent}.${highest + 1}`;
  }
  if (scheme === 'phase-seq' && (phase === null || phase === undefined)) {
    throw new UsageError('phase-seq requires a phase; pass --phase, configure vocab.phase, or set id_scheme to seq.');
  }
  const prefix = scheme === 'seq' ? 'T' : phase;
  const width = scheme === 'seq' ? 4 : 2;
  const re = new RegExp(`^${String(prefix).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)$`);
  const highest = items.reduce((n, item) => {
    const match = item.id?.match(re); return match ? Math.max(n, Number(match[1])) : n;
  }, 0);
  return `${prefix}-${String(highest + 1).padStart(width, '0')}`;
}
