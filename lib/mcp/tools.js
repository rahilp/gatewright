// T-0137 — the tool catalogue. One tool per command an agent already runs on
// the CLI, and nothing else: an MCP tool here is a different way to reach
// lib/commands/*, not a second implementation of the board.
//
// Every tool therefore declares only which command it calls and how its JSON
// arguments become that command's positionals and flags. No rule, refusal or
// piece of output is produced in this file; all of it comes back from the
// command module through lib/serve/invoke.js, which is the same adapter the
// HTTP board writes through.
//
// The descriptions are written for an agent reading tools/list with no other
// context: they say what the tool is for, when to reach for it, and what will
// refuse. That text is the only documentation an MCP client ever shows.

const ID = { type: 'string', description: 'Item id, for example T-0137 or P2-01.' };
const JSON_FLAG = { type: 'boolean', description: 'Return the machine-readable form instead of the rendered text.' };
const FORCE = { type: 'boolean', description: 'Override the ordering rule this command names in its refusal. Never a way past an evidence gate — if a refusal did not print --force, --force is the wrong answer.' };

function schema(properties, required = []) {
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    // Explicit, so a client validating arguments rejects a typo'd field here
    // rather than sending it to a command that would silently ignore it.
    additionalProperties: false,
  };
}

// Joined into the CLI's comma-separated list form. An empty array is the
// explicit "clear this list" value `gw edit --deps ""` exists for, which is
// why the flag is set even when the array is empty.
function commaList(values) {
  return values.map((value) => String(value).trim()).join(',');
}

export const TOOLS = [
  {
    name: 'gw_brief',
    title: 'Board brief',
    command: 'brief',
    description: [
      'Read the board: what is in flight, blocked, owned by whom, and what is next and unblocked.',
      'Call this first in a session and act on it. Identical to `gw brief`, capped at 25 lines.',
    ].join(' '),
    inputSchema: schema({
      json: JSON_FLAG,
      me: {
        type: 'string',
        description: 'Filter every section to one owner. Pass an owner such as "agent:codex", or the empty string "" to mean whoever this server records writes as.',
      },
    }),
    build: ({ json, me }) => ({
      flags: {
        ...(json ? { json: true } : {}),
        // The CLI's bare `--me` is parsed as boolean true and resolved to the
        // acting identity; '' is the JSON spelling of standing alone.
        ...(me === undefined ? {} : { me: me === '' ? true : me }),
      },
      positionals: [],
    }),
  },
  {
    name: 'gw_show',
    title: 'Show item',
    command: 'show',
    description: 'Print one item in full — scope, owner, stage, evidence, dependencies, notes — and the events recorded against it.',
    inputSchema: schema({ id: ID, json: JSON_FLAG }, ['id']),
    build: ({ id, json }) => ({ flags: json ? { json: true } : {}, positionals: [id] }),
  },
  {
    name: 'gw_next',
    title: 'Legal moves',
    command: 'next',
    description: [
      'Ask what stage(s) an item may move to right now on THIS board, and why the other stages refuse.',
      'Boards define their own pipelines, so never guess a stage name — read it here before calling gw_move.',
    ].join(' '),
    inputSchema: schema({ id: ID, json: JSON_FLAG }, ['id']),
    build: ({ id, json }) => ({ flags: json ? { json: true } : {}, positionals: [id] }),
  },
  {
    name: 'gw_list',
    title: 'List items',
    command: 'list',
    description: [
      'List items as one line each: id, stage, title. Filter by stage, phase, flag or owner, search the ids and titles with "text", and cap the rows with "limit".',
      'Use flag "needs-triage" to see the triage inbox, and a terminal stage to see finished work, which the brief leaves out of the open counts.',
    ].join(' '),
    inputSchema: schema({
      stage: { type: 'string', description: 'Only items in this stage. An unknown stage is refused, and the refusal names the stages this board actually has.' },
      phase: { type: 'string', description: 'Only items in this phase.' },
      flag: { type: 'string', description: 'Only items carrying this flag, for example "needs-triage" or "unclassified".' },
      owner: { type: 'string', description: 'Only items owned by this actor, for example "agent:codex". Pass "none" for the unowned ones.' },
      text: { type: 'string', description: 'Case-insensitive substring search over item ids and titles: some words you remember, or part of an id.' },
      limit: {
        type: 'integer',
        minimum: 1,
        description: 'At most this many rows. Truncation is never silent — the count of what was cut is printed after the last row, so a capped list is not mistaken for a complete one.',
      },
    }),
    build: ({ stage, phase, flag, owner, text, limit }) => ({
      flags: {
        ...(stage === undefined ? {} : { stage }),
        ...(phase === undefined ? {} : { phase }),
        ...(flag === undefined ? {} : { flag }),
        ...(owner === undefined ? {} : { owner }),
        // The CLI parses every flag value out of argv as a string, so a
        // number arriving as JSON is handed over the same way -- including to
        // the refusal, which quotes the value it was given.
        ...(limit === undefined ? {} : { limit: String(limit) }),
      },
      positionals: text === undefined ? [] : [text],
    }),
  },
  {
    name: 'gw_add',
    title: 'Add item',
    command: 'add',
    writes: true,
    description: [
      'Put work on the board and get its id back. Do this BEFORE the first edit of a task, one item per step you intend to take;',
      'the pre-edit guard refuses edits no item accounts for. Use "parent" for sub-steps.',
      'Dependencies are not set here — create the items first, then call gw_edit with "deps".',
    ].join(' '),
    inputSchema: schema({
      title: { type: 'string', description: 'One line, 120 characters or fewer, no newlines. Say what will be done, not what area it is in.' },
      scope: { type: 'string', description: 'What "done" means for this item. The evidence gate is judged against it, so it is worth writing.' },
      parent: { type: 'string', description: 'Id of the item this is a step of. Board policy caps depth and children per item.' },
      type: { type: 'string', description: 'A value from this board\'s type vocabulary; an unknown one is refused and the refusal lists the allowed values.' },
      priority: { type: 'string', description: 'A value from this board\'s priority vocabulary.' },
      phase: { type: 'string', description: 'A value from this board\'s phase vocabulary. Some id schemes require it.' },
    }, ['title']),
    build: ({ title, scope, parent, type, priority, phase }) => ({
      flags: {
        ...(scope === undefined ? {} : { scope }),
        ...(parent === undefined ? {} : { parent }),
        ...(type === undefined ? {} : { type }),
        ...(priority === undefined ? {} : { priority }),
        ...(phase === undefined ? {} : { phase }),
      },
      positionals: [title],
    }),
  },
  {
    name: 'gw_claim',
    title: 'Claim item',
    command: 'claim',
    writes: true,
    description: 'Take ownership of an item before changing code for it. An item someone else owns is refused unless you pass force, which is a deliberate takeover.',
    inputSchema: schema({ id: ID, force: FORCE }, ['id']),
    build: ({ id, force }) => ({ flags: force ? { force: true } : {}, positionals: [id] }),
  },
  {
    name: 'gw_move',
    title: 'Move item to a stage',
    command: 'move',
    writes: true,
    description: [
      'Advance an item to a stage. This is the gate: if the target stage requires evidence, ownership, scope or finished dependencies and the item has not got them, the move is REFUSED and the refusal says exactly what is missing.',
      'Fix what it names — do not retry with force. Call gw_next first if you are unsure which stages are legal.',
    ].join(' '),
    inputSchema: schema({
      id: ID,
      stage: { type: 'string', description: 'Target stage id on this board. Read the legal ones from gw_next; the default pipeline is backlog → building → built → in_review → reviewed → merged → verified, but a board may define its own.' },
      evidence: {
        type: 'array',
        items: { type: 'string' },
        description: 'Proof the stage asks for: a commit sha, a test command and its result, a pull request URL. Stages may require a minimum count or a matching pattern.',
      },
      force: FORCE,
    }, ['id', 'stage']),
    build: ({ id, stage, evidence, force }) => ({
      flags: {
        ...(evidence === undefined ? {} : { evidence }),
        ...(force ? { force: true } : {}),
      },
      positionals: [id, stage],
    }),
  },
  {
    name: 'gw_note',
    title: 'Note on item',
    command: 'note',
    writes: true,
    description: 'Append one timestamped line to an item\'s running notes. Notes are progress remarks on work that already exists — a step you plan to take is an item (gw_add), never a note.',
    inputSchema: schema({ id: ID, text: { type: 'string', description: 'The remark. Must not be empty.' } }, ['id', 'text']),
    build: ({ id, text }) => ({ flags: {}, positionals: [id, text] }),
  },
  {
    name: 'gw_edit',
    title: 'Edit item fields',
    command: 'edit',
    writes: true,
    description: [
      'Change an item\'s non-stage, non-evidence, non-notes fields. At least one field is required.',
      'Fields a linked GitHub issue owns are refused, because the next sync would revert them. Rewriting scope on finished work is refused too, since the recorded evidence was judged against the old scope.',
    ].join(' '),
    inputSchema: schema({
      id: ID,
      title: { type: 'string', description: 'Replacement title: one line, 120 characters or fewer.' },
      scope: { type: 'string', description: 'Replacement definition of done.' },
      priority: { type: 'string', description: 'A value from this board\'s priority vocabulary.' },
      type: { type: 'string', description: 'A value from this board\'s type vocabulary.' },
      phase: { type: 'string', description: 'A value from this board\'s phase vocabulary.' },
      deps: {
        type: 'array',
        items: { type: 'string' },
        description: 'REPLACES the dependency list with these item ids. An empty array clears it. Unknown ids and cycles are refused.',
      },
      refs: { type: 'array', items: { type: 'string' }, description: 'REPLACES the reference list. An empty array clears it.' },
      force: FORCE,
    }, ['id']),
    build: ({ id, title, scope, priority, type, phase, deps, refs, force }) => ({
      flags: {
        ...(title === undefined ? {} : { title }),
        ...(scope === undefined ? {} : { scope }),
        ...(priority === undefined ? {} : { priority }),
        ...(type === undefined ? {} : { type }),
        ...(phase === undefined ? {} : { phase }),
        ...(deps === undefined ? {} : { deps: commaList(deps) }),
        ...(refs === undefined ? {} : { refs: commaList(refs) }),
        ...(force ? { force: true } : {}),
      },
      positionals: [id],
    }),
  },
  {
    name: 'gw_triage',
    title: 'Approve or drop a held item',
    command: 'triage',
    writes: true,
    description: [
      'Clear an item out of the triage inbox: approve it so it can advance, or drop it so it does not go ahead. Set exactly one of approve or drop.',
      'A different agent or any human may approve an agent-created item; you may not approve one you created yourself, and force does not change that. Its creator may still drop it.',
      'List the inbox with gw_list and flag "needs-triage".',
    ].join(' '),
    inputSchema: schema({
      id: ID,
      approve: { type: 'boolean', description: 'Lift the hold and let the item advance.' },
      drop: { type: 'boolean', description: 'Move the item to the dropped stage: this work will not go ahead.' },
      force: FORCE,
    }, ['id']),
    build: ({ id, approve, drop, force }) => ({
      flags: {
        // Passed through as booleans rather than collapsed into one enum, so
        // that "neither" and "both" still reach the command and come back as
        // its own refusal instead of a message this server invented.
        ...(approve ? { approve: true } : {}),
        ...(drop ? { drop: true } : {}),
        ...(force ? { force: true } : {}),
      },
      positionals: [id],
    }),
  },
];

const BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

export function findTool(name) {
  return BY_NAME.get(name) ?? null;
}

// What tools/list publishes: the wire shape only, never the build function.
export function toolDescriptors() {
  return TOOLS.map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema }));
}

// MCP requires servers to validate tool inputs. This checks exactly the schema
// vocabulary used above -- there is no general JSON Schema engine here, because
// a half-correct one is worse than a small honest one. A missing REQUIRED
// positional is deliberately not checked: invoke() refuses it with the CLI's
// own wording, and duplicating that here would be a second source of truth.
export function validateArguments(tool, args) {
  const problems = [];
  const { properties, required = [] } = tool.inputSchema;
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(properties, key)) {
      problems.push(`unknown argument "${key}"; ${tool.name} accepts ${Object.keys(properties).join(', ')}`);
    }
  }
  for (const key of required) {
    if (args[key] === undefined) problems.push(`missing required argument "${key}"`);
  }
  for (const [key, value] of Object.entries(args)) {
    const definition = properties[key];
    if (!definition || value === undefined) continue;
    if (definition.type === 'string' && typeof value !== 'string') {
      problems.push(`argument "${key}" must be a string`);
    }
    if (definition.type === 'boolean' && typeof value !== 'boolean') {
      problems.push(`argument "${key}" must be true or false`);
    }
    if (definition.type === 'integer' && (!Number.isInteger(value) || value < (definition.minimum ?? -Infinity))) {
      problems.push(`argument "${key}" must be an integer${definition.minimum === undefined ? '' : ` of ${definition.minimum} or more`}`);
    }
    if (definition.type === 'array') {
      if (!Array.isArray(value)) problems.push(`argument "${key}" must be an array of strings`);
      else if (value.some((entry) => typeof entry !== 'string')) problems.push(`every entry of "${key}" must be a string`);
    }
  }
  return problems;
}

// The command line this tool call is equivalent to. Used only in messages --
// so an agent that hits a refusal can see, and reproduce, the exact CLI call
// the board just answered.
export function printedCommand(tool, { flags, positionals }) {
  const quote = (value) => (/^[\w.:/@=-]+$/.test(value) ? value : `"${String(value).replaceAll('"', '\\"')}"`);
  const parts = ['gw', tool.command, ...positionals.map((value) => quote(String(value)))];
  for (const [flag, value] of Object.entries(flags)) {
    if (value === true) parts.push(`--${flag}`);
    else if (Array.isArray(value)) for (const entry of value) parts.push(`--${flag}`, quote(String(entry)));
    else parts.push(`--${flag}`, quote(String(value)));
  }
  return parts.join(' ');
}
