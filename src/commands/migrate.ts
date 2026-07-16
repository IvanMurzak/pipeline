// `pipeline migrate --to <N> [--dry-run] [--root <dir>] [--json]`
//
// Resolve the pipeline dir (explicit --root, else the nearest enclosing
// PIPELINE.md from cwd, else cwd), read its current `format:`, compute the
// migrated files IN MEMORY via the pure ladder walker, and:
//   • --dry-run: print the unified-ish DIFF and write NOTHING.
//   • otherwise: print the diff, run PLAN-LINT (computePlan) on the RESULT and
//     ABORT (writing nothing) if it has errors; only when lint passes are the
//     files written — atomically, per file (temp + rename) — so the tree is
//     never left half-migrated.
//
// Exit codes: 0 ok / nothing-to-do · 1 failure (bad target guard, missing
// ladder rung, lint abort, malformed source stamp) · 2 usage.
//
// I/O is confined to this command layer and is INJECTABLE (see MigrateDeps) so
// the pure ladder + the gate can be tested without a real filesystem. The pure
// transforms themselves do no I/O (lib/migrate/*).

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import {
  CURRENT_FORMAT_VERSION,
  FormatVersionError,
  classifyFormat,
  readPipelineFormat,
  type FormatReaderIO,
} from '../lib/format-version';
import { computePlan, findEnclosingPipelineRoot } from '../lib/plan';
import {
  MANIFEST_BASENAME,
  MigrationLadderError,
  migratePipeline,
  renderDiff,
  diffStat,
  type MigrationRegistry,
  type PipelineFiles,
} from '../lib/migrate';

/** Injectable seams — defaults use node:fs + computePlan. */
export interface MigrateDeps {
  /** Ladder to walk (default: the empty PRODUCTION_MIGRATIONS). */
  registry?: MigrationRegistry;
  /** Engine "current" format for target guarding (default: CURRENT_FORMAT_VERSION). */
  current?: number;
  /** Working directory used to resolve the pipeline (default: process.cwd()). */
  cwd?: string;
  /** Load PIPELINE.md + steps/** from a dir into a files map. */
  loadFiles?: (root: string) => PipelineFiles;
  /** Does a path exist? (used for the "is this a pipeline dir" check). */
  exists?: (path: string) => boolean;
  /** Plan-lint the RESULT (default: materialize to a temp dir + computePlan). */
  lint?: (files: PipelineFiles) => { errors: string[]; warnings: string[] };
  /** Persist the migrated files atomically; returns what changed. */
  writeFiles?: (root: string, before: PipelineFiles, after: PipelineFiles) => { written: string[]; deleted: string[] };
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

interface ParsedArgs {
  to?: number;
  dryRun: boolean;
  root?: string;
  json: boolean;
  error?: string;
}

function parseArgs(args: string[]): ParsedArgs {
  const out: ParsedArgs = { dryRun: false, json: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--to' || a.startsWith('--to=')) {
      const raw = a === '--to' ? args[++i] : a.slice('--to='.length);
      if (raw === undefined || !/^\d+$/.test(raw.trim()) || Number.parseInt(raw, 10) < 1) {
        out.error = `--to expects a positive integer, got '${raw ?? ''}'`;
        return out;
      }
      out.to = Number.parseInt(raw.trim(), 10);
    } else if (a === '--dry-run') {
      out.dryRun = true;
    } else if (a === '--root') {
      out.root = args[++i];
    } else if (a.startsWith('--root=')) {
      out.root = a.slice('--root='.length);
    } else if (a === '--json') {
      out.json = true;
    } else if (!a.startsWith('-') && out.root === undefined) {
      // Lenient positional dir (matches "cwd or arg").
      out.root = a;
    } else {
      out.error = `unknown argument '${a}'`;
      return out;
    }
  }
  return out;
}

function usage(): string {
  return [
    'Usage: pipeline migrate --to <N> [--dry-run] [--root <dir>] [--json]',
    '',
    '  Migrate a pipeline folder (PIPELINE.md + steps/**) to format <N> along the',
    '  paired up/down transform ladder. --dry-run prints the diff and writes',
    '  nothing; without it, the result must pass plan-lint or the migration aborts.',
  ].join('\n');
}

// ── default I/O adapters ─────────────────────────────────────────────────────

/** POSIX-relative key for a file under `root`. */
function relKey(root: string, abs: string): string {
  return relative(root, abs).split(sep).join('/');
}

/** Default loader: PIPELINE.md at the root + every file under steps/**. */
export function defaultLoadFiles(root: string): PipelineFiles {
  const files: PipelineFiles = {};
  const manifest = join(root, MANIFEST_BASENAME);
  if (existsSync(manifest)) files[MANIFEST_BASENAME] = readFileSync(manifest, 'utf8');
  const stepsDir = join(root, 'steps');
  const walk = (d: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      const full = join(d, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) files[relKey(root, full)] = readFileSync(full, 'utf8');
    }
  };
  walk(stepsDir);
  return files;
}

/** Default plan-lint: materialize the files to a temp dir and run computePlan. */
export function defaultLint(files: PipelineFiles): { errors: string[]; warnings: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-migrate-lint-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(dir, ...rel.split('/'));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    const plan = computePlan(dir);
    return { errors: plan.errors, warnings: plan.warnings };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Default writer: atomic PER FILE (write a sibling `.tmp` then rename over the
 * target). Only files that actually changed are written; files present in the
 * loaded set but absent from the result are removed. Callers run lint FIRST, so
 * no write happens for a lint-failing tree.
 */
export function defaultWriteFiles(
  root: string,
  before: PipelineFiles,
  after: PipelineFiles,
): { written: string[]; deleted: string[] } {
  const written: string[] = [];
  const deleted: string[] = [];
  for (const [rel, content] of Object.entries(after)) {
    if (before[rel] === content) continue;
    const abs = join(root, ...rel.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    const tmp = `${abs}.pipeline-migrate.tmp`;
    writeFileSync(tmp, content);
    renameSync(tmp, abs);
    written.push(rel);
  }
  for (const rel of Object.keys(before)) {
    if (Object.prototype.hasOwnProperty.call(after, rel)) continue;
    const abs = join(root, ...rel.split('/'));
    try {
      unlinkSync(abs);
      deleted.push(rel);
    } catch {
      /* already gone */
    }
  }
  return { written, deleted };
}

// ── command ──────────────────────────────────────────────────────────────────

export function runMigrate(args: string[], deps: MigrateDeps = {}): number {
  const out = (s: string) => (deps.stdout ?? ((x: string) => process.stdout.write(x)))(s);
  const err = (s: string) => (deps.stderr ?? ((x: string) => process.stderr.write(x)))(s);
  const emitUsageErr = (msg: string): number => {
    err(`pipeline migrate: ${msg}\n\n${usage()}\n`);
    return 2;
  };

  const parsed = parseArgs(args);
  if (parsed.error) return emitUsageErr(parsed.error);
  if (parsed.to === undefined) return emitUsageErr('--to <N> is required');

  const cwd = deps.cwd ?? process.cwd();
  const exists = deps.exists ?? existsSync;
  const loadFiles = deps.loadFiles ?? defaultLoadFiles;
  const lint = deps.lint ?? defaultLint;
  const writeFiles = deps.writeFiles ?? defaultWriteFiles;
  const current = deps.current ?? CURRENT_FORMAT_VERSION;

  // Resolve the pipeline dir: explicit --root, else nearest enclosing
  // PIPELINE.md from cwd, else cwd itself.
  const root = parsed.root ?? findEnclosingPipelineRoot(cwd) ?? cwd;
  if (!exists(join(root, MANIFEST_BASENAME))) {
    return emitUsageErr(`no ${MANIFEST_BASENAME} found at ${root} — point --root at a pipeline folder`);
  }

  const files = loadFiles(root);

  // Read + classify the CURRENT format (T1-17 accessor, injectable fs).
  const readerIO: FormatReaderIO = {
    exists,
    readFile: (p) => (p === join(root, MANIFEST_BASENAME) ? files[MANIFEST_BASENAME] ?? readFileSync(p, 'utf8') : readFileSync(p, 'utf8')),
  };
  let fromVersion: number;
  try {
    fromVersion = readPipelineFormat(root, { io: readerIO });
    classifyFormat(fromVersion, current); // throws only on a malformed stamp
  } catch (e) {
    if (e instanceof FormatVersionError) {
      err(`pipeline migrate: ${e.message}\n`);
      return 1;
    }
    throw e;
  }

  // Walk the ladder (pure, in memory). Guard failures → exit 1.
  let result;
  try {
    result = migratePipeline(files, parsed.to, {
      current,
      ...(deps.registry ? { registry: deps.registry } : {}),
    });
  } catch (e) {
    if (e instanceof FormatVersionError || e instanceof MigrationLadderError) {
      err(`pipeline migrate: ${e.message}\n`);
      return 1;
    }
    throw e;
  }

  if (!result.changed) {
    if (parsed.json) {
      out(JSON.stringify({ from: fromVersion, to: parsed.to, changed: false, dryRun: parsed.dryRun, wrote: [] }) + '\n');
    } else {
      out(`pipeline migrate: already at format ${fromVersion} — nothing to do.\n`);
    }
    return 0;
  }

  const diff = renderDiff(files, result.files);
  const stat = diffStat(files, result.files);
  const summary = `format ${result.from} -> ${result.to} (${stat.changed} changed, ${stat.added} added, ${stat.removed} removed)`;

  if (parsed.dryRun) {
    if (parsed.json) {
      out(JSON.stringify({ from: result.from, to: result.to, changed: true, dryRun: true, applied: result.applied, stat, wrote: [] }) + '\n');
    } else {
      out(`pipeline migrate [dry-run]: ${summary}\n\n${diff}\n\n[dry-run] no files written.\n`);
    }
    return 0;
  }

  // Non-dry-run: show the diff, then GATE on plan-lint before any write.
  if (!parsed.json) out(`pipeline migrate: ${summary}\n\n${diff}\n\n`);

  const lintResult = lint(result.files);
  if (lintResult.errors.length > 0) {
    err(
      `pipeline migrate: ABORTED — the migrated pipeline fails plan-lint (nothing was written):\n` +
        lintResult.errors.map((m) => `  - ${m}`).join('\n') +
        '\n',
    );
    return 1;
  }

  const wrote = writeFiles(root, files, result.files);
  if (parsed.json) {
    out(
      JSON.stringify({
        from: result.from,
        to: result.to,
        changed: true,
        dryRun: false,
        applied: result.applied,
        stat,
        wrote: wrote.written,
        deleted: wrote.deleted,
      }) + '\n',
    );
  } else {
    out(`pipeline migrate: wrote ${wrote.written.length} file(s) — ${summary}\n`);
  }
  return 0;
}
