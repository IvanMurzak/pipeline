// `pipeline gc` and the BUILT-IN SLOT ROOT (taskflow-v2 a8 / finding F-10)
// — shard 5/5 of the gc suite (sandbox plumbing in _gc-world.ts).
//
// Everything the other four shards test lives INSIDE the project. a3's built-in
// provisioner puts its slots OUTSIDE it, under `slotRootFor(<project>)`, with
// their branches ATTACHED — so neither the `.claude/worktrees/` scan nor the
// orphan-branch sweep has ever seen one. Between a3 and a5 nothing reaped a
// built-in slot at all; a5 closed the happy path (`destroy` works without
// hooks), and what is under test here is the LEAK path: a run that dies before
// `destroy` and leaves a slot no janitor knows about.
//
// It is deliberately physical, like the a5 suite it builds on: real temp git
// repos, real `git worktree add`, real port reservation files on disk. "The
// slot is gone" is a statement about git's registrations and the filesystem,
// not about a mock's return value — so every disk fact is read off disk.
//
// THE GUARDS get their own tests, and two of them are load-bearing over REAL
// FILES rather than over a hypothetical: `PIPELINE_WT_ROOT` pointed inside the
// repository, and a current working directory sitting in the slot. A command
// that deletes directories OUTSIDE the repository has to be provable at the
// point where it declines.
//
// Every test pins its OWN `PIPELINE_WT_ROOT` and its own port range, so no test
// can see another's slots or reservations — and nothing ever lands in the
// developer's real slot root.

import { test, expect, afterEach } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { callGc, callGcJson, cleanupCreated, ident, mkTmp, sh } from './_gc-world';
import { runWorktree } from '../src/commands/worktree';
import { PORT_RANGE_ENV } from '../src/lib/port-alloc';
import { slotRootFor, toPosixPath } from '../src/lib/worktree-provision';

afterEach(cleanupCreated);

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

/** Git's OWN spelling of a repo root — GitHub's Windows runner hands out 8.3
 *  short TEMP segments that `realpathSync` does not expand while every git
 *  command prints the long form, and the provisioner, the teardown and gc all
 *  anchor on git's answer, so the tests must too. */
function gitRoot(dir: string): string {
  const top = sh(['rev-parse', '--show-toplevel'], dir).trim();
  return process.platform === 'win32' ? top.replace(/\//g, '\\') : top;
}

/** A repo with one commit on `main` and, by default, NO hooks at all — the
 *  repository the built-in provisioner exists for. */
function scaffold(createHook?: string): string {
  const tmp = mkTmp('gcslot-');
  sh(['init', '-q', '-b', 'main'], tmp);
  ident(tmp);
  writeFileSync(join(tmp, 'README.md'), 'x\n');
  sh(['add', '.'], tmp);
  sh(['commit', '-q', '-m', 'init'], tmp);
  const root = gitRoot(tmp);
  if (createHook !== undefined) {
    const dir = join(root, '.pipeline', '.hooks');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'worktree-create.js'), createHook);
  }
  return root;
}

interface Ctx {
  /** This project's slot root — `<PIPELINE_WT_ROOT>/<project>-<hash>`. */
  slotRoot: string;
  /** The slot-root BASE; the port reservation registry hangs off it. */
  wtRoot: string;
}

/** cwd → the project (that is where `pipeline worktree` reads its project root
 *  from), a private slot root and a private port range for the duration.
 *
 *  `wtRoot` re-enters an EXISTING slot root — for the tests that step out of
 *  the block between two commands and must not be handed a fresh empty one.
 *  `cwd` overrides where the body runs from, which is the whole subject of the
 *  cwd-guard test. */
function inProject<T>(
  root: string,
  portRange: string,
  fn: (ctx: Ctx) => T,
  opts: { wtRoot?: string; cwd?: string } = {},
): T {
  const prev = process.cwd();
  const keys = [PORT_RANGE_ENV, 'PIPELINE_WT_ROOT', 'PIPELINE_WT_FETCH', 'PIPELINE_WT_INTEGRATION_BRANCH'];
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];
  const wtRoot = opts.wtRoot ?? mkTmp('gcslotroot-');
  try {
    process.env.PIPELINE_WT_ROOT = wtRoot;
    process.env[PORT_RANGE_ENV] = portRange;
    delete process.env.PIPELINE_WT_FETCH;
    delete process.env.PIPELINE_WT_INTEGRATION_BRANCH;
    process.chdir(opts.cwd ?? root);
    return fn({ slotRoot: slotRootFor(root), wtRoot });
  } finally {
    process.chdir(prev);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** `pipeline worktree <args> --json`, in-process. Throws with the command's own
 *  `detail` on failure — a bare exit-code assertion throws away the one line
 *  that explains a platform-specific refusal. */
function wt(args: string[]): any {
  let buf = '';
  const orig = process.stdout.write;
  (process.stdout as any).write = (c: unknown) => ((buf += String(c)), true);
  let code: number;
  try {
    code = runWorktree([...args, '--json']);
  } finally {
    (process.stdout as any).write = orig;
  }
  const json = buf.trim() ? JSON.parse(buf.trim()) : null;
  if (code !== 0) throw new Error(`pipeline worktree ${args.join(' ')} → exit ${code}: ${json?.detail ?? buf}`);
  return json;
}

const slotFile = (root: string, name: string): string =>
  join(root, '.pipeline', '.runtime', 'worktrees', `${name}.json`);

const readRecord = (root: string, name: string): any => JSON.parse(readFileSync(slotFile(root, name), 'utf8'));

function writeRecord(root: string, name: string, rec: object): void {
  mkdirSync(join(root, '.pipeline', '.runtime', 'worktrees'), { recursive: true });
  writeFileSync(slotFile(root, name), JSON.stringify(rec, null, 2));
}

/** THE RUN DIES. Nothing calls `destroy`, and the registry row that named the
 *  slot goes with the run's state — a wiped `.pipeline/.runtime/`, a re-cloned
 *  project, a session that simply ended. The slot outside the repository
 *  survives all of it. */
const runDies = (root: string, name: string): void => unlinkSync(slotFile(root, name));

const branchThere = (repo: string, branch: string): boolean => sh(['branch', '--list', branch], repo).trim() !== '';

const registeredCount = (repo: string): number =>
  sh(['worktree', 'list', '--porcelain'], repo).match(/^worktree /gm)?.length ?? 0;

/** The reservation files a slot's port block holds. */
function reservations(wtRoot: string, base: number, count: number): boolean[] {
  const out: boolean[] = [];
  for (let i = 0; i < count; i++) out.push(existsSync(join(wtRoot, '.ports', `${base + i}.json`)));
  return out;
}

const slotByPath = (report: any, path: string): any =>
  report.builtin_slots.find((s: any) => s.path === toPosixPath(path));

// ---------------------------------------------------------------------------
// (1) DoD 1 + 2 + 3 + 7 — the slot whose run died before `destroy`
// ---------------------------------------------------------------------------

test('a built-in slot whose run died before destroy is FOUND: gc reports it (and changes nothing), --clean reaps it through a5\'s teardown and hands its port reservations back', () => {
  const root = scaffold();
  inProject(root, '23300-23399', ({ slotRoot, wtRoot }) => {
    const created = wt(['create', '--name', 'dead', '--ports', '2']);
    expect(created.provisioner).toBe('builtin');
    const slot = created.worktree_path as string;
    const envFile = created.env_file as string;
    const portBase = created.port_base as number;

    // The premise, asserted rather than assumed: the slot really is OUTSIDE the
    // repository, under the slot root, and there really is something to reap.
    expect(slot).toBe(`${slotRoot}/dead`);
    expect(existsSync(slot)).toBe(true);
    expect(existsSync(envFile)).toBe(true);
    expect(branchThere(root, 'worktree-dead')).toBe(true);
    expect(registeredCount(root)).toBe(2);
    expect(reservations(wtRoot, portBase, 2)).toEqual([true, true]);

    // ---- and the OLD scans see none of it ----------------------------------
    // The slot is not under `.claude/worktrees/` and its branch is ATTACHED, so
    // both of the pre-a8 sections are empty. That is finding F-10, stated as an
    // assertion so "gc now reports it" cannot pass as a tautology.
    const before = callGcJson(['--project', root]).report;
    expect(before.worktrees).toEqual([]);
    expect(before.stale_dirs).toEqual([]);
    expect(before.branches).toEqual([]);

    runDies(root, 'dead');
    expect(existsSync(slotFile(root, 'dead'))).toBe(false);
    expect(existsSync(slot)).toBe(true);

    // ---- DoD 1: gc REPORTS it ----------------------------------------------
    const dry = callGcJson(['--project', root]);
    expect(dry.code).toBe(0);
    expect(dry.report.slot_root).toBe(slotRoot);
    const found = slotByPath(dry.report, slot);
    expect(found).toBeDefined();
    expect(found.name).toBe('dead');
    expect(found.orphaned).toBe(true);
    expect(found.record).toBeNull();
    expect(found.exists).toBe(true);
    expect(found.reason).toContain('no slot record');
    expect(dry.report.cleaned).toBeNull();
    const human = callGc(['--project', root]);
    expect(human.out).toContain('built-in worktree slots under');
    expect(human.out).toContain(toPosixPath(slot));
    expect(human.out).not.toContain('no leaks detected');

    // ---- DoD 7: the report changed NOTHING ---------------------------------
    expect(`slot: ${existsSync(slot)}`).toBe('slot: true');
    expect(`env file: ${existsSync(envFile)}`).toBe('env file: true');
    expect(`branch: ${branchThere(root, 'worktree-dead')}`).toBe('branch: true');
    expect(`registered: ${registeredCount(root)}`).toBe('registered: 2');
    expect(reservations(wtRoot, portBase, 2)).toEqual([true, true]);

    // ---- DoD 2 + 3: --clean reaps it, ports included -----------------------
    const cleaned = callGcJson(['--project', root, '--clean']);
    expect(cleaned.code).toBe(0);
    const c = cleaned.report.cleaned!;
    expect(c.reaped_slots.length).toBe(1);
    expect(c.reaped_slots[0]!.name).toBe('dead');
    expect(c.reaped_slots[0]!.path).toBe(toPosixPath(slot));
    expect(c.reaped_slots[0]!.removed_worktrees).toEqual([toPosixPath(slot)]);
    expect(c.reaped_slots[0]!.removed_env_file).toBe(toPosixPath(envFile));
    expect(c.reaped_slots[0]!.released_ports).toBe(2);
    expect(c.kept_slots).toEqual([]);

    // Read off DISK and off GIT, not off the JSON.
    expect(`slot: ${existsSync(slot)}`).toBe('slot: false');
    expect(`env file: ${existsSync(envFile)}`).toBe('env file: false');
    expect(`registered: ${registeredCount(root)}`).toBe('registered: 1');
    expect(reservations(wtRoot, portBase, 2)).toEqual([false, false]);
    // The branch was DETACHED by the reap and then handled by this command's
    // own, unchanged branch policy: this one is merged, so it is safe-deleted.
    expect(c.deleted_branches).toContain('worktree-dead');
    expect(`branch: ${branchThere(root, 'worktree-dead')}`).toBe('branch: false');

    // The HUMAN --clean output names the reap too — an operator must not have to
    // pass --json to find out that something outside their repo was deleted.
    const second = wt(['create', '--name', 'dead2', '--ports', '0']);
    runDies(root, 'dead2');
    const h2 = callGc(['--project', root, '--clean']);
    expect(h2.out).toContain('reaped built-in slots: 1');
    expect(h2.out).toContain(toPosixPath(second.worktree_path as string));

    // Idempotent: a third pass finds nothing left at all.
    const again = callGcJson(['--project', root, '--clean']);
    expect(again.report.builtin_slots).toEqual([]);
    expect(again.report.cleaned!.reaped_slots).toEqual([]);
    expect(again.report.cleaned!.kept_slots).toEqual([]);
  });
}, 300000);

// ---------------------------------------------------------------------------
// (2) The branch policy is UNCHANGED — plain --clean still never force-deletes
// ---------------------------------------------------------------------------

test('reaping an orphaned slot does not force-delete its branch: an UNMERGED worktree-* branch is detached, kept with a reason, and still reaped only under --force-worktree-branches', () => {
  const root = scaffold();
  inProject(root, '23400-23499', ({ slotRoot }) => {
    const created = wt(['create', '--name', 'wip', '--ports', '0']);
    const slot = created.worktree_path as string;
    // Real work in the slot — the ordinary shape of a run that died mid-flight,
    // and the shape that reads as "unmerged" forever after a squash merge.
    writeFileSync(join(slot, 'work.txt'), 'unfinished\n');
    sh(['add', '.'], slot);
    sh(['commit', '-q', '-m', 'work in progress'], slot);
    runDies(root, 'wip');

    const c = callGcJson(['--project', root, '--clean']).report.cleaned!;
    expect(c.reaped_slots.map((s: any) => s.name)).toEqual(['wip']);
    expect(`slot: ${existsSync(slot)}`).toBe('slot: false');
    expect(readdirSync(slotRoot).filter((n) => !n.startsWith('.'))).toEqual([]);

    // The branch survives, unattached, with the reason this command has always
    // given for an unmerged one.
    expect(c.deleted_branches).not.toContain('worktree-wip');
    expect(c.kept_branches.find((k: any) => k.branch === 'worktree-wip')!.reason).toContain('not merged into main');
    expect(`branch: ${branchThere(root, 'worktree-wip')}`).toBe('branch: true');

    const forced = callGcJson(['--project', root, '--clean', '--force-worktree-branches']);
    expect(forced.report.cleaned!.force_deleted_branches).toContain('worktree-wip');
    expect(`branch: ${branchThere(root, 'worktree-wip')}`).toBe('branch: false');
  });
}, 300000);

// ---------------------------------------------------------------------------
// (3) DoD 4 — THE SYMMETRY RULE
// ---------------------------------------------------------------------------

/** A create hook that provisions INTO the built-in slot root — the one place a
 *  hook's slot and the CLI's own would sit side by side, which is exactly where
 *  the symmetry rule has to hold. It keeps bookkeeping of its own (a marker
 *  file) that this CLI never wrote and could not restore. */
const HOOK_INTO_SLOT_ROOT = `
const fs = require('fs');
const path = require('path');
const name = process.env.PIPELINE_WT_NAME;
const dir = path.join(process.env.GC_TEST_HOOK_SLOT_ROOT, name);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, '.hook-bookkeeping'), 'the hook owns this\\n');
fs.writeFileSync(path.join(dir, '.worktree.env'), 'SLOT=' + name + '\\n');
const posix = (p) => p.split(path.sep).join('/');
process.stdout.write(JSON.stringify({
  worktree_path: posix(dir),
  branch: 'hook-branch',
  env_file: posix(path.join(dir, '.worktree.env')),
}) + '\\n');
`;

test('symmetry: a HOOK-provisioned slot under the built-in slot root is never reaped by the built-in path — while a record-less built-in slot beside it, in the same --clean, is', () => {
  const root = scaffold(HOOK_INTO_SLOT_ROOT);
  const saved = process.env.GC_TEST_HOOK_SLOT_ROOT;
  try {
    inProject(root, '23500-23599', ({ slotRoot }) => {
      process.env.GC_TEST_HOOK_SLOT_ROOT = slotRoot;
      const created = wt(['create', '--name', 'theirs', '--ports', '0']);
      expect(created.provisioner).toBe('hook');
      const hookSlot = created.worktree_path as string;
      expect(hookSlot).toBe(`${slotRoot}/theirs`);
      expect(readRecord(root, 'theirs').provisioner).toBe('hook');

      // Beside it, a built-in slot whose record is gone — the orphan of test 1.
      // Made by hand here because a repository WITH a create hook can never
      // reach the built-in provisioner (a hook always wins), and the point of
      // this test is the two of them sharing ONE slot root.
      const mine = `${slotRoot}/mine`;
      sh(['worktree', 'add', '-q', '-b', 'worktree-mine', mine, 'main'], root);

      const dry = callGcJson(['--project', root]).report;
      const theirs = slotByPath(dry, hookSlot);
      expect(theirs.record).toBe('hook');
      expect(theirs.orphaned).toBe(false);
      expect(theirs.reason).toContain('symmetry rule');
      expect(theirs.reason).toContain('HOOK');
      expect(slotByPath(dry, mine).orphaned).toBe(true);

      const c = callGcJson(['--project', root, '--clean']).report.cleaned!;
      // NON-VACUOUS IN BOTH DIRECTIONS, in a single --clean: the built-in path
      // reaped the slot it can describe and left the one it cannot.
      expect(c.reaped_slots.map((s: any) => s.name)).toEqual(['mine']);
      expect(`hook slot: ${existsSync(hookSlot)}`).toBe('hook slot: true');
      expect(`hook bookkeeping: ${existsSync(join(hookSlot, '.hook-bookkeeping'))}`).toBe('hook bookkeeping: true');
      expect(`hook slot record: ${existsSync(slotFile(root, 'theirs'))}`).toBe('hook slot record: true');
      expect(`built-in slot: ${existsSync(mine)}`).toBe('built-in slot: false');
    });
  } finally {
    if (saved === undefined) delete process.env.GC_TEST_HOOK_SLOT_ROOT;
    else process.env.GC_TEST_HOOK_SLOT_ROOT = saved;
  }
}, 300000);

test('a slot PRESERVED on purpose (`destroy --outcome halted`) is reported and never reaped — halting exists to keep the slot for post-mortem and resume', () => {
  const root = scaffold();
  inProject(root, '23600-23699', () => {
    const created = wt(['create', '--name', 'held', '--ports', '0']);
    const slot = created.worktree_path as string;
    expect(wt(['destroy', '--name', 'held', '--outcome', 'halted']).preserved).toBe(true);

    const c = callGcJson(['--project', root, '--clean']);
    const s = slotByPath(c.report, slot);
    expect(s.orphaned).toBe(false);
    expect(s.reason).toContain('PRESERVED');
    expect(c.report.cleaned!.reaped_slots).toEqual([]);
    expect(`slot: ${existsSync(slot)}`).toBe('slot: true');
    expect(`record: ${existsSync(slotFile(root, 'held'))}`).toBe('record: true');
    expect(`branch: ${branchThere(root, 'worktree-held')}`).toBe('branch: true');
  });
}, 300000);

test('a TRACKED slot — one this command still has a record for — is reported but left to `pipeline worktree destroy`, which really does reap it', () => {
  const root = scaffold();
  inProject(root, '23700-23799', () => {
    const created = wt(['create', '--name', 'live', '--ports', '0']);
    const slot = created.worktree_path as string;

    const c = callGcJson(['--project', root, '--clean']);
    const s = slotByPath(c.report, slot);
    expect(s.orphaned).toBe(false);
    expect(s.record).toBe('builtin');
    expect(s.reason).toContain('pipeline worktree destroy --name live');
    expect(c.report.cleaned!.reaped_slots).toEqual([]);
    expect(`slot: ${existsSync(slot)}`).toBe('slot: true');

    // …and the command gc points at is not a dead end.
    expect(wt(['destroy', '--name', 'live', '--outcome', 'completed']).reaped).toBe(true);
    expect(existsSync(slot)).toBe(false);
    expect(callGcJson(['--project', root]).report.builtin_slots).toEqual([]);
  });
}, 300000);

// ---------------------------------------------------------------------------
// (4) DoD 6 — THE GUARDS. This command deletes things outside the repository.
// ---------------------------------------------------------------------------

test('guard 1 — PIPELINE_WT_ROOT pointed INSIDE the repository: gc refuses to delete anything there, and the files survive --clean', () => {
  const root = scaffold();
  // The provisioner REFUSES to create a slot inside the repository. gc computes
  // the same slot root from the same variable, so a stray `PIPELINE_WT_ROOT`
  // can aim it at the user's own tree — the one mistake with no undo.
  const inside = join(root, '.tmp-slots');
  mkdirSync(inside, { recursive: true });
  inProject(
    root,
    '23800-23899',
    ({ slotRoot }) => {
      const precious = `${slotRoot}/precious`;
      mkdirSync(precious, { recursive: true });
      writeFileSync(join(precious, 'keep.txt'), 'do not delete me\n');

      const c = callGcJson(['--project', root, '--clean']);
      const s = slotByPath(c.report, precious);
      expect(s).toBeDefined();
      expect(s.orphaned).toBe(false);
      expect(s.reason).toContain('inside the repository');
      expect(c.report.cleaned!.reaped_slots).toEqual([]);
      expect(`kept: ${existsSync(join(precious, 'keep.txt'))}`).toBe('kept: true');
    },
    { wtRoot: inside },
  );
}, 240000);

test('guard 2 — the current working directory is inside the slot: gc refuses to delete it out from under itself, and the slot survives --clean', () => {
  const root = scaffold();
  const wtRoot = mkTmp('gcslotroot-');
  const created = inProject(root, '23900-23999', () => wt(['create', '--name', 'here', '--ports', '0']), { wtRoot });
  const slot = created.worktree_path as string;
  runDies(root, 'here'); // an orphan by every other measure

  // Now stand in it. Same project, same slot root — only the cwd differs.
  inProject(
    root,
    '23900-23999',
    () => {
      const c = callGcJson(['--project', root, '--clean']);
      const s = slotByPath(c.report, slot);
      expect(s).toBeDefined();
      expect(s.orphaned).toBe(false);
      expect(s.reason).toContain('current working directory');
      expect(c.report.cleaned!.reaped_slots).toEqual([]);
      expect(`slot: ${existsSync(slot)}`).toBe('slot: true');
    },
    { wtRoot, cwd: slot },
  );

  // Step back out and the very same slot is reaped — so the refusal above was
  // the cwd guard answering, not gc failing to see the slot.
  inProject(
    root,
    '23900-23999',
    () => {
      expect(callGcJson(['--project', root, '--clean']).report.cleaned!.reaped_slots.length).toBe(1);
      expect(`slot: ${existsSync(slot)}`).toBe('slot: false');
    },
    { wtRoot },
  );
}, 240000);

test('guards 3 and 4 — a slot record naming an implausible path is a REFUSAL, not a target: too close to a filesystem root, and outside this project\'s slot root', () => {
  const root = scaffold();
  inProject(root, '24000-24099', ({ slotRoot }) => {
    // A real, healthy slot alongside, so "nothing was reaped" below cannot pass
    // because gc scanned nothing at all.
    const real = wt(['create', '--name', 'healthy', '--ports', '0']).worktree_path as string;
    const template = readRecord(root, 'healthy');

    // (a) A record shortened to a single segment below a filesystem root —
    //     what a truncating crash, a bad merge or a text editor leaves in a
    //     plain JSON file. A recursive delete of THAT is why the depth check
    //     exists. (Deliberately not an ancestor of the cwd, or guard 2 would
    //     answer first and this one would go untested.)
    const shallow = process.platform === 'win32' ? 'C:/pipeline-gc-guard' : '/pipeline-gc-guard';
    writeRecord(root, 'shallow', { ...template, name: 'shallow', worktree_path: shallow });

    // (b) A plausible-looking path that is simply not ours — outside this
    //     project's slot root. gc reaps only what the built-in provisioner
    //     would have created, whatever a record claims.
    const foreign = `${toPosixPath(mkTmp('gcnotours-'))}/somebody/else`;
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, 'keep.txt'), 'not a slot\n');
    writeRecord(root, 'foreign', { ...template, name: 'foreign', worktree_path: foreign });

    const c = callGcJson(['--project', root, '--clean']);
    const sa = slotByPath(c.report, shallow);
    expect(sa).toBeDefined();
    expect(sa.orphaned).toBe(false);
    expect(sa.reason).toContain('too close to a filesystem root');

    const sb = slotByPath(c.report, foreign);
    expect(sb).toBeDefined();
    expect(sb.orphaned).toBe(false);
    expect(sb.reason).toContain('not under this project');

    expect(c.report.cleaned!.reaped_slots).toEqual([]);
    expect(`kept: ${existsSync(join(foreign, 'keep.txt'))}`).toBe('kept: true');
    // The healthy slot is untouched and correctly classified throughout.
    expect(slotByPath(c.report, real).reason).toContain('tracked by slot record');
    expect(`healthy slot: ${existsSync(real)}`).toBe('healthy slot: true');
    expect(slotRootFor(root)).toBe(slotRoot);
  });
}, 300000);

// ---------------------------------------------------------------------------
// (5) A slot with SUBMODULE slots — reaped WITH their parent, from their own
//     repositories, and never mistaken for slots of their own
// ---------------------------------------------------------------------------

test('an orphaned slot with submodule slots: the `<name>--<submodule>` directory is reaped WITH the parent from the submodule\'s own repository, not reported as a slot of its own', () => {
  const base = mkTmp('gcslotsub-');
  const origin = join(base, 'alpha-origin');
  sh(['init', '-q', '-b', 'main', origin], base);
  ident(origin);
  writeFileSync(join(origin, 'a.txt'), 'main\n');
  sh(['add', '.'], origin);
  sh(['commit', '-q', '-m', 'alpha main'], origin);

  const parent = join(base, 'super');
  sh(['init', '-q', '-b', 'main', parent], base);
  ident(parent);
  writeFileSync(join(parent, 'README.md'), 'super\n');
  sh(['add', '.'], parent);
  sh(['commit', '-q', '-m', 'init'], parent);
  // `-c protocol.file.allow=always`: git >= 2.38 refuses the file transport.
  sh(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', toPosixPath(origin), 'pkg/alpha'], parent);
  ident(join(parent, 'pkg', 'alpha'));
  sh(['commit', '-q', '-m', 'add submodule'], parent);
  const root = gitRoot(parent);

  inProject(root, '24100-24199', ({ slotRoot }) => {
    const created = wt(['create', '--name', 'multi', '--base', 'main', '--submodules', 'pkg/alpha', '--ports', '0']);
    const slot = created.worktree_path as string;
    const subSlot = created.submodule_slots[0].dir as string;
    expect(subSlot).toBe(`${slotRoot}/multi--alpha`);
    expect(existsSync(subSlot)).toBe(true);
    expect(registeredCount(join(root, 'pkg', 'alpha'))).toBe(2);

    runDies(root, 'multi');

    // The submodule slot sits right beside the parent in the slot root. It must
    // NOT be reported as an orphan in its own right: it is a worktree of the
    // SUBMODULE, and reaping it from the superproject would fail.
    const dry = callGcJson(['--project', root]).report;
    expect(dry.builtin_slots.map((s: any) => s.name)).toEqual(['multi']);
    expect(slotByPath(dry, subSlot)).toBeUndefined();

    // …and `--no-submodules` does not change that. It switches off the
    // per-submodule branch sweep, not a slot's shape: without the declared
    // submodule list the `multi--alpha` directory would read as a slot of its
    // own and be reaped from the superproject, which does not own it.
    const noSub = callGcJson(['--project', root, '--no-submodules']).report;
    expect(noSub.builtin_slots.map((s: any) => s.name)).toEqual(['multi']);
    expect(noSub.submodules).toEqual([]);

    const c = callGcJson(['--project', root, '--clean']).report.cleaned!;
    expect(c.reaped_slots.length).toBe(1);
    expect(c.reaped_slots[0]!.removed_worktrees).toEqual([toPosixPath(slot), toPosixPath(subSlot)]);
    expect(`parent: ${existsSync(slot)}`).toBe('parent: false');
    expect(`submodule slot: ${existsSync(subSlot)}`).toBe('submodule slot: false');
    expect(`submodule registrations: ${registeredCount(join(root, 'pkg', 'alpha'))}`).toBe('submodule registrations: 1');
    // Nothing left behind in the slot root at all — the env file included.
    expect(readdirSync(slotRoot).filter((n) => !n.startsWith('.'))).toEqual([]);
  });
}, 600000);

// ---------------------------------------------------------------------------
// (6) DoD 5 — a repository with no built-in slots is completely unaffected
// ---------------------------------------------------------------------------

test('a project whose slot root holds nothing reports an EMPTY built-in slot section and still says "no leaks detected" — the addition is additive', () => {
  const root = scaffold();
  inProject(root, '24200-24299', ({ slotRoot }) => {
    const j = callGcJson(['--project', root]);
    expect(j.code).toBe(0);
    expect(j.report.slot_root).toBe(slotRoot);
    expect(j.report.builtin_slots).toEqual([]);
    const h = callGc(['--project', root]);
    expect(h.out).toContain('no leaks detected');
    expect(h.out).not.toContain('built-in worktree slots');
  });
}, 120000);
