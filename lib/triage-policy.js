// Policy changes are not merely prospective. When a creator kind no longer
// requires triage, work that is held *only* because of that policy must become
// usable at the same time. Both `gw config` and POST /api/config call this
// module so their policy transitions cannot drift.

function actorKind(actor) {
  return String(actor ?? '').split(':', 1)[0];
}

function requiredFor(config) {
  const value = config?.policy?.triage_required_for;
  // Old boards that predate the field kept the historical agent hold.
  return Array.isArray(value) ? value : ['agent'];
}

// This is deliberately narrower than "clear every needs-triage flag whose
// creator is not currently covered." A human's unclassified-capture hold is
// independent of this policy, and must survive an agent-policy change. Only a
// kind that the previous policy covered and the new policy no longer covers is
// released.
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
  store.writeItems(items.map((item) => releasedIds.has(item.id) ? { ...item, flag: null, updated: now } : item));
  for (const item of released) {
    store.appendEvent({
      type: 'flag',
      item: item.id,
      flag: null,
      by: actor,
      policy_changed_by: actor,
      reason: 'triage hold no longer required by policy',
    });
  }
  return released.length;
}
