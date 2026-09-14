export function makeItems(count = 20) {
  const stages = ['backlog', 'specified', 'building', 'built', 'in_review', 'reviewed', 'merged', 'verified'];
  const owners = [null, 'agent:r-0001', 'human:rahil', 'agent:r-0002'];
  const titles = [
    'Pin release metadata',
    'Reject stale lease renewals after reconnect',
    'Add evidence gate to the merge workflow for generated artifacts and integration tests',
    'Document the scheduler timeout and recovery policy',
    'Verify dependency ordering across parallel agent runs',
  ];
  return Array.from({ length: count }, (_, index) => {
    const number = index + 1;
    const stage = stages[index % stages.length];
    const id = `P${index % 4}-${String(number).padStart(2, '0')}`;
    return {
      id, title: titles[index % titles.length],
      phase: `P${index % 4}`, priority: `P${index % 4}`, gate: `G${index % 3}`, type: index % 2 ? 'feature' : 'defect',
      stage, flag: index % 17 === 0 ? 'needs-triage' : index % 13 === 0 ? 'blocked' : null,
      owner: owners[index % owners.length], scope: 'Complete the scoped change and record evidence.',
      deps: index > 0 && index % 3 === 0 ? [`P${(index - 1) % 4}-${String(index).padStart(2, '0')}`] : [],
      evidence: stage === 'built' || stage === 'in_review' || stage === 'reviewed' || stage === 'merged' || stage === 'verified' ? ['commit:abc123'] : [],
      notes: 'Generated fixture item.', refs: [`R${String(number).padStart(2, '0')}`], parent: index > 9 && index % 10 === 0 ? 'P0-01' : null,
      created_by: index % 5 === 0 ? 'agent:r-0001' : 'human', gh: null,
      created: '2026-09-14T10:00:00Z', updated: '2026-09-14T10:00:00Z',
    };
  });
}

export function makeEvents(items) {
  return items.flatMap((item, index) => index % 4 === 0 && item.stage !== 'backlog'
    ? [{ ts: '2026-09-14T10:00:00Z', type: 'dispatch', item: item.id, by: 'scheduler' }]
    : []);
}
