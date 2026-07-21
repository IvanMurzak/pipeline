import { test, expect, afterEach } from 'bun:test';
import { parseUiArgs, daemonUrl, resolveSupervisorScript, hasPipelineDir, uiEnabled } from '../src/commands/ui';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

test('parseUiArgs: defaults + flags', () => {
  expect(parseUiArgs([])).toEqual({ open: false, json: false, restart: false });
  expect(parseUiArgs(['--open'])).toEqual({ open: true, json: false, restart: false });
  expect(parseUiArgs(['--json', '--open'])).toEqual({ open: true, json: true, restart: false });
  expect(parseUiArgs(['--open', '--no-open'])).toEqual({ open: false, json: false, restart: false });
  expect(parseUiArgs(['--restart'])).toEqual({ open: false, json: false, restart: true });
});

test('uiEnabled: ON by default, off only on an explicit falsy opt-out', () => {
  const prev = process.env.PIPELINE_UI_ENABLED;
  try {
    // Unset → ON (the flipped default: the UI works out of the box).
    delete process.env.PIPELINE_UI_ENABLED;
    expect(uiEnabled()).toBe(true); // enabled by default when unset
    // Empty string is treated as unset → ON (an empty value is NOT an opt-out).
    process.env.PIPELINE_UI_ENABLED = '';
    expect(uiEnabled()).toBe(true);
    // Any explicit truthy / non-falsy value → ON (unchanged).
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on', 'please', 'anything']) {
      process.env.PIPELINE_UI_ENABLED = v;
      expect(uiEnabled()).toBe(true);
    }
    // Explicit falsy value → OFF (the opt-out; case-insensitive, whitespace-trimmed).
    for (const v of ['0', 'false', 'FALSE', 'off', 'OFF', 'no', 'NO', ' 0 ', ' off ']) {
      process.env.PIPELINE_UI_ENABLED = v;
      expect(uiEnabled()).toBe(false);
    }
  } finally {
    if (prev === undefined) delete process.env.PIPELINE_UI_ENABLED;
    else process.env.PIPELINE_UI_ENABLED = prev;
  }
});

test('daemonUrl: builds from lock, defaults host', () => {
  expect(daemonUrl({ host: '127.0.0.1', port: 50000 })).toBe('http://127.0.0.1:50000/');
  expect(daemonUrl({ port: 51234 } as { port: number })).toBe('http://127.0.0.1:51234/');
});

test('resolveSupervisorScript: finds via CLAUDE_PLUGIN_ROOT', () => {
  const root = mkdtempSync(join(tmpdir(), 'ui-root-'));
  created.push(root);
  const uiDir = join(root, 'apps', 'pipeline-ui');
  mkdirSync(uiDir, { recursive: true });
  writeFileSync(join(uiDir, 'supervisor.ts'), '// stub\n');
  expect(resolveSupervisorScript(root, '/nowhere')).toBe(join(uiDir, 'supervisor.ts'));
});

test('resolveSupervisorScript: walks up from a start dir', () => {
  const root = mkdtempSync(join(tmpdir(), 'ui-walk-'));
  created.push(root);
  const uiDir = join(root, 'apps', 'pipeline-ui');
  mkdirSync(uiDir, { recursive: true });
  writeFileSync(join(uiDir, 'supervisor.ts'), '// stub\n');
  const deep = join(root, 'apps', 'pipeline-cli', 'src', 'commands');
  mkdirSync(deep, { recursive: true });
  expect(resolveSupervisorScript(undefined, deep)).toBe(join(uiDir, 'supervisor.ts'));
});

test('resolveSupervisorScript: null when not found', () => {
  const root = mkdtempSync(join(tmpdir(), 'ui-none-'));
  created.push(root);
  expect(resolveSupervisorScript(undefined, root)).toBeNull();
  expect(resolveSupervisorScript(root, root)).toBeNull();
});

test('hasPipelineDir: detects .claude/pipeline at cwd or an ancestor', () => {
  const root = mkdtempSync(join(tmpdir(), 'ui-pipe-'));
  created.push(root);
  mkdirSync(join(root, '.claude', 'pipeline'), { recursive: true });
  const deep = join(root, 'a', 'b', 'c');
  mkdirSync(deep, { recursive: true });
  expect(hasPipelineDir(root)).toBe(true);
  expect(hasPipelineDir(deep)).toBe(true);

  const bare = mkdtempSync(join(tmpdir(), 'ui-bare-'));
  created.push(bare);
  expect(hasPipelineDir(bare)).toBe(false);
});

// The real supervisor.ts must be reachable from this command file's location
// (the plugin-install case), so the launcher can find it without env vars.
test('resolveSupervisorScript: finds the real plugin supervisor by walking up', () => {
  const commandsDir = join(import.meta.dir, '..', 'src', 'commands');
  const found = resolveSupervisorScript(undefined, commandsDir);
  expect(found).not.toBeNull();
  expect(found!.replace(/\\/g, '/')).toContain('apps/pipeline-ui/supervisor.ts');
});
