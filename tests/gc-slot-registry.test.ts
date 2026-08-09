// `pipeline gc` and the SLOT REGISTRY (taskflow-v2 a12 / finding P-5)
// — shard 6/6 of the gc suite (sandbox plumbing in _gc-world.ts).
//
// ── P-5, AS A MECHANISM ─────────────────────────────────────────────────────
//
// a8 taught gc the built-in slot ROOT — a directory, `slotRootFor(<project>)`.
// It did not teach it the slot REGISTRY (`.pipeline/.runtime/worktrees/*.json`),
// and `scanSlotRoot` skipped every record whose `provisioner` was not `builtin`.
// A consumer's `worktree-create.*` puts its slot wherever it likes — this
// repository's own reference hook uses `PIPELINE_WT_ROOT/<name>`, the slot
// root's PARENT — so a hook-provisioned slot was invisible to gc no matter how
// thoroughly it had leaked.
//
// The consequence is the reason this file exists: **a clean gc report was not
// evidence that nothing had leaked.** The first proving run recorded its gc
// confirmation as a "false clean" and suspected the cause; the second
// established it. 03-execution-flows.md F10 case 4 and F11 both lean on this
// command as the janitor of record, which is only true of slots it can SEE.
//
// ── WHAT THESE TESTS PIN ────────────────────────────────────────────────────
//
//   (1) THE P-5 TEST ITSELF. A hook-provisioned slot whose directory lies
//       OUTSIDE the built-in slot root, whose run died, and whose repository has
//       no `worktree-destroy.*` — so `pipeline worktree destroy` REFUSES it and
//       nothing on the CLI can reap it. gc must report it. Against the code this
//       task replaces the verdict is "invisible", asserted as a verdict rather
//       than as a missing field. The same test carries the symmetry rule (gc
//       reports it and reaps nothing) and the no-op rule (a report without
//       --clean changes nothing).
//   (2) A REGISTRY ROW WHOSE SLOT IS GONE — in two steps, because the first is
//       the a11 data loss re-armed: the recorded worktree_path is gone while the
//       SUBMODULE slot still holds the work. gc must not treat that as empty.
//       Only when every part is gone is the row itself the leak, and then what
//       gc reaps is the row and the port block — never anything on disk.
//   (3) THE GUARDS, over registry-derived paths. A row can name ANY path a hook
//       chose, so an implausible one is a refusal, not a target.
//
// Real temp git repos and real fixture hooks throughout, like the a8 suite it
// extends: "gc can see the slot" is a statement about what a command prints when
// pointed at a filesystem, and a mocked registry can be made to say anything.
// Every test pins its OWN `PIPELINE_WT_ROOT` and port range.

import { test, expect, afterEach } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
 *  command prints the long form, and gc anchors on git's answer. */
function gitRoot(dir: string): string {
  const top = sh(['rev-parse', '--show-toplevel'], dir).trim();
  return process.platform === 'win32' ? top.replace(/\//g, '\\') : top;
}

/** THE HOOK THIS FINDING IS ABOUT.
 *
 *  A port of this repository's reference `worktree-create.py`, reduced to what
 *  P-5 turns on: it provisions into `<PIPELINE_WT_ROOT>/hook-slots/`, which is a
 *  SIBLING of `slotRootFor(<project>)`, not a child — the ordinary shape, since
 *  a hook has no reason to know the CLI's project-scoped, hash-suffixed spelling
 *  and the reference hook does not use it.
 *
 *  It keeps bookkeeping of its own (a marker file) that this CLI never wrote and
 *  could not restore, cuts one worktree per declared submodule beside the
 *  parent, and publishes them on the only channel the frozen contract leaves —
 *  `SUBMODULE_<n>_DIR` in the env file. Its stdout JSON says nothing about
 *  submodules, by contract. */
const HOOK = `
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
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
const home = posix(process.env.PIPELINE_WT_ROOT) + '/hook-slots';
fs.mkdirSync(home, { recursive: true });
const branch = 'worktree-' + name;
const wt = home + '/' + name;
if (!fs.existsSync(wt)) git(['worktree', 'add', '-b', branch, wt, base], root);
fs.writeFileSync(wt + '/.hook-bookkeeping', 'the hook owns this\\n');

const subs = (process.env.PIPELINE_WT_SUBMODULES || '').split(',').map((s) => s.trim()).filter(Boolean);
const made = [];
for (const rel of subs) {
  const label = path.basename(rel);
  const dir = home + '/' + name + '--' + label.replace(/[^A-Za-z0-9._-]/g, '-');
  if (!fs.existsSync(dir)) git(['worktree', 'add', '-b', branch, dir, base], path.join(root, rel));
  made.push({ path: rel, name: label, dir: dir });
}

const envFile = home + '/' + name + '.env';
const values = [['RUN_ID', name], ['WORKTREE_PATH', wt], ['WORKTREE_BRANCH', branch]];
if (made.length) {
  values.push(['SUBMODULE_COUNT', String(made.length)]);
  made.forEach((s, i) => {
    const n = i + 1;
    values.push(['SUBMODULE_' + n + '_PATH', s.path]);
    values.push(['SUBMODULE_' + n + '_NAME', s.name]);
    values.push(['SUBMODULE_' + n + '_DIR', s.dir]);
  });
}
fs.writeFileSync(envFile, values.map((kv) => kv[0] + '=' + kv[1]).join('\\n') + '\\n');
process.stdout.write(JSON.stringify({ worktree_path: wt, branch: branch, env_file: envFile }) + '\\n');
`;

/** A repo with one commit on `main` and the create hook above. No
 *  `worktree-destroy.*`: that is the leak this suite is about, and it is what
 *  makes `pipeline worktree destroy` refuse the slot outright. */
function scaffold(opts: { nested?: string[] } = {}): string {
  const tmp = mkTmp('gcreg-');
  sh(['init', '-q', '-b', 'main'], tmp);
  ident(tmp);
  writeFileSync(join(tmp, 'README.md'), 'x\n');
  sh(['add', '.'], tmp);
  sh(['commit', '-q', '-m', 'init'], tmp);
  // Plain nested repositories rather than `git submodule add` — the property
  // under test is where a slot's directories ARE, both provisioning paths accept
  // a nested repository, and a real submodule add is a clone per submodule (the
  // slowest thing this suite could do for a distinction nothing here can see).
  for (const rel of opts.nested ?? []) {
    const dir = join(tmp, rel);
    mkdirSync(dirname(dir), { recursive: true });
    sh(['init', '-q', '-b', 'main', dir], tmp);
    ident(dir);
    writeFileSync(join(dir, 'code.txt'), 'the work lives here\n');
    sh(['add', '.'], dir);
    sh(['commit', '-q', '-m', 'nested init'], dir);
  }
  const root = gitRoot(tmp);
  const hooks = join(root, '.pipeline', '.hooks');
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, 'worktree-create.js'), HOOK);
  return root;
}

interface Ctx {
  /** This project's BUILT-IN slot root — the only place a8 ever looked. */
  slotRoot: string;
  /** `PIPELINE_WT_ROOT`; the port registry hangs off it, and the fixture hook
   *  provisions into `<wtRoot>/hook-slots/`, beside the built-in slot root. */
  wtRoot: string;
}

function inProject<T>(root: string, portRange: string, fn: (ctx: Ctx) => T, opts: { wtRoot?: string } = {}): T {
  const prev = process.cwd();
  const keys = [PORT_RANGE_ENV, 'PIPELINE_WT_ROOT', 'PIPELINE_WT_FETCH', 'PIPELINE_WT_INTEGRATION_BRANCH'];
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];
  const wtRoot = opts.wtRoot ?? mkTmp('gcregroot-');
  try {
    process.env.PIPELINE_WT_ROOT = wtRoot;
    process.env[PORT_RANGE_ENV] = portRange;
    delete process.env.PIPELINE_WT_FETCH;
    delete process.env.PIPELINE_WT_INTEGRATION_BRANCH;
    process.chdir(root);
    return fn({ slotRoot: slotRootFor(root), wtRoot });
  } finally {
    process.chdir(prev);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** `pipeline worktree <args> --json`, in-process. */
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
  return { code, json };
}

/** …and the same, insisting on success (a bare exit code throws away the one
 *  line that explains a platform-specific refusal). */
function wtOk(args: string[]): any {
  const r = wt(args);
  if (r.code !== 0) throw new Error(`pipeline worktree ${args.join(' ')} → exit ${r.code}: ${r.json?.detail ?? ''}`);
  return r.json;
}

const slotFile = (root: string, name: string): string =>
  join(root, '.pipeline', '.runtime', 'worktrees', `${name}.json`);

const readRecord = (root: string, name: string): any => JSON.parse(readFileSync(slotFile(root, name), 'utf8'));

function writeRecord(root: string, name: string, rec: object): void {
  mkdirSync(join(root, '.pipeline', '.runtime', 'worktrees'), { recursive: true });
  writeFileSync(slotFile(root, name), JSON.stringify(rec, null, 2));
}

/** Delete a directory, insisting.
 *
 *  Windows keeps a handle on a directory for a moment after the process that
 *  touched it exits — a `git commit` inside a worktree is enough — and a single
 *  `rmSync` then fails with EBUSY. That is a property of the SANDBOX, not of the
 *  behaviour under test ("the slot is gone from disk"), so it is retried here
 *  rather than allowed to flake the assertion that follows it. */
function hardRemove(p: string): void {
  for (let i = 0; i < 40; i++) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // EBUSY / EPERM — a handle is still open; give it up and try again
    }
    if (!existsSync(p)) return;
    Bun.sleepSync(50);
  }
  throw new Error(`could not remove ${p} after 2s of retries`);
}

const branchThere = (repo: string, branch: string): boolean => sh(['branch', '--list', branch], repo).trim() !== '';

const registeredCount = (repo: string): number =>
  sh(['worktree', 'list', '--porcelain'], repo).match(/^worktree /gm)?.length ?? 0;

const reservations = (wtRoot: string, base: number, count: number): boolean[] =>
  Array.from({ length: count }, (_, i) => existsSync(join(wtRoot, '.ports', `${base + i}.json`)));

const slotByPath = (report: any, path: string): any =>
  report.builtin_slots.find((s: any) => s.path === toPosixPath(path));

/** THE VERDICT P-5 IS ABOUT, as one string: does this command know the slot
 *  exists at all? Asserted this way on purpose — a `toBeDefined()` on a lookup
 *  fails as "undefined", which reads like a missing field. This fails as
 *  `invisible`, which is the finding. */
const verdictOn = (report: any, path: string): string =>
  slotByPath(report, path) === undefined ? 'invisible' : 'reported';

// ---------------------------------------------------------------------------
// (1) P-5 — DoD 1, 3, 6, 7
// ---------------------------------------------------------------------------

test('P-5: a HOOK-provisioned slot outside the built-in slot root, whose run died and which no command can reap, is REPORTED by gc — and neither the report nor --clean touches it (the symmetry rule)', () => {
  const root = scaffold();
  inProject(root, '25300-25399', ({ slotRoot, wtRoot }) => {
    const created = wtOk(['create', '--name', 'ghosted', '--ports', '2']);
    expect(created.provisioner).toBe('hook');
    const slot = created.worktree_path as string;
    const envFile = created.env_file as string;
    const portBase = created.port_base as number;

    // ---- THE PREMISE, asserted rather than assumed -------------------------
    // The slot is real, it is OUTSIDE the built-in slot root (a sibling of it,
    // which is what the reference hook produces), and the registry names it.
    expect(slot).toBe(`${toPosixPath(wtRoot)}/hook-slots/ghosted`);
    expect(`${slot} under ${slotRoot}: ${slot.startsWith(slotRoot + '/')}`).toBe(
      `${slot} under ${slotRoot}: false`,
    );
    expect(existsSync(slot)).toBe(true);
    expect(existsSync(join(slot, '.hook-bookkeeping'))).toBe(true);
    expect(readRecord(root, 'ghosted').provisioner).toBe('hook');
    expect(reservations(wtRoot, portBase, 2)).toEqual([true, true]);

    // THE RUN DIES. Nothing calls `destroy`… and nothing could: with no
    // `worktree-destroy.*` in the repository, the built-in path REFUSES a
    // hook-provisioned slot outright (a5's symmetry rule, the refusal side). So
    // this slot is a leak that no `pipeline worktree` command can reach, which
    // is precisely when gc is supposed to be the janitor of record.
    const refused = wt(['destroy', '--name', 'ghosted', '--outcome', 'completed']);
    expect(refused.code).toBe(1);
    expect(refused.json.teardown_by).toBe('none');
    expect(refused.json.detail).toContain('REFUSES to reap a hook-provisioned slot');
    expect(`slot after the refusal: ${existsSync(slot)}`).toBe('slot after the refusal: true');

    // ---- and every pre-a12 scan says the repository is clean ---------------
    // Not under `.claude/worktrees/`; branch ATTACHED so the orphan-branch sweep
    // skips it; not under the built-in slot root so a8's scan skips it too.
    const dry = callGcJson(['--project', root]);
    expect(dry.code).toBe(0);
    expect(dry.report.worktrees).toEqual([]);
    expect(dry.report.stale_dirs).toEqual([]);
    expect(dry.report.branches).toEqual([]);
    expect(dry.report.slot_root).toBe(slotRoot);
    expect(existsSync(slotRoot)).toBe(false);

    // ---- DoD 7: THE VERDICT ------------------------------------------------
    // Against the code this task replaces this reads `invisible`, and the gc
    // report of a leaking project is a clean bill of health.
    expect(`gc knows the hook slot: ${verdictOn(dry.report, slot)}`).toBe('gc knows the hook slot: reported');

    const found = slotByPath(dry.report, slot);
    expect(found.name).toBe('ghosted');
    expect(found.record).toBe('hook');
    expect(found.source).toBe('registry');
    expect(found.exists).toBe(true);
    // DoD 3: reported, and NOT a reap target — the symmetry rule, stated.
    expect(found.orphaned).toBe(false);
    expect(found.reason).toContain('symmetry rule');
    expect(found.reason).toContain('HOOK');
    expect(dry.report.cleaned).toBeNull();

    // The HUMAN report names it too: an operator must not have to pass --json to
    // learn that a slot outside their repository is unaccounted for.
    const human = callGc(['--project', root]);
    expect(human.out).toContain(slot);
    expect(human.out).toContain('[registry]');
    // …and the one-line summary no longer reads as a clean bill of health while
    // a slot nothing can reap sits three lines above it. That sentence being
    // taken at face value IS P-5.
    expect(human.out).toContain('no leaks detected — but 1 slot above is reported and left to its owner');

    // ---- DoD 6: the report changed NOTHING ---------------------------------
    expect(`slot: ${existsSync(slot)}`).toBe('slot: true');
    expect(`hook bookkeeping: ${existsSync(join(slot, '.hook-bookkeeping'))}`).toBe('hook bookkeeping: true');
    expect(`env file: ${existsSync(envFile)}`).toBe('env file: true');
    expect(`record: ${existsSync(slotFile(root, 'ghosted'))}`).toBe('record: true');
    expect(`branch: ${branchThere(root, 'worktree-ghosted')}`).toBe('branch: true');
    expect(`registered: ${registeredCount(root)}`).toBe('registered: 2');
    expect(reservations(wtRoot, portBase, 2)).toEqual([true, true]);

    // ---- DoD 3: --clean does not touch it either ---------------------------
    const cleaned = callGcJson(['--project', root, '--clean']);
    expect(cleaned.report.cleaned!.reaped_slots).toEqual([]);
    expect(`slot: ${existsSync(slot)}`).toBe('slot: true');
    expect(`hook bookkeeping: ${existsSync(join(slot, '.hook-bookkeeping'))}`).toBe('hook bookkeeping: true');
    expect(`env file: ${existsSync(envFile)}`).toBe('env file: true');
    expect(`record: ${existsSync(slotFile(root, 'ghosted'))}`).toBe('record: true');
    expect(`branch: ${branchThere(root, 'worktree-ghosted')}`).toBe('branch: true');
    expect(reservations(wtRoot, portBase, 2)).toEqual([true, true]);
    // Still reported after the clean — a slot gc leaves alone must not vanish
    // from the next report, or "clean" would become the false clean again.
    expect(`gc knows the hook slot: ${verdictOn(cleaned.report, slot)}`).toBe('gc knows the hook slot: reported');
  });
}, 300000);

// ---------------------------------------------------------------------------
// (2) DoD 2 — a registry row whose slot is gone, in the order that matters
// ---------------------------------------------------------------------------

test('a registry row whose recorded worktree is gone: NOT reaped while a submodule slot still holds the work (a11), and reaped — row and ports only, nothing on disk — once every part is gone', () => {
  const root = scaffold({ nested: ['pkg/alpha'] });
  inProject(root, '25400-25499', ({ wtRoot }) => {
    const created = wtOk(['create', '--name', 'worker', '--submodules', 'pkg/alpha', '--ports', '2']);
    expect(created.provisioner).toBe('hook');
    const slot = created.worktree_path as string;
    const envFile = created.env_file as string;
    const portBase = created.port_base as number;
    // a11's resolution, off the env file the hook published — the record's own
    // `submodule_slots` is `[]` for a hook slot by design.
    const subSlot = `${toPosixPath(wtRoot)}/hook-slots/worker--alpha`;
    expect(created.submodule_slots.map((s: any) => s.dir)).toEqual([subSlot]);
    expect(existsSync(subSlot)).toBe(true);

    // THE WORKER'S COMMITS. They are in the SUBMODULE slot, which is the whole
    // point: the parent slot of a dispatched worker is empty by design.
    writeFileSync(join(subSlot, 'feature.txt'), 'finished implementation\n');
    sh(['add', '.'], subSlot);
    sh(['commit', '-q', '-m', 'the work'], subSlot);

    // ---- step 1: the PARENT directory goes, the work does not --------------
    // A cleaner swept the parent, or a partial teardown half-ran. Nothing else
    // changed: the registry still names it and the submodule slot still holds
    // the commit above.
    hardRemove(slot);
    const partial = callGcJson(['--project', root, '--clean']);
    const p = slotByPath(partial.report, slot);
    expect(`gc knows the hook slot: ${verdictOn(partial.report, slot)}`).toBe('gc knows the hook slot: reported');
    expect(p.exists).toBe(false);
    // THE ASSERTION THIS STEP EXISTS FOR. "The recorded worktree_path is gone"
    // is NOT "the slot held nothing" — reading it that way is the a11 incident,
    // which destroyed 21,880 bytes of finished work.
    expect(p.submodule_slots).toEqual([
      { path: 'pkg/alpha', dir: subSlot, source: 'env-file', exists: true },
    ]);
    expect(p.orphaned).toBe(false);
    expect(p.reason).toContain('NOT empty');
    expect(partial.report.cleaned!.reaped_slots).toEqual([]);
    expect(`the work: ${existsSync(join(subSlot, 'feature.txt'))}`).toBe('the work: true');
    expect(`record: ${existsSync(slotFile(root, 'worker'))}`).toBe('record: true');

    // ---- step 2: the submodule slot goes too — now the row is the leak -----
    // Through git, from the SUBMODULE's own repository — which is what the
    // consumer's `worktree-destroy.*` would have done, and what leaves the
    // registry row behind as the only trace of a slot that no longer exists.
    sh(['worktree', 'remove', '--force', subSlot], join(root, 'pkg', 'alpha'));
    hardRemove(subSlot);
    expect(`submodule slot: ${existsSync(subSlot)}`).toBe('submodule slot: false');
    const dry = callGcJson(['--project', root]).report;
    const s = slotByPath(dry, slot);
    expect(s.orphaned).toBe(true);
    expect(s.record).toBe('hook');
    expect(s.reason).toContain('nothing left on disk');
    // DoD 6 again, on the branch of the code that DOES reap: a report reaps
    // nothing, so the row is still there for the --clean below to drop.
    expect(`record after the report: ${existsSync(slotFile(root, 'worker'))}`).toBe('record after the report: true');

    const c = callGcJson(['--project', root, '--clean']).report.cleaned!;
    expect(c.reaped_slots.length).toBe(1);
    expect(c.reaped_slots[0]!.name).toBe('worker');
    expect(c.reaped_slots[0]!.reaped_by).toBe('record-only');
    expect(c.reaped_slots[0]!.removed_record).toBe(true);
    expect(c.reaped_slots[0]!.released_ports).toBe(2);
    // NOTHING ON DISK — the symmetry rule holds even here. The hook's env file
    // is the proof: it sits beside the slot, this CLI did not write it, and a
    // built-in teardown would have deleted it.
    expect(c.reaped_slots[0]!.removed_worktrees).toEqual([]);
    expect(c.reaped_slots[0]!.removed_env_file).toBeNull();
    expect(`the hook's env file: ${existsSync(envFile)}`).toBe("the hook's env file: true");

    // Read off DISK, not off the JSON: the row and the port block are gone.
    expect(`record: ${existsSync(slotFile(root, 'worker'))}`).toBe('record: false');
    expect(reservations(wtRoot, portBase, 2)).toEqual([false, false]);
    // Idempotent, and the row does not come back as a phantom.
    const again = callGcJson(['--project', root, '--clean']);
    expect(again.report.cleaned!.reaped_slots).toEqual([]);
    expect(verdictOn(again.report, slot)).toBe('invisible');

    const human = callGc(['--project', root, '--clean']);
    expect(human.out).not.toContain('hook-slots/worker');
  });
}, 600000);

// ---------------------------------------------------------------------------
// (3) DoD 5 — THE GUARDS, over paths that came out of the registry
// ---------------------------------------------------------------------------

test('DoD 5 — a registry row naming an implausible path is a REFUSAL, not a target: inside the repository, above the current working directory, and too close to a filesystem root', () => {
  const root = scaffold();
  inProject(root, '25500-25599', () => {
    // One healthy hook slot alongside, so "nothing was reaped" below cannot pass
    // because gc scanned nothing at all.
    const healthy = wtOk(['create', '--name', 'healthy', '--ports', '0']).worktree_path as string;
    const template = readRecord(root, 'healthy');
    expect(template.provisioner).toBe('hook');

    // (a) INSIDE THE REPOSITORY. The one mistake with no undo: a row that names
    //     the user's own tree. A hook writes this row, so no built-in provisioner
    //     invariant stands between it and a recursive delete.
    const inside = join(root, 'src');
    mkdirSync(inside, { recursive: true });
    writeFileSync(join(inside, 'precious.txt'), 'do not delete me\n');
    writeRecord(root, 'inrepo', { ...template, name: 'inrepo', worktree_path: toPosixPath(inside) });

    // (b) ABOVE THE CURRENT WORKING DIRECTORY — the project's own parent, which
    //     holds the repository itself.
    const above = toPosixPath(dirname(root));
    writeRecord(root, 'above', { ...template, name: 'above', worktree_path: above });

    // (c) ONE SEGMENT BELOW A FILESYSTEM ROOT — what a truncating crash, a bad
    //     merge or a text editor leaves in a plain JSON file. Nothing is there,
    //     so without the guard this row would read as "names nothing on disk"
    //     and be dropped; the surviving record below is what proves it was not.
    const shallow = process.platform === 'win32' ? 'C:/pipeline-a12-guard' : '/pipeline-a12-guard';
    writeRecord(root, 'shallow', { ...template, name: 'shallow', worktree_path: shallow });

    const c = callGcJson(['--project', root, '--clean']);
    expect(slotByPath(c.report, inside).reason).toContain('inside the repository');
    expect(slotByPath(c.report, above).reason).toContain('current working directory');
    expect(slotByPath(c.report, shallow).reason).toContain('too close to a filesystem root');
    for (const p of [inside, above, shallow]) {
      expect(`${p} orphaned: ${slotByPath(c.report, p).orphaned}`).toBe(`${p} orphaned: false`);
    }
    expect(c.report.cleaned!.reaped_slots).toEqual([]);

    // Read off disk: nothing was deleted and no row was dropped.
    expect(`precious: ${existsSync(join(inside, 'precious.txt'))}`).toBe('precious: true');
    expect(`the repository: ${existsSync(join(root, 'README.md'))}`).toBe('the repository: true');
    for (const n of ['inrepo', 'above', 'shallow', 'healthy']) {
      expect(`${n} record: ${existsSync(slotFile(root, n))}`).toBe(`${n} record: true`);
    }
    expect(`healthy slot: ${existsSync(healthy)}`).toBe('healthy slot: true');

    // …and the guards did not swallow the healthy one: it is reported, with the
    // symmetry rule's reason rather than a refusal.
    expect(slotByPath(c.report, healthy).reason).toContain('symmetry rule');
  });
}, 300000);

// ---------------------------------------------------------------------------
// (4) DoD 4 — nothing about the existing shape changed
// ---------------------------------------------------------------------------

test('a project whose registry is empty and whose slot root holds nothing still reports an empty slot section and says "no leaks detected"', () => {
  const root = scaffold();
  inProject(root, '25600-25699', ({ slotRoot }) => {
    const j = callGcJson(['--project', root]);
    expect(j.code).toBe(0);
    expect(j.report.slot_root).toBe(slotRoot);
    expect(j.report.builtin_slots).toEqual([]);
    const h = callGc(['--project', root]);
    expect(h.out).toContain('no leaks detected');
    expect(h.out).not.toContain('built-in worktree slots');

    // And a slot whose record was reaped normally leaves nothing behind either:
    // `destroy` drops the row, so the registry scan has nothing to report.
    const created = wtOk(['create', '--name', 'transient', '--ports', '0']);
    expect(callGcJson(['--project', root]).report.builtin_slots.length).toBe(1);
    unlinkSync(slotFile(root, 'transient'));
    hardRemove(created.worktree_path as string);
    expect(callGcJson(['--project', root]).report.builtin_slots).toEqual([]);
  });
}, 300000);
