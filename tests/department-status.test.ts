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

function fakeCloudFs(initial: Record<string, string> = {}): CloudFs {
  const files = new Map<string, string>(Object.entries(initial));
  return {
    existsSync: (p) => files.has(p),
    readFileSync: (p) => {
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

interface StatusWorldOpts {
  cwd: string;
  /** When set, seeds a live (never-expiring) stored credential. */
  signedIn?: boolean;
  bindingsDeptId?: string | null;
  fetchOverride?: (url: string, init: ServeHttpInit) => Promise<ServeHttpResponse> | ServeHttpResponse;
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
    env: { PIPELINE_CLOUD_HOME: CRED_HOME },
    cwd: opts.cwd,
    fs: fakeCloudFs(
      opts.signedIn
        ? { [CRED_PATH]: JSON.stringify({ version: 1, servers: { [SERVER]: { access_token: 'tok', token_type: 'bearer', org_slug: ORG } } }) }
        : {},
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
