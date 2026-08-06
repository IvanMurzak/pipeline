// drive-telemetry-link.test.ts — ux-v2 `b12`: the dashboard link `pipeline
// drive` prints before step 1, the local-only in-process journal tail, and
// the daemon-spawn gating. Runs `runDrive` IN-PROCESS (like drive.test.ts's
// own `driveMerge` helper) rather than as a subprocess, for two reasons:
//   - speed (no double Node/Bun startup per test), and
//   - SAFETY: `ensureTelemetryDaemonRunning` can spawn a REAL detached
//     background process when it wins the daemon lock. Every test that
//     reaches a connected project pre-seeds `daemon.lock` with THIS test
//     process's own (always-alive) pid first, so the function takes the
//     "already running" branch and never actually spawns — the same
//     precaution `apps/pipeline-cli/tests/hook-telemetry-daemon-lock.test.ts`
//     documents for the hook's own copy.

import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computePlan } from '../src/lib/plan';
import { composeRunLink, runDrive, type ExecutorRunner } from '../src/commands/drive';
import { telemetryDir } from '../src/lib/telemetry-outbox';
import { telemetryDaemonLockPath } from '../src/commands/telemetry-daemon';
import { uploadStatePath, UPLOAD_STATE_SCHEMA } from '../src/lib/telemetry-upload';

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'drive-link-'));
  created.push(root);
  writeFileSync(join(root, 'PIPELINE.md'), '# P\n\n## End State\nx\n');
  mkdirSync(join(root, 'steps'), { recursive: true });
  writeFileSync(join(root, 'steps', '01-step.md'), '# step 01\n');
  return root;
}

function connectProject(root: string, over: Partial<{ server: string; org: string }> = {}): void {
  mkdirSync(join(root, '.pipeline'), { recursive: true });
  writeFileSync(
    join(root, '.pipeline', 'cloud.json'),
    JSON.stringify({
      server: over.server ?? 'https://api.ai-pipeline.dev',
      org: over.org ?? 'acme',
      project: 'proj',
      connected_at: new Date().toISOString(),
    }),
  );
}

/** Pre-seed a "live" daemon lock under THIS test process's own (always-alive)
 *  pid so `ensureTelemetryDaemonRunning` never actually spawns — see this
 *  file's header. */
function seedLiveDaemonLock(root: string): void {
  const lockPath = telemetryDaemonLockPath(root);
  mkdirSync(join(root, '.pipeline', '.runtime', 'telemetry'), { recursive: true });
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }) + '\n');
}

function inProcessExecutor(records: Record<string, unknown>): ExecutorRunner {
  return async (req) => {
    const rec = records[req.step_id];
    if (rec === undefined) return { code: 7 };
    writeFileSync(req.record_file, JSON.stringify(rec), 'utf8');
    return { code: 0 };
  };
}

/** Run `pipeline drive` IN-PROCESS with cwd/HOME sandboxed to `root`, exactly
 *  as drive.test.ts's own `driveMerge` does. */
async function driveInProcess(root: string, runId: string, records: Record<string, unknown>) {
  const plan = computePlan(root);
  let outBuf = '';
  let errBuf = '';
  const prevCwd = process.cwd();
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.chdir(root);
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  try {
    const code = await runDrive(['--root', root, '--run-id', runId, '--start', plan.steps[0].path], {
      executor: inProcessExecutor(records),
      out: (s) => (outBuf += s),
      err: (s) => (errBuf += s),
    });
    let json: any = null;
    try {
      json = JSON.parse(outBuf);
    } catch {
      /* error paths have empty stdout */
    }
    return { code, json, stderr: errBuf };
  } finally {
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
  }
}

const oneStepRecord = { kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' };

// ---------------------------------------------------------------------------
// composeRunLink — pure
// ---------------------------------------------------------------------------

test('composeRunLink: dashboard origin (NOT the bare apex) + /<org>/runs/<uuid>', () => {
  expect(composeRunLink('https://api.ai-pipeline.dev', 'acme', '019fc762-5762-7000-a9bf-922ed8fa00be')).toBe(
    'https://api.ai-pipeline.dev/acme/runs/019fc762-5762-7000-a9bf-922ed8fa00be',
  );
  // A trailing slash / path on the server is normalized away first.
  expect(composeRunLink('https://api.ai-pipeline.dev/', 'acme', 'r1')).toBe('https://api.ai-pipeline.dev/acme/runs/r1');
});

// ---------------------------------------------------------------------------
// F7 — no cloud.json at all: no line, nothing spawned, nothing queued.
// ---------------------------------------------------------------------------

test('F7: no .pipeline/cloud.json -> no run.link line, no daemon lock, no outbox', async () => {
  const root = scaffold();
  const r = await driveInProcess(root, 'nolinkrun', { '01-step': oneStepRecord });

  expect(r.code).toBe(0);
  expect(r.stderr).not.toContain('run.link');
  expect(existsSync(telemetryDaemonLockPath(root))).toBe(false);
  expect(existsSync(join(telemetryDir(root), 'outbox.jsonl'))).toBe(false);
});

// ---------------------------------------------------------------------------
// PIPELINE_SYNC_LOCAL_STATS=0 — same "absent" gate, even with a connected
// project. Checked FIRST (before the cloud.json existsSync).
// ---------------------------------------------------------------------------

test('PIPELINE_SYNC_LOCAL_STATS=0: no run.link line, no daemon lock, even with a connected project', async () => {
  const root = scaffold();
  connectProject(root);
  const saved = process.env.PIPELINE_SYNC_LOCAL_STATS;
  process.env.PIPELINE_SYNC_LOCAL_STATS = '0';
  try {
    const r = await driveInProcess(root, 'syncoffrun', { '01-step': oneStepRecord });
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain('run.link');
    expect(existsSync(telemetryDaemonLockPath(root))).toBe(false);
  } finally {
    if (saved === undefined) delete process.env.PIPELINE_SYNC_LOCAL_STATS;
    else process.env.PIPELINE_SYNC_LOCAL_STATS = saved;
  }
});

// ---------------------------------------------------------------------------
// Connected + online: the link is line 2 (right after run.started), before
// any step.* progress line, and matches composeRunLink exactly.
// ---------------------------------------------------------------------------

test('connected + online: run.link is the SECOND progress line, before step 1, with no offline suffix', async () => {
  const root = scaffold();
  connectProject(root, { server: 'https://api.ai-pipeline.dev', org: 'acme' });
  seedLiveDaemonLock(root);

  const r = await driveInProcess(root, '019fc762-5762-7000-a9bf-922ed8fa00be', { '01-step': oneStepRecord });
  expect(r.code).toBe(0);

  const lines = r.stderr.split('\n').filter((l) => l.startsWith('[drive]'));
  expect(lines[0]).toContain('run.started');
  expect(lines[1]).toContain('run.link');
  expect(lines[1]).toContain(
    'url=https://api.ai-pipeline.dev/acme/runs/019fc762-5762-7000-a9bf-922ed8fa00be',
  );
  expect(lines[1]).not.toContain('offline');
  // step.started (the first step-boundary line) comes strictly AFTER the link.
  const stepIdx = lines.findIndex((l) => l.includes('step.started'));
  expect(stepIdx).toBeGreaterThan(1);

  // The daemon lock is untouched (still this test process's pid) — no new
  // daemon was spawned because one was already "running".
  const lock = JSON.parse(readFileSync(telemetryDaemonLockPath(root), 'utf-8'));
  expect(lock.pid).toBe(process.pid);
});

// ---------------------------------------------------------------------------
// Offline suffix: a PERSISTED backoff (upload.json, written the same way
// telemetry-upload.ts's scheduleBackoff does) flips the printed line —
// without this call making any network request of its own.
// ---------------------------------------------------------------------------

test('a persisted upload backoff flips the link to the offline suffix', async () => {
  const root = scaffold();
  connectProject(root);
  seedLiveDaemonLock(root);
  mkdirSync(telemetryDir(root), { recursive: true });
  writeFileSync(
    uploadStatePath(root),
    JSON.stringify({ schema: UPLOAD_STATE_SCHEMA, attempt: 1, next_attempt_at: Date.now() + 60_000 }) + '\n',
  );

  const r = await driveInProcess(root, 'offlinerun', { '01-step': oneStepRecord });
  expect(r.code).toBe(0);

  const linkLine = r.stderr.split('\n').find((l) => l.includes('run.link'));
  expect(linkLine).toContain('offline=true');
});

test('an EXPIRED backoff (next_attempt_at already past) does NOT flip the offline suffix', async () => {
  const root = scaffold();
  connectProject(root);
  seedLiveDaemonLock(root);
  mkdirSync(telemetryDir(root), { recursive: true });
  writeFileSync(
    uploadStatePath(root),
    JSON.stringify({ schema: UPLOAD_STATE_SCHEMA, attempt: 1, next_attempt_at: Date.now() - 60_000 }) + '\n',
  );

  const r = await driveInProcess(root, 'pastbackoffrun', { '01-step': oneStepRecord });
  const linkLine = r.stderr.split('\n').find((l) => l.includes('run.link'));
  expect(linkLine).not.toContain('offline');
});

// ---------------------------------------------------------------------------
// In-process tail: connected run drains the journal into outbox.jsonl
// without any daemon ever flushing it (the daemon here is a seeded lock —
// no real process runs).
// ---------------------------------------------------------------------------

test('connected run drains its own journal into outbox.jsonl in-process (no daemon involved)', async () => {
  const root = scaffold();
  connectProject(root);
  seedLiveDaemonLock(root);

  const r = await driveInProcess(root, 'tailrun', { '01-step': oneStepRecord });
  expect(r.code).toBe(0);

  const outboxPath = join(telemetryDir(root), 'outbox.jsonl');
  expect(existsSync(outboxPath)).toBe(true);
  const lines = readFileSync(outboxPath, 'utf-8').trim().split('\n').filter(Boolean);
  expect(lines.length).toBeGreaterThan(0);
  const records = lines.map((l) => JSON.parse(l));
  expect(records.every((rec) => rec.run_id === 'tailrun' && rec.org === 'acme')).toBe(true);
});
