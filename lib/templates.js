// The shipped defaults: the eight-stage board, the tool config, the dispatch
// prompt, and the fenced agent-instruction block. `init` and `upgrade` install
// from here so the defaults live in exactly one place — templates/.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');

export function templatePath(name) {
  return join(TEMPLATES_DIR, name);
}

export function readTemplate(name) {
  return readFileSync(templatePath(name), 'utf8');
}

const START = '<!-- gatewright:start -->';
const END = '<!-- gatewright:end -->';

// Put the agent-instruction block into an AGENTS.md-shaped text. The block is
// fenced by its start and end markers so it can be replaced without touching
// anything a human or another tool wrote around it.
export function upsertBlock(existingText, blockText) {
  const lines = existingText.split('\n');
  const starts = [];
  const ends = [];
  lines.forEach((line, i) => {
    if (line.trim() === START) starts.push(i);
    else if (line.trim() === END) ends.push(i);
  });

  if (starts.length > 1 || ends.length > 1) {
    throw new Error(
      `AGENTS.md has ${starts.length} gatewright start markers and ${ends.length} end markers; ` +
      'there must be exactly one fenced block. Fix the file by hand before gw can update it.',
    );
  }
  if (starts.length !== ends.length) {
    throw new Error(starts.length
      ? `AGENTS.md has a ${START} marker with no ${END} marker. Fix the file by hand before gw can update it.`
      : `AGENTS.md has a ${END} marker with no ${START} marker. Fix the file by hand before gw can update it.`);
  }

  if (starts.length === 1) {
    const [start, end] = [starts[0], ends[0]];
    if (start > end) {
      throw new Error(`AGENTS.md markers are out of order: ${START} must come before ${END}. Fix the file by hand before gw can update it.`);
    }
    const before = lines.slice(0, start).join('\n') + (start > 0 ? '\n' : '');
    const middle = blockText.endsWith('\n') ? blockText : `${blockText}\n`;
    const after = lines.slice(end + 1).join('\n');
    return before + middle + after;
  }

  const body = existingText.replace(/\s+$/, '');
  return body === '' ? blockText : `${body}\n\n${blockText}`;
}
