// Tests for the LOCAL runner-journal reader (src/lib/department-journal.ts —
// simplified-onboarding task x19).
//
// Two things are being pinned here:
//
//  1. **The path this reader computes is the path pipeline-runner writes.**
//     The two packages ship separately, so the format knowledge is mirrored
//     rather than imported; these assertions are the mirror's contract, and
//     they name the source file they mirror so a future drift is traceable.
//     (`pipeline-runner/src/core/config.ts#resolveHome`,
//      `pipeline-runner/src/shipper/fs.ts#defaultDataDir`,
//      `pipeline-runner/src/cli.ts` (`journalRoot`),
//      `pipeline-runner/src/department/events.ts#departmentIndexPath`.)
//
//  2. **Every way the journal can be missing is an ordinary state.** Absent,
//     unlocatable, unreadable, truncated, foreign, empty — each one narrows
//     what is reported and none of them throws.

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  departmentIndexPath,
  readLocalDepartmentJournal,
  resolveRunnerDataDir,
  resolveRunnerHome,
  resolveRunnerJournalRoot,
  sanitizeForPath,
  type JournalFs,
} from '../src/lib/department-journal';

const DEPT_ID = '22222222-2222-4222-8222-222222222222';

function fs(files: Record<string, string>, unreadable: Record<string, string> = {}): JournalFs {
  return {
    existsSync: (p) => p in files || p in unreadable,
    readFileSync: (p) => {
      if (p in unreadable) throw Object.assign(new Error(unreadable[p]!), { code: unreadable[p] });
      const v = files[p];
      if (v === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      return v;
    },
  };
}

function entry(o: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    schema: 2,
    ts: '2026-07-27T14:00:00.000Z',
    type: 'department.execution_started',
    department_id: DEPT_ID,
    run_id: 'dexec-1',
    task_id: 'task-1',
    context_id: 'ctx-1',
    engine: 'claude-code',
    sender: 'ivan@acme.dev',
    journal_path: '/data/department/dexec-1/events.jsonl',
    ...o,
  });
}

// ---------------------------------------------------------------------------
// Where the journal is
// ---------------------------------------------------------------------------

describe('locating pipeline-runner’s journal', () => {
  test('PIPELINE_RUNNER_HOME roots the data dir at <home>/data (d7/D17)', () => {
    expect(resolveRunnerHome({ PIPELINE_RUNNER_HOME: '/srv/runner-a' })).toBe('/srv/runner-a');
    expect(resolveRunnerDataDir({ PIPELINE_RUNNER_HOME: '/srv/runner-a' }, 'linux')).toBe(join('/srv/runner-a', 'data'));
    expect(resolveRunnerJournalRoot({ PIPELINE_RUNNER_HOME: '/srv/runner-a' }, 'win32')).toBe(
      join('/srv/runner-a', 'data', 'department'),
    );
  });

  test('a blank PIPELINE_RUNNER_HOME is NOT a home — same `.trim()` rule as the runner', () => {
    expect(resolveRunnerHome({ PIPELINE_RUNNER_HOME: '   ' })).toBeNull();
    expect(resolveRunnerHome({})).toBeNull();
    // ...and therefore falls through to the OS default.
    expect(resolveRunnerDataDir({ PIPELINE_RUNNER_HOME: '  ', HOME: '/home/ivan' }, 'linux')).toBe(
      join('/home/ivan', '.local', 'state', 'pipeline-runner'),
    );
  });

  test('the OS defaults match defaultDataDir branch for branch', () => {
    expect(resolveRunnerDataDir({ LOCALAPPDATA: 'C:\\Users\\ivan\\AppData\\Local' }, 'win32')).toBe(
      join('C:\\Users\\ivan\\AppData\\Local', 'pipeline-runner'),
    );
    expect(resolveRunnerDataDir({ USERPROFILE: 'C:\\Users\\ivan' }, 'win32')).toBe(
      join('C:\\Users\\ivan', 'AppData', 'Local', 'pipeline-runner'),
    );
    expect(resolveRunnerDataDir({ XDG_STATE_HOME: '/xdg/state' }, 'linux')).toBe(join('/xdg/state', 'pipeline-runner'));
    expect(resolveRunnerDataDir({ HOME: '/home/ivan' }, 'darwin')).toBe(
      join('/home/ivan', '.local', 'state', 'pipeline-runner'),
    );
  });

  test('an environment that names no home at all returns null instead of throwing', () => {
    // The runner THROWS here; a status command has no standing to fail over it.
    expect(resolveRunnerDataDir({}, 'win32')).toBeNull();
    expect(resolveRunnerDataDir({}, 'linux')).toBeNull();
    expect(resolveRunnerJournalRoot({}, 'linux')).toBeNull();
  });

  test('the index path is <root>/by-department/<id>/executions.jsonl, id-sanitized like the writer', () => {
    expect(departmentIndexPath('/data/department', 'unity-department')).toBe(
      join('/data/department', 'by-department', 'unity-department', 'executions.jsonl'),
    );
    // A caller-minted id can never escape the journal root — the writer
    // sanitizes before using one as a path segment, so a reader that did not
    // would compute a different path for the same id.
    expect(sanitizeForPath('../../etc')).toBe('.._.._etc');
    expect(departmentIndexPath('/data/department', '../../etc')).toBe(
      join('/data/department', 'by-department', '.._.._etc', 'executions.jsonl'),
    );
  });
});

// ---------------------------------------------------------------------------
// Reading it — every failure is an ordinary state
// ---------------------------------------------------------------------------

const ENV = { PIPELINE_RUNNER_HOME: '/runner-home' };
const INDEX = departmentIndexPath(resolveRunnerJournalRoot(ENV, 'linux')!, DEPT_ID);

function read(files: Record<string, string>, unreadable: Record<string, string> = {}, env = ENV) {
  return readLocalDepartmentJournal(fs(files, unreadable), { env, platform: 'linux', departmentId: DEPT_ID });
}

describe('reading the journal — degradation', () => {
  test('a good index yields task -> {sender, engine}', () => {
    const r = read({ [INDEX]: `${entry()}\n${entry({ task_id: 'task-2', sender: 'dana@acme.dev', engine: 'pipeline' })}\n` });
    expect(r.status).toBe('ok');
    expect(r.path).toBe(INDEX);
    expect(r.executions).toBe(2);
    expect(r.skipped).toBe(0);
    expect(r.byTaskId.get('task-1')).toEqual({ sender: 'ivan@acme.dev', engine: 'claude-code' });
    expect(r.byTaskId.get('task-2')).toEqual({ sender: 'dana@acme.dev', engine: 'pipeline' });
    expect(r.byTaskId.has('task-3')).toBe(false);
  });

  test('ABSENT: no index file — no runner ever ran this department here', () => {
    const r = read({});
    expect(r.status).toBe('absent');
    expect(r.path).toBe(INDEX);
    expect(r.byTaskId.size).toBe(0);
    expect(r.executions).toBe(0);
  });

  test('ABSENT: the file vanished between the probe and the read (a racing `rm`)', () => {
    const r = read({}, { [INDEX]: 'ENOENT' });
    expect(r.status).toBe('absent');
  });

  test('ABSENT: even an existsSync that throws (unreadable parent dir) is not an error', () => {
    const throwingFs: JournalFs = {
      existsSync: () => {
        throw new Error('EACCES');
      },
      readFileSync: () => {
        throw new Error('never reached');
      },
    };
    const r = readLocalDepartmentJournal(throwingFs, { env: ENV, platform: 'linux', departmentId: DEPT_ID });
    expect(r.status).toBe('absent');
    expect(r.byTaskId.size).toBe(0);
  });

  test('UNREADABLE: permissions — reported in the OS’s own words, never thrown', () => {
    const r = read({}, { [INDEX]: 'EACCES' });
    expect(r.status).toBe('unreadable');
    expect(r.message).toBe('permission denied');
    expect(r.byTaskId.size).toBe(0);
  });

  test('UNREADABLE: a directory where the index file should be', () => {
    const r = read({}, { [INDEX]: 'EISDIR' });
    expect(r.status).toBe('unreadable');
    expect(r.message).toBe('a directory exists where the index file should be');
  });

  test('UNLOCATABLE: the data directory cannot be computed from the environment', () => {
    const r = read({}, {}, {} as typeof ENV);
    expect(r.status).toBe('unlocatable');
    expect(r.path).toBeNull();
    expect(r.message).toContain('data directory');
  });

  test('PARTIAL: a truncated final line after a hard kill costs only that line', () => {
    const r = read({ [INDEX]: `${entry()}\n${entry({ task_id: 'task-2' }).slice(0, 30)}` });
    expect(r.status).toBe('ok');
    expect(r.executions).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.byTaskId.get('task-1')).toEqual({ sender: 'ivan@acme.dev', engine: 'claude-code' });
    expect(r.byTaskId.has('task-2')).toBe(false);
  });

  test('PARTIAL: foreign / non-entry lines are skipped, never guessed at', () => {
    const r = read({
      [INDEX]:
        'not json at all\n' +
        '[1,2,3]\n' +
        '"a bare string"\n' +
        `${JSON.stringify({ type: 'something.else', run_id: 'x', department_id: DEPT_ID, task_id: 'task-9' })}\n` +
        `${entry({ run_id: '' })}\n` +
        `${entry({ task_id: '' })}\n` +
        `${entry()}\n`,
    });
    expect(r.status).toBe('ok');
    expect(r.executions).toBe(1);
    expect(r.skipped).toBe(6);
    expect(r.byTaskId.has('task-9')).toBe(false);
  });

  test('an empty index file is `ok` with nothing in it, not `absent`', () => {
    const r = read({ [INDEX]: '' });
    expect(r.status).toBe('ok');
    expect(r.executions).toBe(0);
    expect(r.skipped).toBe(0);
  });

  test('a schema-1 line (no sender/engine fields) is a VALID entry recording neither', () => {
    const line = JSON.stringify({
      schema: 1,
      ts: '2026-07-27T14:00:00.000Z',
      type: 'department.execution_started',
      department_id: DEPT_ID,
      run_id: 'dexec-1',
      task_id: 'task-1',
      context_id: 'ctx-1',
      journal_path: '/x/events.jsonl',
    });
    const r = read({ [INDEX]: `${line}\n` });
    expect(r.executions).toBe(1);
    // Present in the map (this machine ran it) with nothing to state — which is
    // NOT the same as absent from the map (this machine never saw the task).
    expect(r.byTaskId.get('task-1')).toEqual({ sender: null, engine: null });
  });

  test('an explicit null sender/engine reads back as null, never as an empty string', () => {
    const r = read({ [INDEX]: `${entry({ sender: null, engine: null })}\n` });
    expect(r.byTaskId.get('task-1')).toEqual({ sender: null, engine: null });
    const blank = read({ [INDEX]: `${entry({ sender: '', engine: '' })}\n` });
    expect(blank.byTaskId.get('task-1')).toEqual({ sender: null, engine: null });
  });

  test('a re-executed task takes its LAST entry — the append order is the answer', () => {
    const r = read({
      [INDEX]: `${entry({ run_id: 'a', engine: 'pipeline' })}\n${entry({ run_id: 'b', engine: 'claude-code' })}\n`,
    });
    expect(r.executions).toBe(2);
    expect(r.byTaskId.get('task-1')!.engine).toBe('claude-code');
  });

  test('an index that has grown without bound is read from the TAIL, and still never throws', () => {
    const filler = Array.from({ length: 6000 }, (_, i) => entry({ run_id: `r${i}`, task_id: `old-${i}` })).join('\n');
    const r = read({ [INDEX]: `${filler}\n${entry({ task_id: 'newest' })}\n` });
    expect(r.status).toBe('ok');
    // The newest line always survives the cap; the oldest are the ones dropped.
    expect(r.byTaskId.has('newest')).toBe(true);
    expect(r.byTaskId.has('old-0')).toBe(false);
    expect(r.executions).toBeLessThanOrEqual(5000);
  });
});
