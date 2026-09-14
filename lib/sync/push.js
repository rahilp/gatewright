import { readConfig, readStages } from '../config.js';

function labelName(label) {
  return typeof label === 'string' ? label : label?.name;
}

function stageLabel(stage, stages) {
  const definition = (stages.stages ?? []).find((candidate) => candidate.id === stage);
  if (definition?.label) return definition.label;
  return stage.replace(/[_-]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function moveKey(event, index) {
  return event.ts ?? `${event.item}:${event.from ?? ''}:${event.to ?? ''}:${index}`;
}

function pushedAcks(events) {
  const comments = new Set();
  const closed = new Set();
  const dispatchRemoved = new Set();
  for (const event of events) {
    if (event.type !== 'sync' || !event.pushed) continue;
    for (const key of event.pushed.comments ?? []) comments.add(key);
    for (const id of event.pushed.closed ?? []) closed.add(id);
    for (const id of event.pushed.dispatch_removed ?? []) dispatchRemoved.add(id);
  }
  return { comments, closed, dispatchRemoved };
}

function linkedIssue(item, issues) {
  return issues.find((issue) => issue.number === item.gh?.number);
}

/**
 * Push GitHub-owned side effects for the current board.
 *
 * The caller supplies the issues fetched by pull so this function performs no
 * additional GitHub reads. Every board mutation is made inside withLock.
 */
export function push({ store, gh, issues = [], config = readConfig(store), stages = readStages(store), dryRun = false } = {}) {
  if (!store || !gh) throw new TypeError('push requires store and gh');

  return store.withLock(() => {
    const items = store.readItems();
    const events = store.readEvents();
    const acks = pushedAcks(events);
    const pushed = { comments: [], closed: [], dispatch_removed: [] };
    const failures = [];

    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (event.type !== 'move' || !event.queued_comment) continue;
      const key = moveKey(event, index);
      if (acks.comments.has(key)) continue;
      const item = items.find((candidate) => candidate.id === event.item);
      const issue = item && linkedIssue(item, issues);
      if (!item || !issue) continue;
      const evidence = (event.evidence ?? []).join(', ');
      const body = `→ ${stageLabel(event.to, stages)} · evidence: ${evidence} · by ${event.by}`;
      if (dryRun) {
        console.log(`gh issue comment ${issue.number} --body ${body}`);
        continue;
      }
      try {
        gh.comment(issue.number, body);
        pushed.comments.push(key);
      } catch (error) {
        failures.push({ action: 'comment', item: item.id, error });
      }
    }

    const closeOn = config.github?.close_on;
    if (closeOn) {
      for (const item of items) {
        if (item.stage !== closeOn) continue;
        const issue = linkedIssue(item, issues);
        if (!issue || String(issue.state).toLowerCase() === 'closed' || acks.closed.has(item.id)) continue;
        if (dryRun) {
          console.log(`gh issue close ${issue.number}`);
          continue;
        }
        try {
          gh.close(issue.number);
          pushed.closed.push(item.id);
        } catch (error) {
          failures.push({ action: 'close', item: item.id, error });
        }
      }
    }

    const dispatchLabel = config.github?.dispatch_label;
    if (dispatchLabel) {
      for (const issue of issues) {
        if (!issue.labels?.some((label) => labelName(label) === dispatchLabel)) continue;
        const item = items.find((candidate) => candidate.gh?.number === issue.number);
        if (!item) continue;
        const dispatched = events.some((event) => event.type === 'dispatch' && event.item === item.id);
        if (!dispatched) {
          if (dryRun) {
            console.log(`dispatch ${item.id}`);
          } else {
            store.appendEvent({ type: 'dispatch', item: item.id, by: 'sync' });
          }
        }
        if (acks.dispatchRemoved.has(item.id)) continue;
        if (dryRun) {
          console.log(`gh issue edit ${issue.number} --remove-label ${dispatchLabel}`);
          continue;
        }
        try {
          gh.editLabels(issue.number, { remove: [dispatchLabel] });
          pushed.dispatch_removed.push(item.id);
        } catch (error) {
          failures.push({ action: 'remove-label', item: item.id, error });
        }
      }
    }

    if (!dryRun && (pushed.comments.length || pushed.closed.length || pushed.dispatch_removed.length)) {
      store.appendEvent({ type: 'sync', pushed });
    }
    return { ...pushed, failures };
  });
}
