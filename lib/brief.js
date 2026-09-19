import { nextStage, stageIndex } from './rules.js';
import { isDropped, isTerminalStage, resolveRoles } from './stages.js';
import { describeTerm } from './glossary.js';
import { sameOwner } from './owner.js';
import { triageAdvice } from './owner.js';

function stageName(stages, id) {
  const stage = stages?.stages?.find((candidate) => candidate.id === id);
  if (stage?.label) return stage.label;
  if (stage?.id) return stage.id.split(/[-_\s]+/).filter(Boolean).map((part) => `${part[0].toUpperCase()}${part.slice(1)}`).join(' ');
  return id ?? 'unknown';
}
function terminal(item, stages) { return isTerminalStage(item.stage, stages ?? {}); }
// T-0038 — this used to name "the stage before the first evidence gate",
// which reads as "everything past here needs evidence". That was false for
// the shipped pipeline (reviewed asks for nothing, merged only for
// dependency depth) and would stay false for any pipeline whose evidence
// stages are non-contiguous. The spec wording (§6.1) names no stage for the
// same reason: the rule is conditional, and `gw next <id>` is what names the
// actual gate on a real item. A constant is the only honest form.
const EVIDENCE_RULE = '       Gates ask for evidence where a stage\'s rules require it: `gw next <id>` names the gate. Never edit .gatewright/ by hand.';
function rules(stages, finished = 0) {
  const lines = [
    'Rules: use `gw add` for work someone else could pick up; checklists go in notes.',
  ];
  // T-0066 — finished work used to vanish from the brief the moment it
  // reached a terminal stage, and nothing on this digest said where it went.
  // One footer line, only when there is finished work to find. The stage it
  // names is the board's own done stage: on a foreign pipeline a hardcoded
  // `verified` names a stage the board does not have (the exact T-0038
  // disease this footer sits beside). It slots between the two standing
  // rules so the footer still ends with the evidence rule, as it always has.
  if (finished) {
    const done = resolveRoles(stages).done ?? 'verified';
    lines.push(`       Finished work is out of the open counts: \`gw list --stage ${done}\` lists it.`);
  }
  lines.push(EVIDENCE_RULE);
  return lines;
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
// The width of an item row's title column. Named because more than one thing
// depends on it: the rows themselves and the legend that wraps beneath them.
export const TITLE_WIDTH = 54;

// Text rendering's last line of defence (T-0009): whatever a title holds,
// one item must render as one row. A newline in a stored title -- possible
// from data written before `gw add` refused it -- used to split the row and
// render the continuation with no id or stage, reading as a separate item.
// Input validation stops new bad titles; this stops the old ones from
// breaking every table that prints them.
export function sanitizeTitle(value) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ');
}

// An item row is: 2 indent + 9 id + 2 gap + title + a margin for the suffix
// column. The legend wraps to the same total so it reads as part of the block
// rather than overhanging it.
const ROW_WIDTH = 2 + 9 + 2 + TITLE_WIDTH + 9;

function title(value, width = TITLE_WIDTH) {
  const text = sanitizeTitle(value);
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

// T-0019 — the same active-dispatch bookkeeping the brief draws from, as data:
// items carrying a dispatch with no matching run_ended/cancel yet. With the
// runner disabled nothing will ever end such a run, so a queued dispatch is a
// state nothing will ever pick up; `gw check` uses this to make it visible.
export function outstandingDispatches(events = []) {
  return [...computeActive(events).keys()];
}

// What "in flight" means: owned work that has actually moved beyond the
// initial stage. A claim alone is a promise, not progress; conversely, an
// unowned card left mid-pipeline is abandoned work, not something anyone is
// currently doing. A live dispatch is the narrow exception: it is presently
// running even before the item has a durable owner/stage state.
function isInFlight(item, stages, active) {
  return (Boolean(item.owner) && stageIndex(stages, item.stage) > 0) || active.has(item.id);
}

// The five buckets the rendered brief draws from. Exported because `gw brief
// --json` must answer the same question the text answers: a script asking
// "what is blocked right now" cannot be left to re-derive "in flight" or
// "blocked" from raw items, because a second definition of those words is how
// the JSON and the human text have disagreed before.
export function computeBuckets(state, options = {}) {
  const { items = [], events = [], stages = {} } = state;
  const active = computeActive(events);
  const rawOpen = items.filter((item) => !terminal(item, stages));
  const dispatched = rawOpen.filter((item) => {
    if (!active.has(item.id)) return false;
    // T-0069 — the last dispatch's actor decides, compared with the same
    // owner rule every other section uses, so `--me rahil` matches a
    // dispatch recorded as `human:rahil`.
    const lastBy = events.filter((event) => event.type === 'dispatch' && event.item === item.id).at(-1)?.by;
    return !options.me || sameOwner(lastBy, options.me);
  });
  // T-0069 — one definition of "this section is about me": ownership, with
  // sameOwner tolerating a bare name against its qualified form, and a live
  // dispatch to the actor counting as theirs (a dispatched card can be
  // unowned). Every section filters through it, so `gw brief --me` cannot
  // print a board that looks exactly like the unfiltered one.
  const isMine = (item) => !options.me || sameOwner(item.owner, options.me) || dispatched.includes(item);
  const open = rawOpen.filter(isMine);
  const blocked = rawOpen.filter((item) => (item.flag === 'blocked' || !depsReady(item, items, stages)) && isMine(item));
  const triage = rawOpen.filter((item) => item.flag === 'needs-triage' && isMine(item));
  // T-0066 — needs-triage used to be excluded here, so an item someone had
  // claimed AND moved to building read as "0 in flight" in the headline:
  // the hold is a review requirement, not evidence that work stopped.
  // The rule now is observable reality: an item with an owner, in a
  // non-initial non-terminal stage, is in flight.
  const inFlight = rawOpen.filter((item) => !dispatched.includes(item) && !blocked.includes(item) && isInFlight(item, stages, active) && isMine(item));
  // T-0091 — releasing an item after it has moved leaves real, actionable
  // work behind, but it is neither in flight nor a new pick-up candidate.
  // Name it explicitly instead of letting it disappear from this cheap poll.
  const stranded = rawOpen.filter((item) => !dispatched.includes(item) && !blocked.includes(item) && !triage.includes(item) && !item.owner && stageIndex(stages, item.stage) > 0 && isMine(item));
  const next = rawOpen.filter((item) => !dispatched.includes(item) && !blocked.includes(item) && !triage.includes(item) && !stranded.includes(item) && !item.owner && stageIndex(stages, item.stage) <= 0 && depsReady(item, items, stages) && isMine(item));
  return { open, dispatched, blocked, triage, inFlight, stranded, next };
}

// T-0020 — THE definition of "flagged", in one place. This repo has already
// shipped two bugs from the CLI and the viewer holding separate definitions
// of "terminal" and "in flight"; a third from a duplicated definition of
// "flagged" is exactly what this export prevents. An item is flagged when it
// carries a literal flag (any value the board's flag filter offers: blocked,
// needs-triage, paused, conflict) or when it sits in the paused-role stage
// without a flag -- `gw move <id> paused` parks work without writing a flag,
// so a count that reads only item.flag misses it while the filter's "paused"
// option promises it exists.
export function isFlagged(item, stages = {}) {
  if (item.flag) return true;
  const roles = resolveRoles(stages);
  return roles.paused !== null && item.stage === roles.paused;
}

export function flaggedItems(items, stages = {}) {
  return items.filter((item) => isFlagged(item, stages));
}

// The one dependency an item is waiting on, or null when it is blocked only
// because it carries the flag. Shared by the rendered BLOCKED suffix and the
// `blocked` entries of brief --json, so both name the same dependency.
export function blockedDep(item, items, stages) {
  return (item.deps ?? []).find((id) => !depsReady({ ...item, deps: [id] }, items, stages)) ?? null;
}

// The rendered BLOCKED suffix: the same dependency blockedDep names, plus the
// stage that dependency sits in. Kept beside blockedDep so the text and the
// JSON cannot drift apart.
function blockedSuffix(item, items, stages) {
  const dep = blockedDep(item, items, stages);
  if (!dep) return 'flagged blocked';
  const depStage = stageName(stages, items.find((candidate) => candidate.id === dep)?.stage);
  // T-0073 — when the dependency in the way can never advance, the suffix
  // must not dead-end on a fact; it names the edit that removes exactly the
  // stranded dependencies and keeps the live ones.
  const fix = strandedDepFix(item, items, stages);
  return `waiting on ${dep} (${depStage})${fix ? ` — run \`${fix}\`` : ''}`;
}

// T-0073 — the fix command for an item stranded behind a dependency that
// cannot advance (dropped, or terminal by any other route — and a dependency
// missing from the board is stranded the same way). The only way out is to
// edit the deps, and the advice has to be right, not just present: the item
// may have OTHER deps that must survive, so the command lists them. `--deps
// ""` is what the command says only when the stranded dependency was the
// last one. Shared by `gw brief`'s BLOCKED rows and `gw next`'s waiting-on
// line, so the two cannot drift. Returns null when the blocking dependency
// is alive and merely behind — there `gw move <dep>` is the right advice,
// and the deps_at_least gate refusal already names it.
export function strandedDepFix(item, items, stages) {
  const blocking = (item.deps ?? []).filter((id) => !depsReady({ ...item, deps: [id] }, items, stages));
  if (!blocking.length) return null;
  const byId = new Map(items.map((candidate) => [candidate.id, candidate]));
  const stranded = blocking.filter((id) => {
    const dep = byId.get(id);
    return !dep || isTerminalStage(dep.stage, stages);
  });
  if (!stranded.length) return null;
  const kept = (item.deps ?? []).filter((id) => !stranded.includes(id));
  return `gw edit ${item.id} --deps ${kept.length ? kept.join(',') : '""'}`;
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

// T-0088 — after a hand edit, `gw check` reported OUT-OF-BAND WRITE while
// brief listed normally, list presented the forged item as legitimate and next
// said "terminal stage": the one surface that knew was the one surface nobody
// runs. Every read surface carries the same one line so the knowledge cannot
// live in a command nobody invokes. One line, because brief is polled; naming
// the file keeps the line answerable and `gw check` is the way to details.
export function tamperBanner(digest) {
  if (!digest || digest.status !== 'modified') return null;
  const files = (digest.files ?? []).join(', ');
  return `warning: this board was modified outside gw${files ? ` (${files})` : ''}; run \`gw check\``;
}

export function renderBrief(state, options = {}) {
  const { items = [], stages = {}, config = {}, git = null } = state;
  const { open, dispatched, blocked, triage, inFlight, stranded, next } = computeBuckets(state, options);
  // T-0066 — finished work is real headline news: a fresh agent whose first
  // command is `gw brief` must be able to tell that work already happened.
  // Dropped is not finished — it is work thrown away — so it does not count.
  const roles = resolveRoles(stages);
  const finished = items.filter((item) => isTerminalStage(item.stage, stages, roles) && !isDropped(item, roles)).length;
  const openChildren = new Map();
  for (const child of open) if (child.parent) openChildren.set(child.parent, (openChildren.get(child.parent) ?? 0) + 1);
  const gitPart = git?.branch && git?.sha ? ` · ${git.branch}@${String(git.sha).slice(0, 7)}` : '';
  const finishedPart = finished ? ` · ${finished} finished` : '';
  const warning = tamperBanner(state.digest);
  const lines = [
    `gw · ${open.length} open · ${inFlight.length + dispatched.length} in flight · ${blocked.length} blocked${finishedPart}${gitPart}`,
    ...(warning ? [warning] : []),
  ];
  const sections = [
    ['DISPATCHED TO YOU', dispatched, (item) => `${stageName(stages, item.stage).toLowerCase()} → ${stageName(stages, nextStage(stages, item.stage)).toLowerCase()}`],
    ['IN FLIGHT', inFlight, (item) => inFlightSuffix(item, stages)],
    ['STRANDED', stranded, (item) => `${stageName(stages, item.stage).toLowerCase()} · unowned`],
    ['BLOCKED', blocked, (item) => blockedSuffix(item, items, stages)],
    // T-0036 — a NEEDS TRIAGE row with no instruction attached sends the
    // reader hunting for how to clear the hold. `gw check` names the command
    // that works (T-0039); the brief's rows do the same. The flag's meaning —
    // someone other than the creator must approve — lives in the agents block.
    [`NEEDS TRIAGE (${triage.length})`, triage, (item) => `created by ${item.created_by ?? 'an unknown actor'} — ${triageAdvice(item, options.actor)}`],
    ['NEXT UNBLOCKED', next, (item) => `${item.phase ?? '-'}`],
  ];
  const related = options.relatedMemory ?? [];
  const relatedLines = related.map((hit) => `  - (${hit.date ?? 'unknown'}) ${String(hit.text ?? '').replace(/\s+/g, ' ').trim()}`).filter((line) => line.length > 7);
  const totalMaxLines = Number(config.brief?.max_lines ?? 25);
  const maxLines = Math.max(1, totalMaxLines - (relatedLines.length ? relatedLines.length + 2 : 0));
  const footer = rules(stages, finished);
  let remaining = Math.max(0, maxLines - (2 + (warning ? 1 : 0) + footer.length)); // header, warning, blank line, plus the footer
  const budgetOrder = [sections[0], sections[3], sections[1], sections[2], sections[4], sections[5]];
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
  // Only NEXT UNBLOCKED prints a bare phase code (`P1`), so that is the only
  // section worth a legend. One line naming every code actually shown beats
  // annotating each row -- annotating every row repeats the same sentence
  // once per item, while a legend pays for it once regardless of how many
  // rows share a code. A code with no glossary entry contributes nothing
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
        const value = item.phase;
        const description = describeTerm(config, 'phase', value);
        if (description && !legend.has(value)) legend.set(value, description);
      }
    }
  }
  if (!emitted) {
    // T-0012 — an empty board and a finished board both printed "No open
    // work", telling a team that just shipped everything that nothing was
    // ever here. Acknowledge the finished work instead.
    // T-0069 — under --me the same silence would read as "the board is
    // empty" when it only means "none of it is mine": say whose view this
    // is and point back at the whole board.
    const boardFinished = items.length - items.filter((item) => !terminal(item, stages)).length;
    if (options.me && !open.length && items.some((item) => !terminal(item, stages))) {
      lines.push('', `Nothing open is owned by ${options.me}. Run \`gw brief\` for the whole board.`);
    } else {
      lines.push('', open.length
        ? 'No open work is ready yet.'
        : (boardFinished
          ? `All ${boardFinished} item(s) are finished. Start new work with \`gw add "title"\`.`
          : 'No open work. Add one with `gw add "title"`.'));
    }
  }
  // The legend is help text, not core content: it only goes out if it fits in
  // what is left of the line budget (including the footer that always
  // follows it). Skipped rather than shrinking anything else -- the cap on
  // this digest matters more than completeness of the legend.
  const FOOTER_COST = footer.length + 1; // blank line, then the rules lines
  if (legend.size) {
    const legendText = [...legend].map(([code, description]) => `${code} = ${description}`).join(' · ');
    // Derived from the row layout rather than restated, so widening the title
    // column moves the legend with it instead of leaving it overhanging.
    const WRAP_WIDTH = ROW_WIDTH;
    const firstLineWidth = WRAP_WIDTH - 'Legend: '.length; // Account for "Legend: " prefix
    const wrappedLines = wrapLegend(legendText, firstLineWidth);

    // Check if wrapped legend fits against the budget (first line is implicit in empty slot)
    if (wrappedLines.length > 0 && lines.length + wrappedLines.length + FOOTER_COST <= maxLines) {
      lines.push(`Legend: ${wrappedLines[0]}`);
      // Indent continuation lines with 7 spaces to align with the text after "Legend: "
      for (let i = 1; i < wrappedLines.length; i++) {
        lines.push(`       ${wrappedLines[i]}`);
      }
    }
  }
  lines.push('', ...footer);
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

// T-0032 — `gw brief --json` is what an agent polls, and it used to ship the
// database: the whole event log, the whole config, and a duplicate of the
// human text, ~33x the size of the text on a 100-item board. This returns the
// brief instead — the same buckets, the same titles, the same waiting-on
// facts the text conveys, structured. It is built from computeBuckets and
// the same helpers renderBrief draws from, so the JSON and the text cannot
// disagree about what "in flight" or "blocked" means, the way the buckets
// already cannot.
export function briefJson(state, options = {}) {
  const { items = [], stages = {}, git = null } = state;
  const { open, dispatched, blocked, triage, inFlight, stranded, next } = computeBuckets(state, options);
  const byId = new Map(items.map((item) => [item.id, item]));

  const roles = resolveRoles(stages);
  const finished = items.filter((item) => isTerminalStage(item.stage, stages, roles) && !isDropped(item, roles)).length;
  const payload = {
    open: open.length,
    in_flight: inFlight.length + dispatched.length,
    blocked: blocked.length,
    finished,
    git: git?.branch && git?.sha ? git : null,
    dispatched: dispatched.map((item) => ({ id: item.id, title: sanitizeTitle(item.title), stage: item.stage, next_stage: nextStage(stages, item.stage), owner: item.owner ?? null })),
    in_flight: inFlight.map((item) => ({ id: item.id, title: sanitizeTitle(item.title), stage: item.stage, owner: item.owner ?? null })),
    stranded: stranded.map((item) => ({ id: item.id, title: sanitizeTitle(item.title), stage: item.stage })),
    blocked: blocked.map((item) => {
      const waitingOn = blockedDep(item, items, stages);
      const fix = strandedDepFix(item, items, stages);
      return { id: item.id, title: sanitizeTitle(item.title), flag: item.flag ?? null, waiting_on: waitingOn, waiting_on_stage: waitingOn ? byId.get(waitingOn)?.stage ?? null : null, ...(fix ? { fix } : {}) };
    }),
    needs_triage: triage.map((item) => ({ id: item.id, title: sanitizeTitle(item.title), created_by: item.created_by ?? null })),
    next_unblocked: next.map((item) => ({ id: item.id, title: sanitizeTitle(item.title), phase: item.phase ?? null })),
    rules: rules(stages, finished),
  };
  const related = options.relatedMemory ?? [];
  if (related.length) payload.related_memory = related.map((hit) => ({ date: hit.date ?? null, text: String(hit.text ?? '').replace(/\s+/g, ' ').trim() }));
  return payload;
}
