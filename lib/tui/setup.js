// The `gw init` walkthrough.
//
// A tracker whose defaults do not match how you work is worse than no tracker,
// because it reports things that are not true. The shipped pipeline assumes
// pull requests; a repo that commits to main cannot legitimately advance past
// `built`, so finished work piles up there and `gw brief` reports all of it as
// still in flight. That is not a bug a new user can diagnose, so this asks
// once, at the only moment the answer is cheap to act on.
//
// Everything here is skipped unless a real terminal is present. See
// lib/tui/prompt.js: init runs inside agents, CI and npx one-liners, and a
// prompt there is a hang with nothing to explain it.

// Truncating the shipped pipeline rather than defining a second one keeps
// stage ids, labels and exit rules identical across both shapes, so a board
// can be moved from one to the other by editing the pipeline alone.
export function trunkStages(shipped) {
  const cut = shipped.stages.findIndex((stage) => stage.id === 'built');
  const stages = shipped.stages.slice(0, cut + 1).map((stage) => ({ ...stage }));
  const last = stages.at(-1);
  last.role = 'done';
  last.exit = 'Evidence recorded: commit and test path. This is the finish line.';
  return {
    ...shipped,
    stages,
    // `built` is terminal through its role, so naming it here too would be a
    // second place to keep in step for no gain.
    terminal: (shipped.terminal ?? []).filter((id) => id === 'dropped'),
  };
}
