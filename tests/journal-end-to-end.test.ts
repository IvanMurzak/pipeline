// @serial — spawns the real hook scripts as child processes and reads their
// side effects off disk; held out of the parallel pool so an unrelated suite's
// CPU load cannot turn a slow spawn into a flake.
//
// journal-end-to-end.test.ts — the journal outlived the local dashboard.
//
// WHY THIS FILE EXISTS. `<project>/.pipeline/.runtime/events.jsonl` was built
// for the local web dashboard (plugin-thin `01-remove-local-ui.md`), is still
// named after it in every environment variable, and was the single easiest
// thing to take out by accident when that dashboard was deleted in task `p3`.
// It must not be: it is `ux-v2`'s telemetry source. The outbox tails it, the
// uploader ships it, and `pipeline logs` renders it for a user who has declined
// the cloud entirely.
//
// The failure mode this guards against is not a crash. Every writer here is
// best-effort and exits 0 by contract, so a journal that silently stopped being
// written would look exactly like a quiet project — no error, no red test, just
// an empty file and, weeks later, an empty dashboard. So this test drives the
// REAL hook scripts as the REAL subprocesses Claude Code spawns, and then feeds
// the journal they produced through the REAL outbox and uploader. Nothing here
// is mocked except the HTTP boundary.
//
// Two properties, in the two blocks below:
//
//   1. WRITERS — every surviving writer still appends to the journal:
//      the SessionStart hook (`session_relay.ts`, all that is left of the
//      deleted daemon launcher), the analytics hook (`analytics_relay.ts`), and
//      the `pipeline event` CLI. Driven end to end through their process entry
//      points, not by importing a handler.
//
//   2. CHAIN — that same journal, unmodified, drains through `TelemetryOutbox`
//      and flushes through `TelemetryUploader` to the wire. Including `b20`'s
//      distinction: `session.opened` is an EXPECTED EXCLUSION, never a drop.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { TelemetryOutbox, journalPath } from '../src/lib/telemetry-outbox';
import {
  TelemetryUploader,
  type UploadFetch,
  type UploadRequest,
  type UploadTarget,
} from '../src/lib/telemetry-upload';

const PLUGIN_ROOT = resolve(import.meta.dir, '..', '..', '..');
const SESSION_HOOK = join(PLUGIN_ROOT, 'hooks', 'session_relay.ts');
const ANALYTICS_HOOK = join(PLUGIN_ROOT, 'hooks', 'analytics_relay.ts');
const CLI = join(PLUGIN_ROOT, 'apps', 'pipeline-cli', 'src', 'cli.ts');

const created: string[] = [];
afterAll(() => {
  for (const d of created) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

let projectRoot: string;
let homeDir: string;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'journal-e2e-'));
  created.push(base);
  projectRoot = join(base, 'proj');
  homeDir = join(base, 'home');
  // A `.pipeline/` directory is the gate every hook checks — without it they
  // are correctly no-ops, and this test would prove nothing.
  mkdirSync(join(projectRoot, '.pipeline', 'demo', 'steps'), { recursive: true });
  mkdirSync(homeDir, { recursive: true });
});

/** The environment Claude Code hands a hook, with HOME redirected so the
 *  per-user bindings journal lands in the fixture and not the developer's. */
function hookEnv(): Record<string, string> {
  return {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
    CLAUDE_SESSION_ID: 'sess-e2e',
    PIPELINE_JOURNAL_DEBUG: '0',
    // Never let a real telemetry daemon be spawned by the hook under test.
    PIPELINE_SYNC_LOCAL_STATS: '0',
  } as Record<string, string>;
}

/** Run a hook script exactly as `run-hook.sh` does: `bun <script>`, hook JSON
 *  on stdin, cwd inside the project. `envOverrides` layers on top of the base
 *  hook environment — used to drive the gating switches for a single call
 *  without touching the fixtures every other test in this file relies on. */
function runHook(script: string, payload: unknown, envOverrides: Record<string, string> = {}): number {
  const r = spawnSync(process.execPath, [script], {
    cwd: projectRoot,
    env: { ...hookEnv(), ...envOverrides },
    input: JSON.stringify(payload),
    encoding: 'utf-8',
  });
  return r.status ?? -1;
}

function runCli(args: string[]): number {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: projectRoot,
    env: hookEnv(),
    encoding: 'utf-8',
  });
  return r.status ?? -1;
}

function journalLines(): Array<Record<string, unknown>> {
  const p = journalPath(projectRoot);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const types = () => journalLines().map((e) => String(e.type));


/** Produce a journal the way a real supervised run does, in order:
 *  SessionStart hook → `pipeline.started` + the mirror binding the run
 *  registers → a tool call through the analytics hook → `pipeline.completed`. */
function writeRealRun(): void {
  runHook(SESSION_HOOK, { hook_event_name: 'SessionStart', source: 'startup' });
  runCli([
    'event',
    'pipeline.started',
    `--project-root=${projectRoot}`,
    'run_id=run-e2e',
    'pipeline_name=demo',
  ]);
  // What `/pipeline:run` registers right after `pipeline.started`. It is what
  // lets a hook-emitted event resolve its run from the session id — the lookup
  // that outlived the dashboard the bindings journal was named for.
  runCli([
    'event',
    'register-mirror-binding',
    `--project-root=${projectRoot}`,
    'run_id=run-e2e',
    'pipeline_name=demo',
    `iteration_path=${join(projectRoot, '.pipeline', 'demo', 'steps', '01-x.md')}`,
  ]);
  runHook(ANALYTICS_HOOK, {
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    tool_response: { content: 'ok' },
    tool_use_id: 'toolu_e2e_bash',
    session_id: 'sess-e2e',
  });
  runCli([
    'event',
    'pipeline.completed',
    `--project-root=${projectRoot}`,
    'run_id=run-e2e',
    'pipeline_name=demo',
  ]);
}

// ---------------------------------------------------------------------------
// 1. The writers
// ---------------------------------------------------------------------------

describe('the journal is still written by every surviving writer', () => {
  test('SessionStart hook appends session.opened (the daemon launcher is gone, the journal write is not)', () => {
    expect(runHook(SESSION_HOOK, { hook_event_name: 'SessionStart', source: 'startup' })).toBe(0);

    const opened = journalLines().find((e) => e.type === 'session.opened');
    expect(opened).toBeDefined();
    // The b20 contract: this event legitimately carries a null run_id, and the
    // outbox must classify it as an expected exclusion rather than a drop.
    expect(opened?.run_id).toBeNull();
    expect(opened?.project_root).toBe(projectRoot);
    expect(typeof (opened?.data as Record<string, unknown>)?.claude_pid).toBe('number');
  });

  test('the analytics hook still appends tool.called on PostToolUse', () => {
    expect(
      runHook(ANALYTICS_HOOK, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Read',
        tool_input: { file_path: join(projectRoot, 'x.ts') },
        tool_response: { content: 'ok' },
        tool_use_id: 'toolu_e2e_read',
        session_id: 'sess-e2e',
      }),
    ).toBe(0);

    expect(types()).toContain('tool.called');
  });

  test('the `pipeline event` CLI still appends run lifecycle events', () => {
    expect(
      runCli([
        'event',
        'pipeline.started',
        `--project-root=${projectRoot}`,
        'run_id=run-e2e',
        'pipeline_name=demo',
      ]),
    ).toBe(0);

    const started = journalLines().find((e) => e.type === 'pipeline.started');
    expect(started).toBeDefined();
    expect(started?.run_id).toBe('run-e2e');
  });

  test('all three writers share ONE journal, in the order they ran', () => {
    writeRealRun();
    expect(types()).toEqual([
      'session.opened',
      'pipeline.started',
      'tool.called',
      'pipeline.completed',
    ]);
  });

  test('the tool call CORRELATES to the run through the binding the run registered', () => {
    writeRealRun();
    // The bindings journal is named `~/.claude/pipeline-ui/…` after the deleted
    // dashboard, but the lookup it feeds is `analytics_relay.ts`'s own. Without
    // it this event stamps run_id: null and the run's tool counts vanish.
    expect(journalLines().find((e) => e.type === 'tool.called')?.run_id).toBe('run-e2e');
  });
});

// ---------------------------------------------------------------------------
// 1b. The rename (plugin-thin p4) — same gate, new name, no alias
// ---------------------------------------------------------------------------
//
// PIPELINE_UI_ENABLED was the master opt-out for every writer above; it is now
// PIPELINE_JOURNAL_ENABLED, with no back-compat shim (owner decision: a clean
// break, since there were no users yet to break). Two things must both be
// true, through the REAL subprocesses, not a unit test of the parsing helper:
//   1. the new name still gates the SAME writers the old name gated.
//   2. the old name is now inert — setting it does nothing, proving this is a
//      rename and not merely an additional accepted spelling.

describe('the master switch survived the rename with its gate intact', () => {
  test('PIPELINE_JOURNAL_ENABLED=0 silences the SessionStart writer', () => {
    expect(
      runHook(SESSION_HOOK, { hook_event_name: 'SessionStart', source: 'startup' }, { PIPELINE_JOURNAL_ENABLED: '0' }),
    ).toBe(0);
    expect(journalLines().find((e) => e.type === 'session.opened')).toBeUndefined();
  });

  test('PIPELINE_JOURNAL_ENABLED=0 silences the analytics writer (no tool.called, no binding)', () => {
    expect(
      runHook(
        ANALYTICS_HOOK,
        {
          hook_event_name: 'PostToolUse',
          tool_name: 'Read',
          tool_input: { file_path: join(projectRoot, 'x.ts') },
          tool_response: { content: 'ok' },
          tool_use_id: 'toolu_e2e_gate',
          session_id: 'sess-e2e',
        },
        { PIPELINE_JOURNAL_ENABLED: '0' },
      ),
    ).toBe(0);
    expect(types()).not.toContain('tool.called');
  });

  test('the OLD name, PIPELINE_UI_ENABLED=0, is inert — the journal keeps recording (no alias)', () => {
    expect(
      runHook(
        SESSION_HOOK,
        { hook_event_name: 'SessionStart', source: 'startup' },
        // The pre-p4 name. If this still disabled the hook, the rename would
        // really be an additive alias, contradicting the owner's clean-break
        // decision and DEFEATING the point of dropping PIPELINE_UI_ from the
        // repository.
        { PIPELINE_UI_ENABLED: '0' },
      ),
    ).toBe(0);
    expect(journalLines().find((e) => e.type === 'session.opened')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 2. The telemetry chain over that same journal
// ---------------------------------------------------------------------------

const TEST_SALT = 'test-salt-journal-e2e';
const TARGET: UploadTarget = {
  server: 'https://api.example.test',
  org: 'acme',
  token: 'tok-e2e',
};

function captureFetch(): { fetch: UploadFetch; requests: UploadRequest[] } {
  const requests: UploadRequest[] = [];
  return {
    requests,
    fetch: async (req) => {
      requests.push(req);
      return { status: 200 };
    },
  };
}

function mkOutbox(): TelemetryOutbox {
  return new TelemetryOutbox({
    projectRoot,
    org: 'acme',
    env: {},
    fingerprintSalt: TEST_SALT,
    onDrop: () => {},
    onExclude: () => {},
  });
}

describe('the telemetry chain still drains and uploads that journal', () => {
  test('drainJournal queues every run-bearing line and EXCLUDES session.opened without calling it a drop (b20)', () => {
    writeRealRun();
    expect(journalLines().length).toBe(4);

    const drained = mkOutbox().drainJournal();

    expect(drained.lines_read).toBe(4);
    // pipeline.started + tool.called + pipeline.completed all carry run-e2e.
    expect(drained.enqueued).toBe(3);
    // The whole point of b20: session.opened's null run_id is EXPECTED, and is
    // reported through a different counter and a different vocabulary.
    expect(drained.skipped_excluded).toBe(1);
    expect(drained.skipped_no_run_id).toBe(0);
    expect(drained.skipped_malformed).toBe(0);
  });

  test('the drained records flush to the wire', async () => {
    writeRealRun();
    const outbox = mkOutbox();
    outbox.drainJournal();

    const { fetch, requests } = captureFetch();
    const result = await new TelemetryUploader({
      outbox,
      target: TARGET,
      fetch,
      env: {},
      random: () => 0,
      backoffBaseMs: 1,
      backoffCapMs: 2,
    }).flushOnce();

    expect(result.outcome).toBe('sent');
    expect(result.records_sent).toBe(3);
    expect(requests.length).toBeGreaterThan(0);

    // The run this project actually executed is what reached the wire.
    const wire = requests.map((r) => r.body).join('');
    expect(wire).toContain('pipeline.started');
    expect(wire).toContain('pipeline.completed');
    expect(wire).toContain('run-e2e');
  });

  test('the drain is a TAIL, not a consumer: the journal file is byte-identical afterwards', () => {
    writeRealRun();
    const before = readFileSync(journalPath(projectRoot), 'utf-8');
    mkOutbox().drainJournal();
    // `pipeline logs` must still render every line of a journal that has
    // already been uploaded — the offline path does not lose to the cloud one.
    expect(readFileSync(journalPath(projectRoot), 'utf-8')).toBe(before);
  });
});
