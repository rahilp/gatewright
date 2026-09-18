// JSON import.
//
// Accepts either a bare array or an object with an `items` array, because both
// are what people actually have: a `gw list --json` dump is the former, and an
// export from almost anything else wraps it.

// T-0061 — evidence entries arrive in two shapes, and both are legitimate: a
// `gw list --json` dump carries the on-disk `{ text, stage }` objects, while a
// hand-written file uses plain strings. Both are normalised here to the
// on-disk shape, because the previous string-only filter threw away every
// entry of a dump — the importer then downgraded finished work and told the
// user the file "needs at least one new piece of evidence" about evidence it
// had just discarded. A `stage` tag is preserved: it is what lets a gate
// count the entry for the stage whose move supplied it. An entry without one
// is the migrated legacy shape (`lib/store.js` reads pre-T-0029 boards into
// exactly that), and `lib/rules.js` alone decides what such an entry may
// satisfy — import adds no second opinion. An entry that is neither a string
// nor a `{ text, stage? }` object fails the row with a reason, like any other
// malformed row (T-0053): half-importing an item's evidence in silence is the
// very bug this fixes.
function evidenceEntries(raw) {
  const entries = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      const text = entry.trim();
      if (text) entries.push({ text, stage: null });
      continue;
    }
    const stage = entry?.stage;
    if (entry && typeof entry === 'object' && !Array.isArray(entry)
      && typeof entry.text === 'string'
      && (stage === undefined || stage === null || typeof stage === 'string')) {
      const text = entry.text.trim();
      if (text) entries.push({ text, stage: stage ?? null });
      continue;
    }
    return { error: `invalid evidence entry: ${JSON.stringify(entry)}` };
  }
  return { entries };
}

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
    // T-0053 — deps may arrive as an array or as a comma-separated string;
    // both are common in exports. A non-string entry inside the array used to
    // be filtered out in silence — `[7, "T-0001"]` imported as `["T-0001"]`
    // with no trace of the `7`. Now the whole row is skipped with the reason
    // and its line number, exactly like a row with an unknown dependency:
    // half-importing the surviving string deps would look like a clean
    // import while the item silently lost a constraint it declared.
    const rawDeps = Array.isArray(record.deps) ? record.deps : null;
    const nonStrings = rawDeps ? rawDeps.filter((entry) => typeof entry !== 'string') : [];
    if (nonStrings.length) {
      skipped.push({ line: index + 1, text: JSON.stringify(record).slice(0, 80), reason: `non-string dependency: ${nonStrings.join(', ')}` });
      return;
    }
    const deps = rawDeps
      ? rawDeps.map((entry) => entry.trim()).filter(Boolean)
      : typeof record.deps === 'string'
        ? record.deps.split(/[,;]/).map((entry) => entry.trim()).filter(Boolean)
        : [];
    const rawEvidence = Array.isArray(record.evidence)
      ? record.evidence
      : typeof record.evidence === 'string'
        ? record.evidence.split(/[,;]/)
        : null;
    let evidence = [];
    if (rawEvidence) {
      const result = evidenceEntries(rawEvidence);
      if (result.error) {
        skipped.push({ line: index + 1, text: JSON.stringify(record).slice(0, 80), reason: result.error });
        return;
      }
      evidence = result.entries;
    }
    items.push({
      // The record's ordinal, kept only for import's skip report; never
      // written to the board (fullItems maps explicit fields).
      line: index + 1,
      id,
      title,
      phase: record.phase ?? null,
      // Never inferred from phase; see lib/import/csv.js.
      priority: record.priority ?? null,
      type: record.type ?? null,
      stage: typeof record.stage === 'string' && record.stage ? record.stage : 'initial',
      scope: typeof record.scope === 'string' ? record.scope : '',
      // T-0061 — a dump carries the owner a claim recorded, and the building
      // gate requires one: dropping it would downgrade every claimed item on
      // import for an owner the file plainly named. A file that names no
      // owner imports unowned and faces that gate honestly.
      owner: typeof record.owner === 'string' && record.owner.trim() ? record.owner.trim() : null,
      deps,
      // Carried through, not dropped: evidence is what earns a stage, so
      // losing it silently downgrades every finished item on import and the
      // user is told their board "needs at least 1 evidence entry" about work
      // that plainly had some. A `gw list --json` dump must round-trip.
      evidence,
    });
  });

  return { items, skipped };
}
