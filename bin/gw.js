#!/usr/bin/env node
// gatewright — argv → commands. Exit codes: 0 ok, 1 rule violation, 2 usage, 3 I/O.
import { runRouter } from '../lib/cli/router.js';

runRouter(process.argv.slice(2)).then((code) => { process.exitCode = code; });
