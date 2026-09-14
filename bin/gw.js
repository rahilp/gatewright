#!/usr/bin/env node
// gatewright — argv → commands. Exit codes: 0 ok, 1 rule violation, 2 usage, 3 I/O.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createStore } from '../lib/store.js';
import { parseArgs } from '../lib/cli/args.js';
import { UsageError, RuleError, IOError } from '../lib/cli/errors.js';
import { findRoot, actor } from '../lib/cli/root.js';

const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));

const USAGE = `gw — evidence-gated work tracking for coding agents

usage: gw <command> [options]

  init [--gh] [--force]                 create .gatewright/ and the agent instruction block
  brief [--me <owner>] [--json]         what is in flight, blocked, owned, and next
  add "<title>" [--parent ID] ...       create an item, print its id
  edit <id> [--title ...] [--scope ...] change item fields
  claim <id> | release <id>             take or drop ownership
  move <id> <stage> [--evidence <e>]    advance a stage; refused if its rules are unmet
  note <id> "<text>"                    append to the item's running notes
  show <id> | list [--stage S]          read one item, or many
  check                                 report rule violations and out-of-band writes
  import <file> [--format md|csv|json]  ingest an existing task list
  open [--no-browser]                   write a board snapshot and open it
  upgrade [--templates]                 replace the CLI and viewer, never the data

  --version   print the version
  --help      print this message
`;

function usage(stdout) { stdout.write(USAGE); }
function unknown(cmd, stderr) { stderr.write(`gw: unknown command '${cmd}'\nRun 'gw --help' for usage.\n`); }

export async function runRouter(argv, { cwd = process.cwd(), env = process.env, stdout = process.stdout, stderr = process.stderr, load } = {}) {
  const [cmd] = argv;

  if (cmd === '--version' || cmd === '-v') {
    stdout.write(`${PKG.version}\n`);
    return 0;
  }
  if (cmd === undefined || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    usage(stdout);
    return 0;
  }
  try {
    let command;
    try { command = await (load ? load(cmd) : import(new URL(`../lib/commands/${cmd}.js`, import.meta.url))); }
    catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND') { unknown(cmd, stderr); return 2; }
      throw error;
    }
    const { flags, positionals } = parseArgs(argv.slice(1), command.spec);
    const needsRoot = command.spec.needsRoot !== false;
    const root = needsRoot ? findRoot(cwd, env) : null;
    const ctx = { flags, positionals, store: needsRoot ? createStore(root) : null, root, actor: actor(flags, env), env, stdout, stderr };
    return (await command.run(ctx)) ?? 0;
  } catch (error) {
    const known = error instanceof UsageError || error instanceof RuleError || error instanceof IOError;
    stderr.write(`${error.message}\n`);
    if (error instanceof RuleError) for (const failure of error.failures) stderr.write(`${failure}\n`);
    if (!known && env.GW_DEBUG && error.stack) stderr.write(`${error.stack}\n`);
    return known ? error.exitCode : 3;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runRouter(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
