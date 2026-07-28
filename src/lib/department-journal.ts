// The LOCAL runner journal, read-only — the consumer half of pipeline-runner's
// b4 (simplified-onboarding task x19).
//
// ── why this module exists ──────────────────────────────────────────────────
// `pipeline department status` builds its task list from the CONTROL PLANE
// (`fetchDeptTasks`), and the control plane does not carry `sender` (who
// addressed the task) or `engine` (what actually ran it). Those two facts are
// recorded by the runner process, on the machine that ran the work, in its own
// execution journal — pipeline-runner's `src/department/events.ts` (journal
// schema 2). b4 shipped that PRODUCER; this module is its CONSUMER, so the two
// columns 05 §6 asked for can finally be rendered.
//
// The join is therefore deliberately LOCAL: cloud task ids on one side, this
// machine's own journal on the other, matched by `task_id`. A task this machine
// never ran simply is not in the journal, and renders as unknown — never as
// somebody else's identity. (The column `status` used to print,
// `originPrincipal`, is the cloud's AUTHENTICATED CALLER, a different identity
// from the sender; showing it where a reader will read "who asked" is the exact
// misattribution this module replaces.)
//
// ── the three rules this module keeps ──────────────────────────────────────
//  1. READ-ONLY, and never through pipeline-runner's own code. This package
//     must not depend on that package (they ship separately, on independent
//     versions), so the small amount of format knowledge below is MIRRORED, not
//     imported, and every mirrored constant names its source file. The mirror is
//     safe in one direction only: b4's format is append-only and additive (its
//     own module doc: "Nothing was renamed, removed, or re-typed"), so an older
//     reader stays correct against a newer writer.
//  2. ABSENT IS NORMAL. No runner has ever run here; the runner runs under a
//     different account; the tasks came from another machine entirely; the file
//     is half-written because the daemon was killed mid-append. Every one of
//     those is an ordinary state of the world, not an error — each narrows what
//     is reported and NOTHING here ever throws.
//  3. PRIVACY: this reads what is already on this machine's disk and shows it
//     to the person sitting at that machine. It never writes, never ships, and
//     never widens what pipeline-runner stores. b4's own privacy decision lives
//     on the SHIPPING path — `pipeline-runner/src/shipper/privacy.ts` maps
//     `sender: 'fingerprint'` (and `department_id`/`engine`: `'keep'`), so what
//     leaves the machine at the metadata tier is `fp:<sha256-16>`, never the
//     identity. Reading the local file locally does not touch that boundary,
//     and this module must never be wired into anything that ships.
//
// ── x44: the mirror is now the FALLBACK, not the first choice ───────────────
// Rule 1 above stated the mirror's one-directional safety and was right about
// the FORMAT. It was silent about the thing that actually broke: the mirror
// resolves the data dir **as the invoking user**, and `pipeline department
// serve` installs a SERVICE — on Windows `sc.exe create` with no `obj=` runs
// it as `LocalSystem`, whose `%LOCALAPPDATA%` is not the invoking user's. The
// mirror then looks in the right place for the wrong account, finds nothing,
// and `status` honestly renders `?` for every task on the happy path (x22).
//
// pipeline-runner shipped the read surface that closes it:
// `pipeline-runner journal --department <id> --json`, over ARGV — the D26 seam
// this package already uses for `bind`/`bindings`/`unbind`/`service status`,
// creating no npm dependency in either direction. It can do two things this
// file structurally cannot: read the INSTALLED service definition to follow a
// pinned `--home`, and NAME the account that owns the journal when it still
// finds nothing. That name is what replaces the unexplained `?`.
//
// `readDepartmentJournal()` below therefore asks the runner first and keeps
// everything here as the fallback. **Degrade to the mirror, never to a lie**:
// an absent binary, a runner too old to know the verb, a hung child, malformed
// stdout, a status word this reader does not know, or a BREAKING schema bump
// each fall back with a stated reason — none of them may produce an answer.

import { join } from 'node:path';
import { RUNNER_CLI_BIN, SHELL_TIMEOUT_CODE, type ShellRunner } from './runner-enrol';

/** The filesystem this module needs — deliberately narrow (two read calls) and
 *  structurally satisfied by `CloudFs` (`./cloud-config.ts`), so `status` can
 *  pass the fs it already injects and tests keep using one fake. */
export interface JournalFs {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: 'utf-8'): string;
}

// ── mirrored path knowledge (see rule 1) ────────────────────────────────────

/** pipeline-runner `src/core/config.ts` — roots an isolated instance's config
 *  AND data dir. The same variable name, and the same blank-is-unset rule. */
export const PIPELINE_RUNNER_HOME_ENV = 'PIPELINE_RUNNER_HOME';
/** pipeline-runner `src/shipper/fs.ts` (`defaultDataDir`) / `src/core/config.ts`
 *  (`CONFIG_DIR_NAME`) — the OS-default directory leaf. */
const RUNNER_DIR_NAME = 'pipeline-runner';
/** pipeline-runner `src/cli.ts`: `journalRoot: join(defaultDataDir(), 'department')`. */
const DEPARTMENT_JOURNAL_DIR = 'department';
/** pipeline-runner `src/department/events.ts`: `DEPARTMENT_INDEX_DIR`. */
const DEPARTMENT_INDEX_DIR = 'by-department';
/** pipeline-runner `src/department/events.ts`: `DEPARTMENT_INDEX_FILE`. */
const DEPARTMENT_INDEX_FILE = 'executions.jsonl';
/** pipeline-runner `src/department/events.ts`: the index line's `type`. */
const INDEX_ENTRY_TYPE = 'department.execution_started';

/**
 * The isolated runner home, or `null` when `PIPELINE_RUNNER_HOME` is unset or
 * blank — mirrors pipeline-runner's `resolveHome` exactly, including the
 * `.trim()` (a home set to whitespace is NOT a home).
 */
export function resolveRunnerHome(env: Record<string, string | undefined>): string | null {
  const home = env[PIPELINE_RUNNER_HOME_ENV];
  return home !== undefined && home.trim().length > 0 ? home : null;
}

/**
 * pipeline-runner's data dir — `resolveHome` first (d7/D17: an isolated home
 * roots the data dir at `<home>/data`), then the OS defaults, branch for branch
 * as `defaultDataDir` has them. Returns `null` instead of throwing where the
 * runner throws: this reader has no standing to fail a status command because
 * `%LOCALAPPDATA%` is unset — it just cannot locate the journal, which rule 2
 * already treats as ordinary.
 */
export function resolveRunnerDataDir(env: Record<string, string | undefined>, platform: string): string | null {
  const home = resolveRunnerHome(env);
  if (home !== null) return join(home, 'data');
  if (platform === 'win32') {
    const local = env['LOCALAPPDATA'] ?? (env['USERPROFILE'] ? join(env['USERPROFILE'], 'AppData', 'Local') : undefined);
    return local !== undefined ? join(local, RUNNER_DIR_NAME) : null;
  }
  if (env['XDG_STATE_HOME']) return join(env['XDG_STATE_HOME'], RUNNER_DIR_NAME);
  if (env['HOME']) return join(env['HOME'], '.local', 'state', RUNNER_DIR_NAME);
  return null;
}

/** `<dataDir>/department` — pipeline-runner `src/cli.ts`'s `journalRoot`. */
export function resolveRunnerJournalRoot(env: Record<string, string | undefined>, platform: string): string | null {
  const dataDir = resolveRunnerDataDir(env, platform);
  return dataDir === null ? null : join(dataDir, DEPARTMENT_JOURNAL_DIR);
}

/** pipeline-runner `src/department/events.ts`'s `sanitizeForPath` — ids are
 *  caller-minted, so the WRITER sanitizes before using one as a path segment.
 *  A reader that skipped this would compute a different path for the same id. */
export function sanitizeForPath(id: string): string {
  return id.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

/** `<journalRoot>/by-department/<departmentId>/executions.jsonl` — the ONE file
 *  a reader has to open for a department (b4's whole point: no directory scan,
 *  no opening every execution's journal to find out whose it was). */
export function departmentIndexPath(journalRoot: string, departmentId: string): string {
  return join(journalRoot, DEPARTMENT_INDEX_DIR, sanitizeForPath(departmentId), DEPARTMENT_INDEX_FILE);
}

// ── reading ─────────────────────────────────────────────────────────────────

/**
 * The most a journal line can teach about ONE task. Both fields are `string |
 * null` because the WRITER records them that way and the distinction is real:
 * `sender: null` means the offer stated no sender (b4's `senderFromMessages`),
 * `engine: null` means the adapter is not in the runner's engine registry so
 * there is no user-facing engine name to state. Neither is "we don't know" —
 * that case is the ABSENCE of a `LocalTaskFacts` for the id, which is why this
 * is looked up through a Map rather than folded into more nullable fields.
 */
export interface LocalTaskFacts {
  sender: string | null;
  engine: string | null;
}

export type LocalJournalStatus =
  /** The index file was found and read (it may still be empty). */
  | 'ok'
  /** No index file for this department — no runner has run this department's
   *  work on this machine. The ordinary state on a laptop that only submits. */
  | 'absent'
  /** The file is there but could not be read at all: permissions, a directory
   *  where a file should be, a mid-write truncation of the whole file. */
  | 'unreadable'
  /** The runner's data directory could not be computed from the environment. */
  | 'unlocatable';

/**
 * x44 — which of the two readers produced a reading.
 *
 * Reported rather than hidden because the two see DIFFERENT things: only
 * `runner` can follow a service-pinned home or name the account that owns the
 * journal, so `mirror` + `absent` is a weaker "nothing here" than `runner` +
 * `absent`, and a reader that conflated them would be back to the
 * unexplained `?`.
 */
export type JournalSource = 'runner' | 'mirror';

/**
 * x44 — what pipeline-runner's INSTALLED service definition says about itself
 * (`pipeline-runner/src/service/inspect.ts`'s `InstalledServiceObservation`,
 * carried on `journal --json` as `supervisor`).
 *
 * Best-effort on the far side and therefore nullable throughout on this one:
 * it is CONTEXT for an absent journal, never the thing being asked for, and
 * nothing may fail because it could not be answered. Present only when the
 * runner probed — i.e. when the ordinary location turned up nothing.
 */
export interface RunnerSupervisorObservation {
  /** `systemd` | `launchd` | `windows`, or null when the platform has none. */
  backend: string | null;
  installed: boolean;
  /** The home its argv pins (`--home <path>`), or null for an unpinned one. */
  home: string | null;
  /** The OS account it runs as, when the backend reports one (Windows only —
   *  systemd/launchd install a per-user unit, so there is no other account). */
  account: string | null;
  /** True when `account` is a well-known MACHINE account (`LocalSystem` &c.):
   *  the case whose whole point is that its profile directory, and therefore
   *  its journal, is not the invoking user's. */
  systemAccount: boolean;
  note: string | null;
}

export interface LocalJournalReading {
  status: LocalJournalStatus;
  /** The file this reading came from (or would have), `null` when unlocatable. */
  path: string | null;
  /** Set for `unreadable` — the OS's own words, for the operator. */
  message?: string;
  /** task id -> what this machine recorded for it. Empty for every non-`ok`
   *  status, so a caller may read it unconditionally. */
  byTaskId: Map<string, LocalTaskFacts>;
  /** Valid index lines parsed. */
  executions: number;
  /** Lines that were not valid index entries and were skipped — a truncated
   *  final line after a hard kill is the common one. Reported, never fatal. */
  skipped: number;
  /** x44 — {@link JournalSource}. `mirror` for everything this file reads on
   *  its own; `runner` when `pipeline-runner journal --json` answered. */
  source: JournalSource;
  /** x44 — `runner` only, and only when the runner probed: the account that
   *  owns the journal this process could not see. `undefined` means nothing
   *  was probed, which is NOT the same as "no service is installed" (that is
   *  a present observation with `installed: false`). */
  supervisor?: RunnerSupervisorObservation | null;
  /** x44 — `runner` only: which candidate home answered (`flag` | `env` |
   *  `service` | `default` | `none`), verbatim from the runner. */
  homeSource?: string;
  /** x44 — `mirror` only: why the runner's own command did not answer, in
   *  plain words. Always set on a fallback, so "we asked and it could not
   *  tell us" is never silently indistinguishable from "we never asked". */
  fallbackReason?: string;
}

/**
 * A partial read is normal, so how much of the file is parsed is capped rather
 * than unbounded: the index is append-only and never pruned, and `status` only
 * ever joins against the control plane's RECENT task list, so the newest lines
 * are the only ones that can match. The tail is what is kept.
 */
const MAX_INDEX_LINES = 5000;

/** One index line, or `null` when it is not one. Mirrors pipeline-runner's
 *  `parseDepartmentIndexLine` field check for field check — deliberately
 *  tolerant, because "an index is a convenience for a reader, never the source
 *  of truth" (that function's own doc). */
function parseIndexLine(line: string): { taskId: string; facts: LocalTaskFacts } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const entry = parsed as Record<string, unknown>;
  if (entry['type'] !== INDEX_ENTRY_TYPE) return null;
  if (typeof entry['run_id'] !== 'string' || entry['run_id'].length === 0) return null;
  if (typeof entry['department_id'] !== 'string' || entry['department_id'].length === 0) return null;
  // A schema-1 line (or a partially-written schema-2 one) carries no
  // sender/engine at all. It is still a VALID entry — it just teaches nothing
  // about those two columns, and `null` is exactly how the writer spells that.
  const taskId = entry['task_id'];
  if (typeof taskId !== 'string' || taskId.length === 0) return null;
  return {
    taskId,
    facts: {
      sender: typeof entry['sender'] === 'string' && entry['sender'].length > 0 ? entry['sender'] : null,
      engine: typeof entry['engine'] === 'string' && entry['engine'].length > 0 ? entry['engine'] : null,
    },
  };
}

function emptyReading(status: LocalJournalStatus, path: string | null, message?: string): LocalJournalReading {
  return {
    status,
    path,
    ...(message !== undefined ? { message } : {}),
    byTaskId: new Map(),
    executions: 0,
    skipped: 0,
    source: 'mirror',
  };
}

/**
 * Read what THIS machine recorded for `departmentId`. Never throws: every
 * failure mode collapses into a status the caller renders as "unknown".
 *
 * One task can have several index entries (a re-offer after a retry is a new
 * EXECUTION of the same task), and the file is append-ordered, so the LAST
 * entry for a task wins — the engine that most recently ran it is the one an
 * operator is asking about.
 */
export function readLocalDepartmentJournal(
  fs: JournalFs,
  opts: { env: Record<string, string | undefined>; platform: string; departmentId: string },
): LocalJournalReading {
  const root = resolveRunnerJournalRoot(opts.env, opts.platform);
  if (root === null) {
    return emptyReading('unlocatable', null, "could not determine pipeline-runner's data directory from the environment");
  }
  const path = departmentIndexPath(root, opts.departmentId);

  let exists: boolean;
  try {
    exists = fs.existsSync(path);
  } catch {
    // An `existsSync` that throws means the path could not even be probed
    // (an unreadable parent directory) — indistinguishable from absent for
    // our purposes, and equally not an error.
    return emptyReading('absent', path);
  }
  if (!exists) return emptyReading('absent', path);

  let raw: string;
  try {
    raw = fs.readFileSync(path, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    // A file that vanished between the probe and the read is ABSENT, not
    // broken — the runner rotates/removes nothing today, but a user's `rm` is
    // allowed to race us.
    if (code === 'ENOENT') return emptyReading('absent', path);
    return emptyReading('unreadable', path, describeReadError(err));
  }

  const all = raw.split('\n');
  const lines = all.length > MAX_INDEX_LINES ? all.slice(all.length - MAX_INDEX_LINES) : all;
  const byTaskId = new Map<string, LocalTaskFacts>();
  let executions = 0;
  let skipped = 0;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const entry = parseIndexLine(line);
    if (entry === null) {
      skipped++;
      continue;
    }
    executions++;
    byTaskId.set(entry.taskId, entry.facts);
  }
  return { status: 'ok', path, byTaskId, executions, skipped, source: 'mirror' };
}

function describeReadError(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === 'EACCES' || code === 'EPERM') return 'permission denied';
  if (code === 'EISDIR') return 'a directory exists where the index file should be';
  if (code !== undefined && code !== null) return String(code);
  return err instanceof Error ? err.message : String(err);
}

// ── x44: asking pipeline-runner instead of guessing ─────────────────────────

/**
 * The `--json` contract's version this reader understands
 * (`pipeline-runner/src/department/journal-read.ts`'s `JOURNAL_READ_SCHEMA`).
 *
 * The runner's own rule: this number moves ONLY for a BREAKING change to the
 * shape, and adding a key is additive and does not move it. So the two
 * directions are handled differently and deliberately:
 *
 *  - a key this reader does not know is IGNORED (a newer runner must not break
 *    an older plugin — the same tolerance b4's schema bump documents);
 *  - a schema NUMBER above this one falls back to the mirror, because the far
 *    side has just said, in the one word reserved for it, that the shape this
 *    parser assumes no longer holds. Reading it anyway is how a wrong answer
 *    gets rendered confidently.
 */
export const RUNNER_JOURNAL_SCHEMA = 1;

/** How long `status` waits for `pipeline-runner journal` before giving up on
 *  it and reading the file itself. Generous for a local file read plus (only
 *  on the absent path, only on Windows) one `sc.exe qc`, and short enough that
 *  a wedged child cannot hang a `--follow` loop. */
export const RUNNER_JOURNAL_TIMEOUT_MS = 10_000;

/** The four status words this reader knows. A fifth one from a future runner
 *  is not guessed at — see `interpretRunnerJournal`. */
const RUNNER_STATUSES: readonly string[] = ['ok', 'absent', 'unreadable', 'unlocatable'];

/** The exit code the runner contracts for a status: 0 for `ok` AND `absent`
 *  (never having served this department here is ordinary), 1 for the two that
 *  are genuine failures to answer. Checked rather than assumed — a mismatch
 *  means the JSON did not come from the command we think we ran. */
function expectedExitCode(status: string): number {
  return status === 'ok' || status === 'absent' ? 0 : 1;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function nonNegInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

/**
 * Pull the JSON object out of a child's stdout, or `null`.
 *
 * Strict first (the whole of stdout IS the document, which is what the runner
 * prints), then ONE lenient retry over the outermost `{…}` span, so a stray
 * line from a logger on the far side costs a fallback rather than the answer.
 * `JSON.parse` still has to accept it and every field is still validated
 * below, so the retry widens what can be read, never what can be believed.
 */
function parseJsonObject(stdout: string): Record<string, unknown> | null {
  const attempt = (text: string): Record<string, unknown> | null => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  };
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return null;
  const direct = attempt(trimmed);
  if (direct !== null) return direct;
  const open = trimmed.indexOf('{');
  const close = trimmed.lastIndexOf('}');
  if (open === -1 || close <= open) return null;
  return attempt(trimmed.slice(open, close + 1));
}

/** The runner's `supervisor` object, field by field — every one of them
 *  optional on the wire and defaulted to the answer that claims least. */
function parseSupervisor(raw: unknown): RunnerSupervisorObservation | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  return {
    backend: str(s['backend']),
    installed: s['installed'] === true,
    home: str(s['home']),
    account: str(s['account']),
    systemAccount: s['systemAccount'] === true,
    note: str(s['note']),
  };
}

/**
 * Turn one `pipeline-runner journal --json` invocation into a reading, or say
 * why it could not be one. Pure over a `ShellResult`-shaped input, so every
 * degradation below is unit-testable without a binary on the machine.
 */
export function interpretRunnerJournal(
  r: { code: number; stdout: string; stderr: string },
  departmentId: string,
): { ok: true; reading: LocalJournalReading } | { ok: false; reason: string } {
  if (r.code === 127) {
    return { ok: false, reason: '`pipeline-runner` is not installed on this machine' };
  }
  if (r.code === SHELL_TIMEOUT_CODE) {
    return { ok: false, reason: '`pipeline-runner journal` did not answer in time and was stopped' };
  }
  const doc = parseJsonObject(r.stdout);
  if (doc === null) {
    // THE version discriminator. The runner prints its JSON for `unreadable`
    // and `unlocatable` too — those exit 1 WITH a document — so exit 1 and no
    // document on stdout is a different animal: `cli.ts`'s `unknownCommand()`
    // (x11) writes to stderr and exits 1. Older still: a build predating x11
    // fell through to `usage()`, which prints to stdout and exits 0, so a
    // zero exit with unparseable stdout is the same conclusion by the other
    // route. Both mean this runner cannot answer, and neither may be read as
    // an empty journal.
    return {
      ok: false,
      reason:
        r.code === 0
          ? 'this `pipeline-runner` build printed no JSON for `journal` — it predates the verb'
          : "this `pipeline-runner` build does not know the `journal` verb (it predates it), or it failed before printing: " +
            ((r.stderr || r.stdout || `exit ${r.code}`).trim().split('\n')[0] ?? `exit ${r.code}`),
    };
  }

  const schema = doc['schema'];
  if (typeof schema !== 'number' || !Number.isFinite(schema)) {
    return { ok: false, reason: '`pipeline-runner journal` printed JSON with no schema version' };
  }
  if (schema > RUNNER_JOURNAL_SCHEMA) {
    return {
      ok: false,
      reason:
        `\`pipeline-runner journal\` speaks output schema ${schema}; this CLI understands ${RUNNER_JOURNAL_SCHEMA}. ` +
        'Upgrade `@baizor/pipeline` to read it',
    };
  }

  const status = doc['status'];
  if (typeof status !== 'string' || !RUNNER_STATUSES.includes(status)) {
    return { ok: false, reason: `\`pipeline-runner journal\` reported a status this CLI does not know (${String(status)})` };
  }
  if (r.code !== expectedExitCode(status)) {
    // The exit code and the document disagree about whether this worked. One
    // of them is not the command we think we ran; neither is trusted.
    return {
      ok: false,
      reason: `\`pipeline-runner journal\` exited ${r.code} while reporting '${status}' — its output contract did not hold`,
    };
  }
  if (str(doc['department_id']) !== departmentId) {
    return { ok: false, reason: '`pipeline-runner journal` answered about a different department' };
  }

  const byTaskId = new Map<string, LocalTaskFacts>();
  const tasks = doc['tasks'];
  if (typeof tasks === 'object' && tasks !== null && !Array.isArray(tasks)) {
    for (const [taskId, value] of Object.entries(tasks as Record<string, unknown>)) {
      if (taskId.length === 0) continue;
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
      const facts = value as Record<string, unknown>;
      // Same rule as the mirror's `parseIndexLine`: a missing or blank field
      // is `null` ("recorded, nothing to state"), never an empty cell that
      // reads as a value.
      byTaskId.set(taskId, { sender: str(facts['sender']), engine: str(facts['engine']) });
    }
  }

  const counts = doc['counts'];
  const countsObj = typeof counts === 'object' && counts !== null && !Array.isArray(counts) ? (counts as Record<string, unknown>) : {};
  const message = str(doc['message']);
  const homeSource = str(doc['home_source']);
  const supervisorRaw = doc['supervisor'];

  return {
    ok: true,
    reading: {
      status: status as LocalJournalStatus,
      path: str(doc['path']),
      ...(message !== null ? { message } : {}),
      byTaskId,
      // A count this reader cannot verify is reported as what it can: the
      // number of task rows it actually understood.
      executions: nonNegInt(countsObj['executions']) ?? byTaskId.size,
      skipped: nonNegInt(countsObj['skipped']) ?? 0,
      source: 'runner',
      // `undefined` (never probed) and `null` (probed, nothing observable)
      // are different answers and stay different — see the field's doc.
      ...(supervisorRaw === undefined ? {} : { supervisor: parseSupervisor(supervisorRaw) }),
      ...(homeSource !== null ? { homeSource } : {}),
    },
  };
}

/**
 * THE reader `status` calls: pipeline-runner's own `journal` command when it
 * can answer, this file's mirror when it cannot.
 *
 * Never throws, and never returns an answer it did not get — a fallback always
 * carries `fallbackReason`, so "we asked and were told nothing" is a stated
 * outcome rather than an indistinguishable blank.
 *
 * The environment is deliberately NOT overridden for the child. It inherits
 * this process's own, which is where `PIPELINE_RUNNER_HOME` already lives, and
 * the runner treats an explicit home as final (it will not second-guess it
 * with the service probe) — exactly the behaviour a user who set one wants.
 */
export function readDepartmentJournal(
  shell: ShellRunner,
  fs: JournalFs,
  opts: { env: Record<string, string | undefined>; platform: string; departmentId: string },
): LocalJournalReading {
  let result: { code: number; stdout: string; stderr: string };
  try {
    result = shell(RUNNER_CLI_BIN, ['journal', '--department', opts.departmentId, '--json'], undefined, {
      timeoutMs: RUNNER_JOURNAL_TIMEOUT_MS,
    });
  } catch (err) {
    // A `ShellRunner` is not supposed to throw, but `status` is the command
    // whose contract is "never crashes, only narrows".
    return {
      ...readLocalDepartmentJournal(fs, opts),
      fallbackReason: `\`pipeline-runner journal\` could not be started: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const interpreted = interpretRunnerJournal(result, opts.departmentId);
  if (interpreted.ok) return interpreted.reading;
  return { ...readLocalDepartmentJournal(fs, opts), fallbackReason: interpreted.reason };
}
