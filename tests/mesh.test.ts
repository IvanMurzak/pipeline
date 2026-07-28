// mesh.test.ts — the DEPRECATED `pipeline mesh notify` alias
// (`commands/mesh.ts`, a11: 08-terminology.md / D10 / D31). It has no logic
// of its own beyond subcommand dispatch + a deprecation warning; the actual
// notify behavior is covered by department-notify-cli.test.ts (CLI shell)
// and department-notify.test.ts (poll/diff/journal core) against
// `commands/department-notify.ts`, which this file delegates to.
//
// DoD coverage (a11-rename-plugin.md): "pipeline mesh notify still works,
// warns, and points at the new name."

import { test, expect, afterEach, describe } from 'bun:test';
import { runMesh } from '../src/commands/mesh';
import { realFs } from '../src/lib/cloud-config';
import type { DepartmentNotifyCliDeps } from '../src/commands/department-notify';
import type { FetchLike } from '../src/lib/department-notify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

function mkHome(): string {
  const d = mkdtempSync(join(tmpdir(), 'pipeline-mesh-deprecated-home-'));
  created.push(d);
  return d;
}

function makeCliDeps(home: string): { deps: DepartmentNotifyCliDeps; out: () => string; err: () => string } {
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
  };
  return { deps, out: () => outBuf, err: () => errBuf };
}

describe('runMesh (deprecated alias)', () => {
  test('no subcommand → usage to stderr, exit 2', async () => {
    const { deps, err } = makeCliDeps(mkHome());
    const code = await runMesh([], deps);
    expect(code).toBe(2);
    expect(err()).toContain('Usage: pipeline mesh notify');
  });

  test('--help → usage to stdout naming the deprecation, exit 0', async () => {
    const { deps, out } = makeCliDeps(mkHome());
    const code = await runMesh(['--help'], deps);
    expect(code).toBe(0);
    expect(out()).toContain('Usage: pipeline mesh notify');
    expect(out()).toContain('DEPRECATED');
    expect(out()).toContain('pipeline department notify');
  });

  test('unknown subcommand → usage to stderr, exit 2', async () => {
    const { deps, err } = makeCliDeps(mkHome());
    const code = await runMesh(['bogus'], deps);
    expect(code).toBe(2);
    expect(err()).toContain("unknown subcommand 'bogus'");
  });

  test('notify warns on stderr and points at the new name before doing anything else', async () => {
    const home = mkHome();
    const { deps, err } = makeCliDeps(home);
    const code = await runMesh(['notify', '--once'], deps);
    expect(code).toBe(0);
    expect(err()).toContain('deprecated');
    expect(err()).toContain('pipeline department notify');
  });

  test('notify --once still works end-to-end, delegating to the same behavior as `department notify`', async () => {
    const home = mkHome();
    const { deps, out } = makeCliDeps(home);
    const code = await runMesh(['notify', '--once'], deps);
    expect(code).toBe(0);
    expect(out()).toContain('polled 0 server(s)');
  });

  test('notify with a bad flag still validates (delegated), after the deprecation warning', async () => {
    const { deps, err } = makeCliDeps(mkHome());
    const code = await runMesh(['notify', '--nope'], deps);
    expect(code).toBe(2);
    expect(err()).toContain('deprecated');
    expect(err()).toContain('unknown argument');
  });
});
