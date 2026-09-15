// Windows names the search-path variable `Path`, not `PATH` (and sometimes
// other casings). `process.env.PATH` still works because Node gives
// `process.env` itself a case-insensitive proxy on win32, but once an env
// object is spread into a plain object — as lib/run/spawn.js's `start()`
// does to build a child's env — that proxy is gone and the key keeps
// whatever casing the OS gave it. A test asserting on `options.env.PATH`
// against such a spread object must look the key up case-insensitively.
export function pathValue(env) {
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH');
  return key ? env[key] : undefined;
}
