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

function writeStaleGwShim(dir, name) {
  if (process.platform === 'win32') {
    writeFileSync(join(dir, `${name}.cmd`), '@echo off\r\nexit /b 2\r\n');
    return;
  }
  const shim = join(dir, name);
  writeFileSync(shim, '#!/bin/sh\nexit 2\n');
  chmodSync(shim, 0o755);
}

export function withGwShim(callback, env = process.env, { stale = false } = {}) {
  const binDir = mkdtempSync(join(tmpdir(), 'gw-printed-command-'));
  try {
    if (stale) {
      // Prevent the npx fallback from masking the deliberately stale gw.
      writeStaleGwShim(binDir, 'gw');
      writeStaleGwShim(binDir, 'npx');
    } else {
      writeGwShim(binDir);
    }
    const inheritedPath = env.PATH ?? env.Path;
    return callback({ ...env, PATH: [binDir, inheritedPath].filter(Boolean).join(delimiter) });
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
}

// Execute advice exactly as the CLI printed it. The only test setup is a
// temporary PATH shim for the package's real binary; shell parsing remains
// the platform's own (/bin/sh on POSIX and cmd.exe on Windows).
export function runPrintedCommand(root, command, env = process.env, options = {}) {
  return withGwShim((shimEnv) => {
    return spawnSync(command, {
      cwd: root,
      encoding: 'utf8',
      shell: true,
      env: shimEnv,
      input: options.input,
    });
  }, env, options);
}
