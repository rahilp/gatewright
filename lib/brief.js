import { nextStage, stageIndex } from './rules.js';
import { isTerminalStage } from './stages.js';

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
function title(value, width = 54) {
  const text = String(value ?? '');
  return text.length <= width ? text.padEnd(width) : `${text.slice(0, Math.max(1, width - 1))}…`;
}
function row(item, stages, suffix) {
  const id = String(item.id ?? '').padEnd(9);
  return `  ${id}  ${title(item.title)}${suffix ? `  ${suffix}` : ''}`.trimEnd();
}
function inFlightSuffix(item, stages) {
  return `${stageName(stages, item.stage).toLowerCase().padEnd(11)}${item.owner ?? 'unowned'}`;
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
  const active = new Map();
  for (const event of events) {
    if (event.type === 'dispatch') active.set(event.item, true);
    if (event.type === 'run_ended' || event.type === 'cancel') active.delete(event.item);
  }
  const open = items.filter((item) => !terminal(item, stages));
  const blocked = open.filter((item) => item.flag === 'blocked' || !depsReady(item, items, stages));
  const dispatched = open.filter((item) => active.has(item.id) && (!options.me || events.filter((event) => event.type === 'dispatch' && event.item === item.id).at(-1)?.by === options.me));
  const triage = open.filter((item) => item.flag === 'needs-triage');
  const inFlight = open.filter((item) => !dispatched.includes(item) && !blocked.includes(item) && item.flag !== 'needs-triage' && (item.owner || stageIndex(stages, item.stage) > 0) && (!options.me || item.owner === options.me));
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
  const maxLines = Number(config.brief?.max_lines ?? 25);
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
  for (const [heading, candidates, suffix] of sections) {
    const sectionAllocation = allocation.get(heading);
    if (!sectionAllocation) continue;
    const shown = candidates.slice(0, sectionAllocation.count);
    lines.push('', heading, ...shown.map((item) => row(item, stages, suffix(item))));
    if (sectionAllocation.marker && shown.length < candidates.length) lines.push(`  (+${candidates.length - shown.length} more)`);
    emitted = true;
  }
  if (!emitted) lines.push('', open.length ? 'No open work is ready yet.' : 'No open work. Add one with `gw add "title"`.');
  lines.push('', ...rules(stages));
  return `${lines.join('\n')}\n`;
}
