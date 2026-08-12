// drive-executor-flag.test.ts — the `--executor` flag (c5, E8/E15): selects
// the ExecutorRunner IMPLEMENTATION for `pipeline drive`. Companion to c4's
// tests/sdk-seams.test.ts, which proves the SEAMS this flag wires in; this
// file proves the WIRING — parsing, the default, and the manifest-vs-flag
// precedence rule (01-modes.md) — without needing the real Agent SDK package
// installed anywhere.
//
// ── THE PROBE ────────────────────────────────────────────────────────────
//
// c4's sdkDriveSeams emits one warning line per command-template environment
// override that CANNOT apply to the SDK executor (tests/sdk-seams.test.ts),
// and it does so at CONSTRUCTION — before any step ever runs, independent of
// whether `deps.executor` is also injected to override the actual spawn. That
// makes it a clean, fast, install-nothing probe for "did runDrive select
// claude-sdk at all": set PIPELINE_DRIVE_EXECUTOR_CMD to any non-empty value,
// inject a plain in-process `deps.executor` fake so the run completes without
// spawning anything, and check whether that one line reached stderr. Present
// ⇒ sdkDriveSeams was built ⇒ claude-sdk was selected. Absent ⇒ it was not.

import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { computePlan, type Plan } from '../src/lib/plan';
import { EXECUTOR_KINDS, runDrive, type DriveDeps, type ExecutorRequest, type ExecutorRunner } from '../src/commands/drive';

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
}, 30000);

// ---------------------------------------------------------------------------
// Scaffolds
// ---------------------------------------------------------------------------

/** A plain v1 two-step pipeline. `runner:` is absent — v1 cannot even express
 *  `standalone` (only `manager`/`headless` round-trip through PIPELINE.md's
 *  frontmatter, `src/lib/plan.ts` computePlanFromMarkdown), so this scaffold
 *  is exactly the "manifest has no opinion" half of the precedence rule. */
function scaffoldV1(): string {
  const root = mkdtempSync(join(tmpdir(), 'drive-exec-v1-'));
  created.push(root);
  writeFileSync(join(root, 'PIPELINE.md'), '# P\n\n## End State\ndone\n');
  mkdirSync(join(root, 'steps'), { recursive: true });
  writeFileSync(join(root, 'steps', '01-a.md'), '# step a\n');
  writeFileSync(join(root, 'steps', '02-b.md'), '# step b\n');
  return root;
}

/** A v2 two-step pipeline.yml declaring `runner: standalone` — the ONLY
 *  runner value with an opinion on axis 2 (01-modes.md's combinations table:
 *  `driver`+`claude-sdk` IS what the mode name `standalone` means). */
function scaffoldStandalone(): string {
  const root = mkdtempSync(join(tmpdir(), 'drive-exec-v2-'));
  created.push(root);
  mkdirSync(join(root, 'steps'), { recursive: true });
  writeFileSync(join(root, 'steps', '01-a.md'), '# step a\n');
  writeFileSync(join(root, 'steps', '02-b.md'), '# step b\n');
  writeFileSync(
    join(root, 'pipeline.yml'),
    'schema: 2\nname: demo\nrunner: standalone\nsteps:\n' +
      '  - name: a\n    body: steps/01-a.md\n' +
      '  - name: b\n    body: steps/02-b.md\n',
  );
  return root;
}

/** A plain in-process ExecutorRunner: writes a `completed` record advancing
 *  to the next step (by `plan.steps` order), never spawns anything. Fast, and
 *  — because `deps.executor` always wins over both the SDK seams and the
 *  subprocess runner (same precedence as before c5) — usable regardless of
 *  which --executor was selected, so these tests can assert SELECTION without
 *  needing the real `claude`/`codex` binaries or the Agent SDK installed. */
function fakeExecutor(plan: Plan): { runner: ExecutorRunner; calls: ExecutorRequest[] } {
  const calls: ExecutorRequest[] = [];
  const runner: ExecutorRunner = async (req) => {
    calls.push(req);
    mkdirSync(dirname(req.record_file), { recursive: true });
    const idx = plan.steps.findIndex((s) => s.step_id === req.step_id);
    const next = idx >= 0 && idx + 1 < plan.steps.length ? plan.steps[idx + 1].path : 'PIPELINE_COMPLETE';
    writeFileSync(req.record_file, JSON.stringify({ outcome: 'completed', next_iteration: next }), 'utf8');
    return { code: 0 };
  };
  return { runner, calls };
}

const ENV_KEYS = [
  'PIPELINE_DRIVE_EXECUTOR_CMD',
  'PIPELINE_DRIVE_IMPROVER_CMD',
  'PIPELINE_DRIVE_SCRIPT_CREATOR_CMD',
  'PIPELINE_DRIVE_SELF_IMPROVE',
  'PIPELINE_RUN_ID',
  'PIPELINE_PARENT_RUN_ID',
  'PIPELINE_SYNC_LOCAL_STATS',
  'CLAUDE_SESSION_ID',
  'CLAUDE_PLUGIN_ROOT',
  'HOME',
  'USERPROFILE',
] as const;

/** Run `pipeline drive` IN-PROCESS with a sandboxed cwd/HOME (so auto-emitted
 *  UI events and any stray writes land inside the temp root, never the repo or
 *  the real ~/.claude — the same recipe tests/sdk-seams.test.ts uses) and the
 *  command-template env-var probe armed on all three variables. */
async function drive(
  root: string,
  runId: string,
  extraArgs: string[],
  makeDeps: () => DriveDeps,
  opts: { probeEnv?: boolean } = {},
): Promise<{ code: number; out: string; err: string }> {
  const saved = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));
  const prevCwd = process.cwd();
  if (opts.probeEnv !== false) {
    // A value that is not a real command — the probe only cares whether
    // sdkDriveSeams' inapplicability warning fires, never whether this
    // template could actually run (deps.executor always wins the spawn).
    process.env.PIPELINE_DRIVE_EXECUTOR_CMD = 'not-a-real-command --probe';
  } else {
    delete process.env.PIPELINE_DRIVE_EXECUTOR_CMD;
  }
  delete process.env.PIPELINE_DRIVE_IMPROVER_CMD;
  delete process.env.PIPELINE_DRIVE_SCRIPT_CREATOR_CMD;
  delete process.env.PIPELINE_DRIVE_SELF_IMPROVE;
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  for (const k of ['PIPELINE_RUN_ID', 'PIPELINE_PARENT_RUN_ID', 'PIPELINE_SYNC_LOCAL_STATS', 'CLAUDE_SESSION_ID', 'CLAUDE_PLUGIN_ROOT']) {
    delete process.env[k];
  }
  process.chdir(root);
  let outBuf = '';
  let errBuf = '';
  try {
    const code = await runDrive([...extraArgs], {
      ...makeDeps(),
      out: (s) => (outBuf += s),
      err: (s) => (errBuf += s),
    });
    return { code, out: outBuf, err: errBuf };
  } finally {
    process.chdir(prevCwd);
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// ---------------------------------------------------------------------------
// Parse-time validation — fast, no scaffold: these checks happen before
// runDrive ever touches the filesystem (same ordering as modelError/
// effortError/varsError), so a bogus --root is fine.
// ---------------------------------------------------------------------------

describe('--executor: parse-time validation (no silent fallback)', () => {
  test('an unknown value exits non-zero, naming the accepted set, never a silent claude-cli default', async () => {
    let errBuf = '';
    const code = await runDrive(
      ['--root', 'does-not-matter', '--run-id', 'r', '--start', 's', '--executor', 'sdk'],
      { out: () => {}, err: (s) => (errBuf += s) },
    );
    expect(code).toBe(2);
    expect(errBuf).toContain('--executor');
    expect(errBuf).toContain('unknown value');
    expect(errBuf).toContain('"sdk"');
    for (const k of EXECUTOR_KINDS) expect(errBuf).toContain(k);
  });

  test('subagent is rejected with a session-only explanation, not the generic "unknown value" message', async () => {
    let errBuf = '';
    const code = await runDrive(
      ['--root', 'does-not-matter', '--run-id', 'r', '--start', 's', '--executor', 'subagent'],
      { out: () => {}, err: (s) => (errBuf += s) },
    );
    expect(code).toBe(2);
    expect(errBuf).toContain('subagent');
    expect(errBuf.toLowerCase()).toContain('session');
    expect(errBuf).not.toContain('unknown value');
  });
});

// ---------------------------------------------------------------------------
// USAGE — --executor vs --executor-cmd, distinguished in one line each
// ---------------------------------------------------------------------------

test('USAGE documents --executor and --executor-cmd on two distinct, self-explaining lines', async () => {
  let outBuf = '';
  const code = await runDrive(['--help'], { out: (s) => (outBuf += s), err: () => {} });
  expect(code).toBe(0);
  const lines = outBuf.split('\n');
  const execLine = lines.find((l) => l.includes('--executor ') || l.includes('--executor <'));
  const execCmdLine = lines.find((l) => l.includes('--executor-cmd'));
  expect(execLine).toBeDefined();
  expect(execCmdLine).toBeDefined();
  expect(execLine).not.toBe(execCmdLine);
  // Each line says what it does, so the reader is not left to guess apart two
  // similarly-named flags.
  expect(execLine!.toLowerCase()).toContain('implementation');
  expect(execCmdLine!.toLowerCase()).toContain('template');
  for (const k of EXECUTOR_KINDS) expect(execLine).toContain(k);
});

// ---------------------------------------------------------------------------
// Accepted values — a full (fake-executor-backed) run for each
// ---------------------------------------------------------------------------

describe('--executor accepts exactly claude-cli, claude-sdk, codex-cli', () => {
  for (const kind of EXECUTOR_KINDS) {
    test(`--executor=${kind} runs a step to completion`, async () => {
      const root = scaffoldV1();
      const plan = computePlan(root);
      const fake = fakeExecutor(plan);
      const r = await drive(
        root,
        `accept-${kind}`,
        ['--root', root, '--run-id', `accept-${kind}`, '--start', plan.steps[0].path, '--executor', kind],
        () => ({ executor: fake.runner }),
      );
      expect(r.code).toBe(0);
      expect(fake.calls.length).toBeGreaterThan(0);
    }, 30000);
  }
});

// ---------------------------------------------------------------------------
// Absent the flag — identical to today
// ---------------------------------------------------------------------------

describe('absent --executor, a manifest with no opinion: behaviour is identical to today', () => {
  test('no --executor, v1 manifest (no runner: standalone possible) ⇒ claude-cli, no override, no SDK construction', async () => {
    const root = scaffoldV1();
    const plan = computePlan(root);
    expect(plan.runner).not.toBe('standalone'); // sanity: v1 truly cannot express it
    const fake = fakeExecutor(plan);
    const runId = 'default-v1';
    const r = await drive(root, runId, ['--root', root, '--run-id', runId, '--start', plan.steps[0].path], () => ({
      executor: fake.runner,
    }));
    expect(r.code).toBe(0);
    expect(fake.calls.length).toBe(2); // both steps really ran
    // sdkDriveSeams was never built — its env-var inapplicability warning
    // (armed via the probe) never fires. That IS the proof claude-cli (the
    // subprocess path) was selected, exactly as before this flag existed.
    expect(r.err).not.toContain('PIPELINE_DRIVE_EXECUTOR_CMD');
    expect(r.err).not.toContain('executor.override');
  }, 30000);
});

// ---------------------------------------------------------------------------
// Manifest-versus-flag precedence (01-modes.md) — both halves, plus once-ness
// ---------------------------------------------------------------------------

describe('manifest-versus-flag precedence: runner: standalone', () => {
  test('manifest speaks alone (no --executor) ⇒ manifest wins: claude-sdk is selected, no override reported', async () => {
    const root = scaffoldStandalone();
    const plan = computePlan(root);
    expect(plan.runner).toBe('standalone'); // sanity on the scaffold itself
    const fake = fakeExecutor(plan);
    const runId = 'manifest-alone';
    const r = await drive(root, runId, ['--root', root, '--run-id', runId, '--start', plan.steps[0].path], () => ({
      executor: fake.runner,
    }));
    expect(r.code).toBe(0);
    expect(fake.calls.length).toBe(2);
    // sdkDriveSeams WAS built (claude-sdk chosen) — its armed env-var probe
    // fires, proving the manifest's implied executor took effect.
    expect(r.err).toContain('PIPELINE_DRIVE_EXECUTOR_CMD');
    expect(r.err).toContain('does NOT apply');
    // Nobody overrode anything, so there is nothing to report.
    expect(r.err).not.toContain('executor.override');
  }, 30000);

  test('both speak and differ (--executor=claude-cli) ⇒ the flag wins, reported ONCE — not per step', async () => {
    const root = scaffoldStandalone();
    const plan = computePlan(root);
    const fake = fakeExecutor(plan);
    const runId = 'flag-wins';
    const r = await drive(
      root,
      runId,
      ['--root', root, '--run-id', runId, '--start', plan.steps[0].path, '--executor', 'claude-cli'],
      () => ({ executor: fake.runner }),
    );
    expect(r.code).toBe(0);
    expect(fake.calls.length).toBe(2); // a two-step run — "once" is not vacuous
    // The flag genuinely won: sdkDriveSeams was NEVER built, so its env-var
    // probe cannot have fired.
    expect(r.err).not.toContain('PIPELINE_DRIVE_EXECUTOR_CMD');
    // …and the override IS reported, in a human-readable form naming both
    // sides of the conflict…
    expect(r.err).toContain('executor.override');
    expect(r.err).toContain('standalone');
    expect(r.err).toContain('claude-cli');
    // …exactly once for the whole run, never once per step.
    expect(countOccurrences(r.err, 'executor.override')).toBe(1);
  }, 30000);

  test('both speak and agree (--executor=claude-sdk) ⇒ nothing was overridden, so nothing is reported', async () => {
    const root = scaffoldStandalone();
    const plan = computePlan(root);
    const fake = fakeExecutor(plan);
    const runId = 'flag-agrees';
    const r = await drive(
      root,
      runId,
      ['--root', root, '--run-id', runId, '--start', plan.steps[0].path, '--executor', 'claude-sdk'],
      () => ({ executor: fake.runner }),
    );
    expect(r.code).toBe(0);
    // claude-sdk either way ⇒ sdkDriveSeams built ⇒ the probe fires…
    expect(r.err).toContain('PIPELINE_DRIVE_EXECUTOR_CMD');
    // …but there was no actual override (the flag only confirmed the
    // manifest's own default), so the override report stays silent.
    expect(r.err).not.toContain('executor.override');
  }, 30000);
});
