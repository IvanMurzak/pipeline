// The BUILT-IN default provisioner (taskflow-v2 a3) — `pipeline worktree
// create` in a repository that has authored NO `worktree-create.*`.
//
// Everything here runs against REAL git repositories (temp sandboxes with a
// real submodule, a real `next` branch, real worktrees), because every property
// under test is a property of git's behavior, not of a mock's: whether a
// submodule slot is cut from the submodule's own integration branch, whether a
// linked worktree's `rev-parse --show-toplevel` is the slot or a `core.worktree`
// redirect back into the main checkout (R10), and whether the slot lands outside
// the repository at all.
//
// The two places a fake git IS used are the two failure modes a real git cannot
// be asked to produce on demand: a too-old version string (R10's preflight) and
// a toplevel that lies (R10's catastrophic case). Both wrap the real runner and
// rewrite exactly one answer.
//
// The D9 boundary — that none of this is reachable from a pipeline RUN — is
// asserted in tests/worktree-hook-module.test.ts, beside a1's original guard,
// so the frozen contract keeps ONE place that compares its callers.

import { test, expect, afterEach } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupCreated, ident, mkTmp } from './_git-sandbox';
import { runWorktree } from '../src/commands/worktree';
import { parseEnvFile } from '../src/lib/env-file';
import { realGit, type GitResult, type GitRunner } from '../src/lib/git';
import {
  ENV_KEY_RE,
  ENV_VALUE_RE,
  MIN_GIT_VERSION_TEXT,
  invalidSubmodulePath,
  isUnder,
  parseGitVersion,
  slotRootFor,
  toPosixPath,
  unsafeEnvEntry,
} from '../src/lib/worktree-provision';

afterEach(cleanupCreated);

// ---------------------------------------------------------------------------
// Sandboxes
// ---------------------------------------------------------------------------

function sh(args: string[], cwd?: string, check = true): GitResult {
  const r = realGit(args, cwd);
  if (check && r.code !== 0) {
    throw new Error(`git ${args.join(' ')} @ ${cwd ?? '.'} → ${r.code}: ${(r.stderr || r.stdout).trim()}`);
  }
  return r;
}

/** Git's OWN spelling of a repo root. GitHub's Windows runner hands out 8.3
 *  short TEMP segments that realpathSync does not expand, while every git
 *  command prints the long canonical form — and the provisioner anchors on
 *  git's answer, so the tests must too. */
function gitRoot(dir: string): string {
  const top = sh(['rev-parse', '--show-toplevel'], dir).stdout.trim();
  return process.platform === 'win32' ? top.replace(/\//g, '\\') : top;
}

/** A repo with one commit on `main`. `hooks: false` (the default) leaves the
 *  project with no `.pipeline/.hooks` directory at all — a repository that has
 *  authored no hooks, which is the case this whole feature exists for. */
function scaffold(opts: { createHook?: string } = {}): string {
  const tmp = mkTmp('wtprov-');
  sh(['init', '-q', '-b', 'main', tmp]);
  ident(tmp);
  writeFileSync(join(tmp, 'README.md'), 'x\n');
  sh(['add', '.'], tmp);
  sh(['commit', '-q', '-m', 'init'], tmp);
  const root = gitRoot(tmp);
  if (opts.createHook !== undefined) {
    const hooks = join(root, '.pipeline', '.hooks');
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, 'worktree-create.js'), opts.createHook);
  }
  return root;
}

interface SubWorld {
  root: string;
  /** `<sub>/next` tip — what an integration-branch slot must be cut from. */
  gatedNextTip: string;
  /** `<sub>/main` tip — the parent's pin AND the parent's base, so a slot that
   *  landed here would be indistinguishable from "took the pin". */
  gatedMainTip: string;
  plainMainTip: string;
}

/** A superproject with REAL submodules (gitfile + `.git/modules/<name>`, i.e.
 *  the shape that carries a `core.worktree` redirect):
 *    `pkg/gated` — has `next`. Its integration branch is NOT `main`.
 *    `pkg/plain` — has no `next`. It falls back to the parent's base. Only
 *                  built when `withPlain`, because a real `submodule add` is
 *                  a clone and these sandboxes are the slowest thing in the
 *                  suite; only the integration-branch test needs both.
 *  Both are pinned at their `main` tip, so a slot cut from `next` cannot be
 *  confused with a slot cut from the pin or from the parent's base. */
function subWorld(withPlain = true): SubWorld {
  const base = mkTmp('wtprovsub-');
  const mkSub = (name: string, withNext: boolean): { origin: string; nextTip: string; mainTip: string } => {
    const origin = join(base, name);
    sh(['init', '-q', '-b', 'main', origin]);
    ident(origin);
    writeFileSync(join(origin, 'a.txt'), 'main\n');
    sh(['add', '.'], origin);
    sh(['commit', '-q', '-m', `${name} main`], origin);
    const mainTip = sh(['rev-parse', 'HEAD'], origin).stdout.trim();
    let nextTip = '';
    if (withNext) {
      sh(['checkout', '-q', '-b', 'next'], origin);
      writeFileSync(join(origin, 'b.txt'), 'next\n');
      sh(['add', '.'], origin);
      sh(['commit', '-q', '-m', `${name} next`], origin);
      nextTip = sh(['rev-parse', 'HEAD'], origin).stdout.trim();
      sh(['checkout', '-q', 'main'], origin);
    }
    return { origin, nextTip, mainTip };
  };
  const gated = mkSub('gated-origin', true);
  const plain = withPlain ? mkSub('plain-origin', false) : { origin: '', nextTip: '', mainTip: '' };

  const parent = join(base, 'super');
  sh(['init', '-q', '-b', 'main', parent]);
  ident(parent);
  writeFileSync(join(parent, 'README.md'), 'super\n');
  sh(['add', '.'], parent);
  sh(['commit', '-q', '-m', 'init'], parent);
  // `-c protocol.file.allow=always`: git >= 2.38 refuses the file transport for
  // submodules by default. A REAL `submodule add` (not a plain clone) is the
  // point — it is what produces the gitfile + shared config that makes R10 real.
  const declared: Array<[string, string]> = [[toPosixPath(gated.origin), 'pkg/gated']];
  if (withPlain) declared.push([toPosixPath(plain.origin), 'pkg/plain']);
  for (const [url, path] of declared) {
    sh(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', url, path], parent);
    ident(join(parent, path));
  }
  sh(['commit', '-q', '-m', 'add submodules'], parent);
  return {
    root: gitRoot(parent),
    gatedNextTip: gated.nextTip,
    gatedMainTip: gated.mainTip,
    plainMainTip: plain.mainTip,
  };
}

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

/** cwd → the project; PIPELINE_WT_ROOT → a temp slot root (so slots are cleaned
 *  up with the sandbox and never land in the developer's real C:/tmp);
 *  PIPELINE_WT_FETCH / _INTEGRATION_BRANCH pinned off/default so a developer's
 *  environment cannot change what the suite exercises. */
function inProject<T>(root: string, fn: (slotRoot: string) => T): T {
  const prev = process.cwd();
  const keys = ['PIPELINE_WT_ROOT', 'PIPELINE_WT_FETCH', 'PIPELINE_WT_INTEGRATION_BRANCH'];
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];
  const wtRoot = mkTmp('wtroot-');
  try {
    process.chdir(root);
    process.env.PIPELINE_WT_ROOT = wtRoot;
    delete process.env.PIPELINE_WT_FETCH;
    delete process.env.PIPELINE_WT_INTEGRATION_BRANCH;
    return fn(slotRootFor(root));
  } finally {
    process.chdir(prev);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function call(args: string[], git: GitRunner = realGit): { code: number; out: string; err: string } {
  let out = '';
  let err = '';
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  (process.stdout as any).write = (c: unknown) => ((out += String(c)), true);
  (process.stderr as any).write = (c: unknown) => ((err += String(c)), true);
  let code: number;
  try {
    code = runWorktree(args, git);
  } finally {
    (process.stdout as any).write = origOut;
    (process.stderr as any).write = origErr;
  }
  return { code, out, err };
}

function callJson(args: string[], git: GitRunner = realGit): { code: number; json: any } {
  const r = call([...args, '--json'], git);
  return { code: r.code, json: r.out.trim() ? JSON.parse(r.out) : null };
}

/** The env file's RAW lines as [key, value], comments dropped. Deliberately not
 *  parseEnvFile: the point of DoD 4 is what is ON DISK, before any tolerant
 *  reader has had a chance to forgive it. */
function rawEntries(file: string): Array<[string, string]> {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      expect(i).toBeGreaterThan(0);
      return [l.slice(0, i), l.slice(i + 1)] as [string, string];
    });
}

const slotFile = (root: string, name: string): string =>
  join(root, '.pipeline', '.runtime', 'worktrees', `${name}.json`);

// ---------------------------------------------------------------------------
// (1) DoD 1 + 8 — it provisions, and the slot is outside the repository
// ---------------------------------------------------------------------------

test('no worktree-create.* at all: the command provisions the slot itself and returns worktree_path, branch and env_file', () => {
  const root = scaffold();
  inProject(root, (slotRoot) => {
    const r = callJson(['create', '--name', 'solo']);
    expect(r.code).toBe(0);
    expect(r.json.ok).toBe(true);
    expect(r.json.status).toBe('created');
    expect(r.json.provisioner).toBe('builtin');

    // The three fields a create hook would have returned.
    expect(r.json.worktree_path).toBe(`${slotRoot}/solo`);
    expect(r.json.branch).toBe('worktree-solo');
    expect(r.json.env_file).toBe(`${slotRoot}/solo.env`);

    // A WORKING slot: a real checkout, on its own branch, registered with git.
    expect(existsSync(join(r.json.worktree_path, 'README.md'))).toBe(true);
    expect(sh(['rev-parse', '--abbrev-ref', 'HEAD'], r.json.worktree_path).stdout.trim()).toBe('worktree-solo');
    expect(sh(['rev-parse', 'HEAD'], r.json.worktree_path).stdout.trim()).toBe(
      sh(['rev-parse', 'main'], root).stdout.trim(),
    );
    expect(sh(['worktree', 'list', '--porcelain'], root).stdout).toContain(
      process.platform === 'win32' ? r.json.worktree_path : r.json.worktree_path,
    );
    expect(existsSync(r.json.env_file)).toBe(true);
    expect(existsSync(slotFile(root, 'solo'))).toBe(true);
    expect(JSON.parse(readFileSync(slotFile(root, 'solo'), 'utf8')).provisioner).toBe('builtin');

    // DoD 8 — OUTSIDE the repository working tree, both of them. A worker's
    // node_modules and build output must never appear in the project folder.
    expect(isUnder(r.json.worktree_path, root)).toBe(false);
    expect(isUnder(r.json.env_file, root)).toBe(false);
    expect(existsSync(join(root, '.claude', 'worktrees'))).toBe(false);
    // …and stated as a path fact too, not only through the helper.
    expect(r.json.worktree_path.startsWith(toPosixPath(root) + '/')).toBe(false);
  });
}, 180000);

test('the built-in provisioner refuses a slot root INSIDE the repository', () => {
  const root = scaffold();
  inProject(root, () => {
    process.env.PIPELINE_WT_ROOT = join(root, 'slots');
    const r = callJson(['create', '--name', 'inside']);
    expect(r.code).toBe(1);
    expect(r.json.ok).toBe(false);
    expect(r.json.worktree_path).toBeNull();
    expect(r.json.detail).toContain('refusing to provision inside the repository');
    expect(existsSync(join(root, 'slots'))).toBe(false);
  });
}, 120000);

test('idempotent per name: a second create REUSES the built-in slot and re-reports it', () => {
  const root = scaffold();
  inProject(root, () => {
    const first = callJson(['create', '--name', 'twice']);
    expect(first.json.status).toBe('created');
    const second = callJson(['create', '--name', 'twice']);
    expect(second.code).toBe(0);
    expect(second.json.status).toBe('reused');
    expect(second.json.reused).toBe(true);
    expect(second.json.worktree_path).toBe(first.json.worktree_path);
    expect(second.json.branch).toBe('worktree-twice');
    expect(existsSync(second.json.env_file)).toBe(true);
  });
}, 180000);

// ---------------------------------------------------------------------------
// (2) DoD 2 — a repository WITH a hook is untouched
// ---------------------------------------------------------------------------

test('a repository WITH a worktree-create.* is unaffected: the hook runs, the provisioner does not', () => {
  const root = scaffold({
    createHook: `
const fs = require('fs');
const path = require('path');
fs.writeFileSync(path.join(process.cwd(), 'hook-ran'), '1');
const wt = path.join(process.cwd(), '.claude', 'worktrees', process.env.PIPELINE_WT_NAME);
fs.mkdirSync(wt, { recursive: true });
process.stdout.write(JSON.stringify({ worktree_path: wt, branch: 'hook-branch', env_file: null }) + '\\n');
`,
  });
  inProject(root, (slotRoot) => {
    const r = callJson(['create', '--name', 'hooked']);
    expect(r.code).toBe(0);
    expect(r.json.provisioner).toBe('hook');
    // The HOOK's answers, verbatim — not the provisioner's conventions.
    expect(r.json.worktree_path).toBe(join(root, '.claude', 'worktrees', 'hooked'));
    expect(r.json.branch).toBe('hook-branch');
    expect(r.json.env_file).toBeNull();
    expect(r.json.submodule_slots).toEqual([]);
    expect(existsSync(join(root, 'hook-ran'))).toBe(true);

    // The provisioner did not run alongside it: no slot dir, no env file, and
    // no `worktree-hooked` branch invented behind the hook's back.
    expect(existsSync(`${slotRoot}/hooked`)).toBe(false);
    expect(existsSync(`${slotRoot}/hooked.env`)).toBe(false);
    expect(sh(['branch', '--list', 'worktree-hooked'], root).stdout.trim()).toBe('');
  });
}, 180000);

// ---------------------------------------------------------------------------
// (3) DoD 3 — submodule slots, cut from the submodule's INTEGRATION branch
// ---------------------------------------------------------------------------

test("each declared submodule gets its own worktree cut from THAT submodule's integration branch — `next` where it exists, the parent's base where it does not", () => {
  const w = subWorld();
  inProject(w.root, (slotRoot) => {
    const r = callJson(['create', '--name', 'multi', '--base', 'main', '--submodules', 'pkg/gated,pkg/plain']);
    expect(r.code).toBe(0);
    expect(r.json.ok).toBe(true);

    const slots: Array<{ path: string; name: string; dir: string; base: string }> = r.json.submodule_slots;
    expect(slots.map((s) => s.path)).toEqual(['pkg/gated', 'pkg/plain']);

    const gated = slots[0]!;
    const plain = slots[1]!;
    expect(gated.name).toBe('gated');
    expect(gated.dir).toBe(`${slotRoot}/multi--gated`);

    // THE assertion of this task: the gated submodule's slot sits on `next`,
    // which is NOT `main` — not the parent's base, and not the commit the
    // parent pins (both of which are the submodule's `main` tip).
    expect(gated.base).toBe('next');
    expect(sh(['rev-parse', 'HEAD'], gated.dir).stdout.trim()).toBe(w.gatedNextTip);
    expect(w.gatedNextTip).not.toBe(w.gatedMainTip);
    expect(sh(['rev-parse', 'HEAD'], gated.dir).stdout.trim()).not.toBe(w.gatedMainTip);
    expect(existsSync(join(gated.dir, 'b.txt'))).toBe(true); // the next-only file

    // A submodule with no `next` falls back to the parent's base.
    expect(plain.base).toBe('main');
    expect(sh(['rev-parse', 'HEAD'], plain.dir).stdout.trim()).toBe(w.plainMainTip);

    // Both carry the run's branch, both live outside the repository, and both
    // pass the R10 toplevel assertion (they were returned, which IS that proof
    // — restated here so a regression that skips the check is visible).
    for (const s of [gated, plain]) {
      expect(sh(['rev-parse', '--abbrev-ref', 'HEAD'], s.dir).stdout.trim()).toBe('worktree-multi');
      expect(isUnder(s.dir, w.root)).toBe(false);
      expect(toPosixPath(sh(['rev-parse', '--show-toplevel'], s.dir).stdout.trim())).toBe(toPosixPath(s.dir));
    }

    // The env file publishes them by index AND by name.
    const env = parseEnvFile(readFileSync(r.json.env_file, 'utf8'));
    expect(env.SUBMODULE_COUNT).toBe('2');
    expect(env.SUBMODULE_DIR_GATED).toBe(gated.dir);
    expect(env.SUBMODULE_BASE_GATED).toBe('next');
    expect(env.SUBMODULE_DIR_PLAIN).toBe(plain.dir);
    expect(env.SUBMODULE_BASE_PLAIN).toBe('main');
    expect(env.SUBMODULE_1_PATH).toBe('pkg/gated');
  });
}, 300000);

test('an uninitialised submodule is a clear failure, not a broken slot', () => {
  const root = scaffold();
  inProject(root, () => {
    const r = callJson(['create', '--name', 'nosub', '--submodules', 'pkg/missing']);
    expect(r.code).toBe(1);
    expect(r.json.detail).toContain("submodule 'pkg/missing' is not initialised");
    expect(r.json.detail).toContain('git submodule update --init');
    expect(r.json.worktree_path).toBeNull();
    expect(existsSync(slotFile(root, 'nosub'))).toBe(false);
  });
}, 120000);

test('a --submodules entry is allow-listed before it becomes a path or an env value', () => {
  for (const ok of ['pkg/gated', 'public/package/pipeline-protocol', 'a', 'a.b_c-d']) {
    expect(`${ok}: ${invalidSubmodulePath(ok)}`).toBe(`${ok}: null`);
  }
  for (const bad of ['../escape', 'a/../b', '/abs', 'C:/abs', 'a\\b', 'a b', '$(id)', 'a;b', 'a//b', '']) {
    expect(`${JSON.stringify(bad)}: ${invalidSubmodulePath(bad) === null ? 'ACCEPTED' : 'refused'}`).toBe(
      `${JSON.stringify(bad)}: refused`,
    );
  }
  const root = scaffold();
  inProject(root, () => {
    const r = callJson(['create', '--name', 'traversal', '--submodules', '../escape']);
    expect(r.code).toBe(1);
    expect(r.json.detail).toContain("invalid --submodules entry '../escape'");
    expect(existsSync(slotFile(root, 'traversal'))).toBe(false);
  });
}, 120000);

// ---------------------------------------------------------------------------
// (4) DoD 4 — the env file's grammar, asserted directly
// ---------------------------------------------------------------------------

test('every env-file value is unquoted, space-free and metacharacter-free — asserted on the RAW file, not implied by the parser', () => {
  const w = subWorld(false);
  inProject(w.root, () => {
    const r = callJson(['create', '--name', 'envcheck', '--submodules', 'pkg/gated']);
    expect(r.code).toBe(0);
    const text = readFileSync(r.json.env_file, 'utf8');
    const entries = rawEntries(r.json.env_file);
    expect(entries.length).toBeGreaterThan(6);

    for (const [k, v] of entries) {
      // The key is a shell identifier — `set -a && source` has to accept it.
      expect(`${k}: key`).toBe(`${k}: ${ENV_KEY_RE.test(k) ? 'key' : 'NOT A SHELL IDENTIFIER'}`);
      // The value, character class by character class. Stated as separate
      // assertions rather than one regex so a failure names the offense.
      expect(`${k}: quotes=${/["']/.test(v)}`).toBe(`${k}: quotes=false`);
      expect(`${k}: whitespace=${/\s/.test(v)}`).toBe(`${k}: whitespace=false`);
      expect(`${k}: backslash=${v.includes('\\')}`).toBe(`${k}: backslash=false`);
      expect(`${k}: metachars=${/[$`;|&<>(){}\[\]*?!#~^%]/.test(v)}`).toBe(`${k}: metachars=false`);
      expect(`${k}: allowed=${ENV_VALUE_RE.test(v)}`).toBe(`${k}: allowed=true`);
      // No `export ` prefix, no padding: the tolerant parser would forgive all
      // three, the shell consumer would not always.
      expect(text).toContain(`\n${k}=${v}\n`);
    }
    // Not vacuous: the values under test include real absolute paths.
    const byKey = Object.fromEntries(entries);
    expect(byKey.WORKTREE_PATH).toBe(r.json.worktree_path);
    expect(byKey.WORKTREE_PATH).toContain('/');
    expect(byKey.PROJECT_ROOT).toBe(toPosixPath(w.root));

    // And the grammar the CLI itself reads it with round-trips.
    const parsed = parseEnvFile(text);
    for (const [k, v] of entries) expect(parsed[k]).toBe(v);
    expect(parsed.WORKTREE_BRANCH).toBe('worktree-envcheck');
    expect(parsed.RUN_ID).toBe('envcheck');
    expect(parsed.BASE_BRANCH).toBe('main');
  });
}, 300000);

test('a value that cannot be written unquoted FAILS the provision with a stated reason (a slot root containing a space)', () => {
  const root = scaffold();
  inProject(root, () => {
    const spaced = join(mkTmp('wtroot-'), 'has space');
    mkdirSync(spaced, { recursive: true });
    process.env.PIPELINE_WT_ROOT = spaced;
    const r = callJson(['create', '--name', 'spacey']);
    expect(r.code).toBe(1);
    expect(r.json.ok).toBe(false);
    expect(r.json.worktree_path).toBeNull();
    expect(r.json.detail).toContain('a space');
    expect(r.json.detail).toContain('PIPELINE_WT_ROOT');
    // Refused BEFORE anything was created — no half-slot to clean up.
    expect(sh(['worktree', 'list', '--porcelain'], root).stdout).not.toContain('spacey');
    expect(sh(['branch', '--list', 'worktree-spacey'], root).stdout.trim()).toBe('');
  });
}, 120000);

test('unsafeEnvEntry names exactly what `set -a && source` cannot survive', () => {
  expect(unsafeEnvEntry('WORKTREE_PATH', 'C:/tmp/slots/a3')).toBeNull();
  expect(unsafeEnvEntry('PORT_BASE', '31000')).toBeNull();
  expect(unsafeEnvEntry('EMPTY', '')).toBeNull();
  for (const bad of ['a b', 'a\tb', 'C:\\tmp\\x', '"quoted"', "'q'", 'a;b', 'a|b', 'a&b', '$HOME', '`id`', 'a>b', 'a*b', 'a#b', '~/x', 'a\nb']) {
    expect(`${JSON.stringify(bad)}: ${unsafeEnvEntry('K', bad) === null ? 'ACCEPTED' : 'refused'}`).toBe(
      `${JSON.stringify(bad)}: refused`,
    );
  }
  for (const bad of ['1LEADING', 'has-dash', 'has space', '']) expect(unsafeEnvEntry(bad, 'x')).not.toBeNull();
});

// ---------------------------------------------------------------------------
// (5) DoD 6 — the git-version floor (R10)
// ---------------------------------------------------------------------------

/** Real git for everything except the version banner. */
const gitReporting = (version: string): GitRunner => (args, cwd) =>
  args.length === 1 && args[0] === '--version'
    ? { code: 0, stdout: `git version ${version}\n`, stderr: '' }
    : realGit(args, cwd);

test('below the pinned minimum git version the command FAILS with a stated reason instead of producing a slot', () => {
  const root = scaffold();
  inProject(root, () => {
    const r = callJson(['create', '--name', 'oldgit'], gitReporting('2.19.4'));
    expect(r.code).toBe(1);
    expect(r.json.ok).toBe(false);
    expect(r.json.worktree_path).toBeNull();
    expect(r.json.detail).toContain('2.19.4');
    expect(r.json.detail).toContain(MIN_GIT_VERSION_TEXT);
    expect(r.json.detail).toContain('submodule');
    // Nothing was created on the way to the refusal.
    expect(sh(['worktree', 'list', '--porcelain'], root).stdout).not.toContain('oldgit');
    expect(existsSync(slotFile(root, 'oldgit'))).toBe(false);

    // A version at/above the floor is accepted (so the gate is the version, not
    // the injected runner), and an UNPARSEABLE banner is refused rather than
    // gambled on.
    expect(callJson(['create', '--name', 'newgit'], gitReporting('2.20.0')).code).toBe(0);
    const junk = callJson(['create', '--name', 'junkgit'], gitReporting('(unknown build)'));
    expect(junk.code).toBe(1);
    expect(junk.json.detail).toContain('could not parse the git version');
  });
}, 180000);

test('parseGitVersion reads the banners git actually prints', () => {
  expect(parseGitVersion('git version 2.45.1')).toEqual([2, 45, 1]);
  expect(parseGitVersion('git version 2.55.0.windows.3')).toEqual([2, 55, 0]);
  expect(parseGitVersion('git version 2.39.5 (Apple Git-154)')).toEqual([2, 39, 5]);
  expect(parseGitVersion('git version 2.20')).toEqual([2, 20, 0]);
  expect(parseGitVersion('no digits here')).toBeNull();
});

// ---------------------------------------------------------------------------
// (6) DoD 7 — a slot whose toplevel is not itself is REFUSED
// ---------------------------------------------------------------------------

test('R10: a slot whose `rev-parse --show-toplevel` points somewhere else is REFUSED, not returned', () => {
  const w = subWorld(false);
  inProject(w.root, () => {
    // The catastrophic case, forced: a submodule slot that resolves back into
    // the main checkout (what an inherited `core.worktree` would do). Only the
    // submodule slot's answer is rewritten — the parent's is left honest, so
    // the refusal is provably the submodule assertion firing.
    const subSlot = `--gated`;
    const liar: GitRunner = (args, cwd) => {
      const r = realGit(args, cwd);
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel' && cwd && cwd.includes(subSlot)) {
        return { code: 0, stdout: toPosixPath(join(w.root, 'pkg', 'gated')) + '\n', stderr: '' };
      }
      return r;
    };
    const r = callJson(['create', '--name', 'redirect', '--submodules', 'pkg/gated'], liar);
    expect(r.code).toBe(1);
    expect(r.json.ok).toBe(false);
    // REFUSED, not returned: no path, no branch, no env file, no slot record.
    expect(r.json.worktree_path).toBeNull();
    expect(r.json.branch).toBeNull();
    expect(r.json.env_file).toBeNull();
    expect(existsSync(slotFile(w.root, 'redirect'))).toBe(false);
    expect(r.json.detail).toContain('refusing');
    expect(r.json.detail).toContain('resolves to');
    expect(r.json.detail).toContain('Nothing was deleted');

    // And the honest check passes for the same repository, so the refusal is
    // the assertion doing its job rather than the sandbox being broken.
    expect(callJson(['create', '--name', 'honest', '--submodules', 'pkg/gated']).code).toBe(0);
  });
}, 300000);

test('the toplevel assertion also refuses a slot git cannot resolve at all', () => {
  const root = scaffold();
  inProject(root, () => {
    const blind: GitRunner = (args, cwd) => {
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel' && cwd && cwd.includes('blindslot')) {
        return { code: 128, stdout: '', stderr: 'fatal: not a git repository\n' };
      }
      return realGit(args, cwd);
    };
    const r = callJson(['create', '--name', 'blindslot'], blind);
    expect(r.code).toBe(1);
    expect(r.json.worktree_path).toBeNull();
    expect(r.json.detail).toContain('could not resolve its working tree');
  });
}, 180000);
