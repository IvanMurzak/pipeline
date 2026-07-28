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

import { join } from 'node:path';

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
  return { status: 'ok', path, byTaskId, executions, skipped };
}

function describeReadError(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === 'EACCES' || code === 'EPERM') return 'permission denied';
  if (code === 'EISDIR') return 'a directory exists where the index file should be';
  if (code !== undefined && code !== null) return String(code);
  return err instanceof Error ? err.message : String(err);
}
