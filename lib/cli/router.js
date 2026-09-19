import { readFileSync } from 'node:fs';
import { createStore } from '../store.js';
import { parseArgs } from './args.js';
import { UsageError, RuleError, IOError } from './errors.js';
import { findRoot, actor } from './root.js';

const PKG = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url)));

const USAGE = `gw — evidence-gated work tracking for coding agents

usage: gw <command> [options]

  init [--gh] [--repo owner/name] [--force] create .gatewright/ and the agent instruction block
  brief [--me [<owner>]] [--json]     what is in flight, blocked, owned, and next
  add "<title>" [--parent ID] ...       create an item, print its id
  edit <id> [--title ...] [--scope ...] change item fields
  claim <id> | release <id>             take or drop ownership
  move <id> <stage> [--evidence <e>]    advance a stage; refused if its rules are unmet
  next <id> [--json]                    what stage(s) an item can move to now, and why not for the rest
  note <id> "<text>"                    append to the item's running notes
  show <id> | list [--stage S]          read one item, or many
  check                                 report rule violations and out-of-band writes
  repair [--write]                      quarantine corrupt lines from the board files (dry run by default)
  guard [--message-file F] [--range A..B] refuse a commit no item on the board accounts for
  hook install [--ci] [--agent]         gate commits and edits on the board (also: status, uninstall)
  config [<key> [<value>]] [--list]     show or change settings without editing files
  triage <id> --approve | --drop        clear or drop an item held for review or not classified yet
  import <file> [--format md]           ingest an existing task list (csv and json: P1-19)
  sync [--dry-run]                      pull linked GitHub issues
  gc [--dry-run] [--force]              remove terminal-stage worktrees
  open [--no-browser] [--watch]         write a board snapshot and open it
  serve [--port 7777] [--host H] [--open] serve the live board; loopback unless --host says otherwise
  stop <id> | --all                     stop recorded runs, even without serve
  resume <id>                           resume a paused item in its existing worktree
  upgrade [--templates]                 replace the CLI and viewer, never the data

  who did what: every command that writes records an actor. Default is
  human:<user>; agents must identify as agent:<name> — pass --by agent:opencode
  or export GW_ACTOR=agent:opencode (all commands). A bare "agent" is refused.
  Identity is declared, not authenticated.

  GW_ROOT names the project root — the directory holding .gatewright/ — not
  .gatewright/ itself. A path ending in .gatewright is accepted with a
  deprecation warning.

  --version   print the version
  --help      print this message
`;

function usage(stdout) { stdout.write(USAGE); }

// Rendered from the command's own spec rather than written out by hand, so it
// cannot drift from what the parser will actually accept -- which is the whole
// complaint: the flag set used to be discoverable only by reading source.
function commandUsage(name, spec) {
  const flags = Object.entries(spec.flags ?? {})
    .map(([flag, definition]) => (definition.type === 'boolean' ? `[--${flag}]` : `[--${flag} <value>]`));
  const positionals = (spec.positionals ?? [])
    .map((positional) => (positional.required ? `<${positional.name}>` : `[<${positional.name}>]`));
  return `usage: gw ${[name, ...positionals, ...flags].join(' ')}`;
}

function commandHelp(name, spec, stdout) {
  // A missing summary must degrade to a visible placeholder rather than the
  // word "undefined": help text is rendered, so it cannot be trusted to have
  // been filled in.
  const summary = spec.summary ?? '(no summary)';
  stdout.write(`gw ${name} — ${summary}\n\n`);
  stdout.write(`${commandUsage(name, spec)}\n`);
  const flags = Object.entries(spec.flags ?? {});
  if (flags.length) {
    stdout.write('\nflags:\n');
    const width = Math.max(...flags.map(([flag]) => flag.length)) + 2;
    for (const [flag, definition] of flags) {
      stdout.write(`  --${flag.padEnd(width)}${definition.type === 'boolean' ? 'on/off' : 'takes a value'}\n`);
    }
  }
  if (spec.needsRoot === false) stdout.write('\nRuns outside an initialized board.\n');
}
function unknown(cmd, stderr) { stderr.write(`gw: unknown command '${cmd}'\nRun 'gw --help' for usage.\n`); }

export async function runRouter(argv, { cwd = process.cwd(), env = process.env, stdout = process.stdout, stderr = process.stderr, stdin = process.stdin, load, ghRun } = {}) {
  const [cmd] = argv;

  if (cmd === '--version' || cmd === '-v') {
    stdout.write(`${PKG.version}\n`);
    return 0;
  }
  if (cmd === undefined || cmd === '--help' || cmd === '-h') {
    usage(stdout);
    return 0;
  }
  // `gw help <command>` and `gw <command> --help` are the same request and
  // must answer the same way. Both are resolved before parseArgs, which would
  // otherwise reject --help as an unknown flag on every command.
  const helpFor = cmd === 'help' ? argv[1] : (argv.includes('--help') || argv.includes('-h') ? cmd : null);
  if (cmd === 'help' && !helpFor) {
    usage(stdout);
    return 0;
  }
  if (helpFor) {
    let target;
    try { target = await (load ? load(helpFor) : import(new URL(`../commands/${helpFor}.js`, import.meta.url))); }
    catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND') { unknown(helpFor, stderr); return 2; }
      throw error;
    }
    commandHelp(helpFor, target.spec, stdout);
    return 0;
  }
  try {
    let command;
    try { command = await (load ? load(cmd) : import(new URL(`../commands/${cmd}.js`, import.meta.url))); }
    catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND') { unknown(cmd, stderr); return 2; }
      throw error;
    }
    const { flags, positionals } = parseArgs(argv.slice(1), command.spec);
    const needsRoot = command.spec.needsRoot !== false;
    const root = needsRoot ? findRoot(cwd, env, { stderr }) : null;
    const ctx = { flags, positionals, store: needsRoot ? createStore(root) : null, root, actor: actor(flags, env), env, cwd, stdout, stderr, stdin, ghRun };
    return (await command.run(ctx)) ?? 0;
  } catch (error) {
    const known = error instanceof UsageError || error instanceof RuleError || error instanceof IOError;
    stderr.write(`${error.message}\n`);
    if (error instanceof RuleError) for (const failure of error.failures) stderr.write(`${failure}\n`);
    if (!known && env.GW_DEBUG && error.stack) stderr.write(`${error.stack}\n`);
    return known ? error.exitCode : 3;
  }
}
