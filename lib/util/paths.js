import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

// The one place a path that came from an external process (git, the OS) is
// made comparable to one this tool built with `path.join`/`resolve`. `git`
// always reports forward slashes, even on Windows, while `path.join` reports
// OS-native separators; and on macOS git resolves symlinks (/var is really
// /private/var) while a freshly constructed path does not. Comparing either
// form against the other directly fails for a reason no user could act on,
// so every such comparison goes through here first instead of normalising
// ad hoc at each call site.
//
// `realpathSync` (the plain, JS-implemented version) resolves symlinks but,
// on Windows, leaves 8.3 short names (`RUNNER~1`, from a long CI account
// name) and drive-letter case exactly as given. git's own path resolution
// goes through the real Win32 API and comes back long-form with corrected
// case, so a path we built from `os.tmpdir()`/`GITHUB_WORKSPACE` can differ
// from the same path as git reports it even after symlink resolution.
// `realpathSync.native` calls that same Win32 API (GetFinalPathNameByHandleW)
// so it expands short names and corrects case the same way git does — at
// the cost of an extended-length `\\?\` (or `\\?\UNC\`) prefix that neither
// git nor anything else in this pipeline produces, which is stripped below.
export function normalizePath(value) {
  const resolved = resolve(String(value).replace(/\\/g, '/'));
  try {
    const real = realpathSync.native(resolved);
    return real.replace(/^\\\\\?\\UNC\\/, '\\\\').replace(/^\\\\\?\\/, '');
  } catch {
    // An absent path cannot be resolved and is not equal to any real path
    // anyway, so the lexical resolution is as good an answer as any.
    return resolved;
  }
}

// Containment, asked the only way that survives Windows: `relative()` between
// two different drives does not answer with `..` -- it answers with the target,
// absolute -- so a path on another drive reads as *inside* the parent unless
// that case is checked too. Both sides are normalised first for the reasons
// above.
export function isWithin(path, parent) {
  const fromParent = relative(normalizePath(parent), normalizePath(path));
  return fromParent === '' || (!fromParent.startsWith(`..${sep}`) && fromParent !== '..' && !isAbsolute(fromParent));
}
