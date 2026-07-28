// department-notify-cli.test.ts — `pipeline department notify` CLI entry:
// arg parsing + the --once smoke-test path (daemon-loop behavior itself is
// covered by department-notify.test.ts's pollLoop suite against the pure
// core). The deprecated `pipeline mesh notify` alias has its own small test
// file, mesh.test.ts, covering only the warn-and-delegate behavior — this
// file was `mesh.test.ts` before a11 moved the CLI shell to
// `commands/department-notify.ts`.

import { test, expect, afterEach, describe } from 'bun:test';
import {
  runDepartmentNotify,
  parseNotifyArgs,
  DEFAULT_INTERVAL_MS,
  MIN_INTERVAL_MS,
  type DepartmentNotifyCliDeps,
} from '../src/commands/department-notify';
import { realFs, credentialFilePath, writeCredentialStore, type HomeContext } from '../src/lib/cloud-config';
import type { FetchLike, HttpResponse, HttpInit } from '../src/lib/department-notify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

function mkHome(): string {
  const d = mkdtempSync(join(tmpdir(), 'pipeline-department-notify-cli-home-'));
  created.push(d);
  return d;
}

// ---------------------------------------------------------------------------
// parseNotifyArgs
// ---------------------------------------------------------------------------

describe('parseNotifyArgs', () => {
  test('defaults: not once, not json, default interval', () => {
    const r = parseNotifyArgs([]);
    expect(r).toEqual({ once: false, intervalMs: DEFAULT_INTERVAL_MS, json: false });
  });

  test('--once and --json flags', () => {
    const r = parseNotifyArgs(['--once', '--json']);
    expect('error' in r).toBe(false);
    if (!('error' in r)) {
      expect(r.once).toBe(true);
      expect(r.json).toBe(true);
    }
  });

  test('--interval-ms <n> and --interval-ms=<n> both parse', () => {
    const a = parseNotifyArgs(['--interval-ms', '90000']);
    const b = parseNotifyArgs(['--interval-ms=90000']);
    expect(a).toEqual({ once: false, intervalMs: 90_000, json: false });
    expect(b).toEqual({ once: false, intervalMs: 90_000, json: false });
  });

  test('an interval below the floor clamps up to MIN_INTERVAL_MS', () => {
    const r = parseNotifyArgs(['--interval-ms=100']);
    expect('error' in r).toBe(false);
    if (!('error' in r)) expect(r.intervalMs).toBe(MIN_INTERVAL_MS);
  });

  test('a non-numeric or non-positive interval is a usage error', () => {
    expect('error' in parseNotifyArgs(['--interval-ms=abc'])).toBe(true);
    expect('error' in parseNotifyArgs(['--interval-ms=-5'])).toBe(true);
    expect('error' in parseNotifyArgs(['--interval-ms=0'])).toBe(true);
  });

  test('a missing --interval-ms value is a usage error', () => {
    expect('error' in parseNotifyArgs(['--interval-ms'])).toBe(true);
  });

  test('an unknown flag is a usage error', () => {
    expect('error' in parseNotifyArgs(['--bogus'])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runDepartmentNotify — CLI entry (args hold only notify's own flags; the
// `department` dispatcher already consumed the `notify` word)
// ---------------------------------------------------------------------------

function makeCliDeps(
  home: string,
  overrides: Partial<DepartmentNotifyCliDeps> = {},
): { deps: DepartmentNotifyCliDeps; out: () => string; err: () => string } {
  let outBuf = '';
  let errBuf = '';
  const deps: DepartmentNotifyCliDeps = {
    fetch: (async () => {
      throw new Error('fetch should not be called in this test');
    }) as FetchLike,
    fs: realFs,
    now: () => Date.now(),
    sleep: async () => {},
    env: { PIPELINE_CLOUD_HOME: home },
    platform: 'linux',
    homedir: home,
    spawn: () => {},
    out: (s) => {
      outBuf += s;
    },
    err: (s) => {
      errBuf += s;
    },
    ...overrides,
  };
  return { deps, out: () => outBuf, err: () => errBuf };
}

describe('runDepartmentNotify', () => {
  test('--help → usage to stdout, exit 0', async () => {
    const { deps, out } = makeCliDeps(mkHome());
    const code = await runDepartmentNotify(['--help'], deps);
    expect(code).toBe(0);
    expect(out()).toContain('Usage: pipeline department notify');
  });

  test('a bad flag → usage error, exit 2', async () => {
    const { deps, err } = makeCliDeps(mkHome());
    const code = await runDepartmentNotify(['--nope'], deps);
    expect(code).toBe(2);
    expect(err()).toContain('unknown argument');
  });

  test('--once with no stored credential → polls zero servers, prints a clean summary, exit 0', async () => {
    const home = mkHome();
    const { deps, out } = makeCliDeps(home);
    const code = await runDepartmentNotify(['--once'], deps);
    expect(code).toBe(0);
    expect(out()).toContain('polled 0 server(s)');
  });

  test('--once --json with no stored credential prints a machine-readable summary', async () => {
    const home = mkHome();
    const { deps, out } = makeCliDeps(home);
    const code = await runDepartmentNotify(['--once', '--json'], deps);
    expect(code).toBe(0);
    const parsed = JSON.parse(out().trim());
    expect(parsed).toEqual({ servers_polled: 0, notifications: 0, errors: [] });
  });

  test('--once with a task in INPUT_REQUIRED fires the OS-notify spawn AND prints the human line', async () => {
    const home = mkHome();
    const ctx: HomeContext = { platform: 'linux', env: { PIPELINE_CLOUD_HOME: home }, homedir: home };
    writeCredentialStore(realFs, credentialFilePath(ctx), {
      version: 1,
      servers: { 'https://api.example.com': { access_token: 'tok', token_type: 'bearer' } },
    });
    const fetchImpl: FetchLike = async (url: string, _init: HttpInit): Promise<HttpResponse> => {
      if (url.endsWith('/api/v1/me')) {
        return {
          status: 200,
          json: async () => ({ user: { id: 'u1' }, orgs: [{ id: 'org-1', slug: 'acme', name: 'Acme', role: 'member' }] }),
        };
      }
      if (url.endsWith('/api/v1/dept-tasks')) {
        return {
          status: 200,
          json: async () => ({
            tasks: [
              {
                id: 'task-1',
                contextId: 'ctx-1',
                departmentId: 'dep-1',
                originPrincipal: 'user:u1',
                state: 'INPUT_REQUIRED',
                stateVersion: 1,
                updatedAt: '2026-07-24T00:00:00.000Z',
              },
            ],
          }),
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    };
    const spawnCalls: Array<{ cmd: string; args: string[] }> = [];
    const { deps, out } = makeCliDeps(home, { fetch: fetchImpl, spawn: (cmd, args) => spawnCalls.push({ cmd, args }) });
    const code = await runDepartmentNotify(['--once'], deps);
    expect(code).toBe(0);
    expect(out()).toContain('needs your input');
    expect(out()).toContain('task-1');
    expect(spawnCalls).toHaveLength(1); // linux → notify-send
    expect(spawnCalls[0]!.cmd).toBe('notify-send');
  });
});
