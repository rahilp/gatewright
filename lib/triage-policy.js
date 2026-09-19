// Policy changes are not merely prospective. When a creator kind no longer
// requires triage, work that is held *only* because of that policy must become
// usable at the same time. Both `gw config` and POST /api/config call this
// module so their policy transitions cannot drift.
import { isUnclassified } from './rules.js';

function actorKind(actor) {
  return String(actor ?? '').split(':', 1)[0];
}

export function requiredFor(config) {
  const value = config?.policy?.triage_required_for;
  // Old boards that predate the field kept the historical agent hold.
  return Array.isArray(value) ? value : ['agent'];
}

// Does the current policy hold work created by this actor for review?
function policyHolds(actor, config) {
  return requiredFor(config).includes(actorKind(actor)) && !config?.policy?.auto_dispatch_children;
}

// The flag an item earns at capture, and the flag it falls back to when a
// policy hold is lifted -- one rule so `gw add`, a policy change and
// `gw repair` cannot disagree about what a bare capture looks like.
// Agent-created work is never flagged unclassified: the policy decides
// whether it is held, and auto_dispatch_children exists to say it is not.
export function captureFlag(item, actor, config) {
  if (policyHolds(actor, config)) return 'needs-triage';
  return actorKind(actor) !== 'agent' && isUnclassified(item) ? 'unclassified' : null;
}

// T-0113 — before 0.13 a non-agent's unclassified capture was flagged
// needs-triage, the same flag as the agent policy hold, so move refused it
// until someone approved it. These are the open items still carrying that
// old hold: a needs-triage flag the current policy would not have set. The
// creator must be known -- an item with no creator cannot be told apart
// from a policy hold, so it keeps the hold it has.
export function legacyCaptureHolds(items, config, isFinished = () => false) {
  return items.filter((item) => item.flag === 'needs-triage'
    && item.created_by
    && actorKind(item.created_by) !== 'agent'
    && !policyHolds(item.created_by, config)
    && !isFinished(item));
}

// This is deliberately narrower than "clear every needs-triage flag whose
// creator is not currently covered." Only a kind that the previous policy
// covered and the new policy no longer covers is released. A released item
// that was captured with no classification drops to the `unclassified` flag
// a bare capture earns today, not to no flag at all.
export function persistConfigAndReleaseTriageHolds(store, { previousConfig, config, actor }) {
  const before = requiredFor(previousConfig);
  const after = requiredFor(config);
  const noLongerRequired = before.filter((kind) => !after.includes(kind));

  store.writeConfig(config);
  if (!noLongerRequired.length) return 0;

  const now = new Date().toISOString();
  const items = store.readItems();
  const released = items.filter((item) => item.flag === 'needs-triage' && noLongerRequired.includes(actorKind(item.created_by)));
  if (!released.length) return 0;

  const releasedIds = new Set(released.map((item) => item.id));
  const fallback = (item) => (actorKind(item.created_by) !== 'agent' && isUnclassified(item) ? 'unclassified' : null);
  store.writeItems(items.map((item) => releasedIds.has(item.id) ? { ...item, flag: fallback(item), updated: now } : item));
  for (const item of released) {
    store.appendEvent({
      type: 'flag',
      item: item.id,
      flag: fallback(item),
      by: actor,
      policy_changed_by: actor,
      reason: 'triage hold no longer required by policy',
    });
  }
  return released.length;
}
