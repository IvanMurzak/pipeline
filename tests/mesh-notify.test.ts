// mesh-notify.test.ts — the background mesh-task notifier's poll/diff/journal
// core (department-mesh task a1, Q2). Everything is injected: a scripted
// fetch, the real fs over a tmp home (credentialDir/credentialFilePath
// resolve relative to it via PIPELINE_CLOUD_HOME), and a fake clock — no
// test touches the network or the real home dir.

import { test, expect, afterEach, describe } from 'bun:test';
import {
  pollOnce,
  pollLoop,
  drainPendingNotifications,
  readNotifyJournal,
  writeNotifyJournal,
  notifyJournalPath,
  notifyLockPath,
  notificationTitle,
  notificationBody,
  isNotifyTerminal,
  MAX_PENDING_NOTIFICATIONS,
  type FetchLike,
  type HttpResponse,
  type HttpInit,
  type MeshNotifyDeps,
  type NotifyJournal,
  type TaskNotification,
} from '../src/lib/mesh-notify';
import { realFs, credentialFilePath, writeCredentialStore, type HomeContext } from '../src/lib/cloud-config';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

function mkHome(): string {
  const d = mkdtempSync(join(tmpdir(), 'pipeline-mesh-home-'));
  created.push(d);
  return d;
}

function reply(status: number, body: unknown): HttpResponse {
  return { status, json: async () => body };
}

interface Call {
  url: string;
  headers: Record<string, string>;
}

const TOKEN = 'pat_server1_secret';

/** A scripted fetch: /api/v1/me returns `me`; /api/v1/dept-tasks returns
 *  `tasksByOrg[x-org-id]` (default: empty list for an unlisted org id). */
function scriptedFetch(opts: {
  me: { status: number; body?: unknown };
  tasksByOrg: Record<string, unknown[]>;
  calls?: Call[];
}): FetchLike {
  return async (url: string, init: HttpInit): Promise<HttpResponse> => {
    opts.calls?.push({ url, headers: init.headers });
    if (url.endsWith('/api/v1/me')) {
      return reply(opts.me.status, opts.me.body ?? { user: { id: 'u1' }, orgs: [] });
    }
    if (url.endsWith('/api/v1/dept-tasks')) {
      const orgId = init.headers['x-org-id'];
      return reply(200, { tasks: opts.tasksByOrg[orgId ?? ''] ?? [] });
    }
    throw new Error(`unexpected fetch to ${url}`);
  };
}

function task(overrides: Partial<{
  id: string;
  contextId: string;
  departmentId: string;
  originPrincipal: string;
  state: string;
  stateVersion: number;
  updatedAt: string;
}> = {}) {
  return {
    id: 'task-1',
    contextId: 'ctx-1',
    departmentId: 'dep-1',
    originPrincipal: 'user:u1',
    state: 'INPUT_REQUIRED',
    stateVersion: 1,
    updatedAt: '2026-07-24T00:00:00.000Z',
    ...overrides,
  };
}

function makeDeps(fetchImpl: FetchLike, home: string, overrides: Partial<MeshNotifyDeps> = {}): MeshNotifyDeps {
  return {
    fetch: fetchImpl,
    fs: realFs,
    now: () => Date.parse('2026-07-24T00:00:00.000Z'),
    env: { PIPELINE_CLOUD_HOME: home },
    platform: 'linux',
    homedir: home,
    ...overrides,
  };
}

function seedCredential(home: string, server: string, token: string, expiresAt?: number): void {
  const ctx: HomeContext = { platform: 'linux', env: { PIPELINE_CLOUD_HOME: home }, homedir: home };
  const path = credentialFilePath(ctx);
  writeCredentialStore(realFs, path, {
    version: 1,
    servers: {
      [server]: {
        access_token: token,
        token_type: 'bearer',
        ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
      },
    },
  });
}

const SERVER = 'https://api.example.com';

// ---------------------------------------------------------------------------
// pollOnce — detection + journal semantics
// ---------------------------------------------------------------------------

describe('pollOnce', () => {
  test('no stored credential → nothing polled, no notifications', async () => {
    const home = mkHome();
    const fetchImpl = scriptedFetch({ me: { status: 200 }, tasksByOrg: {} });
    const result = await pollOnce(makeDeps(fetchImpl, home));
    expect(result.serversPolled).toBe(0);
    expect(result.notifications).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  test('a task newly in INPUT_REQUIRED produces one notification and is journaled', async () => {
    const home = mkHome();
    seedCredential(home, SERVER, TOKEN);
    const calls: Call[] = [];
    const fetchImpl = scriptedFetch({
      me: { status: 200, body: { user: { id: 'u1' }, orgs: [{ id: 'org-1', slug: 'acme', name: 'Acme', role: 'member' }] } },
      tasksByOrg: { 'org-1': [task()] },
      calls,
    });
    const result = await pollOnce(makeDeps(fetchImpl, home));
    expect(result.serversPolled).toBe(1);
    expect(result.notifications).toHaveLength(1);
    const n = result.notifications[0]!;
    expect(n.server).toBe(SERVER);
    expect(n.orgSlug).toBe('acme');
    expect(n.taskId).toBe('task-1');
    expect(n.previousState).toBeNull();
    expect(n.state).toBe('INPUT_REQUIRED');

    // The dept-tasks call carried the org id as X-Org-Id and the PAT as Bearer.
    const tasksCall = calls.find((c) => c.url.endsWith('/dept-tasks'))!;
    expect(tasksCall.headers['x-org-id']).toBe('org-1');
    expect(tasksCall.headers.authorization).toBe(`Bearer ${TOKEN}`);

    // Journaled: seen cursor set, and it landed in the durable pending queue.
    const ctx: HomeContext = { platform: 'linux', env: { PIPELINE_CLOUD_HOME: home }, homedir: home };
    const journal = readNotifyJournal(realFs, notifyJournalPath(ctx));
    expect(journal.seen[`${SERVER}::task-1`]).toEqual({ state: 'INPUT_REQUIRED', stateVersion: 1 });
    expect(journal.pending).toHaveLength(1);
  });

  test('an unchanged state+version on a second poll produces NO duplicate notification', async () => {
    const home = mkHome();
    seedCredential(home, SERVER, TOKEN);
    const fetchImpl = scriptedFetch({
      me: { status: 200, body: { user: { id: 'u1' }, orgs: [{ id: 'org-1', slug: 'acme', name: 'Acme', role: 'member' }] } },
      tasksByOrg: { 'org-1': [task()] },
    });
    const deps = makeDeps(fetchImpl, home);
    const first = await pollOnce(deps);
    expect(first.notifications).toHaveLength(1);
    const second = await pollOnce(deps);
    expect(second.notifications).toHaveLength(0);
  });

  test('a transition from INPUT_REQUIRED to COMPLETED (version bump) produces a SECOND notification', async () => {
    const home = mkHome();
    seedCredential(home, SERVER, TOKEN);
    const orgs = [{ id: 'org-1', slug: 'acme', name: 'Acme', role: 'member' }];
    const deps1 = makeDeps(
      scriptedFetch({ me: { status: 200, body: { user: { id: 'u1' }, orgs } }, tasksByOrg: { 'org-1': [task()] } }),
      home,
    );
    await pollOnce(deps1);

    const deps2 = makeDeps(
      scriptedFetch({
        me: { status: 200, body: { user: { id: 'u1' }, orgs } },
        tasksByOrg: { 'org-1': [task({ state: 'COMPLETED', stateVersion: 2, updatedAt: '2026-07-24T00:05:00.000Z' })] },
      }),
      home,
    );
    const second = await pollOnce(deps2);
    expect(second.notifications).toHaveLength(1);
    expect(second.notifications[0]!.previousState).toBe('INPUT_REQUIRED');
    expect(second.notifications[0]!.state).toBe('COMPLETED');
  });

  test('a task in a non-notify state (WORKING) is never journaled or notified', async () => {
    const home = mkHome();
    seedCredential(home, SERVER, TOKEN);
    const orgs = [{ id: 'org-1', slug: 'acme', name: 'Acme', role: 'member' }];
    const fetchImpl = scriptedFetch({
      me: { status: 200, body: { user: { id: 'u1' }, orgs } },
      tasksByOrg: { 'org-1': [task({ state: 'WORKING', stateVersion: 3 })] },
    });
    const result = await pollOnce(makeDeps(fetchImpl, home));
    expect(result.notifications).toEqual([]);
    const ctx: HomeContext = { platform: 'linux', env: { PIPELINE_CLOUD_HOME: home }, homedir: home };
    const journal = readNotifyJournal(realFs, notifyJournalPath(ctx));
    expect(journal.seen[`${SERVER}::task-1`]).toBeUndefined();
  });

  test('a task from a DIFFERENT principal is filtered out (not the caller\'s own task)', async () => {
    const home = mkHome();
    seedCredential(home, SERVER, TOKEN);
    const orgs = [{ id: 'org-1', slug: 'acme', name: 'Acme', role: 'member' }];
    const fetchImpl = scriptedFetch({
      me: { status: 200, body: { user: { id: 'u1' }, orgs } },
      tasksByOrg: { 'org-1': [task({ originPrincipal: 'user:someone-else' })] },
    });
    const result = await pollOnce(makeDeps(fetchImpl, home));
    expect(result.notifications).toEqual([]);
  });

  test('a task originated via the REAL /mcp tasks.send tool (originPrincipal "mcp-user:<id>") is STILL detected as the caller\'s own — regression for the e3 gate convergence bug', async () => {
    // cloud/apps/api/src/modules/mesh-mcp/tools/types.ts#principalForUser
    // stamps MCP-created tasks `mcp-user:<id>`, not `user:<id>` — the two
    // spellings name the SAME human via two different orchestrator entry
    // points (REST vs the live Claude-Code-via-MCP path Persona B actually
    // uses). Before this fix, pollOnce compared against `user:<id>` only, so
    // a task created the way Persona B really creates it was silently never
    // surfaced — Q2's "a parked task announces itself" guarantee never fired
    // for the one path it exists to serve.
    const home = mkHome();
    seedCredential(home, SERVER, TOKEN);
    const orgs = [{ id: 'org-1', slug: 'acme', name: 'Acme', role: 'member' }];
    const fetchImpl = scriptedFetch({
      me: { status: 200, body: { user: { id: 'u1' }, orgs } },
      tasksByOrg: { 'org-1': [task({ originPrincipal: 'mcp-user:u1' })] },
    });
    const result = await pollOnce(makeDeps(fetchImpl, home));
    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0]!.taskId).toBe('task-1');
  });

  test('a "mcp-user:" task belonging to someone else is still filtered out', async () => {
    const home = mkHome();
    seedCredential(home, SERVER, TOKEN);
    const orgs = [{ id: 'org-1', slug: 'acme', name: 'Acme', role: 'member' }];
    const fetchImpl = scriptedFetch({
      me: { status: 200, body: { user: { id: 'u1' }, orgs } },
      tasksByOrg: { 'org-1': [task({ originPrincipal: 'mcp-user:someone-else' })] },
    });
    const result = await pollOnce(makeDeps(fetchImpl, home));
    expect(result.notifications).toEqual([]);
  });

  test('a task originated via the A2A façade (originPrincipal "a2a-user:<id>") is ALSO detected as the caller\'s own — completing the same-class fix for c7', async () => {
    // cloud/apps/api/src/modules/mesh-a2a/tokens.ts#principalForA2a stamps
    // A2A-created tasks `a2a-user:<id>` — the THIRD user-delegated namespace
    // (after REST `user:` and MCP `mcp-user:`), landed by task c7. The e3
    // convergence fix must recognize it too, or the exact same silent-miss
    // bug re-appears for the A2A entry point.
    const home = mkHome();
    seedCredential(home, SERVER, TOKEN);
    const orgs = [{ id: 'org-1', slug: 'acme', name: 'Acme', role: 'member' }];
    const fetchImpl = scriptedFetch({
      me: { status: 200, body: { user: { id: 'u1' }, orgs } },
      tasksByOrg: { 'org-1': [task({ originPrincipal: 'a2a-user:u1' })] },
    });
    const result = await pollOnce(makeDeps(fetchImpl, home));
    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0]!.taskId).toBe('task-1');
  });

  test('a non-user principal (execution/department) with the caller\'s id embedded is NOT matched (no over-match across namespaces)', async () => {
    // `department:<id>`/`runner:<id>` etc. are machine principals — even if an
    // id string collided, they must never be surfaced as the human's own task.
    const home = mkHome();
    seedCredential(home, SERVER, TOKEN);
    const orgs = [{ id: 'org-1', slug: 'acme', name: 'Acme', role: 'member' }];
    const fetchImpl = scriptedFetch({
      me: { status: 200, body: { user: { id: 'u1' }, orgs } },
      tasksByOrg: { 'org-1': [task({ originPrincipal: 'department:u1' })] },
    });
    const result = await pollOnce(makeDeps(fetchImpl, home));
    expect(result.notifications).toEqual([]);
  });

  test('an EXPIRED stored credential is skipped with an error, not thrown', async () => {
    const home = mkHome();
    seedCredential(home, SERVER, TOKEN, Date.parse('2026-07-01T00:00:00.000Z')); // in the past relative to `now`
    const fetchImpl = scriptedFetch({ me: { status: 200 }, tasksByOrg: {} });
    const result = await pollOnce(makeDeps(fetchImpl, home));
    expect(result.serversPolled).toBe(0);
    expect(result.notifications).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('expired');
  });

  test('a 401 from /api/v1/me is skipped with an error, not thrown', async () => {
    const home = mkHome();
    seedCredential(home, SERVER, TOKEN);
    const fetchImpl = scriptedFetch({ me: { status: 401, body: { error: 'invalid_token' } }, tasksByOrg: {} });
    const result = await pollOnce(makeDeps(fetchImpl, home));
    expect(result.serversPolled).toBe(0);
    expect(result.errors).toHaveLength(1);
  });

  test('multiple orgs on the same server are all polled', async () => {
    const home = mkHome();
    seedCredential(home, SERVER, TOKEN);
    const orgs = [
      { id: 'org-1', slug: 'acme', name: 'Acme', role: 'member' },
      { id: 'org-2', slug: 'globex', name: 'Globex', role: 'member' },
    ];
    const fetchImpl = scriptedFetch({
      me: { status: 200, body: { user: { id: 'u1' }, orgs } },
      tasksByOrg: {
        'org-1': [task({ id: 'task-a' })],
        'org-2': [task({ id: 'task-b' })],
      },
    });
    const result = await pollOnce(makeDeps(fetchImpl, home));
    expect(result.notifications.map((n) => n.taskId).sort()).toEqual(['task-a', 'task-b']);
  });

  test('the pending queue is capped at MAX_PENDING_NOTIFICATIONS, dropping the oldest first', async () => {
    const home = mkHome();
    seedCredential(home, SERVER, TOKEN);
    const ctx: HomeContext = { platform: 'linux', env: { PIPELINE_CLOUD_HOME: home }, homedir: home };
    // Pre-seed a journal with MAX_PENDING_NOTIFICATIONS - 2 fake pending entries.
    const preSeeded: TaskNotification[] = Array.from({ length: MAX_PENDING_NOTIFICATIONS - 2 }, (_, i) => ({
      server: SERVER,
      orgSlug: 'acme',
      taskId: `old-${i}`,
      contextId: 'ctx',
      departmentId: 'dep',
      previousState: null,
      state: 'COMPLETED',
      updatedAt: '2026-07-01T00:00:00.000Z',
      detectedAt: 0,
    }));
    const seeded: NotifyJournal = { version: 1, seen: {}, pending: preSeeded };
    writeNotifyJournal(realFs, notifyJournalPath(ctx), seeded);

    const orgs = [{ id: 'org-1', slug: 'acme', name: 'Acme', role: 'member' }];
    // 5 NEW tasks arrive in one poll — total would be (MAX-2)+5 > MAX.
    const newTasks = Array.from({ length: 5 }, (_, i) => task({ id: `new-${i}` }));
    const fetchImpl = scriptedFetch({
      me: { status: 200, body: { user: { id: 'u1' }, orgs } },
      tasksByOrg: { 'org-1': newTasks },
    });
    await pollOnce(makeDeps(fetchImpl, home));
    const journal = readNotifyJournal(realFs, notifyJournalPath(ctx));
    expect(journal.pending).toHaveLength(MAX_PENDING_NOTIFICATIONS);
    // The oldest entries (old-0, old-1) were dropped; the newest 5 all survived.
    expect(journal.pending.some((p) => p.taskId === 'old-0')).toBe(false);
    expect(journal.pending.some((p) => p.taskId === 'old-1')).toBe(false);
    for (let i = 0; i < 5; i++) expect(journal.pending.some((p) => p.taskId === `new-${i}`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// drainPendingNotifications
// ---------------------------------------------------------------------------

describe('drainPendingNotifications', () => {
  test('returns the pending queue and clears it, leaving the seen cursor intact', async () => {
    const home = mkHome();
    seedCredential(home, SERVER, TOKEN);
    const orgs = [{ id: 'org-1', slug: 'acme', name: 'Acme', role: 'member' }];
    const fetchImpl = scriptedFetch({
      me: { status: 200, body: { user: { id: 'u1' }, orgs } },
      tasksByOrg: { 'org-1': [task()] },
    });
    await pollOnce(makeDeps(fetchImpl, home));

    const drained = drainPendingNotifications({ fs: realFs, platform: 'linux', env: { PIPELINE_CLOUD_HOME: home }, homedir: home });
    expect(drained).toHaveLength(1);
    expect(drained[0]!.taskId).toBe('task-1');

    const ctx: HomeContext = { platform: 'linux', env: { PIPELINE_CLOUD_HOME: home }, homedir: home };
    const journal = readNotifyJournal(realFs, notifyJournalPath(ctx));
    expect(journal.pending).toEqual([]);
    // seen cursor (used for future dedup) survives the drain.
    expect(journal.seen[`${SERVER}::task-1`]).toBeDefined();

    // Draining again with nothing new pending returns empty.
    const secondDrain = drainPendingNotifications({ fs: realFs, platform: 'linux', env: { PIPELINE_CLOUD_HOME: home }, homedir: home });
    expect(secondDrain).toEqual([]);
  });

  test('no journal file at all → empty drain, no throw', () => {
    const home = mkHome();
    const drained = drainPendingNotifications({ fs: realFs, platform: 'linux', env: { PIPELINE_CLOUD_HOME: home }, homedir: home });
    expect(drained).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// journal I/O edge cases
// ---------------------------------------------------------------------------

describe('journal I/O', () => {
  test('a corrupt journal file reads back as empty (never throws)', () => {
    const home = mkHome();
    const ctx: HomeContext = { platform: 'linux', env: { PIPELINE_CLOUD_HOME: home }, homedir: home };
    const path = notifyJournalPath(ctx);
    realFs.writeFileSync(path, 'not json at all');
    const journal = readNotifyJournal(realFs, path);
    expect(journal).toEqual({ version: 1, seen: {}, pending: [] });
  });

  test('notifyLockPath sits beside notifyJournalPath, both under the credential dir', () => {
    const home = mkHome();
    const ctx: HomeContext = { platform: 'linux', env: { PIPELINE_CLOUD_HOME: home }, homedir: home };
    expect(notifyJournalPath(ctx)).toBe(join(home, 'mesh-notify-state.json'));
    expect(notifyLockPath(ctx)).toBe(join(home, 'mesh-notify-daemon.lock'));
  });
});

// ---------------------------------------------------------------------------
// pollLoop
// ---------------------------------------------------------------------------

describe('pollLoop', () => {
  test('polls maxIterations times, firing onNotification once per new transition and sleeping intervalMs between cycles', async () => {
    const home = mkHome();
    seedCredential(home, SERVER, TOKEN);
    const orgs = [{ id: 'org-1', slug: 'acme', name: 'Acme', role: 'member' }];
    // Same task every cycle: notified once (cycle 1), silent thereafter (unchanged state).
    const fetchImpl = scriptedFetch({
      me: { status: 200, body: { user: { id: 'u1' }, orgs } },
      tasksByOrg: { 'org-1': [task()] },
    });
    const sleeps: number[] = [];
    const notified: TaskNotification[] = [];
    await pollLoop(makeDeps(fetchImpl, home), {
      intervalMs: 30_000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      onNotification: (n) => {
        notified.push(n);
      },
      maxIterations: 3,
    });
    expect(notified).toHaveLength(1);
    // pollLoop sleeps BETWEEN cycles, not after the last one — 3 iterations
    // means 2 sleeps (the loop returns immediately once maxIterations is hit).
    expect(sleeps).toEqual([30_000, 30_000]);
  });

  test('a poll-cycle error is reported via onError and does not stop the loop', async () => {
    const home = mkHome();
    seedCredential(home, SERVER, TOKEN);
    let fetchCalls = 0;
    const fetchImpl: FetchLike = async () => {
      fetchCalls++;
      throw new Error('network down');
    };
    const errors: string[] = [];
    await pollLoop(makeDeps(fetchImpl, home), {
      intervalMs: 1000,
      sleep: async () => {},
      onError: (e) => errors.push(e),
      maxIterations: 2,
    });
    // Both iterations really ran (one fetch attempt each) despite the first
    // cycle's failure — fetchMe swallows the throw internally (returns null)
    // and pollOnce itself never throws; the "me" fetch failure surfaces as a
    // per-server error, not a poll-cycle crash that would abort the loop.
    expect(fetchCalls).toBe(2);
    expect(errors.filter((e) => e.includes('could not resolve identity'))).toHaveLength(2);
  });

  test('an onNotification handler that throws is caught and reported, never crashing the loop', async () => {
    const home = mkHome();
    seedCredential(home, SERVER, TOKEN);
    const orgs = [{ id: 'org-1', slug: 'acme', name: 'Acme', role: 'member' }];
    const fetchImpl = scriptedFetch({
      me: { status: 200, body: { user: { id: 'u1' }, orgs } },
      tasksByOrg: { 'org-1': [task()] },
    });
    const errors: string[] = [];
    await pollLoop(makeDeps(fetchImpl, home), {
      intervalMs: 1000,
      sleep: async () => {},
      onNotification: () => {
        throw new Error('toast backend unavailable');
      },
      onError: (e) => errors.push(e),
      maxIterations: 1,
    });
    expect(errors.some((e) => e.includes('toast backend unavailable'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

describe('pure helpers', () => {
  test('isNotifyTerminal classifies exactly the four terminal states', () => {
    expect(isNotifyTerminal('COMPLETED')).toBe(true);
    expect(isNotifyTerminal('FAILED')).toBe(true);
    expect(isNotifyTerminal('CANCELED')).toBe(true);
    expect(isNotifyTerminal('REJECTED')).toBe(true);
    expect(isNotifyTerminal('INPUT_REQUIRED')).toBe(false);
    expect(isNotifyTerminal('AUTH_REQUIRED')).toBe(false);
    expect(isNotifyTerminal('WORKING')).toBe(false);
    expect(isNotifyTerminal('SUBMITTED')).toBe(false);
  });

  test('notificationTitle/notificationBody produce stable, non-empty one-liners', () => {
    const n: TaskNotification = {
      server: SERVER,
      orgSlug: 'acme',
      taskId: 'task-1',
      contextId: 'ctx-1',
      departmentId: 'dep-1',
      previousState: null,
      state: 'INPUT_REQUIRED',
      updatedAt: '2026-07-24T00:00:00.000Z',
      detectedAt: 0,
    };
    expect(notificationTitle(n)).toContain('needs your input');
    expect(notificationBody(n)).toContain('task-1');
    expect(notificationBody(n)).toContain('dep-1');
    expect(notificationBody(n)).toContain('acme');

    const done: TaskNotification = { ...n, state: 'COMPLETED', orgSlug: null };
    expect(notificationTitle(done)).toContain('finished');
    expect(notificationBody(done)).not.toContain('org');
  });
});
