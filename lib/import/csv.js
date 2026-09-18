// CSV import.
//
// Hand-written rather than pulled from npm because the package promises zero
// runtime dependencies, and hand-written to RFC 4180 rather than
// `line.split(',')` because the first realistic export anyone tries -- a
// spreadsheet with a comma in a title, or a scope containing a newline --
// silently produces garbage under the naive version. Corrupting an import is
// worse than refusing one.

// Returns rows of raw string cells. A quoted field may contain commas,
// newlines, and doubled quotes; everything outside quotes is literal.
export function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let started = false;

  // A trailing newline should not manufacture an empty final row, but a file
  // with no trailing newline must still yield its last row.
  const input = text.replace(/^﻿/, '');

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') { field += '"'; i += 1; } else { quoted = false; }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && field === '') { quoted = true; started = true; continue; }
    if (char === ',') { row.push(field); field = ''; started = true; continue; }
    if (char === '\r') continue;
    if (char === '\n') {
      if (started || field !== '' || row.length) { row.push(field); rows.push(row); }
      row = []; field = ''; started = false;
      continue;
    }
    field += char;
    started = true;
  }
  if (started || field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const ALIASES = new Map([
  ['id', 'id'], ['title', 'title'], ['name', 'title'], ['summary', 'title'],
  ['phase', 'phase'], ['priority', 'priority'], ['type', 'type'],
  ['stage', 'stage'], ['status', 'stage'], ['scope', 'scope'], ['description', 'scope'],
  ['deps', 'deps'], ['depends_on', 'deps'], ['dependencies', 'deps'], ['blocked_by', 'deps'],
  ['evidence', 'evidence'], ['links', 'evidence'],
]);

function normalizeHeader(cell) {
  return ALIASES.get(cell.trim().toLowerCase().replace(/[\s-]+/g, '_')) ?? null;
}

export function parseCsv(text) {
  const rows = parseCsvRows(text);
  const items = [];
  const skipped = [];
  if (!rows.length) return { items, skipped };

  const header = rows[0].map(normalizeHeader);
  if (!header.includes('id') || !header.includes('title')) {
    // Named explicitly: a header this parser cannot understand is the single
    // most likely reason an import produces nothing, and "0 imported" on its
    // own tells the user nothing about why.
    const seen = rows[0].map((cell) => cell.trim()).filter(Boolean).join(', ');
    return { items, skipped, error: `csv needs at least an "id" and a "title" column; found: ${seen || '(no header row)'}` };
  }

  for (let r = 1; r < rows.length; r += 1) {
    const cells = rows[r];
    if (cells.every((cell) => cell.trim() === '')) continue;
    const record = {};
    header.forEach((field, index) => { if (field) record[field] = (cells[index] ?? '').trim(); });

    if (!record.id || !record.title) {
      skipped.push({ line: r + 1, text: cells.join(','), reason: 'missing id or title' });
      continue;
    }
    items.push({
      // The physical file line, kept only for import's skip report; never
      // written to the board (fullItems maps explicit fields).
      line: r + 1,
      id: record.id,
      title: record.title,
      phase: record.phase || null,
      // Never inferred from phase. They are different questions, and copying
      // one into the other is what put 33 items on this project's own board
      // holding a priority no vocabulary allowed.
      priority: record.priority || null,
      type: record.type || null,
      stage: record.stage || 'initial',
      scope: record.scope || '',
      deps: record.deps ? record.deps.split(/[,;]/).map((entry) => entry.trim()).filter(Boolean) : [],
      // See lib/import/json.js: evidence is what earns a stage, so dropping it
      // downgrades finished work and blames the user for it.
      evidence: record.evidence ? record.evidence.split(/[,;]/).map((entry) => entry.trim()).filter(Boolean) : [],
    });
  }
  return { items, skipped };
}
