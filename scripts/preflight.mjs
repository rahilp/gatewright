import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LOCAL_PATH = /\/home\/|\/Users\/|C:\\Users\\/;
const VERSION = /(?<![\d.])v?(\d+\.\d+(?:\.\d+)?)(?!\d|\.\d)/g;

function read(root, file) {
  return readFileSync(join(root, file), 'utf8');
}

function command(root, program, args) {
  try {
    return { ok: true, output: execFileSync(program, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}`.trim(), error };
  }
}

function shippedFiles(root, pkg) {
  const files = new Set(['README.md', 'LICENSE']);
  for (const entry of pkg.files ?? []) {
    const target = join(root, entry);
    if (!existsSync(target)) continue;
    if (statSync(target).isDirectory()) {
      const visit = (dir) => {
        for (const name of readdirSync(dir)) {
          const child = join(dir, name);
          if (statSync(child).isDirectory()) visit(child);
          else files.add(child.slice(root.length + 1));
        }
      };
      visit(target);
    } else {
      files.add(entry);
    }
  }
  return [...files];
}

function versionFailures(readme, version) {
  const failures = [];
  let heading = '';
  for (const [index, line] of readme.split(/\r?\n/).entries()) {
    const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch) heading = headingMatch[1].toLowerCase();
    const planned = /\b(coming|planned|not yet)\b/i.test(heading) || /\b(coming|planned|not yet)\b/i.test(line);
    const statusContext = (/\b(status|release|current)\b/i.test(heading)
      && /\b(gatewright\s+(?:is\s+at|version)|current version|release version)\b/i.test(line))
      || /\b(gatewright\s+(?:is\s+at|version)|current version|release version)\b/i.test(line)
      || /^#{1,6}\s+.*\bv?\d+\.\d+/i.test(line);
    if (!planned && statusContext) {
      for (const match of line.matchAll(VERSION)) {
        if (match[1] !== version) failures.push(`README.md:${index + 1}: claims version ${match[0]}; update it to ${version}, or put planned versions under a Coming, Planned, or Not Yet heading.`);
      }
    }
  }
  return failures;
}

function documentedCommands(readme) {
  const commands = new Map();
  for (const [index, line] of readme.split(/\r?\n/).entries()) {
    const match = line.match(/^\|\s*`gw\s+([a-z][\w-]*)\b[^`]*`\s*\|/i);
    if (match) commands.set(match[1], { line: index + 1, notYet: /\*\*\s*not yet\b/i.test(line) });
  }
  return commands;
}

export function helpCommands(help) {
  const commands = new Set();
  for (const line of help.split(/\r?\n/)) {
    const syntax = line.match(/^ {2}([^\n]+)$/)?.[1] ?? '';
    const primary = syntax.match(/^([a-z][\w-]*)\b/);
    if (primary) commands.add(primary[1]);
    for (const match of syntax.matchAll(/\|\s*([a-z][\w-]*)\b/g)) commands.add(match[1]);
  }
  return commands;
}

function advertisedImportFormats(help) {
  const line = help.split(/\r?\n/).find((candidate) => /^ {2}import\b/.test(candidate));
  const values = line?.match(/--format\s+([a-z]+(?:\|[a-z]+)*)/i)?.[1];
  return values ? values.split('|') : [];
}

function commandModules(root) {
  const directory = join(root, 'lib', 'commands');
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((file) => file.endsWith('.js'))
    .map((file) => file.slice(0, -3));
}

function importFormatFailures(root, bin, help) {
  const formats = advertisedImportFormats(help);
  if (!formats.length) return [];
  const probe = mkdtempSync(join(tmpdir(), 'gatewright-preflight-'));
  try {
    writeFileSync(join(probe, 'tasks.md'), '## P1\n\n- [ ] Probe\n');
    const initialized = command(probe, process.execPath, [join(root, bin), 'init']);
    if (!initialized.ok) return [`${bin}: could not initialize isolated --format probe; fix the binary. ${initialized.output}`];
    const failures = [];
    for (const format of formats) {
      const result = command(probe, process.execPath, [join(root, bin), 'import', '--format', format, '--dry-run', 'tasks.md']);
      if (!result.ok) failures.push(`${bin}: advertises \`--format ${format}\`, but the binary rejects it; remove it from gw --help or implement it. ${result.output}`);
    }
    return failures;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

function tarballFiles(root) {
  const packed = command(root, 'npm', ['pack', '--dry-run', '--json']);
  if (!packed.ok) return { error: packed.output || 'npm pack --dry-run --json failed' };
  try {
    const report = JSON.parse(packed.output);
    return { files: report[0]?.files?.map((file) => file.path) ?? [] };
  } catch {
    return { error: `could not parse npm pack output: ${packed.output}` };
  }
}

export function runPreflight({ root = process.cwd(), ci = false } = {}) {
  root = resolve(root);
  const failures = [];
  let pkg;
  let readme;
  try {
    pkg = JSON.parse(read(root, 'package.json'));
    readme = ci ? '' : read(root, 'README.md');
  } catch (error) {
    return [`preflight${ci ? ' --ci' : ''}: ${ci ? 'package.json' : 'package.json and README.md'} must be readable: ${error.message}`];
  }

  if (!ci) failures.push(...versionFailures(readme, pkg.version));
  for (const file of shippedFiles(root, pkg)) {
    if (!existsSync(join(root, file))) continue;
    if (LOCAL_PATH.test(read(root, file))) failures.push(`${file}: contains a local path; remove /home/, /Users/, or C:\\Users\\ before publishing.`);
  }

  if (!ci) {
    const bin = pkg.bin?.gw;
    const help = bin && existsSync(join(root, bin))
      ? command(root, process.execPath, [join(root, bin), '--help'])
      : { ok: false, output: 'package.json bin.gw is missing' };
    if (!help.ok) {
      failures.push(`${bin ?? 'package.json'}: could not run local gw --help; fix the binary before release. ${help.output}`);
    } else {
      const available = helpCommands(help.output);
      for (const [name, doc] of documentedCommands(readme)) {
        if (doc.notYet && available.has(name)) failures.push(`README.md:${doc.line}: marks \`gw ${name}\` as not yet, but gw --help lists it; update the command table.`);
        else if (!doc.notYet && !available.has(name)) failures.push(`README.md:${doc.line}: documents \`gw ${name}\`, but gw --help does not list it; update the README or binary.`);
      }
      const modules = new Set(commandModules(root));
      for (const name of modules) if (!available.has(name)) failures.push(`lib/commands/${name}.js: command module is absent from gw --help; add it to the usage block.`);
      for (const name of available) if (!modules.has(name)) failures.push(`gw --help: advertises \`${name}\`, but lib/commands/${name}.js is absent; add the module or remove the usage entry.`);
      failures.push(...importFormatFailures(root, bin, help.output));
    }

    const tests = command(root, 'npm', ['test']);
    if (!tests.ok) failures.push(`package.json scripts.test: test suite failed; fix failing tests. ${tests.output}`);

    const status = command(root, 'git', ['status', '--porcelain']);
    if (!status.ok) failures.push(`git status: could not inspect the working tree; fix git metadata. ${status.output}`);
    else if (status.output) failures.push(`git status: working tree is dirty; commit or stash changes before publishing.\n${status.output}`);

    const tag = command(root, 'git', ['tag', '-l', `v${pkg.version}`]);
    if (!tag.ok) failures.push(`git tag: could not inspect tags; fix git metadata. ${tag.output}`);
    else if (tag.output.split(/\r?\n/).includes(`v${pkg.version}`)) failures.push(`git tag: v${pkg.version} already exists; bump package.json before publishing.`);
    const branch = command(root, 'git', ['branch', '--show-current']);
    const defaultRef = command(root, 'git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    const defaultBranch = defaultRef.ok ? defaultRef.output.replace(/^origin\//, '').trim() : 'main';
    if (!branch.ok || !branch.output.trim()) failures.push('git branch: HEAD is detached; check out the default branch before publishing.');
    else if (branch.output.trim() !== defaultBranch) failures.push(`git branch: HEAD is on ${branch.output.trim()}, not default branch ${defaultBranch}; check out ${defaultBranch} before publishing.`);
  }

  const tarball = tarballFiles(root);
  if (tarball.error) failures.push(`npm pack: ${tarball.error}`);
  else {
    if (tarball.files.length === 0) failures.push('npm pack: tarball file list is empty; configure package.json files.');
    for (const file of tarball.files) if (/(^|\/)(test|docs)\//.test(file)) failures.push(`npm pack: includes ${file}; exclude test/ and docs/ from the published package.`);
    for (const required of ['README.md', 'LICENSE']) if (!tarball.files.includes(required)) failures.push(`npm pack: ${required} is absent; include it in the published package.`);
  }

  if (pkg.version.includes('-dev') || pkg.version === '0.0.0') failures.push(`package.json: version ${pkg.version} is a placeholder; set a publishable release version.`);
  return failures;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const ci = process.argv.includes('--ci');
  const failures = runPreflight({ ci });
  if (failures.length) {
    console.error(`preflight${ci ? ' --ci' : ''} failed (${failures.length}):`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(`preflight${ci ? ' --ci' : ''} passed`);
  }
}
