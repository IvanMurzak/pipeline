// The BUILT-IN teardown (taskflow-v2 a5 / finding F-7) — `pipeline worktree
// finalize` and `destroy` in a repository that has authored NO hooks.
//
// a3 gave `create` a built-in provisioner and left teardown to a hook, so a
// hook-less repository could provision a slot and never reap it. What is under
// test here is the closing of that asymmetry, and it is deliberately physical:
// every lifecycle test runs against a REAL temp git repository (and, for the
// submodule case, a real superproject with two real submodules), because
// "the worktree is gone" is a statement about git's registrations and the
// filesystem, not about a mock's return value.
//
// THE SYMMETRY RULE gets both directions, in the same style: a slot record says
// which side provisioned it, and the side that reaps must be the side that can
// describe what is there. A hook that exists always wins — even over a slot the
// built-in provisioner made — and the built-in never reaps a hook's slot, it
// refuses with a reason. Neither direction is inferable from the other, so
// neither is left to be inferred.
//
// A REMOVAL THAT FAILS gets both treatments. A fake git that declines
// `worktree remove` pins the REPORTING deterministically on every platform (it
// wraps the real runner and rewrites exactly one answer); and a live child
// process whose working directory is the slot pins that the reporting matches
// what the OS actually did — Windows refuses to delete that directory, POSIX
// does not, and the test asserts the honest answer on either side of that
// difference rather than assuming one of them.
//
// The D9 boundary — that none of this is reachable from a pipeline RUN — is
// asserted in tests/worktree-hook-module.test.ts, beside a1's original guard,
// so the frozen contract keeps ONE place that compares its callers.

import { test, expect, afterEach } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupCreated, ident, mkTmp } from './_git-sandbox';
import { runWorktree } from '../src/commands/worktree';
import { realGit, type GitResult, type GitRunner } from '../src/lib/git';
import { PORT_RANGE_ENV } from '../src/lib/port-alloc';
import { derivedSubmoduleSlotDir, slotRootFor, toPosixPath } from '../src/lib/worktree-provision';

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
 *  command prints the long canonical form — and both the provisioner and the
 *  teardown anchor on git's answer, so the tests must too. */
function gitRoot(dir: string): string {
  const top = sh(['rev-parse', '--show-toplevel'], dir).stdout.trim();
  return process.platform === 'win32' ? top.replace(/\//g, '\\') : top;
}

interface HookSet {
  create?: string;
  finalize?: string;
  destroy?: string;
}

/** A repo with one commit on `main`. With no options it has NO `.pipeline/
 *  .hooks` directory at all — a repository that has authored no hooks, which is
 *  the case this whole feature exists for. */
function scaffold(hooks: HookSet = {}): string {
  const tmp = mkTmp('wtteardown-');
  sh(['init', '-q', '-b', 'main', tmp]);
  ident(tmp);
  writeFileSync(join(tmp, 'README.md'), 'x\n');
  sh(['add', '.'], tmp);
  sh(['commit', '-q', '-m', 'init'], tmp);
  const root = gitRoot(tmp);
  for (const [base, body] of Object.entries(hooks)) {
    if (body === undefined) continue;
    writeHook(root, base as keyof HookSet, body);
  }
  return root;
}

/** Write (or ADD, later in a test's life — the "the repository grew a destroy
 *  hook after the slot was made" case) one hook. */
function writeHook(root: string, base: keyof HookSet, body: string): void {
  const dir = join(root, '.pipeline', '.hooks');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `worktree-${base}.js`), body);
}

/** A superproject with TWO real submodules (`submodule add`, so each carries the
 *  gitfile + `.git/modules/<name>` shape a slot is cut from). Two, not one:
 *  DoD 5 is about a MULTI-submodule slot, and a single one cannot distinguish
 *  "reaps the submodule slot" from "reaps the first submodule slot". */
function subWorld(): { root: string } {
  const base = mkTmp('wtteardownsub-');
  const origins: string[] = [];
  for (const name of ['alpha-origin', 'beta-origin']) {
    const origin = join(base, name);
    sh(['init', '-q', '-b', 'main', origin]);
    ident(origin);
    writeFileSync(join(origin, 'a.txt'), 'main\n');
    sh(['add', '.'], origin);
    sh(['commit', '-q', '-m', `${name} main`], origin);
    origins.push(origin);
  }
  const parent = join(base, 'super');
  sh(['init', '-q', '-b', 'main', parent]);
  ident(parent);
  writeFileSync(join(parent, 'README.md'), 'super\n');
  sh(['add', '.'], parent);
  sh(['commit', '-q', '-m', 'init'], parent);
  // `-c protocol.file.allow=always`: git >= 2.38 refuses the file transport for
  // submodules by default.
  const declared: Array<[string, string]> = [
    [toPosixPath(origins[0]!), 'pkg/alpha'],
    [toPosixPath(origins[1]!), 'pkg/beta'],
  ];
  for (const [url, path] of declared) {
    sh(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', url, path], parent);
    ident(join(parent, path));
  }
  sh(['commit', '-q', '-m', 'add submodules'], parent);
  return { root: gitRoot(parent) };
}

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

interface Ctx {
  /** Where this project's slots live. */
  slotRoot: string;
  /** The slot-root BASE — the port reservation registry hangs off it. */
  wtRoot: string;
}

/** cwd → the project; a private slot root and a private PORT RANGE per test, so
 *  one test's slots and reservations can never be another's, and so nothing
 *  lands in the developer's real slot root.
 *
 *  `existingRoot` re-enters the SAME slot root — for the one test that has to
 *  step outside the block (to await a child process) between two commands, and
 *  must not be handed a second, empty slot root when it steps back in. */
function inProject<T>(root: string, portRange: string, fn: (ctx: Ctx) => T, existingRoot?: string): T {
  const prev = process.cwd();
  const keys = [PORT_RANGE_ENV, 'PIPELINE_WT_ROOT', 'PIPELINE_WT_FETCH', 'PIPELINE_WT_INTEGRATION_BRANCH'];
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];
  const wtRoot = existingRoot ?? mkTmp('wttd-');
  try {
    process.chdir(root);
    process.env.PIPELINE_WT_ROOT = wtRoot;
    process.env[PORT_RANGE_ENV] = portRange;
    delete process.env.PIPELINE_WT_FETCH;
    delete process.env.PIPELINE_WT_INTEGRATION_BRANCH;
    return fn({ slotRoot: slotRootFor(root), wtRoot });
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
  const json = r.out.trim() ? JSON.parse(r.out) : null;
  // A refusal explains itself in `detail`; a bare exit-code assertion throws
  // that explanation away, and the platform this is hardest on is the one whose
  // log is all anyone gets to read.
  if (r.code !== 0 && json?.detail) console.error(`[${args.join(' ')}] exit ${r.code}: ${json.detail}`);
  return { code: r.code, json };
}

const slotFile = (root: string, name: string): string =>
  join(root, '.pipeline', '.runtime', 'worktrees', `${name}.json`);

const readRecord = (root: string, name: string): any => JSON.parse(readFileSync(slotFile(root, name), 'utf8'));

const branchExists = (repo: string, branch: string): boolean =>
  sh(['branch', '--list', branch], repo).stdout.trim() !== '';

/** Every worktree git has registered for `repo`, as `git worktree list` says. */
const registeredCount = (repo: string): number =>
  sh(['worktree', 'list', '--porcelain'], repo).stdout.match(/^worktree /gm)?.length ?? 0;

/** The reservation files a slot's port block holds. */
function reservations(wtRoot: string, base: number, count: number): boolean[] {
  const out: boolean[] = [];
  for (let i = 0; i < count; i++) out.push(existsSync(join(wtRoot, '.ports', `${base + i}.json`)));
  return out;
}

// ---------------------------------------------------------------------------
// (1) DoD 1 — the whole lifecycle, in a repository with NO hooks at all
// ---------------------------------------------------------------------------

test('a repository with NO hooks runs the whole lifecycle through the command: create -> finalize -> destroy --outcome completed leaves no worktree, no branch, no env file, no slot record and no port reservation', () => {
  const root = scaffold();
  inProject(root, '22300-22399', ({ wtRoot }) => {
    const created = callJson(['create', '--name', 'solo', '--ports', '3']);
    expect(created.code).toBe(0);
    expect(created.json.provisioner).toBe('builtin');
    const wt = created.json.worktree_path as string;
    const envFile = created.json.env_file as string;
    const portBase = created.json.port_base as number;
    // The premise, asserted rather than assumed: there IS something to reap.
    expect(existsSync(wt)).toBe(true);
    expect(existsSync(envFile)).toBe(true);
    expect(branchExists(root, 'worktree-solo')).toBe(true);
    expect(registeredCount(root)).toBe(2);
    expect(reservations(wtRoot, portBase, 3)).toEqual([true, true, true]);

    // ---- finalize: a NO-OP that reports ok, and says exactly that ----------
    const fin = callJson(['finalize', '--name', 'solo']);
    expect(fin.code).toBe(0);
    expect(fin.json.ok).toBe(true);
    // DoD 6: which side finalized is READABLE, so `ok:true` cannot be mistaken
    // for "the work was landed".
    expect(fin.json.finalized_by).toBe('builtin');
    expect(fin.json.provisioner).toBe('builtin');
    expect(fin.json.detail).toContain('NO-OP');
    expect(fin.json.detail).toContain('nothing was committed, pushed');
    expect(fin.json.detail).toContain('worktree-finalize');
    // It really did nothing: the slot is exactly as create left it.
    expect(existsSync(wt)).toBe(true);
    expect(branchExists(root, 'worktree-solo')).toBe(true);
    expect(readRecord(root, 'solo').finalized).toBe(true);

    // ---- destroy --outcome completed: it reaps -----------------------------
    const gone = callJson(['destroy', '--name', 'solo', '--outcome', 'completed']);
    expect(gone.code).toBe(0);
    expect(gone.json.ok).toBe(true);
    expect(gone.json.reaped).toBe(true);
    expect(gone.json.preserved).toBe(false);
    expect(gone.json.teardown_by).toBe('builtin');
    expect(gone.json.provisioner).toBe('builtin');
    expect(gone.json.delete_branches).toBe(true);
    expect(gone.json.removed_worktrees).toEqual([toPosixPath(wt)]);
    expect(gone.json.removed_branches).toEqual([`${toPosixPath(root)}: worktree-solo`]);
    expect(gone.json.removed_env_file).toBe(toPosixPath(envFile));

    // THE five things DoD 1 names, each read off disk rather than off the JSON.
    expect(`worktree ${wt}: ${existsSync(wt)}`).toBe(`worktree ${wt}: false`);
    expect(`branch: ${branchExists(root, 'worktree-solo')}`).toBe('branch: false');
    expect(`env file: ${existsSync(envFile)}`).toBe('env file: false');
    expect(`slot record: ${existsSync(slotFile(root, 'solo'))}`).toBe('slot record: false');
    expect(reservations(wtRoot, portBase, 3)).toEqual([false, false, false]);
    // …and git agrees it is not merely deleted but DEREGISTERED.
    expect(registeredCount(root)).toBe(1);
    expect(callJson(['list']).json.slots).toEqual([]);

    // The human output names the side that ran, too — an operator must not have
    // to pass --json to find out whether a hook or the CLI reaped their slot.
    expect(call(['create', '--name', 'solo2', '--ports', '0']).code).toBe(0);
    const human = call(['destroy', '--name', 'solo2']);
    expect(human.out).toContain('the built-in teardown');
    expect(human.out).toContain('destroyed (reaped)');
  });
}, 300000);

// ---------------------------------------------------------------------------
// (2) DoD 2 — `halted` preserves the slot WHOLE, ports included
// ---------------------------------------------------------------------------

test('destroy --outcome halted PRESERVES a built-in slot whole — worktree, branch, env file, slot record AND its port reservation — and a later --outcome completed still reaps it', () => {
  const root = scaffold();
  inProject(root, '22400-22499', ({ wtRoot }) => {
    const created = callJson(['create', '--name', 'kept', '--ports', '2']);
    expect(created.code).toBe(0);
    const wt = created.json.worktree_path as string;
    const envFile = created.json.env_file as string;
    const portBase = created.json.port_base as number;
    expect(reservations(wtRoot, portBase, 2)).toEqual([true, true]);

    const halted = callJson(['destroy', '--name', 'kept', '--outcome', 'halted']);
    expect(halted.code).toBe(0);
    expect(halted.json.ok).toBe(true);
    expect(halted.json.reaped).toBe(false);
    expect(halted.json.preserved).toBe(true);
    expect(halted.json.teardown_by).toBe('builtin');
    expect(halted.json.delete_branches).toBe(false);
    expect(halted.json.removed_worktrees).toEqual([]);
    expect(halted.json.detail).toContain('PRESERVED');

    // WHOLE: every part of the slot, including the part a4 owns.
    expect(`worktree: ${existsSync(wt)}`).toBe('worktree: true');
    expect(`branch: ${branchExists(root, 'worktree-kept')}`).toBe('branch: true');
    expect(`env file: ${existsSync(envFile)}`).toBe('env file: true');
    expect(`slot record: ${existsSync(slotFile(root, 'kept'))}`).toBe('slot record: true');
    expect(reservations(wtRoot, portBase, 2)).toEqual([true, true]);
    expect(registeredCount(root)).toBe(2);
    const rec = readRecord(root, 'kept');
    expect(rec.outcome).toBe('halted');
    expect(rec.provisioner).toBe('builtin');
    expect(callJson(['list']).json.slots.map((s: any) => s.name)).toEqual(['kept']);

    // Preserving is not a dead end: the same slot reaps on `completed`.
    const gone = callJson(['destroy', '--name', 'kept', '--outcome', 'completed']);
    expect(gone.code).toBe(0);
    expect(gone.json.reaped).toBe(true);
    expect(existsSync(wt)).toBe(false);
    expect(branchExists(root, 'worktree-kept')).toBe(false);
    expect(reservations(wtRoot, portBase, 2)).toEqual([false, false]);
  });
}, 300000);

// ---------------------------------------------------------------------------
// (3) DoD 3 — a repository WITH a destroy hook is unaffected
// ---------------------------------------------------------------------------

/** Provisions a slot the way a consumer hook does — inside `.claude/worktrees`,
 *  its own layout, nothing of ours. */
const CREATE_HOOK = `
const fs = require('fs');
const path = require('path');
const name = process.env.PIPELINE_WT_NAME;
const wt = path.join(process.cwd(), '.claude', 'worktrees', name);
fs.mkdirSync(wt, { recursive: true });
fs.writeFileSync(path.join(wt, '.worktree.env'), 'SLOT=' + name + '\\n');
process.stdout.write(JSON.stringify({ worktree_path: wt, branch: 'hook-branch', env_file: path.join(wt, '.worktree.env') }) + '\\n');
`;

/** Reaps on `completed`, and LEAVES A MARKER either way — "the hook ran" has to
 *  be observable, or "the built-in did not run instead" proves nothing. */
const DESTROY_HOOK = `
const fs = require('fs');
const path = require('path');
fs.appendFileSync(path.join(process.cwd(), 'destroy-hook-ran'), process.env.PIPELINE_WT_OUTCOME + '\\n');
const wt = process.env.PIPELINE_WT_WORKTREE_PATH || '';
if (process.env.PIPELINE_WT_OUTCOME === 'completed' && wt) fs.rmSync(wt, { recursive: true, force: true });
process.stdout.write(JSON.stringify({ ok: true }) + '\\n');
`;

test('a repository WITH a worktree-destroy.* is unaffected: the hook runs, the built-in teardown does not', () => {
  const root = scaffold({ create: CREATE_HOOK, destroy: DESTROY_HOOK });
  inProject(root, '22500-22599', ({ slotRoot }) => {
    const created = callJson(['create', '--name', 'hooked', '--ports', '0']);
    expect(created.code).toBe(0);
    expect(created.json.provisioner).toBe('hook');
    const wt = created.json.worktree_path as string;
    expect(wt).toBe(join(root, '.claude', 'worktrees', 'hooked'));

    const gone = callJson(['destroy', '--name', 'hooked', '--outcome', 'completed']);
    expect(gone.code).toBe(0);
    expect(gone.json.ok).toBe(true);
    // DoD 6 again, from the other side: the JSON names the HOOK.
    expect(gone.json.teardown_by).toBe('hook');
    expect(gone.json.provisioner).toBe('hook');
    // The built-in reports nothing because it did nothing — what a hook removes
    // is the hook's to report.
    expect(gone.json.removed_worktrees).toEqual([]);
    expect(gone.json.removed_branches).toEqual([]);
    expect(gone.json.removed_env_file).toBeNull();
    // The hook really ran, with the outcome-aware environment it has always had.
    expect(readFileSync(join(root, 'destroy-hook-ran'), 'utf8').trim()).toBe('completed');
    expect(existsSync(wt)).toBe(false);

    // And nothing of the built-in path happened alongside it: no slot dir under
    // the CLI's own root, no `worktree-hooked` branch invented behind the hook's
    // back (the hook named its branch `hook-branch`).
    expect(existsSync(`${slotRoot}/hooked`)).toBe(false);
    expect(branchExists(root, 'worktree-hooked')).toBe(false);
  });
}, 240000);

// ---------------------------------------------------------------------------
// (4) DoD 4 — THE SYMMETRY RULE, both directions
// ---------------------------------------------------------------------------

test('symmetry, direction 1: the built-in teardown REFUSES to reap a HOOK-provisioned slot, with a reason — it never guesses at bookkeeping it did not write', () => {
  // A create hook and NO destroy hook: the exact repository that could
  // otherwise trick the built-in into reaping a slot it knows nothing about.
  const root = scaffold({ create: CREATE_HOOK });
  inProject(root, '22600-22699', () => {
    const created = callJson(['create', '--name', 'theirs', '--ports', '0']);
    expect(created.code).toBe(0);
    expect(created.json.provisioner).toBe('hook');
    const wt = created.json.worktree_path as string;

    const refused = callJson(['destroy', '--name', 'theirs', '--outcome', 'completed']);
    expect(refused.code).toBe(1);
    expect(refused.json.ok).toBe(false);
    expect(refused.json.teardown_by).toBe('none');
    expect(refused.json.provisioner).toBe('hook');
    expect(refused.json.reaped).toBe(false);
    expect(refused.json.preserved).toBe(true);
    expect(refused.json.detail).toContain('REFUSES');
    expect(refused.json.detail).toContain('hook');
    expect(refused.json.removed_worktrees).toEqual([]);

    // NOTHING was touched: the hook's slot, and this command's record of it,
    // both survive the refusal.
    expect(`worktree: ${existsSync(wt)}`).toBe('worktree: true');
    expect(`slot record: ${existsSync(slotFile(root, 'theirs'))}`).toBe('slot record: true');
    expect(readRecord(root, 'theirs').provisioner).toBe('hook');

    // The same refusal for a slot with no record at all — unknown provenance
    // reads as a hook's, which is the conservative half of the rule.
    const unknown = callJson(['destroy', '--name', 'never-created']);
    expect(unknown.code).toBe(1);
    expect(unknown.json.teardown_by).toBe('none');
    expect(unknown.json.detail).toContain('no slot record');
    expect(unknown.json.detail).toContain('already reaped');
  });
}, 240000);

test('symmetry, direction 2: a repository that GREW a worktree-destroy.* after a built-in create gets the HOOK — and the detail says so', () => {
  const root = scaffold();
  inProject(root, '22700-22799', () => {
    const created = callJson(['create', '--name', 'grown', '--ports', '0']);
    expect(created.code).toBe(0);
    expect(created.json.provisioner).toBe('builtin');
    const wt = created.json.worktree_path as string;
    const envFile = created.json.env_file as string;

    // The repository grows a destroy hook AFTER the slot exists. This one only
    // leaves a marker — it removes NOTHING — so "the built-in did not also run"
    // is observable rather than assumed.
    writeHook(root, 'destroy', `
const fs = require('fs');
const path = require('path');
fs.writeFileSync(path.join(process.cwd(), 'destroy-hook-ran'), process.env.PIPELINE_WT_WORKTREE_PATH || '');
process.stdout.write(JSON.stringify({ ok: true, detail: 'the hook handled it' }) + '\\n');
`);

    const gone = callJson(['destroy', '--name', 'grown', '--outcome', 'completed']);
    expect(gone.code).toBe(0);
    expect(gone.json.ok).toBe(true);
    // The pair of fields is the whole point: provisioned by the CLI, torn down
    // by the hook — and the JSON says both.
    expect(gone.json.provisioner).toBe('builtin');
    expect(gone.json.teardown_by).toBe('hook');
    expect(gone.json.detail).toContain('a hook always wins');
    expect(gone.json.detail).toContain('the hook handled it');
    expect(gone.json.removed_worktrees).toEqual([]);

    // The hook ran, and it was told the built-in slot's path.
    expect(readFileSync(join(root, 'destroy-hook-ran'), 'utf8')).toBe(wt);
    // The built-in did NOT reap behind it: this hook removed nothing, so
    // everything is still there. Preferring the hook has to mean the built-in
    // stayed out of it entirely.
    expect(`worktree: ${existsSync(wt)}`).toBe('worktree: true');
    expect(`env file: ${existsSync(envFile)}`).toBe('env file: true');
    expect(`branch: ${branchExists(root, 'worktree-grown')}`).toBe('branch: true');
  });
}, 240000);

// ---------------------------------------------------------------------------
// (5) DoD 5 — a MULTI-submodule slot: every submodule worktree goes too
// ---------------------------------------------------------------------------

test('every submodule worktree the provisioner cut is removed too, with its branch — asserted with a TWO-submodule slot', () => {
  const w = subWorld();
  inProject(w.root, '22800-22899', () => {
    const created = callJson(['create', '--name', 'multi', '--base', 'main', '--submodules', 'pkg/alpha,pkg/beta', '--ports', '0']);
    expect(created.code).toBe(0);
    const wt = created.json.worktree_path as string;
    const slots: Array<{ path: string; name: string; dir: string; base: string }> = created.json.submodule_slots;
    expect(slots.map((s) => s.path)).toEqual(['pkg/alpha', 'pkg/beta']);
    for (const s of slots) {
      expect(`${s.path} on disk: ${existsSync(s.dir)}`).toBe(`${s.path} on disk: true`);
      expect(`${s.path} branch: ${branchExists(join(w.root, s.path), 'worktree-multi')}`).toBe(`${s.path} branch: true`);
      expect(registeredCount(join(w.root, s.path))).toBe(2);
    }
    // The record carries what teardown will reap — recorded by create, not
    // recomputed at destroy time from an environment that may have moved.
    const rec = readRecord(w.root, 'multi');
    expect(rec.submodule_slots.map((s: any) => s.dir)).toEqual(slots.map((s) => s.dir));
    // …and the FALLBACK for records written before that field existed lands on
    // exactly the same directories, so an older slot reaps identically.
    for (const s of slots) {
      expect(derivedSubmoduleSlotDir(wt, 'multi', s.path)).toBe(s.dir);
    }

    const gone = callJson(['destroy', '--name', 'multi', '--outcome', 'completed']);
    expect(gone.code).toBe(0);
    expect(gone.json.ok).toBe(true);
    expect(gone.json.teardown_by).toBe('builtin');
    // Parent first, then one per declared submodule — all three reported.
    expect(gone.json.removed_worktrees).toEqual([toPosixPath(wt), ...slots.map((s) => toPosixPath(s.dir))]);
    expect(gone.json.removed_branches.length).toBe(3);

    // On disk and in git: gone from the superproject AND from each submodule.
    expect(`parent: ${existsSync(wt)}`).toBe('parent: false');
    expect(branchExists(w.root, 'worktree-multi')).toBe(false);
    expect(registeredCount(w.root)).toBe(1);
    for (const s of slots) {
      expect(`${s.path} on disk: ${existsSync(s.dir)}`).toBe(`${s.path} on disk: false`);
      expect(`${s.path} branch: ${branchExists(join(w.root, s.path), 'worktree-multi')}`).toBe(`${s.path} branch: false`);
      expect(`${s.path} registered: ${registeredCount(join(w.root, s.path))}`).toBe(`${s.path} registered: 1`);
    }
    expect(existsSync(slotFile(w.root, 'multi'))).toBe(false);
  });
}, 600000);

// ---------------------------------------------------------------------------
// (6) A removal that FAILS — the Windows locked-directory case
// ---------------------------------------------------------------------------

test('a worktree git REFUSES to remove (a locked or in-use directory — the Windows case) is a stated failure that preserves the slot, and a retry once the cause clears reaps it', () => {
  const root = scaffold();
  inProject(root, '22900-22999', ({ wtRoot }) => {
    const created = callJson(['create', '--name', 'locked', '--ports', '2']);
    expect(created.code).toBe(0);
    const wt = created.json.worktree_path as string;
    const envFile = created.json.env_file as string;
    const portBase = created.json.port_base as number;

    // What a locked directory looks like from here: git declines, with a
    // reason. Only `worktree remove` is rewritten — every other answer is the
    // real git's, so the failure is provably the removal and not the sandbox.
    const stubborn: GitRunner = (args, cwd) =>
      args[0] === 'worktree' && args[1] === 'remove'
        ? { code: 1, stdout: '', stderr: "fatal: failed to delete '.': Directory not empty\n" }
        : realGit(args, cwd);

    const failed = callJson(['destroy', '--name', 'locked', '--outcome', 'completed'], stubborn);
    expect(failed.code).toBe(1);
    expect(failed.json.ok).toBe(false);
    expect(failed.json.teardown_by).toBe('builtin');
    expect(failed.json.reaped).toBe(false);
    expect(failed.json.preserved).toBe(true);
    expect(failed.json.detail).toContain('git worktree remove failed');
    expect(failed.json.detail).toContain('Directory not empty');
    expect(failed.json.detail).toContain('retried by name');
    expect(failed.json.removed_worktrees).toEqual([]);

    // NOTHING ELSE WAS TAKEN APART. A half-reaped slot whose record was dropped
    // is a leak with no handle; every part of this one survives, and the record
    // that names it survives with them.
    expect(`worktree: ${existsSync(wt)}`).toBe('worktree: true');
    expect(`branch: ${branchExists(root, 'worktree-locked')}`).toBe('branch: true');
    expect(`env file: ${existsSync(envFile)}`).toBe('env file: true');
    expect(`slot record: ${existsSync(slotFile(root, 'locked'))}`).toBe('slot record: true');
    expect(reservations(wtRoot, portBase, 2)).toEqual([true, true]);

    // The retry — the reason the record was kept — reaps it completely.
    const retry = callJson(['destroy', '--name', 'locked', '--outcome', 'completed']);
    expect(retry.code).toBe(0);
    expect(retry.json.reaped).toBe(true);
    expect(existsSync(wt)).toBe(false);
    expect(branchExists(root, 'worktree-locked')).toBe(false);
    expect(existsSync(envFile)).toBe(false);
    expect(existsSync(slotFile(root, 'locked'))).toBe(false);
    expect(reservations(wtRoot, portBase, 2)).toEqual([false, false]);
  });
}, 300000);

test('a REAL in-use slot (a live process whose working directory is inside it — the Windows lock): destroy is honest whichever way the platform answers, and the retry after the lock clears reaps it', async () => {
  const root = scaffold();
  // ONE slot root across all three commands: this test leaves the project block
  // between them to await a child process, and re-entering must not hand it a
  // fresh, empty one.
  const wtRoot = mkTmp('wttd-');
  const run = <T,>(fn: (ctx: Ctx) => T): T => inProject(root, '23000-23099', fn, wtRoot);

  const created = run(() => callJson(['create', '--name', 'busy', '--ports', '0']));
  expect(created.code).toBe(0);
  const wt = created.json.worktree_path as string;

  // A process whose CURRENT DIRECTORY is the slot. This is the platform
  // difference, made real rather than simulated: Windows refuses to delete a
  // directory a running process is sitting in, POSIX does not care. The
  // injected-failure test above pins the reporting; this one pins that the
  // reporting matches what the OS actually did.
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready\\n"); setTimeout(() => {}, 120000);'], {
    cwd: wt,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the holding child never reported ready')), 30000);
    child.stdout.on('data', () => {
      clearTimeout(timer);
      resolve();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });

  const r = run(() => callJson(['destroy', '--name', 'busy', '--outcome', 'completed']));

  if (r.json.ok) {
    // Removal won. Then it must have REALLY won — a slot reported reaped while
    // its directory survives is the failure this branch exists to exclude.
    expect(`reaped, so gone: ${existsSync(wt)}`).toBe('reaped, so gone: false');
    expect(existsSync(slotFile(root, 'busy'))).toBe(false);
    child.kill();
  } else {
    expect(r.code).toBe(1);
    expect(r.json.reaped).toBe(false);
    expect(r.json.preserved).toBe(true);
    expect(r.json.detail).toContain('could not reap');
    expect(`preserved, so present: ${existsSync(wt)}`).toBe('preserved, so present: true');
    expect(`record kept: ${existsSync(slotFile(root, 'busy'))}`).toBe('record kept: true');
    expect(`branch kept: ${branchExists(root, 'worktree-busy')}`).toBe('branch kept: true');

    // Clear the lock — waiting for the process to be GONE, not merely signalled,
    // so the handle it held is released — and the retry the kept record made
    // possible reaps the slot.
    await new Promise<void>((resolve) => {
      child.on('exit', () => resolve());
      child.kill();
    });
    const retry = run(() => callJson(['destroy', '--name', 'busy', '--outcome', 'completed']));
    expect(retry.code).toBe(0);
    expect(existsSync(wt)).toBe(false);
    expect(branchExists(root, 'worktree-busy')).toBe(false);
  }
}, 300000);

// ---------------------------------------------------------------------------
// (7) The one mistake with no undo
// ---------------------------------------------------------------------------

test('a slot record naming a path INSIDE the repository is refused, never deleted — the built-in provisioner never creates one there', () => {
  const root = scaffold();
  inProject(root, '23100-23199', () => {
    expect(callJson(['create', '--name', 'tampered', '--ports', '0']).code).toBe(0);

    // A hand-edited (or corrupted) record pointing at the user's own tree.
    const rec = readRecord(root, 'tampered');
    const inside = join(root, 'src');
    mkdirSync(inside, { recursive: true });
    writeFileSync(join(inside, 'keep.txt'), 'precious\n');
    rec.worktree_path = toPosixPath(inside);
    writeFileSync(slotFile(root, 'tampered'), JSON.stringify(rec, null, 2));

    const r = callJson(['destroy', '--name', 'tampered', '--outcome', 'completed']);
    expect(r.code).toBe(1);
    expect(r.json.ok).toBe(false);
    expect(r.json.detail).toContain('inside the repository');
    expect(r.json.removed_worktrees).toEqual([]);
    expect(`kept: ${existsSync(join(inside, 'keep.txt'))}`).toBe('kept: true');
    // …and the refusal did not take the branch or the record with it either.
    expect(branchExists(root, 'worktree-tampered')).toBe(true);
    expect(existsSync(slotFile(root, 'tampered'))).toBe(true);

    // The same record, shortened to a single segment below a filesystem root —
    // what a truncating crash or a bad merge leaves behind. A recursive delete
    // of THAT is the reason the depth check exists. (Deliberately not an
    // ancestor of the current directory, or the cwd guard would answer first
    // and this one would go untested.)
    const shallowPath = process.platform === 'win32' ? 'C:/pipeline-teardown-guard' : '/pipeline-teardown-guard';
    rec.worktree_path = shallowPath;
    writeFileSync(slotFile(root, 'tampered'), JSON.stringify(rec, null, 2));
    const shallow = callJson(['destroy', '--name', 'tampered', '--outcome', 'completed']);
    expect(shallow.code).toBe(1);
    expect(shallow.json.detail).toContain('too close to a filesystem root');
    expect(shallow.json.removed_worktrees).toEqual([]);
  });
}, 240000);

// ---------------------------------------------------------------------------
// (8) finalize: the built-in is a no-op, and a HOOK repository still fails loud
// ---------------------------------------------------------------------------

test('finalize in a repository WITH a create hook and NO finalize hook still FAILS, exactly as before — the built-in no-op is only ever the built-in provisioner\'s', () => {
  const root = scaffold({ create: CREATE_HOOK });
  inProject(root, '23200-23299', () => {
    expect(callJson(['create', '--name', 'strict', '--ports', '0']).code).toBe(0);
    const r = callJson(['finalize', '--name', 'strict']);
    expect(r.code).toBe(1);
    expect(r.json.ok).toBe(false);
    expect(r.json.finalized_by).toBe('hook');
    expect(r.json.provisioner).toBe('hook');
    expect(r.json.detail).toContain('worktree-finalize.* hook found');
    // The strict must-succeed gate is unchanged: the slot is not marked
    // finalized by a finalize that did not happen.
    expect(readRecord(root, 'strict').finalized).toBe(false);

    // A finalize hook that DOES exist still wins over everything.
    writeHook(root, 'finalize', `process.stdout.write(JSON.stringify({ ok: true, detail: 'pushed 1 commit' }) + '\\n');`);
    const ok = callJson(['finalize', '--name', 'strict']);
    expect(ok.code).toBe(0);
    expect(ok.json.finalized_by).toBe('hook');
    expect(ok.json.detail).toBe('pushed 1 commit');
  });
}, 240000);
