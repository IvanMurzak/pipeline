// sdk-seams.test.ts — the improver and script-creator `standalone` runners (c4).
//
// c3 proved the step runner. This file proves the OTHER TWO seams, and one
// thing about them that no assertion on the SDK runner itself can establish:
// that selecting the SDK executor does not leave `claude -p` running the
// self-improvement half of the run.
//
// ── THE LOAD-BEARING SUITE IS "no subprocess is spawned" ──────────────────
//
// It is load-bearing because the failure is INVISIBLE. A run whose steps go
// through the SDK and whose improver silently falls back to `claude -p` still
// completes, still writes a well-formed improver record, still emits the right
// events and still prints a terminal JSON nobody would question. The only
// symptom is that a mode whose premise is "no CLI binary needed" quietly needs
// one — discovered later, on a machine that does not have it.
//
// So this file proves the NEGATIVE, twice, two independent ways:
//
//   1. STATICALLY — walk the runtime module closure of
//      `src/lib/executors/sdk-seams.ts` (value imports only; `import type`
//      edges are erased and are not part of what executes) and assert nothing
//      in it imports `node:child_process` or calls a process-spawning API at
//      all. A seam that cannot reach `spawn` cannot fall back to one.
//
//   2. BEHAVIOURALLY, WITH A POSITIVE CONTROL — arm a real tripwire: point
//      PIPELINE_DRIVE_EXECUTOR_CMD / _IMPROVER_CMD / _SCRIPT_CREATOR_CMD at a
//      script that records every invocation, then drive a whole two-step run
//      that fires a Tier-1 improver AND a script-creator. With the seams
//      wired, the tripwire is never touched.
//
//      A never-touched tripwire proves nothing unless it is touchable, so the
//      control test reproduces the exact bug — wire ONLY `DriveDeps.executor`,
//      the omission this task exists to prevent — and shows the tripwire fires,
//      the record still comes back well-formed, and the run still reports
//      success. That is the "invisible" claim above, demonstrated rather than
//      asserted.

import { describe, expect, test, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  SDK_IMPROVER_AGENT,
  SDK_SCRIPT_CREATOR_AGENT,
  SDK_SELF_IMPROVE_PERMISSION_MODE,
  SDK_STEP_AGENT,
  TEMPLATE_OVERRIDE_ENV,
  sdkDriveSeams,
  sdkSeamOverrideWarnings,
} from '../src/lib/executors/sdk-seams';
import type { SdkMessage, SdkOptions, SdkQuery } from '../src/lib/executors/sdk';
import {
  DEFAULT_EXECUTOR_TEMPLATE,
  DEFAULT_IMPROVER_TEMPLATE,
  DEFAULT_SCRIPT_CREATOR_TEMPLATE,
  runDrive,
  type DriveDeps,
  type ExecutorRequest,
} from '../src/commands/drive';
import { IMPROVER_RECORD_SCHEMA, SCRIPT_CREATOR_RECORD_SCHEMA, improverSchemaJson, scriptCreatorSchemaJson } from '../src/lib/improver-schema';
import { STEP_RECORD_SCHEMA } from '../src/lib/step-schema';
import { computePlan } from '../src/lib/plan';

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
}, 30000);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function request(over: Partial<ExecutorRequest> = {}): ExecutorRequest {
  return {
    step_id: 'improver-1',
    kind: 'improver',
    prompt: 'improve the thing',
    model: null,
    effort: null,
    record_file: join(tmpdir(), 'pipeline-run', 'records', 'improver-1.json'),
    session: { id: '6f1f9c1e-0000-4000-8000-000000000001', resume: false },
    permission_mode: null,
    ...over,
  };
}

function resultFrame(structured: unknown): SdkMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 2,
    result: JSON.stringify(structured),
    session_id: 'sess-1',
    total_cost_usd: 0.01,
    usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
    permission_denials: [],
    structured_output: structured,
  };
}

function assistantFrame(name: string): SdkMessage {
  return {
    type: 'assistant',
    parent_tool_use_id: null,
    message: {
      role: 'assistant',
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: 'tool_use', id: `toolu_${name}`, name, input: {} }],
    },
  };
}

interface SeenCall {
  prompt: string;
  options: SdkOptions;
}

/** A fake `query` that records every call and yields one tool call + a
 *  terminal result whose structured output is chosen by the caller from the
 *  agent that was requested. */
function recordingQuery(structuredFor: (o: SdkOptions, prompt: string) => unknown): {
  query: SdkQuery;
  calls: SeenCall[];
} {
  const calls: SeenCall[] = [];
  const query: SdkQuery = ({ prompt, options }) => {
    calls.push({ prompt, options: options ?? {} });
    const structured = structuredFor(options ?? {}, prompt);
    return (async function* () {
      yield assistantFrame('Read');
      yield resultFrame(structured);
    })();
  };
  return { query, calls };
}

/** The single `--agent <value>` a command template carries. */
function agentOf(template: string): string {
  const parts = template.split(/\s+/);
  return parts[parts.indexOf('--agent') + 1];
}

/** The literal `--permission-mode <value>` a template carries, or null when it
 *  spells the `{permissions}` token (i.e. takes it from the request). */
function permissionModeOf(template: string): string | null {
  const parts = template.split(/\s+/);
  const v = parts[parts.indexOf('--permission-mode') + 1];
  return v === undefined || v.includes('{') ? null : v;
}

// ---------------------------------------------------------------------------
// DoD 1 — the seams resolve to SDK-backed runners, sharing c3's implementation
// ---------------------------------------------------------------------------

describe('all three seams come out of one call, so one cannot be forgotten', () => {
  test('sdkDriveSeams returns exactly the three DriveDeps runner members', () => {
    const seams = sdkDriveSeams();
    expect(Object.keys(seams).sort()).toEqual(['executor', 'improver', 'scriptCreator']);
    for (const runner of Object.values(seams)) expect(typeof runner).toBe('function');
    // The type-level half of the same guarantee: the object is assignable
    // straight into DriveDeps, so wiring is a spread and not a checklist.
    const deps: DriveDeps = { ...seams };
    expect(deps.improver).toBe(seams.improver);
    expect(deps.scriptCreator).toBe(seams.scriptCreator);
  });

  test('the two self-improvement seams share c3’s transport — same options, bar their row of the table', async () => {
    const { query, calls } = recordingQuery(() => ({ applied: true, script_creation_briefs: [] }));
    const seams = sdkDriveSeams({ query, cwd: '/work', maxTurns: 12, settingSources: ['project'] });

    await seams.improver(request({ kind: 'improver' }));
    await seams.scriptCreator(request({ kind: 'script-creator', step_id: 'script-1' }));

    expect(calls).toHaveLength(2);
    const [improver, scriptCreator] = calls.map((c) => c.options);
    // Everything that is NOT per-seam is byte-identical, which is what "reuse
    // c3's runner" has to mean in practice.
    for (const o of [improver, scriptCreator]) {
      expect(o.cwd).toBe('/work');
      expect(o.maxTurns).toBe(12);
      expect(o.settingSources).toEqual(['project']);
      expect(o.allowedTools).toContain('Agent');
      expect(o.sessionId).toBe('6f1f9c1e-0000-4000-8000-000000000001');
    }
    // …and the only differences are the three the table declares.
    expect(improver.agent).toBe(SDK_IMPROVER_AGENT);
    expect(scriptCreator.agent).toBe(SDK_SCRIPT_CREATOR_AGENT);
    expect(improver.outputFormat).not.toEqual(scriptCreator.outputFormat!);
  });

  test('the agents and the permission mode still match the CLI templates they mirror', () => {
    // The constants are declared in sdk-seams.ts rather than imported from
    // drive.ts (a value import would close a runtime cycle once c5 wires the
    // selection). This is the drift tripwire that makes that safe: change a
    // template's --agent and this fails, naming the file to update.
    expect(agentOf(DEFAULT_EXECUTOR_TEMPLATE)).toBe(SDK_STEP_AGENT);
    expect(agentOf(DEFAULT_IMPROVER_TEMPLATE)).toBe(SDK_IMPROVER_AGENT);
    expect(agentOf(DEFAULT_SCRIPT_CREATOR_TEMPLATE)).toBe(SDK_SCRIPT_CREATOR_AGENT);

    // Both self-improvement templates hardcode the mode; the step template
    // spells {permissions} and takes it from the request.
    expect(permissionModeOf(DEFAULT_IMPROVER_TEMPLATE)).toBe(SDK_SELF_IMPROVE_PERMISSION_MODE);
    expect(permissionModeOf(DEFAULT_SCRIPT_CREATOR_TEMPLATE)).toBe(SDK_SELF_IMPROVE_PERMISSION_MODE);
    expect(permissionModeOf(DEFAULT_EXECUTOR_TEMPLATE)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DoD 2 — the schemas bind through structured outputs, same shape as the CLI
// ---------------------------------------------------------------------------

describe('the improver and script-creator schemas bind through structured outputs', () => {
  test('each seam binds ITS OWN schema as outputFormat json_schema', async () => {
    const { query, calls } = recordingQuery(() => ({ applied: true, script_creation_briefs: [] }));
    const seams = sdkDriveSeams({ query });

    await seams.executor(request({ kind: 'step', step_id: 'build' }));
    await seams.improver(request());
    await seams.scriptCreator(request({ kind: 'script-creator' }));

    expect(calls[0].options.outputFormat).toEqual({ type: 'json_schema', schema: STEP_RECORD_SCHEMA as unknown as Record<string, unknown> });
    expect(calls[1].options.outputFormat).toEqual({ type: 'json_schema', schema: IMPROVER_RECORD_SCHEMA as unknown as Record<string, unknown> });
    expect(calls[2].options.outputFormat).toEqual({
      type: 'json_schema',
      schema: SCRIPT_CREATOR_RECORD_SCHEMA as unknown as Record<string, unknown>,
    });
  });

  test('it is the SAME schema the CLI executor passes as --json-schema, not a parallel copy', async () => {
    // "Identical in shape to the subprocess path" starts here: one source of
    // truth, two serialisations. If lib/improver-schema.ts ever grew an
    // SDK-specific variant, this is what would catch it.
    const { query, calls } = recordingQuery(() => ({ applied: true, script_creation_briefs: [] }));
    const seams = sdkDriveSeams({ query });
    await seams.improver(request());
    await seams.scriptCreator(request({ kind: 'script-creator' }));

    expect(calls[0].options.outputFormat!.schema).toEqual(JSON.parse(improverSchemaJson()) as Record<string, unknown>);
    expect(calls[1].options.outputFormat!.schema).toEqual(JSON.parse(scriptCreatorSchemaJson()) as Record<string, unknown>);
  });

  test('a caller cannot cross the wires: schema and agent are not settable per seam', async () => {
    // SdkSeamOptions omits `schema`, `agent` and `permissionMode` at the type
    // level. This is the runtime half — whatever an untyped caller passes, the
    // seams keep their own. Handing the improver the STEP schema would produce
    // records of the wrong shape, and drive would parse them defensively into
    // `applied: false` rather than report anything, so the failure would be a
    // permanently unhelpful improver rather than an error.
    const { query, calls } = recordingQuery(() => ({ applied: true, script_creation_briefs: [] }));
    const loose = {
      query,
      schema: STEP_RECORD_SCHEMA,
      agent: SDK_STEP_AGENT,
      permissionMode: 'bypassPermissions',
    } as unknown as Parameters<typeof sdkDriveSeams>[0];

    await sdkDriveSeams(loose).improver(request());

    expect(calls[0].options.agent).toBe(SDK_IMPROVER_AGENT);
    expect(calls[0].options.outputFormat!.schema).toEqual(IMPROVER_RECORD_SCHEMA as unknown as Record<string, unknown>);
    expect(calls[0].options.permissionMode).toBe(SDK_SELF_IMPROVE_PERMISSION_MODE);
  });
});

// ---------------------------------------------------------------------------
// DoD 3 — `kind` discrimination survives unchanged
// ---------------------------------------------------------------------------

describe('kind discrimination is preserved', () => {
  test('the request each seam receives keeps its kind, and the progress hook sees it', async () => {
    const seen: Array<{ kind: string | undefined; step: string }> = [];
    const { query } = recordingQuery(() => ({ applied: true, script_creation_briefs: [] }));
    const seams = sdkDriveSeams({ query, onToolCall: (req) => seen.push({ kind: req.kind, step: req.step_id }) });

    await seams.executor(request({ kind: 'step', step_id: 'build' }));
    await seams.improver(request({ kind: 'improver', step_id: 'improver-1' }));
    await seams.scriptCreator(request({ kind: 'script-creator', step_id: 'script-1' }));

    expect(seen).toEqual([
      { kind: 'step', step: 'build' },
      { kind: 'improver', step: 'improver-1' },
      { kind: 'script-creator', step: 'script-1' },
    ]);
  });

  test('kind still governs the record-directory grant, exactly as it does for the CLI runner', async () => {
    const { query, calls } = recordingQuery(() => ({ applied: true, script_creation_briefs: [] }));
    const seams = sdkDriveSeams({ query });

    await seams.executor(request({ kind: 'step', step_id: 'build' }));
    await seams.improver(request({ kind: 'improver' }));
    await seams.scriptCreator(request({ kind: 'script-creator' }));

    // A step's executor writes its own record into the granted drop dir; the
    // improver/script-creator record files are drive's own writes, so those
    // sessions get no grant — the same asymmetry subprocessExecutor applies.
    expect(calls[0].options.additionalDirectories).toEqual([dirname(request().record_file)]);
    expect('additionalDirectories' in calls[1].options).toBe(false);
    expect('additionalDirectories' in calls[2].options).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The permission mode the templates hardcoded
// ---------------------------------------------------------------------------

describe('the hardcoded acceptEdits of both self-improvement templates survives the port', () => {
  test('a null request permission_mode falls back to acceptEdits for the two self-improvement seams', async () => {
    const { query, calls } = recordingQuery(() => ({ applied: true, script_creation_briefs: [] }));
    const seams = sdkDriveSeams({ query });
    // This is the request runSelfImproveSession actually builds.
    await seams.improver(request({ permission_mode: null }));
    await seams.scriptCreator(request({ kind: 'script-creator', permission_mode: null }));
    expect(calls[0].options.permissionMode).toBe('acceptEdits');
    expect(calls[1].options.permissionMode).toBe('acceptEdits');
  });

  test('the step seam keeps null meaning "inherit machine settings" — no fallback invented', async () => {
    const { query, calls } = recordingQuery(() => ({ outcome: 'completed' }));
    const seams = sdkDriveSeams({ query });
    await seams.executor(request({ kind: 'step', permission_mode: null }));
    expect('permissionMode' in calls[0].options).toBe(false);
  });

  test('a request that DOES carry a mode wins over the fallback', async () => {
    const { query, calls } = recordingQuery(() => ({ applied: true, script_creation_briefs: [] }));
    const seams = sdkDriveSeams({ query });
    await seams.improver(request({ permission_mode: 'plan' }));
    expect(calls[0].options.permissionMode).toBe('plan');
  });
});

// ---------------------------------------------------------------------------
// Plugins — the {plugin_dir} token's SDK equivalent
// ---------------------------------------------------------------------------

describe('the plugin root reaches the SDK, because there is no auto-discovery', () => {
  test('pluginDir becomes a local plugin config on every seam', async () => {
    const { query, calls } = recordingQuery(() => ({ applied: true, script_creation_briefs: [] }));
    const seams = sdkDriveSeams({ query, pluginDir: '/opt/plugins/pipeline' });
    await seams.executor(request({ kind: 'step' }));
    await seams.improver(request());
    await seams.scriptCreator(request({ kind: 'script-creator' }));
    for (const c of calls) expect(c.options.plugins).toEqual([{ type: 'local', path: '/opt/plugins/pipeline' }]);
  });

  test('blank or absent ⇒ the key is dropped, mirroring buildExecutorArgv dropping the flag pair', async () => {
    const { query, calls } = recordingQuery(() => ({ applied: true, script_creation_briefs: [] }));
    await sdkDriveSeams({ query, pluginDir: '   ' }).improver(request());
    await sdkDriveSeams({ query, pluginDir: null }).improver(request());
    for (const c of calls) expect('plugins' in c.options).toBe(false);
  });

  test('an explicit plugins array wins over the convenience path', async () => {
    const { query, calls } = recordingQuery(() => ({ applied: true, script_creation_briefs: [] }));
    await sdkDriveSeams({
      query,
      pluginDir: '/ignored',
      plugins: [{ type: 'local', path: '/explicit' }],
    }).improver(request());
    expect(calls[0].options.plugins).toEqual([{ type: 'local', path: '/explicit' }]);
  });
});

// ---------------------------------------------------------------------------
// DoD 5 — template environment overrides are REPORTED, never silently dropped
// ---------------------------------------------------------------------------

describe('command-template environment overrides do not apply, and the run says so', () => {
  test('nothing set ⇒ no report at all', () => {
    expect(sdkSeamOverrideWarnings({})).toEqual([]);
    // A variable set to whitespace is not a template.
    expect(sdkSeamOverrideWarnings({ PIPELINE_DRIVE_IMPROVER_CMD: '  ' })).toEqual([]);
  });

  test('each override that IS set produces one line naming it, why, what runs instead, and the way back', () => {
    for (const { variable, seam, agent } of TEMPLATE_OVERRIDE_ENV) {
      const lines = sdkSeamOverrideWarnings({ [variable]: 'claude -p --agent whatever' });
      expect(lines).toHaveLength(1);
      // Named — a user grepping their own variable finds the line.
      expect(lines[0]).toContain(variable);
      // Did not apply, and why.
      expect(lines[0]).toContain('does NOT apply');
      expect(lines[0]).toContain('spawns no command');
      // What runs instead…
      expect(lines[0]).toContain(seam);
      expect(lines[0]).toContain(agent);
      // …and how to get the old behaviour back.
      expect(lines[0]).toContain('CLI executor');
    }
  });

  test('all three set ⇒ three lines, in template order', () => {
    const lines = sdkSeamOverrideWarnings({
      PIPELINE_DRIVE_EXECUTOR_CMD: 'a',
      PIPELINE_DRIVE_IMPROVER_CMD: 'b',
      PIPELINE_DRIVE_SCRIPT_CREATOR_CMD: 'c',
    });
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => TEMPLATE_OVERRIDE_ENV.findIndex((e) => l.includes(e.variable)))).toEqual([0, 1, 2]);
  });

  test('the report reaches the run’s stderr sink ONCE per seam-set, not once per spawn', async () => {
    const prev = process.env.PIPELINE_DRIVE_IMPROVER_CMD;
    process.env.PIPELINE_DRIVE_IMPROVER_CMD = 'claude -p --agent mine';
    try {
      let errBuf = '';
      const { query } = recordingQuery(() => ({ applied: true, script_creation_briefs: [] }));
      const seams = sdkDriveSeams({ query, err: (s) => (errBuf += s) });
      const before = errBuf;
      await seams.improver(request());
      await seams.improver(request());
      // Emitted at construction…
      expect(before).toContain('PIPELINE_DRIVE_IMPROVER_CMD');
      // …and not once per spawn: an eleven-improver run prints it once.
      expect(errBuf).toBe(before);
      expect(errBuf.split('PIPELINE_DRIVE_IMPROVER_CMD')).toHaveLength(2);
    } finally {
      if (prev === undefined) delete process.env.PIPELINE_DRIVE_IMPROVER_CMD;
      else process.env.PIPELINE_DRIVE_IMPROVER_CMD = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// DoD 4a — the STATIC proof: these seams cannot reach a spawn at all
// ---------------------------------------------------------------------------

const REPO = join(import.meta.dir, '..');

/** Every `.ts` module reachable from `entry` through RUNTIME (value) relative
 *  imports. `import type` edges are deliberately NOT followed: they are erased
 *  before execution, so following them would drag in `commands/drive.ts` —
 *  which does spawn, legitimately, for the CLI executor — and make this
 *  assertion vacuous in the other direction. */
function runtimeClosure(entry: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (abs: string): void => {
    const key = relative(REPO, abs).split(sep).join('/');
    if (out.has(key)) return;
    const text = readFileSync(abs, 'utf-8');
    out.set(key, text);
    for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)\s+(type\s+)?[^;]*?from\s+'(\.[^']+)'/g)) {
      if (m[1]) continue; // `import type …` — erased, not executed
      const p = resolve(dirname(abs), m[2]);
      for (const cand of [p, `${p}.ts`, join(p, 'index.ts')]) {
        if (cand.endsWith('.ts') && existsSync(cand)) {
          walk(cand);
          break;
        }
      }
    }
  };
  walk(entry);
  return out;
}

describe('no claude -p subprocess is spawned — the structural proof', () => {
  const closure = () => runtimeClosure(join(REPO, 'src', 'lib', 'executors', 'sdk-seams.ts'));

  test('the walk is real (guard against a vacuous suite)', () => {
    const c = closure();
    expect(c.size).toBeGreaterThan(3);
    expect([...c.keys()]).toContain('src/lib/executors/sdk-seams.ts');
    // It must reach c3's runner — that IS the reuse this task requires.
    expect([...c.keys()]).toContain('src/lib/executors/sdk.ts');
    // And it must NOT reach drive.ts, whose type-only edge is erased. If it
    // did, every assertion below would be about drive's spawn, not ours.
    expect([...c.keys()]).not.toContain('src/commands/drive.ts');
  });

  test('nothing reachable at runtime imports a process-spawning module', () => {
    const offenders: string[] = [];
    for (const [file, text] of closure()) {
      if (/from\s+'(?:node:)?child_process'/.test(text)) offenders.push(`${file}: imports child_process`);
      if (/require\(\s*'(?:node:)?child_process'\s*\)/.test(text)) offenders.push(`${file}: requires child_process`);
      if (/\bBun\.spawn(?:Sync)?\s*\(/.test(text)) offenders.push(`${file}: calls Bun.spawn`);
    }
    expect(offenders).toEqual([]);
  });

  test('nothing reachable at runtime calls spawn/exec/execFile/fork', () => {
    const offenders: string[] = [];
    for (const [file, text] of closure()) {
      for (const m of text.matchAll(/(?<![\w.$])(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/g)) {
        offenders.push(`${file}: ${m[1]}(`);
      }
    }
    // A seam that cannot reach `spawn` cannot silently fall back to one, for
    // ANY input — which is a stronger statement than any single run can make.
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// DoD 4b — the BEHAVIOURAL proof, with a positive control
// ---------------------------------------------------------------------------

/** A stand-in for `claude`: records that it was spawned at all, then returns a
 *  perfectly well-formed improver envelope. Returning garbage would make the
 *  control test pass for the wrong reason — the point is that a fallback
 *  SUCCEEDS and is therefore invisible without the tripwire. */
const TRIPWIRE = `// spawn tripwire — if this ever runs, a subprocess was spawned.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
const prompt = await Bun.stdin.text();
appendFileSync(
  join(import.meta.dir, 'tripwire.log'),
  JSON.stringify({ argv: process.argv.slice(2), head: prompt.slice(0, 120) }) + '\\n',
  'utf8',
);
process.stdout.write(
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 1,
    result: '{"applied":true,"script_creation_briefs":[]}',
    session_id: 'sess-tripwire',
    total_cost_usd: 0.001,
    usage: { input_tokens: 1, output_tokens: 1 },
    structured_output: { applied: true, script_creation_briefs: [], summary: 'from a claude -p SUBPROCESS' },
  }),
);
process.exit(0);
`;

function scaffold(): { root: string; tripwireLog: string } {
  const root = mkdtempSync(join(tmpdir(), 'sdk-seams-'));
  created.push(root);
  writeFileSync(join(root, 'PIPELINE.md'), '# P\n\n## End State\ndone\n');
  mkdirSync(join(root, 'steps'), { recursive: true });
  writeFileSync(join(root, 'steps', '01-first.md'), '# step 1\n');
  writeFileSync(join(root, 'steps', '02-second.md'), '# step 2\n');
  writeFileSync(join(root, 'tripwire.ts'), TRIPWIRE, 'utf8');
  return { root, tripwireLog: join(root, 'tripwire.log') };
}

function tripwireHits(log: string): Array<{ argv: string[]; head: string }> {
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { argv: string[]; head: string });
}

const ENV_KEYS = [
  'PIPELINE_DRIVE_SELF_IMPROVE',
  'PIPELINE_DRIVE_EXECUTOR_CMD',
  'PIPELINE_DRIVE_IMPROVER_CMD',
  'PIPELINE_DRIVE_SCRIPT_CREATOR_CMD',
  'PIPELINE_RUN_ID',
  'PIPELINE_PARENT_RUN_ID',
  'PIPELINE_SYNC_LOCAL_STATS',
  'CLAUDE_SESSION_ID',
  'CLAUDE_PLUGIN_ROOT',
  'HOME',
  'USERPROFILE',
] as const;

/**
 * Run `pipeline drive` in-process with the tripwire ARMED on all three command
 * templates, cwd/home sandboxed, and `deps` injected verbatim.
 *
 * Arming all three matters: the tripwire is what makes "no subprocess" a
 * measurement instead of an assumption, and it is armed identically for the
 * proof and for the control so the only variable between them is which seams
 * were wired.
 */
async function drive(root: string, runId: string, makeDeps: () => DriveDeps) {
  const plan = computePlan(root);
  const saved = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));
  const prevCwd = process.cwd();
  const tripwire = `bun ${join(root, 'tripwire.ts')}`;
  let outBuf = '';
  let errBuf = '';
  process.env.PIPELINE_DRIVE_SELF_IMPROVE = '1';
  process.env.PIPELINE_DRIVE_EXECUTOR_CMD = tripwire;
  process.env.PIPELINE_DRIVE_IMPROVER_CMD = tripwire;
  process.env.PIPELINE_DRIVE_SCRIPT_CREATOR_CMD = tripwire;
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  for (const k of ['PIPELINE_RUN_ID', 'PIPELINE_PARENT_RUN_ID', 'PIPELINE_SYNC_LOCAL_STATS', 'CLAUDE_SESSION_ID', 'CLAUDE_PLUGIN_ROOT']) {
    delete process.env[k];
  }
  process.chdir(root);
  try {
    // The deps are built INSIDE the env window on purpose: `sdkDriveSeams`
    // reads the command-template overrides at construction, which is exactly
    // where c5's selection will build them too.
    const code = await runDrive(['--root', root, '--run-id', runId, '--start', plan.steps[0].path], {
      ...makeDeps(),
      out: (s) => (outBuf += s),
      err: (s) => (errBuf += s),
    });
    let json: Record<string, unknown> | null = null;
    try {
      json = JSON.parse(outBuf) as Record<string, unknown>;
    } catch {
      /* error paths have empty stdout */
    }
    return { code, json, stderr: errBuf };
  } finally {
    process.chdir(prevCwd);
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const BRIEF = 'IMPROVEMENT BRIEF: step 1 pointed at the wrong linter; use eslint.';
const EXTRACTION = 'EXTRACT-A: pull the build block into a script';

/** The whole SDK, faked: one `query` serving all three seams, dispatching on
 *  the agent each seam asked for — which is itself the assertion that the
 *  seams are distinct. Step 1 reports an improvement brief (which is what
 *  makes the engine emit `run-improver`), the improver returns one extraction
 *  brief (which is what makes it emit `run-script-creator`), so a single run
 *  exercises both seams this task delivers. */
function sdkFake(root: string) {
  const plan = computePlan(root);
  const byAgent: Record<string, number> = {};
  const { query, calls } = recordingQuery((options, prompt) => {
    byAgent[String(options.agent)] = (byAgent[String(options.agent)] ?? 0) + 1;
    if (options.agent === SDK_IMPROVER_AGENT) {
      return { applied: true, script_creation_briefs: [EXTRACTION], summary: 'fixed the linter reference' };
    }
    if (options.agent === SDK_SCRIPT_CREATOR_AGENT) {
      return { outcome: 'created', script_path: join(root, 'scripts', 'build.py'), summary: 'extracted build.py' };
    }
    const m = /^step_record_file = (.+)$/m.exec(prompt);
    const stepId = m ? m[1].trim().replace(/\\/g, '/').split('/').pop()!.replace(/\.json$/, '') : '';
    return stepId === plan.steps[0].step_id
      ? {
          outcome: 'completed',
          next_iteration: plan.steps[1].path,
          has_improvement_brief: true,
          improvement_brief: BRIEF,
        }
      : { outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' };
  });
  return { query, calls, byAgent };
}

describe('no claude -p subprocess is spawned — the behavioural proof', () => {
  test('a full run with a Tier-1 improver AND a script-creator never touches the armed tripwire', async () => {
    const { root, tripwireLog } = scaffold();
    const fake = sdkFake(root);
    const kinds: string[] = [];

    const r = await drive(root, 'sdkseams', () => ({
      ...sdkDriveSeams({ query: fake.query, onToolCall: (req) => kinds.push(req.kind ?? 'step') }),
    }));

    // The run really did everything: two steps, one improver, one script-creator.
    expect(r.code).toBe(0);
    expect(r.json?.status).toBe('completed');
    expect(fake.byAgent[SDK_STEP_AGENT]).toBe(2);
    expect(fake.byAgent[SDK_IMPROVER_AGENT]).toBe(1);
    expect(fake.byAgent[SDK_SCRIPT_CREATOR_AGENT]).toBe(1);
    // …and drive's own requests carried the discriminated kinds end to end.
    expect(kinds.filter((k) => k === 'step')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'improver')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'script-creator')).toHaveLength(1);
    // The script-creator is driven BY the improver's briefs, so it follows it.
    expect(kinds.indexOf('improver')).toBeLessThan(kinds.indexOf('script-creator'));

    // ── THE ASSERTION THIS TASK EXISTS FOR ──────────────────────────────
    // Every one of the three `claude -p` command templates pointed at the
    // tripwire for the whole run. It was never executed.
    expect(tripwireHits(tripwireLog)).toEqual([]);
    expect(existsSync(tripwireLog)).toBe(false);
  }, 60000);

  test('records come back identical in shape to the subprocess path', async () => {
    const { root } = scaffold();
    const fake = sdkFake(root);
    const run = 'sdkseamsrec';
    const r = await drive(root, run, () => ({ ...sdkDriveSeams({ query: fake.query }) }));
    expect(r.code).toBe(0);

    // The improver observability copy drive persists — the same file, with the
    // same fields, that tests/drive-self-improve.test.ts asserts for `claude -p`.
    const rec = JSON.parse(readFileSync(join(root, '.runtime', run, 'records', 'improver-1.json'), 'utf8')) as Record<string, unknown>;
    expect(rec).toEqual({
      applied: true,
      script_creation_briefs: [EXTRACTION],
      summary: 'fixed the linter reference',
    });

    // The script-creator's outcome is recorded VERBATIM, never re-mapped.
    const scriptRec = JSON.parse(readFileSync(join(root, '.runtime', run, 'records', 'script-1.json'), 'utf8')) as Record<string, unknown>;
    expect(scriptRec.outcome).toBe('created');
    expect(scriptRec.script_path).toBe(join(root, 'scripts', 'build.py'));

    // Sessions were pinned and closed, like every other self-improve session.
    for (const key of ['improver-1', 'script-1']) {
      const sess = JSON.parse(readFileSync(join(root, '.runtime', run, 'sessions', `${key}.json`), 'utf8')) as Record<string, unknown>;
      expect(sess.status).toBe('done');
      expect(sess.crashes).toBe(0);
    }

    // And the run reports the improvements, so the terminal JSON is the same
    // shape a `driver` run produces.
    expect(r.json?.improvements_applied).toBe(true);
  }, 60000);

  test('the inapplicable-override report is emitted during a real run, once per variable', async () => {
    const { root } = scaffold();
    const fake = sdkFake(root);
    // `drive()` arms all three command-template overrides, so a run whose
    // seams are SDK-backed must report all three as inapplicable — DoD 5
    // observed through the actual command rather than through a unit call.
    let seamErr = '';
    const r = await drive(root, 'sdkseamswarn', () => ({
      ...sdkDriveSeams({ query: fake.query, err: (s) => (seamErr += s) }),
    }));

    expect(r.code).toBe(0);
    for (const { variable } of TEMPLATE_OVERRIDE_ENV) {
      expect(seamErr).toContain(variable);
      // Once — not once per spawn, and this run made four spawn-equivalents.
      expect(seamErr.split(variable)).toHaveLength(2);
    }
    expect(seamErr).toContain('does NOT apply');
  }, 60000);

  // ── THE POSITIVE CONTROL ────────────────────────────────────────────────
  test('CONTROL: wiring ONLY DriveDeps.executor reproduces the bug — the tripwire fires, and nothing else looks wrong', async () => {
    const { root, tripwireLog } = scaffold();
    const fake = sdkFake(root);

    // The exact omission this task prevents: steps go through the SDK, the
    // improver seam is left to its default.
    const r = await drive(root, 'sdkhalf', () => ({ executor: sdkDriveSeams({ query: fake.query }).executor }));

    // The tripwire FIRED: a `claude -p` subprocess ran for the improver.
    const hits = tripwireHits(tripwireLog);
    expect(hits).toHaveLength(1);
    expect(hits[0].argv).toContain('--session-id');

    // …and this is why the failure is invisible. Everything a user or a CI job
    // would look at still says the run was fine:
    expect(r.code).toBe(0);
    expect(r.json?.status).toBe('completed');
    expect(r.json?.improvements_applied).toBe(true);
    const rec = JSON.parse(readFileSync(join(root, '.runtime', 'sdkhalf', 'records', 'improver-1.json'), 'utf8')) as Record<string, unknown>;
    expect(rec.applied).toBe(true);
    // The one giveaway is the summary the SUBPROCESS wrote — which no
    // assertion on the SDK runner would ever have looked at.
    expect(rec.summary).toBe('from a claude -p SUBPROCESS');
    // The SDK improver seam was never called at all.
    expect(fake.byAgent[SDK_IMPROVER_AGENT]).toBeUndefined();
  }, 60000);
});
