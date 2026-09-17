// Parser for Gatewright's tasks.md format.
// Phase is set by the nearest preceding `## P<n> — ...` heading.
// Each item line looks like:
//   - **ID** · title · type · gate · deps · done when
// The fourth column is a holdover from when items carried a `gate` field
// (P0-15 removed it: it duplicated priority and no rule ever read it). The
// column is still parsed here -- so existing tasks.md files never need to be
// rewritten -- and simply discarded rather than attached to the item.
// The first five `·` separators split the fixed fields; everything after the
// fifth separator is the scope (done-when text) and keeps its `·` characters.

const PHASE_HEADING_RE = /^##\s+(P\d+)\b/;
const PARKING_LOT_RE = /^##\s+Parking lot\b/i;
const SEPARATOR = '·';

// Split after exactly the first five separators. Returns null if fewer than
// five separators exist.
function splitItemLine(line) {
  let pos = -1;
  for (let n = 0; n < 5; n += 1) {
    const next = line.indexOf(SEPARATOR, pos + 1);
    if (next === -1) return null;
    pos = next;
  }
  const prefix = line.slice(0, pos);
  const scope = line.slice(pos + 1);
  const [idRaw, titleRaw, typeRaw, gateRaw, depsRaw] = prefix.split(SEPARATOR);
  return {
    idRaw: idRaw.trim(),
    title: titleRaw.trim(),
    type: typeRaw.trim(),
    gate: gateRaw.trim(),
    depsText: depsRaw.trim(),
    scope,
  };
}

export function inferStage(scope) {
  const s = scope.trim();
  if (s.startsWith('**Decided:**') || s.endsWith('✅')) return 'done';
  return 'initial';
}

export function parseMarkdown(text) {
  const items = [];
  const skipped = [];
  const lines = text.split('\n');
  let phase = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    const phaseMatch = line.match(PHASE_HEADING_RE);
    if (phaseMatch) {
      phase = phaseMatch[1];
      continue;
    }

    if (PARKING_LOT_RE.test(line)) {
      phase = null;
      continue;
    }

    if (phase === null) continue;
    if (!line.trimStart().startsWith('- ')) continue;

    const split = splitItemLine(line);
    if (!split) {
      skipped.push({ line: i + 1, text: line, reason: 'expected 6 fields separated by ·' });
      continue;
    }

    const { idRaw, title, type, depsText, scope: rawScope } = split;
    const scope = rawScope.trim();

    const idMatch = idRaw.match(/\*\*([^*]+)\*\*/);
    if (!idMatch) {
      skipped.push({ line: i + 1, text: line, reason: 'id not wrapped in **' });
      continue;
    }

    const id = idMatch[1].trim();
    const deps = (depsText === '' || depsText === '—' || depsText === '-')
      ? []
      : depsText.split(',').map((s) => s.trim()).filter(Boolean);

    if (!id || !title || !type) {
      skipped.push({ line: i + 1, text: line, reason: 'missing required field' });
      continue;
    }

    items.push({
      id,
      title,
      phase,
      // NOT `priority: phase`. The markdown format has no priority column, and
      // copying the phase into it put 33 items on this project's own board
      // holding a priority no vocabulary allowed -- which `gw check` then
      // reported, correctly, as drift. An absent field is null.
      priority: null,
      type,
      stage: inferStage(scope),
      scope,
      deps,
    });
  }

  return { items, skipped };
}
