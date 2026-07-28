// department-notify.ts — pure/injectable core of the background department-task notifier
// (department-mesh design, task a1 — the Q2 owner override:
// 12-user-workflows.md Persona B, "a parked task announces itself instead of
// waiting to be polled").
//
// RENAME NOTE (a11, simplified-onboarding — 08-terminology.md / D10 / D31):
// this file was `lib/mesh-notify.ts`. "mesh" is gone from every user-facing
// surface and from this module's own identifiers; citations below that name
// files in the PRIVATE cloud/ repo (`mesh-oauth/…`, `mesh/routes.ts`, …) or in
// the LOCKED `department-mesh` design folder are left as-is — those paths and
// that folder name have not been renamed (D17: the design ledger keeps its
// original wording), so rewriting the citation would point at something that
// doesn't exist.
//
// WHAT THIS WATCHES: department tasks the caller created (A2A
// `originPrincipal === "user:<id>"`) that enter `INPUT_REQUIRED` /
// `AUTH_REQUIRED` (needs a human) or a terminal state
// (`COMPLETED`/`FAILED`/`CANCELED`/`REJECTED`) — even after the Claude Code
// session that sent the task has ended, since a plain MCP client has no push
// channel once the session is gone.
//
// TRANSPORT — a deliberate, documented deviation from a literal reading of
// the task spec, recorded here rather than left implicit:
//
//   04-mcp-gateway.md §3.6/§3.7 and 13-mcp-authorization.md name the
//   department surface this watches as the `tasks.list` / `tasks.wait` MCP
//   TOOLS on the OAuth-gated `/mcp` endpoint. That is the eventual,
//   spec-literal transport, and it is what a live Claude Code session uses
//   (the `mcpServers` entry in `.claude-plugin/plugin.json` — Claude Code
//   owns that whole OAuth dance internally; nothing here duplicates it).
//
//   This module, however, is a HEADLESS background process with no
//   interactive session to complete a browser consent flow in. At a1's
//   implementation time the OAuth 2.1 authorization server (task c12,
//   13-mcp-authorization.md §2-§12) has not landed — a1 only `depends_on:
//   [c6]`, deliberately, so the two build in parallel — so there is today no
//   live path for ANY headless process to hold a valid MCP-audience token.
//   Even once c12 ships, minting one for an unattended daemon needs its own
//   grant story (an MCP-scoped device/refresh flow for a headless CLI),
//   which is out of this task's scope.
//
//   The functionally-equivalent REST surface already exists —
//   `GET /api/v1/dept-tasks` (`cloud/apps/api/src/modules/mesh/routes.ts`) —
//   authenticated by the EXACT credential store this task names
//   (`./cloud-config.ts`'s PAT, populated by the existing `pipeline cloud
//   connect` device flow). Persona B's step budget in 12-user-workflows.md
//   shows ZERO additional user-facing steps for the notifier's own setup,
//   which only holds if it reuses an already-established credential instead
//   of running a second OAuth dance the user never asked for.
//
//   The polling/diff/journal logic below is written behind the small
//   `DepartmentNotifyDeps` seam so swapping the transport to real MCP
//   `tasks.list`/`tasks.wait` JSON-RPC calls (once c12 lands and a headless
//   MCP-audience credential path exists) is a localized change to
//   `fetchMe`/`fetchOpenTasks` below, not a redesign. Full cross-session live
//   proof is deferred to the `e3` gate, per this task's DoD.
//
// Every side effect (HTTP, filesystem, clock) is injected, mirroring
// commands/cloud.ts's CloudDeps pattern, so the whole poll/diff/journal loop
// is unit-testable with zero real I/O.

import { dirname, join } from 'node:path';
import {
  credentialDir,
  credentialFilePath,
  readCredentialStore,
  type CloudFs,
  type CredentialStore,
  type HomeContext,
  type StoredCredential,
} from './cloud-config';
import { ensureFreshCredential, type RefreshDeps } from './credential-refresh';

// ---------------------------------------------------------------------------
// HTTP seam (deliberately local — lib/ must not depend on commands/; see
// commands/cloud.ts for the near-identical shape used by `pipeline cloud`).
// ---------------------------------------------------------------------------

export interface HttpResponse {
  status: number;
  json(): Promise<unknown>;
}

export interface HttpInit {
  method: string;
  headers: Record<string, string>;
}

export type FetchLike = (url: string, init: HttpInit) => Promise<HttpResponse>;

export const realDepartmentNotifyFetch: FetchLike = async (url, init) => {
  return (await fetch(url, init as RequestInit)) as unknown as HttpResponse;
};

// ---------------------------------------------------------------------------
// Task state vocabulary (mirrors cloud/apps/api/src/modules/mesh/types.ts —
// DEPT_TASK_STATES / DEPT_TERMINAL_STATES — duplicated as a plain string
// union here since this package never imports the private cloud/ tree).
// ---------------------------------------------------------------------------

export type DeptTaskState =
  | 'SUBMITTED'
  | 'WORKING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELED'
  | 'INPUT_REQUIRED'
  | 'REJECTED'
  | 'AUTH_REQUIRED';

/**
 * True when `originPrincipal` names `userId` as the ORIGINATING human —
 * across EVERY principal spelling the department orchestrator produces for a
 * user-delegated task, not just one.
 *
 * FIX (e3 P2 gate, cross-repo convergence bug found against the REAL c6
 * `tasks.send` tool, not the REST reference path this module was written
 * against): the same human is stamped under a DIFFERENT namespace depending
 * on the entry point that created the task —
 *   - `user:<id>`      — the REST `POST /api/v1/dept-tasks`
 *                        (`cloud/apps/api/src/modules/mesh/routes.ts`'s `principalFor`);
 *   - `mcp-user:<id>`  — the `/mcp` `tasks.send` tool, the ACTUAL Persona B
 *                        entry point Q2 exists to serve
 *                        (`mesh-mcp/tools/types.ts`'s `principalForUser`);
 *   - `a2a-user:<id>`  — the A2A façade's `message:send`
 *                        (`mesh-a2a/tokens.ts`'s `principalForA2a`, task c7).
 * Each is deliberately namespaced "so it is unambiguously distinguishable in
 * audit trails" — but they all name the SAME originating user. This module's
 * poll filter originally compared against `user:<id>` ONLY, so a task created
 * by the live Claude-Code-via-MCP flow was silently invisible to its own
 * notifier — Q2's parked-task-across-sessions guarantee (12-user-workflows.md
 * Persona B) never fired for the one path that matters. Recognize ALL THREE
 * user-delegated spellings so a task is "mine" regardless of which surface
 * created it, while an execution/runner/department principal (or another
 * user's id under any namespace) never matches.
 */
const USER_PRINCIPAL_PREFIXES = ["user:", "mcp-user:", "a2a-user:"] as const;

function isOwnTask(originPrincipal: string, userId: string): boolean {
  if (userId.length === 0) return false;
  return USER_PRINCIPAL_PREFIXES.some((prefix) => originPrincipal === `${prefix}${userId}`);
}

/** States worth waking the user up for: needs a human, or done (either way). */
export const NOTIFY_STATES: ReadonlySet<DeptTaskState> = new Set([
  'INPUT_REQUIRED',
  'AUTH_REQUIRED',
  'COMPLETED',
  'FAILED',
  'CANCELED',
  'REJECTED',
]);

/** True for the terminal subset of NOTIFY_STATES (mirrors DEPT_TERMINAL_STATES). */
export function isNotifyTerminal(state: DeptTaskState): boolean {
  return state === 'COMPLETED' || state === 'FAILED' || state === 'CANCELED' || state === 'REJECTED';
}

// ---------------------------------------------------------------------------
// Data shapes
// ---------------------------------------------------------------------------

/** The subset of DeptTaskView (cloud's REST response shape) this module reads. */
export interface DepartmentTaskSummary {
  id: string;
  contextId: string;
  departmentId: string;
  originPrincipal: string;
  state: DeptTaskState;
  stateVersion: number;
  updatedAt: string;
}

/** One surfaced transition — either newly entering a notify-worthy state. */
export interface TaskNotification {
  server: string;
  orgSlug: string | null;
  taskId: string;
  contextId: string;
  departmentId: string;
  previousState: DeptTaskState | null;
  state: DeptTaskState;
  updatedAt: string;
  /** Epoch ms when this module computed the transition (not the server's updatedAt). */
  detectedAt: number;
}

/** Human-readable one-liners shared by the CLI's human-mode output, the
 *  OS-toast title/body (lib/os-notify.ts), and the SessionStart hook's
 *  additionalContext — so every surface describes a transition identically. */
export function notificationTitle(n: TaskNotification): string {
  const label = n.state === 'INPUT_REQUIRED' || n.state === 'AUTH_REQUIRED' ? 'needs your input' : 'finished';
  return `Department task ${label}`;
}

export function notificationBody(n: TaskNotification): string {
  const org = n.orgSlug ? `, org ${n.orgSlug}` : '';
  return `Task ${n.taskId} (department ${n.departmentId}${org}) is now ${n.state}.`;
}

interface JournalSeenEntry {
  state: DeptTaskState;
  stateVersion: number;
}

export interface NotifyJournal {
  version: 1;
  /** Keyed by `${server}::${taskId}` — the last notify-worthy state seen per task. */
  seen: Record<string, JournalSeenEntry>;
  /** Notifications computed but not yet drained by a SessionStart hook. */
  pending: TaskNotification[];
}

/** Hard cap on the pending queue so a user who never opens Claude Code again
 *  doesn't grow this file unboundedly — oldest entries drop first. */
export const MAX_PENDING_NOTIFICATIONS = 200;

// ---------------------------------------------------------------------------
// File locations — same per-user directory cloud-config.ts already uses for
// the credential store, so both live beside each other and share the same
// "outside any project" placement rationale.
// ---------------------------------------------------------------------------

export function notifyJournalPath(ctx: HomeContext): string {
  return join(credentialDir(ctx), 'department-notify-state.json');
}

export function notifyLockPath(ctx: HomeContext): string {
  return join(credentialDir(ctx), 'department-notify-daemon.lock');
}

function emptyJournal(): NotifyJournal {
  return { version: 1, seen: {}, pending: [] };
}

export function readNotifyJournal(fs: CloudFs, filePath: string): NotifyJournal {
  if (!fs.existsSync(filePath)) return emptyJournal();
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<NotifyJournal> | null;
    if (!parsed || typeof parsed !== 'object') return emptyJournal();
    return {
      version: 1,
      seen: parsed.seen && typeof parsed.seen === 'object' ? parsed.seen : {},
      pending: Array.isArray(parsed.pending) ? parsed.pending : [],
    };
  } catch {
    // Corrupt journal is not fatal — the notifier just re-derives "seen" from
    // scratch (worst case: one duplicate notification per open task).
    return emptyJournal();
  }
}

export function writeNotifyJournal(fs: CloudFs, filePath: string, journal: NotifyJournal): void {
  const dir = dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, JSON.stringify(journal, null, 2) + '\n');
}

/** Read the pending queue and clear it in one step — the SessionStart hook's
 *  "show it once" contract. Returns the drained notifications (oldest first). */
export function drainPendingNotifications(deps: {
  fs: CloudFs;
  platform: string;
  env: Record<string, string | undefined>;
  homedir: string;
}): TaskNotification[] {
  const ctx: HomeContext = { platform: deps.platform, env: deps.env, homedir: deps.homedir };
  const path = notifyJournalPath(ctx);
  const journal = readNotifyJournal(deps.fs, path);
  if (journal.pending.length === 0) return [];
  const drained = journal.pending;
  writeNotifyJournal(deps.fs, path, { ...journal, pending: [] });
  return drained;
}

// ---------------------------------------------------------------------------
// REST calls (see the transport note at the top of this file)
// ---------------------------------------------------------------------------

interface MeOrg {
  id: string;
  slug: string;
  name: string;
  role: string;
}

interface MeResponse {
  user?: { id: string; email?: string };
  orgs: MeOrg[];
}

async function fetchMe(deps: DepartmentNotifyDeps, server: string, token: string): Promise<MeResponse | null> {
  try {
    const res = await deps.fetch(`${server}/api/v1/me`, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
    });
    if (res.status !== 200) return null;
    const body = (await res.json()) as MeResponse;
    if (!body || !Array.isArray(body.orgs)) return null;
    return body;
  } catch {
    return null;
  }
}

async function fetchOpenTasks(
  deps: DepartmentNotifyDeps,
  server: string,
  token: string,
  orgId: string,
): Promise<DepartmentTaskSummary[]> {
  try {
    const res = await deps.fetch(`${server}/api/v1/dept-tasks`, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${token}`, 'x-org-id': orgId },
    });
    if (res.status !== 200) return [];
    const body = (await res.json()) as { tasks?: unknown };
    if (!Array.isArray(body.tasks)) return [];
    return body.tasks as DepartmentTaskSummary[];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Poll core
// ---------------------------------------------------------------------------

export interface DepartmentNotifyDeps {
  fetch: FetchLike;
  fs: CloudFs;
  now: () => number;
  env: Record<string, string | undefined>;
  platform: string;
  homedir: string;
}

export interface PollResult {
  notifications: TaskNotification[];
  serversPolled: number;
  errors: string[];
}

/** Adapt `DepartmentNotifyDeps` into `credential-refresh.ts`'s `RefreshDeps` —
 *  the two side-effect seams are structurally identical (fetch/fs/now/env/
 *  platform/homedir); this daemon is exactly the "always-on supervisor"
 *  04-cloud-auth.md §6 names, so it must never hand-roll its own refresh
 *  call — a poll cycle racing an interactive `pipeline cloud connect` is the
 *  precise concurrent-refresh scenario that revokes the token family. */
function refreshDepsFrom(deps: DepartmentNotifyDeps): RefreshDeps {
  return { fetch: deps.fetch, fs: deps.fs, now: deps.now, platform: deps.platform, env: deps.env, homedir: deps.homedir };
}

/** One full poll cycle: every stored server credential, every org the user
 *  belongs to on it, diffed against the journal's "seen" cursor. New or
 *  changed notify-worthy states are appended to the pending queue (durable —
 *  survives until a SessionStart hook drains them) and returned. Never
 *  throws — a single bad server/org is skipped and recorded in `errors`. */
export async function pollOnce(deps: DepartmentNotifyDeps): Promise<PollResult> {
  const ctx: HomeContext = { platform: deps.platform, env: deps.env, homedir: deps.homedir };
  const store: CredentialStore = readCredentialStore(deps.fs, credentialFilePath(ctx));
  const journal = readNotifyJournal(deps.fs, notifyJournalPath(ctx));
  const now = deps.now();
  const found: TaskNotification[] = [];
  const errors: string[] = [];
  let serversPolled = 0;

  for (const server of Object.keys(store.servers)) {
    let cred: StoredCredential;
    try {
      // a5: ensureFreshCredential is the ONLY code allowed to call the
      // refresh grant (single-flight + the cross-process advisory lock —
      // see lib/credential-refresh.ts). A throw here (expired with no
      // refresh_token, or invalid_grant/reuse-detected — 04-cloud-auth.md
      // §9's "Your session was refreshed elsewhere") is recorded below and
      // this server is skipped for this cycle — never a crash, and never a
      // refresh attempted outside the lock this daemon shares with the CLI.
      cred = await ensureFreshCredential(refreshDepsFrom(deps), server);
    } catch (e) {
      errors.push(`${server}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const me = await fetchMe(deps, server, cred.access_token);
    if (!me) {
      errors.push(`${server}: could not resolve identity (credential may be invalid)`);
      continue;
    }
    serversPolled++;
    const myUserId = me.user?.id ?? '';
    for (const org of me.orgs) {
      const tasks = await fetchOpenTasks(deps, server, cred.access_token, org.id);
      for (const task of tasks) {
        if (!isOwnTask(task.originPrincipal, myUserId)) continue;
        if (!NOTIFY_STATES.has(task.state)) continue;
        const key = `${server}::${task.id}`;
        const prior = journal.seen[key];
        if (prior && prior.state === task.state && prior.stateVersion === task.stateVersion) continue;
        const notification: TaskNotification = {
          server,
          orgSlug: org.slug ?? null,
          taskId: task.id,
          contextId: task.contextId,
          departmentId: task.departmentId,
          previousState: prior?.state ?? null,
          state: task.state,
          updatedAt: task.updatedAt,
          detectedAt: now,
        };
        found.push(notification);
        journal.seen[key] = { state: task.state, stateVersion: task.stateVersion };
      }
    }
  }

  if (found.length > 0) {
    journal.pending = [...journal.pending, ...found].slice(-MAX_PENDING_NOTIFICATIONS);
  }
  writeNotifyJournal(deps.fs, notifyJournalPath(ctx), journal);

  return { notifications: found, serversPolled, errors };
}

// ---------------------------------------------------------------------------
// Poll loop (the daemon's main body — `pipeline department notify`)
// ---------------------------------------------------------------------------

export interface PollLoopOptions {
  intervalMs: number;
  sleep: (ms: number) => Promise<void>;
  /** Fired once per NEW notification, in the same cycle it was detected —
   *  the daemon's hook for an OS-level toast. Errors are swallowed (best
   *  effort; a failed toast must never kill the poll loop). */
  onNotification?: (n: TaskNotification) => void | Promise<void>;
  onError?: (message: string) => void;
  /** Test-only: stop after N iterations instead of looping forever. */
  maxIterations?: number;
}

export async function pollLoop(deps: DepartmentNotifyDeps, opts: PollLoopOptions): Promise<void> {
  let iteration = 0;
  for (;;) {
    iteration++;
    try {
      const result = await pollOnce(deps);
      for (const n of result.notifications) {
        try {
          await opts.onNotification?.(n);
        } catch (e) {
          opts.onError?.(`onNotification handler failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      for (const e of result.errors) opts.onError?.(e);
    } catch (e) {
      opts.onError?.(`poll cycle failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (opts.maxIterations !== undefined && iteration >= opts.maxIterations) return;
    await opts.sleep(opts.intervalMs);
  }
}
