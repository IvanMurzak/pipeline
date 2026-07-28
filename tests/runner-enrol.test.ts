// runner-enrol.test.ts — unit tests for lib/runner-enrol.ts (task a6): the
// reusable "already connected?" check, the mint HTTP call, and the
// install → mint → register → service-install composition. Every subprocess
// and every HTTP call is injected — nothing here spawns a real
// `pipeline-runner`/`bun`, or reaches a real network.

import { test, expect, describe } from 'bun:test';
import {
  enrolRunner,
  isRunnerCliAvailable,
  isRunnerServiceInstalled,
  readRunnerIdentity,
  readRunnerServiceState,
  realShell,
  RUNNER_PACKAGE,
  RUNNER_OAUTH_CLIENT_SECRET_ENV,
  type RunnerEnrolDeps,
  type ShellResult,
  type ShellRunner,
  type HttpResponse,
  type HttpInit,
} from '../src/lib/runner-enrol';

function reply(status: number, body: unknown): HttpResponse {
  return { status, json: async () => body };
}

// ---------------------------------------------------------------------------
// isRunnerCliAvailable
// ---------------------------------------------------------------------------

describe('isRunnerCliAvailable', () => {
  test('true when `pipeline-runner --version` exits 0', () => {
    const shell: ShellRunner = () => ({ code: 0, stdout: 'pipeline-runner 0.1.0\n', stderr: '' });
    expect(isRunnerCliAvailable({ shell })).toBe(true);
  });
  test('false when the binary is missing (spawn ENOENT → code 127)', () => {
    const shell: ShellRunner = () => ({ code: 127, stdout: '', stderr: '' });
    expect(isRunnerCliAvailable({ shell })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// readRunnerIdentity — "is this machine already a runner, and which one?"
// (a9: the install claim needs a runner_id, D26)
// ---------------------------------------------------------------------------

describe('readRunnerIdentity', () => {
  test('null when no identity is configured (`status` exits 1)', () => {
    const shell: ShellRunner = () => ({ code: 1, stdout: '', stderr: 'no agent identity configured\n' });
    expect(readRunnerIdentity({ shell })).toBeNull();
  });

  test('null when the binary is missing entirely (127)', () => {
    const shell: ShellRunner = () => ({ code: 127, stdout: '', stderr: '' });
    expect(readRunnerIdentity({ shell })).toBeNull();
  });

  test("reads runner_id + base_url out of `status`'s redacted JSON", () => {
    const shell: ShellRunner = (cmd, args) => {
      expect(cmd).toBe('pipeline-runner');
      expect(args).toEqual(['status']);
      return {
        code: 0,
        // `describeIdentity()` redacts every secret BEFORE printing, which is
        // why reading this is safe at all.
        stdout: JSON.stringify({ base_url: 'https://api.example.dev', runner_id: 'r-1', runner_token: '<redacted>' }),
        stderr: '',
      };
    };
    expect(readRunnerIdentity({ shell })).toEqual({ runnerId: 'r-1', baseUrl: 'https://api.example.dev' });
  });

  test('runnerId null when the identity exists but never completed a register round trip', () => {
    const shell: ShellRunner = () => ({ code: 0, stdout: JSON.stringify({ base_url: 'https://x' }), stderr: '' });
    expect(readRunnerIdentity({ shell })).toEqual({ runnerId: null, baseUrl: 'https://x' });
  });

  test('unreadable output is treated as no identity, never as a crash', () => {
    const shell: ShellRunner = () => ({ code: 0, stdout: 'not json at all', stderr: '' });
    expect(readRunnerIdentity({ shell })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isRunnerServiceInstalled — the reusable "one supervisor service per
// machine" check (a6; a9 converges on the same rule per D26)
// ---------------------------------------------------------------------------

describe('isRunnerServiceInstalled', () => {
  test('false — the pipeline-runner binary itself is missing (127)', () => {
    const shell: ShellRunner = () => ({ code: 127, stdout: '', stderr: '' });
    expect(isRunnerServiceInstalled({ shell })).toBe(false);
  });
  test('false — service status succeeds but says "not installed" (systemd wording)', () => {
    const shell: ShellRunner = () => ({
      code: 0,
      stdout: '[pipeline-runner] pipeline-runner.service is not installed\n',
      stderr: '',
    });
    expect(isRunnerServiceInstalled({ shell })).toBe(false);
  });
  test('false — Windows SCM wording ("service \'x\' is not installed")', () => {
    const shell: ShellRunner = () => ({
      code: 0,
      stdout: "[pipeline-runner] service 'pipeline-runner' is not installed\n",
      stderr: '',
    });
    expect(isRunnerServiceInstalled({ shell })).toBe(false);
  });
  test('false — launchd wording ("<label> is not installed")', () => {
    const shell: ShellRunner = () => ({
      code: 0,
      stdout: '[pipeline-runner] dev.ai-pipeline.pipeline-runner is not installed\n',
      stderr: '',
    });
    expect(isRunnerServiceInstalled({ shell })).toBe(false);
  });
  test('true — running', () => {
    const shell: ShellRunner = () => ({
      code: 0,
      stdout: '[pipeline-runner] pipeline-runner.service: running (enabled)\n',
      stderr: '',
    });
    expect(isRunnerServiceInstalled({ shell })).toBe(true);
  });
  test('true — installed but stopped (still "already connected", just not currently online)', () => {
    const shell: ShellRunner = () => ({
      code: 0,
      stdout: '[pipeline-runner] pipeline-runner.service: stopped (enabled)\n',
      stderr: '',
    });
    expect(isRunnerServiceInstalled({ shell })).toBe(true);
  });
  test('false — an unexpected nonzero exit never produces a false "already connected" positive', () => {
    const shell: ShellRunner = () => ({ code: 1, stdout: '', stderr: 'boom' });
    expect(isRunnerServiceInstalled({ shell })).toBe(false);
  });
  test('shells exactly "pipeline-runner service status" with no extra args', () => {
    let seen: { cmd: string; args: string[] } | null = null;
    const shell: ShellRunner = (cmd, args) => {
      seen = { cmd, args };
      return { code: 0, stdout: 'not installed', stderr: '' };
    };
    isRunnerServiceInstalled({ shell });
    expect(seen).toEqual({ cmd: 'pipeline-runner', args: ['service', 'status'] });
  });
});

// ---------------------------------------------------------------------------
// readRunnerServiceState (x13) — installed is NOT running
// ---------------------------------------------------------------------------
//
// The whole reason this function exists: `isRunnerServiceInstalled` answers
// "may I skip `service install`?" and returns `true` for a STOPPED service —
// correct for that question, and the exact hole `department serve` fell
// through when it printed `● online` on a machine whose supervisor was
// `stopped (auto-start)`.

describe('readRunnerServiceState (x13)', () => {
  const withStdout = (stdout: string, code = 0): { shell: ShellRunner } => ({
    shell: () => ({ code, stdout, stderr: '' }),
  });

  test("systemd's three renderings", () => {
    expect(readRunnerServiceState(withStdout('[pipeline-runner] pipeline-runner.service: running (enabled)\n'))).toBe('running');
    expect(readRunnerServiceState(withStdout('[pipeline-runner] pipeline-runner.service: stopped (disabled)\n'))).toBe('stopped');
    expect(readRunnerServiceState(withStdout('[pipeline-runner] pipeline-runner.service is not installed\n'))).toBe('not-installed');
  });

  test("launchd's three renderings", () => {
    expect(readRunnerServiceState(withStdout('[pipeline-runner] com.ivanmurzak.pipeline-runner: running (loaded)\n'))).toBe('running');
    expect(readRunnerServiceState(withStdout('[pipeline-runner] com.ivanmurzak.pipeline-runner: stopped (not loaded)\n'))).toBe('stopped');
    expect(readRunnerServiceState(withStdout('[pipeline-runner] dev.ai-pipeline.pipeline-runner is not installed\n'))).toBe('not-installed');
  });

  test("Windows SCM's three renderings — including the exact e2-gate line", () => {
    expect(readRunnerServiceState(withStdout("[pipeline-runner] service 'pipeline-runner': running (auto-start)\n"))).toBe('running');
    // ↓ This is the machine state that shipped a false `● online` in the e2 gate.
    expect(readRunnerServiceState(withStdout("[pipeline-runner] service 'pipeline-runner': stopped (auto-start)\n"))).toBe('stopped');
    expect(readRunnerServiceState(withStdout("[pipeline-runner] service 'pipeline-runner' is not installed\n"))).toBe('not-installed');
  });

  test("pipeline-runner's own fourth state is preserved, not rounded to 'stopped'", () => {
    // `sc query` output matching neither RUNNING nor STOPPED — the backend
    // reports `unknown`, and so must this.
    expect(readRunnerServiceState(withStdout("[pipeline-runner] service 'pipeline-runner': unknown (manual/disabled)\n"))).toBe('unknown');
  });

  test('a line that does not parse is "unknown", never a guess', () => {
    expect(readRunnerServiceState(withStdout('[pipeline-runner] something entirely new\n'))).toBe('unknown');
  });

  test('the service name containing "runner" never reads as "running"', () => {
    // A bare substring scan for "running" over `pipeline-runner.service:
    // stopped (...)` would still be wrong; the state is read from the `:
    // <state> (` shape all three backends share.
    expect(readRunnerServiceState(withStdout('[pipeline-runner] pipeline-runner.service: stopped (enabled)\n'))).toBe('stopped');
  });

  test('a missing binary (127) and any unexpected non-zero are "not-installed" — the pre-x13 behaviour, unchanged', () => {
    expect(readRunnerServiceState(withStdout('', 127))).toBe('not-installed');
    expect(readRunnerServiceState({ shell: () => ({ code: 1, stdout: '', stderr: 'boom' }) })).toBe('not-installed');
  });

  test('ONE shell per call, and `isRunnerServiceInstalled` still answers the install question identically', () => {
    let calls = 0;
    const stopped: { shell: ShellRunner } = {
      shell: () => {
        calls++;
        return { code: 0, stdout: "[pipeline-runner] service 'pipeline-runner': stopped (auto-start)\n", stderr: '' };
      },
    };
    expect(readRunnerServiceState(stopped)).toBe('stopped');
    expect(calls).toBe(1);
    // D26 is not weakened by x13: a stopped service is still a service, so
    // `serve` must not install a rival one.
    expect(isRunnerServiceInstalled(stopped)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// enrolRunner — install (on demand) → mint → register → service install
// ---------------------------------------------------------------------------

describe('enrolRunner', () => {
  const NAME = 'ivan-desktop';
  const SERVER = 'https://api.ai-pipeline.dev';
  const TOKEN = 'access_SECRET_abc';
  const CLIENT_ID = 'runner-row-uuid';
  const CLIENT_SECRET = 'aipc_SUPER_SECRET_0123456789';

  function mintFetch(
    opts: { status?: number; body?: unknown; capture?: Array<{ url: string; init: HttpInit }> } = {},
  ) {
    return async (url: string, init: HttpInit): Promise<HttpResponse> => {
      opts.capture?.push({ url, init });
      if (opts.status && opts.status !== 201) return reply(opts.status, opts.body ?? { error: 'nope' });
      return reply(
        201,
        opts.body ?? {
          runner: { id: CLIENT_ID },
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
          credentialMode: 'dual',
        },
      );
    };
  }

  interface RecordedCall {
    cmd: string;
    args: string[];
    env?: Record<string, string>;
  }

  function collectingShell(overrides: Partial<Record<string, ShellResult>> = {}) {
    const calls: RecordedCall[] = [];
    const shell: ShellRunner = (cmd, args, env) => {
      calls.push({ cmd, args, env });
      if (cmd === 'pipeline-runner' && args[0] === '--version') {
        return overrides['--version'] ?? { code: 0, stdout: 'v', stderr: '' };
      }
      if (cmd === 'bun') return overrides['bun'] ?? { code: 0, stdout: '', stderr: '' };
      if (cmd === 'pipeline-runner' && args[0] === 'register') {
        return overrides['register'] ?? { code: 0, stdout: '', stderr: '' };
      }
      if (cmd === 'pipeline-runner' && args[0] === 'service' && args[1] === 'install') {
        return overrides['service install'] ?? { code: 0, stdout: '', stderr: '' };
      }
      throw new Error(`unexpected shell call in test: ${cmd} ${args.join(' ')}`);
    };
    return { shell, calls };
  }

  test('happy path: CLI already available (skips install), mints, registers via --client-id + env secret, installs the service', async () => {
    const capture: Array<{ url: string; init: HttpInit }> = [];
    const { shell, calls } = collectingShell();
    const out: string[] = [];
    const deps: RunnerEnrolDeps = {
      shell,
      fetch: mintFetch({ capture }),
      out: (s) => out.push(s),
      err: (s) => out.push(s),
    };

    const outcome = await enrolRunner(deps, { server: SERVER, accessToken: TOKEN, orgId: 'org-uuid', name: NAME });

    // `runnerId` is a9's addition: `pipeline department serve` needs the
    // server-assigned id to claim an install with (D26), and enrolment is the
    // only step that knows it on a machine that was not a runner before.
    expect(outcome).toEqual({ status: 'connected', name: NAME, runnerId: CLIENT_ID });
    expect(calls.some((c) => c.cmd === 'bun')).toBe(false); // already available — no install attempted

    const mintCall = capture[0]!;
    expect(mintCall.url).toBe(`${SERVER}/api/v1/runners`);
    expect(mintCall.init.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(mintCall.init.headers['x-org-id']).toBe('org-uuid');
    expect(JSON.parse(mintCall.init.body ?? '{}')).toEqual({ name: NAME, labels: [] });

    const registerCall = calls.find((c) => c.args[0] === 'register')!;
    expect(registerCall.args).toEqual(['register', '--url', SERVER, '--client-id', CLIENT_ID]);
    expect(registerCall.env).toEqual({ [RUNNER_OAUTH_CLIENT_SECRET_ENV]: CLIENT_SECRET });
    expect(registerCall.args).not.toContain('--token');
    expect(registerCall.args).not.toContain('--store-only');

    expect(calls.some((c) => c.args.join(' ') === 'service install')).toBe(true);
  });

  test('installService: false enrols WITHOUT touching the service — a9 owns that decision (D26)', async () => {
    const { shell, calls } = collectingShell();
    const deps: RunnerEnrolDeps = { shell, fetch: mintFetch(), out: () => {}, err: () => {} };

    const outcome = await enrolRunner(deps, {
      server: SERVER,
      accessToken: TOKEN,
      name: NAME,
      installService: false,
    });

    // `connected-no-service` keeps the ONE `connected` status meaning
    // "registered AND supervised" for `cloud connect`, which asked for both.
    expect(outcome).toEqual({ status: 'connected-no-service', name: NAME, runnerId: CLIENT_ID });
    expect(calls.some((c) => c.args.join(' ') === 'service install')).toBe(false);
    expect(calls.some((c) => c.args[0] === 'register')).toBe(true);
  });

  test('CLI not available: shows the install command BEFORE running it, then proceeds', async () => {
    const { shell, calls } = collectingShell({ '--version': { code: 127, stdout: '', stderr: '' } });
    const out: string[] = [];
    // A shared timeline so ordering between "printed the command" and
    // "actually ran bun" is verifiable, not just presence.
    const timeline: string[] = [];
    const tracedShell: ShellRunner = (cmd, args, env) => {
      timeline.push(`shell:${cmd} ${args.join(' ')}`);
      return shell(cmd, args, env);
    };
    const deps: RunnerEnrolDeps = {
      shell: tracedShell,
      fetch: mintFetch(),
      out: (s) => {
        out.push(s);
        timeline.push(`out:${s.trim()}`);
      },
      err: () => {},
    };

    const outcome = await enrolRunner(deps, { server: SERVER, accessToken: TOKEN, name: NAME });

    expect(outcome.status).toBe('connected');
    expect(out.join('')).toContain(`$ bun add -g ${RUNNER_PACKAGE}`);
    expect(calls.some((c) => c.cmd === 'bun' && c.args.join(' ') === `add -g ${RUNNER_PACKAGE}`)).toBe(true);

    const printedAt = timeline.findIndex((l) => l.startsWith('out:$ bun add -g'));
    const ranAt = timeline.findIndex((l) => l === 'shell:bun add -g @baizor/pipeline-runner');
    expect(printedAt).toBeGreaterThanOrEqual(0);
    expect(ranAt).toBeGreaterThanOrEqual(0);
    expect(printedAt).toBeLessThan(ranAt);
  });

  test('package install fails: returns install-failed, never attempts the mint', async () => {
    const { shell } = collectingShell({
      '--version': { code: 127, stdout: '', stderr: '' },
      bun: { code: 1, stdout: '', stderr: 'network unreachable' },
    });
    let mintCalled = false;
    const deps: RunnerEnrolDeps = {
      shell,
      fetch: async () => {
        mintCalled = true;
        return reply(201, {});
      },
      out: () => {},
      err: () => {},
    };
    const outcome = await enrolRunner(deps, { server: SERVER, accessToken: TOKEN, name: NAME });
    expect(outcome.status).toBe('install-failed');
    expect(outcome.detail).toContain('network unreachable');
    expect(mintCalled).toBe(false);
  });

  test('mint 403 (admin role required): mint-failed with an actionable message, never shells register', async () => {
    const { shell, calls } = collectingShell();
    const deps: RunnerEnrolDeps = { shell, fetch: mintFetch({ status: 403 }), out: () => {}, err: () => {} };
    const outcome = await enrolRunner(deps, { server: SERVER, accessToken: TOKEN, name: NAME });
    expect(outcome.status).toBe('mint-failed');
    expect(outcome.detail).toContain('admin');
    expect(calls.some((c) => c.args[0] === 'register')).toBe(false);
  });

  test('mint non-201/non-403: mint-failed, relays the HTTP status', async () => {
    const { shell } = collectingShell();
    const deps: RunnerEnrolDeps = {
      shell,
      fetch: mintFetch({ status: 500, body: { error: 'boom' } }),
      out: () => {},
      err: () => {},
    };
    const outcome = await enrolRunner(deps, { server: SERVER, accessToken: TOKEN, name: NAME });
    expect(outcome.status).toBe('mint-failed');
    expect(outcome.detail).toContain('500');
  });

  test('register fails: register-failed, never installs the service, and the detail never contains the secret', async () => {
    const { shell, calls } = collectingShell({
      register: { code: 1, stdout: '', stderr: '[pipeline-runner] error: runner credential was not accepted' },
    });
    const deps: RunnerEnrolDeps = { shell, fetch: mintFetch(), out: () => {}, err: () => {} };
    const outcome = await enrolRunner(deps, { server: SERVER, accessToken: TOKEN, name: NAME });
    expect(outcome.status).toBe('register-failed');
    expect(outcome.detail).toContain('not accepted');
    expect(outcome.detail).not.toContain(CLIENT_SECRET);
    expect(calls.some((c) => c.args.join(' ') === 'service install')).toBe(false);
  });

  test('service install fails: connected-no-service — registration itself succeeded', async () => {
    const { shell } = collectingShell({
      'service install': { code: 1, stdout: '', stderr: 'permission denied' },
    });
    const deps: RunnerEnrolDeps = { shell, fetch: mintFetch(), out: () => {}, err: () => {} };
    const outcome = await enrolRunner(deps, { server: SERVER, accessToken: TOKEN, name: NAME });
    expect(outcome.status).toBe('connected-no-service');
    expect(outcome.detail).toContain('permission denied');
  });

  test('no orgId supplied (machine-credential path): the mint request carries no X-Org-Id header', async () => {
    const capture: Array<{ url: string; init: HttpInit }> = [];
    const { shell } = collectingShell();
    const deps: RunnerEnrolDeps = { shell, fetch: mintFetch({ capture }), out: () => {}, err: () => {} };
    await enrolRunner(deps, { server: SERVER, accessToken: TOKEN, name: NAME }); // no orgId
    expect(capture[0]!.init.headers['x-org-id']).toBeUndefined();
  });

  // ---------------------------------------------------------------------
  // SECURITY — DoD: "No token may ever be printed."
  // ---------------------------------------------------------------------
  test('SECURITY: the minted client secret never appears in any out()/err() line, nor in any shelled argv — only in the register subprocess env', async () => {
    const { shell, calls } = collectingShell();
    const printed: string[] = [];
    const deps: RunnerEnrolDeps = {
      shell,
      fetch: mintFetch(),
      out: (s) => printed.push(s),
      err: (s) => printed.push(s),
    };
    const outcome = await enrolRunner(deps, { server: SERVER, accessToken: TOKEN, name: NAME });
    expect(outcome.status).toBe('connected');

    const everythingPrinted = printed.join('');
    expect(everythingPrinted).not.toContain(CLIENT_SECRET);
    for (const c of calls) {
      expect(c.args.join(' ')).not.toContain(CLIENT_SECRET);
    }
    const registerCall = calls.find((c) => c.args[0] === 'register')!;
    expect(registerCall.env?.[RUNNER_OAUTH_CLIENT_SECRET_ENV]).toBe(CLIENT_SECRET);
  });
});

// ---------------------------------------------------------------------------
// realShell — the real spawnSync wrapper's ENOENT → 127 mapping
// ---------------------------------------------------------------------------

describe('realShell', () => {
  test('a missing binary maps to code 127, never throws', () => {
    const r = realShell('definitely-not-a-real-binary-xyz-a6', ['--version']);
    expect(r.code).toBe(127);
  });
});
