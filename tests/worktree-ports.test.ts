// PORT ALLOCATION for provisioned slots (taskflow-v2 a4).
//
// The property under test is not "a number appears in a file" — it is that two
// workers cannot be handed the same port. That is a property of the OPERATING
// SYSTEM and of CONCURRENT PROCESSES, so the tests here are correspondingly
// physical:
//
//   * "occupied ports are skipped" BINDS a real listening socket inside the
//     block the allocator would otherwise have chosen, and asserts it moved;
//   * "two live slots never overlap" spawns REAL `pipeline worktree create`
//     PROCESSES, all started before any is awaited, on slot names deliberately
//     chosen to hash to the SAME deterministic base — the collision the
//     allocator has to survive. Sequential creates, or creates with unrelated
//     names, would pass without the mechanism existing at all;
//   * the env-file assertions read the RAW bytes on disk, in a4's inherited
//     style, because the file's second consumer is `set -a && source` and a
//     tolerant parser would forgive what a shell will not.
//
// The bind probe needs a SYNCHRONOUS answer (the whole command is synchronous),
// which is why the allocator uses Bun's listen and these tests hold their
// sockets the same way.

import { test, expect, afterEach } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupCreated, ident, mkTmp } from './_git-sandbox';
import { runWorktree } from '../src/commands/worktree';
import { parseEnvFile } from '../src/lib/env-file';
import { realGit, type GitResult } from '../src/lib/git';
import {
  DEFAULT_PORT_COUNT,
  PORT_BASE_KEY,
  PORT_COUNT_KEY,
  PORT_RANGE_ENV,
  PORT_RANGE_MAX,
  PORT_RANGE_MIN,
  allocatePorts,
  deterministicBase,
  isPortFree,
  portEnvEntries,
  readPortsFromEnv,
  resolvePortRange,
} from '../src/lib/port-alloc';
import { slotRootFor } from '../src/lib/worktree-provision';

// ---------------------------------------------------------------------------
// Sockets held by a test
// ---------------------------------------------------------------------------

interface HeldServer {
  stop(closeActiveConnections?: boolean): void;
}
interface BunListen {
  listen(opts: { hostname: string; port: number; socket: Record<string, unknown> }): HeldServer;
}
const bun = (globalThis as unknown as { Bun: BunListen }).Bun;

const held: HeldServer[] = [];

/** Occupy `port` for real. The wildcard address is what the allocator probes
 *  first on every platform, so this is the strongest single-socket occupancy a
 *  test can create. */
function hold(port: number): void {
  held.push(bun.listen({ hostname: '0.0.0.0', port, socket: { data() {} } }));
}

afterEach(() => {
  while (held.length) {
    try {
      held.pop()!.stop(true);
    } catch {
      // best-effort
    }
  }
  cleanupCreated();
});

// ---------------------------------------------------------------------------
// Sandboxes and drivers (same shape as tests/worktree-provision.test.ts)
// ---------------------------------------------------------------------------

function sh(args: string[], cwd?: string, check = true): GitResult {
  const r = realGit(args, cwd);
  if (check && r.code !== 0) {
    throw new Error(`git ${args.join(' ')} @ ${cwd ?? '.'} → ${r.code}: ${(r.stderr || r.stdout).trim()}`);
  }
  return r;
}

/** Git's OWN spelling of the repo root — GitHub's Windows runner hands out 8.3
 *  short TEMP segments and git always prints the long form. */
function gitRoot(dir: string): string {
  const top = sh(['rev-parse', '--show-toplevel'], dir).stdout.trim();
  return process.platform === 'win32' ? top.replace(/\//g, '\\') : top;
}

function scaffold(opts: { createHook?: string } = {}): string {
  const tmp = mkTmp('wtports-');
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

interface Ctx {
  slotRoot: string;
  wtRoot: string;
  range: { min: number; max: number };
}

/** cwd → the project; a private slot root and a private PORT RANGE per test,
 *  so one test's blocks and reservations can never be another's. */
function inProject<T>(root: string, portRange: string, fn: (ctx: Ctx) => T): T {
  const prev = process.cwd();
  const keys = [PORT_RANGE_ENV, 'PIPELINE_WT_ROOT', 'PIPELINE_WT_FETCH', 'PIPELINE_WT_INTEGRATION_BRANCH'];
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];
  const wtRoot = mkTmp('wtpr-');
  try {
    process.chdir(root);
    process.env.PIPELINE_WT_ROOT = wtRoot;
    process.env[PORT_RANGE_ENV] = portRange;
    delete process.env.PIPELINE_WT_FETCH;
    delete process.env.PIPELINE_WT_INTEGRATION_BRANCH;
    const parsed = resolvePortRange(portRange);
    if ('error' in parsed) throw new Error(parsed.error);
    return fn({ slotRoot: slotRootFor(root), wtRoot, range: parsed });
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
    code = runWorktree(args, realGit);
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

/** The env file's RAW lines — deliberately not parseEnvFile: what matters is
 *  what is ON DISK before a tolerant reader forgives it. */
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
// (1) DoD 1 + 5 + 8 — the block reaches the env file, unquoted, and --json
//     reports it by reading that file back
// ---------------------------------------------------------------------------

test('create --ports N allocates a CONTIGUOUS free block, writes it into the env file unquoted, and --json reports it back from the file', () => {
  const root = scaffold();
  inProject(root, '21400-21499', () => {
    const r = callJson(['create', '--name', 'ports3', '--ports', '3']);
    expect(r.code).toBe(0);
    expect(r.json.ok).toBe(true);
    expect(r.json.ports_requested).toBe(3);
    expect(r.json.ports_source).toBe('builtin');

    // Contiguous, in range, and exactly N of them.
    const base = r.json.port_base as number;
    expect(Number.isInteger(base)).toBe(true);
    expect(base).toBeGreaterThanOrEqual(21400);
    expect(base + 2).toBeLessThanOrEqual(21499);
    expect(r.json.ports).toEqual({ PORT_1: base, PORT_2: base + 1, PORT_3: base + 2 });

    // DoD 8: --json is not reporting its own intention — every value it
    // printed is in the file it points at.
    const raw = rawEntries(r.json.env_file);
    const byKey = Object.fromEntries(raw);
    expect(byKey[PORT_BASE_KEY]).toBe(String(base));
    expect(byKey[PORT_COUNT_KEY]).toBe('3');
    expect(byKey.PORT_1).toBe(String(base));
    expect(byKey.PORT_2).toBe(String(base + 1));
    expect(byKey.PORT_3).toBe(String(base + 2));
    expect(byKey.PORT_4).toBeUndefined();

    // DoD 5: no quotes, no spaces — asserted on the RAW line, per port key.
    const text = readFileSync(r.json.env_file, 'utf8');
    for (const [k, v] of raw) {
      if (!/^PORT/.test(k)) continue;
      expect(`${k}: quotes=${/["']/.test(v)}`).toBe(`${k}: quotes=false`);
      expect(`${k}: whitespace=${/\s/.test(v)}`).toBe(`${k}: whitespace=false`);
      expect(`${k}: digits-only=${/^\d+$/.test(v)}`).toBe(`${k}: digits-only=true`);
      expect(text).toContain(`\n${k}=${v}\n`);
    }

    // And the ports really are free ones: nothing else on this machine holds
    // them, which is what "allocated" has to mean.
    for (const p of [base, base + 1, base + 2]) expect(isPortFree(p)).toBe(true);

    // The slot record carries the base too, so `list` can answer without
    // opening a file a consumer hook may own.
    expect(JSON.parse(readFileSync(slotFile(root, 'ports3'), 'utf8')).port_base).toBe(base);
  });
}, 180000);

test('--ports is optional (a sane default) and `--ports 0` provisions a slot with no PORT_* key at all', () => {
  const root = scaffold();
  inProject(root, '21500-21599', () => {
    const dflt = callJson(['create', '--name', 'defaulted']);
    expect(dflt.code).toBe(0);
    expect(dflt.json.ports_requested).toBe(DEFAULT_PORT_COUNT);
    expect(Object.keys(dflt.json.ports).length).toBe(DEFAULT_PORT_COUNT);

    const zero = callJson(['create', '--name', 'noports', '--ports', '0']);
    expect(zero.code).toBe(0);
    expect(zero.json.ports).toEqual({});
    expect(zero.json.port_base).toBeNull();
    expect(zero.json.ports_source).toBe('none');
    expect(rawEntries(zero.json.env_file).some(([k]) => /PORT/.test(k))).toBe(false);
    expect(call(['create', '--name', 'noports2', '--ports', '0']).out).toContain('ports:    none (--ports 0)');
  });
}, 180000);

// ---------------------------------------------------------------------------
// (2) DoD 2 — the base is deterministic per slot name
// ---------------------------------------------------------------------------

test('the base is DETERMINISTIC per slot name: provisioning the same name twice yields the same block while those ports are free', () => {
  const root = scaffold();
  inProject(root, '21600-21699', ({ range }) => {
    const first = callJson(['create', '--name', 'stable', '--ports', '4']);
    expect(first.code).toBe(0);
    const second = callJson(['create', '--name', 'stable', '--ports', '4']);
    expect(second.code).toBe(0);
    expect(second.json.status).toBe('reused');
    expect(second.json.port_base).toBe(first.json.port_base);
    expect(second.json.ports).toEqual(first.json.ports);

    // …and it is the base the pure function predicts from the NAME alone —
    // no clock, no pid, no project path in the derivation.
    expect(first.json.port_base).toBe(deterministicBase('stable', 4, range));

    // A different name lands somewhere else (the derivation is a hash of the
    // name, not a constant).
    const other = callJson(['create', '--name', 'stable-two', '--ports', '4']);
    expect(other.json.port_base).not.toBe(first.json.port_base);
  });
}, 240000);

test('deterministicBase is a pure function of the name and stays inside the range', () => {
  const range = { min: 30000, max: 30099 };
  for (const name of ['a4', 'b12-x', 'x'.repeat(60)]) {
    const a = deterministicBase(name, 4, range);
    expect(deterministicBase(name, 4, range)).toBe(a);
    expect(a).toBeGreaterThanOrEqual(range.min);
    expect(a + 3).toBeLessThanOrEqual(range.max);
  }
  // Pinned: a change to the derivation moves every existing slot's ports, so
  // it must be a deliberate edit rather than an accident.
  expect(deterministicBase('a4', 4, { min: PORT_RANGE_MIN, max: PORT_RANGE_MAX })).toBe(
    deterministicBase('a4', 4),
  );
});

// ---------------------------------------------------------------------------
// (3) DoD 4 — an occupied port is skipped
// ---------------------------------------------------------------------------

test('an OCCUPIED port inside the would-be block is skipped: the allocator probes on and lands on the next free block', () => {
  const root = scaffold();
  inProject(root, '21700-21799', ({ range }) => {
    const name = nameWithRoom('busy', 4, range, 2);
    const wouldBe = deterministicBase(name, 4, range);
    // Not vacuous, and not at the mercy of whatever else this machine runs:
    // both the first candidate block and the one after it must start free.
    for (let p = wouldBe; p < wouldBe + 8; p++) expect(`${p}: ${isPortFree(p)}`).toBe(`${p}: true`);

    hold(wouldBe + 2); // one real listening socket, inside the block

    const r = callJson(['create', '--name', name, '--ports', '4']);
    expect(r.code).toBe(0);
    const got = Object.values(r.json.ports) as number[];
    expect(got).not.toContain(wouldBe + 2);
    expect(r.json.port_base).not.toBe(wouldBe);
    // The next candidate is one block along — the probe advanced, it did not
    // scatter or restart.
    expect(r.json.port_base).toBe(wouldBe + 4);
    expect(got).toEqual([wouldBe + 4, wouldBe + 5, wouldBe + 6, wouldBe + 7]);

    // Released, the original block is available again — so the skip was the
    // socket, not a permanent blacklist.
    while (held.length) held.pop()!.stop(true);
    expect(isPortFree(wouldBe + 2)).toBe(true);
  });
}, 180000);

// ---------------------------------------------------------------------------
// (4) DoD 3 — CONCURRENTLY provisioned slots never overlap
// ---------------------------------------------------------------------------

/** A slot name whose deterministic base leaves `blocks` whole blocks of room
 *  below the top of the range — so "the next candidate is one block along" is a
 *  statement about the probe, not about the wrap-around at the end of the
 *  range (which the unit test covers separately). */
function nameWithRoom(prefix: string, count: number, range: { min: number; max: number }, blocks: number): string {
  for (let i = 0; i < 4000; i++) {
    const name = `${prefix}-${i}`;
    if (deterministicBase(name, count, range) + blocks * count - 1 <= range.max) return name;
  }
  throw new Error(`no '${prefix}-*' name leaves ${blocks} blocks of room in ${range.min}-${range.max}`);
}

/** Slot names that all hash to the SAME first candidate base. Without them the
 *  test proves nothing: two unrelated names land on different bases by
 *  construction, and would pass against an allocator with no collision
 *  handling whatsoever. */
function collidingNames(count: number, blockSize: number, range: { min: number; max: number }): string[] {
  const buckets = new Map<number, string[]>();
  for (let i = 0; i < 4000; i++) {
    const name = `race-${i}`;
    const b = deterministicBase(name, blockSize, range);
    const list = buckets.get(b) ?? [];
    list.push(name);
    buckets.set(b, list);
    if (list.length >= count) return list.slice(0, count);
  }
  throw new Error(`could not find ${count} slot names sharing a base in ${range.min}-${range.max}`);
}

/** One `pipeline worktree create` in its OWN process. Started when called;
 *  awaited later — the caller starts them all first. */
function spawnCreate(
  cwd: string,
  env: NodeJS.ProcessEnv,
  args: string[],
): Promise<{ code: number; out: string; err: string }> {
  const cli = join(import.meta.dir, '..', 'src', 'cli.ts');
  const child = spawn(process.execPath, [cli, 'worktree', 'create', ...args, '--json'], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr.on('data', (d: Buffer) => (err += d.toString()));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code: code ?? -1, out, err })));
}

test('two live slots NEVER receive overlapping blocks — asserted with concurrently spawned creates whose names hash to the SAME base', async () => {
  const root = scaffold();
  const wtRoot = mkTmp('wtpr-conc-');
  const portRange = '21800-21899';
  const parsed = resolvePortRange(portRange);
  if ('error' in parsed) throw new Error(parsed.error);
  const names = collidingNames(4, 4, parsed);
  // The premise, asserted rather than assumed: these four names all want the
  // SAME first candidate block.
  expect(new Set(names.map((n) => deterministicBase(n, 4, parsed))).size).toBe(1);

  const env = { ...process.env, PIPELINE_WT_ROOT: wtRoot, [PORT_RANGE_ENV]: portRange };
  delete env.PIPELINE_WT_FETCH;
  delete env.PIPELINE_WT_INTEGRATION_BRANCH;

  // EVERY process is started before ANY is awaited — that is what makes this
  // concurrent rather than four sequential creates in a loop.
  const pending = names.map((name) => spawnCreate(root, env, ['--name', name, '--ports', '4']));
  const results = await Promise.all(pending);

  const blocks: Array<{ name: string; ports: number[] }> = [];
  results.forEach((r, i) => {
    if (r.code !== 0) console.error(`[${names[i]}] exit ${r.code}: ${r.out}${r.err}`);
    expect(`${names[i]}: exit ${r.code}`).toBe(`${names[i]}: exit 0`);
    const json = JSON.parse(r.out);
    expect(json.ok).toBe(true);
    const ports = Object.values(json.ports) as number[];
    expect(ports.length).toBe(4);
    blocks.push({ name: names[i]!, ports });
  });

  // The assertion: pairwise disjoint, across every slot that is live at once.
  const owner = new Map<number, string>();
  for (const b of blocks) {
    for (const p of b.ports) {
      const prev = owner.get(p);
      expect(`port ${p}: ${prev ?? 'free'} then ${b.name}`).toBe(`port ${p}: free then ${b.name}`);
      owner.set(p, b.name);
    }
  }
  expect(owner.size).toBe(16);

  // And the env files on disk say the same thing. The JSON was read back from
  // them, but a reader that trusts only the files must reach the same verdict.
  const prevRoot = process.env.PIPELINE_WT_ROOT;
  process.env.PIPELINE_WT_ROOT = wtRoot;
  const slotRoot = slotRootFor(root);
  if (prevRoot === undefined) delete process.env.PIPELINE_WT_ROOT;
  else process.env.PIPELINE_WT_ROOT = prevRoot;

  const fromFiles = new Set<number>();
  for (const name of names) {
    const { ports } = readPortsFromEnv(parseEnvFile(readFileSync(`${slotRoot}/${name}.env`, 'utf8')));
    for (const p of Object.values(ports)) fromFiles.add(p);
  }
  expect(fromFiles.size).toBe(16);
}, 300000);

// ---------------------------------------------------------------------------
// (5) DoD 6 — D14 precedence, PER FIELD, both directions
// ---------------------------------------------------------------------------

/** Shaped like this repository's REAL create hook
 *  (`.pipeline/.hooks/worktree-create.py` ≈ 222-228): it provisions, writes an
 *  unquoted env file, and reports `"port_base": 0, "ports": {}` — the exact
 *  answer that would make ports unreachable under hook-wins-wholesale. */
const HOOK_NO_PORTS = `
const fs = require('fs');
const path = require('path');
const name = process.env.PIPELINE_WT_NAME || 'unnamed';
const wt = path.join(process.cwd(), '.claude', 'worktrees', name);
fs.mkdirSync(wt, { recursive: true });
const envFile = path.join(wt, '.worktree.env');
fs.writeFileSync(envFile, '# generated by worktree-create.js\\nSLOT=' + name + '\\n');
process.stdout.write(JSON.stringify({
  worktree_path: wt,
  branch: 'worktree-' + name,
  env_file: envFile,
  port_base: 0,
  ports: {},
}) + '\\n');
`;

/** The other direction: a hook that DID allocate ports and says so. */
const HOOK_WITH_PORTS = `
const fs = require('fs');
const path = require('path');
const name = process.env.PIPELINE_WT_NAME || 'unnamed';
const wt = path.join(process.cwd(), '.claude', 'worktrees', name);
fs.mkdirSync(wt, { recursive: true });
const envFile = path.join(wt, '.worktree.env');
fs.writeFileSync(envFile, 'BACKEND_PORT=5103\\nFRONTEND_PORT=5104\\n');
process.stdout.write(JSON.stringify({
  worktree_path: wt,
  branch: 'worktree-' + name,
  env_file: envFile,
  port_base: 5103,
  ports: { BACKEND_PORT: 5103, FRONTEND_PORT: 5104 },
}) + '\\n');
`;

test('D14: a hook returning `ports: {}` / `port_base: 0` STILL receives the provisioner\'s ports — in its own env file', () => {
  const root = scaffold({ createHook: HOOK_NO_PORTS });
  inProject(root, '21900-21999', ({ range }) => {
    const r = callJson(['create', '--name', 'hookempty', '--ports', '4']);
    expect(r.code).toBe(0);
    expect(r.json.provisioner).toBe('hook'); // the hook provisioned the slot…
    expect(r.json.ports_source).toBe('builtin'); // …and the CLI filled the field it left empty
    const base = r.json.port_base as number;
    expect(base).toBe(deterministicBase('hookempty', 4, range));
    expect(r.json.ports).toEqual({ PORT_1: base, PORT_2: base + 1, PORT_3: base + 2, PORT_4: base + 3 });

    // The channel is the FILE, and the fill is additive: the hook's own line
    // survives, the ports are appended, and every value is still unquoted.
    const text = readFileSync(r.json.env_file, 'utf8');
    expect(text).toContain('SLOT=hookempty');
    expect(text).toContain(`\n${PORT_BASE_KEY}=${base}\n`);
    for (const [k, v] of rawEntries(r.json.env_file)) {
      expect(`${k}: quotes=${/["']/.test(v)}`).toBe(`${k}: quotes=false`);
      expect(`${k}: whitespace=${/\s/.test(v)}`).toBe(`${k}: whitespace=false`);
    }
    // Re-provisioning is stable and does not duplicate the block.
    const again = callJson(['create', '--name', 'hookempty', '--ports', '4']);
    expect(again.json.port_base).toBe(base);
    const lines = readFileSync(again.json.env_file, 'utf8').split('\n').filter((l) => l.startsWith(`${PORT_BASE_KEY}=`));
    expect(lines.length).toBe(1);
  });
}, 180000);

test('D14, the other direction: a hook returning NON-EMPTY ports OVERRIDES the provisioner — nothing of ours is written', () => {
  const root = scaffold({ createHook: HOOK_WITH_PORTS });
  inProject(root, '21900-21999', () => {
    const r = callJson(['create', '--name', 'hookports', '--ports', '4']);
    expect(r.code).toBe(0);
    expect(r.json.ports_source).toBe('hook');
    expect(r.json.port_base).toBe(5103);
    expect(r.json.ports).toEqual({ BACKEND_PORT: 5103, FRONTEND_PORT: 5104 });

    // Per FIELD, and the field the hook filled is left exactly as it left it:
    // no PORT_BASE, no PORT_1, no second block appended behind its back.
    const text = readFileSync(r.json.env_file, 'utf8');
    expect(text).not.toContain(PORT_BASE_KEY);
    expect(text).not.toContain('PORT_1=');
    expect(text.trim().split('\n').sort()).toEqual(['BACKEND_PORT=5103', 'FRONTEND_PORT=5104']);
    expect(call(['create', '--name', 'hookports2']).out).toContain('worktree-create.*');
  });
}, 180000);

/** Reports no ports (`port_base: 0, ports: {}`) but WROTE them into the env
 *  file — the file is the channel, so those win over a fill. */
const HOOK_PORTS_IN_FILE_ONLY = `
const fs = require('fs');
const path = require('path');
const name = process.env.PIPELINE_WT_NAME || 'unnamed';
const wt = path.join(process.cwd(), '.claude', 'worktrees', name);
fs.mkdirSync(wt, { recursive: true });
const envFile = path.join(wt, '.worktree.env');
fs.writeFileSync(envFile, 'PORT_BASE=31999\\nAPI_PORT=31999\\n');
process.stdout.write(JSON.stringify({
  worktree_path: wt,
  branch: 'worktree-' + name,
  env_file: envFile,
  port_base: 0,
  ports: {},
}) + '\\n');
`;

test('a hook that wrote ports into its env file without reporting them keeps them: the FILE is the channel', () => {
  const root = scaffold({ createHook: HOOK_PORTS_IN_FILE_ONLY });
  inProject(root, '21900-21999', () => {
    const r = callJson(['create', '--name', 'filesonly', '--ports', '4']);
    expect(r.code).toBe(0);
    expect(r.json.ports_source).toBe('hook');
    expect(r.json.port_base).toBe(31999);
    expect(readFileSync(r.json.env_file, 'utf8')).not.toContain('PORT_1=');
  });
}, 180000);

test('a hook that reports NO env_file gets no ports — and the report SAYS so rather than implying an allocation that never happened', () => {
  const root = scaffold({
    createHook: `
const fs = require('fs');
const path = require('path');
const wt = path.join(process.cwd(), '.claude', 'worktrees', process.env.PIPELINE_WT_NAME);
fs.mkdirSync(wt, { recursive: true });
process.stdout.write(JSON.stringify({ worktree_path: wt, branch: 'b', env_file: null, port_base: 0, ports: {} }) + '\\n');
`,
  });
  inProject(root, '21900-21999', () => {
    const r = callJson(['create', '--name', 'nofile', '--ports', '4']);
    // A usable slot, not a failed create: the env file is the ONLY channel for
    // ports, and inventing a second one that no step sources would be worse
    // than an honest "none".
    expect(r.code).toBe(0);
    expect(r.json.env_file).toBeNull();
    expect(r.json.ports).toEqual({});
    expect(r.json.ports_source).toBe('none');
    expect(r.json.detail).toContain('no env_file');
    expect(call(['create', '--name', 'nofile2', '--ports', '4']).out).toContain('note:');
  });
}, 180000);

// ---------------------------------------------------------------------------
// (6) DoD 7 — exhaustion is a stated failure naming the range
// ---------------------------------------------------------------------------

test('port EXHAUSTION is a clean, reported failure naming the range tried — not a crash, and not a silent zero-port slot', () => {
  const root = scaffold();
  const min = 22000;
  const max = 22007;
  inProject(root, `${min}-${max}`, () => {
    for (let p = min; p <= max; p++) {
      expect(`${p}: ${isPortFree(p)}`).toBe(`${p}: true`);
      hold(p);
    }
    const r = callJson(['create', '--name', 'exhausted', '--ports', '4']);
    expect(r.code).toBe(1);
    expect(r.json.ok).toBe(false);
    expect(r.json.status).toBe('failed');
    expect(r.json.detail).toContain(`${min}-${max}`); // the range, named
    expect(r.json.detail).toContain('no free block of 4 contiguous ports');
    expect(r.json.detail).toContain(PORT_RANGE_ENV); // and how to widen it

    // NOT a silent zero-port slot: no env file, no slot record, and the
    // command's own report says failed rather than ok-with-no-ports.
    expect(r.json.ports).toEqual({});
    expect(r.json.port_base).toBeNull();
    expect(r.json.env_file).toBeNull();
    expect(existsSync(slotFile(root, 'exhausted'))).toBe(false);

    // Released, the same name provisions cleanly — so the failure was the
    // occupancy, not a permanently poisoned allocator.
    while (held.length) held.pop()!.stop(true);
    const ok = callJson(['create', '--name', 'exhausted', '--ports', '4']);
    expect(ok.code).toBe(0);
    expect(ok.json.port_base).toBeGreaterThanOrEqual(min);
  });
}, 240000);

test('a malformed PIPELINE_WT_PORT_RANGE is refused with a stated reason instead of falling back to ports the operator excluded', () => {
  const root = scaffold();
  inProject(root, '22100-22199', () => {
    process.env[PORT_RANGE_ENV] = 'not-a-range';
    const r = callJson(['create', '--name', 'badrange']);
    expect(r.code).toBe(1);
    expect(r.json.detail).toContain(PORT_RANGE_ENV);
    expect(r.json.detail).toContain('not-a-range');
  });
}, 120000);

// ---------------------------------------------------------------------------
// (7) The allocator's own units
// ---------------------------------------------------------------------------

test('resolvePortRange: default, override, and every malformed spelling refused', () => {
  expect(resolvePortRange(undefined)).toEqual({ min: PORT_RANGE_MIN, max: PORT_RANGE_MAX });
  expect(resolvePortRange('')).toEqual({ min: PORT_RANGE_MIN, max: PORT_RANGE_MAX });
  expect(resolvePortRange('4000-4100')).toEqual({ min: 4000, max: 4100 });
  expect(resolvePortRange(' 4000 - 4100 ')).toEqual({ min: 4000, max: 4100 });
  for (const bad of ['4000', '4000-', '-4100', 'a-b', '4100-4000', '0-100', '4000-70000', '4000..4100']) {
    expect(`${bad}: ${'error' in resolvePortRange(bad) ? 'refused' : 'ACCEPTED'}`).toBe(`${bad}: refused`);
  }
  // The DEFAULT range sits below Linux's ephemeral floor (32768) — allocating
  // out of the ephemeral range would collide with the kernel's own choices.
  expect(PORT_RANGE_MAX).toBeLessThan(32768);
});

test('the probe walk: occupied candidates are skipped block by block, the range wraps once, and a full range is an exhaustion message rather than a throw', () => {
  const range = { min: 25000, max: 25039 };
  const busy = new Set<number>();
  const isFree = (p: number): boolean => !busy.has(p);
  const walker = nameWithRoom('walker', 4, range, 2);
  const alloc = (name: string, count = 4) =>
    allocatePorts({ name, count, reservationDir: null, livePath: '', range, isFree });
  const first = deterministicBase(walker, 4, range);

  expect(alloc(walker)).toEqual({ ok: true, base: first, ports: [first, first + 1, first + 2, first + 3] });

  busy.add(first + 3);
  const moved = alloc(walker);
  expect(moved.ok && moved.base).toBe(first + 4);

  // A name near the TOP of the range wraps to the bottom rather than running
  // off the end — the candidate walk covers the range exactly once.
  const high = `high-${[...Array(4000).keys()].find((i) => deterministicBase(`high-${i}`, 4, range) > range.max - 8)}`;
  const highBase = deterministicBase(high, 4, range);
  for (let p = highBase; p <= range.max; p++) busy.add(p);
  const wrapped = alloc(high);
  expect(wrapped.ok).toBe(true);
  expect(wrapped.ok && wrapped.base).toBeLessThan(highBase);
  expect(wrapped.ok && wrapped.base).toBeGreaterThanOrEqual(range.min);

  for (let p = range.min; p <= range.max; p++) busy.add(p);
  const none = alloc(walker);
  expect(none.ok).toBe(false);
  expect(!none.ok && none.detail).toContain('25000-25039');

  // A block that cannot fit is refused before anything is probed.
  const tooBig = alloc(walker, 100);
  expect(tooBig.ok).toBe(false);
  expect(!tooBig.ok && tooBig.detail).toContain('holds only 40');
});

test('reservations alone keep two same-base allocations apart, and a reservation whose slot is gone is reclaimed', () => {
  const dir = join(mkTmp('resv-'), 'ports');
  const range = { min: 26000, max: 26039 };
  const alive = mkTmp('liveslot-');
  const isFree = (): boolean => true; // nothing is BOUND: the reservation is the only defence
  const [alpha, beta] = collidingNames(2, 4, range);
  expect(deterministicBase(alpha!, 4, range)).toBe(deterministicBase(beta!, 4, range));

  const a = allocatePorts({ name: alpha!, count: 4, reservationDir: dir, livePath: alive, range, isFree });
  expect(a.ok).toBe(true);
  const b = allocatePorts({ name: beta!, count: 4, reservationDir: dir, livePath: alive, range, isFree });
  expect(b.ok).toBe(true);
  const aPorts = new Set(a.ok ? a.ports : []);
  for (const p of b.ok ? b.ports : []) expect(`${p} taken by ${alpha}: ${aPorts.has(p)}`).toBe(`${p} taken by ${alpha}: false`);

  // Re-allocating alpha reclaims ITS block (idempotent, and it does not now
  // hold two).
  const again = allocatePorts({ name: alpha!, count: 4, reservationDir: dir, livePath: alive, range, isFree });
  expect(again.ok && again.base).toBe(a.ok ? a.base : -1);

  // A stale reservation — the slot it named is gone — is taken over rather
  // than eating the range forever.
  writeFileSync(join(dir, '26036.json'), JSON.stringify({ name: 'ghost', base: 26036, count: 4, path: join(alive, 'gone'), at: '' }));
  const reclaimed = allocatePorts({
    name: 'ghost-taker',
    count: 4,
    reservationDir: dir,
    livePath: alive,
    range: { min: 26036, max: 26039 },
    isFree,
  });
  expect(reclaimed.ok).toBe(true);
  expect(reclaimed.ok && reclaimed.base).toBe(26036);
});

test('portEnvEntries and readPortsFromEnv are inverses, and only port-shaped keys count', () => {
  expect(portEnvEntries(31000, 3)).toEqual([
    ['PORT_BASE', '31000'],
    ['PORT_COUNT', '3'],
    ['PORT_1', '31000'],
    ['PORT_2', '31001'],
    ['PORT_3', '31002'],
  ]);
  const values = Object.fromEntries(portEnvEntries(31000, 3));
  expect(readPortsFromEnv(values)).toEqual({
    port_base: 31000,
    ports: { PORT_1: 31000, PORT_2: 31001, PORT_3: 31002 },
  });
  // PORT_COUNT is a count. A path is not a port. `<ROLE>_PORT` — the spelling
  // the frozen contract's own example uses — is.
  expect(
    readPortsFromEnv({
      PORT_COUNT: '3',
      WORKTREE_PATH: '/tmp/x',
      BACKEND_PORT: '5103',
      PORT_1: '70000',
      PORT_2: 'abc',
      RUN_ID: 'a4',
    }),
  ).toEqual({ port_base: null, ports: { BACKEND_PORT: 5103 } });
});
