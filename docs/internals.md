# Gatewright internals

`bin/gw.js` is the unconditional executable entry point; it delegates to the exported
`runRouter` in `lib/cli/router.js`. The router resolves `gw <name>` to
`lib/commands/<name>.js`. A command module exports:

```js
export const spec = {
  summary: 'short description',
  flags: { json: { type: 'boolean' }, evidence: { type: 'string', repeat: true } },
  positionals: [{ name: 'id', required: true }],
  needsRoot: true, // default; use false for commands such as init
};

export function run(ctx) { return 0; } // undefined also means 0
```

`ctx` is `{ flags, positionals, store, root, actor, env, cwd, stdout, stderr, ghRun }`.
`flags` and `positionals` are parsed by `parseArgs`. `store` is `createStore(root)` when
`needsRoot` is true, otherwise `null`; `root` is likewise the repository root or `null`.
`actor` is `--by`, then `GW_ACTOR`, then `human:$USER` (or `$USERNAME`). `cwd` is the working
directory the router was invoked with (`process.cwd()` unless overridden through the router's
options); commands that create the root, such as `init`, use it instead of calling
`process.cwd()` themselves. Use the supplied output streams rather than `process.stdout`
and `process.stderr`.

`ghRun` is an optional executor passed through `runRouter` to commands that use GitHub.
It receives `gh` argv without the executable name and exists so the sync layer can be
tested offline with fixture output; production CLI invocations leave it undefined and use
the committed GitHub wrapper's default executor.

`findRoot(cwd, env, { stopAt })` walks to the filesystem root by default. Tests and other
callers that must not search past a fixture can pass `stopAt`; that directory is checked but
its parent is not. If the selected `.gatewright` root is outside the enclosing Git repository,
the CLI warns on stderr and continues. Outside a Git repository, root lookup remains silent.

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

`lib/stages.js` resolves stage meaning from the user-owned process definition:

- `resolveRoles(stages)` returns `{ initial, done, dropped, paused }`; each value is a stage ID or `null`.
- `isDropped(item, roles)` reports whether an item occupies the resolved dropped stage.
- `isTerminalStage(stageId, stages, roles)` reports configured terminal stages and the resolved dropped stage.
- `validateStages(stages)` returns actionable process-definition findings without printing or throwing. `check` runs it before reading board items.

Always use `store` for writes. Do not write `.gatewright/` directly.
