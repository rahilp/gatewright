export function nextId(items, { scheme = 'phase-seq', phase, parent } = {}) {
  if (scheme !== 'phase-seq') throw new Error(`unsupported id scheme: ${scheme}`);
  if (parent) {
    const prefix = `${parent}.`;
    const highest = items.reduce((n, item) => {
      if (!item.id?.startsWith(prefix)) return n;
      const suffix = item.id.slice(prefix.length);
      return /^\d+$/.test(suffix) ? Math.max(n, Number(suffix)) : n;
    }, 0);
    return `${parent}.${highest + 1}`;
  }
  const re = new RegExp(`^${String(phase).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)$`);
  const highest = items.reduce((n, item) => {
    const match = item.id?.match(re); return match ? Math.max(n, Number(match[1])) : n;
  }, 0);
  return `${phase}-${String(highest + 1).padStart(2, '0')}`;
}
