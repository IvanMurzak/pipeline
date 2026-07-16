// `pipeline release <patch|minor|major> [--plugin-root <path>] [--dry-run] [--json]`
//
// Automates the safe half of the plugin release dance mandated by CLAUDE.md:
// Claude Code caches installed plugins by name@version, so every meaningful
// change MUST bump `.claude-plugin/plugin.json`'s `version`. This command bumps
// that one field (semver patch/minor/major) and prints the checklist for the
// rest (commit/push + the parent marketplace repo's submodule-pointer bump).
//
// Deliberately NO git operations — it only edits plugin.json. The write is a
// targeted text substitution of the version value, so the file's existing
// formatting (2-space indentation, trailing newline, key order) is preserved.
//
// Exit: 0 (bumped | dry-run) · 2 (usage/env: bad level, unresolvable plugin
// root, unreadable or non-semver plugin.json) — mirroring `submodule bump`.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

export type BumpLevel = 'patch' | 'minor' | 'major';

export interface ReleaseArgs {
  level: BumpLevel;
  pluginRoot?: string;
  dryRun: boolean;
  json: boolean;
}

export interface ReleaseReport {
  status: 'bumped' | 'dry-run';
  old_version: string;
  new_version: string;
  plugin_json: string;
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/** Bump a strict `x.y.z` semver string. Throws on a non-semver input. */
export function bumpSemver(version: string, level: BumpLevel): string {
  const m = SEMVER_RE.exec(version.trim());
  if (!m) throw new Error(`not a semver x.y.z version: '${version}'`);
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  switch (level) {
    case 'patch':
      return `${major}.${minor}.${patch + 1}`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'major':
      return `${major + 1}.0.0`;
  }
}

/**
 * Resolve the plugin root (the directory containing `.claude-plugin/plugin.json`):
 *   1. `explicit` (--plugin-root) when given — used as-is, no fallback.
 *   2. `CLAUDE_PLUGIN_ROOT` when it contains a plugin.json (the installed case).
 *   3. Otherwise walk up from `startDir` (this module's dir under
 *      apps/pipeline-cli/src/commands) looking for `.claude-plugin/plugin.json`
 *      — the run-from-source case. Mirrors ui.ts:resolveSupervisorScript.
 * Returns null when nothing resolves. Pure (env + dirs injected) for tests.
 */
export function resolvePluginRoot(
  explicit: string | undefined,
  pluginRootEnv: string | undefined,
  startDir: string,
): string | null {
  const rel = join('.claude-plugin', 'plugin.json');
  if (explicit) {
    const root = resolve(explicit);
    return existsSync(join(root, rel)) ? root : null;
  }
  if (pluginRootEnv && existsSync(join(pluginRootEnv, rel))) return resolve(pluginRootEnv);
  let cur = resolve(startDir);
  for (let i = 0; i < 16; i++) {
    if (existsSync(join(cur, rel))) return cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

/**
 * Compute + apply the version bump for the plugin.json under `pluginRoot`.
 * Changes ONLY the version value: the write substitutes the old value inside
 * the original text (preserving formatting); it falls back to a 2-space
 * re-serialize only if the original text is too exotic to substitute safely.
 * Throws Error with a usage-style message on any invalid input (caller maps
 * that to exit 2).
 */
export function performRelease(
  pluginRoot: string,
  level: BumpLevel,
  dryRun: boolean,
): ReleaseReport {
  const pluginJsonPath = join(pluginRoot, '.claude-plugin', 'plugin.json');
  if (!existsSync(pluginJsonPath)) {
    throw new Error(`no plugin manifest at ${pluginJsonPath}`);
  }
  const raw = readFileSync(pluginJsonPath, 'utf-8');
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`invalid JSON in ${pluginJsonPath}`);
  }
  const oldVersion = manifest.version;
  if (typeof oldVersion !== 'string') {
    throw new Error(`no string 'version' field in ${pluginJsonPath}`);
  }
  if (!SEMVER_RE.test(oldVersion)) {
    throw new Error(
      `'version' in ${pluginJsonPath} is not semver x.y.z: '${oldVersion}'`,
    );
  }
  const newVersion = bumpSemver(oldVersion, level);

  if (!dryRun) {
    // Substitute only the version VALUE, in place, so every other byte of the
    // file (indentation, key order, spacing) survives untouched.
    const pattern = new RegExp(`("version"\\s*:\\s*")${escapeRegExp(oldVersion)}(")`);
    let next: string;
    if (pattern.test(raw)) {
      next = raw.replace(pattern, `$1${newVersion}$2`);
    } else {
      // Exotic formatting (e.g. escaped keys) — re-serialize with the standard
      // 2-space style instead of writing nothing.
      manifest.version = newVersion;
      next = JSON.stringify(manifest, null, 2) + '\n';
    }
    if (!next.endsWith('\n')) next += '\n';
    writeFileSync(pluginJsonPath, next);
  }

  return {
    status: dryRun ? 'dry-run' : 'bumped',
    old_version: oldVersion,
    new_version: newVersion,
    plugin_json: pluginJsonPath,
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseReleaseArgs(args: string[]): ReleaseArgs | { error: string } {
  let level: BumpLevel | undefined;
  let pluginRoot: string | undefined;
  let dryRun = false;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a === 'patch' || a === 'minor' || a === 'major') {
      if (level) return { error: `duplicate bump level '${a}'` };
      level = a;
    } else if (a === '--plugin-root') {
      pluginRoot = args[++i];
      if (!pluginRoot) return { error: '--plugin-root requires a path' };
    } else if (a.startsWith('--plugin-root=')) {
      pluginRoot = a.slice('--plugin-root='.length);
    } else if (a === '--dry-run') dryRun = true;
    else if (a === '--json') json = true;
    else return { error: `unknown argument '${a}'` };
  }
  if (!level) return { error: 'a bump level is required (patch | minor | major)' };
  return { level, pluginRoot, dryRun, json };
}

const CHECKLIST = [
  '',
  'Next steps (manual — this command touches only plugin.json):',
  '  1. Commit & push in the plugin repo.',
  '  2. In the marketplace repo: bump the submodule pointer + the',
  '     marketplace.json version, then commit.',
  '  3. Users pick the new version up on their next plugin update',
  '     (Claude Code caches plugins by name@version).',
  '',
].join('\n');

/** CLI shell: parse → resolve root → bump → print. */
export function runRelease(args: string[]): number {
  const parsed = parseReleaseArgs(args);
  if ('error' in parsed) {
    process.stderr.write(
      `pipeline release: ${parsed.error}\n` +
        'Usage: pipeline release <patch|minor|major> [--plugin-root <path>] [--dry-run] [--json]\n',
    );
    return 2;
  }

  const root = resolvePluginRoot(
    parsed.pluginRoot,
    process.env.CLAUDE_PLUGIN_ROOT,
    import.meta.dir,
  );
  if (!root) {
    process.stderr.write(
      parsed.pluginRoot
        ? `pipeline release: no .claude-plugin/plugin.json under --plugin-root (${resolve(parsed.pluginRoot)})\n`
        : 'pipeline release: could not locate .claude-plugin/plugin.json ' +
            '(pass --plugin-root, or set CLAUDE_PLUGIN_ROOT)\n',
    );
    return 2;
  }

  let report: ReleaseReport;
  try {
    report = performRelease(root, parsed.level, parsed.dryRun);
  } catch (e) {
    process.stderr.write(`pipeline release: ${(e as Error).message}\n`);
    return 2;
  }

  if (parsed.json) {
    process.stdout.write(JSON.stringify(report) + '\n');
  } else {
    process.stdout.write(`version: ${report.old_version} -> ${report.new_version}\n`);
    if (parsed.dryRun) {
      process.stdout.write(`(dry-run — ${report.plugin_json} not modified)\n`);
    } else {
      process.stdout.write(CHECKLIST);
    }
  }
  return 0;
}
