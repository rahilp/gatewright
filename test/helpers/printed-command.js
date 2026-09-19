import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../../bin/gw.js', import.meta.url));

function writeGwShim(dir) {
  if (process.platform === 'win32') {
    writeFileSync(join(dir, 'gw.cmd'), `@echo off\r\n"${process.execPath}" "${BIN}" %*\r\n`);
    return;
  }

  const quote = (value) => `'${value.replaceAll("'", "'\\\"'\\\"'")}'`;
  const shim = join(dir, 'gw');
  writeFileSync(shim, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(BIN)} "$@"\n`);
  chmodSync(shim, 0o755);
}

// Execute advice exactly as the CLI printed it. The only test setup is a
// temporary PATH shim for the package's real binary; shell parsing remains
// the platform's own (/bin/sh on POSIX and cmd.exe on Windows).
export function runPrintedCommand(root, command, env = process.env) {
  const binDir = mkdtempSync(join(tmpdir(), 'gw-printed-command-'));
  try {
    writeGwShim(binDir);
    const inheritedPath = env.PATH ?? env.Path;
    return spawnSync(command, {
      cwd: root,
      encoding: 'utf8',
      shell: true,
      env: { ...env, PATH: [binDir, inheritedPath].filter(Boolean).join(delimiter) },
    });
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
}
