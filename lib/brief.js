import { nextStage, stageIndex } from './rules.js';
import { isTerminalStage } from './stages.js';
import { describeTerm } from './glossary.js';

function stageName(stages, id) {
  const stage = stages?.stages?.find((candidate) => candidate.id === id);
  if (stage?.label) return stage.label;
  if (stage?.id) return stage.id.split(/[-_\s]+/).filter(Boolean).map((part) => `${part[0].toUpperCase()}${part.slice(1)}`).join(' ');
  return id ?? 'unknown';
}
function terminal(item, stages) { return isTerminalStage(item.stage, stages ?? {}); }
function evidenceRule(stages) {
  const evidenceStage = (stages?.stages ?? []).findIndex((stage) => (
    stage.requires?.evidence_min !== undefined || stage.requires?.evidence_match !== undefined
  ));
  const precedingStage = stages?.stages?.[evidenceStage - 1];
  return precedingStage
    ? `       \`gw move\` needs evidence past ${stageName(stages, precedingStage.id)}. Never edit .gatewright/ by hand.`
    : '       `gw move` needs evidence where the stage requires it. Never edit .gatewright/ by hand.';
}
function rules(stages) {
  return [
    'Rules: use `gw add` for work someone else could pick up; checklists go in notes.',
    evidenceRule(stages),
  ];
}

function wrapLegend(text, wrapWidth) {
  // Wrap text on word boundaries to fit within wrapWidth.
  // Returns an array of wrapped lines (without any indentation prefix).
  const lines = [];
  const words = text.split(/\s+/);
  let currentLine = '';

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    if (testLine.length <= wrapWidth) {
      currentLine = testLine;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines;
}
function title(value, width = 54) {
  const text = String(value ?? '');
  return text.length <= width ? text.padEnd(width) : `${text.slice(0, Math.max(1, width - 1))}…`;
}
function row(item, stages, suffix, childCount = 0) {
  const id = String(item.id ?? '').padEnd(9);
  const children = childCount ? `  · ${childCount} open ${childCount === 1 ? 'child' : 'children'}` : '';
  return `  ${id}  ${title(item.title)}${suffix ? `  ${suffix}` : ''}${children}`.trimEnd();
}
function inFlightSuffix(item, stages) {
  return `${stageName(stages, item.stage).toLowerCase().padEnd(11)}${item.owner ?? 'unowned'}`;
}
// Active dispatch bookkeeping shared by renderBrief and inFlightTitles: an
// item is "active" from the moment it is dispatched until the run ends or is
// cancelled, independent of whether its stage or owner ever changed.
function computeActive(events) {
  const active = new Map();
  for (const event of events) {
    if (event.type === 'dispatch') active.set(event.item, true);
    if (event.type === 'run_ended' || event.type === 'cancel') active.delete(event.item);
  }
  return active;
}

// What "in flight" means: real progress has happened, not merely that someone
// claimed the card. Claiming an item sets item.owner but leaves its stage
// exactly where it was -- `gw claim` is a promise to work on something, not
// evidence that work started. So ownership alone no longer qualifies. What
// does: the item has moved past the stage it was created in (stageIndex > 0),
// which is a durable fact about work already done, or an agent is live on it
// right now (an active dispatch with no matching run_ended/cancel yet), which
// is true even for an item still sitting in its first stage. Either one is a
// claim a human can act on; "I claimed it" alone is not.
function isInFlight(item, stages, active) {
  return stageIndex(stages, item.stage) > 0 || active.has(item.id);
}

function depsReady(item, items, stages) {
  const byId = new Map(items.map((candidate) => [candidate.id, candidate]));
  const target = stages?.stages?.[stageIndex(stages, item.stage) + 1];
  const boundary = target?.requires?.deps_at_least ?? (item.deps?.length ? item.stage : null);
  return (item.deps ?? []).every((id) => {
    const dep = byId.get(id);
    return dep && (!boundary || stageIndex(stages, dep.stage) >= stageIndex(stages, boundary));
  });
}

export function renderBrief(state, options = {}) {
  const { items = [], events = [], stages = {}, config = {}, git = null } = state;
  const active = computeActive(events);
  const open = items.filter((item) => !terminal(item, stages));
  const openChildren = new Map();
  for (const child of open) if (child.parent) openChildren.set(child.parent, (openChildren.get(child.parent) ?? 0) + 1);
  const blocked = open.filter((item) => item.flag === 'blocked' || !depsReady(item, items, stages));
  const dispatched = open.filter((item) => active.has(item.id) && (!options.me || events.filter((event) => event.type === 'dispatch' && event.item === item.id).at(-1)?.by === options.me));
  const triage = open.filter((item) => item.flag === 'needs-triage');
  const inFlight = open.filter((item) => !dispatched.includes(item) && !blocked.includes(item) && item.flag !== 'needs-triage' && isInFlight(item, stages, active) && (!options.me || item.owner === options.me));
  const next = open.filter((item) => !dispatched.includes(item) && !blocked.includes(item) && !triage.includes(item) && !item.owner && stageIndex(stages, item.stage) <= 0 && depsReady(item, items, stages));
  const gitPart = git?.branch && git?.sha ? ` · ${git.branch}@${String(git.sha).slice(0, 7)}` : '';
  const lines = [`gw · ${open.length} open · ${inFlight.length + dispatched.length} in flight · ${blocked.length} blocked${gitPart}`];
  const sections = [
    ['DISPATCHED TO YOU', dispatched, (item) => `${stageName(stages, item.stage).toLowerCase()} → ${stageName(stages, nextStage(stages, item.stage)).toLowerCase()}`],
    ['IN FLIGHT', inFlight, (item) => inFlightSuffix(item, stages)],
    ['BLOCKED', blocked, (item) => { const dep = (item.deps ?? []).find((id) => !depsReady({ ...item, deps: [id] }, items, stages)); return dep ? `waiting on ${dep} (${stageName(stages, items.find((candidate) => candidate.id === dep)?.stage)})` : 'flagged blocked'; }],
    [`NEEDS TRIAGE (${triage.length})`, triage, (item) => `created by ${item.created_by}`],
    ['NEXT UNBLOCKED', next, (item) => `${item.phase ?? '-'} ${item.gate ?? '-'}`],
  ];
  const related = options.relatedMemory ?? [];
  const relatedLines = related.map((hit) => `  - (${hit.date ?? 'unknown'}) ${String(hit.text ?? '').replace(/\s+/g, ' ').trim()}`).filter((line) => line.length > 7);
  const totalMaxLines = Number(config.brief?.max_lines ?? 25);
  const maxLines = Math.max(1, totalMaxLines - (relatedLines.length ? relatedLines.length + 2 : 0));
  let remaining = Math.max(0, maxLines - 4); // header, separator, plus the two-line rules footer
  const budgetOrder = [sections[0], sections[2], sections[1], sections[3], sections[4]];
  const kept = budgetOrder.filter((section) => section[1].length);
  const minimumCost = (section) => 3 + (section[1].length > 1 ? 1 : 0); // blank, heading, one item, and marker
  while (kept.reduce((total, section) => total + minimumCost(section), 0) > remaining) kept.pop();
  remaining -= kept.reduce((total, section) => total + minimumCost(section), 0);
  const allocation = new Map(kept.map((section) => [section[0], { count: 1, marker: section[1].length > 1 }]));
  for (const section of budgetOrder) {
    const sectionAllocation = allocation.get(section[0]);
    if (!sectionAllocation) continue;
    const need = section[1].length - sectionAllocation.count;
    const markerCost = sectionAllocation.marker ? 0 : (need > 0 ? 1 : 0);
    const extra = Math.max(0, Math.min(need, remaining - markerCost));
    sectionAllocation.count += extra;
    remaining -= extra;
    if (sectionAllocation.count < section[1].length && !sectionAllocation.marker && remaining > 0) {
      sectionAllocation.marker = true;
      remaining -= 1;
    }
  }
  let emitted = false;
  // Only NEXT UNBLOCKED prints a bare phase/gate code (`P1 G0`), so that is
  // the only section worth a legend. One line naming every code actually
  // shown beats annotating each row -- annotating every row repeats the same
  // sentence once per item, while a legend pays for it once regardless of how
  // many rows share a code. A code with no glossary entry contributes nothing
  // here, same as everywhere else describeTerm is used.
  const legend = new Map();
  for (const [heading, candidates, suffix] of sections) {
    const sectionAllocation = allocation.get(heading);
    if (!sectionAllocation) continue;
    const shown = candidates.slice(0, sectionAllocation.count);
    lines.push('', heading, ...shown.map((item) => row(item, stages, suffix(item), openChildren.get(item.id))));
    if (sectionAllocation.marker && shown.length < candidates.length) lines.push(`  (+${candidates.length - shown.length} more)`);
    emitted = true;
    if (heading === 'NEXT UNBLOCKED') {
      for (const item of shown) {
        for (const field of ['phase', 'gate']) {
          const value = item[field];
          const description = describeTerm(config, field, value);
          if (description && !legend.has(value)) legend.set(value, description);
        }
      }
    }
  }
  if (!emitted) lines.push('', open.length ? 'No open work is ready yet.' : 'No open work. Add one with `gw add "title"`.');
  // The legend is help text, not core content: it only goes out if it fits in
  // what is left of the line budget (including the footer that always
  // follows it). Skipped rather than shrinking anything else -- the cap on
  // this digest matters more than completeness of the legend.
  const FOOTER_COST = 3; // blank line, 'Rules:' line, evidence-rule line
  if (legend.size && lines.length + 1 + FOOTER_COST <= maxLines) {
    lines.push(`Legend: ${[...legend].map(([code, description]) => `${code} = ${description}`).join(' · ')}`);
  }
  lines.push('', ...rules(stages));
  if (relatedLines.length) {
    const relatedCost = relatedLines.length + 2;
    lines.splice(Math.max(0, totalMaxLines - relatedCost));
    lines.push('', 'RELATED MEMORY', ...relatedLines);
  }
  return `${lines.join('\n')}\n`;
}

export function inFlightTitles({ items = [], events = [], stages = {} }) {
  const active = computeActive(events);
  return items.filter((item) => !terminal(item, stages) && isInFlight(item, stages, active)).map((item) => item.title).filter(Boolean);
}
