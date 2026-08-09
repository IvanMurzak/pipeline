// `submodule_slots` REPORTING — taskflow-v2 a11 (P-1), and the only test file
// in this repository written to prevent a SPECIFIC, ALREADY-OCCURRED data loss.
//
// ── THE INCIDENT ────────────────────────────────────────────────────────────
//
// A resumed `--parallel=2` run reconciled its slots and concluded, verbatim:
//
//   "Both slots are empty shells: no commits, clean trees, and — critically —
//    `submodule_slots: []` with every submodule uninitialized, so the target
//    code was never even present in them."
//
// It then reaped all four worktrees. 21,880 bytes of finished implementation
// were destroyed. Every observation in that sentence was TRUE and the
// conclusion was FALSE, because the two facts do not connect the way they read:
//
//   * a dispatched worker works in the SUBMODULE slot, so the PARENT slot is
//     empty and clean exactly as it should be; and
//   * `submodule_slots` was `[]` not because there were none, but because
//     `commands/worktree.ts` reported `[]` for every HOOK-provisioned slot on
//     the grounds that the frozen contract does not make a hook enumerate them.
//
// So the one field that could have named the directory holding the work
// asserted its absence instead. The directory's only machine-readable pointer
// was `SUBMODULE_*_DIR` in the slot's env file, which nothing on the resume
// path read.
//
// ── WHAT THESE TESTS PIN ────────────────────────────────────────────────────
//
//   * `create --json` and `list --json` name the submodule directories for a
//     HOOK-provisioned slot — the broken path — as well as a built-in one, in
//     one shape, with `source` saying which channel named each directory and
//     `exists` saying whether it is there.
//   * `list` is asserted FROM A SEPARATE PROCESS. That is the resume case:
//     `create`'s output is long gone by the time a run is reconciled, and a
//     `list` that only works because the same process created the slot would
//     have prevented nothing.
//   * "the reconciliation can see the slot is not empty" is asserted as a
//     RECONCILIATION — the §12 procedure re-run against a slot whose submodule
//     worktree holds a commit — not as a field check. Against the code this
//     task replaces, that test reports "empty" and fails.
//
// Real git throughout: the property under test is what a reconciliation can
// SEE, and a mocked slot can be made to say anything.

import { test, expect, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupCreated, ident, mkTmp } from './_git-sandbox';
import { runWorktree } from '../src/commands/worktree';
import { realGit, type GitResult } from '../src/lib/git';
import { slotRootFor, toPosixPath } from '../src/lib/worktree-provision';

afterEach(cleanupCreated);

/** The CLI entry point, for the SEPARATE-PROCESS half of these tests. */
const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

function sh(args: string[], cwd?: string, check = true): GitResult {
  const r = realGit(args, cwd);
  if (check && r.code !== 0) {
    throw new Error(`git ${args.join(' ')} @ ${cwd ?? '.'} → ${r.code}: ${(r.stderr || r.stdout).trim()}`);
  }
  return r;
}

/** Git's OWN spelling of a repo root — GitHub's Windows runner hands out 8.3
 *  short TEMP segments (`RUNNER~1`) that `realpathSync` does not expand while
 *  every git command prints the long form. */
function gitRoot(dir: string): string {
  const top = sh(['rev-parse', '--show-toplevel'], dir).stdout.trim();
  return process.platform === 'win32' ? top.replace(/\//g, '\\') : top;
}

/** The OS's own canonical spelling of a path, for comparing OUR path against
 *  GIT's.
 *
 *  `realpathSync.native`, not a string compare, and it is not paranoia — it is
 *  the same trap `samePath` exists for in `src/lib/worktree-provision.ts`.
 *  GitHub's Windows runner hands out an **8.3 short** TEMP path
 *  (`C:\Users\RUNNER~1\…`), plain `realpathSync` leaves those segments alone,
 *  and **git always prints the long form** (`C:\Users\runneradmin\…`). A hook
 *  that derives its slot from `PIPELINE_WT_ROOT` therefore reports the short
 *  spelling while `rev-parse --show-toplevel` answers with the long one.
 *
 *  Neither spelling is wrong and the CLI is right to report the hook's answer
 *  VERBATIM — rewriting a hook's own path would make `submodule_slots[].dir`
 *  disagree with the `SUBMODULE_*_DIR` the same hook wrote, which is two
 *  channels contradicting each other to fix a cosmetic difference. So the
 *  comparison normalizes, rather than the production code. */
function nativePath(p: string): string {
  let out: string;
  try {
    out = toPosixPath(realpathSync.native(p));
  } catch {
    out = toPosixPath(p);
  }
  return process.platform === 'win32' ? out.toLowerCase() : out;
}

interface World {
  /** The consumer project. */
  root: string;
  /** `PIPELINE_WT_ROOT` for this world — where both the fixture hook and the
   *  built-in provisioner put their slots. */
  slotRoot: string;
}

/** A superproject with two nested repositories at `pkg/alpha` and `pkg/beta`,
 *  each a real clone with its own `origin`.
 *
 *  Plain clones rather than `git submodule add`: every property under test here
 *  is about REPORTING a directory, both provisioning paths accept a nested
 *  repository (`existsSync(<src>/.git)` + a self-resolving toplevel), and a
 *  real `submodule add` is a clone per submodule — the slowest thing in this
 *  suite for a distinction none of these assertions can see. R10's
 *  `core.worktree` redirect case, which DOES need a real submodule, is owned by
 *  tests/worktree-provision.test.ts and is not re-litigated here. */
function makeWorld(hookSource?: string): World {
  const base = mkTmp('a11-');
  const parent = join(base, 'super');
  sh(['init', '-q', '-b', 'main', parent]);
  ident(parent);
  writeFileSync(join(parent, 'README.md'), 'super\n');
  sh(['add', '.'], parent);
  sh(['commit', '-q', '-m', 'init'], parent);

  mkdirSync(join(parent, 'pkg'), { recursive: true });
  for (const name of ['alpha', 'beta']) {
    const origin = join(base, `${name}-origin`);
    sh(['init', '-q', '-b', 'main', origin]);
    ident(origin);
    writeFileSync(join(origin, `${name}.txt`), `${name} main\n`);
    sh(['add', '.'], origin);
    sh(['commit', '-q', '-m', `${name} init`], origin);
    sh(['clone', '-q', origin, join(parent, 'pkg', name)]);
    ident(join(parent, 'pkg', name));
  }

  const root = gitRoot(parent);
  if (hookSource !== undefined) {
    const hooks = join(root, '.pipeline', '.hooks');
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, 'worktree-create.js'), hookSource);
  }
  return { root, slotRoot: mkTmp('a11-slots-') };
}

// ---------------------------------------------------------------------------
// The fixture create hook — a port of this repository's own reference
// `.pipeline/.hooks/worktree-create.py`, which is the hook the incident ran
// under: same slot layout (`<PIPELINE_WT_ROOT>/<name>` for the parent,
// `<PIPELINE_WT_ROOT>/<name>--<label>` per submodule), same env-file keys, and
// the same silence in its stdout JSON — it returns `worktree_path` / `branch` /
// `env_file` and NOTHING about submodules, because the frozen contract has no
// field for them. That silence is the whole problem being fixed.
// ---------------------------------------------------------------------------

/** `publishSubmodules: false` is the OTHER hook in the wild — one that cuts the
 *  submodule worktrees and never writes a `SUBMODULE_*` key anywhere. It is
 *  what forces the third (convention) derivation channel. */
function createHookSource(publishSubmodules: boolean): string {
  return `
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

// The env the hook RECEIVED, so the frozen contract's key set is assertable.
const seen = {};
for (const k of Object.keys(process.env)) if (k.startsWith('PIPELINE_WT_')) seen[k] = process.env[k];
fs.writeFileSync(path.join(process.cwd(), 'create-env-dump.json'), JSON.stringify(seen));

const GIT = process.env.PIPELINE_GIT_BIN || 'git';
const git = (args, cwd) => {
  const r = cp.spawnSync(GIT, args, { cwd: cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    process.stderr.write('git ' + args.join(' ') + ' @ ' + cwd + ': ' + (r.stderr || r.stdout));
    process.exit(1);
  }
  return r.stdout;
};
const posix = (p) => String(p).replace(/\\\\/g, '/');

const root = process.cwd();
const name = process.env.PIPELINE_WT_NAME;
const base = process.env.PIPELINE_WT_BASE_BRANCH || 'main';
const wtRoot = posix(process.env.PIPELINE_WT_ROOT);
const branch = 'worktree-' + name;
const wt = wtRoot + '/' + name;
if (!fs.existsSync(wt)) git(['worktree', 'add', '-b', branch, wt, base], root);

const subs = (process.env.PIPELINE_WT_SUBMODULES || '').split(',').map((s) => s.trim()).filter(Boolean);
const made = [];
for (const rel of subs) {
  const src = path.join(root, rel);
  const label = path.basename(rel);
  const dir = wtRoot + '/' + name + '--' + label.replace(/[^A-Za-z0-9._-]/g, '-');
  if (!fs.existsSync(dir)) git(['worktree', 'add', '-b', branch, dir, 'origin/' + base], src);
  made.push({ path: rel, name: label, dir: dir, base: base });
}

const envFile = wtRoot + '/' + name + '.env';
const values = [
  ['RUN_ID', name],
  ['WORKTREE_NAME', name],
  ['WORKTREE_PATH', wt],
  ['WORKTREE_BRANCH', branch],
  ['PROJECT_ROOT', posix(root)],
  ['BASE_BRANCH', base],
];
if (${publishSubmodules ? 'true' : 'false'} && made.length) {
  values.push(['SUBMODULE_COUNT', String(made.length)]);
  made.forEach((s, i) => {
    const n = i + 1;
    values.push(['SUBMODULE_' + n + '_PATH', s.path]);
    values.push(['SUBMODULE_' + n + '_NAME', s.name]);
    values.push(['SUBMODULE_' + n + '_DIR', s.dir]);
    values.push(['SUBMODULE_' + n + '_BASE', s.base]);
    values.push(['SUBMODULE_DIR_' + s.name.replace(/[^A-Za-z0-9]/g, '_').toUpperCase(), s.dir]);
  });
}
fs.mkdirSync(path.dirname(envFile), { recursive: true });
fs.writeFileSync(envFile, '# generated by the a11 fixture hook\\n' + values.map((kv) => kv[0] + '=' + kv[1]).join('\\n') + '\\n');

// The frozen create-hook JSON. Three fields, no submodules — by contract.
process.stdout.write(JSON.stringify({ worktree_path: wt, branch: branch, env_file: envFile }) + '\\n');
`;
}

const PUBLISHING_HOOK = createHookSource(true);
const SILENT_HOOK = createHookSource(false);

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

function inProject<T>(w: World, fn: () => T): T {
  const prev = process.cwd();
  const keys = ['PIPELINE_WT_ROOT', 'PIPELINE_WT_FETCH', 'PIPELINE_WT_INTEGRATION_BRANCH'];
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];
  try {
    process.chdir(w.root);
    process.env.PIPELINE_WT_ROOT = w.slotRoot;
    delete process.env.PIPELINE_WT_FETCH;
    delete process.env.PIPELINE_WT_INTEGRATION_BRANCH;
    return fn();
  } finally {
    process.chdir(prev);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function call(args: string[]): { code: number; out: string; err: string } {
  let out = '';
  let err = '';
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  (process.stdout as any).write = (c: unknown) => ((out += String(c)), true);
  (process.stderr as any).write = (c: unknown) => ((err += String(c)), true);
  let code: number;
  try {
    code = runWorktree(args);
  } finally {
    (process.stdout as any).write = origOut;
    (process.stderr as any).write = origErr;
  }
  return { code, out, err };
}

function callJson(args: string[]): { code: number; json: any } {
  const r = call([...args, '--json']);
  const json = r.out.trim() ? JSON.parse(r.out) : null;
  if (r.code !== 0 && json?.detail) console.error(`[${args.join(' ')}] exit ${r.code}: ${json.detail}`);
  return { code: r.code, json };
}

/** `worktree list --json` FROM A FRESH PROCESS.
 *
 *  THE POINT OF THIS HELPER: a resume reconciles slots it did not create, in a
 *  process that holds nothing from the one that did. A `list` assertion made
 *  in-process could pass on state that only exists because `create` just ran
 *  here; this one cannot. Everything it can see came off the disk. */
function listFromFreshProcess(w: World): any {
  const env = { ...process.env, PIPELINE_WT_ROOT: w.slotRoot };
  // process.execPath, not 'bun': a shim-installed `bun` (npm .cmd/.ps1) is not
  // directly spawnable on Windows once an explicit env is passed.
  const r = spawnSync(process.execPath, [CLI, 'worktree', 'list', '--json'], {
    cwd: w.root,
    encoding: 'utf8',
    env,
  });
  if (r.status !== 0) throw new Error(`worktree list exited ${r.status}: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout);
}

interface ReportedSlot {
  path: string;
  name: string;
  dir: string;
  base: string;
  source: string;
  exists: boolean;
}

/** THE §12 RECONCILIATION, re-run — the procedure that destroyed the work,
 *  performed the way it was performed: take every directory the slot NAMES and
 *  ask whether any of them carries a commit that `base` does not.
 *
 *  It is deliberately written against the reported JSON alone, with no
 *  knowledge of where slots live, because that is the only thing an
 *  orchestrator resuming a run has. */
function reconcile(slot: any, base: string): { empty: boolean; inspected: string[]; commits: string[] } {
  const inspected: string[] = [];
  const commits: string[] = [];
  const dirs = [slot.worktree_path, ...(slot.submodule_slots as ReportedSlot[]).map((s) => s.dir)];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    inspected.push(dir);
    const log = realGit(['log', '--oneline', `${base}..HEAD`], dir);
    if (log.code === 0) for (const line of log.stdout.split('\n').filter(Boolean)) commits.push(`${dir}: ${line}`);
  }
  return { empty: commits.length === 0, inspected, commits };
}

const sorted = (o: object): string[] => Object.keys(o).sort();

// ---------------------------------------------------------------------------
// (1) DoD 1 — a HOOK-provisioned slot reports its submodule slots
// ---------------------------------------------------------------------------

test('DoD 1: create --json on a HOOK-provisioned slot with declared submodules reports a NON-EMPTY submodule_slots — the path that reported [] and cost the work', () => {
  const w = makeWorld(PUBLISHING_HOOK);
  inProject(w, () => {
    const r = callJson(['create', '--name', 'hooked', '--base', 'main', '--submodules', 'pkg/alpha,pkg/beta']);
    expect(r.code).toBe(0);
    expect(r.json.ok).toBe(true);
    // THE hook path — asserted, not assumed: this test is worthless against the
    // built-in provisioner, which never had the defect.
    expect(r.json.provisioner).toBe('hook');

    const slots: ReportedSlot[] = r.json.submodule_slots;
    expect(slots.length).toBe(2);
    expect(slots.map((s) => s.path)).toEqual(['pkg/alpha', 'pkg/beta']);
    expect(slots.map((s) => s.name)).toEqual(['alpha', 'beta']);

    for (const s of slots) {
      // A REAL directory, and a real worktree of the right repository — the
      // field would be worth nothing if it named a path that is not there.
      expect(s.exists).toBe(true);
      expect(existsSync(s.dir)).toBe(true);
      // Compared through `nativePath` on BOTH sides — see its doc comment: on
      // GitHub's Windows runner the hook's spelling is 8.3-short and git's is
      // long, and the reported path is deliberately the hook's.
      expect(nativePath(sh(['rev-parse', '--show-toplevel'], s.dir).stdout.trim())).toBe(nativePath(s.dir));
      expect(sh(['rev-parse', '--abbrev-ref', 'HEAD'], s.dir).stdout.trim()).toBe('worktree-hooked');
      // The hook published these in its env file, so that is where they came
      // from — not from a convention this command hoped the hook followed.
      expect(s.source).toBe('env-file');
      expect(s.base).toBe('main');
    }
    expect(slots[0]!.dir).toBe(`${toPosixPath(w.slotRoot)}/hooked--alpha`);
    expect(slots[1]!.dir).toBe(`${toPosixPath(w.slotRoot)}/hooked--beta`);

    // Human output names them too — an operator reading a terminal reaches the
    // same wrong conclusion as a machine reading `[]` otherwise.
    const human = call(['create', '--name', 'hooked2', '--submodules', 'pkg/alpha']);
    expect(human.code).toBe(0);
    expect(human.out).toContain('submodule pkg/alpha: ');
    expect(human.out).toContain(`${toPosixPath(w.slotRoot)}/hooked2--alpha`);
  });
}, 300000);

// ---------------------------------------------------------------------------
// (2) DoD 2 + DoD 7 — THE REGRESSION TEST
// ---------------------------------------------------------------------------

test('DoD 7: a slot whose SUBMODULE worktree holds a commit is not reported as empty by a list-based reconciliation running in a FRESH process (DoD 2)', () => {
  const w = makeWorld(PUBLISHING_HOOK);
  const created = inProject(w, () =>
    callJson(['create', '--name', 'resume-me', '--base', 'main', '--submodules', 'pkg/alpha']),
  );
  expect(created.code).toBe(0);
  expect(created.json.provisioner).toBe('hook');

  // A worker does its work IN THE SUBMODULE SLOT. This is the 21,880 bytes.
  //
  // The directory is spelled out from the FIXTURE's own layout rather than read
  // out of the create output, deliberately: this test must be able to run — all
  // the way to the reconciliation verdict — against a build that reports no
  // submodule slots at all. A setup that needed the new field would fail before
  // reaching the assertion that matters, and "it threw during setup" is a much
  // weaker statement than "the reconciliation declared finished work absent".
  const subDir = `${toPosixPath(w.slotRoot)}/resume-me--alpha`;
  expect(existsSync(subDir)).toBe(true);
  writeFileSync(join(subDir, 'finished-work.txt'), 'the implementation\n');
  sh(['add', '.'], subDir);
  sh(['commit', '-q', '-m', 'feat: the work that was destroyed'], subDir);

  // THE OTHER HALF OF THE INCIDENT, stated as a fact rather than as an
  // assumption: the PARENT slot really is an empty shell. No commits ahead of
  // the base, a clean tree. Every observation the run made about it was true.
  const parent = created.json.worktree_path as string;
  expect(existsSync(parent)).toBe(true);
  expect(sh(['log', '--oneline', 'main..HEAD'], parent).stdout.trim()).toBe('');
  expect(sh(['status', '--porcelain'], parent).stdout.trim()).toBe('');

  // Now reconcile the way a resume does: a FRESH PROCESS, `list`, no memory of
  // the create above, nothing but what is on disk.
  const listed = listFromFreshProcess(w);
  const slot = listed.slots.find((s: any) => s.name === 'resume-me');
  expect(slot).toBeDefined();

  // THE ASSERTION THIS FILE EXISTS FOR, and it is asserted FIRST so that a
  // build which regresses fails on the VERDICT rather than on a field.
  //
  // Against the code a11 replaces, `submodule_slots` is `[]` for every
  // hook-provisioned slot, so `inspected` is the parent alone, `commits` is
  // empty, and `empty` is `true` — the verdict that reaped four worktrees and
  // 21,880 bytes of finished implementation while reporting that the code had
  // never been present.
  const verdict = reconcile(slot, 'main');
  expect(verdict.empty).toBe(false);
  expect(verdict.inspected).toContain(subDir);
  expect(verdict.commits.length).toBe(1);
  expect(verdict.commits[0]).toContain('the work that was destroyed');

  // `list` — not `create` — is what names the directory holding the work.
  const reported: ReportedSlot[] = slot.submodule_slots;
  expect(reported.length).toBe(1);
  expect(reported[0]!.path).toBe('pkg/alpha');
  expect(reported[0]!.dir).toBe(subDir);
  expect(reported[0]!.exists).toBe(true);

  // And the human output an operator would have read says it too.
  const humanList = spawnSync(process.execPath, [CLI, 'worktree', 'list'], {
    cwd: w.root,
    encoding: 'utf8',
    env: { ...process.env, PIPELINE_WT_ROOT: w.slotRoot },
  });
  expect(humanList.status).toBe(0);
  expect(humanList.stdout).toContain('submodule pkg/alpha: ');
  expect(humanList.stdout).toContain(subDir);
}, 300000);

// ---------------------------------------------------------------------------
// (3) DoD 3 — the built-in path is unregressed, and BOTH paths report one shape
// ---------------------------------------------------------------------------

test('DoD 3: the built-in provisioner still reports what it always reported, and a hook-provisioned slot reports the SAME SHAPE — a consumer never branches on `provisioner` to find the work', () => {
  const builtinWorld = makeWorld(); // no worktree-create.* at all
  const builtin = inProject(builtinWorld, () => {
    const r = callJson(['create', '--name', 'multi', '--base', 'main', '--submodules', 'pkg/alpha,pkg/beta']);
    expect(r.code).toBe(0);
    expect(r.json.provisioner).toBe('builtin');
    const slotRoot = slotRootFor(builtinWorld.root);
    const slots: ReportedSlot[] = r.json.submodule_slots;
    // a3's own contract, unchanged: path, name, dir, base — the provisioner's
    // four fields with the provisioner's values.
    expect(slots.map((s) => s.path)).toEqual(['pkg/alpha', 'pkg/beta']);
    expect(slots.map((s) => s.name)).toEqual(['alpha', 'beta']);
    expect(slots.map((s) => s.dir)).toEqual([`${slotRoot}/multi--alpha`, `${slotRoot}/multi--beta`]);
    expect(slots.map((s) => s.base)).toEqual(['main', 'main']);
    // …and it is the RECORD that says so, because the provisioner watched
    // itself cut them. The other two channels are for slots it did not.
    for (const s of slots) expect(s.source).toBe('record');
    // `list` from a fresh process agrees — the resume case on this path too.
    const listed = listFromFreshProcess(builtinWorld);
    const fromList: ReportedSlot[] = listed.slots.find((s: any) => s.name === 'multi').submodule_slots;
    expect(fromList.map((s) => s.dir)).toEqual(slots.map((s) => s.dir));
    return slots;
  });

  const hookWorld = makeWorld(PUBLISHING_HOOK);
  const hooked = inProject(hookWorld, () => {
    const r = callJson(['create', '--name', 'multi', '--base', 'main', '--submodules', 'pkg/alpha,pkg/beta']);
    expect(r.code).toBe(0);
    expect(r.json.provisioner).toBe('hook');
    return r.json.submodule_slots as ReportedSlot[];
  });

  // ONE SHAPE. Same keys, same types, same ordering rule (the declared list) —
  // only `dir` and `source` differ, because only the layout and the channel do.
  expect(sorted(hooked[0]!)).toEqual(sorted(builtin[0]!));
  expect(sorted(hooked[0]!)).toEqual(['base', 'dir', 'exists', 'name', 'path', 'source']);
  expect(hooked.map((s) => s.path)).toEqual(builtin.map((s) => s.path));
  expect(hooked.map((s) => s.name)).toEqual(builtin.map((s) => s.name));
  expect(hooked.map((s) => s.exists)).toEqual(builtin.map((s) => s.exists));
  for (const s of [...hooked, ...builtin]) {
    expect(typeof s.dir).toBe('string');
    expect(s.dir.length).toBeGreaterThan(0);
    expect(typeof s.exists).toBe('boolean');
  }
}, 600000);

// ---------------------------------------------------------------------------
// (4) DoD 4 — no declared submodules is an EMPTY LIST, on both paths
// ---------------------------------------------------------------------------

test('DoD 4: a slot with no declared submodules reports [] — present, an array, not null and not a missing key — from create and from list, on both paths', () => {
  for (const [label, hook] of [
    ['hook', PUBLISHING_HOOK],
    ['builtin', undefined],
  ] as Array<[string, string | undefined]>) {
    const w = makeWorld(hook);
    inProject(w, () => {
      const r = callJson(['create', '--name', 'bare']);
      expect(`${label}: ${r.code}`).toBe(`${label}: 0`);
      expect(r.json.provisioner).toBe(label);
      expect(Object.keys(r.json)).toContain('submodule_slots');
      expect(r.json.submodule_slots).not.toBeNull();
      expect(Array.isArray(r.json.submodule_slots)).toBe(true);
      expect(r.json.submodule_slots).toEqual([]);

      const slot = listFromFreshProcess(w).slots.find((s: any) => s.name === 'bare');
      expect(Object.keys(slot)).toContain('submodule_slots');
      expect(slot.submodule_slots).toEqual([]);
      // An empty list is not the same claim as "there was work here" — the
      // reconciliation is entitled to call THIS slot empty.
      expect(reconcile(slot, 'main').empty).toBe(true);
    });
  }
}, 600000);

// ---------------------------------------------------------------------------
// (5) The third channel — a hook that publishes NOTHING
// ---------------------------------------------------------------------------

test('a hook that cuts submodule worktrees and publishes no SUBMODULE_* key at all still has them reported, by the CONVENTION teardown already reaps by — and labelled `derived`, never dressed up as the hook’s own answer', () => {
  const w = makeWorld(SILENT_HOOK);
  inProject(w, () => {
    const r = callJson(['create', '--name', 'quiet', '--base', 'main', '--submodules', 'pkg/alpha']);
    expect(r.code).toBe(0);
    expect(r.json.provisioner).toBe('hook');

    // The hook's env file really is silent: this is the case where the second
    // channel has nothing to say.
    const env = readFileSync(r.json.env_file, 'utf8');
    expect(env).not.toContain('SUBMODULE_');

    const slots: ReportedSlot[] = r.json.submodule_slots;
    expect(slots.length).toBe(1);
    expect(slots[0]!.source).toBe('derived');
    expect(slots[0]!.dir).toBe(`${toPosixPath(w.slotRoot)}/quiet--alpha`);
    // The guess is right — it is the same layout the reference hook and the
    // built-in provisioner both use — and `exists` is how a consumer checks
    // rather than trusts.
    expect(slots[0]!.exists).toBe(true);
    // The integration branch is a fact about the submodule repository, not
    // about the layout: it is left empty rather than guessed, and the key is
    // still present so the shape never varies.
    expect(slots[0]!.base).toBe('');
    expect(Object.keys(slots[0]!)).toContain('base');

    // A derived directory that is NOT there reports `exists: false` and is
    // still reported — "where it would be" is the operator's next lead, and
    // silently dropping it is how the parent-only view happened.
    rmSync(slots[0]!.dir, { recursive: true, force: true });
    const after: ReportedSlot[] = listFromFreshProcess(w).slots.find((s: any) => s.name === 'quiet').submodule_slots;
    expect(after.length).toBe(1);
    expect(after[0]!.dir).toBe(slots[0]!.dir);
    expect(after[0]!.exists).toBe(false);
    expect(call(['list']).out).toContain('NOT on disk');
  });
}, 300000);

// ---------------------------------------------------------------------------
// (6) DoD 5 — the frozen contract gained nothing
// ---------------------------------------------------------------------------

test('DoD 5: reporting submodule slots changed what the CLI PRINTS, not what a hook RECEIVES — the create hook still sees exactly its nine PIPELINE_WT_* keys', () => {
  const w = makeWorld(PUBLISHING_HOOK);
  inProject(w, () => {
    expect(callJson(['create', '--name', 'frozen', '--submodules', 'pkg/alpha']).code).toBe(0);
    const dumped = JSON.parse(readFileSync(join(w.root, 'create-env-dump.json'), 'utf8')) as Record<string, string>;
    // `PIPELINE_WT_ROOT`/`_FETCH`/`_INTEGRATION_BRANCH`/`_PORT_RANGE` are
    // documented ENVIRONMENT KNOBS of this CLI, not contract variables: a hook
    // inherits the caller's environment, so they are present here only because
    // the harness (and a real operator) set them. They are subtracted rather
    // than asserted — the contract is what the assembler ADDS.
    const KNOBS = new Set([
      'PIPELINE_WT_ROOT',
      'PIPELINE_WT_FETCH',
      'PIPELINE_WT_INTEGRATION_BRANCH',
      'PIPELINE_WT_PORT_RANGE',
    ]);
    const seen: Record<string, string> = {};
    for (const [k, v] of Object.entries(dumped)) if (!KNOBS.has(k)) seen[k] = v;
    // Nine on create; the other three (WORKTREE_PATH, OUTCOME,
    // DELETE_BRANCHES) belong to finalize/destroy, and the twelve-key,
    // byte-identical anti-drift comparison against the RUN path is
    // tests/worktree-hook-module.test.ts's — one place compares the contract's
    // callers, and this is not it.
    expect(sorted(seen)).toEqual([
      'PIPELINE_WT_ACTION',
      'PIPELINE_WT_BASE_BRANCH',
      'PIPELINE_WT_DRY_RUN',
      'PIPELINE_WT_NAME',
      'PIPELINE_WT_PIPELINE_NAME',
      'PIPELINE_WT_PIPELINE_ROOT',
      'PIPELINE_WT_PROJECT_ROOT',
      'PIPELINE_WT_RUN_ID',
      'PIPELINE_WT_SUBMODULES',
    ]);
    // Nothing about submodule SLOTS reached the hook — it is told which
    // submodules to provision, exactly as before, and never where.
    expect(seen.PIPELINE_WT_SUBMODULES).toBe('pkg/alpha');
    expect(Object.keys(seen).some((k) => /SLOT|DIR/.test(k))).toBe(false);
  });
}, 300000);

test('the env file keeps its SUBMODULE_*_DIR keys — this adds a second discoverable channel, it does not replace the first', () => {
  const w = makeWorld(PUBLISHING_HOOK);
  inProject(w, () => {
    const r = callJson(['create', '--name', 'both-channels', '--base', 'main', '--submodules', 'pkg/alpha']);
    expect(r.code).toBe(0);
    const env = readFileSync(r.json.env_file, 'utf8');
    const dir = (r.json.submodule_slots as ReportedSlot[])[0]!.dir;
    expect(env).toContain(`SUBMODULE_1_DIR=${dir}`);
    expect(env).toContain(`SUBMODULE_DIR_ALPHA=${dir}`);
    expect(env).toContain('SUBMODULE_COUNT=1');
  });
}, 300000);

// ---------------------------------------------------------------------------
// (7) DoD 6 — the help no longer contradicts the code
// ---------------------------------------------------------------------------

test('DoD 6: `create --help` no longer claims a hook ALWAYS wins with the provisioner inert — it states the PER-FIELD port precedence the code implements', () => {
  const w = makeWorld(PUBLISHING_HOOK);
  inProject(w, () => {
    const help = call(['--help']);
    expect(help.code).toBe(0);
    // The false claim, gone. a4 made port precedence PER FIELD: a hook that
    // returns `ports: {}` still receives the CLI's block.
    expect(help.out).not.toContain('the provisioner is inert');
    expect(help.out).not.toContain('A hook, where one exists, ALWAYS wins');
    expect(help.out).toContain('PER FIELD');
    expect(help.out).toContain('ports: {}');
    expect(help.out).toContain('NON-EMPTY ports overrides');

    // Surgical: the DESTROY-side claim is TRUE (a destroy hook really does
    // always win, including over a built-in slot) and must survive.
    expect(help.out).toContain('A worktree-destroy.* hook, where one exists, ALWAYS wins');

    // `worktree create --help` is a usage error that prints the same reference
    // (--help is not a create flag), so the corrected text is what an operator
    // typing that command reads.
    const viaCreate = call(['create', '--help']);
    expect(viaCreate.code).toBe(2);
    expect(viaCreate.err).not.toContain('the provisioner is inert');
    expect(viaCreate.err).toContain('PER FIELD');

    // The help also tells a reader where a worker's work actually is.
    expect(help.out).toContain('submodule_slots');
  });
}, 120000);

// ---------------------------------------------------------------------------
// (8) The derivation is defensive — a mangled env file is not a crash
// ---------------------------------------------------------------------------

test('a truncated or hand-edited env file degrades to the convention instead of failing the command or inventing an empty path', () => {
  const w = makeWorld(PUBLISHING_HOOK);
  inProject(w, () => {
    const r = callJson(['create', '--name', 'mangled', '--base', 'main', '--submodules', 'pkg/alpha,pkg/beta']);
    expect(r.code).toBe(0);
    const envFile = r.json.env_file as string;

    // A count that lies high, an index whose _DIR was cut, and trailing junk.
    writeFileSync(
      envFile,
      ['SUBMODULE_COUNT=9', 'SUBMODULE_1_PATH=pkg/alpha', 'SUBMODULE_1_DIR=', 'SUBMODULE_2_DIR=', 'not-an-assignment'].join('\n') + '\n',
      'utf8',
    );
    const slots: ReportedSlot[] = listFromFreshProcess(w).slots.find((s: any) => s.name === 'mangled').submodule_slots;
    // Both declared submodules are still answered for, by the convention, and
    // no entry carries an empty directory.
    expect(slots.map((s) => s.path)).toEqual(['pkg/alpha', 'pkg/beta']);
    for (const s of slots) {
      expect(s.source).toBe('derived');
      expect(s.dir).not.toBe('');
      expect(s.dir).toBe(`${toPosixPath(w.slotRoot)}/mangled--${s.name}`);
    }

    // An env file that is gone entirely is the same story.
    rmSync(envFile, { force: true });
    const again: ReportedSlot[] = listFromFreshProcess(w).slots.find((s: any) => s.name === 'mangled').submodule_slots;
    expect(again.map((s) => s.dir)).toEqual(slots.map((s) => s.dir));
  });
}, 300000);
