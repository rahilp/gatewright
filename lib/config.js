import { existsSync, readFileSync } from 'node:fs';
import { IOError } from './cli/errors.js';

// Defaults are shipped alongside the package, not inferred from the caller's
// working directory. This keeps a fresh install and an absent config file on
// the same policy as `gw init`.
function readDefaultTemplate(name) {
  return JSON.parse(readFileSync(new URL(`../templates/${name}`, import.meta.url), 'utf8'));
}

const DEFAULT_CONFIG = readDefaultTemplate('config.json');
const DEFAULT_STAGES = readDefaultTemplate('stages.json');

function readJson(path, fallback) {
  if (!existsSync(path)) return structuredClone(fallback);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new IOError(`${path.split('/').pop()} is not valid JSON.`);
  }
}

export function readConfig(store) {
  return readJson(store.paths.config, DEFAULT_CONFIG);
}

export function readStages(store) {
  return readJson(store.paths.stages, DEFAULT_STAGES);
}
