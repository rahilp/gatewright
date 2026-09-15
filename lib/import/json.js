// JSON import.
//
// Accepts either a bare array or an object with an `items` array, because both
// are what people actually have: a `gw list --json` dump is the former, and an
// export from almost anything else wraps it.
export function parseJson(text) {
  const items = [];
  const skipped = [];

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { items, skipped, error: `file is not valid JSON: ${error.message}` };
  }

  const records = Array.isArray(parsed) ? parsed : parsed?.items;
  if (!Array.isArray(records)) {
    return { items, skipped, error: 'expected a JSON array of items, or an object with an "items" array' };
  }

  records.forEach((record, index) => {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      skipped.push({ line: index + 1, text: JSON.stringify(record), reason: 'not an object' });
      return;
    }
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const title = typeof record.title === 'string' ? record.title.trim() : '';
    if (!id || !title) {
      skipped.push({ line: index + 1, text: JSON.stringify(record).slice(0, 80), reason: 'missing id or title' });
      return;
    }
    // deps may arrive as an array or as a comma-separated string; both are
    // common in exports, and neither is worth refusing an import over.
    const deps = Array.isArray(record.deps)
      ? record.deps.filter((entry) => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean)
      : typeof record.deps === 'string'
        ? record.deps.split(/[,;]/).map((entry) => entry.trim()).filter(Boolean)
        : [];
    items.push({
      id,
      title,
      phase: record.phase ?? null,
      // Never inferred from phase; see lib/import/csv.js.
      priority: record.priority ?? null,
      gate: record.gate ?? null,
      type: record.type ?? null,
      stage: typeof record.stage === 'string' && record.stage ? record.stage : 'initial',
      scope: typeof record.scope === 'string' ? record.scope : '',
      deps,
      // Carried through, not dropped: evidence is what earns a stage, so
      // losing it silently downgrades every finished item on import and the
      // user is told their board "needs at least 1 evidence entry" about work
      // that plainly had some. A `gw list --json` dump must round-trip.
      evidence: Array.isArray(record.evidence)
        ? record.evidence.filter((entry) => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean)
        : typeof record.evidence === 'string'
          ? record.evidence.split(/[,;]/).map((entry) => entry.trim()).filter(Boolean)
          : [],
    });
  });

  return { items, skipped };
}
