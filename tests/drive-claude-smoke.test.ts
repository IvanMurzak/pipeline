// @serial — REAL end-to-end smoke against the INSTALLED claude binary: spawns
// a genuine `pipeline:step-executor` (haiku) through `pipeline drive`'s
// DEFAULT template and proves a step record lands under the fixed contract
// (e7 DEFECT-1) with the pipeline living under `.claude/` — the layout whose
// canonical records path is sensitive-gated on Claude Code >= 2.1.21x.
//
// Held out of the parallel pool (@serial: one real claude session; timing and
// network bound). SKIPPED when the environment cannot run it:
//   - CI (no claude binary / no credentials),
//   - no `claude` on PATH,
//   - PIPELINE_SKIP_CLAUDE_SMOKE=1 (developer opt-out — the run costs a real
//     model call, ~cents on haiku).
//
// What it proves (empirically verified on Claude Code 2.1.214, 2026-07-18):
//   - `-p --agent` produces NO structured_output (claude-code#20625) and
//     headless acceptEdits DENIES `.claude/` writes — yet the record lands via
//     the drop-file (--add-dir grant) or result-text channel, and drive
//     persists the canonical `.runtime/<run>/records/` copy itself.

import { test, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
}, 30000);

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

function claudeAvailable(): boolean {
  try {
    // shell:true — `claude` installs as a .cmd shim on Windows.
    const r = spawnSync('claude --version', { shell: true, encoding: 'utf8', timeout: 30000 });
    return r.status === 0 && /\d+\.\d+/.test(r.stdout ?? '');
  } catch {
    return false;
  }
}

const SKIP =
  process.env.CI !== undefined ||
  process.env.PIPELINE_SKIP_CLAUDE_SMOKE === '1' ||
  !claudeAvailable();

test.skipIf(SKIP)(
  'drive smoke (REAL claude): a one-step .claude/ pipeline completes and the record lands',
  () => {
    // A real consumer-project layout: git repo + .claude/pipeline/<name>.
    const project = mkdtempSync(join(tmpdir(), 'drive-claude-smoke-'));
    created.push(project);
    spawnSync('git', ['init', '-q'], { cwd: project });
    const root = join(project, '.claude', 'pipeline', 'smoke');
    mkdirSync(join(root, 'steps'), { recursive: true });
    writeFileSync(join(root, 'PIPELINE.md'), '# Smoke\n\n## End State\nsmoke-artifact.txt exists.\n');
    writeFileSync(
      join(root, 'steps', '01-touch.md'),
      [
        '# Create the smoke artifact',
        '## Goal',
        'Create one small file to prove the run executes.',
        '## Steps',
        '1. In the project root (your current working directory), create a file named `smoke-artifact.txt` containing exactly this single line: `drive-smoke-ok`',
        '## Success Criteria',
        '- `smoke-artifact.txt` exists in the project root with the exact content `drive-smoke-ok`.',
        '## Next',
        'PIPELINE_COMPLETE',
        '',
      ].join('\n'),
      'utf8',
    );

    const run = `smoke-${Date.now().toString(36)}`;
    const env: NodeJS.ProcessEnv = { ...process.env };
    // Journal isolation vars only — HOME stays REAL (claude auth + plugin).
    delete env.PIPELINE_UI_RUN_ID;
    delete env.PIPELINE_UI_PARENT_RUN_ID;
    delete env.CLAUDE_SESSION_ID;
    delete env.PIPELINE_DRIVE_EXECUTOR_CMD;

    const r = spawnSync(
      process.execPath,
      [CLI, 'drive', '--root', root, '--run-id', run, '--start', join(root, 'steps', '01-touch.md'), '--default-model', 'haiku'],
      { encoding: 'utf8', cwd: project, env, timeout: 480000 },
    );

    // Surface the full transcript on failure — this is the evidence run.
    const transcript = `--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;
    if (r.status !== 0) console.error(transcript);

    expect(r.status).toBe(0);
    const json = JSON.parse(r.stdout);
    expect(json.status).toBe('completed');

    // The record landed and drive persisted the canonical copy (the executor
    // itself CANNOT write here on >= 2.1.21x — sensitive-path auto-deny).
    const rec = JSON.parse(readFileSync(join(root, '.runtime', run, 'records', '01-touch.json'), 'utf8'));
    expect(rec.outcome).toBe('completed');

    // Which channel carried it (structured_output on <= 2.1.205; record-file /
    // result-text on >= 2.1.21x) — assert one of the ladder's channels won.
    expect(r.stderr).toMatch(/step\.record .*source=(structured_output|record-file|record-file-legacy|result-text)/);
    // The record write was NEVER denied under the fixed contract.
    expect(r.stderr).not.toContain('step.record_write_denied');

    // The step did its real work.
    expect(existsSync(join(project, 'smoke-artifact.txt'))).toBe(true);
    expect(readFileSync(join(project, 'smoke-artifact.txt'), 'utf8').trim()).toBe('drive-smoke-ok');

    console.log(`[drive-claude-smoke] PASS — record channel evidence:\n${r.stderr.split('\n').filter((l) => l.includes('step.record') || l.includes('run.')).join('\n')}`);
  },
  600000,
);
