// Memory is deliberately behind a dynamic boundary: importing Gatewright must
// not parse an adapter unless the board explicitly opts in.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_TIMEOUT_MS = 5_000;

function warning(log, message) {
  if (typeof log === 'function') return log(message);
  if (log?.write) return log.write(`${message}\n`);
  if (log?.root) {
    const dir = join(log.root, '.gatewright', 'runs');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'memory.log'), `${new Date().toISOString()} WARN ${message}\n`);
  }
}

function withinTimeout(call, name, log, empty, timeoutMs) {
  let timer;
  return Promise.race([
    Promise.resolve().then(call),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${name} timed out after ${timeoutMs}ms`)), timeoutMs); }),
  ]).catch((error) => {
    warning(log, `memory ${name} failed: ${error.message}`);
    return empty;
  }).finally(() => clearTimeout(timer));
}

// The provider module is a small translation layer.  The only supplied one is
// `transport`, useful for embedders and tests; production adapters remain
// optional packages under the documented provider paths.
function loadProvider(name) {
  const encoded = encodeURIComponent(name).replaceAll('%2F', '/');
  return import(`./providers/${encoded}.js`).catch(() => import(`../../adapters/${encoded}/memory.js`));
}

export function createMemory({ config = {}, transport, log } = {}) {
  const memory = config.memory ?? {};
  if (!memory.enabled) return {
    enabled: false,
    recall: async () => [],
    remember: async () => null,
    capsule: async () => null,
  };

  let disabled = false;
  const configuredTimeout = Number(memory.timeout_ms);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : DEFAULT_TIMEOUT_MS;
  let provider;
  const configured = memory.provider;
  const getProvider = async () => {
    if (disabled) return null;
    if (provider) return provider;
    try {
      const loaded = await loadProvider(configured);
      provider = loaded.createProvider ? loaded.createProvider({ config: memory, transport }) : loaded.default?.({ config: memory, transport });
      if (!provider) throw new Error('module does not export createProvider');
      return provider;
    } catch (error) {
      disabled = true;
      warning(log, `memory provider "${configured}" could not be loaded; memory disabled: ${error.message}`);
      return null;
    }
  };
  const call = (name, args, empty) => withinTimeout(async () => {
    const active = await getProvider();
    if (!active) return empty;
    if (typeof active[name] !== 'function') return empty;
    return active[name](...args);
  }, name, log, empty, timeoutMs);

  // Surface a bad configured provider when this boundary is constructed, not
  // only after a later dispatch tries to use it.
  void getProvider();

  return {
    get enabled() { return !disabled; },
    recall: async (query, n) => {
      const hits = await call('recall', [query, n], []);
      if (!Array.isArray(hits)) {
        warning(log, 'memory recall returned malformed data; treating it as no hits');
        return [];
      }
      return hits.slice(0, n);
    },
    remember: (text, tags, options = {}) => call('remember', [text, tags, options], null),
    capsule: (projectId) => call('capsule', [projectId], null),
  };
}
