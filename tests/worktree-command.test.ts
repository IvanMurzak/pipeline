// `pipeline worktree create|finalize|destroy|list` — the standalone lifecycle
// (taskflow-v2 a2).
//
// The command drives the FROZEN worktree-hook contract with no pipeline run, so
// what has to be pinned here is everything the run path used to supply and now
// nobody does: the slot name (`--name`, defaulting to a UUIDv7 and validated
// before it can reach a path or a branch — SG6), the standalone context values
// (`PIPELINE_WT_PIPELINE_ROOT`/`_PIPELINE_NAME` empty), the absence of
// run-scoped journal events, and the created-vs-reused distinction the
// orchestrator reads as duplicate dispatch.
//
// The anti-drift half — that this command and the RUN path hand a hook
// byte-identical `PIPELINE_WT_*` — deliberately lives in
// tests/worktree-hook-module.test.ts beside a1's original assertion, so the
// frozen contract has exactly one place that compares its callers.
//
// Same in-process driving pattern as tests/hooks.test.ts: a real temp git repo
// as the consumer project, plain-JS fake hooks (run through process.execPath
// per the interpreter map), cwd swapped for the duration.

import { test, expect, afterEach } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupCreated, ident, mkTmp } from './_git-sandbox';
import { runWorktree, validateSlotName } from '../src/commands/worktree';
import { realGit } from '../src/lib/git';

afterEach(cleanupCreated);

// ---------------------------------------------------------------------------
// Fake hooks
// ---------------------------------------------------------------------------

/** Every hook dumps the PIPELINE_WT_* env it received — once per action into
 *  `<action>-env-dump.json` (last call wins) and once appended to
 *  `hook-calls.jsonl` (so "the hook never ran" is assertable). */
const DUMP = (file: string): string => `
const fs = require('fs');
const path = require('path');
const env = {};
for (const k of Object.keys(process.env)) if (k.startsWith('PIPELINE_WT_')) env[k] = process.env[k];
fs.writeFileSync(path.join(process.cwd(), '${file}'), JSON.stringify(env));
fs.appendFileSync(path.join(process.cwd(), 'hook-calls.jsonl'), JSON.stringify(env) + '\\n');
`;

/** Idempotent per name, and it really creates the directory — reuse detection
 *  reads the filesystem, so a hook that only PRINTS a path would make the
 *  created/reused test vacuous. */
const CREATE_HOOK = `${DUMP('create-env-dump.json')}
const name = process.env.PIPELINE_WT_NAME || 'unnamed';
const wt = path.join(process.cwd(), '.claude', 'worktrees', name);
fs.mkdirSync(wt, { recursive: true });
fs.writeFileSync(path.join(wt, '.worktree.env'), 'SLOT=' + name + '\\n');
process.stdout.write(JSON.stringify({
  worktree_path: wt,
  branch: 'worktree-' + name,
  env_file: path.join(wt, '.worktree.env'),
}) + '\\n');
`;

const FINALIZE_HOOK = `${DUMP('finalize-env-dump.json')}
process.stdout.write(JSON.stringify({ ok: true, detail: 'pushed 1 commit' }) + '\\n');
`;

/** The recommended production pattern: reap on `completed`, PRESERVE on
 *  anything else. Both halves of DoD 8 are observable on disk because of it. */
const DESTROY_HOOK = `${DUMP('destroy-env-dump.json')}
const wt = process.env.PIPELINE_WT_WORKTREE_PATH || '';
if (process.env.PIPELINE_WT_OUTCOME === 'completed' && wt) fs.rmSync(wt, { recursive: true, force: true });
process.stdout.write(JSON.stringify({ ok: true }) + '\\n');
`;

interface HookSet {
  create?: string | null;
  finalize?: string | null;
  destroy?: string | null;
}

/** A real git repo (so the reuse probe's `git worktree list` has something to
 *  answer) plus `.pipeline/.hooks`. A `null` hook is omitted entirely. */
function scaffold(hooks: HookSet = {}): string {
  const tmp = mkTmp('wtcmd-');
  const r = realGit(['init', '-q', '-b', 'main'], tmp);
  if (r.code !== 0) throw new Error(`git init failed: ${r.stderr}`);
  ident(tmp);
  writeFileSync(join(tmp, 'README.md'), 'x\n');
  realGit(['add', '.'], tmp);
  realGit(['commit', '-q', '-m', 'init'], tmp);

  // Anchor on GIT's spelling of the path, not the OS's: GitHub's Windows
  // runner hands out 8.3 short TEMP segments (`RUNNER~1`) that realpathSync
  // does NOT expand while `git worktree list` always prints the long form.
  // Comparing the two would make the reuse probe's path match fail on CI only.
  const top = realGit(['rev-parse', '--show-toplevel'], tmp);
  const root =
    top.code === 0 && top.stdout.trim()
      ? process.platform === 'win32'
        ? top.stdout.trim().replace(/\//g, '\\')
        : top.stdout.trim()
      : tmp;

  const hooksDir = join(root, '.pipeline', '.hooks');
  mkdirSync(hooksDir, { recursive: true });
  const write = (base: string, body: string | null | undefined, fallback: string): void => {
    if (body === null) return;
    writeFileSync(join(hooksDir, `${base}.js`), body ?? fallback);
  };
  write('worktree-create', hooks.create, CREATE_HOOK);
  write('worktree-finalize', hooks.finalize, FINALIZE_HOOK);
  write('worktree-destroy', hooks.destroy, DESTROY_HOOK);
  return root;
}

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

function inProject<T>(root: string, fn: () => T): T {
  const prev = process.cwd();
  try {
    process.chdir(root);
    return fn();
  } finally {
    process.chdir(prev);
  }
}

/** Run runWorktree() in-process, capturing stdout AND stderr. */
function call(args: string[]): { code: number; out: string; err: string } {
  let out = '';
  let err = '';
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  (process.stdout as any).write = (chunk: unknown) => {
    out += String(chunk);
    return true;
  };
  (process.stderr as any).write = (chunk: unknown) => {
    err += String(chunk);
    return true;
  };
  let code: number;
  try {
    code = runWorktree(args);
  } finally {
    (process.stdout as any).write = origOut;
    (process.stderr as any).write = origErr;
  }
  return { code, out, err };
}

function callJson(args: string[]): { code: number; json: any; err: string } {
  const r = call([...args, '--json']);
  return { code: r.code, json: r.out.trim() ? JSON.parse(r.out) : null, err: r.err };
}

const envDump = (root: string, action: 'create' | 'finalize' | 'destroy'): Record<string, string> =>
  JSON.parse(readFileSync(join(root, `${action}-env-dump.json`), 'utf8')) as Record<string, string>;

const hookCallCount = (root: string): number => {
  const f = join(root, 'hook-calls.jsonl');
  if (!existsSync(f)) return 0;
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).length;
};

/** Point the BUILT-IN provisioner's slot root (taskflow-v2 a3) at a temp dir
 *  that `cleanupCreated` reaps. Only the two tests that deliberately reach the
 *  provisioner need it; everywhere else in this file a create hook exists and
 *  the provisioner is inert. */
function withSlotRoot<T>(fn: () => T): T {
  const saved = process.env.PIPELINE_WT_ROOT;
  process.env.PIPELINE_WT_ROOT = mkTmp('wtcmdslots-');
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.PIPELINE_WT_ROOT;
    else process.env.PIPELINE_WT_ROOT = saved;
  }
}

const eventsFile = (root: string): string => join(root, '.pipeline', '.runtime', 'events.jsonl');
const slotFile = (root: string, name: string): string =>
  join(root, '.pipeline', '.runtime', 'worktrees', `${name}.json`);

// ---------------------------------------------------------------------------
// (1) Surface: help, verbs, flags
// ---------------------------------------------------------------------------

test('worktree --help lists all four subcommands; no verb / unknown verb / unknown flag are usage errors', () => {
  const root = scaffold();
  inProject(root, () => {
    const help = call(['--help']);
    expect(help.code).toBe(0);
    for (const verb of ['create', 'finalize', 'destroy', 'list']) expect(help.out).toContain(verb);
    // The standalone context is documented in the help itself — a frozen
    // contract's second dialect must not be discoverable only by reading code.
    expect(help.out).toContain('PIPELINE_WT_PIPELINE_ROOT');
    expect(help.out).toContain('EMPTY');

    expect(call([]).code).toBe(2);
    expect(call(['bogus']).code).toBe(2);
    expect(call(['bogus']).err).toContain("unknown verb 'bogus'");
    expect(call(['create', '--nope']).code).toBe(2);
    expect(call(['create', '--name']).code).toBe(2); // flag with no value
    expect(call(['destroy', '--name', 'x', '--outcome', 'sideways']).code).toBe(2);
    expect(call(['create', '--ports', 'many']).code).toBe(2);
    expect(call(['finalize']).code).toBe(2); // --name is required off the create path
    expect(call(['list', '--name', 'x']).code).toBe(2); // list takes only --json
    expect(hookCallCount(root)).toBe(0); // not one usage error reached a hook
  });
}, 30000);

// ---------------------------------------------------------------------------
// (2) create: JSON shape, standalone context, no journal
// ---------------------------------------------------------------------------

test('create --json emits the documented shape and hands the hook the STANDALONE context (PIPELINE_ROOT/PIPELINE_NAME empty, NAME = the slot)', () => {
  const root = scaffold();
  inProject(root, () => {
    const r = callJson(['create', '--name', 'slot-alpha', '--base', 'next', '--submodules', 'AppX, McpY']);
    expect(r.code).toBe(0);
    expect(r.json.command).toBe('worktree create');
    expect(r.json.ok).toBe(true);
    expect(r.json.status).toBe('created');
    expect(r.json.reused).toBe(false);
    expect(r.json.reused_evidence).toBeNull();
    expect(r.json.name).toBe('slot-alpha');
    expect(r.json.worktree_path).toBe(join(root, '.claude', 'worktrees', 'slot-alpha'));
    expect(r.json.branch).toBe('worktree-slot-alpha');
    expect(r.json.env_file).toBe(join(root, '.claude', 'worktrees', 'slot-alpha', '.worktree.env'));
    expect(r.json.base_branch).toBe('next');
    expect(r.json.submodules).toEqual(['AppX', 'McpY']);
    expect(r.json.hook_dir).toBe('.pipeline/.hooks');
    expect(r.json.ports).toBeNull();
    expect(r.json.detail).toBeNull();
    expect(existsSync(r.json.worktree_path)).toBe(true);

    // The standalone context, on the wire the hook actually saw.
    const env = envDump(root, 'create');
    expect(env.PIPELINE_WT_PIPELINE_ROOT).toBe('');
    expect(env.PIPELINE_WT_PIPELINE_NAME).toBe('');
    expect(env.PIPELINE_WT_NAME).toBe('slot-alpha');
    expect(env.PIPELINE_WT_RUN_ID).toBe('slot-alpha');
    expect(env.PIPELINE_WT_ACTION).toBe('create');
    expect(env.PIPELINE_WT_PROJECT_ROOT).toBe(root);
    expect(env.PIPELINE_WT_BASE_BRANCH).toBe('next');
    expect(env.PIPELINE_WT_SUBMODULES).toBe('AppX,McpY');
    expect(env.PIPELINE_WT_DRY_RUN).toBe('0');
    // Both keys are PRESENT, not absent — the frozen contract lists them as
    // always present, and absent is a different observation from empty.
    expect(Object.keys(env)).toContain('PIPELINE_WT_PIPELINE_ROOT');
    expect(Object.keys(env)).toContain('PIPELINE_WT_PIPELINE_NAME');

    // A slot record was written where finalize/destroy/list will find it.
    expect(existsSync(slotFile(root, 'slot-alpha'))).toBe(true);
  });
}, 30000);

test('a standalone invocation writes NO run-scoped journal events (create + finalize + destroy)', () => {
  const root = scaffold();
  inProject(root, () => {
    expect(call(['create', '--name', 'quiet-slot']).code).toBe(0);
    expect(call(['finalize', '--name', 'quiet-slot']).code).toBe(0);
    expect(call(['destroy', '--name', 'quiet-slot']).code).toBe(0);
    expect(existsSync(eventsFile(root))).toBe(false);
  });
}, 30000);

test('--name defaults to a freshly minted UUIDv7 — the identifier `pipeline id` produces', () => {
  const root = scaffold();
  inProject(root, () => {
    const a = callJson(['create']);
    const b = callJson(['create']);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(a.json.name).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(b.json.name).not.toBe(a.json.name);
    // A default name is a FRESH slot every time, never a reuse.
    expect(a.json.status).toBe('created');
    expect(b.json.status).toBe('created');
  });
}, 30000);

// ---------------------------------------------------------------------------
// (3) Idempotence: created vs reused
// ---------------------------------------------------------------------------

test('a second create with the same name REUSES the slot and reports it as reused (the orchestrator reads that as duplicate dispatch)', () => {
  const root = scaffold();
  inProject(root, () => {
    const first = callJson(['create', '--name', 'dup-slot']);
    expect(first.code).toBe(0);
    expect(first.json.status).toBe('created');
    expect(first.json.reused).toBe(false);

    const second = callJson(['create', '--name', 'dup-slot']);
    expect(second.code).toBe(0); // idempotence is CORRECT behavior, not an error
    expect(second.json.status).toBe('reused');
    expect(second.json.reused).toBe(true);
    expect(second.json.reused_evidence).toBe('registry');
    expect(second.json.worktree_path).toBe(first.json.worktree_path);

    // Human output says so too — an operator must not have to diff paths.
    const human = call(['create', '--name', 'dup-slot']);
    expect(human.out).toContain('reused');

    // A DIFFERENT name in the same project is still a fresh slot.
    expect(callJson(['create', '--name', 'other-slot']).json.status).toBe('created');
  });
}, 30000);

test('reuse is detected from a pre-existing git worktree registration even with no slot record of our own', () => {
  const root = scaffold({
    // A create hook that registers a REAL git worktree, the way a production
    // hook does — and is idempotent per name.
    create: `${DUMP('create-env-dump.json')}
const cp = require('child_process');
const name = process.env.PIPELINE_WT_NAME;
const wt = path.join(process.cwd(), '.claude', 'worktrees', name);
if (!fs.existsSync(wt)) {
  const r = cp.spawnSync(process.env.PIPELINE_GIT_BIN || 'git', ['worktree', 'add', '-b', 'worktree-' + name, wt, 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' });
  if (r.status !== 0) { process.stderr.write(String(r.stderr)); process.exit(1); }
}
process.stdout.write(JSON.stringify({ worktree_path: wt, branch: 'worktree-' + name, env_file: null }) + '\\n');
`,
  });
  inProject(root, () => {
    const first = callJson(['create', '--name', 'gitslot']);
    expect(first.code).toBe(0);
    expect(first.json.status).toBe('created');

    // Drop OUR record; git's registration is the only remaining evidence.
    unlinkSync(slotFile(root, 'gitslot'));
    const second = callJson(['create', '--name', 'gitslot']);
    expect(second.code).toBe(0);
    expect(second.json.status).toBe('reused');
    expect(second.json.reused_evidence).toBe('git-worktree');
  });
}, 60000);

// ---------------------------------------------------------------------------
// (4) A --name unrelated to any run id, end to end
// ---------------------------------------------------------------------------

test('a --name unrelated to any run id runs the whole lifecycle: create -> finalize -> destroy', () => {
  const root = scaffold();
  inProject(root, () => {
    const created = callJson(['create', '--name', 'task-b7.review-2']);
    expect(created.code).toBe(0);
    expect(created.json.worktree_path).toBe(join(root, '.claude', 'worktrees', 'task-b7.review-2'));

    const fin = callJson(['finalize', '--name', 'task-b7.review-2']);
    expect(fin.code).toBe(0);
    expect(fin.json.ok).toBe(true);
    expect(fin.json.detail).toBe('pushed 1 commit');
    expect(fin.json.worktree_path).toBe(created.json.worktree_path);
    const fenv = envDump(root, 'finalize');
    expect(fenv.PIPELINE_WT_NAME).toBe('task-b7.review-2');
    expect(fenv.PIPELINE_WT_WORKTREE_PATH).toBe(created.json.worktree_path);
    expect(fenv.PIPELINE_WT_OUTCOME).toBe('completed');
    expect(fenv.PIPELINE_WT_PIPELINE_ROOT).toBe('');

    const gone = callJson(['destroy', '--name', 'task-b7.review-2']);
    expect(gone.code).toBe(0);
    expect(gone.json.reaped).toBe(true);
    expect(existsSync(created.json.worktree_path)).toBe(false);
    expect(existsSync(eventsFile(root))).toBe(false);
  });
}, 30000);

// ---------------------------------------------------------------------------
// (5) destroy: halted preserves, completed reaps
// ---------------------------------------------------------------------------

test('destroy --outcome halted PRESERVES (DELETE_BRANCHES=0, slot kept); --outcome completed REAPS (DELETE_BRANCHES=1, slot dropped)', () => {
  const root = scaffold();
  inProject(root, () => {
    const c = callJson(['create', '--name', 'keeper']);
    const wt = c.json.worktree_path as string;

    const halted = callJson(['destroy', '--name', 'keeper', '--outcome', 'halted']);
    expect(halted.code).toBe(0);
    expect(halted.json.outcome).toBe('halted');
    expect(halted.json.delete_branches).toBe(false);
    expect(halted.json.reaped).toBe(false);
    expect(halted.json.preserved).toBe(true);
    let denv = envDump(root, 'destroy');
    expect(denv.PIPELINE_WT_OUTCOME).toBe('halted');
    expect(denv.PIPELINE_WT_DELETE_BRANCHES).toBe('0');
    expect(denv.PIPELINE_WT_WORKTREE_PATH).toBe(wt);
    expect(existsSync(wt)).toBe(true); // the hook preserved it
    expect(existsSync(slotFile(root, 'keeper'))).toBe(true); // still tracked
    expect(callJson(['list']).json.slots.map((s: any) => s.name)).toContain('keeper');

    const done = callJson(['destroy', '--name', 'keeper', '--outcome', 'completed']);
    expect(done.code).toBe(0);
    expect(done.json.delete_branches).toBe(true);
    expect(done.json.reaped).toBe(true);
    expect(done.json.preserved).toBe(false);
    denv = envDump(root, 'destroy');
    expect(denv.PIPELINE_WT_OUTCOME).toBe('completed');
    expect(denv.PIPELINE_WT_DELETE_BRANCHES).toBe('1');
    expect(existsSync(wt)).toBe(false); // the hook reaped it
    expect(existsSync(slotFile(root, 'keeper'))).toBe(false);
    expect(callJson(['list']).json.slots).toEqual([]);
  });
}, 30000);

// ---------------------------------------------------------------------------
// (6) Exit codes: success · soft-fail · hard-fail · invalid --name
// ---------------------------------------------------------------------------

test('exit 1 on a destroy SOFT-fail ({"ok":false} + exit 0): the slot is kept and the hook\'s own detail is reported', () => {
  const root = scaffold({
    destroy: `${DUMP('destroy-env-dump.json')}
process.stdout.write(JSON.stringify({ ok: false, detail: 'worktree busy' }) + '\\n');
`,
  });
  inProject(root, () => {
    expect(call(['create', '--name', 'soft']).code).toBe(0);
    const r = callJson(['destroy', '--name', 'soft']);
    expect(r.code).toBe(1);
    expect(r.json.ok).toBe(false);
    expect(r.json.detail).toBe('worktree busy');
    // A failed teardown must never drop the record — that would hide the leak.
    expect(r.json.reaped).toBe(false);
    expect(r.json.preserved).toBe(true);
    expect(existsSync(slotFile(root, 'soft'))).toBe(true);
  });
}, 30000);

test('exit 1 on a HARD-fail (non-zero exit, and a missing hook): detail names the hook and why', () => {
  const nonZero = scaffold({
    create: `${DUMP('create-env-dump.json')}
process.stderr.write('boom\\n');
process.exit(3);
`,
  });
  inProject(nonZero, () => {
    const r = callJson(['create', '--name', 'hard']);
    expect(r.code).toBe(1);
    expect(r.json.ok).toBe(false);
    expect(r.json.status).toBe('failed');
    expect(r.json.worktree_path).toBeNull();
    expect(r.json.detail).toContain('worktree-create hook');
    expect(r.json.detail).toContain('exited 3');
    expect(existsSync(slotFile(nonZero, 'hard'))).toBe(false); // nothing recorded
  });

  // A MISSING create hook is no longer a hard-fail here: taskflow-v2 a3 gave
  // the standalone command a built-in provisioner for exactly that case (D9 —
  // the standalone command only; a pipeline RUN with no create hook still
  // halts, asserted in tests/worktree-hook-module.test.ts). The hard-fail
  // catalogue above is what remains: a hook that exists and misbehaves.
  const missing = scaffold({ create: null });
  inProject(missing, () => {
    const r = withSlotRoot(() => callJson(['create', '--name', 'nohook']));
    expect(r.code).toBe(0);
    expect(r.json.provisioner).toBe('builtin');
    expect(r.json.worktree_path).not.toBeNull();
  });

  const garbage = scaffold({
    create: `${DUMP('create-env-dump.json')}
process.stdout.write('not json at all\\n');
`,
  });
  inProject(garbage, () => {
    const r = callJson(['create', '--name', 'garbage']);
    expect(r.code).toBe(1);
    expect(r.json.detail).toContain('stdout not JSON');
  });
  // 180s: the missing-hook third of this test now provisions a REAL git
  // worktree (a3), and git-heavy suites are the ones that time out under load.
}, 180000);

test('finalize is STRICT must-succeed: a hook that does not print {"ok":true} exits 1', () => {
  const root = scaffold({
    finalize: `${DUMP('finalize-env-dump.json')}
process.stdout.write(JSON.stringify({ detail: 'forgot the ok flag' }) + '\\n');
`,
  });
  inProject(root, () => {
    expect(call(['create', '--name', 'strict']).code).toBe(0);
    const r = callJson(['finalize', '--name', 'strict']);
    expect(r.code).toBe(1);
    expect(r.json.ok).toBe(false);
    expect(r.json.detail).toBe('forgot the ok flag');
  });
}, 30000);

// ---------------------------------------------------------------------------
// (7) SG6 — hostile --name values
// ---------------------------------------------------------------------------

const HOSTILE: Array<[string, string]> = [
  ['../evil', 'parent traversal'],
  ['..', 'bare parent'],
  ['a/b', 'posix path separator'],
  ['a\\b', 'windows path separator'],
  ['a..b', 'embedded ..'],
  ['-rf', 'leading dash reads as a flag'],
  ['--name', 'leading dashes'],
  ['a b', 'inner whitespace'],
  [' lead', 'leading whitespace'],
  ['trail ', 'trailing whitespace'],
  ['a;rm -rf /', 'shell command separator'],
  ['a|b', 'pipe'],
  ['a&b', 'background operator'],
  ['a>b', 'redirect'],
  ['$(id)', 'command substitution'],
  ['`id`', 'backtick substitution'],
  ['a\nb', 'newline'],
  ['a\tb', 'tab'],
  ['.hidden', 'leading dot'],
  ['C:name', 'drive-letter colon'],
  ['~root', 'home expansion'],
  ['*', 'glob'],
  ['sl"ot', 'double quote'],
  ["sl'ot", 'single quote'],
  ['sl\u0000ot', 'NUL byte'],
  ['слот', 'non-ASCII'],
  ['trailing.', 'trailing dot (windows path hazard)'],
  ['CON', 'windows reserved device'],
  ['nul.txt', 'windows reserved device with extension'],
  ['x'.repeat(65), 'over the length cap'],
  ['', 'empty'],
];

test('SG6: a hostile --name is refused with exit 2 BEFORE any path, branch, hook, or record is touched', () => {
  const root = scaffold();
  inProject(root, () => {
    for (const [name, why] of HOSTILE) {
      for (const verb of ['create', 'finalize', 'destroy']) {
        const r = call([verb, '--name', name]);
        expect(`${verb} ${why}: ${r.code}`).toBe(`${verb} ${why}: 2`);
        expect(r.err).toContain('invalid --name');
      }
    }
    // Nothing ran, nothing was written: no hook invocation, no slot record
    // directory, no worktree directory, no journal.
    expect(hookCallCount(root)).toBe(0);
    expect(existsSync(join(root, '.claude', 'worktrees'))).toBe(false);
    expect(existsSync(join(root, '.pipeline', '.runtime', 'worktrees'))).toBe(false);
    expect(existsSync(eventsFile(root))).toBe(false);
  });
}, 60000);

test('validateSlotName accepts exactly the names the command promises', () => {
  for (const ok of ['a', 'A1', 'slot-alpha', 'task-b7.review-2', 'x_y', '019fc762-5762-7000-a9bf-922ed8fa00be', 'x'.repeat(64)]) {
    expect(`${ok}: ${validateSlotName(ok)}`).toBe(`${ok}: null`);
  }
  for (const bad of HOSTILE.map(([n]) => n)) expect(validateSlotName(bad)).not.toBeNull();
});

// ---------------------------------------------------------------------------
// (8) list
// ---------------------------------------------------------------------------

test('list reports the provisioned slots (and whether each is still on disk); it never reaps', () => {
  const root = scaffold();
  inProject(root, () => {
    const empty = callJson(['list']);
    expect(empty.code).toBe(0);
    expect(empty.json.command).toBe('worktree list');
    expect(empty.json.slots).toEqual([]);
    expect(call(['list']).out).toContain('no provisioned worktree slots');

    call(['create', '--name', 'one']);
    call(['create', '--name', 'two', '--base', 'next', '--submodules', 'AppX']);
    const listed = callJson(['list']);
    expect(listed.json.slots.map((s: any) => s.name)).toEqual(['one', 'two']);
    const two = listed.json.slots.find((s: any) => s.name === 'two');
    expect(two.exists).toBe(true);
    expect(two.branch).toBe('worktree-two');
    expect(two.base_branch).toBe('next');
    expect(two.submodules).toEqual(['AppX']);
    expect(two.hook_dir).toBe('.pipeline/.hooks');

    // A slot whose directory disappeared out from under us is REPORTED, not
    // reaped — leak collection is `pipeline gc`'s job, not this command's.
    rmSync(join(root, '.claude', 'worktrees', 'one'), { recursive: true, force: true });
    const after = callJson(['list']);
    expect(after.json.slots.find((s: any) => s.name === 'one').exists).toBe(false);
    expect(after.json.slots.length).toBe(2);
    expect(call(['list']).out).toContain('missing');
  });
}, 30000);

// ---------------------------------------------------------------------------
// (9) --ports is accepted and RECORDED, not allocated (a4 owns allocation)
// ---------------------------------------------------------------------------

test('--ports N is recorded, reported as not-allocated, and never invented into the env', () => {
  const root = scaffold();
  inProject(root, () => {
    const r = callJson(['create', '--name', 'ported', '--ports', '3']);
    expect(r.code).toBe(0);
    expect(r.json.ports).toBeNull();
    expect(r.json.ports_requested).toBe(3);
    expect(call(['create', '--name', 'ported2', '--ports', '3']).out).toContain('NOT allocated');
    const env = envDump(root, 'create');
    expect(Object.keys(env).some((k) => /PORT/i.test(k))).toBe(false);
  });
}, 30000);

// ---------------------------------------------------------------------------
// (10) --hook-dir
// ---------------------------------------------------------------------------

test('--hook-dir redirects hook resolution (relative to the project root, or absolute) and is replayed by finalize/destroy', () => {
  const root = scaffold({ create: null, finalize: null, destroy: null });
  const alt = join(root, 'tools', 'wt-hooks');
  mkdirSync(alt, { recursive: true });
  writeFileSync(join(alt, 'worktree-create.js'), CREATE_HOOK);
  writeFileSync(join(alt, 'worktree-destroy.js'), DESTROY_HOOK);
  inProject(root, () => {
    // The default dir has no hooks at all, so the DEFAULT resolution reaches
    // the built-in provisioner (a3) and never the hook under `tools/`: the
    // hook's own marker file is the proof it did not run.
    const dflt = withSlotRoot(() => callJson(['create', '--name', 'default-dir']));
    expect(dflt.code).toBe(0);
    expect(dflt.json.provisioner).toBe('builtin');
    expect(existsSync(join(root, 'create-env-dump.json'))).toBe(false);

    const r = callJson(['create', '--name', 'alt', '--hook-dir', 'tools/wt-hooks']);
    expect(r.code).toBe(0);
    expect(r.json.hook_dir).toBe('tools/wt-hooks');
    expect(r.json.provisioner).toBe('hook');
    expect(existsSync(join(root, 'create-env-dump.json'))).toBe(true);

    // destroy replays the recorded hook dir without being told again.
    const d = callJson(['destroy', '--name', 'alt']);
    expect(d.code).toBe(0);
    expect(d.json.reaped).toBe(true);
  });
  // 180s: the default-hook-dir half now reaches the built-in provisioner,
  // which does real git work.
}, 180000);
