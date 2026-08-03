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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runDepartmentServe, runDepartmentValidate, type ServeCommandDeps } from '../src/commands/department';
import {
  appOriginFor,
  assessLiveness,
  bindRuntime,
  buildBindArgs,
  departmentUrlFor,
  describeAdapterRegistryDrift,
  localSupervisorIsUp,
  parseAdapterRefusal,
  readLocalDaemonState,
  renderState,
  runtimeBindingFor,
  type ServeHttpInit,
  type ServeHttpResponse,
} from '../src/lib/department-serve';
import {
  buildRegistrationRequest,
  enginesWithAgentEntrypoint,
  ENGINES,
  parseDepartmentManifest,
} from '../src/lib/department-manifest';
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
    engine === 'pipeline' ? '  pipelineRoot: .pipeline/review\n  startIteration: steps/01-plan.md\n' : '';
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
  const pipelineRoot = join(dir, '.pipeline', 'review');
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
  /**
   * x13: what `GET /api/v1/departments/:id` reports for `online` — the ONE
   * authority for the word `online`, and the read `serve` had never made.
   * Defaults to `true` (a healthy machine), so every pre-existing test keeps
   * asserting the transcript it always asserted.
   */
  profileOnline?: boolean;
  /** x13: `online` answers, in order, for the retry path — the last one
   *  sticks. Overrides `profileOnline` when present. */
  profileOnlineSequence?: boolean[];
  /** x13: make the profile read itself fail (a non-200), so the
   *  "could not confirm" branch is reachable without breaking every other
   *  call the way `offlineOn` would. */
  profileStatus?: number;
}

interface ShellScript {
  /** Does this machine already have a supervisor service? */
  serviceInstalled?: boolean;
  /** x13: and is it RUNNING? Only meaningful with `serviceInstalled: true`;
   *  defaults to `running`, which is what the fake always used to report. */
  serviceState?: 'running' | 'stopped' | 'unknown';
  /** x13: what `service status` reports AFTER a successful `service install`
   *  (the second read). Defaults to `running` — every backend's `install`
   *  starts the service. */
  serviceStateAfterInstall?: 'running' | 'stopped' | 'unknown';
  /** Existing runner identity (a machine that is already enrolled). */
  identityRunnerId?: string | null;
  registerCode?: number;
  registerStderr?: string;
  bindCode?: number;
  bindStderr?: string;
  /**
   * x39: which of b1's four `signalSupervisorReload()` lines `pipeline-runner
   * bind` ends with — the ONE local observation that can see a supervisor
   * PROCESS (foreground included), which `service status` structurally
   * cannot. `undefined` = the line is absent entirely (an older
   * `pipeline-runner`, or an output-format drift), which must degrade to
   * "not observed" and never to a guess — so every test written before x39
   * keeps exercising exactly the evidence it always had.
   */
  bindDaemon?: 'none' | 'running-win' | 'signalled' | 'signal-failed';
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
  let profileReads = 0;
  let serviceStatusReads = 0;

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
      // x13: step 9's confirmation read — the department's own profile.
      if (url.endsWith(`/api/v1/departments/${DEPT_ID}`) && init.method === 'GET') {
        profileReads++;
        const status = cloud.profileStatus ?? 200;
        if (status !== 200) return reply(status, { error: 'profile unavailable' });
        const seq = cloud.profileOnlineSequence;
        const online =
          seq !== undefined
            ? (seq[Math.min(profileReads - 1, seq.length - 1)] ?? false)
            : (cloud.profileOnline ?? true);
        return reply(200, {
          department: { id: DEPT_ID, slug: 'unity-review', enabled: true, retired: false, online, manifestDigest: null },
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
        serviceStatusReads++;
        // x13: the FIRST read is the machine as `serve` found it; a second
        // read only ever happens after this run installed a service, and must
        // therefore describe the machine as this run left it.
        const state =
          serviceStatusReads > 1
            ? (sh.serviceStateAfterInstall ?? 'running')
            : sh.serviceInstalled
              ? (sh.serviceState ?? 'running')
              : null;
        if (state === null) {
          return { code: 0, stdout: '[pipeline-runner] pipeline-runner.service is not installed\n', stderr: '' };
        }
        return {
          code: 0,
          stdout: `[pipeline-runner] pipeline-runner.service: ${state} (enabled)\n`,
          stderr: '',
        };
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
        // b1's `runBind` prints the store line, then `signalSupervisorReload()`
        // prints exactly one of these — verbatim from pipeline-runner's
        // `src/cli.ts`, so a drift on either side breaks a test here rather
        // than a user's transcript.
        const reload =
          sh.bindDaemon === 'none'
            ? '[pipeline-runner] no supervisor is running for this home — the change applies at the next `start`.\n'
            : sh.bindDaemon === 'running-win'
              ? '[pipeline-runner] supervisor pid 4242 is running — it picks this up automatically (file watch).\n'
              : sh.bindDaemon === 'signalled'
                ? '[pipeline-runner] signalled supervisor pid 4242 (SIGHUP) to reload.\n'
                : sh.bindDaemon === 'signal-failed'
                  ? '[pipeline-runner] could not signal pid 4242 (EPERM) — its file watch still picks the change up.\n'
                  : '';
        return {
          code: sh.bindCode ?? 0,
          stdout: sh.bindCode ? '' : `[pipeline-runner] bound … (…/departments.json)\n${reload}`,
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
    // x13: step 9's backoff, made instant. A real `sleep` here would put up to
    // 15 seconds of wall clock into any test that exercises the retry.
    sleep: async () => {},
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
    // particular no `.pipeline/cloud.json` (which would pin a clonable
    // repo to one org and one server).
    expect(listFilesRel(dir)).toEqual(before);
    expect(existsSync(join(dir, '.pipeline', 'cloud.json'))).toBe(false);
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
    expect(payload['url']).toBe('https://api.example.dev/departments/unity-review');
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
    expect(spec.pipelineDrive.pipelineRoot).toBe(resolve(dir, '.pipeline/review'));
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
  test('an engine that does not exist at all is refused BEFORE anything is registered', async () => {
    // The refusal x32 kept. `codex` is named in the design as a planned engine
    // and is deliberately absent from the registry (as it is from
    // pipeline-runner's `ENGINE_NAMES`), so nothing on this machine could
    // execute a task for it — and a cloud record for it would be inert.
    const dir = departmentProject(departmentYaml({ engine: 'codex' }));
    const w = makeWorld({ cwd: dir });

    const code = await runDepartmentServe([], w.deps);

    expect(code).toBe(1);
    expect(w.err()).toContain("'codex' is not supported yet");
    expect(w.err()).toContain('claude-code, pipeline, process, container');
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
    expect(w.out()).toContain('https://api.example.dev/departments/unity-review');
    expect(w.out()).toContain("You'll be notified when it's approved.");
    expect(w.out()).not.toContain('● unity-review');
  });
});

// ---------------------------------------------------------------------------
// x13 — `serve` never claims an outcome it has not observed
// ---------------------------------------------------------------------------
//
// The defect: `serve` ended with `● <slug> — online, ready for work` after
// writing a local binding, having checked nothing. In the `e2` gate that line
// was printed while the control plane reported `online: false`, because the
// machine's supervisor service was `stopped (auto-start)`.
//
// Three outcomes, three transcripts, three exit codes:
//   verified live      ● online, ready for work                       exit 0
//   bound, not live    ○ registered — not serving (<why>) + the fix   exit 1
//   undetermined       ◌ could not confirm it is live (<why>)         exit 0

describe('serve — x13: the online claim is an observation, not an assumption', () => {
  test('VERIFIED LIVE: the claim is made only after the control plane says so', async () => {
    const dir = departmentProject();
    const w = makeWorld({ cwd: dir, cloud: { profileOnline: true } });

    const code = await runDepartmentServe([], w.deps);

    expect(code).toBe(0);
    expect(w.out()).toContain('● unity-review — online, ready for work');
    // The claim rests on a real read of the ONE authority for the word.
    const profileReads = w.fetches.filter(
      (f) => f.url === `${SERVER}/api/v1/departments/${DEPT_ID}` && f.init.method === 'GET',
    );
    expect(profileReads).toHaveLength(1);
  });

  test('BOUND BUT NOT LIVE: the e2 gate, reproduced — a stopped supervisor never reads as online', async () => {
    const dir = departmentProject();
    const w = makeWorld({
      cwd: dir,
      // The machine exactly as the e2 gate found it: a supervisor service that
      // exists and is not running, and a control plane that says so.
      shell: { serviceInstalled: true, serviceState: 'stopped', identityRunnerId: RUNNER_ID },
      cloud: { profileOnline: false },
    });

    const code = await runDepartmentServe([], w.deps);

    expect(code).toBe(1);
    const out = w.out();
    expect(out).not.toContain('online, ready for work');
    expect(out).toContain('○ unity-review — registered — not serving');
    expect(out).toContain("this machine's supervisor service is installed but NOT running");
    // Actionable: the fix is named, not left for the user to discover — and
    // since x24 the named fix is the verb that STARTS the installed service
    // rather than the one that stop+deletes+recreates it (x44).
    expect(out).toContain('Start it:  pipeline-runner service start');
    expect(out).not.toContain('Start it:  pipeline-runner service install');
    // …and the supervisor step said so where it was found, too.
    expect(out).toContain('⚠ Supervisor      already installed, but NOT running');
    // D26 is intact: a stopped service is still a service, so no rival one.
    expect(w.shells.filter((c) => c.args[0] === 'service' && c.args[1] === 'install')).toHaveLength(0);
    // Everything `serve` actually DOES still happened — this is an honest
    // report of an incomplete outcome, not an aborted run.
    expect(shellArgs(w, 'bind')).toHaveLength(1);
    expect(w.fetches.some((f) => f.url.includes('/installs'))).toBe(true);
  });

  test('BOUND BUT NOT LIVE survives the network: a stopped supervisor is a LOCAL fact', async () => {
    const dir = departmentProject();
    const w = makeWorld({
      cwd: dir,
      shell: { serviceInstalled: true, serviceState: 'stopped', identityRunnerId: RUNNER_ID },
      cloud: { profileStatus: 503 },
    });

    const code = await runDepartmentServe([], w.deps);

    expect(code).toBe(1);
    expect(w.out()).toContain('○ unity-review — registered — not serving');
    expect(w.out()).toContain('installed but NOT running');
    expect(w.out()).not.toContain('could not confirm');
  });

  test('a supervisor that is not running is never WAITED for — one read, not five', async () => {
    const dir = departmentProject();
    const w = makeWorld({
      cwd: dir,
      shell: { serviceInstalled: true, serviceState: 'stopped', identityRunnerId: RUNNER_ID },
      cloud: { profileOnline: false },
    });

    await runDepartmentServe([], w.deps);

    expect(
      w.fetches.filter((f) => f.url === `${SERVER}/api/v1/departments/${DEPT_ID}` && f.init.method === 'GET'),
    ).toHaveLength(1);
    expect(w.out()).not.toContain('waiting for the supervisor to report in');
  });

  test('a RUNNING supervisor the cloud has not seen yet is waited for, briefly, then reported honestly', async () => {
    const dir = departmentProject();
    const w = makeWorld({
      cwd: dir,
      shell: { serviceInstalled: true, serviceState: 'running', identityRunnerId: RUNNER_ID },
      cloud: { profileOnline: false },
    });

    const code = await runDepartmentServe([], w.deps);

    expect(code).toBe(1);
    // 1 first read + 4 backoff re-reads, and then it stops.
    expect(
      w.fetches.filter((f) => f.url === `${SERVER}/api/v1/departments/${DEPT_ID}` && f.init.method === 'GET'),
    ).toHaveLength(5);
    const out = w.out();
    expect(out).toContain('· Confirming      waiting for the supervisor to report in');
    expect(out).toContain('○ unity-review — registered — not serving');
    expect(out).toContain(`does not see it connected`);
    expect(out).toContain('Check the runner:  pipeline-runner status');
    expect(out).not.toContain('online, ready for work');
  });

  test('the fresh-install race is not reported as a failure: a late `online` still ends in ● online', async () => {
    // A machine that had no service: step 7 installs and starts one, and the
    // supervisor's gateway connection lands a moment after `serve` first asks.
    const dir = departmentProject();
    const w = makeWorld({ cwd: dir, cloud: { profileOnlineSequence: [false, false, true] } });

    const code = await runDepartmentServe([], w.deps);

    expect(code).toBe(0);
    expect(w.out()).toContain('● unity-review — online, ready for work');
    expect(
      w.fetches.filter((f) => f.url === `${SERVER}/api/v1/departments/${DEPT_ID}` && f.init.method === 'GET'),
    ).toHaveLength(3);
  });

  test('UNDETERMINED: an unreadable control plane is not "online" and is not a failure either', async () => {
    const dir = departmentProject();
    const w = makeWorld({
      cwd: dir,
      shell: { serviceInstalled: true, serviceState: 'running', identityRunnerId: RUNNER_ID },
      cloud: { profileStatus: 500 },
    });

    const code = await runDepartmentServe([], w.deps);

    // Every step `serve` controls succeeded; only the confirmation did not.
    expect(code).toBe(0);
    const out = w.out();
    expect(out).not.toContain('online, ready for work');
    expect(out).toContain('◌ unity-review — registered and bound; could not confirm it is live');
    expect(out).toContain('Check it:  pipeline department status');
  });

  test('a supervisor whose own state cannot be read is "unknown", never assumed running', async () => {
    const dir = departmentProject();
    const w = makeWorld({
      cwd: dir,
      shell: { serviceInstalled: true, serviceState: 'unknown', identityRunnerId: RUNNER_ID },
      cloud: { profileOnline: false },
    });

    const code = await runDepartmentServe([], w.deps);

    expect(code).toBe(1);
    expect(w.out()).toContain('· Supervisor      already installed (its state could not be read)');
    expect(w.out()).toContain("this machine's supervisor state could not be read");
    expect(w.out()).toContain('pipeline-runner service status');
  });

  test('an install that reports 0 but leaves nothing running is not reported as ready', async () => {
    // Windows' backend runs `sc start` best-effort — its exit code is
    // deliberately not checked — so `service install` exiting 0 is not by
    // itself evidence that a supervisor is running.
    const dir = departmentProject();
    const w = makeWorld({ cwd: dir, shell: { serviceStateAfterInstall: 'stopped' }, cloud: { profileOnline: false } });

    const code = await runDepartmentServe([], w.deps);

    expect(code).toBe(1);
    expect(w.out()).toContain('⚠ Supervisor      installed, but it is not running');
    expect(w.out()).toContain('○ unity-review — registered — not serving');
    expect(w.out()).not.toContain('online, ready for work');
    // The world changed under `serve`, so it looked again — and only then.
    expect(w.shells.filter((c) => c.args[0] === 'service' && c.args[1] === 'status')).toHaveLength(2);
  });

  test('a department the cloud reports online while THIS machine is down says both', async () => {
    const dir = departmentProject();
    const w = makeWorld({
      cwd: dir,
      // x39: the service is down AND the runner says nothing holds this home,
      // which is what licenses the "somewhere else" half of the sentence.
      shell: { serviceInstalled: true, serviceState: 'stopped', identityRunnerId: RUNNER_ID, bindDaemon: 'none' },
      cloud: { profileOnline: true },
    });

    const code = await runDepartmentServe([], w.deps);

    expect(code).toBe(1);
    expect(w.out()).toContain('installed but NOT running');
    expect(w.out()).toContain('served from somewhere else (another machine, or another runner home on this one)');
    expect(w.out()).not.toContain('online, ready for work');
  });

  test('--json carries the same three-way distinction, and never spells "not observed" as false', async () => {
    const dir = departmentProject();
    const w = makeWorld({
      cwd: dir,
      shell: { serviceInstalled: true, serviceState: 'stopped', identityRunnerId: RUNNER_ID },
      cloud: { profileStatus: 503 },
    });

    const code = await runDepartmentServe(['--json'], w.deps);

    expect(code).toBe(1);
    const payload = JSON.parse(w.out()) as Record<string, unknown>;
    expect(payload['ok']).toBe(false);
    expect(payload['state']).toBe('registered-not-serving');
    const liveness = payload['liveness'] as Record<string, unknown>;
    expect(liveness['verdict']).toBe('not-live');
    expect(liveness['supervisorState']).toBe('stopped');
    // The distinction the whole task is about: "not observed" is null, not false.
    expect(liveness['cloudOnline']).toBeNull();
    expect(String(liveness['reason'])).toContain('installed but NOT running');
    expect(String(liveness['nextStep'])).toContain('pipeline-runner service start');
    // D27: `--json` is one object on stdout, every progress line on stderr,
    // and the non-interactive flag rides down the auth ladder untouched.
    expect(w.err()).toContain('✓ Registered');
    expect(w.out().trimEnd().endsWith('}')).toBe(true);
  });

  test('--json on a live department reports the verdict and the evidence behind it', async () => {
    const dir = departmentProject();
    const w = makeWorld({ cwd: dir, cloud: { profileOnline: true } });

    expect(await runDepartmentServe(['--json'], w.deps)).toBe(0);

    const payload = JSON.parse(w.out()) as Record<string, unknown>;
    expect(payload['state']).toBe('online');
    // x39: BOTH local probes are reported, and the process one says
    // `unknown` — this fake `bind` prints no reload line, and "not observed"
    // is spelled as itself rather than inferred from the service state.
    expect(payload['liveness']).toEqual({
      verdict: 'live',
      supervisorState: 'running',
      localDaemon: 'unknown',
      cloudOnline: true,
    });
  });

  test('--json on an unconfirmed run is ok:true with state "unconfirmed" — never ok:true with state "online"', async () => {
    const dir = departmentProject();
    const w = makeWorld({
      cwd: dir,
      shell: { serviceInstalled: true, serviceState: 'running', identityRunnerId: RUNNER_ID },
      cloud: { profileStatus: 500 },
    });

    expect(await runDepartmentServe(['--json'], w.deps)).toBe(0);

    const payload = JSON.parse(w.out()) as Record<string, unknown>;
    expect(payload['ok']).toBe(true);
    expect(payload['state']).toBe('unconfirmed');
    const liveness = payload['liveness'] as Record<string, unknown>;
    expect(liveness['verdict']).toBe('undetermined');
    expect(liveness['cloudOnline']).toBeNull();
    expect(String(liveness['cloudError']).length).toBeGreaterThan(0);
  });

  test('D27 is intact: `--json` still declines the interactive ladder', async () => {
    const dir = departmentProject();
    const w = makeWorld({ cwd: dir });
    let sawJson: boolean | undefined;
    const inner = w.deps.authenticate;
    w.deps.authenticate = async (opts) => {
      sawJson = opts.json;
      return await inner(opts);
    };

    await runDepartmentServe(['--json'], w.deps);

    expect(sawJson).toBe(true);
  });

  test('--foreground on a machine that has no supervisor still refuses to claim online', async () => {
    // x13 must not undo a9's own rule, nor duplicate it: `--foreground` runs
    // through the SAME verification, and lands on the same answer.
    const dir = departmentProject();
    const w = makeWorld({ cwd: dir, cloud: { profileOnline: false } });

    const code = await runDepartmentServe(['--foreground'], w.deps);

    expect(code).toBe(1);
    expect(w.out()).toContain('○ unity-review — registered — not serving');
    expect(w.out()).toContain('no supervisor service on this machine (--foreground)');
    expect(w.out()).toContain('Run one here:  pipeline-runner start');
  });

  test('--foreground on a machine that DOES have a running, connected supervisor tells the truth', async () => {
    // The old code printed "no supervisor service on this machine" for every
    // `--foreground` run — its own small unverified claim, in the other
    // direction. The evidence decides now.
    const dir = departmentProject();
    const w = makeWorld({
      cwd: dir,
      shell: { serviceInstalled: true, serviceState: 'running', identityRunnerId: RUNNER_ID },
      cloud: { profileOnline: true },
    });

    const code = await runDepartmentServe(['--foreground'], w.deps);

    expect(code).toBe(0);
    expect(w.out()).toContain('● unity-review — online, ready for work');
    expect(w.shells.filter((c) => c.args[0] === 'service' && c.args[1] === 'install')).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // x39 — `serve --foreground` against a machine that IS serving, in the
  // foreground, with no service installed: the P4 gate's transcript.
  // -------------------------------------------------------------------------

  test('x39: `serve --foreground` on a live FOREGROUND supervisor reports online, not "another machine"', async () => {
    // Exactly the machine the P4 gate drove: no service (that is what
    // `--foreground` MEANS), a daemon running in the foreground, and a
    // control plane that agrees the department is online. x13 read the
    // verdict off `service status` alone and printed
    // `registered — not serving … another machine is serving it, but this one
    // is not`, exit 1, about the very machine that was serving it.
    const dir = departmentProject();
    const w = makeWorld({
      cwd: dir,
      shell: { serviceInstalled: false, identityRunnerId: RUNNER_ID, bindDaemon: 'signalled' },
      cloud: { profileOnline: true },
    });

    const code = await runDepartmentServe(['--foreground'], w.deps);

    expect(code).toBe(0);
    expect(w.out()).toContain('✓ Supervisor      a foreground supervisor is running here');
    expect(w.out()).toContain('● unity-review — online, ready for work');
    expect(w.out()).not.toContain('registered — not serving');
    expect(w.out()).not.toContain('another machine');
    // No service was installed, and none was asked for.
    expect(w.shells.filter((c) => c.args[0] === 'service' && c.args[1] === 'install')).toHaveLength(0);
  });

  test('x39: --json carries the process observation next to the service one', async () => {
    const dir = departmentProject();
    const w = makeWorld({
      cwd: dir,
      shell: { serviceInstalled: false, identityRunnerId: RUNNER_ID, bindDaemon: 'running-win' },
      cloud: { profileOnline: true },
    });

    expect(await runDepartmentServe(['--foreground', '--json'], w.deps)).toBe(0);

    const payload = JSON.parse(w.out()) as Record<string, unknown>;
    expect(payload['state']).toBe('online');
    expect(payload['liveness']).toEqual({
      verdict: 'live',
      supervisorState: 'not-installed',
      localDaemon: 'running',
      cloudOnline: true,
    });
    // D27: still one object on stdout, every progress line on stderr, and
    // this run declined every optional side effect exactly as before.
    expect(w.err()).toContain('✓ Registered');
    expect(w.out().trimEnd().endsWith('}')).toBe(true);
    expect(w.shells.filter((c) => c.args[0] === 'service' && c.args[1] === 'install')).toHaveLength(0);
  });

  test('x39: `--foreground` with NO supervisor running still exits 1 — x13\'s contract survives', async () => {
    // The other direction. The runner itself says nothing holds this home, so
    // the not-live verdict is earned rather than inferred, and the "somewhere
    // else" half of the sentence is licensed by that same observation.
    const dir = departmentProject();
    const w = makeWorld({
      cwd: dir,
      shell: { serviceInstalled: false, identityRunnerId: RUNNER_ID, bindDaemon: 'none' },
      cloud: { profileOnline: true },
    });

    const code = await runDepartmentServe(['--foreground'], w.deps);

    expect(code).toBe(1);
    expect(w.out()).toContain('○ unity-review — registered — not serving');
    expect(w.out()).toContain('None is running here either');
    expect(w.out()).toContain('no supervisor service on this machine (--foreground)');
    expect(w.out()).toContain("no supervisor process is running in this machine's runner home either");
    expect(w.out()).toContain('served from somewhere else');
    expect(w.out()).toContain('Run one here:  pipeline-runner start');
    expect(w.out()).not.toContain('online, ready for work');
  });

  test('x39: a stopped SERVICE next to a running process is reported as both, not as neither', async () => {
    const dir = departmentProject();
    const w = makeWorld({
      cwd: dir,
      shell: {
        serviceInstalled: true,
        serviceState: 'stopped',
        identityRunnerId: RUNNER_ID,
        bindDaemon: 'signal-failed',
      },
      cloud: { profileOnline: true },
    });

    const code = await runDepartmentServe([], w.deps);

    expect(code).toBe(0);
    expect(w.out()).toContain('⚠ Supervisor      the installed service is NOT running — but a supervisor process is holding this runner home');
    expect(w.out()).toContain('● unity-review — online, ready for work');
    expect(w.out()).not.toContain('another machine');
  });

  test('x39: a foreground supervisor gets the confirm backoff a service one always got', async () => {
    // The backoff exists for a supervisor that is coming up but has not
    // reported in yet. Keyed off `service status` alone, a `--foreground` run
    // gave the one supervisor it expects to exist zero seconds to connect.
    const dir = departmentProject();
    const w = makeWorld({
      cwd: dir,
      shell: { serviceInstalled: false, identityRunnerId: RUNNER_ID, bindDaemon: 'signalled' },
      cloud: { profileOnlineSequence: [false, false, true] },
    });

    const code = await runDepartmentServe(['--foreground'], w.deps);

    expect(code).toBe(0);
    expect(w.out()).toContain('· Confirming      waiting for the supervisor to report in …');
    expect(w.out()).toContain('● unity-review — online, ready for work');
  });

  test('an approval-pending claim is still ⏸ — x13 adds no read on a path with nothing to confirm', async () => {
    const dir = departmentProject();
    const w = makeWorld({
      cwd: dir,
      cloud: {
        claimBody: { install: { id: INSTALL_ID, pendingApproval: true }, changed: true, approval_policy: 'always' },
      },
    });

    expect(await runDepartmentServe(['--json'], w.deps)).toBe(0);

    const payload = JSON.parse(w.out()) as Record<string, unknown>;
    expect(payload['state']).toBe('waiting-approval');
    expect(payload['liveness']).toBeNull();
    expect(w.fetches.some((f) => f.url === `${SERVER}/api/v1/departments/${DEPT_ID}` && f.init.method === 'GET')).toBe(false);
  });

  test('x11 is not regressed: a bind that fails still aborts before the claim, and prints no state at all', async () => {
    const dir = departmentProject();
    const w = makeWorld({ cwd: dir, shell: { bindCode: 1, bindStderr: 'nope' } });

    expect(await runDepartmentServe([], w.deps)).toBe(1);
    expect(w.out()).not.toContain('online');
    expect(w.out()).not.toContain('could not confirm');
    expect(w.fetches.some((f) => f.url.includes('/installs'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// x32 — the flagship engine is reachable through the shipped command
// ---------------------------------------------------------------------------
//
// `serve` could not bring a `claude-code` department online AT ALL: a second,
// hand-written engine list in `lib/department-serve.ts` (`SERVABLE_ADAPTER_IDS`)
// had gone stale against the registry, so one screen printed
// `✓ engine  claude-code  (supported)` and the next refused the same manifest.
// Every phase-P4 engine task (b3, b4, x16, x21, x27, x31) builds `claude-code`,
// and design 02 §4's publish path runs through `serve`.
//
// Two gate runs and a green CI missed it because their rigs bound the
// `DepartmentManager` directly instead of going through `serve`. So these tests
// deliberately do NOT assert list membership — they run a real `claude-code`
// manifest through `runDepartmentServe`, the same entry point a user types, and
// look at what reached `pipeline-runner bind`.

describe('serve — x32: a claude-code department comes online', () => {
  test('serve binds and serves engine: claude-code, defaulting the binary to `claude`', async () => {
    const dir = departmentProject(departmentYaml({ engine: 'claude-code' }));
    const w = makeWorld({ cwd: dir });

    const code = await runDepartmentServe([], w.deps);

    expect(code).toBe(0);
    expect(w.out()).toContain('✓ Runtime bound   claude-code → claude');
    expect(w.out()).toContain('● unity-review — online');
    // The refusal that used to fire here is gone in every spelling.
    expect(w.err()).not.toContain('no engine module');
    expect(w.err()).not.toContain('Nothing was registered');

    // What actually reached pipeline-runner. `--adapter claude-code` is the id
    // its `cli.ts` really registers (`new ClaudeCodeAdapter(...)`), `--command`
    // is non-empty because `narrowRuntimeConfig` DROPS a binding without one,
    // and `--cwd` is the department folder (05 §1: the session is rooted
    // there, and the folder's own `.claude/` is what governs it).
    const bind = w.shells.find((c) => c.args[0] === 'bind');
    expect(bind).toBeDefined();
    expect(bind!.args).toEqual([
      'bind',
      '--department',
      DEPT_ID,
      '--adapter',
      'claude-code',
      '--command',
      'claude',
      '--cwd',
      dir,
      '--lifecycle',
      'per-task',
    ]);
    // No nested spec: the adapter builds its own flag surface.
    expect(bind!.args).not.toContain('--spec');
  });

  test('nothing prints "(supported)" and then refuses — validate and serve read one predicate', async () => {
    // The self-contradiction itself, as a test: the exact two outputs that
    // disagreed on `main`, produced back to back from the same manifest.
    const dir = departmentProject(departmentYaml({ engine: 'claude-code' }));
    const manifestPath = join(dir, 'department.yml');

    let validateOut = '';
    const origOut = process.stdout.write;
    process.stdout.write = ((s: string) => ((validateOut += s), true)) as typeof process.stdout.write;
    let validateCode: number;
    try {
      validateCode = runDepartmentValidate(['--file', manifestPath]);
    } finally {
      process.stdout.write = origOut;
    }

    expect(validateCode).toBe(0);
    expect(validateOut).toContain('✓ engine        claude-code  (supported)');

    const w = makeWorld({ cwd: dir });
    expect(await runDepartmentServe([], w.deps)).toBe(0);
    expect(w.out()).toContain('● unity-review — online');
  });

  test('--runtime-command overrides the claude binary; a manifest never carries an install path', async () => {
    const dir = departmentProject(departmentYaml({ engine: 'claude-code' }));
    const w = makeWorld({ cwd: dir });

    expect(await runDepartmentServe(['--runtime-command', '/opt/claude/bin/claude'], w.deps)).toBe(0);

    const bind = w.shells.find((c) => c.args[0] === 'bind');
    expect(bind!.args[bind!.args.indexOf('--command') + 1]).toBe('/opt/claude/bin/claude');
  });

  test('claude-code passes runtime.args through as the adapter\'s verbatim extras', () => {
    // `ClaudeCodeAdapter` appends `RuntimeConfig.args` after the flag surface
    // it builds, which is where `--model` / `--add-dir` belong.
    const { manifest } = parseDepartmentManifest(
      departmentYaml({ engine: 'claude-code', extra: '  args: ["--model", "opus"]\n' }),
    );
    const result = runtimeBindingFor(manifest!, { manifestDir: '/dept' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.binding.adapterId).toBe('claude-code');
    expect(result.binding.command).toBe('claude');
    expect(result.binding.args).toEqual(['--model', 'opus']);
    expect(result.binding.spec).toEqual({});
  });

  test('every engine the registry lists can produce a binding — no row is a dead end', () => {
    // The general form of the x32 bug: a registry row `validate` calls
    // "supported" that `runtimeBindingFor` cannot turn into a binding. Written
    // over `ENGINES` rather than over a list of names, so a new engine is
    // covered the moment its row lands.
    for (const def of ENGINES) {
      const extra =
        def.engine === 'pipeline'
          ? '' // departmentYaml already writes pipelineRoot + startIteration
          : def.takesLocalExecFields
            ? '  command: ./bin/dept\n'
            : '';
      const { manifest } = parseDepartmentManifest(departmentYaml({ engine: def.engine, extra }));
      expect(manifest).not.toBeNull();
      const result = runtimeBindingFor(manifest!, { manifestDir: '/dept' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.binding.adapterId).toBe(def.adapterId);
      // pipeline-runner's `narrowRuntimeConfig` drops an entry without one.
      expect(result.binding.command.length).toBeGreaterThan(0);
    }
  });

  test('x13 still holds for claude-code: a stopped supervisor is not-serving, never online', async () => {
    const dir = departmentProject(departmentYaml({ engine: 'claude-code' }));
    const w = makeWorld({
      cwd: dir,
      shell: { identityRunnerId: RUNNER_ID, serviceInstalled: true, serviceState: 'stopped' },
      cloud: { profileOnline: false },
    });

    expect(await runDepartmentServe([], w.deps)).toBe(1);
    expect(w.out()).toContain('○ unity-review — registered — not serving');
    expect(w.out()).not.toContain('● unity-review — online');
  });

  test('x11 still holds for claude-code: a failed bind aborts before the claim', async () => {
    const dir = departmentProject(departmentYaml({ engine: 'claude-code' }));
    const w = makeWorld({ cwd: dir, shell: { bindCode: 1, bindStderr: 'nope' } });

    expect(await runDepartmentServe([], w.deps)).toBe(1);
    expect(w.out()).not.toContain('online');
    expect(w.fetches.some((f) => f.url.includes('/installs'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// x32 — the drift that produced the bug, made loud where it is authored
// ---------------------------------------------------------------------------
//
// `ENGINES` is a hand-maintained copy of a table owned by `pipeline-runner`
// (`src/department/engine.ts`'s `ENGINE_NAMES` + `ENGINE_REGISTRY`) with NO
// dependency edge between the packages — the open architecture decision filed
// as x14, which this task deliberately does not take unilaterally. Until it is
// taken, the next best thing is to make the drift LOUD in the one place it is
// actually authored: the ai-pipeline superrepo, where both repos are checked
// out as sibling submodules.
//
// Best-effort by construction. When the runner's source is not on disk (this
// repo's own CI, an npm consumer, a bare clone) or its shape is not the one
// this reader understands, the check declines to assert rather than inventing
// a failure. It is a detector for the superrepo, not a substitute for x14.
//
// x44 — WHAT THIS CHECK IS AND IS NOT WORTH, stated rather than implied.
//
// On this repo's CI `public/package/pipeline-runner` is not on disk, so
// `readRunnerEngineRegistry()` returns null and the assertion below is
// VACUOUS — it passes without comparing anything. That was true the day it
// was written and x32's own worker said so. It is equally vacuous for every
// USER, who has no runner source tree at all, only an INSTALLED runner — and
// the installed build's registry is the only one that can actually break a
// department. A checked-out `main` agreeing with a checked-out `main` says
// nothing about the `@baizor/pipeline-runner` on the machine doing the work.
//
// So it is kept for exactly what it is worth — a superrepo edit guard, run by
// whoever has both trees — and the load is carried at RUNTIME instead, by
// `parseAdapterRefusal` (see its section in `lib/department-serve.ts` for the
// argued position). What CI can prove about this file is that its parser and
// its comparison work; `driftBetween` is extracted so it can, and the test
// below feeds it a deliberately drifted source.

const RUNNER_ENGINE_SOURCE_ENV = 'PIPELINE_RUNNER_ENGINE_TS';

/** `engine → adapterId` as stated by pipeline-runner's own `ENGINE_REGISTRY`
 *  source text, or `null` when it cannot be read or confidently parsed. */
function readRunnerEngineRegistry(): Record<string, string> | null {
  const candidates = [
    process.env[RUNNER_ENGINE_SOURCE_ENV],
    // superrepo layout: public/ai-pipeline-plugin/apps/pipeline-cli/tests → public/package/pipeline-runner
    resolve(import.meta.dir, '../../../../pipeline-runner/src/department/engine.ts'),
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);

  const file = candidates.find((p) => existsSync(p));
  if (file === undefined) return null;

  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  // Each shipped row reads:  <key>: { engine: '<name>', adapterId: '<id>', …
  const rows = [...text.matchAll(/engine:\s*'([a-z0-9-]+)',\s*(?:\/\/[^\n]*\n\s*)*adapterId:\s*'([a-z0-9-]+)'/g)];
  if (rows.length === 0) return null;
  const out: Record<string, string> = {};
  for (const m of rows) out[m[1]!] = m[2]!;
  return out;
}

/** `ENGINES` against a runner registry, as self-explaining strings rather than
 *  an object diff: a failure here is read by whoever just edited ONE of the two
 *  tables, and it has to say which engine and which side without further
 *  digging. Extracted (x44) so the comparison itself is coverable on a CI that
 *  has no runner source to compare against. */
function driftBetween(runner: Record<string, string>): string[] {
  const mine: Record<string, string> = Object.fromEntries(ENGINES.map((e) => [e.engine, e.adapterId]));
  return [...new Set([...Object.keys(mine), ...Object.keys(runner)])].sort().flatMap((engine) =>
    mine[engine] === runner[engine]
      ? []
      : [
          `${engine}: ENGINES (apps/pipeline-cli/src/lib/department-manifest.ts) says ` +
            `${mine[engine] ?? '(no row — add one, or the engine is unusable from the CLI)'}; ` +
            `pipeline-runner ENGINE_REGISTRY says ${runner[engine] ?? '(no row — no module ships for it)'}`,
        ],
  );
}

describe('x32 — engine registry drift against pipeline-runner (best effort, superrepo only)', () => {
  test('ENGINES mirrors pipeline-runner ENGINE_REGISTRY, or the copy has drifted', () => {
    const runner = readRunnerEngineRegistry();
    if (runner === null) {
      // Nothing to compare against here. Not a failure — and, on this repo's
      // CI, ALWAYS the branch taken. See the x44 note above.
      expect(true).toBe(true);
      return;
    }
    expect(driftBetween(runner)).toEqual([]);
  });

  // x44: what CI *can* prove — that the reader and the comparison work, so a
  // green run of the vacuous test above at least means the detector is not
  // also broken.
  test('the reader parses a real ENGINE_REGISTRY, and the comparison names a drifted engine', () => {
    const dir = mkdtempSync(join(tmpdir(), 'runner-engine-'));
    created.push(dir);
    const file = join(dir, 'engine.ts');
    writeFileSync(
      file,
      "export const ENGINE_REGISTRY = {\n" +
        "  'claude-code': {\n" +
        "    // a comment between the two fields, exactly as the real file has\n" +
        "    engine: 'claude-code',\n" +
        "    adapterId: 'claude-code',\n" +
        '  },\n' +
        '  pipeline: {\n' +
        "    engine: 'pipeline',\n" +
        // The drift: the runner calls it something else than `ENGINES` does.
        "    adapterId: 'drive-v2',\n" +
        '  },\n' +
        '};\n',
    );
    const previous = process.env[RUNNER_ENGINE_SOURCE_ENV];
    process.env[RUNNER_ENGINE_SOURCE_ENV] = file;
    try {
      const runner = readRunnerEngineRegistry();
      expect(runner).not.toBeNull();
      expect(runner!['claude-code']).toBe('claude-code');
      expect(runner!['pipeline']).toBe('drive-v2');

      const drift = driftBetween(runner!);
      // The drifted engine is named, from BOTH sides…
      expect(drift.some((d) => d.startsWith('pipeline:') && d.includes('pipeline-drive') && d.includes('drive-v2'))).toBe(true);
      // …and so is every engine this fixture's runner has no module for.
      expect(drift.some((d) => d.startsWith('process:') && d.includes('no module ships for it'))).toBe(true);
      // The row that agrees is not reported.
      expect(drift.some((d) => d.startsWith('claude-code:'))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env[RUNNER_ENGINE_SOURCE_ENV];
      else process.env[RUNNER_ENGINE_SOURCE_ENV] = previous;
    }
  });
});

// ---------------------------------------------------------------------------
// x44 — the drift detector that fires on a USER's machine
// ---------------------------------------------------------------------------
//
// `pipeline-runner bind --adapter` now refuses an id it has no engine module
// for and names the ones it has (its x14). `serve` provokes that refusal at
// step 6 on every invocation, against the INSTALLED build — the only registry
// that can actually break a department. Reading it is the whole detector; see
// `parseAdapterRefusal`'s section doc in `lib/department-serve.ts`.

/** `cli.ts`'s `runBind` refusal, verbatim in shape (stderr, exit 1). */
const BIND_ADAPTER_REFUSAL: ShellResult = {
  code: 1,
  stdout: '',
  stderr:
    "[pipeline-runner] error: unknown --adapter 'claude-code' — this runner has no engine module for it, so it " +
    'could not execute a single task for this department.\n' +
    '  Adapters this build has: container, jsonl-process (engine: process), pipeline-drive (engine: pipeline)\n',
};

function bindDeps(result: ShellResult) {
  return {
    shell: () => result,
    fetch: async () => {
      throw new Error('no network in this test');
    },
  } as unknown as Parameters<typeof bindRuntime>[0];
}

const A_BINDING = { adapterId: 'claude-code', command: 'claude', args: [], cwd: '/dept', spec: {}, warnings: [] };

describe('x44 — a refused adapter is a REGISTRY DRIFT, and is reported as one', () => {
  test('the refusal is parsed into both sides of the disagreement', () => {
    const drift = parseAdapterRefusal(BIND_ADAPTER_REFUSAL.stderr);
    expect(drift).not.toBeNull();
    expect(drift!.adapterId).toBe('claude-code');
    // Said back in `department.yml`'s vocabulary — the user never typed an
    // adapter id, and 06 §2 forbids printing one at them without translation.
    expect(drift!.engine).toBe('claude-code');
    expect(drift!.runnerAdapters).toBe('container, jsonl-process (engine: process), pipeline-drive (engine: pipeline)');
  });

  test('an adapter id no ENGINES row claims is itself a finding, not a crash', () => {
    const drift = parseAdapterRefusal("unknown --adapter 'codex' — this runner has no engine module for it");
    expect(drift).not.toBeNull();
    expect(drift!.engine).toBeNull();
    expect(drift!.runnerAdapters).toBeNull();
  });

  test('`bind` failing for ANY OTHER reason is not relabelled as a registry problem', () => {
    for (const stderr of [
      '[pipeline-runner] error: could not write the runtime binding: /x/departments.json (EACCES)',
      '[pipeline-runner] error: --command <cmd> is required',
    ]) {
      expect(parseAdapterRefusal(stderr)).toBeNull();
      const outcome = bindRuntime(bindDeps({ code: 1, stdout: '', stderr }), 'dept-1', A_BINDING);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.message).toContain('Could not write the runtime binding:');
      expect(outcome.message).not.toContain('VERSION SKEW');
    }
  });

  test('bindRuntime turns the refusal into a message that names the skew and the fix', () => {
    const outcome = bindRuntime(bindDeps(BIND_ADAPTER_REFUSAL), 'dept-1', A_BINDING);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain('has no engine module for adapter');
    expect(outcome.message).toContain('`engine: claude-code`');
    expect(outcome.message).toContain('pipeline-drive (engine: pipeline)');
    expect(outcome.message).toContain('VERSION SKEW');
    expect(outcome.message).toContain('bun add -g @baizor/pipeline-runner');
  });

  test('a missing binary keeps its own message — that is not a drift either', () => {
    const outcome = bindRuntime(bindDeps({ code: 127, stdout: '', stderr: 'spawn ENOENT' }), 'dept-1', A_BINDING);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain('`pipeline-runner` is not installed on this machine');
  });

  test('a reworded refusal costs the RICHER message, never the answer', () => {
    // The detector matches the runner's own sentence. If that sentence ever
    // changes, `bind` still fails with the runner's text relayed verbatim —
    // the correct direction to degrade.
    const reworded = '[pipeline-runner] error: adapter `claude-code` is not registered';
    expect(parseAdapterRefusal(reworded)).toBeNull();
    const outcome = bindRuntime(bindDeps({ code: 1, stdout: '', stderr: reworded }), 'dept-1', A_BINDING);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain('adapter `claude-code` is not registered');
  });

  test('describeAdapterRegistryDrift stays readable when the runner named no list', () => {
    const text = describeAdapterRegistryDrift({ adapterId: 'codex', engine: null, runnerAdapters: null });
    expect(text).toContain("no engine module for adapter 'codex'");
    expect(text).toContain("this department's engine");
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('null');
  });
});

// ---------------------------------------------------------------------------
// pure units
// ---------------------------------------------------------------------------

describe('department-serve pure helpers', () => {
  test('the dashboard is SAME-ORIGIN with the API — the host is never rewritten', () => {
    // It used to strip a leading `api.`, sending an admin to the apex. The apex
    // is the MARKETING site, which has no /departments route — and because that
    // site is a SPA too, the wrong link answered 200 with its own "page not
    // found" instead of failing loudly. Verified against production.
    expect(appOriginFor('https://api.ai-pipeline.dev')).toBe('https://api.ai-pipeline.dev');
    expect(appOriginFor('http://localhost:3000')).toBe('http://localhost:3000');
    expect(appOriginFor('https://pipeline.example.com')).toBe('https://pipeline.example.com');
    expect(departmentUrlFor('https://api.ai-pipeline.dev', 'unity-review')).toBe(
      'https://api.ai-pipeline.dev/departments/unity-review',
    );
    // A trailing slash on the configured server must not double up in the link.
    expect(departmentUrlFor('https://api.ai-pipeline.dev/', 'ceo')).toBe(
      'https://api.ai-pipeline.dev/departments/ceo',
    );
  });

  test('renderState never renders "online" for a department that is not serving', () => {
    expect(renderState('online', 'd')).toContain('● d — online');
    expect(renderState('waiting-approval', 'd')).toContain('⏸ d — waiting for an admin');
    const notServing = renderState('registered-not-serving', 'd', 'because');
    expect(notServing).toContain('○ d — registered — not serving');
    expect(notServing).not.toContain('online');
    // x13's third outcome: distinct marker, distinct sentence, no claim.
    const unconfirmed = renderState('unconfirmed', 'd', 'the server did not answer');
    expect(unconfirmed).toContain('◌ d — registered and bound; could not confirm it is live');
    expect(unconfirmed).toContain('(the server did not answer)');
    expect(unconfirmed).not.toContain('online');
  });

  test('assessLiveness — the rule, without a network, a service or a clock (x13)', () => {
    const base = { foreground: false, server: 'https://api.example.dev' } as const;

    // Verified live: the authority said so.
    expect(assessLiveness({ ...base, supervisor: 'running', cloudOnline: true })).toEqual({ verdict: 'live' });

    // A supervisor that is not running is checked FIRST — it is the local,
    // actionable fact, and it holds whether or not the cloud answered.
    for (const cloudOnline of [false, null] as const) {
      const stopped = assessLiveness({ ...base, supervisor: 'stopped', cloudOnline });
      expect(stopped.verdict).toBe('not-live');
      if (stopped.verdict !== 'not-live') return;
      expect(stopped.reason).toContain('installed but NOT running');
      // x44/x24: an installed-but-stopped service is STARTED, not recreated.
      expect(stopped.nextStep).toContain('pipeline-runner service start');
      expect(stopped.nextStep).not.toContain('service install');
      // …and because `service start` is not in a PUBLISHED runner yet, the
      // dead end that verb hits on an older one has its own next step.
      expect(stopped.nextStep).toContain('bun add -g @baizor/pipeline-runner');

      const none = assessLiveness({ ...base, supervisor: 'not-installed', cloudOnline });
      expect(none.verdict).toBe('not-live');
      if (none.verdict !== 'not-live') return;
      expect(none.reason).toContain('no supervisor service');
      // …and `not-installed` is a DIFFERENT state, which keeps `install`.
      expect(none.nextStep).toContain('pipeline-runner service install');
    }

    // …and `--foreground` gets the remedy that fits it.
    const fg = assessLiveness({ ...base, foreground: true, supervisor: 'not-installed', cloudOnline: false });
    expect(fg.verdict).toBe('not-live');
    if (fg.verdict !== 'not-live') return;
    expect(fg.reason).toContain('--foreground');
    expect(fg.nextStep).toContain('pipeline-runner start');

    // `--foreground` on a machine that HAS a stopped service still describes
    // the machine truthfully — the service exists, it is simply down.
    const fgStopped = assessLiveness({ ...base, foreground: true, supervisor: 'stopped', cloudOnline: false });
    expect(fgStopped.verdict).toBe('not-live');
    if (fgStopped.verdict !== 'not-live') return;
    expect(fgStopped.reason).toContain('installed but NOT running');
    expect(fgStopped.reason).not.toContain('no supervisor service');
    expect(fgStopped.nextStep).toContain('pipeline-runner start');

    // A department something ELSE is serving is not denied just because this
    // machine is down — both facts are reported. x39: the "somewhere else"
    // half is a CLAIM, so it needs the home-lock observation that rules this
    // machine out; with it, the sentence is earned.
    const elsewhere = assessLiveness({ ...base, supervisor: 'stopped', localDaemon: 'none', cloudOnline: true });
    expect(elsewhere.verdict).toBe('not-live');
    if (elsewhere.verdict !== 'not-live') return;
    expect(elsewhere.reason).toContain('installed but NOT running');
    expect(elsewhere.reason).toContain('served from somewhere else (another machine, or another runner home on this one)');

    // A running supervisor the cloud cannot see: not live, and it says which
    // half is the mystery.
    const unseen = assessLiveness({ ...base, supervisor: 'running', cloudOnline: false });
    expect(unseen.verdict).toBe('not-live');
    if (unseen.verdict !== 'not-live') return;
    expect(unseen.reason).toContain('does not see it connected');

    // Nothing observed either way.
    const undet = assessLiveness({ ...base, supervisor: 'running', cloudOnline: null, cloudError: 'HTTP 500' });
    expect(undet.verdict).toBe('undetermined');
    if (undet.verdict !== 'undetermined') return;
    expect(undet.reason).toContain('HTTP 500');
    expect(undet.nextStep).toContain('pipeline department status');
  });

  test('assessLiveness never returns "live" without a cloud answer of exactly true', () => {
    const supervisors = ['running', 'stopped', 'not-installed', 'unknown'] as const;
    const daemons = ['running', 'none', 'unknown'] as const;
    const answers = [false, null] as const;
    for (const supervisor of supervisors) {
      for (const localDaemon of daemons) {
        for (const cloudOnline of answers) {
          for (const foreground of [false, true]) {
            const v = assessLiveness({ supervisor, localDaemon, foreground, cloudOnline, server: 's' });
            expect(v.verdict).not.toBe('live');
            // Every non-live outcome is actionable — no dead ends.
            if (v.verdict === 'live') return;
            expect(v.reason.length).toBeGreaterThan(0);
            expect(v.nextStep.length).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  // -------------------------------------------------------------------------
  // x39 — the local diagnostic knows what it cannot see
  // -------------------------------------------------------------------------

  test('readLocalDaemonState reads b1\'s four reload lines, and guesses at nothing else (x39)', () => {
    // Verbatim from pipeline-runner's `signalSupervisorReload()`. If any of
    // these four drifts, this test is the tripwire — not a user's transcript.
    expect(
      readLocalDaemonState('[pipeline-runner] no supervisor is running for this home — the change applies at the next `start`.'),
    ).toBe('none');
    expect(
      readLocalDaemonState('[pipeline-runner] supervisor pid 4242 is running — it picks this up automatically (file watch).'),
    ).toBe('running');
    expect(readLocalDaemonState('[pipeline-runner] signalled supervisor pid 4242 (SIGHUP) to reload.')).toBe('running');
    // A pid that is ALIVE but could not be signalled — most often a daemon
    // owned by another OS account. "I could not signal it" is not "it is gone".
    expect(
      readLocalDaemonState('[pipeline-runner] could not signal pid 4242 (EPERM) — its file watch still picks the change up.'),
    ).toBe('running');

    // The store line alone (an older `pipeline-runner`, or a format drift) is
    // NOT evidence in either direction.
    expect(readLocalDaemonState('[pipeline-runner] bound d -> jsonl-process: cmd (/x/departments.json)')).toBe('unknown');
    expect(readLocalDaemonState('')).toBe('unknown');
    // The negative line contains the word "running": a bare substring search
    // for it would read "no supervisor is running" as `running`.
    expect(readLocalDaemonState('[pipeline-runner] no supervisor is running for this home')).not.toBe('running');
  });

  test('a live FOREGROUND supervisor is not reported as "not serving … another machine" (x39)', () => {
    // The P4 gate's defect, as a pure unit. `--foreground` installs no
    // service, so the service probe says `not-installed` — and x13 read the
    // verdict off that alone, producing a false failure with an invented
    // cause for a department that was serving from this very machine.
    const base = { foreground: true, supervisor: 'not-installed', server: 'https://api.example.dev' } as const;

    expect(assessLiveness({ ...base, localDaemon: 'running', cloudOnline: true })).toEqual({ verdict: 'live' });

    // The same machine while the cloud has not seen it yet: still not-live
    // (05 §5's "never a bare online"), but for the reason that is TRUE.
    const notSeen = assessLiveness({ ...base, localDaemon: 'running', cloudOnline: false });
    expect(notSeen.verdict).toBe('not-live');
    if (notSeen.verdict !== 'not-live') return;
    expect(notSeen.reason).toContain('does not see it connected');
    expect(notSeen.reason).not.toContain('another machine');
    expect(notSeen.reason).not.toContain('no supervisor service');
  });

  test('"another machine" is said only when this machine was ruled out (x39)', () => {
    const base = { foreground: false, supervisor: 'stopped', cloudOnline: true, server: 'https://api.example.dev' } as const;

    // Ruled out: the runner itself reported that nothing holds this home.
    const ruledOut = assessLiveness({ ...base, localDaemon: 'none' });
    if (ruledOut.verdict !== 'not-live') throw new Error('expected not-live');
    expect(ruledOut.reason).toContain('served from somewhere else');
    // …and even then it names both possibilities rather than picking one: a
    // service under another OS account has its OWN runner home, whose lock
    // file this check cannot read (the same blind spot as x22).
    expect(ruledOut.reason).toContain('another runner home on this one');

    // NOT ruled out: the process probe said nothing, so neither does the
    // message. It reports the two things it knows — the service is down, and
    // the department is online — and explicitly declines the third.
    const unknown = assessLiveness({ ...base, localDaemon: 'unknown' });
    if (unknown.verdict !== 'not-live') throw new Error('expected not-live');
    expect(unknown.reason).toContain('installed but NOT running');
    expect(unknown.reason).toContain('whether a supervisor process is running here could not be determined');
    expect(unknown.reason).toContain('cannot tell whether that is this machine');
    expect(unknown.reason).not.toContain('another machine is serving it');
    expect(unknown.reason).not.toContain('somewhere else');
  });

  test('the home lock alone can carry the not-live verdict when the service probe cannot (x39)', () => {
    // `service status` unreadable (`unknown`) — x13 fell through to the cloud
    // here. The home lock is a positive local observation in its own right.
    const v = assessLiveness({
      foreground: false,
      supervisor: 'unknown',
      localDaemon: 'none',
      cloudOnline: false,
      server: 's',
    });
    if (v.verdict !== 'not-live') throw new Error('expected not-live');
    expect(v.reason).toBe("no supervisor process is running in this machine's runner home");
    // The service probe said nothing at all, so BOTH verbs are named and the
    // runner decides: `service start` refuses (naming `install`) when there is
    // nothing installed to start, so the wrong guess costs a refusal rather
    // than a rebuilt service.
    expect(v.nextStep).toContain('pipeline-runner service start');
    expect(v.nextStep).toContain('pipeline-runner service install');
  });

  test('a running process outranks a service that is merely not installed (x39)', () => {
    // Both probes disagree BY DESIGN on a foreground machine, and the
    // positive observation wins: a process that is demonstrably running
    // outranks a service that is demonstrably absent.
    expect(localSupervisorIsUp({ supervisor: 'not-installed', localDaemon: 'running' })).toBe(true);
    expect(localSupervisorIsUp({ supervisor: 'stopped', localDaemon: 'running' })).toBe(true);
    expect(localSupervisorIsUp({ supervisor: 'running', localDaemon: 'none' })).toBe(true);
    // Neither probe saw anything positive.
    expect(localSupervisorIsUp({ supervisor: 'not-installed', localDaemon: 'none' })).toBe(false);
    expect(localSupervisorIsUp({ supervisor: 'unknown' })).toBe(false);
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
      'name: d\ndescription: x\nskills:\n  - id: s\n    name: S\n    description: y\nruntime:\n  engine: pipeline\n  pipelineRoot: .pipeline/review\n',
    );
    const result = runtimeBindingFor(manifest!, { manifestDir: '/dept' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('runtime.startIteration');
  });
});

// ---------------------------------------------------------------------------
// runtime.agent — the department's entry-point agent
//
// "The agent that receives every arriving message and answers it", named in
// the manifest and defined INSIDE the department. Three properties matter and
// each is pinned below: it reaches the engine as `--agent`, it never reaches
// the control plane, and naming one that does not exist is caught by
// `validate` rather than at the first message.
// ---------------------------------------------------------------------------

describe('runtime.agent', () => {
  const AGENT_YAML = '  agent: front-desk\n';

  test('claude-code binds it as --agent, ahead of the manifest own args', () => {
    const { manifest, findings } = parseDepartmentManifest(
      departmentYaml({
        engine: 'claude-code',
        extra: `${AGENT_YAML}  args:\n    - "--model"\n    - opus\n`,
      }),
    );
    expect(findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(manifest!.runtime.agent).toBe('front-desk');

    const result = runtimeBindingFor(manifest!, { manifestDir: resolve('/dept') });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // FIRST, so an author's own `args` can still override it the way any
    // repeated flag is overridden — last occurrence wins in the harness.
    expect(result.binding.args).toEqual(['--agent', 'front-desk', '--model', 'opus']);
    // And it survives the argv the runner is actually called with.
    expect(buildBindArgs(DEPT_ID, result.binding).join(' ')).toContain('--arg --agent --arg front-desk');
  });

  test('an engine with an entry point of its own refuses the field instead of ignoring it', () => {
    // `pipeline`'s entry point IS `startIteration`; accepting a second one and
    // silently dropping it is the x32/x51 failure mode this rule exists for.
    const { findings } = parseDepartmentManifest(departmentYaml({ engine: 'pipeline', extra: AGENT_YAML }));
    const err = findings.find((f) => f.field === 'runtime.agent' && f.severity === 'error');
    expect(err).toBeDefined();
    expect(err!.message).toContain('runtime.startIteration');
    expect(err!.message).toContain('claude-code');
  });

  test('the registry is the single source for the flag, the folder and the field', () => {
    // Same shape as x32: one table, and no second list to drift from it. The
    // ROW carries every fact — which engines take an agent, the flag `serve`
    // passes, and the folder `validate` looks in — so turning a second engine
    // on cannot leave one of the three behind.
    expect(enginesWithAgentEntrypoint().map((e) => e.engine)).toEqual(['claude-code']);
    for (const e of ENGINES) {
      expect(e.entrypoint.field === 'agent').toBe(e.entrypoint.agent !== undefined);
    }
    const claude = ENGINES.find((e) => e.engine === 'claude-code')!;
    expect(claude.entrypoint.agent).toEqual({ flag: '--agent', agentsDir: '.claude/agents' });
  });

  test('it never reaches the control plane', () => {
    const { manifest } = parseDepartmentManifest(
      departmentYaml({ engine: 'claude-code', extra: AGENT_YAML }),
    );
    const request = buildRegistrationRequest(manifest!) as unknown as Record<string, unknown>;
    expect(request['runtime']).toBeUndefined();
    expect(JSON.stringify(request)).not.toContain('front-desk');
  });

  test('validate refuses an agent this department does not define', () => {
    const dir = departmentProject(departmentYaml({ engine: 'claude-code', extra: AGENT_YAML }));
    let out = '';
    const orig = process.stdout.write;
    process.stdout.write = ((s: string) => ((out += s), true)) as typeof process.stdout.write;
    let code: number;
    try {
      code = runDepartmentValidate(['--file', join(dir, 'department.yml')]);
    } finally {
      process.stdout.write = orig;
    }
    expect(code).toBe(1);
    expect(out).toContain('runtime.agent');
    expect(out).toContain("no agent 'front-desk' in this department");
  });

  test('validate accepts one defined in the department, by filename or by frontmatter name', () => {
    for (const [file, body] of [
      ['front-desk.md', '# Front desk\n'],
      ['whatever.md', '---\nname: front-desk\n---\n\n# Front desk\n'],
    ] as const) {
      const dir = departmentProject(departmentYaml({ engine: 'claude-code', extra: AGENT_YAML }));
      mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
      writeFileSync(join(dir, '.claude', 'agents', file), body, 'utf8');

      let out = '';
      const orig = process.stdout.write;
      process.stdout.write = ((s: string) => ((out += s), true)) as typeof process.stdout.write;
      let code: number;
      try {
        code = runDepartmentValidate(['--file', join(dir, 'department.yml')]);
      } finally {
        process.stdout.write = orig;
      }
      expect(code).toBe(0);
      expect(out).not.toContain('no agent');
    }
  });
});
