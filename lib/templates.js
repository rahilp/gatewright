// The shipped defaults: the eight-stage board, the tool config, the dispatch
// prompt, and the fenced agent-instruction block. `init` and `upgrade` install
// from here so the defaults live in exactly one place — templates/.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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

// Where the agent-instruction block also lives, besides AGENTS.md, in the
// instruction files of specific providers. A target is invited when `file`
// exists; a `parent` (where set) also invites when that directory exists —
// CLAUDE.md has no parent clause because a repo root always exists, so
// creating CLAUDE.md there would never be the user's invitation.
export const BLOCK_TARGETS = [
  { file: 'CLAUDE.md', parent: null },
  { file: join('.cursor', 'rules', 'gatewright.mdc'), parent: join('.cursor', 'rules') },
  { file: join('.github', 'copilot-instructions.md'), parent: '.github' },
];

// Write the current shipped block into one instruction file: replaced in place
// when the fenced block is already there, appended after a blank line when it
// is not. Callers decide whether the file is invited; a missing file is
// treated as empty text so an invited target can be created.
export function upsertBlockFile(path) {
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  writeFileSync(path, upsertBlock(text, readTemplate('agents-block.md')));
}
