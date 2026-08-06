// Tests for `pipeline fix` (src/commands/fix.ts) — the CLI port of the local
// dashboard's AI Fix.
//
// This is a security-critical command: it spawns a headless `claude -p`
// session that edits the user's files. Two of its safety properties are load
// bearing, and both are proven here by tests that FAIL IF THE CHECK IS REMOVED
// OR REORDERED, not by asserting that a check exists:
//
//   SAFETY PROPERTY 2 — `pipeline_root` is containment-checked BEFORE anything
//   is spawned. Proven by driving an escape attempt through an INJECTED
//   session runner that records every call, and asserting the recorder saw
//   ZERO calls. Move the containment check below the spawn and this test goes
//   red; delete it and it goes red.
//
//   SAFETY PROPERTY 1 — write scope is ENFORCED, not merely instructed. Proven
//   at three levels: the guard's decision function denies an outside path; the
//   guard runs as a real subprocess against a real hook payload naming a real
//   file outside the pipeline folder, and that file is byte-identical
//   afterwards; and the argv the command builds actually installs the guard
//   (a guard nothing wires up would pass the first two and protect nothing).

import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  buildFixChildEnv,
  buildFixPrompt,
  buildGuardCommand,
  buildGuardSettings,
  decideScopeGuard,
  helpText,
  isInsidePipelinesDir,
  runFix,
  runScopeGuard,
  type FixSessionRequest,
  type FixSessionResult,
} from '../src/commands/fix';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const created: string[] = [];

afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

function tempDir(prefix = 'fix-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/** A consumer project with one v2 pipeline whose manifest LINTS DIRTY, so
 *  `pipeline fix` has something to hand a session. */
function projectWithPipeline(name = 'demo'): { project: string; pipelineRoot: string } {
  const project = tempDir();
  const pipelineRoot = join(project, '.pipeline', name);
  mkdirSync(join(pipelineRoot, 'steps'), { recursive: true });
  // `needs:` an unknown step — a hard plan error with no ambiguity.
  writeFileSync(
    join(pipelineRoot, 'pipeline.yml'),
    [
      'schema: 2',
      'name: demo',
      'steps:',
      '  - name: first',
      '    body: steps/first.md',
      '  - name: second',
      '    body: steps/second.md',
      '    needs: [nonexistent]',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(join(pipelineRoot, 'steps', 'first.md'), '# First\n', 'utf8');
  writeFileSync(join(pipelineRoot, 'steps', 'second.md'), '# Second\n', 'utf8');
  return { project, pipelineRoot };
}

/** A session runner that records every call and never runs anything. */
function recordingSession(result: Partial<FixSessionResult> = {}) {
  const calls: FixSessionRequest[] = [];
  const runner = async (req: FixSessionRequest): Promise<FixSessionResult> => {
    calls.push(req);
    return { code: 0, summary: 'did nothing', costUsd: 0, ...result };
  };
  return { calls, runner };
}

function sinks() {
  let stdout = '';
  let stderr = '';
  return {
    out: (s: string) => {
      stdout += s;
    },
    err: (s: string) => {
      stderr += s;
    },
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

// ---------------------------------------------------------------------------
// SAFETY PROPERTY 2 — containment BEFORE the spawn
// ---------------------------------------------------------------------------

describe('pipeline fix: pipeline_root is containment-checked before anything is spawned', () => {
  test('an escape via .. refuses AND SPAWNS NOTHING', async () => {
    const { project } = projectWithPipeline();
    const outsideVictim = tempDir();
    // A pipeline folder that is real, is a valid pipeline, and is NOT inside
    // this project's .pipeline/ — reached from the project by traversal.
    const evil = join(outsideVictim, 'evil');
    mkdirSync(join(evil, 'steps'), { recursive: true });
    writeFileSync(join(evil, 'pipeline.yml'), 'schema: 2\nname: evil\nsteps: []\n', 'utf8');

    const escape = join(project, '.pipeline', '..', '..', ...evil.split(/[\\/]/).filter(Boolean));
    const { calls, runner } = recordingSession();
    const io = sinks();

    const code = await runFix(['--root', escape, '--project', project], {
      session: runner,
      out: io.out,
      err: io.err,
    });

    expect(code).toBe(2);
    // THE assertion: not "an error was printed", but "no session existed".
    expect(calls.length).toBe(0);
    expect(io.stderr).toContain('outside');
  });

  test('an absolute --root outside the project refuses and spawns nothing', async () => {
    const { project } = projectWithPipeline();
    const elsewhere = tempDir();
    const otherPipeline = join(elsewhere, '.pipeline', 'other');
    mkdirSync(join(otherPipeline, 'steps'), { recursive: true });
    writeFileSync(join(otherPipeline, 'pipeline.yml'), 'schema: 2\nname: other\nsteps: []\n', 'utf8');

    const { calls, runner } = recordingSession();
    const io = sinks();
    const code = await runFix(['--root', otherPipeline, '--project', project], {
      session: runner,
      out: io.out,
      err: io.err,
    });

    expect(code).toBe(2);
    expect(calls.length).toBe(0);
  });

  test('a sibling directory sharing the .pipeline prefix is outside', async () => {
    // `<project>/.pipeline-evil/x` startsWith `<project>/.pipeline` as a
    // string; the containment check must not be a prefix compare.
    const project = tempDir();
    const sibling = join(project, '.pipeline-evil', 'x');
    mkdirSync(join(sibling, 'steps'), { recursive: true });
    writeFileSync(join(sibling, 'pipeline.yml'), 'schema: 2\nname: x\nsteps: []\n', 'utf8');

    expect(isInsidePipelinesDir(project, sibling)).toBe(false);

    const { calls, runner } = recordingSession();
    const io = sinks();
    const code = await runFix(['--root', sibling, '--project', project], {
      session: runner,
      out: io.out,
      err: io.err,
    });
    expect(code).toBe(2);
    expect(calls.length).toBe(0);
  });

  test('the containment refusal beats every other failure mode — the ORDER is the property', async () => {
    // A --root that is outside AND does not exist AND names a bad model AND a
    // bad timeout. Whatever else the command might complain about, it must
    // refuse on containment and it must not spawn.
    const { project } = projectWithPipeline();
    const { calls, runner } = recordingSession();
    const io = sinks();
    const code = await runFix(
      [
        '--root',
        join(tempDir(), 'does-not-exist'),
        '--project',
        project,
        '--model',
        'not-a-model',
        '--timeout',
        '-5',
      ],
      { session: runner, out: io.out, err: io.err },
    );
    expect(code).toBe(2);
    expect(calls.length).toBe(0);
    expect(io.stderr).toContain('outside');
  });

  test('a legitimate root inside the project DOES reach the session (the check is not a blanket no)', async () => {
    const { project, pipelineRoot } = projectWithPipeline();
    const { calls, runner } = recordingSession();
    const io = sinks();

    const code = await runFix(['--root', pipelineRoot, '--project', project], {
      session: runner,
      out: io.out,
      err: io.err,
    });

    expect(calls.length).toBe(1);
    // The plan error is still there (the fake session changed nothing), so the
    // command reports "issues remain".
    expect(code).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// SAFETY PROPERTY 3 — the trust level, unchanged from `pipeline drive`
// ---------------------------------------------------------------------------

describe('pipeline fix: the spawned session runs at drive-parity trust', () => {
  test('acceptEdits, from the PROJECT root, with the guard settings installed', async () => {
    const { project, pipelineRoot } = projectWithPipeline();
    const { calls, runner } = recordingSession();
    await runFix(['--root', pipelineRoot, '--project', project], {
      session: runner,
      out: () => {},
      err: () => {},
    });

    const req = calls[0]!;
    expect(req.argv[0]).toBe('claude');
    expect(req.argv).toContain('-p');
    const permIdx = req.argv.indexOf('--permission-mode');
    expect(permIdx).toBeGreaterThan(-1);
    expect(req.argv[permIdx + 1]).toBe('acceptEdits');
    // Not a bypass. `--dangerously-skip-permissions` would exceed `drive`.
    expect(req.argv).not.toContain('--dangerously-skip-permissions');
    expect(req.argv).not.toContain('bypassPermissions');
    // stream-json REQUIRES --verbose (claude rejects the pair without it).
    expect(req.argv).toContain('--output-format');
    expect(req.argv).toContain('stream-json');
    expect(req.argv).toContain('--verbose');
    // Safety property 3: the project root, not the pipeline folder.
    expect(resolve(req.cwd)).toBe(resolve(project));
  });

  test('the prompt states the write scope', async () => {
    const prompt = buildFixPrompt('/proj/.pipeline/demo', 'pipeline.yml', ['boom']);
    expect(prompt).toContain('ONLY inside /proj/.pipeline/demo');
    expect(prompt).toContain('Never touch anything else in the repository');
    expect(prompt).toContain('boom');
  });

  test('CLAUDE_CODE_FORWARD_SUBAGENT_TEXT is deleted from the child environment', () => {
    const env = buildFixChildEnv({ PATH: '/usr/bin', CLAUDE_CODE_FORWARD_SUBAGENT_TEXT: '1' });
    expect('CLAUDE_CODE_FORWARD_SUBAGENT_TEXT' in env).toBe(false);
    expect(env.PATH).toBe('/usr/bin');
  });
});

// ---------------------------------------------------------------------------
// SAFETY PROPERTY 1 — write scope is ENFORCED
// ---------------------------------------------------------------------------

describe('pipeline fix: the scope guard is wired into the session', () => {
  test('--settings points at a file whose PreToolUse hook re-enters this CLI in guard mode', async () => {
    const { project, pipelineRoot } = projectWithPipeline();
    let settingsSeen: string | null = null;
    const runner = async (req: FixSessionRequest): Promise<FixSessionResult> => {
      const i = req.argv.indexOf('--settings');
      expect(i).toBeGreaterThan(-1);
      // Read it WHILE the session is notionally running — the command deletes
      // the temp dir once the session resolves.
      settingsSeen = readFileSync(req.argv[i + 1]!, 'utf8');
      return { code: 0, summary: null };
    };

    await runFix(['--root', pipelineRoot, '--project', project], {
      session: runner,
      out: () => {},
      err: () => {},
    });

    expect(settingsSeen).not.toBeNull();
    const parsed = JSON.parse(settingsSeen!) as {
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }> };
    };
    const entry = parsed.hooks.PreToolUse[0]!;
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      expect(entry.matcher).toContain(tool);
    }
    expect(entry.hooks[0]!.type).toBe('command');
    expect(entry.hooks[0]!.command).toContain('fix');
    expect(entry.hooks[0]!.command).toContain('--scope-guard');
    expect(entry.hooks[0]!.command).toContain(pipelineRoot);
  });

  test('the guard command double-quotes every path (install dirs contain spaces)', () => {
    const cmd = buildGuardCommand('C:/Program Files/bun/bun.exe', 'C:/my apps/cli.ts', 'C:/proj/.pipeline/a b');
    expect(cmd).toContain('"C:/Program Files/bun/bun.exe"');
    expect(cmd).toContain('"C:/my apps/cli.ts"');
    expect(cmd).toContain('"C:/proj/.pipeline/a b"');
  });

  test('buildGuardSettings shape is what Claude Code reads', () => {
    const s = buildGuardSettings('echo hi') as {
      hooks: { PreToolUse: Array<{ matcher: string; hooks: unknown[] }> };
    };
    expect(Array.isArray(s.hooks.PreToolUse)).toBe(true);
    expect(s.hooks.PreToolUse.length).toBe(1);
    expect(s.hooks.PreToolUse[0]!.hooks.length).toBe(1);
  });
});

describe('pipeline fix --scope-guard: the decision function', () => {
  const root = resolve('/proj/.pipeline/demo');

  test('allows a write INSIDE the pipeline folder', () => {
    const d = decideScopeGuard(root, {
      tool_name: 'Write',
      tool_input: { file_path: join(root, 'steps', 'first.md') },
    });
    expect(d.allow).toBe(true);
  });

  test('denies a write OUTSIDE the pipeline folder', () => {
    const d = decideScopeGuard(root, {
      tool_name: 'Write',
      tool_input: { file_path: resolve('/proj/src/index.ts') },
    });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toContain('outside the pipeline folder');
  });

  test('denies a traversal out of the pipeline folder', () => {
    const d = decideScopeGuard(root, {
      tool_name: 'Edit',
      tool_input: { file_path: join(root, '..', '..', 'secrets.env') },
    });
    expect(d.allow).toBe(false);
  });

  test('denies a sibling directory sharing the root prefix', () => {
    const d = decideScopeGuard(root, {
      tool_name: 'Edit',
      tool_input: { file_path: resolve('/proj/.pipeline/demo-evil/x.md') },
    });
    expect(d.allow).toBe(false);
  });

  test('covers NotebookEdit via notebook_path', () => {
    expect(
      decideScopeGuard(root, {
        tool_name: 'NotebookEdit',
        tool_input: { notebook_path: resolve('/proj/analysis.ipynb') },
      }).allow,
    ).toBe(false);
    expect(
      decideScopeGuard(root, {
        tool_name: 'NotebookEdit',
        tool_input: { notebook_path: join(root, 'a.ipynb') },
      }).allow,
    ).toBe(true);
  });

  test('FAILS CLOSED: a guarded tool with no resolvable path is denied', () => {
    const d = decideScopeGuard(root, { tool_name: 'Write', tool_input: {} });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toContain('no file path');
  });
});

describe('pipeline fix --scope-guard: as a real subprocess, a file outside the folder is NOT modified', () => {
  test('the guard denies the write and the outside file stays byte-identical', () => {
    const { project, pipelineRoot } = projectWithPipeline();

    // A real file outside the pipeline folder, inside the project — the exact
    // thing a session must never touch.
    const victim = join(project, 'src', 'index.ts');
    mkdirSync(join(project, 'src'), { recursive: true });
    const original = 'export const answer = 42;\n';
    writeFileSync(victim, original, 'utf8');
    const before = readFileSync(victim, 'utf8');

    // The hook payload Claude Code sends before it runs the tool. The session
    // is TOLD not to write here (buildFixPrompt) — this proves the write is
    // stopped even when the instruction is ignored.
    const payload = JSON.stringify({
      session_id: 'test',
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: victim, content: 'export const answer = 0; // pwned\n' },
    });

    const proc = spawnSync(
      process.execPath,
      [CLI, 'fix', '--scope-guard', '--root', pipelineRoot],
      { input: payload, encoding: 'utf8' },
    );

    // Exit 2 is Claude Code's "blocking error" — the tool call does not run.
    expect(proc.status).toBe(2);
    const decision = JSON.parse(proc.stdout.trim()) as {
      hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string };
    };
    expect(decision.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(decision.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain('outside the pipeline folder');
    expect(proc.stderr).toContain('refused');

    // THE assertion: the file outside the pipeline folder is untouched.
    expect(readFileSync(victim, 'utf8')).toBe(before);
    expect(readFileSync(victim, 'utf8')).toBe(original);
  });

  test('the same guard ALLOWS a write inside the pipeline folder (silently, exit 0)', () => {
    const { pipelineRoot } = projectWithPipeline();
    const payload = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: join(pipelineRoot, 'steps', 'third.md'), content: '# Third\n' },
    });
    const proc = spawnSync(
      process.execPath,
      [CLI, 'fix', '--scope-guard', '--root', pipelineRoot],
      { input: payload, encoding: 'utf8' },
    );
    expect(proc.status).toBe(0);
    // Silence is allow. Stray stdout is read as a message by some versions.
    expect(proc.stdout.trim()).toBe('');
  });

  test('an unparseable payload is denied, not waved through', async () => {
    const io = sinks();
    const code = await runScopeGuard(['--root', '/proj/.pipeline/demo'], {
      readStdin: async () => 'not json at all',
      out: io.out,
      err: io.err,
    });
    expect(code).toBe(2);
    expect(io.stdout).toContain('"deny"');
    expect(io.stderr).toContain('fails closed');
  });

  test('a stdin read failure is denied, not waved through', async () => {
    const io = sinks();
    const code = await runScopeGuard(['--root', '/proj/.pipeline/demo'], {
      readStdin: async () => {
        throw new Error('pipe closed');
      },
      out: io.out,
      err: io.err,
    });
    expect(code).toBe(2);
    expect(io.stdout).toContain('"deny"');
  });

  test('an unguarded tool passes through (the matcher, not the guard, does routing)', async () => {
    const io = sinks();
    const code = await runScopeGuard(['--root', '/proj/.pipeline/demo'], {
      readStdin: async () => JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/etc/hosts' } }),
      out: io.out,
      err: io.err,
    });
    expect(code).toBe(0);
    expect(io.stdout).toBe('');
  });

  test('--root is required in guard mode', async () => {
    const io = sinks();
    expect(await runScopeGuard([], { readStdin: async () => '{}', out: io.out, err: io.err })).toBe(2);
    expect(io.stderr).toContain('--root is required');
  });
});

// ---------------------------------------------------------------------------
// SAFETY PROPERTY 4 — the trust level is stated in --help
// ---------------------------------------------------------------------------

describe('pipeline fix --help states the trust level', () => {
  test('names the agent, the file edits, the permission mode, and the parity', () => {
    // Collapse the help's own line wrapping — the CLAIMS are the contract,
    // not where the 80th column happens to fall.
    const h = helpText().replace(/\s+/g, ' ');
    expect(h).toContain('TRUST LEVEL');
    expect(h).toContain('EDITS FILES IN YOUR PROJECT');
    expect(h).toContain('acceptEdits');
    expect(h).toContain('the same trust level as `pipeline drive`');
    expect(h).toContain('from your project root');
    // The honest boundary is stated, not hidden.
    expect(h).toContain('`Bash` inside the session is NOT path-restricted');
    // Offline / uploads nothing.
    expect(h).toContain('Nothing is uploaded');
  });

  test('`pipeline fix --help` exits 0 and prints it', async () => {
    const io = sinks();
    const code = await runFix(['--help'], { out: io.out, err: io.err });
    expect(code).toBe(0);
    expect(io.stdout).toContain('TRUST LEVEL');
  });

  test('the top-level `pipeline --help` carries the trust warning too', () => {
    const proc = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
    expect(proc.status).toBe(0);
    expect(proc.stdout).toContain('fix --root <pipeline_root>');
    expect(proc.stdout).toContain('TRUST LEVEL');
    expect(proc.stdout).toContain('acceptEdits');
  });
});

// ---------------------------------------------------------------------------
// Command behaviour
// ---------------------------------------------------------------------------

describe('pipeline fix: behaviour', () => {
  test('a clean pipeline spawns nothing and exits 0', async () => {
    const project = tempDir();
    const pipelineRoot = join(project, '.pipeline', 'clean');
    mkdirSync(join(pipelineRoot, 'steps'), { recursive: true });
    writeFileSync(
      join(pipelineRoot, 'pipeline.yml'),
      ['schema: 2', 'name: clean', 'steps:', '  - name: only', '    body: steps/only.md', ''].join('\n'),
      'utf8',
    );
    writeFileSync(join(pipelineRoot, 'steps', 'only.md'), '# Only\n', 'utf8');

    const { calls, runner } = recordingSession();
    const io = sinks();
    const code = await runFix(['--root', pipelineRoot, '--project', project], {
      session: runner,
      out: io.out,
      err: io.err,
    });
    expect(code).toBe(0);
    expect(calls.length).toBe(0);
    expect(io.stdout).toContain('Nothing to fix');
  });

  test('a session that actually fixes the manifest exits 0 and reports resolved', async () => {
    const { project, pipelineRoot } = projectWithPipeline();
    const runner = async (): Promise<FixSessionResult> => {
      // Stand in for the real session: repair the bad `needs:`.
      writeFileSync(
        join(pipelineRoot, 'pipeline.yml'),
        [
          'schema: 2',
          'name: demo',
          'steps:',
          '  - name: first',
          '    body: steps/first.md',
          '  - name: second',
          '    body: steps/second.md',
          '    needs: [first]',
          '',
        ].join('\n'),
        'utf8',
      );
      return { code: 0, summary: 'fixed the needs reference', costUsd: 0.01 };
    };
    const io = sinks();
    const code = await runFix(['--root', pipelineRoot, '--project', project, '--json'], {
      session: runner,
      out: io.out,
      err: io.err,
    });
    expect(code).toBe(0);
    const json = JSON.parse(io.stdout) as { resolved: boolean; issues_before: number; issues_after: number };
    expect(json.resolved).toBe(true);
    expect(json.issues_before).toBeGreaterThan(0);
    expect(json.issues_after).toBe(0);
  });

  test('a failed session exits 1 and says so', async () => {
    const { project, pipelineRoot } = projectWithPipeline();
    const runner = async (): Promise<FixSessionResult> => ({ code: null, error: 'could not spawn claude' });
    const io = sinks();
    const code = await runFix(['--root', pipelineRoot, '--project', project], {
      session: runner,
      out: io.out,
      err: io.err,
    });
    expect(code).toBe(1);
    expect(io.stderr).toContain('could not spawn claude');
  });

  test('the temp settings file is cleaned up even when the session throws', async () => {
    const { project, pipelineRoot } = projectWithPipeline();
    let settingsPath = '';
    const runner = async (req: FixSessionRequest): Promise<FixSessionResult> => {
      settingsPath = req.argv[req.argv.indexOf('--settings') + 1]!;
      throw new Error('boom');
    };
    await expect(
      runFix(['--root', pipelineRoot, '--project', project], {
        session: runner,
        out: () => {},
        err: () => {},
      }),
    ).rejects.toThrow('boom');
    expect(settingsPath).not.toBe('');
    expect(existsSync(settingsPath)).toBe(false);
  });

  test('--root is required', async () => {
    const io = sinks();
    expect(await runFix([], { out: io.out, err: io.err })).toBe(2);
    expect(io.stderr).toContain('--root is required');
  });

  test('an unknown flag is a loud usage error, not a silent no-op', async () => {
    const io = sinks();
    expect(await runFix(['--root', 'x', '--frobnicate'], { out: io.out, err: io.err })).toBe(2);
    expect(io.stderr).toContain('--frobnicate');
  });

  test('an unknown model is rejected; a canonical claude-* id is accepted', async () => {
    const { project, pipelineRoot } = projectWithPipeline();
    const io = sinks();
    expect(
      await runFix(['--root', pipelineRoot, '--project', project, '--model', 'gpt-9'], {
        out: io.out,
        err: io.err,
      }),
    ).toBe(2);
    expect(io.stderr).toContain('unknown model');

    const { calls, runner } = recordingSession();
    await runFix(['--root', pipelineRoot, '--project', project, '--model', 'claude-opus-5'], {
      session: runner,
      out: () => {},
      err: () => {},
    });
    expect(calls[0]!.argv[calls[0]!.argv.indexOf('--model') + 1]).toBe('claude-opus-5');
  });

  test('a folder with no manifest is refused (after containment, before the spawn)', async () => {
    const project = tempDir();
    const empty = join(project, '.pipeline', 'empty');
    mkdirSync(empty, { recursive: true });
    const { calls, runner } = recordingSession();
    const io = sinks();
    const code = await runFix(['--root', empty, '--project', project], {
      session: runner,
      out: io.out,
      err: io.err,
    });
    expect(code).toBe(2);
    expect(calls.length).toBe(0);
    expect(io.stderr).toContain('not a pipeline folder');
  });
});
