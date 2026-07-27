// Tests for `pipeline department serve` (src/commands/department.ts +
// src/lib/department-serve.ts — simplified-onboarding task a9).
//
// Organized around a9's Definition of Done:
//  1. Fresh clone -> serve -> a callable department, on a Free-plan org, with
//     `engine: pipeline`.
//  2. Interrupting after any of steps 4–8 and re-running converges without
//     duplicate registrations, runners, or services.
//  3. Each failure row of 05 §5's table produces its stated message and exit
//     code.
//  4. A department that registered but is not serving reports
//     `○ registered — not serving`, never `online`.
//  5. No file is written inside the department folder except what the user
//     authored.
//
// Plus the two constraints a9 carries that its own spec does not state:
//  - the binding is written by SHELLING OUT to `pipeline-runner bind`, never
//    by this package writing another package's config store; and
//  - the cloud's `pipeline-drive` coherence check can never fire (a7 keeps the
//    whole `runtime:` block local, and every server rule is gated on
//    `runtime.adapter`), so the equivalent must be enforced locally — before
//    anything is registered.
//
// Every side effect is injected: no network, no browser, no `pipeline-runner`
// binary, no real credential store is touched by any test in this file.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runDepartmentServe, type ServeCommandDeps } from '../src/commands/department';
import {
  appOriginFor,
  buildBindArgs,
  departmentUrlFor,
  renderState,
  runtimeBindingFor,
  type ServeHttpInit,
  type ServeHttpResponse,
} from '../src/lib/department-serve';
import { buildRegistrationRequest, parseDepartmentManifest } from '../src/lib/department-manifest';
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
const DEPT_ID = '22222222-2222-4222-8222-222222222222';
const RUNNER_ID = '33333333-3333-4333-8333-333333333333';
const INSTALL_ID = '44444444-4444-4444-8444-444444444444';
const CLIENT_SECRET = 'rs_super_secret_value';

const PIPELINE_MANIFEST = `# Review\n\n## End State\nA reviewed Unity project.\n\n## Scope\n- In: Unity architecture review\n- Out: shipping the fix\n`;

function departmentYaml(overrides: { engine?: string; extra?: string } = {}): string {
  const engine = overrides.engine ?? 'pipeline';
  const runtimeExtra =
    engine === 'pipeline' ? '  pipelineRoot: .claude/pipeline/review\n  startIteration: steps/01-plan.md\n' : '';
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
    `  engine: ${engine}\n` +
    runtimeExtra +
    (overrides.extra ?? '')
  );
}

/** A department project folder exactly as `git clone` would leave it: an
 *  authored `department.yml` plus a real pipeline for it to point at. */
function departmentProject(yaml = departmentYaml()): string {
  const dir = mkdtempSync(join(tmpdir(), 'dept-serve-'));
  created.push(dir);
  const pipelineRoot = join(dir, '.claude', 'pipeline', 'review');
  mkdirSync(join(pipelineRoot, 'steps'), { recursive: true });
  writeFileSync(join(pipelineRoot, 'PIPELINE.md'), PIPELINE_MANIFEST);
  writeFileSync(join(pipelineRoot, 'steps', '01-plan.md'), '# Plan\n');
  writeFileSync(join(dir, 'department.yml'), yaml);
  return dir;
}

/** Every file under `root`, POSIX-relative, sorted — for DoD box 5. */
function listFilesRel(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), childRel);
      else out.push(childRel);
    }
  };
  walk(root, '');
  return out.sort();
}

// ---------------------------------------------------------------------------
// injected world
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string;
  init: ServeHttpInit;
}
interface ShellCall {
  cmd: string;
  args: string[];
  env?: Record<string, string>;
}

interface CloudScript {
  /** Departments the org already has (the GET /departments answer). */
  departments?: Array<Record<string, unknown>>;
  /** Status for POST /api/v1/departments (default 201). */
  createStatus?: number;
  createBody?: Record<string, unknown>;
  patchStatus?: number;
  /** Status for POST /api/v1/runners (default 201). */
  mintStatus?: number;
  mintBody?: Record<string, unknown>;
  claimStatus?: number;
  claimBody?: Record<string, unknown>;
  /** Throw (a transport failure) for any URL containing this substring. */
  offlineOn?: string;
}

interface ShellScript {
  /** Does this machine already have a supervisor service? */
  serviceInstalled?: boolean;
  /** Existing runner identity (a machine that is already enrolled). */
  identityRunnerId?: string | null;
  registerCode?: number;
  registerStderr?: string;
  bindCode?: number;
  bindStderr?: string;
  serviceInstallCode?: number;
  serviceInstallStderr?: string;
  cliAvailable?: boolean;
}

interface World {
  deps: ServeCommandDeps;
  out: () => string;
  err: () => string;
  fetches: FetchCall[];
  shells: ShellCall[];
}

function reply(status: number, body: unknown): ServeHttpResponse {
  return { status, json: async () => body };
}

function makeWorld(opts: { cwd: string; cloud?: CloudScript; shell?: ShellScript; authError?: string } = { cwd: '.' }): World {
  const cloud = opts.cloud ?? {};
  const sh = opts.shell ?? {};
  const fetches: FetchCall[] = [];
  const shells: ShellCall[] = [];
  let outBuf = '';
  let errBuf = '';

  const deps: ServeCommandDeps = {
    fetch: async (url, init) => {
      fetches.push({ url, init });
      if (cloud.offlineOn !== undefined && url.includes(cloud.offlineOn)) {
        throw new Error('getaddrinfo ENOTFOUND');
      }
      if (url.endsWith('/api/v1/departments') && init.method === 'GET') {
        return reply(200, { departments: cloud.departments ?? [] });
      }
      if (url.endsWith('/api/v1/departments') && init.method === 'POST') {
        const status = cloud.createStatus ?? 201;
        if (status !== 201) return reply(status, cloud.createBody ?? { error: 'nope' });
        return reply(201, {
          department: { id: DEPT_ID, slug: 'unity-review', manifestDigest: digestOf(init), enabled: true, retired: false },
        });
      }
      if (url.includes('/api/v1/departments/') && init.method === 'PATCH') {
        const status = cloud.patchStatus ?? 200;
        if (status !== 200) return reply(status, { error: 'patch refused' });
        return reply(200, {
          department: { id: DEPT_ID, slug: 'unity-review', manifestDigest: digestOf(init), enabled: true, retired: false },
        });
      }
      if (url.endsWith('/api/v1/runners') && init.method === 'POST') {
        const status = cloud.mintStatus ?? 201;
        if (status !== 201) return reply(status, cloud.mintBody ?? { error: 'runner refused' });
        return reply(201, { runner: { id: RUNNER_ID }, clientId: RUNNER_ID, clientSecret: CLIENT_SECRET });
      }
      if (url.includes('/installs') && init.method === 'POST') {
        const status = cloud.claimStatus ?? 200;
        if (status !== 200) return reply(status, cloud.claimBody ?? { error: 'claim refused' });
        return reply(
          200,
          cloud.claimBody ?? {
            install: { id: INSTALL_ID, pendingApproval: false },
            changed: true,
            auto_approved: true,
            approval_policy: 'auto-admin',
          },
        );
      }
      throw new Error(`unexpected fetch: ${init.method} ${url}`);
    },
    shell: (cmd, args, env): ShellResult => {
      shells.push({ cmd, args, ...(env !== undefined ? { env } : {}) });
      if (cmd === 'pipeline-runner' && args[0] === '--version') {
        return sh.cliAvailable === false ? { code: 127, stdout: '', stderr: '' } : { code: 0, stdout: '0.9.0\n', stderr: '' };
      }
      if (cmd === 'pipeline-runner' && args[0] === 'service' && args[1] === 'status') {
        return sh.serviceInstalled
          ? { code: 0, stdout: '[pipeline-runner] pipeline-runner.service: running (enabled)\n', stderr: '' }
          : { code: 0, stdout: '[pipeline-runner] pipeline-runner.service is not installed\n', stderr: '' };
      }
      if (cmd === 'pipeline-runner' && args[0] === 'status') {
        const id = sh.identityRunnerId;
        if (id === undefined || id === null) {
          return { code: 1, stdout: '', stderr: '[pipeline-runner] error: no agent identity configured\n' };
        }
        return { code: 0, stdout: JSON.stringify({ base_url: SERVER, runner_id: id, runner_token: '<redacted>' }), stderr: '' };
      }
      if (cmd === 'pipeline-runner' && args[0] === 'register') {
        return { code: sh.registerCode ?? 0, stdout: '', stderr: sh.registerStderr ?? '' };
      }
      if (cmd === 'pipeline-runner' && args[0] === 'bind') {
        return {
          code: sh.bindCode ?? 0,
          stdout: sh.bindCode ? '' : '[pipeline-runner] bound … (…/departments.json)\n',
          stderr: sh.bindStderr ?? '',
        };
      }
      if (cmd === 'pipeline-runner' && args[0] === 'service' && args[1] === 'install') {
        return { code: sh.serviceInstallCode ?? 0, stdout: '', stderr: sh.serviceInstallStderr ?? '' };
      }
      if (cmd === 'bun' && args[0] === 'add') return { code: 0, stdout: '', stderr: '' };
      return { code: 1, stdout: '', stderr: `test double: unexpected shell call: ${cmd} ${args.join(' ')}` };
    },
    out: (s) => {
      outBuf += s;
    },
    err: (s) => {
      errBuf += s;
    },
    env: {},
    cwd: opts.cwd,
    hostname: () => 'unity-box',
    authenticate: async () => {
      if (opts.authError !== undefined) throw new Error(opts.authError);
      return {
        server: SERVER,
        accessToken: 'access-token-secret',
        orgSlug: ORG,
        orgId: ORG_ID,
        userEmail: 'ivan@example.dev',
        credentialPath: '/nowhere/credentials.json',
        now: 1_700_000_000_000,
      };
    },
  };
  return { deps, out: () => outBuf, err: () => errBuf, fetches, shells };
}

/** The digest the CLI computed, read back off the request it sent — so the
 *  fake server answers with the SAME digest a re-serve would compute, which is
 *  what makes the idempotency tests mean anything. */
function digestOf(init: ServeHttpInit): string {
  const body = JSON.parse(init.body ?? '{}') as { manifest_digest?: string };
  return body.manifest_digest ?? 'sha256:unknown';
}

const bodyOf = (call: FetchCall): Record<string, unknown> => JSON.parse(call.init.body ?? '{}') as Record<string, unknown>;
const shellArgs = (w: World, verb: string): ShellCall[] => w.shells.filter((c) => c.args[0] === verb);

// ---------------------------------------------------------------------------
// DoD box 1 — fresh clone -> serve -> callable department (engine: pipeline)
// ---------------------------------------------------------------------------

describe('serve — DoD box 1: a fresh clone becomes callable', () => {
  test('nine steps, in order, ending in ● online', async () => {
    const dir = departmentProject();
    const before = listFilesRel(dir);
    const w = makeWorld({ cwd: dir });

    const code = await runDepartmentServe([], w.deps);

    expect(code).toBe(0);
    const out = w.out();
    // 05 §5's own transcript line, identity included.
    expect(out).toContain(`✓ Authorized as ivan@example.dev    org: ${ORG}`);
    expect(out).toContain(`✓ Registered      ${ORG} / unity-review`);
    expect(out).toContain("✓ This machine    registered as runner 'unity-box'");
    expect(out).toContain('✓ Runtime bound   pipeline → pipeline');
    expect(out).toContain('✓ Supervisor      installed, starts on boot');
    expect(out).toContain('● unity-review — online, ready for work');
    expect(out).toContain('Callable now:  "ask the unity-review department to …"');

    // DoD box 5 — nothing written inside the department folder, and in
    // particular no `.claude/pipeline/cloud.json` (which would pin a clonable
    // repo to one org and one server).
    expect(listFilesRel(dir)).toEqual(before);
    expect(existsSync(join(dir, '.claude', 'pipeline', 'cloud.json'))).toBe(false);
  });

  test('step 3: the digest is computed, and the request carries no local field', async () => {
    const dir = departmentProject();
    const w = makeWorld({ cwd: dir });
    await runDepartmentServe([], w.deps);

    const post = w.fetches.find((f) => f.url.endsWith('/api/v1/departments') && f.init.method === 'POST')!;
    const body = bodyOf(post);
    // The digest is real (sha256 over the canonicalized advertised subset),
    // never authored, never a placeholder — D15.
    expect(String(body['manifest_digest'])).toMatch(/^sha256:[0-9a-f]{64}$/);
    // a7's allow-list, re-asserted at the boundary that actually ships bytes:
    // the whole `runtime:` half stays on this machine.
    for (const forbidden of ['runtime', 'engine', 'command', 'args', 'workingDirectory', 'environment', 'pipelineRoot']) {
      expect(Object.keys(body)).not.toContain(forbidden);
    }
    expect(body['slug']).toBe('unity-review');
  });

  test('step 5: the runner OAuth secret rides in the environment, never in argv', async () => {
    const dir = departmentProject();
    const w = makeWorld({ cwd: dir });
    await runDepartmentServe([], w.deps);

    const register = shellArgs(w, 'register')[0]!;
    expect(register.args.join(' ')).not.toContain(CLIENT_SECRET);
    expect(register.args).toContain('--client-id');
    expect(register.env?.['PIPELINE_RUNNER_OAUTH_CLIENT_SECRET']).toBe(CLIENT_SECRET);
    // And it never reaches the transcript either.
    expect(w.out()).not.toContain(CLIENT_SECRET);
    expect(w.err()).not.toContain(CLIENT_SECRET);
  });

  test('step 8: the claim carries this machine\'s runner id and the digest it serves', async () => {
    const dir = departmentProject();
    const w = makeWorld({ cwd: dir });
    await runDepartmentServe([], w.deps);

    const claim = w.fetches.find((f) => f.url.includes('/installs'))!;
    expect(claim.url).toBe(`${SERVER}/api/v1/departments/${DEPT_ID}/installs`);
    const body = bodyOf(claim);
    expect(body['runner_id']).toBe(RUNNER_ID);
    const post = w.fetches.find((f) => f.url.endsWith('/api/v1/departments') && f.init.method === 'POST')!;
    expect(body['manifest_digest']).toBe(bodyOf(post)['manifest_digest']);
  });

  test('--json emits one object on stdout and every progress line on stderr', async () => {
    const dir = departmentProject();
    const w = makeWorld({ cwd: dir });

    const code = await runDepartmentServe(['--json'], w.deps);

    expect(code).toBe(0);
    const payload = JSON.parse(w.out()) as Record<string, unknown>;
    expect(payload['ok']).toBe(true);
    expect(payload['state']).toBe('online');
    expect(payload['org']).toBe(ORG);
    expect((payload['department'] as Record<string, unknown>)['id']).toBe(DEPT_ID);
    expect((payload['runner'] as Record<string, unknown>)['id']).toBe(RUNNER_ID);
    expect((payload['binding'] as Record<string, unknown>)['adapter']).toBe('pipeline-drive');
    expect(payload['supervisor']).toBe('installed');
    expect(payload['url']).toBe('https://example.dev/departments/unity-review');
    expect(w.err()).toContain('✓ Registered');
  });
});

// ---------------------------------------------------------------------------
// Constraint 1 — the binding is written by `pipeline-runner bind`
// ---------------------------------------------------------------------------

describe('serve — step 6 shells out to `pipeline-runner bind` (never writes departments.json)', () => {
  test('the argv is b1\'s contract: adapter, command, cwd, lifecycle, and the nested spec', async () => {
    const dir = departmentProject();
    const w = makeWorld({ cwd: dir });
    await runDepartmentServe([], w.deps);

    const bind = shellArgs(w, 'bind')[0]!;
    expect(bind.cmd).toBe('pipeline-runner');
    expect(bind.args.slice(0, 7)).toEqual([
      'bind',
      '--department',
      DEPT_ID,
      '--adapter',
      'pipeline-drive',
      '--command',
      'pipeline',
    ]);
    const spec = JSON.parse(bind.args[bind.args.indexOf('--spec') + 1]!) as {
      pipelineDrive: { pipelineRoot: string; startIteration: string };
    };
    // Absolute: the supervisor's working directory is its own, not the
    // department's, so a repo-relative root would resolve elsewhere.
    expect(spec.pipelineDrive.pipelineRoot).toBe(resolve(dir, '.claude/pipeline/review'));
    // Root-RELATIVE: `--start` is matched against the plan's own step paths.
    expect(spec.pipelineDrive.startIteration).toBe('steps/01-plan.md');
    expect(bind.args[bind.args.indexOf('--cwd') + 1]).toBe(dir);
  });

  test('nothing is written into a pipeline-runner home — the store is that package\'s to write', async () => {
    const dir = departmentProject();
    const runnerHome = mkdtempSync(join(tmpdir(), 'runner-home-'));
    created.push(runnerHome);
    const w = makeWorld({ cwd: dir });
    w.deps.env = { PIPELINE_RUNNER_HOME: runnerHome };

    await runDepartmentServe([], w.deps);

    // The real `bind` would create it; this CLI must not, which is exactly
    // what 05 §5 step 5 forbids ("never writes another package's config store
    // directly") and why b1 added the verb.
    expect(readdirSync(runnerHome)).toEqual([]);
    expect(shellArgs(w, 'bind')).toHaveLength(1);
  });

  test('a refused binding store is 05 §5\'s step-6 row, with b1\'s own message relayed', async () => {
    const dir = departmentProject();
    const w = makeWorld({
      cwd: dir,
      shell: {
        bindCode: 1,
        bindStderr:
          '[pipeline-runner] error: could not write the runtime binding: /home/u/.config/pipeline-runner/departments.json (EACCES)\n',
      },
    });

    const code = await runDepartmentServe([], w.deps);

    expect(code).toBe(1);
    expect(w.err()).toContain('Could not write the runtime binding:');
    expect(w.err()).toContain('departments.json');
    expect(w.err()).toContain('the department stays registered');
    // Never claimed: a department that cannot execute must not be advertised
    // as installed.
    expect(w.fetches.some((f) => f.url.includes('/installs'))).toBe(false);
    expect(w.out()).not.toContain('online');
  });
});

// ---------------------------------------------------------------------------
// Constraint 2 — local coherence, enforced before anything is registered
// ---------------------------------------------------------------------------

describe('serve — the coherence rules the cloud can no longer apply', () => {
  test('engine: pipeline with acceptsMidTaskInput: true is refused locally, with zero network calls', async () => {
    const dir = departmentProject(
      departmentYaml({ extra: '\ncommunication:\n  acceptsMidTaskInput: true\n' }),
    );
    const w = makeWorld({ cwd: dir });

    const code = await runDepartmentServe([], w.deps);

    expect(code).toBe(1);
    expect(w.err()).toContain('communication.acceptsMidTaskInput');
    expect(w.err()).toContain('Nothing was registered');
    expect(w.fetches).toEqual([]);
    expect(w.shells).toEqual([]);
  });

  test('engine: pipeline with a non per-task lifecycle is refused locally', async () => {
    const dir = departmentProject(departmentYaml({ extra: '  lifecycle: per-context\n' }));
    const w = makeWorld({ cwd: dir });

    const code = await runDepartmentServe([], w.deps);

    expect(code).toBe(1);
    expect(w.err()).toContain('runtime.lifecycle');
    expect(w.err()).toContain("only supports 'per-task'");
    expect(w.fetches).toEqual([]);
  });

  test('the same manifest would have passed the SERVER\'s check — which is why the local one matters', () => {
    // The server's `validateManifestCoherence` returns [] unless
    // `effective.adapter === 'pipeline-drive'`, and a7's advertised
    // projection never sends `runtime` at all. Proof, from the request the
    // CLI actually builds:
    const { manifest } = parseDepartmentManifest(
      departmentYaml({ extra: '\ncommunication:\n  acceptsMidTaskInput: true\n' }),
    );
    expect(manifest).not.toBeNull();
    // Nothing in the advertised half names an adapter, so the server's rule
    // is unreachable — the local check is the only one left.
    const request = buildRegistrationRequest(manifest!) as unknown as Record<string, unknown>;
    expect(request['runtime']).toBeUndefined();
    expect(JSON.stringify(request)).not.toContain('adapter');
    expect(JSON.stringify(request)).not.toContain('pipeline-drive');
  });
});

// ---------------------------------------------------------------------------
// DoD box 2 — idempotent, resumable from any partial state
// ---------------------------------------------------------------------------

describe('serve — DoD box 2: resumable from any partial state', () => {
  test('interrupted after step 4 (registered): the re-run adopts it and never registers twice', async () => {
    const dir = departmentProject();
    // Run 1 registers, then fails at step 7 (service install).
    const first = makeWorld({ cwd: dir, shell: { serviceInstallCode: 1, serviceInstallStderr: 'systemctl: no' } });
    expect(await runDepartmentServe([], first.deps)).toBe(1);
    const digest = String(bodyOf(first.fetches.find((f) => f.init.method === 'POST' && f.url.endsWith('/departments'))!)['manifest_digest']);

    // Run 2 sees the department already there at the SAME digest and a
    // machine that is already a runner.
    const second = makeWorld({
      cwd: dir,
      cloud: { departments: [{ id: DEPT_ID, slug: 'unity-review', manifestDigest: digest, enabled: true, retired: false }] },
      shell: { identityRunnerId: RUNNER_ID },
    });
    const code = await runDepartmentServe([], second.deps);

    expect(code).toBe(0);
    expect(second.out()).toContain('(unchanged)');
    expect(second.out()).toContain('✓ This machine    already a runner');
    expect(second.out()).toContain('● unity-review — online');
    // No duplicate registration, no duplicate runner.
    expect(second.fetches.filter((f) => f.init.method === 'POST' && f.url.endsWith('/departments'))).toHaveLength(0);
    expect(second.fetches.filter((f) => f.url.endsWith('/api/v1/runners'))).toHaveLength(0);
    expect(shellArgs(second, 'register')).toHaveLength(0);
  });

  test('a machine that already has a supervisor gets a binding, not a rival service (D26)', async () => {
    const dir = departmentProject();
    const w = makeWorld({ cwd: dir, shell: { serviceInstalled: true, identityRunnerId: RUNNER_ID } });

    const code = await runDepartmentServe([], w.deps);

    expect(code).toBe(0);
    expect(w.out()).toContain('✓ Supervisor      already installed');
    expect(w.shells.filter((c) => c.args[0] === 'service' && c.args[1] === 'install')).toHaveLength(0);
    // The one machine-level question is asked exactly once per invocation.
    expect(w.shells.filter((c) => c.args[0] === 'service' && c.args[1] === 'status')).toHaveLength(1);
    expect(shellArgs(w, 'bind')).toHaveLength(1);
  });

  test('an edited manifest PATCHes on the digest change, and the unchanged one is a no-op', async () => {
    const dir = departmentProject();
    const w = makeWorld({
      cwd: dir,
      cloud: {
        departments: [
          { id: DEPT_ID, slug: 'unity-review', manifestDigest: 'sha256:stale', enabled: true, retired: false },
        ],
      },
      shell: { identityRunnerId: RUNNER_ID, serviceInstalled: true },
    });

    const code = await runDepartmentServe([], w.deps);

    expect(code).toBe(0);
    expect(w.out()).toContain('(manifest changed)');
    const patch = w.fetches.find((f) => f.init.method === 'PATCH')!;
    expect(patch.url).toBe(`${SERVER}/api/v1/departments/${DEPT_ID}`);
    expect(String(bodyOf(patch)['manifest_digest'])).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(w.fetches.filter((f) => f.init.method === 'POST' && f.url.endsWith('/departments'))).toHaveLength(0);
  });

  test('interrupted after step 6 (bound): the re-run re-binds and claims, still exactly once each', async () => {
    const dir = departmentProject();
    const first = makeWorld({ cwd: dir, cloud: { claimStatus: 500 }, shell: { identityRunnerId: RUNNER_ID } });
    expect(await runDepartmentServe([], first.deps)).toBe(1);
    expect(first.err()).toContain('the install could not be claimed');

    const digest = String(bodyOf(first.fetches.find((f) => f.init.method === 'POST' && f.url.endsWith('/departments'))!)['manifest_digest']);
    const second = makeWorld({
      cwd: dir,
      cloud: {
        departments: [{ id: DEPT_ID, slug: 'unity-review', manifestDigest: digest, enabled: true, retired: false }],
        claimBody: { install: { id: INSTALL_ID, pendingApproval: false }, changed: false, approval_policy: 'auto-admin' },
      },
      shell: { identityRunnerId: RUNNER_ID, serviceInstalled: true },
    });

    expect(await runDepartmentServe([], second.deps)).toBe(0);
    expect(shellArgs(second, 'bind')).toHaveLength(1);
    expect(second.fetches.filter((f) => f.url.includes('/installs'))).toHaveLength(1);
    expect(second.out()).toContain('● unity-review — online');
  });
});

// ---------------------------------------------------------------------------
// DoD box 3 — every failure row's stated message and exit code
// ---------------------------------------------------------------------------

describe('serve — DoD box 3: 05 §5\'s failure table', () => {
  test('row 1 (validate): the findings, exit 1, and not one network call', async () => {
    const dir = departmentProject('name: unity-review\nruntime:\n  engine: pipeline\n');
    const w = makeWorld({ cwd: dir });

    const code = await runDepartmentServe([], w.deps);

    expect(code).toBe(1);
    expect(w.err()).toContain('description');
    expect(w.err()).toContain('skills');
    expect(w.err()).toContain('Nothing was registered');
    expect(w.fetches).toEqual([]);
  });

  test('a missing manifest is exit 2 (05 §4\'s class), never exit 1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dept-empty-'));
    created.push(dir);
    const w = makeWorld({ cwd: dir });

    const code = await runDepartmentServe([], w.deps);

    expect(code).toBe(2);
    expect(w.err()).toContain('no department.yml');
    expect(w.fetches).toEqual([]);
  });

  test('row 2 (auth): the ladder\'s own message, and nothing registered', async () => {
    const dir = departmentProject();
    const w = makeWorld({ cwd: dir, authError: 'That machine token was rejected (expired or revoked).' });

    const code = await runDepartmentServe([], w.deps);

    expect(code).toBe(1);
    expect(w.err()).toContain('That machine token was rejected');
    expect(w.err()).toContain('Nothing was registered');
    expect(w.fetches).toEqual([]);
  });

  test('offline: nothing was registered, local pipelines unaffected', async () => {
    const dir = departmentProject();
    const w = makeWorld({ cwd: dir, cloud: { offlineOn: '/api/v1/departments' } });

    const code = await runDepartmentServe([], w.deps);

    expect(code).toBe(1);
    // The API host that failed to resolve — not the dashboard origin.
    expect(w.err()).toContain('Could not reach api.example.dev');
    expect(w.err()).toContain('nothing was registered');
    expect(w.err()).toContain('Your local pipelines are unaffected.');
  });

  test('row 4 (slug taken): the department name is named, and so is the recovery', async () => {
    const dir = departmentProject();
    const w = makeWorld({ cwd: dir, cloud: { createStatus: 409, createBody: { error: 'a department with this slug already exists' } } });

    const code = await runDepartmentServe([], w.deps);

    expect(code).toBe(1);
    expect(w.err()).toContain(`A department named 'unity-review' already exists in ${ORG}.`);
    expect(w.err()).toContain('Rename this department');
  });

  test('row 4 (department limit): c8\'s named 402 message is relayed verbatim — never a bare 402', async () => {
    const dir = departmentProject();
    const limit = 'Your plan includes 3 departments and you have 3. Retire one, or upgrade at https://ai-pipeline.dev/billing.';
    const w = makeWorld({ cwd: dir, cloud: { createStatus: 402, createBody: { error: limit, limit: 3, current: 3 } } });

    const code = await runDepartmentServe([], w.deps);

    expect(code).toBe(1);
    expect(w.err()).toContain(limit);
    expect(w.err()).not.toContain('HTTP 402');
  });

  test('row 5 (runner enrolment): registered, but this machine could not be enrolled', async () => {
    const dir = departmentProject();
    const runnerLimit = 'Your plan includes 1 runner and this org already has one. Serve from that machine, or upgrade at https://ai-pipeline.dev/billing.';
    const w = makeWorld({ cwd: dir, cloud: { mintStatus: 402, mintBody: { error: runnerLimit } } });

    const code = await runDepartmentServe([], w.deps);

    expect(code).toBe(1);
    expect(w.err()).toContain('Registered, but this machine could not be enrolled:');
    expect(w.err()).toContain(runnerLimit);
    expect(w.err()).toContain('stays registered and offline');
    expect(shellArgs(w, 'bind')).toHaveLength(0);
  });

  test('row 7 (service install): registered and bound, but the supervisor could not be installed', async () => {
    const dir = departmentProject();
    const w = makeWorld({ cwd: dir, shell: { serviceInstallCode: 1, serviceInstallStderr: 'systemd is not available' } });

    const code = await runDepartmentServe([], w.deps);

    expect(code).toBe(1);
    expect(w.err()).toContain('Registered and bound, but the supervisor could not be installed:');
    expect(w.err()).toContain('systemd is not available');
    expect(w.err()).toContain('pipeline-runner service install');
    expect(w.fetches.some((f) => f.url.includes('/installs'))).toBe(false);
  });

  test('row 8 (claim): registered, but the install could not be claimed', async () => {
    const dir = departmentProject();
    const w = makeWorld({ cwd: dir, cloud: { claimStatus: 404, claimBody: { error: 'runner not found' } } });

    const code = await runDepartmentServe([], w.deps);

    expect(code).toBe(1);
    expect(w.err()).toContain('Registered, but the install could not be claimed: runner not found');
    expect(w.err()).toContain('Re-run to try again.');
  });

  test('a warning found at step 1 is still shown when a later step fails', async () => {
    // Warnings are said where they are FOUND, not batched at the end — a run
    // that dies at step 8 must not swallow what step 1 noticed.
    const dir = departmentProject(departmentYaml().replace('visibility: organization\n', ''));
    const w = makeWorld({ cwd: dir, cloud: { claimStatus: 500 } });

    const code = await runDepartmentServe([], w.deps);

    expect(code).toBe(1);
    expect(w.out()).toContain("⚠ visibility: not set — defaults to 'organization'");
    expect(w.err()).toContain('the install could not be claimed');
  });

  test('an admin-only PATCH refusal names the role and the way out', async () => {
    const dir = departmentProject();
    const w = makeWorld({
      cwd: dir,
      cloud: {
        departments: [{ id: DEPT_ID, slug: 'unity-review', manifestDigest: 'sha256:stale', enabled: true, retired: false }],
        patchStatus: 403,
      },
    });

    const code = await runDepartmentServe([], w.deps);

    expect(code).toBe(1);
    expect(w.err()).toContain('needs the admin role');
  });

  test('a step-4 failure reports state "not-registered" in --json — never a state the org does not have', async () => {
    const dir = departmentProject();
    const w = makeWorld({ cwd: dir, cloud: { createStatus: 402, createBody: { error: 'plan ceiling' } } });

    const code = await runDepartmentServe(['--json'], w.deps);

    expect(code).toBe(1);
    const payload = JSON.parse(w.out()) as Record<string, unknown>;
    expect(payload['ok']).toBe(false);
    expect(payload['state']).toBe('not-registered');
    expect(String(payload['error'])).toContain('plan ceiling');
    expect((payload['department'] as Record<string, unknown>)['id']).toBeNull();
  });

  test('a machine enrolled against another control plane is warned about, not silently 404ed later', async () => {
    const dir = departmentProject();
    const w = makeWorld({ cwd: dir, shell: { identityRunnerId: RUNNER_ID, serviceInstalled: true } });
    // The fake identity reports SERVER; serve to a different one.
    w.deps.authenticate = async () => ({
      server: 'https://api.other.dev',
      accessToken: 't',
      orgSlug: ORG,
      orgId: ORG_ID,
      credentialPath: '/nowhere',
      now: 1,
    });

    await runDepartmentServe([], w.deps);

    expect(w.out()).toContain('registered as a runner against https://api.example.dev');
    expect(w.out()).toContain('but you are serving to https://api.other.dev');
  });

  test('--machine-token with --device is a usage error (exit 2), before any I/O', async () => {
    const dir = departmentProject();
    const w = makeWorld({ cwd: dir });

    const code = await runDepartmentServe(['--machine-token', 'aip_m_x.y', '--device'], w.deps);

    expect(code).toBe(2);
    expect(w.err()).toContain('cannot be combined with --device');
    expect(w.fetches).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// DoD box 4 — registered but not serving is never reported as online
// ---------------------------------------------------------------------------

describe('serve — DoD box 4: ○ registered — not serving, never a bare online', () => {
  test('an engine with no module on this machine is refused BEFORE anything is registered', async () => {
    // `claude-code` is `department new`'s own default and its engine module is
    // task b3 — pipeline-runner registers only jsonl-process, container and
    // pipeline-drive today, so this department could not execute one task.
    const dir = departmentProject(departmentYaml({ engine: 'claude-code' }));
    const w = makeWorld({ cwd: dir });

    const code = await runDepartmentServe([], w.deps);

    expect(code).toBe(1);
    expect(w.err()).toContain("no engine module for 'claude-code'");
    expect(w.err()).toContain('Servable engines today: pipeline, process, container');
    expect(w.err()).toContain('Nothing was registered');
    expect(w.out()).not.toContain('online');
    // Nothing reached the control plane, and nothing was bound locally.
    expect(w.fetches).toEqual([]);
    expect(w.shells).toEqual([]);
  });

  test('--foreground installs no service and reports not-serving with the command to run', async () => {
    const dir = departmentProject();
    const w = makeWorld({ cwd: dir });

    const code = await runDepartmentServe(['--foreground'], w.deps);

    expect(code).toBe(1);
    expect(w.out()).toContain('pipeline-runner start');
    expect(w.out()).toContain('○ unity-review — registered — not serving');
    expect(w.shells.filter((c) => c.args[0] === 'service' && c.args[1] === 'install')).toHaveLength(0);
  });

  test('a pending approval is ⏸ with the admin URL — a success, not a failure', async () => {
    const dir = departmentProject();
    const w = makeWorld({
      cwd: dir,
      cloud: {
        claimBody: {
          install: { id: INSTALL_ID, pendingApproval: true },
          changed: true,
          auto_approved: false,
          approval_policy: 'always',
        },
      },
    });

    const code = await runDepartmentServe([], w.deps);

    expect(code).toBe(0);
    expect(w.out()).toContain('⏸ unity-review — waiting for an admin to approve');
    expect(w.out()).toContain('https://example.dev/departments/unity-review');
    expect(w.out()).toContain("You'll be notified when it's approved.");
    expect(w.out()).not.toContain('● unity-review');
  });
});

// ---------------------------------------------------------------------------
// pure units
// ---------------------------------------------------------------------------

describe('department-serve pure helpers', () => {
  test('appOriginFor strips only a leading api. label', () => {
    expect(appOriginFor('https://api.ai-pipeline.dev')).toBe('https://ai-pipeline.dev');
    expect(appOriginFor('http://localhost:3000')).toBe('http://localhost:3000');
    expect(appOriginFor('https://pipeline.example.com')).toBe('https://pipeline.example.com');
    expect(departmentUrlFor('https://api.ai-pipeline.dev', 'unity-review')).toBe(
      'https://ai-pipeline.dev/departments/unity-review',
    );
  });

  test('renderState never renders "online" for a department that is not serving', () => {
    expect(renderState('online', 'd')).toContain('● d — online');
    expect(renderState('waiting-approval', 'd')).toContain('⏸ d — waiting for an admin');
    const notServing = renderState('registered-not-serving', 'd', 'because');
    expect(notServing).toContain('○ d — registered — not serving');
    expect(notServing).not.toContain('online');
  });

  test('an engine that names its own command binds it, args and cwd included', () => {
    const { manifest } = parseDepartmentManifest(
      departmentYaml({
        engine: 'process',
        extra: '  command: ./bin/dept\n  args: ["serve", "--stdio"]\n  workingDirectory: sub\n',
      }),
    );
    const result = runtimeBindingFor(manifest!, { manifestDir: '/dept' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.binding.adapterId).toBe('jsonl-process');
    expect(result.binding.command).toBe('./bin/dept');
    expect(result.binding.args).toEqual(['serve', '--stdio']);
    expect(result.binding.cwd).toBe(resolve('/dept', 'sub'));
    expect(buildBindArgs('id', result.binding)).toEqual([
      'bind',
      '--department',
      'id',
      '--adapter',
      'jsonl-process',
      '--command',
      './bin/dept',
      '--arg',
      'serve',
      '--arg',
      '--stdio',
      '--cwd',
      resolve('/dept', 'sub'),
      '--lifecycle',
      'per-task',
    ]);
  });

  test('runtime.environment cannot be conveyed by bind, and the operator is told', () => {
    const { manifest } = parseDepartmentManifest(
      departmentYaml({
        engine: 'process',
        extra: '  command: ./bin/dept\n  environment:\n    values:\n      MODE: production\n',
      }),
    );
    const result = runtimeBindingFor(manifest!, { manifestDir: '/dept' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.binding.warnings.join(' ')).toContain('runtime.environment is not conveyed');
  });

  test('engine: pipeline without startIteration is refused — the store would drop the spec', () => {
    const { manifest } = parseDepartmentManifest(
      'name: d\ndescription: x\nskills:\n  - id: s\n    name: S\n    description: y\nruntime:\n  engine: pipeline\n  pipelineRoot: .claude/pipeline/review\n',
    );
    const result = runtimeBindingFor(manifest!, { manifestDir: '/dept' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('runtime.startIteration');
  });
});
