#!/usr/bin/env node
// gatewright — argv → commands. Exit codes: 0 ok, 1 rule violation, 2 usage, 3 I/O.
import { runRouter } from '../lib/cli/router.js';

// `gw list | head`, `gw brief | less` and then q, `gw check | grep -q` all end
// the same way: the reader closes the pipe while gw is still writing, and the
// write fails with EPIPE. An unhandled 'error' on stdout is an uncaught
// exception, so what a user actually saw was a Node stack trace after
// perfectly ordinary shell usage. The reader going away first is not an error
// here -- it is the normal end of a pipeline -- so stop writing and exit
// quietly, the way every other Unix tool does. Any other stream error is still
// a real failure and is left to surface.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error) => {
    if (error?.code === 'EPIPE') process.exit(0);
    throw error;
  });
}

runRouter(process.argv.slice(2)).then((code) => { process.exitCode = code; });
