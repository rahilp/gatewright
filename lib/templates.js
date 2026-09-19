// The shipped defaults: the eight-stage board, the tool config, the dispatch
// prompt, and the fenced agent-instruction block. `init` and `upgrade` install
// from here so the defaults live in exactly one place — templates/.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');

export function templatePath(name) {
  return join(TEMPLATES_DIR, name);
}

export function readTemplate(name) {
  return readFileSync(templatePath(name), 'utf8');
}

// Pipeline presets deliberately live next to the shipped templates rather
// than being assembled from command code.  That keeps `init` a small installer
// and gives users (and tests) one inspectable definition of each first-run
// workflow.
export function readPipelinePreset(name) {
  const preset = JSON.parse(readTemplate(`pipeline-${name}.json`));
  if (preset.stages_template) preset.stages = JSON.parse(readTemplate(preset.stages_template));
  return preset;
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
// instruction files of specific providers. A target is invited when one of
// its signals exists. `.github/` is deliberately not a Copilot signal: it is
// common GitHub infrastructure and says nothing about Copilot usage.
// These relative paths are metadata: they are compared and displayed as-is,
// then joined onto `root` only when the filesystem is consulted. Keep them as
// forward-slash literals so the text Gatewright reports is identical on every
// platform; `path.join(root, relativePath)` accepts them on Windows too.
export const BLOCK_TARGETS = [
  // A `.claude/` directory is itself a Claude Code project signal; Claude
  // reads the project-root CLAUDE.md, so create that readable entry point.
  { name: 'claude', label: 'Claude', file: 'CLAUDE.md', signals: ['CLAUDE.md', '.claude'] },
  { name: 'cursor', label: 'Cursor', file: '.cursor/rules/gatewright.mdc', signals: ['.cursor', '.cursorrules'] },
  { name: 'copilot', label: 'Copilot', file: '.github/copilot-instructions.md', signals: ['.github/copilot-instructions.md'] },
];

// Write the current shipped block into one instruction file: replaced in place
// when the fenced block is already there, appended after a blank line when it
// is not. Callers decide whether the file is invited; a missing file is
// treated as empty text so an invited target can be created.
export function upsertBlockFile(path) {
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, upsertBlock(text, readTemplate('agents-block.md')));
}
