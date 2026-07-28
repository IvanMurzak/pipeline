// Tests for `pipeline department status` / `stop` / `retire`
// (src/commands/department.ts + src/lib/department-serve.ts —
// simplified-onboarding task a10).
//
// Organized around a10's Definition of Done:
//  1. `status` works with the network down.
//  2. `stop` then `serve` restores service without re-registering or
//     re-approving.
//  3. `retire` refuses without `--yes` when non-interactive, and reports
//     what it failed.
//  4. A stale-digest machine is flagged.
//  5. The budget line matches what the API reports verbatim — no
//     client-side arithmetic.
//
// Every side effect is injected: no network, no browser, no `pipeline-runner`
// binary, no real credential store is touched by any test in this file.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runDepartmentRetire,
  runDepartmentServe,
  runDepartmentStatus,
  runDepartmentStop,
  type ServeCommandDeps,
  type StatusCommandDeps,
} from '../src/commands/department';
import type { ServeHttpInit, ServeHttpResponse } from '../src/lib/department-serve';
import { credentialFilePath, type CloudFs } from '../src/lib/cloud-config';
import { departmentIndexPath, resolveRunnerJournalRoot } from '../src/lib/department-journal';
import type { ShellResult } from '../src/lib/runner-enrol';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const created: string[] = [];

afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

const SERVER = 'https://api.example.dev';
const ORG = 'acme';
const ORG_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '55555555-5555-4555-8555-555555555555';
const DEPT_ID = '22222222-2222-4222-8222-222222222222';
const RUNNER_ID = '33333333-3333-4333-8333-333333333333';
const INSTALL_ID = '44444444-4444-4444-8444-444444444444';
const DIGEST = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OLD_DIGEST = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const PIPELINE_MANIFEST = `# Review\n\n## End State\nA reviewed Unity project.\n\n## Scope\n- In: Unity architecture review\n- Out: shipping the fix\n`;

function departmentYaml(): string {
  return (
    'apiVersion: department.ai-pipeline.dev/v1\n' +
    'name: unity-review\n' +
    'description: >-\n' +
    '  Reviews Unity and C# architecture, identifies risks, and produces actionable\n' +
    '  refactoring plans.\n' +
    'visibility: organization\n' +
    '\n' +
    'skills:\n' +
    '  - id: unity-architecture-review\n' +
    '    name: Unity Architecture Review\n' +
    '    description: Review a Unity project or design proposal for architectural risk.\n' +
    '\n' +
    'runtime:\n' +
    '  engine: pipeline\n' +
    '  pipelineRoot: .claude/pipeline/review\n' +
    '  startIteration: steps/01-plan.md\n'
  );
}

/** A department project folder exactly as `git clone` would leave it. */
function departmentProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dept-status-'));
  created.push(dir);
  const pipelineRoot = join(dir, '.claude', 'pipeline', 'review');
  mkdirSync(join(pipelineRoot, 'steps'), { recursive: true });
  writeFileSync(join(pipelineRoot, 'PIPELINE.md'), PIPELINE_MANIFEST);
  writeFileSync(join(pipelineRoot, 'steps', '01-plan.md'), '# Plan\n');
  writeFileSync(join(dir, 'department.yml'), departmentYaml());
  return dir;
}

function reply(status: number, body: unknown): ServeHttpResponse {
  return { status, json: async () => body };
}

// ---------------------------------------------------------------------------
// `stop` — entirely local, no network
// ---------------------------------------------------------------------------

interface ShellScript {
  /** `pipeline-runner bindings --json` answer. `null` -> the store is empty
   *  (`departments: {}`); a string -> the raw stdout (for malformed-output
   *  tests). */
  bindingsFor?: (dir: string) => Record<string, unknown> | null;
  bindingsRawStdout?: string;
  bindingsCliMissing?: boolean;
  unbindCode?: number;
  unbindStdout?: string;
  unbindStderr?: string;
}

function stopShell(sh: ShellScript, calls: { cmd: string; args: string[] }[]) {
  return (cmd: string, args: string[]): ShellResult => {
    calls.push({ cmd, args });
    if (cmd === 'pipeline-runner' && args[0] === 'bindings') {
      if (sh.bindingsCliMissing) return { code: 127, stdout: '', stderr: '' };
      if (sh.bindingsRawStdout !== undefined) return { code: 0, stdout: sh.bindingsRawStdout, stderr: '' };
      return {
        code: 0,
        stdout: JSON.stringify({ path: '/fake/departments.json', source: 'file', refusal: null, departments: {} }),
        stderr: '',
      };
    }
    if (cmd === 'pipeline-runner' && args[0] === 'unbind') {
      return { code: sh.unbindCode ?? 0, stdout: sh.unbindStdout ?? '[pipeline-runner] unbound … \n', stderr: sh.unbindStderr ?? '' };
    }
    throw new Error(`unexpected shell call in stop test: ${cmd} ${args.join(' ')}`);
  };
}

function bindingsJsonFor(dir: string, id: string): string {
  return JSON.stringify({
    path: '/fake/departments.json',
    source: 'file',
    refusal: null,
    departments: { [id]: { adapterId: 'pipeline-drive', command: 'pipeline', cwd: dir } },
  });
}

describe('stop — DoD box: entirely local, works with the network down', () => {
  test('not bound on this machine -> idempotent no-op, exit 0, no unbind call', () => {
    const dir = departmentProject();
    const calls: { cmd: string; args: string[] }[] = [];
    let out = '';
    const deps = {
      shell: stopShell({}, calls),
      fetch: async () => {
        throw new Error('stop must never touch the network');
      },
      out: (s: string) => (out += s),
      err: (s: string) => (out += s),
      env: {},
      cwd: dir,
      hostname: () => 'box',
      authenticate: async () => {
        throw new Error('stop must never authenticate');
      },
    } satisfies ServeCommandDeps;

    const code = runDepartmentStop([], deps);
    expect(code).toBe(0);
    expect(out).toContain('nothing to stop');
    expect(calls.some((c) => c.args[0] === 'unbind')).toBe(false);
  });

  test('bound on this machine -> unbinds, reports stopped, registration untouched', () => {
    const dir = departmentProject();
    const calls: { cmd: string; args: string[] }[] = [];
    let out = '';
    const sh: ShellScript = {
      bindingsFor: () => null,
      bindingsRawStdout: bindingsJsonFor(dir, DEPT_ID),
    };
    const deps = {
      shell: stopShell(sh, calls),
      fetch: async () => {
        throw new Error('stop must never touch the network');
      },
      out: (s: string) => (out += s),
      err: (s: string) => (out += s),
      env: {},
      cwd: dir,
      hostname: () => 'box',
      authenticate: async () => {
        throw new Error('stop must never authenticate');
      },
    } satisfies ServeCommandDeps;

    const code = runDepartmentStop([], deps);
    expect(code).toBe(0);
    expect(out).toContain('stopped on this machine');
    expect(out).toContain('In-flight tasks finish on their own');
    expect(out).toContain('brings it straight back');
    const unbindCall = calls.find((c) => c.args[0] === 'unbind');
    expect(unbindCall?.args).toEqual(['unbind', '--department', DEPT_ID]);
  });

  test('binding store refused (07 §8) -> exit 1, refusal surfaced', () => {
    const dir = departmentProject();
    const calls: { cmd: string; args: string[] }[] = [];
    let err = '';
    const deps = {
      shell: (cmd: string, args: string[]): ShellResult => {
        calls.push({ cmd, args });
        if (args[0] === 'bindings') {
          return {
            code: 1,
            stdout: JSON.stringify({ path: '/fake/departments.json', source: 'file', refusal: 'world-writable', departments: {} }),
            stderr: '',
          };
        }
        throw new Error('unexpected');
      },
      fetch: async () => {
        throw new Error('unused');
      },
      out: () => {},
      err: (s: string) => (err += s),
      env: {},
      cwd: dir,
      hostname: () => 'box',
      authenticate: async () => {
        throw new Error('unused');
      },
    } satisfies ServeCommandDeps;

    const code = runDepartmentStop([], deps);
    expect(code).toBe(1);
    expect(err).toContain('world-writable');
  });

  test('--json shape (progress on stderr, one JSON object on stdout)', () => {
    const dir = departmentProject();
    let out = '';
    let err = '';
    const deps = {
      shell: stopShell({ bindingsRawStdout: bindingsJsonFor(dir, DEPT_ID) }, []),
      fetch: async () => {
        throw new Error('unused');
      },
      out: (s: string) => (out += s),
      err: (s: string) => (err += s),
      env: {},
      cwd: dir,
      hostname: () => 'box',
      authenticate: async () => {
        throw new Error('unused');
      },
    } satisfies ServeCommandDeps;

    const code = runDepartmentStop(['--json'], deps);
    expect(code).toBe(0);
    expect(err).toContain('stopped on this machine');
    const parsed = JSON.parse(out) as { ok: boolean; stopped: boolean; departmentId: string };
    expect(parsed).toEqual({ ok: true, stopped: true, slug: 'unity-review', departmentId: DEPT_ID });
  });
});

// ---------------------------------------------------------------------------
// `stop` then `serve` — DoD box 2
// ---------------------------------------------------------------------------

describe('stop -> serve — DoD box 2: restores service without re-registering or re-approving', () => {
  test('a re-serve after stop is a pure no-op register + unchanged claim', async () => {
    const dir = departmentProject();
    const bindings = new Map<string, Record<string, unknown>>();
    bindings.set(DEPT_ID, { adapterId: 'pipeline-drive', command: 'pipeline', cwd: dir });

    const shell = (cmd: string, args: string[]): ShellResult => {
      if (cmd === 'pipeline-runner' && args[0] === '--version') return { code: 0, stdout: '0.9.0\n', stderr: '' };
      if (cmd === 'pipeline-runner' && args[0] === 'bindings') {
        return {
          code: 0,
          stdout: JSON.stringify({ path: '/fake', source: 'file', refusal: null, departments: Object.fromEntries(bindings) }),
          stderr: '',
        };
      }
      if (cmd === 'pipeline-runner' && args[0] === 'unbind') {
        bindings.delete(String(args[2]));
        return { code: 0, stdout: '[pipeline-runner] unbound\n', stderr: '' };
      }
      if (cmd === 'pipeline-runner' && args[0] === 'bind') {
        bindings.set(DEPT_ID, { adapterId: 'pipeline-drive', command: 'pipeline', cwd: dir });
        return { code: 0, stdout: '[pipeline-runner] bound\n', stderr: '' };
      }
      if (cmd === 'pipeline-runner' && args[0] === 'service' && args[1] === 'status') {
        return { code: 0, stdout: '[pipeline-runner] pipeline-runner.service: running (enabled)\n', stderr: '' };
      }
      if (cmd === 'pipeline-runner' && args[0] === 'status') {
        return { code: 0, stdout: JSON.stringify({ base_url: SERVER, runner_id: RUNNER_ID }), stderr: '' };
      }
      throw new Error(`unexpected shell: ${cmd} ${args.join(' ')}`);
    };

    let installClaimCount = 0;
    const fetch = async (url: string, init: ServeHttpInit): Promise<ServeHttpResponse> => {
      if (url.endsWith('/api/v1/departments') && init.method === 'GET') {
        return reply(200, { departments: [{ id: DEPT_ID, slug: 'unity-review', manifestDigest: DIGEST, enabled: true, retired: false }] });
      }
      if (url.includes('/installs') && init.method === 'POST') {
        installClaimCount++;
        // Idempotent re-serve: same digest as before -> `changed: false`,
        // never re-arming approval.
        return reply(200, { install: { id: INSTALL_ID, pendingApproval: false }, changed: false, auto_approved: false, approval_policy: 'auto-admin' });
      }
      // x13: `serve` now CONFIRMS the claim it prints — the department's own
      // profile is the one authority for `online`, and this world's supervisor
      // reports `running`, so the re-serve legitimately comes back live.
      if (url.endsWith(`/api/v1/departments/${DEPT_ID}`) && init.method === 'GET') {
        return reply(200, {
          department: { id: DEPT_ID, slug: 'unity-review', enabled: true, retired: false, online: true, manifestDigest: DIGEST },
        });
      }
      throw new Error(`unexpected fetch: ${init.method} ${url}`);
    };

    const serveDeps = {
      fetch,
      shell,
      out: () => {},
      err: () => {},
      env: {},
      cwd: dir,
      hostname: () => 'unity-box',
      authenticate: async () => ({
        server: SERVER,
        accessToken: 'tok',
        orgSlug: ORG,
        orgId: ORG_ID,
        credentialPath: '/nowhere',
        now: 1_700_000_000_000,
      }),
    } satisfies ServeCommandDeps;

    // department.yml's own digest must equal DIGEST for "unchanged" to fire —
    // compute it for real rather than guessing, by running serve once first
    // to observe the digest the CLI actually derives, then reuse it.
    const { buildRegistrationRequest, readDepartmentManifest } = await import('../src/lib/department-manifest');
    const { readFileSync } = await import('node:fs');
    const parsed = readDepartmentManifest(join(dir, 'department.yml'), { readFile: (p) => readFileSync(p, 'utf-8') });
    const realDigest = buildRegistrationRequest(parsed.manifest!).manifest_digest;
    fetch as unknown; // keep TS happy about closures below capturing realDigest
    const fetchWithRealDigest = async (url: string, init: ServeHttpInit): Promise<ServeHttpResponse> => {
      if (url.endsWith('/api/v1/departments') && init.method === 'GET') {
        return reply(200, { departments: [{ id: DEPT_ID, slug: 'unity-review', manifestDigest: realDigest, enabled: true, retired: false }] });
      }
      return fetch(url, init);
    };
    serveDeps.fetch = fetchWithRealDigest;

    // 1) stop.
    const stopCode = runDepartmentStop([], serveDeps);
    expect(stopCode).toBe(0);
    expect(bindings.has(DEPT_ID)).toBe(false);

    // 2) serve again.
    const serveCode = await runDepartmentServe([], serveDeps);
    expect(serveCode).toBe(0);
    expect(bindings.has(DEPT_ID)).toBe(true);
    // The claim was called (bringing it back online) but reported UNCHANGED —
    // no re-registration (list found it already, no POST/PATCH happened) and
    // the claim response carries `changed: false` — never a re-arm.
    expect(installClaimCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// `retire` — DoD box 3
// ---------------------------------------------------------------------------

function retireDeps(overrides: Partial<ServeCommandDeps> & { isInteractive?: () => boolean; confirm?: (m: string) => Promise<boolean> } = {}) {
  const calls: { cmd: string; args: string[] }[] = [];
  const fetches: { url: string; init: ServeHttpInit }[] = [];
  let out = '';
  let err = '';
  const deps: ServeCommandDeps = {
    shell: (cmd, args) => {
      calls.push({ cmd, args });
      if (args[0] === 'bindings') {
        return { code: 0, stdout: JSON.stringify({ path: '/fake', source: 'file', refusal: null, departments: {} }), stderr: '' };
      }
      if (args[0] === 'unbind') return { code: 0, stdout: 'unbound\n', stderr: '' };
      return { code: 1, stdout: '', stderr: 'unexpected shell call' };
    },
    fetch: async (url, init) => {
      fetches.push({ url, init });
      if (url.endsWith('/api/v1/departments') && init.method === 'GET') {
        return reply(200, { departments: [{ id: DEPT_ID, slug: 'unity-review', manifestDigest: DIGEST, enabled: true, retired: false }] });
      }
      if (url.endsWith(`/api/v1/departments/${DEPT_ID}`) && init.method === 'DELETE') {
        return reply(200, { department: { id: DEPT_ID, slug: 'unity-review', manifestDigest: DIGEST, enabled: false, retired: true }, failed_task_count: 2 });
      }
      throw new Error(`unexpected fetch: ${init.method} ${url}`);
    },
    out: (s) => (out += s),
    err: (s) => (err += s),
    env: {},
    cwd: '.',
    hostname: () => 'box',
    authenticate: async () => ({
      server: SERVER,
      accessToken: 'tok',
      orgSlug: ORG,
      orgId: ORG_ID,
      userEmail: 'ivan@example.dev',
      credentialPath: '/nowhere',
      now: 1_700_000_000_000,
    }),
    ...overrides,
  };
  return { deps, calls, fetches, out: () => out, err: () => err };
}

describe('retire — DoD box 3: refuses without --yes when non-interactive', () => {
  test('non-interactive, no --yes -> refuses, exit 1, never authenticates', async () => {
    const dir = departmentProject();
    const w = retireDeps({ cwd: dir, isInteractive: () => false, authenticate: async () => { throw new Error('must not authenticate'); } });
    const code = await runDepartmentRetire([], w.deps);
    expect(code).toBe(1);
    expect(w.err()).toContain('refusing to retire');
    expect(w.err()).toContain('--yes');
    expect(w.fetches.length).toBe(0);
  });

  test('--json without --yes -> refuses even if a TTY is present (D27)', async () => {
    const dir = departmentProject();
    const w = retireDeps({ cwd: dir, isInteractive: () => true, authenticate: async () => { throw new Error('must not authenticate'); } });
    const code = await runDepartmentRetire(['--json'], w.deps);
    expect(code).toBe(1);
    expect(w.fetches.length).toBe(0);
  });

  test('--yes -> proceeds without prompting, reports failed_task_count', async () => {
    const dir = departmentProject();
    const w = retireDeps({ cwd: dir });
    const code = await runDepartmentRetire(['--yes'], w.deps);
    expect(code).toBe(0);
    expect(w.out()).toContain('Retired unity-review');
    expect(w.out()).toContain('2 open tasks failed with reason "department retired"');
    const del = w.fetches.find((f) => f.init.method === 'DELETE');
    expect(del?.url).toBe(`${SERVER}/api/v1/departments/${DEPT_ID}`);
  });

  test('interactive confirm accepted -> proceeds', async () => {
    const dir = departmentProject();
    const w = retireDeps({ cwd: dir, isInteractive: () => true, confirm: async () => true });
    const code = await runDepartmentRetire([], w.deps);
    expect(code).toBe(0);
    expect(w.fetches.some((f) => f.init.method === 'DELETE')).toBe(true);
  });

  test('interactive confirm declined -> aborts, nothing retired', async () => {
    const dir = departmentProject();
    const w = retireDeps({ cwd: dir, isInteractive: () => true, confirm: async () => false });
    const code = await runDepartmentRetire([], w.deps);
    expect(code).toBe(1);
    expect(w.out()).toContain('Aborted');
    expect(w.fetches.length).toBe(0);
  });

  test('403 -> names the owner-role requirement', async () => {
    const dir = departmentProject();
    const w = retireDeps({
      cwd: dir,
      fetch: async (url, init) => {
        if (url.endsWith('/api/v1/departments') && init.method === 'GET') {
          return reply(200, { departments: [{ id: DEPT_ID, slug: 'unity-review', manifestDigest: DIGEST, enabled: true, retired: false }] });
        }
        if (init.method === 'DELETE') return reply(403, { error: 'forbidden' });
        throw new Error('unexpected');
      },
    });
    const code = await runDepartmentRetire(['--yes'], w.deps);
    expect(code).toBe(1);
    expect(w.err()).toContain('owner role');
  });

  test('department not resolvable (not bound here, not in the cloud list) -> clear failure, no DELETE attempted', async () => {
    const dir = departmentProject();
    const w = retireDeps({
      cwd: dir,
      fetch: async (url, init) => {
        if (url.endsWith('/api/v1/departments') && init.method === 'GET') return reply(200, { departments: [] });
        throw new Error('unexpected');
      },
    });
    const code = await runDepartmentRetire(['--yes'], w.deps);
    expect(code).toBe(1);
    expect(w.err()).toContain('never been served, or was retired');
    expect(w.fetches.some((f) => f.init.method === 'DELETE')).toBe(false);
  });

  test('best-effort local unbind happens before the cloud DELETE when this machine is bound', async () => {
    const dir = departmentProject();
    const calls: { cmd: string; args: string[] }[] = [];
    const w = retireDeps({
      cwd: dir,
      shell: (cmd, args) => {
        calls.push({ cmd, args });
        if (args[0] === 'bindings') {
          return {
            code: 0,
            stdout: JSON.stringify({ path: '/fake', source: 'file', refusal: null, departments: { [DEPT_ID]: { adapterId: 'pipeline-drive', command: 'pipeline', cwd: dir } } }),
            stderr: '',
          };
        }
        if (args[0] === 'unbind') return { code: 0, stdout: 'unbound\n', stderr: '' };
        return { code: 1, stdout: '', stderr: 'unexpected' };
      },
    });
    const code = await runDepartmentRetire(['--yes'], w.deps);
    expect(code).toBe(0);
    expect(calls.some((c) => c.args[0] === 'unbind' && c.args[2] === DEPT_ID)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// `status` — DoD boxes 1, 4, 5
// ---------------------------------------------------------------------------

function fakeCloudFs(initial: Record<string, string> = {}, unreadable: ReadonlySet<string> = new Set()): CloudFs {
  const files = new Map<string, string>(Object.entries(initial));
  return {
    existsSync: (p) => files.has(p),
    readFileSync: (p) => {
      if (unreadable.has(p)) throw Object.assign(new Error(`EACCES: ${p}`), { code: 'EACCES' });
      const v = files.get(p);
      if (v === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      return v;
    },
    writeFileSync: (p, data) => {
      files.set(p, data);
    },
    mkdirSync: () => {},
    chmodSync: () => {},
    renameSync: (o, n) => {
      const v = files.get(o);
      if (v !== undefined) {
        files.set(n, v);
        files.delete(o);
      }
    },
    unlinkSync: (p) => {
      files.delete(p);
    },
  };
}

const CRED_HOME = '/fake-cred-home';
// Computed the SAME way `credentialFilePath` does (`node:path`'s `join`,
// which is platform-separator-sensitive on Windows) rather than hand-built,
// so the fake filesystem's key matches whatever the real function resolves.
const CRED_PATH = credentialFilePath({ platform: 'linux', env: { PIPELINE_CLOUD_HOME: CRED_HOME }, homedir: CRED_HOME });

// x19: pipeline-runner's per-department execution index, computed exactly the
// way the command computes it (the shipped helpers, not a hand-built string),
// so the fake filesystem's key matches whatever those functions resolve.
const RUNNER_HOME = '/fake-runner-home';
const RUNNER_ENV = { PIPELINE_RUNNER_HOME: RUNNER_HOME };
const JOURNAL_INDEX = departmentIndexPath(resolveRunnerJournalRoot(RUNNER_ENV, 'linux')!, DEPT_ID);

const TASK_1 = '8f3c2a1b-0000-0000-0000-000000000001';
const TASK_2 = '9d11e4f2-0000-0000-0000-000000000002';

/** One `department.execution_started` line, byte-shaped like pipeline-runner's
 *  `buildDepartmentIndexEntry` (b4). `undefined` field -> the default value;
 *  `null` -> the writer's own "recorded, but nothing to state". */
function indexLine(o: { taskId: string; sender?: string | null; engine?: string | null; runId?: string }): string {
  return JSON.stringify({
    schema: 1,
    ts: '2026-07-27T14:00:00.000Z',
    type: 'department.execution_started',
    department_id: DEPT_ID,
    run_id: o.runId ?? `dexec-${o.taskId}`,
    task_id: o.taskId,
    context_id: 'ctx-1',
    engine: o.engine === undefined ? 'claude-code' : o.engine,
    sender: o.sender === undefined ? 'ivan@acme.dev' : o.sender,
    journal_path: `/fake-runner-home/data/department/${o.runId ?? 'dexec'}/events.jsonl`,
  });
}

interface StatusWorldOpts {
  cwd: string;
  /** When set, seeds a live (never-expiring) stored credential. */
  signedIn?: boolean;
  bindingsDeptId?: string | null;
  fetchOverride?: (url: string, init: ServeHttpInit) => Promise<ServeHttpResponse> | ServeHttpResponse;
  /** x19: the contents of this department's execution index. Undefined -> no
   *  index file at all (the ordinary "no runner ever ran here" state). */
  journal?: string;
  /** x19: the index exists but the OS refuses the read (permissions). */
  journalUnreadable?: boolean;
  /** x19: no `PIPELINE_RUNNER_HOME` and no HOME/XDG — the data directory
   *  cannot be computed from the environment at all. */
  noRunnerHome?: boolean;
}

function makeStatusWorld(opts: StatusWorldOpts) {
  let out = '';
  let sleeps = 0;
  const fetchCalls: string[] = [];

  const defaultFetch = async (url: string, init: ServeHttpInit): Promise<ServeHttpResponse> => {
    fetchCalls.push(`${init.method} ${url}`);
    if (url.endsWith('/api/v1/me')) {
      return reply(200, { user: { id: USER_ID, email: 'ivan@example.dev' }, orgs: [{ id: ORG_ID, slug: ORG, name: 'Acme', role: 'member' }] });
    }
    if (url.endsWith('/api/v1/departments') && init.method === 'GET') {
      return reply(200, { departments: [{ id: DEPT_ID, slug: 'unity-review', manifestDigest: DIGEST, enabled: true, retired: false }] });
    }
    if (url.endsWith(`/api/v1/departments/${DEPT_ID}`) && init.method === 'GET') {
      return reply(200, { department: { id: DEPT_ID, slug: 'unity-review', enabled: true, retired: false, online: true, manifestDigest: DIGEST } });
    }
    if (url.endsWith(`/api/v1/departments/${DEPT_ID}/installs`)) {
      return reply(200, { installs: [{ id: INSTALL_ID, departmentId: DEPT_ID, runnerId: RUNNER_ID, manifestDigest: DIGEST, pendingApproval: false, state: 'active' }] });
    }
    if (url.endsWith('/api/v1/dept-usage')) {
      return reply(200, {
        tasks_created: 5,
        messages_sent: 9,
        execution_seconds: 120,
        artifact_bytes: 0,
        updated_at: '2026-07-27T00:00:00.000Z',
        departments: { limit: 3, used: 1, remaining: 2 },
        daily_actions: { limit: 100, used: 47, remaining: 53, reset_at: '2026-07-28T00:00:00.000Z' },
      });
    }
    if (url.includes('/api/v1/dept-tasks')) {
      return reply(200, {
        tasks: [
          { id: '8f3c2a1b-0000-0000-0000-000000000001', contextId: 'ctx-1', departmentId: DEPT_ID, originPrincipal: `user:${USER_ID}`, state: 'WORKING', createdAt: '2026-07-27T14:22:00.000Z', updatedAt: '2026-07-27T14:22:00.000Z', deadlineAt: null },
          { id: '9d11e4f2-0000-0000-0000-000000000002', contextId: 'ctx-2', departmentId: DEPT_ID, originPrincipal: `user:${USER_ID}`, state: 'COMPLETED', createdAt: '2026-07-27T15:00:00.000Z', updatedAt: '2026-07-27T15:02:00.000Z', deadlineAt: null },
        ],
      });
    }
    throw new Error(`unexpected fetch: ${init.method} ${url}`);
  };

  const deps: StatusCommandDeps = {
    shell: (cmd, args): ShellResult => {
      if (cmd === 'pipeline-runner' && args[0] === 'bindings') {
        const departments =
          opts.bindingsDeptId === undefined || opts.bindingsDeptId === null
            ? {}
            : { [opts.bindingsDeptId]: { adapterId: 'pipeline-drive', command: 'pipeline', cwd: opts.cwd } };
        return { code: 0, stdout: JSON.stringify({ path: '/fake', source: 'file', refusal: null, departments }), stderr: '' };
      }
      if (cmd === 'pipeline-runner' && args[0] === 'status') {
        return { code: 0, stdout: JSON.stringify({ base_url: SERVER, runner_id: RUNNER_ID }), stderr: '' };
      }
      return { code: 1, stdout: '', stderr: 'unexpected shell call' };
    },
    fetch: async (url, init) => (opts.fetchOverride ? await opts.fetchOverride(url, init) : await defaultFetch(url, init)),
    out: (s) => (out += s),
    err: (s) => (out += s),
    env: { PIPELINE_CLOUD_HOME: CRED_HOME, ...(opts.noRunnerHome ? {} : RUNNER_ENV) },
    cwd: opts.cwd,
    fs: fakeCloudFs(
      {
        ...(opts.signedIn
          ? { [CRED_PATH]: JSON.stringify({ version: 1, servers: { [SERVER]: { access_token: 'tok', token_type: 'bearer', org_slug: ORG } } }) }
          : {}),
        ...(opts.journal !== undefined ? { [JOURNAL_INDEX]: opts.journal } : {}),
        ...(opts.journalUnreadable ? { [JOURNAL_INDEX]: 'unreadable' } : {}),
      },
      opts.journalUnreadable ? new Set([JOURNAL_INDEX]) : new Set(),
    ),
    platform: 'linux',
    homedir: CRED_HOME,
    now: () => new Date('2026-07-27T16:00:00.000Z').getTime(),
    sleep: async () => {
      sleeps++;
    },
  };
  return { deps, out: () => out, fetchCalls, sleeps: () => sleeps };
}

describe('status — DoD box 1: works with the network down', () => {
  test('no stored credential + not bound locally -> local-only view, exit 0, never crashes', async () => {
    const dir = departmentProject();
    const w = makeStatusWorld({ cwd: dir, signedIn: false, bindingsDeptId: null });
    const code = await runDepartmentStatus(['--server', SERVER], w.deps);
    expect(code).toBe(0);
    expect(w.out()).toContain('not bound on this machine');
    expect(w.out()).toContain('offline — no cloud connection');
    // No cloud data was fabricated.
    expect(w.out()).not.toContain('running ·');
    expect(w.fetchCalls.length).toBe(0);
  });

  test('no stored credential + bound locally -> reports accepting tasks, still offline', async () => {
    const dir = departmentProject();
    const w = makeStatusWorld({ cwd: dir, signedIn: false, bindingsDeptId: DEPT_ID });
    const code = await runDepartmentStatus(['--server', SERVER], w.deps);
    expect(code).toBe(0);
    expect(w.out()).toContain('accepting tasks on this machine');
    expect(w.out()).toContain('offline');
  });

  test('--json offline shape never invents a `cloud` object', async () => {
    const dir = departmentProject();
    const w = makeStatusWorld({ cwd: dir, signedIn: false, bindingsDeptId: DEPT_ID });
    const code = await runDepartmentStatus(['--server', SERVER, '--json'], w.deps);
    expect(code).toBe(0);
    const parsed = JSON.parse(w.out()) as { boundLocally: boolean; cloud: unknown };
    expect(parsed.boundLocally).toBe(true);
    expect(parsed.cloud).toBeNull();
  });
});

describe('status — online: budget line, task counts, stale-digest flag', () => {
  test('renders the online line with running/completed counts, from the API, unmodified', async () => {
    const dir = departmentProject();
    const w = makeStatusWorld({ cwd: dir, signedIn: true, bindingsDeptId: DEPT_ID });
    const code = await runDepartmentStatus(['--server', SERVER], w.deps);
    expect(code).toBe(0);
    expect(w.out()).toContain('● unity-review — online · 1 running · 1 completed today');
  });

  test('DoD box 5: the budget line is exactly the API numbers, no client arithmetic', async () => {
    const dir = departmentProject();
    const w = makeStatusWorld({ cwd: dir, signedIn: true, bindingsDeptId: DEPT_ID });
    await runDepartmentStatus(['--server', SERVER], w.deps);
    expect(w.out()).toContain('Free plan · department 1 of 3 · 47 of 100 actions used today (resets 2026-07-28T00:00:00.000Z)');
  });

  test('DoD box 4: a stale-digest install is flagged', async () => {
    const dir = departmentProject();
    const w = makeStatusWorld({
      cwd: dir,
      signedIn: true,
      bindingsDeptId: DEPT_ID,
      fetchOverride: async (url, init) => {
        if (url.endsWith('/api/v1/me')) return reply(200, { user: { id: USER_ID }, orgs: [{ id: ORG_ID, slug: ORG, name: 'Acme', role: 'member' }] });
        if (url.endsWith('/api/v1/departments') && init.method === 'GET') {
          return reply(200, { departments: [{ id: DEPT_ID, slug: 'unity-review', manifestDigest: DIGEST, enabled: true, retired: false }] });
        }
        if (url.endsWith(`/api/v1/departments/${DEPT_ID}`)) {
          return reply(200, { department: { id: DEPT_ID, slug: 'unity-review', enabled: true, retired: false, online: true, manifestDigest: DIGEST } });
        }
        if (url.endsWith(`/api/v1/departments/${DEPT_ID}/installs`)) {
          // This runner's OWN claimed digest lags the department's current one.
          return reply(200, { installs: [{ id: INSTALL_ID, departmentId: DEPT_ID, runnerId: RUNNER_ID, manifestDigest: OLD_DIGEST, pendingApproval: false, state: 'active' }] });
        }
        if (url.endsWith('/api/v1/dept-usage')) {
          return reply(200, { tasks_created: 0, messages_sent: 0, execution_seconds: 0, artifact_bytes: 0, updated_at: '2026-07-27T00:00:00.000Z', departments: { limit: null, used: 1, remaining: null }, daily_actions: { limit: null, used: 0, remaining: null, reset_at: null } });
        }
        if (url.includes('/api/v1/dept-tasks')) return reply(200, { tasks: [] });
        throw new Error(`unexpected: ${init.method} ${url}`);
      },
    });
    const code = await runDepartmentStatus(['--server', SERVER], w.deps);
    expect(code).toBe(0);
    expect(w.out()).toContain('⚠ serving an older manifest');
    expect(w.out()).toContain('Run `pipeline department serve` to update');
  });

  test('an unlimited plan never claims Pro/Team by name', async () => {
    const dir = departmentProject();
    const w = makeStatusWorld({
      cwd: dir,
      signedIn: true,
      bindingsDeptId: DEPT_ID,
      fetchOverride: async (url, init) => {
        if (url.endsWith('/api/v1/me')) return reply(200, { user: {}, orgs: [{ id: ORG_ID, slug: ORG, name: 'Acme', role: 'member' }] });
        if (url.endsWith('/api/v1/departments') && init.method === 'GET') {
          return reply(200, { departments: [{ id: DEPT_ID, slug: 'unity-review', manifestDigest: DIGEST, enabled: true, retired: false }] });
        }
        if (url.endsWith(`/api/v1/departments/${DEPT_ID}`)) {
          return reply(200, { department: { id: DEPT_ID, slug: 'unity-review', enabled: true, retired: false, online: true, manifestDigest: DIGEST } });
        }
        if (url.endsWith(`/api/v1/departments/${DEPT_ID}/installs`)) return reply(200, { installs: [] });
        if (url.endsWith('/api/v1/dept-usage')) {
          return reply(200, { tasks_created: 0, messages_sent: 0, execution_seconds: 0, artifact_bytes: 0, updated_at: '2026-07-27T00:00:00.000Z', departments: { limit: null, used: 4, remaining: null }, daily_actions: { limit: null, used: 900, remaining: null, reset_at: null } });
        }
        if (url.includes('/api/v1/dept-tasks')) return reply(200, { tasks: [] });
        throw new Error(`unexpected: ${init.method} ${url}`);
      },
    });
    await runDepartmentStatus(['--server', SERVER], w.deps);
    expect(w.out()).not.toContain('Free plan');
    expect(w.out()).not.toContain('Pro plan');
    expect(w.out()).not.toContain('Team plan');
    expect(w.out()).toContain('department 4 used (unlimited)');
  });

  test('--json carries the same numbers verbatim', async () => {
    const dir = departmentProject();
    const w = makeStatusWorld({ cwd: dir, signedIn: true, bindingsDeptId: DEPT_ID });
    await runDepartmentStatus(['--server', SERVER, '--json'], w.deps);
    const parsed = JSON.parse(w.out()) as {
      cloud: { online: boolean; running: number; completedToday: number; usage: { dailyActions: { used: number; limit: number } } };
    };
    expect(parsed.cloud.online).toBe(true);
    expect(parsed.cloud.running).toBe(1);
    expect(parsed.cloud.completedToday).toBe(1);
    expect(parsed.cloud.usage.dailyActions).toEqual({ limit: 100, used: 47, remaining: 53, resetAt: '2026-07-28T00:00:00.000Z' });
  });
});

// ---------------------------------------------------------------------------
// `status` — x19: sender + engine, joined from the LOCAL runner journal
//
// The e3 gate failed a10's "renders sender and engine for real tasks" box:
// pipeline-runner's b4 writes both into its own execution journal, and nothing
// anywhere read them back. These cover the consumer half — including every way
// the journal can be missing, since a machine that never ran the work is the
// ORDINARY case, not an error.
// ---------------------------------------------------------------------------

describe('status — x19: sender and engine come from the local runner journal', () => {
  test('a task the journal knows renders its sender and its engine', async () => {
    const dir = departmentProject();
    const w = makeStatusWorld({
      cwd: dir,
      signedIn: true,
      bindingsDeptId: DEPT_ID,
      journal: `${indexLine({ taskId: TASK_1 })}\n${indexLine({ taskId: TASK_2, sender: 'dana@acme.dev', engine: 'pipeline' })}\n`,
    });
    const code = await runDepartmentStatus(['--server', SERVER], w.deps);
    expect(code).toBe(0);
    expect(w.out()).toContain('ivan@acme.dev');
    expect(w.out()).toContain('claude-code');
    expect(w.out()).toContain('dana@acme.dev');
    expect(w.out()).toContain('pipeline');
    // Nothing is unknown, so no `?` legend is printed.
    expect(w.out()).not.toContain('sender/engine unknown');
  });

  test('the cloud `originPrincipal` is NEVER printed where a sender belongs (the misattribution x19 fixes)', async () => {
    const dir = departmentProject();
    const w = makeStatusWorld({
      cwd: dir,
      signedIn: true,
      bindingsDeptId: DEPT_ID,
      journal: `${indexLine({ taskId: TASK_1 })}\n`,
    });
    await runDepartmentStatus(['--server', SERVER], w.deps);
    // `user:<uuid>` is the AUTHENTICATED CALLER, a different identity from the
    // sender — it used to occupy this column and be read as "who asked".
    expect(w.out()).not.toContain(`user:${USER_ID}`);
  });

  test('a task the journal does NOT know renders as unknown, never misattributed', async () => {
    const dir = departmentProject();
    const w = makeStatusWorld({
      cwd: dir,
      signedIn: true,
      bindingsDeptId: DEPT_ID,
      // Only TASK_1 ran here; TASK_2 came from another machine.
      journal: `${indexLine({ taskId: TASK_1 })}\n`,
    });
    const code = await runDepartmentStatus(['--server', SERVER], w.deps);
    expect(code).toBe(0);
    expect(w.out()).toContain('sender/engine unknown for 1 task — not run on this machine.');
    // The known task keeps its real sender; the unknown one borrows nothing.
    const lines = w.out().split('\n');
    const unknownLine = lines.find((l) => l.includes('9d11e4f2'))!;
    expect(unknownLine).toContain('?');
    expect(unknownLine).not.toContain('ivan@acme.dev');
    expect(unknownLine).not.toContain(`user:${USER_ID}`);
  });

  test('an ABSENT journal (no runner ever ran here) is an ordinary state — exit 0, all unknown', async () => {
    const dir = departmentProject();
    const w = makeStatusWorld({ cwd: dir, signedIn: true, bindingsDeptId: DEPT_ID });
    const code = await runDepartmentStatus(['--server', SERVER], w.deps);
    expect(code).toBe(0);
    expect(w.out()).toContain('● unity-review — online');
    expect(w.out()).toContain('no local runner journal on this machine');
  });

  test('an UNREADABLE journal (permissions) is reported, never fatal', async () => {
    const dir = departmentProject();
    const w = makeStatusWorld({ cwd: dir, signedIn: true, bindingsDeptId: DEPT_ID, journalUnreadable: true });
    const code = await runDepartmentStatus(['--server', SERVER], w.deps);
    expect(code).toBe(0);
    expect(w.out()).toContain('runner journal could not be read (permission denied)');
    expect(w.out()).toContain(JOURNAL_INDEX);
  });

  test('an UNLOCATABLE data directory (no PIPELINE_RUNNER_HOME, no HOME) degrades, never crashes', async () => {
    const dir = departmentProject();
    const w = makeStatusWorld({ cwd: dir, signedIn: true, bindingsDeptId: DEPT_ID, noRunnerHome: true });
    const code = await runDepartmentStatus(['--server', SERVER], w.deps);
    expect(code).toBe(0);
    expect(w.out()).toContain("could not determine pipeline-runner's data directory");
  });

  test('a PARTIAL journal — a truncated final line after a hard kill — still yields the lines before it', async () => {
    const dir = departmentProject();
    const w = makeStatusWorld({
      cwd: dir,
      signedIn: true,
      bindingsDeptId: DEPT_ID,
      journal: `${indexLine({ taskId: TASK_1 })}\n${indexLine({ taskId: TASK_2 }).slice(0, 40)}`,
    });
    const code = await runDepartmentStatus(['--server', SERVER], w.deps);
    expect(code).toBe(0);
    expect(w.out()).toContain('ivan@acme.dev');
    expect(w.out()).toContain('sender/engine unknown for 1 task');
  });

  test('a schema-1 line (no sender/engine at all) is still a valid entry — recorded, nothing to state', async () => {
    const dir = departmentProject();
    const w = makeStatusWorld({
      cwd: dir,
      signedIn: true,
      bindingsDeptId: DEPT_ID,
      journal: `${indexLine({ taskId: TASK_1, sender: null, engine: null })}\n`,
    });
    await runDepartmentStatus(['--server', SERVER, '--json'], w.deps);
    const parsed = JSON.parse(w.out()) as { cloud: { tasks: { id: string; sender: string | null; engine: string | null; localRecord: boolean }[] } };
    const known = parsed.cloud.tasks.find((t) => t.id === TASK_1)!;
    // Known to this machine (`localRecord: true`) but with nothing recorded —
    // distinct in JSON from the task it has never heard of.
    expect(known).toMatchObject({ sender: null, engine: null, localRecord: true });
    const unknown = parsed.cloud.tasks.find((t) => t.id === TASK_2)!;
    expect(unknown).toMatchObject({ sender: null, engine: null, localRecord: false });
  });

  test('a re-run task takes its LATEST execution — the engine that most recently ran it', async () => {
    const dir = departmentProject();
    const w = makeStatusWorld({
      cwd: dir,
      signedIn: true,
      bindingsDeptId: DEPT_ID,
      journal:
        `${indexLine({ taskId: TASK_1, engine: 'pipeline', runId: 'dexec-a' })}\n` +
        `${indexLine({ taskId: TASK_1, engine: 'claude-code', runId: 'dexec-b' })}\n`,
    });
    await runDepartmentStatus(['--server', SERVER, '--json'], w.deps);
    const parsed = JSON.parse(w.out()) as { cloud: { tasks: { id: string; engine: string | null }[] } };
    expect(parsed.cloud.tasks.find((t) => t.id === TASK_1)!.engine).toBe('claude-code');
  });

  test('--json carries the same sender/engine the human view shows, plus the journal it came from', async () => {
    const dir = departmentProject();
    const w = makeStatusWorld({
      cwd: dir,
      signedIn: true,
      bindingsDeptId: DEPT_ID,
      journal: `${indexLine({ taskId: TASK_1 })}\n`,
    });
    await runDepartmentStatus(['--server', SERVER, '--json'], w.deps);
    const parsed = JSON.parse(w.out()) as {
      localJournal: { status: string; path: string; executions: number; skippedLines: number };
      cloud: { tasks: { id: string; sender: string | null; engine: string | null; localRecord: boolean; originPrincipal: string }[] };
    };
    expect(parsed.localJournal).toEqual({ status: 'ok', path: JOURNAL_INDEX, executions: 1, skippedLines: 0 });
    const t1 = parsed.cloud.tasks.find((t) => t.id === TASK_1)!;
    expect(t1.sender).toBe('ivan@acme.dev');
    expect(t1.engine).toBe('claude-code');
    expect(t1.localRecord).toBe(true);
    // The cloud's own field survives in JSON — it is real, it is just not the
    // sender, which is why it no longer occupies the sender COLUMN.
    expect(t1.originPrincipal).toBe(`user:${USER_ID}`);
  });

  test('offline: the journal is still read and reported as a count, never rendered as a task list', async () => {
    const dir = departmentProject();
    const w = makeStatusWorld({
      cwd: dir,
      signedIn: false,
      bindingsDeptId: DEPT_ID,
      journal: `${indexLine({ taskId: TASK_1 })}\n${indexLine({ taskId: TASK_2 })}\n`,
    });
    const code = await runDepartmentStatus(['--server', SERVER], w.deps);
    expect(code).toBe(0);
    expect(w.out()).toContain('2 recorded executions for this department');
    // No fabricated task states, and no sender printed against a task the
    // offline view cannot list.
    expect(w.out()).not.toContain('running');
    expect(w.out()).not.toContain('ivan@acme.dev');
  });

  test('offline --json reports the journal without inventing a `cloud` object', async () => {
    const dir = departmentProject();
    const w = makeStatusWorld({
      cwd: dir,
      signedIn: false,
      bindingsDeptId: DEPT_ID,
      journal: `${indexLine({ taskId: TASK_1 })}\n`,
    });
    await runDepartmentStatus(['--server', SERVER, '--json'], w.deps);
    const parsed = JSON.parse(w.out()) as { cloud: unknown; localJournal: { status: string; executions: number } };
    expect(parsed.cloud).toBeNull();
    expect(parsed.localJournal).toMatchObject({ status: 'ok', executions: 1 });
  });

  test('offline and unbound: no department id, so there is not even a file to name', async () => {
    const dir = departmentProject();
    const w = makeStatusWorld({ cwd: dir, signedIn: false, bindingsDeptId: null });
    await runDepartmentStatus(['--server', SERVER, '--json'], w.deps);
    const parsed = JSON.parse(w.out()) as { localJournal: unknown };
    expect(parsed.localJournal).toBeNull();
  });
});

describe('status — --follow', () => {
  test('gathers repeatedly and sleeps between snapshots, bounded by the test hook', async () => {
    const dir = departmentProject();
    const w = makeStatusWorld({ cwd: dir, signedIn: true, bindingsDeptId: DEPT_ID });
    const code = await runDepartmentStatus(['--server', SERVER, '--follow'], w.deps, 3);
    expect(code).toBe(0);
    // 3 iterations -> 2 sleeps between them, never a trailing sleep.
    expect(w.sleeps()).toBe(2);
    // The online line was printed 3 times.
    expect(w.out().split('online · 1 running').length - 1).toBe(3);
  });
});
