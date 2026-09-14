# Gatewright internals

`bin/gw.js` resolves `gw <name>` to `lib/commands/<name>.js`. A command module exports:

```js
export const spec = {
  summary: 'short description',
  flags: { json: { type: 'boolean' }, evidence: { type: 'string', repeat: true } },
  positionals: [{ name: 'id', required: true }],
  needsRoot: true, // default; use false for commands such as init
};

export function run(ctx) { return 0; } // undefined also means 0
```

`ctx` is `{ flags, positionals, store, root, actor, env, stdout, stderr }`.
`flags` and `positionals` are parsed by `parseArgs`. `store` is `createStore(root)` when
`needsRoot` is true, otherwise `null`; `root` is likewise the repository root or `null`.
`actor` is `--by`, then `GW_ACTOR`, then `human:$USER` (or `$USERNAME`). Use the supplied
output streams rather than `process.stdout` and `process.stderr`.

Exit codes are 0 success, 1 rule violation, 2 usage error, and 3 I/O or unexpected error.
Throw `UsageError`, `RuleError`, or `IOError` from `lib/cli/errors.js` to select codes 2, 1,
or 3. `RuleError(message, failures)` prints its message followed by each failure on its own line.

`lib/rules.js` is the stage/graph policy surface:

- `stageList(stages)` returns pipeline stages followed by side (`extra`) stages.
- `stageIndex(stages, id)` returns a pipeline index; extras and unknown stages are `-1`.
- `nextStage(stages, id)` returns the next pipeline stage ID or `null`.
- `evaluateRequires(item, targetStageId, { items, stages })` returns `{ ok, failures }` for
  target-stage `owner`, `evidence_min`, `evidence_match`, and `deps_at_least` requirements.
- `findCycles(items)` returns deterministic dependency cycles as ID arrays.
- `missingDeps(items)` returns `{ id, missing }` entries for unresolved dependency IDs.

Always use `store` for writes. Do not write `.gatewright/` directly.
