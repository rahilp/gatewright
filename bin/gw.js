#!/usr/bin/env node
// gatewright — argv → commands. Exit codes: 0 ok, 1 rule violation, 2 usage, 3 I/O.
import { readFileSync } from 'node:fs';

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

function main(argv) {
  const [cmd] = argv;

  if (cmd === '--version' || cmd === '-v') {
    process.stdout.write(`${PKG.version}\n`);
    return 0;
  }
  if (cmd === undefined || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }

  process.stderr.write(`gw: unknown command '${cmd}'\nRun 'gw --help' for usage.\n`);
  return 2;
}

process.exitCode = main(process.argv.slice(2));
