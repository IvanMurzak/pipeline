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
  interpretRunnerJournal,
  readDepartmentJournal,
  readLocalDepartmentJournal,
  resolveRunnerDataDir,
  resolveRunnerHome,
  resolveRunnerJournalRoot,
  RUNNER_JOURNAL_SCHEMA,
  RUNNER_JOURNAL_TIMEOUT_MS,
  sanitizeForPath,
  type JournalFs,
} from '../src/lib/department-journal';
import { SHELL_TIMEOUT_CODE, type ShellResult, type ShellRunner } from '../src/lib/runner-enrol';

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

// ---------------------------------------------------------------------------
// x44 — asking pipeline-runner instead of guessing
// ---------------------------------------------------------------------------
//
// The mirror above resolves the data dir AS THE INVOKING USER, which is wrong
// for the shape the product steers users onto: `serve` installs a SERVICE, and
// on Windows `sc.exe create` with no `obj=` runs it as `LocalSystem` (x22).
//
// `readDepartmentJournal` therefore shells `pipeline-runner journal --json`
// first. Shelling out is itself a failure surface, so the whole point of this
// suite is the degradation matrix: an absent binary, a runner too old to know
// the verb, a hung child, malformed stdout, a status word this reader does not
// know, and a BREAKING schema bump must each fall back to the mirror WITH A
// STATED REASON — never to a wrong answer, and never to a silent blank.

const RUNNER_INDEX = '/service-home/data/department/by-department/dept/executions.jsonl';

/** A `JournalReadOutput` as pipeline-runner's `journal --json` prints it
 *  (`src/department/journal-read.ts`) — every key always present. */
function runnerDoc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 1,
    department_id: DEPT_ID,
    status: 'ok',
    message: null,
    path: RUNNER_INDEX,
    home_source: 'service',
    executions: [
      {
        run_id: 'dexec-1',
        task_id: 'task-1',
        context_id: 'ctx-1',
        sender: 'service@acme.dev',
        engine: 'claude-code',
        ts: '2026-07-27T14:00:00.000Z',
        journal_path: '/x/events.jsonl',
      },
    ],
    tasks: {
      'task-1': { sender: 'service@acme.dev', engine: 'claude-code', run_id: 'dexec-1', ts: '2026-07-27T14:00:00.000Z' },
    },
    counts: { executions: 1, skipped: 0, limit: 5000, truncated: false },
    supervisor: null,
    ...over,
  };
}

function runnerOk(doc: Record<string, unknown> = runnerDoc(), code = 0): ShellResult {
  return { code, stdout: `${JSON.stringify(doc, null, 2)}\n`, stderr: '' };
}

/** `cli.ts`'s `unknownCommand()`, verbatim: stderr, exit 1, NOTHING on stdout.
 *  THE discriminator — the new `unreadable`/`unlocatable` statuses also exit 1,
 *  but they print their document first. */
const OLD_RUNNER: ShellResult = {
  code: 1,
  stdout: '',
  stderr: "[pipeline-runner] error: unknown command 'journal' — run `pipeline-runner --help` for the command list\n",
};

/** Older still: a build predating `x11`, where EVERY unmatched command fell
 *  into `usage()` — stdout, exit 0. A zero exit is not evidence of an answer. */
const PRE_X11_RUNNER: ShellResult = {
  code: 0,
  stdout: 'usage: pipeline-runner <command>\n\n  register --url <base-url> ...\n',
  stderr: '',
};

function shellReturning(
  result: ShellResult,
  calls: { cmd: string; args: string[]; opts?: unknown }[] = [],
): ShellRunner {
  return (cmd, args, _env, opts) => {
    calls.push({ cmd, args, opts });
    return result;
  };
}

/** The mirror's own answer in these tests, so "which reader won" is decidable:
 *  the on-disk file records a DIFFERENT sender from the runner's. */
const MIRROR_FILES = { [INDEX]: `${entry({ sender: 'mirror@acme.dev' })}\n` };

function readVia(shell: ShellRunner, files: Record<string, string> = MIRROR_FILES, unreadable: Record<string, string> = {}) {
  return readDepartmentJournal(shell, fs(files, unreadable), { env: ENV, platform: 'linux', departmentId: DEPT_ID });
}

describe('x44 — the runner answers, the mirror is the fallback', () => {
  test('the runner is asked first, and its answer wins over the file this process can see', () => {
    const calls: { cmd: string; args: string[]; opts?: unknown }[] = [];
    const r = readVia(shellReturning(runnerOk(), calls));

    expect(r.source).toBe('runner');
    expect(r.status).toBe('ok');
    expect(r.path).toBe(RUNNER_INDEX);
    expect(r.homeSource).toBe('service');
    expect(r.executions).toBe(1);
    // The runner read a home this process cannot; the mirror read one it can.
    // Only one of those is the answer.
    expect(r.byTaskId.get('task-1')).toEqual({ sender: 'service@acme.dev', engine: 'claude-code' });
    expect(r.fallbackReason).toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('pipeline-runner');
    expect(calls[0]!.args).toEqual(['journal', '--department', DEPT_ID, '--json']);
    // A hung child may not hang a `--follow` loop.
    expect(calls[0]!.opts).toEqual({ timeoutMs: RUNNER_JOURNAL_TIMEOUT_MS });
  });

  test('ABSENT from the runner carries the account that OWNS the journal — the whole point of x22', () => {
    const r = readVia(
      shellReturning(
        runnerOk(
          runnerDoc({
            status: 'absent',
            tasks: {},
            executions: [],
            counts: { executions: 0, skipped: 0, limit: 5000, truncated: false },
            home_source: 'default',
            supervisor: {
              backend: 'windows',
              installed: true,
              home: null,
              account: 'LocalSystem',
              systemAccount: true,
              note: null,
            },
          }),
        ),
      ),
      {},
    );
    expect(r.source).toBe('runner');
    expect(r.status).toBe('absent');
    expect(r.supervisor).toEqual({
      backend: 'windows',
      installed: true,
      home: null,
      account: 'LocalSystem',
      systemAccount: true,
      note: null,
    });
  });

  test('a runner that never probed reports `supervisor` as UNDEFINED, not as null', () => {
    // `null` is "probed, nothing observable"; absent from the document is
    // "nothing was probed". Those are different facts and stay different.
    const doc = runnerDoc();
    delete doc['supervisor'];
    const r = readVia(shellReturning(runnerOk(doc)));
    expect(r.supervisor).toBeUndefined();
    expect(r.status).toBe('ok');
  });

  test('`unreadable` is exit 1 WITH a document — used as the answer, not mistaken for an old runner', () => {
    const r = readVia(
      shellReturning(
        runnerOk(
          runnerDoc({
            status: 'unreadable',
            message: 'permission denied — the file exists but this process may not read it',
            tasks: {},
            executions: [],
            counts: { executions: 0, skipped: 0, limit: 5000, truncated: false },
          }),
          1,
        ),
      ),
    );
    expect(r.source).toBe('runner');
    expect(r.status).toBe('unreadable');
    expect(r.message).toContain('permission denied');
    expect(r.fallbackReason).toBeUndefined();
  });

  test('a NEWER runner adding keys this CLI has never heard of still answers', () => {
    const r = readVia(
      shellReturning(
        runnerOk(
          runnerDoc({
            retention_policy: 'forever',
            counts: { executions: 1, skipped: 0, limit: 5000, truncated: false, purged: 3 },
          }),
        ),
      ),
    );
    expect(r.source).toBe('runner');
    expect(r.byTaskId.get('task-1')!.sender).toBe('service@acme.dev');
  });

  test('a blank sender/engine from the runner reads back as null, never as an empty cell', () => {
    const r = readVia(
      shellReturning(runnerOk(runnerDoc({ tasks: { 'task-1': { sender: '', engine: null, run_id: 'x', ts: null } } }))),
    );
    expect(r.byTaskId.get('task-1')).toEqual({ sender: null, engine: null });
  });
});

describe('x44 — every way the shell-out can fail degrades to the mirror, with a reason', () => {
  /** Each case: the runner's answer, and the words the fallback has to carry. */
  const cases: [name: string, result: ShellResult, reasonFragment: string][] = [
    ['a runner too old to know the verb (exit 1, stderr, no JSON)', OLD_RUNNER, 'does not know the `journal` verb'],
    ['a runner predating x11 (usage on stdout, exit 0)', PRE_X11_RUNNER, 'printed no JSON'],
    ['no `pipeline-runner` on PATH at all', { code: 127, stdout: '', stderr: 'spawn ENOENT' }, 'not installed on this machine'],
    ['a child that hung and was killed', { code: SHELL_TIMEOUT_CODE, stdout: '', stderr: 'ETIMEDOUT' }, 'did not answer in time'],
    ['malformed JSON on stdout', { code: 0, stdout: '{"schema": 1, "status": "o', stderr: '' }, 'printed no JSON'],
    ['a JSON ARRAY where an object belongs', { code: 0, stdout: '[1,2,3]', stderr: '' }, 'printed no JSON'],
    ['JSON with no schema version', { code: 0, stdout: '{"status":"ok"}', stderr: '' }, 'no schema version'],
    [
      'a BREAKING schema bump — the one word reserved for "this shape no longer holds"',
      runnerOk(runnerDoc({ schema: RUNNER_JOURNAL_SCHEMA + 1 })),
      `speaks output schema ${RUNNER_JOURNAL_SCHEMA + 1}`,
    ],
    ['a status word this reader does not know', runnerOk(runnerDoc({ status: 'quarantined' })), 'status this CLI does not know'],
    ['an exit code that contradicts the document', runnerOk(runnerDoc({ status: 'ok' }), 1), 'output contract did not hold'],
    ['an answer about a different department', runnerOk(runnerDoc({ department_id: 'someone-else' })), 'different department'],
  ];

  for (const [name, result, fragment] of cases) {
    test(`${name} -> the mirror, and says why`, () => {
      const r = readVia(shellReturning(result));
      expect(r.source).toBe('mirror');
      expect(r.fallbackReason ?? '').toContain(fragment);
      // Degraded to the MIRROR, not to a lie: the file this process CAN read
      // is still read, and its facts are still reported.
      expect(r.status).toBe('ok');
      expect(r.byTaskId.get('task-1')).toEqual({ sender: 'mirror@acme.dev', engine: 'claude-code' });
      expect(r.supervisor).toBeUndefined();
    });
  }

  test('a `ShellRunner` that THROWS is caught — `status` never crashes over a subprocess', () => {
    const r = readVia(() => {
      throw new Error('EPERM: spawn refused');
    });
    expect(r.source).toBe('mirror');
    expect(r.fallbackReason).toContain('could not be started');
    expect(r.fallbackReason).toContain('EPERM');
    expect(r.byTaskId.get('task-1')!.sender).toBe('mirror@acme.dev');
  });

  test("the fallback carries the mirror's OWN degradation, not a fabricated success", () => {
    // Old runner AND an unreadable file: two failures, and the answer is the
    // honest intersection of them.
    const r = readVia(shellReturning(OLD_RUNNER), {}, { [INDEX]: 'EACCES' });
    expect(r.source).toBe('mirror');
    expect(r.status).toBe('unreadable');
    expect(r.message).toBe('permission denied');
    expect(r.fallbackReason).toContain('does not know the `journal` verb');
  });

  test('one stray log line before the document costs a fallback, not the answer', () => {
    const r = readVia(
      shellReturning({ code: 0, stdout: `[pipeline-runner] warn: something\n${JSON.stringify(runnerDoc())}\n`, stderr: '' }),
    );
    expect(r.source).toBe('runner');
    expect(r.byTaskId.get('task-1')!.sender).toBe('service@acme.dev');
  });
});

describe('x44 — interpretRunnerJournal, the pure half', () => {
  test('counts it cannot verify fall back to what it actually understood', () => {
    const doc = runnerDoc();
    delete doc['counts'];
    const out = interpretRunnerJournal(runnerOk(doc), DEPT_ID);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.reading.executions).toBe(1);
    expect(out.reading.skipped).toBe(0);
  });

  test('a `tasks` map that is not a map of objects contributes nothing, and does not throw', () => {
    const out = interpretRunnerJournal(runnerOk(runnerDoc({ tasks: { 'task-1': 'nope', 'task-2': null, '': {} } })), DEPT_ID);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.reading.byTaskId.size).toBe(0);
  });

  test('an OLDER schema is read (the number moves only for a BREAKING change)', () => {
    const out = interpretRunnerJournal(runnerOk(runnerDoc({ schema: 0 })), DEPT_ID);
    expect(out.ok).toBe(true);
  });
});
