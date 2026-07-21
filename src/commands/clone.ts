// `pipeline clone <name> [--force] [--dir <path>] [--list] [--json]`
//
// Copies a bundled, ready-made pipeline TEMPLATE (see src/lib/templates.ts) into
// the consumer project's `./.claude/pipeline/<name>/` (relative to the CURRENT
// working directory by default, or `--dir <path>`). This is the local-first
// onboarding entry point: a user installs @baizor/pipeline, then
// `pipeline clone <name>` drops a working pipeline they can run and adapt.
//
// The templates ship INSIDE this package and are resolved relative to the CLI's
// own source (src/lib/templates.ts, `import.meta.dir`), never the cwd — so clone
// behaves identically from a plugin checkout and an npm/bun global install.
//
// Cross-platform (node/bun `path` + `fs` only; CI runs the CLI on ubuntu AND
// windows). Refuses to overwrite an existing target unless `--force` is passed.
//
// Exit codes:
//   0  cloned (or `--list` / `--help`)
//   1  refused — `./.claude/pipeline/<name>/` already exists (pass --force), or
//      the copy failed
//   2  usage — no name, unknown template (lists available), or a bad flag

import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { copyTemplateTree, findTemplate, formatTemplateList, TEMPLATES } from '../lib/templates';

interface CloneArgs {
  /** The template id / positional `<name>`. */
  name?: string;
  /** Project root the pipeline is cloned INTO (default: process.cwd()). */
  dir?: string;
  force: boolean;
  list: boolean;
  json: boolean;
  help: boolean;
  /** An unrecognized `--flag` — a loud usage error rather than a silent no-op. */
  unknownFlag?: string;
  /** A second positional — clone takes exactly one name. */
  extra?: string;
}

const USAGE = 'Usage: pipeline clone <name> [--force] [--dir <path>] [--list] [--json]';

function parseArgs(args: string[]): CloneArgs {
  const out: CloneArgs = { force: false, list: false, json: false, help: false };
  const take = (i: number) => args[i + 1];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = (p: string) => (a.startsWith(p + '=') ? a.slice(p.length + 1) : undefined);
    if (a === '--force' || a === '-f') out.force = true;
    else if (a === '--list' || a === '-l') out.list = true;
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--dir') out.dir = take(i++);
    else if (eq('--dir') !== undefined) out.dir = eq('--dir');
    else if (a === '--') continue;
    else if (a.startsWith('-')) out.unknownFlag = a;
    else if (out.name === undefined) out.name = a;
    else out.extra = a;
  }
  return out;
}

/** POSIX-relative, sorted list of every FILE under `root` (for the report). */
function listFilesRel(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), childRel);
      else out.push(childRel);
    }
  };
  walk(root, '');
  return out.sort();
}

function helpText(): string {
  return (
    `${USAGE}\n\n` +
    'Copy a bundled ready-made pipeline template into ./.claude/pipeline/<name>/\n' +
    '(relative to the current directory, or --dir <path>).\n\n' +
    'Options:\n' +
    '  --force, -f   Overwrite an existing ./.claude/pipeline/<name>/ target.\n' +
    '  --dir <path>  Project root to clone into (default: current directory).\n' +
    '  --list, -l    List the available templates and exit.\n' +
    '  --json        Print the result (or template list) as JSON.\n' +
    '  --help, -h    Show this help.\n\n' +
    'Available templates:\n' +
    `${formatTemplateList()}\n`
  );
}

export function runClone(args: string[]): number {
  const a = parseArgs(args);
  const err = (s: string) => process.stderr.write(s);
  const out = (s: string) => process.stdout.write(s);
  const usage = (msg: string): number => {
    err(`pipeline clone: ${msg}\n`);
    return 2;
  };

  if (a.help) {
    out(helpText());
    return 0;
  }
  if (a.unknownFlag !== undefined) return usage(`unknown flag '${a.unknownFlag}'\n${USAGE}`);
  if (a.extra !== undefined) {
    return usage(`unexpected extra argument '${a.extra}' — clone takes exactly one <name>\n${USAGE}`);
  }

  if (a.list) {
    if (a.json) out(JSON.stringify({ templates: TEMPLATES }, null, 2) + '\n');
    else out(`Available templates:\n${formatTemplateList()}\n`);
    return 0;
  }

  if (a.name === undefined) {
    return usage(`a template <name> is required.\n\nAvailable templates:\n${formatTemplateList()}\n\n${USAGE}`);
  }

  const entry = findTemplate(a.name);
  if (entry === undefined) {
    return usage(`unknown template '${a.name}'.\n\nAvailable templates:\n${formatTemplateList()}`);
  }

  const projectRoot = resolve(a.dir ?? process.cwd());
  const dest = join(projectRoot, '.claude', 'pipeline', entry.name);

  if (existsSync(dest)) {
    if (!a.force) {
      err(
        `pipeline clone: target already exists: ${dest}\n` +
          '  pass --force to overwrite it (this replaces the folder entirely).\n',
      );
      return 1;
    }
    try {
      // Remove first so the fresh copy can never inherit a stale file from a
      // prior clone (a plain overwrite would leave files the template dropped).
      rmSync(dest, { recursive: true, force: true });
    } catch (e) {
      err(`pipeline clone: could not remove existing target ${dest}: ${(e as Error).message}\n`);
      return 1;
    }
  }

  try {
    copyTemplateTree(entry.name, dest);
  } catch (e) {
    err(`pipeline clone: failed to copy template '${entry.name}': ${(e as Error).message}\n`);
    return 1;
  }

  const files = listFilesRel(dest);
  if (a.json) {
    out(JSON.stringify({ cloned: true, template: entry.name, dest, files }, null, 2) + '\n');
  } else {
    out(`Cloned template '${entry.name}' → ${dest}\n`);
    for (const f of files) out(`  ${f}\n`);
    out(`\nNext: run it with\n  pipeline next --root "${dest}" --run-id <id>\n`);
  }
  return 0;
}
