import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

// The one place a path that came from an external process (git, the OS) is
// made comparable to one this tool built with `path.join`/`resolve`. `git`
// always reports forward slashes, even on Windows, while `path.join` reports
// OS-native separators; and on macOS git resolves symlinks (/var is really
// /private/var) while a freshly constructed path does not. Comparing either
// form against the other directly fails for a reason no user could act on,
// so every such comparison goes through here first instead of normalising
// ad hoc at each call site.
export function normalizePath(value) {
  const resolved = resolve(String(value).replace(/\\/g, '/'));
  try {
    return realpathSync(resolved);
  } catch {
    // An absent path cannot be resolved and is not equal to any real path
    // anyway, so the lexical resolution is as good an answer as any.
    return resolved;
  }
}
