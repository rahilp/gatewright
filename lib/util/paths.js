import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

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

// `normalizePath` can only resolve a path that exists -- realpath has nothing
// to open otherwise -- and the paths this tool compares routinely do not exist
// yet: an agent's `Write` names the file it is about to create. Resolving the
// deepest ancestor that does exist and re-attaching the rest keeps both sides
// of a comparison in the same form. Without it, a resolved parent is compared
// against an unresolved child, and under any symlinked or short-named root
// (macOS /tmp -> /private/tmp, Windows RUNNER~1) a new file inside the
// repository reads as outside it.
export function normalizeForCompare(value) {
  let current = resolve(String(value).replace(/\\/g, '/'));
  const trailing = [];
  for (;;) {
    const resolved = normalizePath(current);
    if (resolved !== current || existsSync(current)) return join(resolved, ...trailing);
    const parent = dirname(current);
    if (parent === current) return join(current, ...trailing);
    trailing.unshift(basename(current));
    current = parent;
  }
}

// Containment, asked the only way that survives every platform: `relative()`
// between two Windows drives does not answer with `..` -- it answers with the
// target, absolute -- so a path on another drive reads as *inside* the parent
// unless that case is checked too.
export function isWithin(path, parent) {
  const fromParent = relative(normalizeForCompare(parent), normalizeForCompare(path));
  return fromParent === '' || (!fromParent.startsWith(`..${sep}`) && fromParent !== '..' && !isAbsolute(fromParent));
}
