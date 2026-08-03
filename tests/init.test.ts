// Tests for `pipeline init` (src/commands/init.ts) — the one-command
// local-first entry point (simplified-onboarding design, task a1).
//
// Every side effect (claude on PATH, the plugin shell-out, the headless run
// engine, the yes/no prompt) is injected via InitDeps, so these tests drive
// the FULL composition with zero real subprocess/network/stdin. The clone
// step itself is exercised for REAL (a fast local fs copy of the bundled
// support-answer template into a temp dir) so computePlan() sees a genuine
// pipeline root — only claude/drive/prompt are faked.
//
// plugin-thin 01-remove-local-ui.md phase 1: init no longer starts the local
// dashboard (see src/commands/init.ts's header comment) — the dashboard
// coverage that used to live here (startUi injection, "✓ Dashboard running",
// parseUiStartOutput) is gone with the step it tested.
//
// Coverage:
//   - parseInitArgs: defaults, every flag, --dir, usage errors.
//   - The happy path (2 commands + 1 confirmation) end to end with fakes.
//   - Idempotent re-run: every step prints ✓, including "(already present)".
//   - Every row of 03-pipeline-init.md §4's failure table.
//   - --json's documented shape, verbatim, for both examples in §5.
//   - --no-plugin / --no-run / --yes / --run composition.
//   - The "session already open" next-action line.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cloudConnectArgs,
  cloudStepDecision,
  parseInitArgs,
  runInit,
  type InitDeps,
  type ShellResult,
  type ClaudeCliRunner,
} from '../src/commands/init';
import type { DriveDeps } from '../src/commands/drive';

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-init-'));
  created.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Fake deps harness
// ---------------------------------------------------------------------------

interface Harness {
  deps: InitDeps;
  stdout: () => string;
  stderr: () => string;
  claudeCliCalls: string[][];
  driveCalls: Array<{ args: string[] }>;
  promptCalls: string[];
  /** Every `cloud connect` argv init composed — empty when it never tried. */
  cloudCalls: string[][];
}

interface HarnessOpts {
  claudeAvailable?: boolean;
  bunAvailable?: boolean;
  claudeCli?: (args: string[]) => ShellResult;
  /** Fake headless run engine. Default: 3 support-answer steps, all succeed,
   *  0.1s apart on the fake clock. */
  runDrive?: (args: string[], driveDeps: DriveDeps) => Promise<number>;
  promptAnswer?: boolean;
  env?: Record<string, string | undefined>;
  /** Fake `cloud connect`. Default: succeeds. Never touches a network — the
   *  real one is composed in-process (`InitDeps.cloudConnect`), so a test that
   *  reached the wire would mean the seam had been bypassed. */
  cloudConnect?: (args: string[]) => Promise<number>;
}

const SUPPORT_ANSWER_STEPS = ['01-retrieve', '02-select', '03-answer'];

/** A fake runDrive that emits a realistic step.started/step.completed
 *  progress stream (exactly what commands/drive.ts emits on --json) for the
 *  given step ids, advancing `clock` by `stepMs` per step, then resolves with
 *  `finalCode`. `failAt` (if set) emits step.failed for that step instead and
 *  the run halts. */
function fakeSuccessfulDrive(opts: {
  clock: { t: number };
  stepMs?: number;
  failAt?: string;
  failReason?: string;
}): (args: string[], driveDeps: DriveDeps) => Promise<number> {
  const stepMs = opts.stepMs ?? 2100;
  return async (_args, driveDeps) => {
    for (const id of SUPPORT_ANSWER_STEPS) {
      driveDeps.err?.(JSON.stringify({ event: 'step.started', step_id: id }) + '\n');
      opts.clock.t += stepMs;
      if (opts.failAt === id) {
        driveDeps.err?.(JSON.stringify({ event: 'step.failed', step_id: id, reason: opts.failReason ?? 'boom' }) + '\n');
        return 1;
      }
      driveDeps.err?.(JSON.stringify({ event: 'step.completed', step_id: id, outcome: 'complete' }) + '\n');
    }
    return 0;
  };
}

function harness(opts: HarnessOpts = {}): Harness {
  let stdout = '';
  let stderr = '';
  const claudeCliCalls: string[][] = [];
  const driveCalls: Array<{ args: string[] }> = [];
  const promptCalls: string[] = [];
  const cloudCalls: string[][] = [];
  const clock = { t: 0 };

  const claudeCliImpl: ClaudeCliRunner =
    opts.claudeCli ??
    (() => ({ code: 0, stdout: 'ok\n', stderr: '' }));

  const runDriveImpl = opts.runDrive ?? fakeSuccessfulDrive({ clock });

  const deps: InitDeps = {
    cwd: tmpdir(),
    env: opts.env ?? {},
    now: () => clock.t,
    out: (s) => {
      stdout += s;
    },
    err: (s) => {
      stderr += s;
    },
    bunAvailable: () => opts.bunAvailable ?? true,
    claudeAvailable: () => opts.claudeAvailable ?? true,
    claudeCli: (args) => {
      claudeCliCalls.push(args);
      return claudeCliImpl(args);
    },
    cloudConnect: async (args) => {
      cloudCalls.push(args);
      return opts.cloudConnect ? opts.cloudConnect(args) : 0;
    },
    runDrive: async (args, driveDeps) => {
      driveCalls.push({ args });
      return runDriveImpl(args, driveDeps);
    },
    promptYesNo: async (q) => {
      promptCalls.push(q);
      return opts.promptAnswer ?? true;
    },
  };
  return {
    deps,
    stdout: () => stdout,
    stderr: () => stderr,
    claudeCliCalls,
    driveCalls,
    promptCalls,
    cloudCalls,
  };
}

// ---------------------------------------------------------------------------
// parseInitArgs
// ---------------------------------------------------------------------------

describe('parseInitArgs', () => {
  test('defaults: support-answer, cloud ON, no flags set', () => {
    const r = parseInitArgs([]);
    expect(r).toEqual({
      template: 'support-answer',
      noPlugin: false,
      noRun: false,
      run: false,
      yes: false,
      json: false,
      help: false,
      // Cloud-first: `local` is the OPT-OUT, so its default is false.
      local: false,
      noRunner: false,
      deprecatedNoUi: false,
    });
  });

  test('a leading positional sets the template', () => {
    const r = parseInitArgs(['ship-feature']);
    expect('error' in r).toBe(false);
    expect((r as { template: string }).template).toBe('ship-feature');
  });

  test('every flag parses, including -y and --dir', () => {
    const r = parseInitArgs([
      '--no-plugin', '--run', '-y', '--dir', '/tmp/x', '--json',
      '--server', 'http://127.0.0.1:39500', '--org', 'acme', '--project', 'proj', '--no-runner',
    ]);
    expect(r).toEqual({
      template: 'support-answer',
      noPlugin: true,
      noRun: false,
      run: true,
      yes: true,
      dir: '/tmp/x',
      json: true,
      help: false,
      local: false,
      server: 'http://127.0.0.1:39500',
      org: 'acme',
      project: 'proj',
      noRunner: true,
      deprecatedNoUi: false,
    });
  });

  test('the cloud flags accept the --flag=value form too', () => {
    const r = parseInitArgs(['--server=http://x', '--org=acme', '--project=p']);
    expect(r).toEqual({
      template: 'support-answer',
      noPlugin: false, noRun: false, run: false, yes: false, json: false, help: false,
      local: false, noRunner: false, deprecatedNoUi: false,
      server: 'http://x', org: 'acme', project: 'p',
    });
  });

  test('--no-ui is accepted as a deprecated no-op, not rejected (plugin-thin phase 1)', () => {
    // The dashboard step is gone, so the flag controls nothing — but a setup
    // script that still passes it predates the change and must not start failing
    // with a usage error over a flag whose whole effect was "do less". Same
    // stance as the deprecated \ alias.
    const parsed = parseInitArgs(['--no-ui']);
    expect('error' in parsed).toBe(false);
    expect((parsed as { deprecatedNoUi: boolean }).deprecatedNoUi).toBe(true);
  });

  test('a cloud flag with no value is a usage error, not a silent skip', () => {
    // `--server` eating the next flag as its value is how someone ends up
    // connecting to a control plane named `--org`.
    expect(parseInitArgs(['--server'])).toEqual({ error: '--server requires a value' });
    expect(parseInitArgs(['--org'])).toEqual({ error: '--org requires a value' });
  });

  test('--local with a cloud flag is a usage error', () => {
    // Honouring one of the two silently is how a user ends up connected when
    // they explicitly asked not to be.
    expect(parseInitArgs(['--local', '--org', 'acme'])).toEqual({
      error: 'cannot combine --local and --org',
    });
    expect(parseInitArgs(['--local', '--no-runner'])).toEqual({
      error: 'cannot combine --local and --no-runner',
    });
  });

  test('--dir=path form', () => {
    const r = parseInitArgs(['--dir=/a/b']);
    expect('error' in r).toBe(false);
    expect((r as { dir?: string }).dir).toBe('/a/b');
  });

  test('unknown flag is a usage error', () => {
    const r = parseInitArgs(['--bogus']);
    expect(r).toEqual({ error: "unknown flag '--bogus'" });
  });

  test('a second positional is a usage error', () => {
    const r = parseInitArgs(['a', 'b']);
    expect('error' in r).toBe(true);
  });

  test('--run and --no-run together is a usage error', () => {
    const r = parseInitArgs(['--run', '--no-run']);
    expect(r).toEqual({ error: 'cannot combine --run and --no-run' });
  });

  test('--help sets help', () => {
    expect((parseInitArgs(['--help']) as { help: boolean }).help).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

describe('pipeline init — happy path', () => {
  test('clean scratch dir: claude+plugin+clone+ui+run all succeed, prints the /pipeline:design next-line', async () => {
    const proj = tempProject();
    const h = harness();
    const code = await runInit(['--dir', proj, '--yes'], h.deps);
    expect(code).toBe(0);
    const out = h.stdout();
    expect(out).toContain('✓ Claude Code found');
    expect(out).toContain('✓ Plugin installed');
    expect(out).toContain('✓ Starter pipeline cloned   .pipeline/support-answer');
    expect(out).not.toContain('(already present)');
    expect(out).not.toContain('Dashboard'); // plugin-thin phase 1: no longer part of onboarding
    expect(out).toContain('Run it now? [Y/n] y');
    expect(out).toContain('▶ support-answer');
    // Per-step lines with timing, in order.
    expect(out).toContain('01-retrieve');
    expect(out).toContain('02-select');
    expect(out).toContain('03-answer');
    expect(out).toContain('✓ Complete');
    expect(out).toContain('Next: open Claude Code here and type  /pipeline:design <your goal>');
    expect(existsSync(join(proj, '.pipeline', 'support-answer', 'PIPELINE.md'))).toBe(true);
  });

  test('per-step lines show the resolved elapsed time from the injected clock', async () => {
    const proj = tempProject();
    const h = harness();
    await runInit(['--dir', proj, '--run'], h.deps);
    const out = h.stdout();
    // fakeSuccessfulDrive advances the clock by 2100ms per step → "2.1s".
    expect(out).toMatch(/01-retrieve\s+✓ 2\.1s/);
    expect(out).toMatch(/02-select\s+✓ 2\.1s/);
    expect(out).toMatch(/03-answer\s+✓ 2\.1s/);
  });

  test('--run skips the prompt entirely and runs without asking', async () => {
    const proj = tempProject();
    const h = harness();
    const code = await runInit(['--dir', proj, '--run'], h.deps);
    expect(code).toBe(0);
    expect(h.stdout()).not.toContain('Run it now?');
    expect(h.promptCalls.length).toBe(0);
    expect(h.driveCalls.length).toBe(1);
  });

  test('declining the prompt does not run, and suggests `pipeline run <template>`', async () => {
    const proj = tempProject();
    const h = harness({ promptAnswer: false });
    const code = await runInit(['--dir', proj], h.deps);
    expect(code).toBe(0);
    expect(h.driveCalls.length).toBe(0);
    expect(h.stdout()).toContain('Next: pipeline run support-answer');
  });

  test('re-running a fully set-up project is idempotent: ✓ per step, "(already present)", and re-offers the run', async () => {
    const proj = tempProject();
    const h1 = harness();
    expect(await runInit(['--dir', proj, '--run'], h1.deps)).toBe(0);

    const h2 = harness();
    const code = await runInit(['--dir', proj, '--run'], h2.deps);
    expect(code).toBe(0);
    const out = h2.stdout();
    expect(out).toContain('✓ Claude Code found');
    expect(out).toContain('✓ Plugin installed');
    expect(out).toContain('✓ Starter pipeline cloned   .pipeline/support-answer (already present)');
    expect(out).toContain('▶ support-answer'); // re-offered and ran again
    expect(out).toContain('✓ Complete');
  });
});

// ---------------------------------------------------------------------------
// --json (03-pipeline-init.md §5)
// ---------------------------------------------------------------------------

describe('pipeline init --json', () => {
  test('emits the documented shape and NEVER runs without --run', async () => {
    const proj = tempProject();
    // `--json` with a machine credential connects silently — that is the ONE
    // rung with no browser and no TTY, so it is the shape a CI run gets.
    const h = harness({ env: { PIPELINE_MACHINE_TOKEN: 'mc_test' } });
    const code = await runInit(['--dir', proj, '--json'], h.deps);
    expect(code).toBe(0);
    expect(h.driveCalls.length).toBe(0);
    expect(h.promptCalls.length).toBe(0);
    expect(h.stdout().trim().split('\n')).toHaveLength(1); // ONE json line, no prompt/checklist noise
    const parsed = JSON.parse(h.stdout().trim());
    expect(parsed).toEqual({
      ok: true,
      cloud: 'connected',
      plugin: 'installed',
      template: 'support-answer',
      path: '.pipeline/support-answer',
      ran: false,
    });
  });

  test('--json --run executes and reports runOk:true', async () => {
    const proj = tempProject();
    const h = harness({ env: { PIPELINE_MACHINE_TOKEN: 'mc_test' } });
    const code = await runInit(['--dir', proj, '--json', '--run'], h.deps);
    expect(code).toBe(0);
    expect(h.driveCalls.length).toBe(1);
    const lines = h.stdout().trim().split('\n');
    const parsed = JSON.parse(lines[lines.length - 1]!);
    expect(parsed).toEqual({
      ok: true,
      cloud: 'connected',
      plugin: 'installed',
      template: 'support-answer',
      path: '.pipeline/support-answer',
      ran: true,
      runOk: true,
    });
  });

  test('--json --run never prints the human step display', async () => {
    const proj = tempProject();
    const h = harness();
    await runInit(['--dir', proj, '--json', '--run'], h.deps);
    expect(h.stdout()).not.toContain('▶');
    expect(h.stdout()).not.toContain('Run it now?');
  });

  test('--json --run surfaces a failed run as ok:false / runOk:false and exit 1', async () => {
    const proj = tempProject();
    const clock = { t: 0 };
    const h = harness({ runDrive: fakeSuccessfulDrive({ clock, failAt: '02-select', failReason: 'no valid step record' }) });
    const code = await runInit(['--dir', proj, '--json', '--run'], h.deps);
    expect(code).toBe(1);
    const parsed = JSON.parse(h.stdout().trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.ran).toBe(true);
    expect(parsed.runOk).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 03-pipeline-init.md §4 — every failure row
// ---------------------------------------------------------------------------

describe('failure modes (03-pipeline-init.md §4)', () => {
  test('bun missing: fails with the install URL, exit 1', async () => {
    const proj = tempProject();
    const h = harness({ bunAvailable: false });
    const code = await runInit(['--dir', proj], h.deps);
    expect(code).toBe(1);
    expect(h.stderr()).toContain('https://bun.sh');
    expect(h.claudeCliCalls.length).toBe(0);
    expect(existsSync(join(proj, '.claude'))).toBe(false);
  });

  test('claude missing: warns, skips plugin install AND the run, exit 0, prints the remediation line', async () => {
    const proj = tempProject();
    const h = harness({ claudeAvailable: false });
    const code = await runInit(['--dir', proj], h.deps);
    expect(code).toBe(0);
    expect(h.claudeCliCalls.length).toBe(0);
    expect(h.driveCalls.length).toBe(0);
    expect(h.promptCalls.length).toBe(0);
    const out = h.stdout();
    expect(out).toContain('Claude Code not found on PATH');
    expect(out).toContain('Install Claude Code, then re-run: pipeline init');
    // The clone still ran.
    expect(existsSync(join(proj, '.pipeline', 'support-answer', 'PIPELINE.md'))).toBe(true);
  });

  test('claude missing, --json: exits 0, ran:false, plugin:"skipped", warns in the warnings array', async () => {
    const proj = tempProject();
    const h = harness({ claudeAvailable: false });
    const code = await runInit(['--dir', proj, '--json'], h.deps);
    expect(code).toBe(0);
    const parsed = JSON.parse(h.stdout().trim());
    expect(parsed.ok).toBe(true);
    expect(parsed.plugin).toBe('skipped');
    expect(parsed.ran).toBe(false);
    expect(parsed.warnings.join(' ')).toContain('claude not found');
  });

  test('claude present but unauthenticated: the run fails, reports its output AND the claude login command, exit 1', async () => {
    const proj = tempProject();
    const clock = { t: 0 };
    const h = harness({
      runDrive: fakeSuccessfulDrive({ clock, failAt: '01-retrieve', failReason: 'claude error: invalid_api_key' }),
    });
    const code = await runInit(['--dir', proj, '--run'], h.deps);
    expect(code).toBe(1);
    expect(h.stdout()).toContain('01-retrieve');
    expect(h.stdout()).toContain('✗');
    expect(h.stderr()).toContain('invalid_api_key'); // its output
    expect(h.stderr()).toContain('claude /login'); // the claude login command (03 §4)
  });

  test('`claude plugin install` non-zero: warns with stderr, continues (clone + run still happen)', async () => {
    const proj = tempProject();
    let call = 0;
    const h = harness({
      claudeCli: (args) => {
        call++;
        if (args[0] === 'plugin' && args[1] === 'install') {
          return { code: 1, stdout: '', stderr: 'network unreachable' };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    const code = await runInit(['--dir', proj, '--run'], h.deps);
    expect(code).toBe(0);
    expect(call).toBe(2); // marketplace add + install both attempted
    const out = h.stdout();
    expect(out).toContain('network unreachable');
    expect(out).toContain('continuing');
    // The clone and the run still happened.
    expect(existsSync(join(proj, '.pipeline', 'support-answer', 'PIPELINE.md'))).toBe(true);
    expect(out).toContain('✓ Complete');
  });

  test('template already cloned: ✓ (already present), not an error', async () => {
    const proj = tempProject();
    // Pre-clone it (simulate a prior run / manual clone).
    mkdirSync(join(proj, '.pipeline', 'support-answer'), { recursive: true });
    const h = harness();
    const code = await runInit(['--dir', proj, '--no-run'], h.deps);
    expect(code).toBe(0);
    expect(h.stdout()).toContain('✓ Starter pipeline cloned   .pipeline/support-answer (already present)');
  });

  test('starter run fails: reports the failing step + its output, exit 1', async () => {
    const proj = tempProject();
    const clock = { t: 0 };
    const h = harness({ runDrive: fakeSuccessfulDrive({ clock, failAt: '03-answer', failReason: 'no valid step record at ...' }) });
    const code = await runInit(['--dir', proj, '--run'], h.deps);
    expect(code).toBe(1);
    expect(h.stdout()).toContain('03-answer');
    expect(h.stdout()).toContain('✗');
    expect(h.stderr()).toContain('the starter run failed');
    expect(h.stderr()).toContain('no valid step record');
    // No "Next:" success line on a failure.
    expect(h.stdout()).not.toContain('Next:');
  });
});

// ---------------------------------------------------------------------------
// Flag composition
// ---------------------------------------------------------------------------

describe('flag composition', () => {
  test('--no-plugin skips the plugin shell-out entirely but still offers the run', async () => {
    const proj = tempProject();
    const h = harness();
    const code = await runInit(['--dir', proj, '--no-plugin', '--run'], h.deps);
    expect(code).toBe(0);
    expect(h.claudeCliCalls.length).toBe(0);
    expect(h.stdout()).not.toContain('Plugin installed');
    expect(h.driveCalls.length).toBe(1);
  });

  test('--no-run: no prompt, no run, "Next: pipeline run <template>"', async () => {
    const proj = tempProject();
    const h = harness();
    const code = await runInit(['--dir', proj, '--no-run'], h.deps);
    expect(code).toBe(0);
    expect(h.promptCalls.length).toBe(0);
    expect(h.driveCalls.length).toBe(0);
    expect(h.stdout()).toContain('Next: pipeline run support-answer');
  });

  test('unknown template: exit 2, lists available templates', async () => {
    const proj = tempProject();
    const h = harness();
    const code = await runInit(['does-not-exist', '--dir', proj], h.deps);
    expect(code).toBe(2);
    expect(h.stderr()).toContain("unknown template 'does-not-exist'");
    expect(h.stderr()).toContain('support-answer');
  });

  test('ship-feature template clones under its own name', async () => {
    const proj = tempProject();
    const h = harness();
    const code = await runInit(['ship-feature', '--dir', proj, '--no-run'], h.deps);
    expect(code).toBe(0);
    expect(existsSync(join(proj, '.pipeline', 'ship-feature', 'PIPELINE.md'))).toBe(true);
    expect(h.stdout()).toContain('.pipeline/ship-feature');
  });
});

// ---------------------------------------------------------------------------
// "session already open" next-action line
// ---------------------------------------------------------------------------

describe('the cloud step (cloud-first default)', () => {
  test('connects BY DEFAULT, with no flag asked for', async () => {
    // The headline behaviour change: a bare `pipeline init` reaches the cloud.
    const proj = tempProject();
    const h = harness();
    const code = await runInit(['--dir', proj, '--run'], h.deps);
    expect(code).toBe(0);
    expect(h.cloudCalls).toHaveLength(1);
    // And it enrols this machine, because a machine that is not a runner
    // cannot pick up cloud-dispatched work — the point of connecting.
    expect(h.cloudCalls[0]).toContain('--runner');
  });

  test('--local connects to nothing at all', async () => {
    const proj = tempProject();
    const h = harness();
    const code = await runInit(['--dir', proj, '--local', '--run'], h.deps);
    expect(code).toBe(0);
    expect(h.cloudCalls).toHaveLength(0);
    // And it SAYS so, rather than leaving the reader to infer it.
    expect(h.stdout()).toContain('local only');
    expect(h.stdout()).not.toContain('⚠');
  });

  test('runs the cloud step FIRST, before the plugin install and the clone', async () => {
    // The browser consent is the one thing needing a human. Making it wait
    // behind a plugin install is how a user walks away mid-setup.
    const order: string[] = [];
    const proj = tempProject();
    const h = harness({
      cloudConnect: async () => {
        order.push('cloud');
        return 0;
      },
      claudeCli: () => {
        order.push('plugin');
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    await runInit(['--dir', proj, '--no-run'], h.deps);
    expect(order[0]).toBe('cloud');
    expect(order).toContain('plugin');
  });

  test('a failed connect WARNS and finishes locally, exit 0', async () => {
    // Everything below the cloud step works unconnected. An init that aborted
    // on a declined consent screen would leave the user with nothing.
    const proj = tempProject();
    const h = harness({ cloudConnect: async () => 1 });
    const code = await runInit(['--dir', proj, '--run'], h.deps);
    expect(code).toBe(0);
    expect(h.stdout()).toContain('Not connected');
    expect(h.stdout()).toContain('pipeline cloud connect');
    // The local half still happened.
    expect(existsSync(join(proj, '.pipeline', 'support-answer'))).toBe(true);
    expect(h.driveCalls).toHaveLength(1);
  });

  test('a THROWING connect is contained, not propagated', async () => {
    const proj = tempProject();
    const h = harness({
      cloudConnect: async () => {
        throw new Error('socket hang up');
      },
    });
    const code = await runInit(['--dir', proj, '--no-run'], h.deps);
    expect(code).toBe(0);
    expect(h.stdout()).toContain('socket hang up');
  });

  test('names the dashboard only when a run actually reached it', async () => {
    const proj = tempProject();
    const connected = harness();
    await runInit(['--dir', proj, '--run'], connected.deps);
    expect(connected.stdout()).toContain('on your dashboard');

    // No run ⇒ no line: pointing someone at an empty dashboard is worse than
    // saying nothing.
    const proj2 = tempProject();
    const noRun = harness();
    await runInit(['--dir', proj2, '--no-run'], noRun.deps);
    expect(noRun.stdout()).not.toContain('on your dashboard');
  });

  test('--server is honoured by the dashboard line, not just by the connect', async () => {
    const proj = tempProject();
    const h = harness();
    await runInit(['--dir', proj, '--run', '--server', 'http://127.0.0.1:39500'], h.deps);
    expect(h.stdout()).toContain('http://127.0.0.1:39500');
    expect(h.stdout()).not.toContain('api.ai-pipeline.dev');
  });
});

describe('cloudStepDecision / cloudConnectArgs', () => {
  const opts = (over: Partial<ReturnType<typeof baseOpts>> = {}) => ({ ...baseOpts(), ...over });
  function baseOpts() {
    const parsed = parseInitArgs([]);
    if ('error' in parsed) throw new Error('unreachable');
    return parsed;
  }

  test('--json NEVER opens a browser, and says why', () => {
    // CI/bots/agents run --json. A browser flow there blocks until its
    // five-minute timeout and then fails.
    const d = cloudStepDecision(opts({ json: true }), {});
    expect(d.run).toBe(false);
    expect((d as { reason: string }).reason).toContain('PIPELINE_MACHINE_TOKEN');
  });

  test('--json WITH a machine credential connects silently', () => {
    expect(cloudStepDecision(opts({ json: true }), { PIPELINE_MACHINE_TOKEN: 'mc_x' }).run).toBe(true);
  });

  test('a blank machine token counts as absent', () => {
    // An env var set to '' is the classic "configured but empty" CI mistake.
    expect(cloudStepDecision(opts({ json: true }), { PIPELINE_MACHINE_TOKEN: '  ' }).run).toBe(false);
  });

  test('--local is silent, not a warning', () => {
    const d = cloudStepDecision(opts({ local: true }), {});
    expect(d.run).toBe(false);
    expect((d as { reason: string | null }).reason).toBeNull();
  });

  test('every cloud flag is passed through to connect', () => {
    const args = cloudConnectArgs(
      opts({ server: 'http://x', org: 'acme', project: 'p', json: true }),
    );
    expect(args).toEqual([
      '--server', 'http://x',
      '--org', 'acme',
      '--project', 'p',
      '--runner',
      '--json',
    ]);
  });

  test('--no-runner reaches connect as --no-runner', () => {
    expect(cloudConnectArgs(opts({ noRunner: true }))).toEqual(['--no-runner']);
  });
});

describe('the next-action line', () => {
  test('no session-open signal → suggests /pipeline:design', async () => {
    const proj = tempProject();
    const h = harness({ env: {} });
    await runInit(['--dir', proj, '--run'], h.deps);
    expect(h.stdout()).toContain('/pipeline:design <your goal>');
  });

  test('CLAUDECODE set → "Restart Claude Code to load the plugin."', async () => {
    const proj = tempProject();
    const h = harness({ env: { CLAUDECODE: '1' } });
    await runInit(['--dir', proj, '--run'], h.deps);
    expect(h.stdout()).toContain('Restart Claude Code to load the plugin.');
    expect(h.stdout()).not.toContain('/pipeline:design');
  });
});

