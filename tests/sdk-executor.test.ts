// sdk-executor.test.ts — the `standalone` ExecutorRunner (c3).
//
// The SDK is an OPTIONAL peer dependency, so every test here runs with it
// ABSENT: `SdkExecutorOptions.query` is the injection point, and the frames the
// fakes yield are the real `SDKMessage` shapes (an assistant message carries
// `parent_tool_use_id` and a `message.content` block array; the terminal
// `result` is the envelope field-for-field). The one suite that does touch the
// real package is the drift tripwire at the bottom, and it SKIPS itself when
// the package is not installed rather than failing.
//
// The load-bearing tests are the last two:
//
//   - the end-to-end one, which drives the whole `pipeline drive` command with
//     this runner injected and a `success` result carrying NO structured
//     output, and proves the run still completes — i.e. that the recovery
//     ladder genuinely narrowed rather than collapsed;
//   - the intra-step helper one, which proves `Agent` is PRE-APPROVED (not
//     that it exists — a separate option governs that, and this module leaves
//     it at its default; see `PRE_APPROVED_TOOLS`) AND that a helper's nested
//     tool calls are attributed at depth 1.

import { describe, expect, test, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  PRE_APPROVED_TOOLS,
  SDK_EXIT,
  SDK_MODULE_ID,
  VERIFIED_SDK_VERSION,
  asEffortLevel,
  asPermissionMode,
  buildSdkOptions,
  loadSdkQuery,
  sdkExecutor,
  type SdkMessage,
  type SdkOptions,
  type SdkQuery,
} from '../src/lib/executors/sdk';
import { envelopeOf, runDrive, type ExecutorRequest, type ExecutorRunner } from '../src/commands/drive';
import { STEP_RECORD_SCHEMA } from '../src/lib/step-schema';
import { parseResultObject } from '../src/lib/envelope';
import { computePlan } from '../src/lib/plan';

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
}, 30000);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RECORD_DIR = join(tmpdir(), 'pipeline-drop', 'run-1');

function request(over: Partial<ExecutorRequest> = {}): ExecutorRequest {
  return {
    step_id: 'build',
    prompt: 'do the thing',
    model: 'claude-sonnet-4-5-20250929',
    effort: 'high',
    record_file: join(RECORD_DIR, 'build.json'),
    session: { id: '6f1f9c1e-0000-4000-8000-000000000001', resume: false },
    permission_mode: 'acceptEdits',
    ...over,
  };
}

/** A terminal `result` frame — the SDK's `SDKResultSuccess`, verbatim shape. */
function resultFrame(over: Record<string, unknown> = {}): SdkMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 3,
    result: 'all done',
    session_id: 'sess-1',
    total_cost_usd: 0.0125,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 5,
    },
    permission_denials: [],
    structured_output: { outcome: 'completed', summary: 'built' },
    ...over,
  };
}

/** An `assistant` frame carrying tool_use blocks at a given attribution. */
function assistantFrame(
  blocks: Array<{ id: string; name: string }>,
  parent: string | null = null,
): SdkMessage {
  return {
    type: 'assistant',
    parent_tool_use_id: parent,
    message: {
      role: 'assistant',
      usage: { input_tokens: 10, output_tokens: 2 },
      content: blocks.map((b) => ({ type: 'tool_use', id: b.id, name: b.name, input: {} })),
    },
  };
}

/** A fake `query` that yields the given frames and records what it was called
 *  with. `seen.options` is how the option-mapping assertions reach the real
 *  object the runner built. */
function fakeQuery(frames: SdkMessage[]): {
  query: SdkQuery;
  seen: { prompt?: string; options?: SdkOptions; calls: number };
} {
  const seen: { prompt?: string; options?: SdkOptions; calls: number } = { calls: 0 };
  const query: SdkQuery = ({ prompt, options }) => {
    seen.calls += 1;
    seen.prompt = prompt;
    seen.options = options;
    return (async function* () {
      for (const f of frames) yield f;
    })();
  };
  return { query, seen };
}

/** Build the options the runner would pass for `req`. */
function optionsFor(req: ExecutorRequest, opts: Parameters<typeof sdkExecutor>[0] = {}): SdkOptions {
  return buildSdkOptions(req, opts);
}

// ---------------------------------------------------------------------------
// DoD 1 — the exact existing type, unchanged
// ---------------------------------------------------------------------------

describe('it is an ExecutorRunner, and the interface did not change', () => {
  test('the factory produces something assignable to ExecutorRunner', async () => {
    // The assignment itself is the assertion the compiler makes; the call
    // below proves it also BEHAVES like one at runtime.
    const runner: ExecutorRunner = sdkExecutor({ query: fakeQuery([resultFrame()]).query });
    const exit = await runner(request());
    expect(typeof exit.code).toBe('number');
    expect(exit).toHaveProperty('stream');
  });

  test('a runner never throws — a broken query resolves as a spawn-shaped exit', async () => {
    const runner = sdkExecutor({
      query: () => {
        throw new Error('transport exploded');
      },
    });
    const exit = await runner(request());
    // `code: null` keeps its documented meaning: could not be started.
    expect(exit.code).toBeNull();
    expect(exit.error).toContain('transport exploded');
  });

  test('a stream that dies mid-flight keeps the partial summary it had built', async () => {
    const runner = sdkExecutor({
      query: () =>
        (async function* () {
          yield assistantFrame([{ id: 'toolu_a', name: 'Read' }]);
          throw new Error('socket closed');
        })(),
    });
    const exit = await runner(request());
    expect(exit.code).toBeNull();
    expect(exit.error).toContain('socket closed');
    // The ten-minutes-then-lost-transport case: what it did is still reported.
    expect(exit.stream?.tools_called).toBe(1);
    expect(exit.stream?.tool_calls[0].tool).toBe('Read');
  });
});

// ---------------------------------------------------------------------------
// DoD 2 — every ExecutorRequest field is honoured
// ---------------------------------------------------------------------------

describe('every ExecutorRequest field maps onto a real SDK option', () => {
  test('prompt → query({ prompt })', async () => {
    const { query, seen } = fakeQuery([resultFrame()]);
    await sdkExecutor({ query })(request({ prompt: 'THE PROMPT' }));
    expect(seen.calls).toBe(1);
    expect(seen.prompt).toBe('THE PROMPT');
  });

  test('model → Options.model; null inherits (key absent)', () => {
    expect(optionsFor(request({ model: 'claude-opus-4-6' })).model).toBe('claude-opus-4-6');
    expect('model' in optionsFor(request({ model: null }))).toBe(false);
  });

  test('effort → Options.effort, narrowed onto the SDK union', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      expect(optionsFor(request({ effort: level })).effort).toBe(level);
    }
    // null = inherit the session default.
    expect('effort' in optionsFor(request({ effort: null }))).toBe(false);
    // An unrecognised value is DROPPED, not forwarded: Options.effort is a
    // closed union and an invalid value would fail the whole call, turning a
    // bad config value into a dead run.
    expect('effort' in optionsFor(request({ effort: 'turbo' }))).toBe(false);
    expect(asEffortLevel('max')).toBe('max');
    expect(asEffortLevel('turbo')).toBeUndefined();
  });

  test('permission_mode → Options.permissionMode, narrowed onto the SDK union', () => {
    for (const mode of ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'] as const) {
      expect(optionsFor(request({ permission_mode: mode })).permissionMode).toBe(mode);
    }
    expect('permissionMode' in optionsFor(request({ permission_mode: null }))).toBe(false);
    expect('permissionMode' in optionsFor(request({ permission_mode: 'yolo' }))).toBe(false);
    expect(asPermissionMode('plan')).toBe('plan');
    expect(asPermissionMode('yolo')).toBeUndefined();
  });

  test('session → sessionId on a fresh spawn, resume on an answer delivery — NEVER both', () => {
    const id = '6f1f9c1e-0000-4000-8000-00000000000a';
    const fresh = optionsFor(request({ session: { id, resume: false } }));
    expect(fresh.sessionId).toBe(id);
    expect('resume' in fresh).toBe(false);

    const resumed = optionsFor(request({ session: { id, resume: true } }));
    expect(resumed.resume).toBe(id);
    // The SDK rejects sessionId together with resume unless forkSession is
    // set — and forking is exactly what an answer delivery must not do.
    expect('sessionId' in resumed).toBe(false);
  });

  test('record_file → the drop directory as an additionalDirectories grant', () => {
    const req = request({ record_file: join(RECORD_DIR, 'build.json') });
    expect(optionsFor(req).additionalDirectories).toEqual([dirname(req.record_file)]);
  });

  test('the grant is for STEP spawns only, like the CLI executor', () => {
    // drive writes the improver / script-creator record files itself, so those
    // sessions need no grant at all.
    for (const kind of ['improver', 'script-creator'] as const) {
      expect('additionalDirectories' in optionsFor(request({ kind }))).toBe(false);
    }
    expect(optionsFor(request({ kind: 'step' })).additionalDirectories).toHaveLength(1);
  });

  test("caller grants are kept, and the drop dir is not duplicated", () => {
    const req = request();
    const dir = dirname(req.record_file);
    expect(optionsFor(req, { additionalDirectories: ['/extra'] }).additionalDirectories).toEqual([dir, '/extra']);
    expect(optionsFor(req, { additionalDirectories: [dir] }).additionalDirectories).toEqual([dir]);
  });

  test('the step schema → outputFormat json_schema, which is what produces structured_output', () => {
    const withSchema = optionsFor(request(), { schema: STEP_RECORD_SCHEMA as Record<string, unknown> });
    expect(withSchema.outputFormat).toEqual({
      type: 'json_schema',
      schema: STEP_RECORD_SCHEMA as Record<string, unknown>,
    });
    expect('outputFormat' in optionsFor(request())).toBe(false);
  });

  test('step_id reaches the progress hook, which is the only thing that consumes it', async () => {
    const seen: Array<{ step: string; tool: string }> = [];
    const { query } = fakeQuery([assistantFrame([{ id: 'toolu_r', name: 'Read' }]), resultFrame()]);
    await sdkExecutor({
      query,
      onToolCall: (req, call) => seen.push({ step: req.step_id, tool: call.tool }),
    })(request({ step_id: 'compile' }));
    expect(seen).toEqual([{ step: 'compile', tool: 'Read' }]);
  });

  test('the remaining option seams are reachable: agent, plugins, cwd, env, maxTurns', () => {
    const o = optionsFor(request(), {
      agent: 'pipeline:step-executor',
      plugins: [{ type: 'local', path: '/plugins/pipeline' }],
      cwd: '/work',
      env: { SOME_OPAQUE_OVERLAY: 'value' },
      maxTurns: 40,
    });
    expect(o.agent).toBe('pipeline:step-executor');
    expect(o.plugins).toEqual([{ type: 'local', path: '/plugins/pipeline' }]);
    expect(o.cwd).toBe('/work');
    expect(o.env).toEqual({ SOME_OPAQUE_OVERLAY: 'value' });
    expect(o.maxTurns).toBe(40);
    // Plugins load through the option — there is no auto-discovery to lean on.
    expect('plugins' in optionsFor(request())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DoD 5 — settingSources is caller-settable and defaults to OMITTED
// ---------------------------------------------------------------------------

describe('E9 — configuration is set by location, and the local default is the user’s own', () => {
  test('unset ⇒ the key is ABSENT, so the SDK loads every tier (full user configuration)', () => {
    const o = optionsFor(request());
    // Not `settingSources: undefined` — absent. The SDK's documented default
    // for an omitted key is "all sources", which is what keeps a local user's
    // agents, skills, MCP servers and memory working.
    expect('settingSources' in o).toBe(false);
    expect(Object.keys(o)).not.toContain('settingSources');
    expect(JSON.stringify(o)).not.toContain('settingSources');
  });

  test('a caller can pin it — the hosted runner’s [\'project\'] is just a value', () => {
    expect(optionsFor(request(), { settingSources: ['project'] }).settingSources).toEqual(['project']);
    expect(optionsFor(request(), { settingSources: [] }).settingSources).toEqual([]);
    expect(optionsFor(request(), { settingSources: ['user', 'project', 'local'] }).settingSources).toEqual([
      'user',
      'project',
      'local',
    ]);
  });

  test('nothing hardcodes a tier: the module names no default location', () => {
    // The pinning is f1's job. This runner must make the setting reachable
    // without choosing for the hosted case OR against the local one.
    const o = optionsFor(request(), { settingSources: ['project'] });
    o.settingSources!.push('user');
    // The caller's array was COPIED, so a later mutation cannot reach back.
    expect(optionsFor(request(), { settingSources: ['project'] }).settingSources).toEqual(['project']);
  });
});

// ---------------------------------------------------------------------------
// DoD 6 — the Agent tool: pre-approval, and the lever that is NOT this one
//
// These tests used to be framed as "allowedTools includes Agent, therefore
// intra-step helpers can exist". The premise was false, and the assertions
// passed anyway because they only ever checked the option that is not the one
// in question. Measured against a real @anthropic-ai/claude-agent-sdk@0.3.228:
// `allowedTools` is a permission pre-approval list with NO effect on which
// tools exist, and `tools` — which this module deliberately never sets — is
// what governs existence. So the suite now asserts two separable things:
// that the pre-approval is set, and that the existence lever is left alone.
// ---------------------------------------------------------------------------

describe('the Agent tool is PRE-APPROVED, which is not the same as made to exist', () => {
  test('allowedTools always contains Agent', () => {
    expect(optionsFor(request()).allowedTools).toContain('Agent');
    expect(PRE_APPROVED_TOOLS).toContain('Agent');
  });

  test('caller tools are ADDED to it, never substituted for it', () => {
    const o = optionsFor(request(), { allowedTools: ['Bash', 'Read'] });
    expect(o.allowedTools).toEqual(['Agent', 'Bash', 'Read']);
    // A caller that names Agent itself does not get it twice.
    expect(optionsFor(request(), { allowedTools: ['Agent', 'Bash'] }).allowedTools).toEqual(['Agent', 'Bash']);
  });

  test('`tools` — the option that DOES govern existence — is never set', () => {
    // The regression this guards is a narrowing dressed as a fix. Measured on
    // the Claude Code binary bundled with that SDK release: omitting `tools`
    // yields all 33 built-in tools (subagent tool included), the `claude_code`
    // preset maps to `--tools default` and yields that same list, and explicit
    // array yields ONLY what it names — `--tools Read,Agent` returns two
    // tools. Assigning `tools` here is therefore either a no-op or a silent
    // capability cut, and pre-approving a tool the base set excluded would
    // not bring it back.
    expect('tools' in optionsFor(request())).toBe(false);
    expect('tools' in optionsFor(request(), { allowedTools: ['Bash', 'Read'] })).toBe(false);
    expect('tools' in optionsFor(request(), { allowedTools: [], settingSources: [] })).toBe(false);
    // Not merely absent from the mapping — absent from the module's whole
    // vocabulary, so a caller cannot reach it by accident either.
    expect(Object.keys(optionsFor(request(), { allowedTools: ['Agent'] }))).not.toContain('tools');
  });

  test('a spawned intra-step helper is observed and attributed at depth 1', async () => {
    const calls: Array<{ tool: string; depth: number }> = [];
    // The real shape of an intra-step helper: the step-executor calls Agent at
    // depth 0, and the tool calls the helper then makes carry that call's id
    // as their parent_tool_use_id.
    const { query, seen } = fakeQuery([
      { type: 'system', subtype: 'init', session_id: 'sess-1', tools: ['Agent', 'Bash'] },
      assistantFrame([{ id: 'toolu_agent', name: 'Agent' }]),
      assistantFrame([{ id: 'toolu_bash', name: 'Bash' }], 'toolu_agent'),
      resultFrame(),
    ]);
    const exit = await sdkExecutor({
      query,
      onToolCall: (_req, call) => calls.push({ tool: call.tool, depth: call.depth }),
    })(request());

    // The pre-approval that keeps a headless helper spawn from stalling on a
    // permission prompt — NOT what makes the tool exist, which is the default
    // base tool set this runner leaves untouched…
    expect(seen.options?.allowedTools).toContain('Agent');
    expect('tools' in seen.options!).toBe(false);
    // …and the evidence that a helper's nested calls are attributed at depth.
    // This is parser coverage over injected frames, not proof that a live
    // model turn can spawn one; `docs/sdk-delta-measurement.md` records that
    // gap explicitly rather than rounding it off.
    expect(calls).toEqual([
      { tool: 'Agent', depth: 0 },
      { tool: 'Bash', depth: 1 },
    ]);
    expect(exit.stream?.max_depth).toBe(1);
    expect(exit.stream?.tools_called).toBe(2);
    expect(exit.code).toBe(SDK_EXIT.ok);
  });
});

// ---------------------------------------------------------------------------
// DoD 3 — stream is populated and envelopeOf takes the stream path
// ---------------------------------------------------------------------------

describe('ExecutorExit.stream is the progress channel, and envelopeOf prefers it', () => {
  test('stream is populated and stdout is deliberately absent', async () => {
    const exit = await sdkExecutor({ query: fakeQuery([resultFrame()]).query })(request());
    expect(exit.stream).toBeDefined();
    // No captured text exists, and inventing some would create a second,
    // lower-fidelity source of truth for the same facts.
    expect(exit.stdout).toBeUndefined();
    expect(exit.stream?.saw_result).toBe(true);
  });

  test('envelopeOf returns the stream’s OWN envelope object, not a replay', async () => {
    const exit = await sdkExecutor({ query: fakeQuery([resultFrame()]).query })(request());
    // Identity, not equality: proves nothing was re-parsed on the way out.
    expect(envelopeOf(exit)).toBe(exit.stream!.envelope!);
  });

  test('the stream path WINS even when a conflicting stdout is present', async () => {
    const exit = await sdkExecutor({ query: fakeQuery([resultFrame()]).query })(request());
    const decoy = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'DECOY' });
    // If envelopeOf ever replayed stdout for an exit that has a stream, this
    // is the assertion that would catch it.
    expect(envelopeOf({ ...exit, stdout: decoy })!.result).toBe('all done');
  });

  test('the envelope carries the fields drive folds: usage, cost, denials, session', async () => {
    const exit = await sdkExecutor({ query: fakeQuery([resultFrame()]).query })(request());
    const env = envelopeOf(exit)!;
    expect(env.usage).toEqual({ input: 100, output: 20, cache_read: 1000, cache_creation: 5 });
    expect(env.total_cost_usd).toBe(0.0125);
    expect(env.session_id).toBe('sess-1');
    expect(env.num_turns).toBe(3);
    expect(env.structured_output).toEqual({ outcome: 'completed', summary: 'built' });
  });

  test('unknown frames are counted and ignored, never thrown', async () => {
    const exit = await sdkExecutor({
      query: fakeQuery([
        { type: 'system', subtype: 'from_a_future_release' },
        { type: 'a_type_nobody_documented' },
        resultFrame(),
      ]).query,
    })(request());
    expect(exit.code).toBe(SDK_EXIT.ok);
    expect(exit.stream?.counts.unknown).toBe(2);
    expect(exit.stream?.counts.frames).toBe(3);
  });

  test('a stream with no terminal result is reported, not invented', async () => {
    const exit = await sdkExecutor({
      query: fakeQuery([assistantFrame([{ id: 'toolu_a', name: 'Read' }])]).query,
    })(request());
    expect(exit.code).toBe(SDK_EXIT.noResult);
    expect(exit.stream?.saw_result).toBe(false);
    expect(envelopeOf(exit)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DoD 4 — success with no structured_output is a FAILURE
// ---------------------------------------------------------------------------

describe('the recovery ladder narrows but does not collapse', () => {
  test('subtype success with NO structured_output is treated as a failure', async () => {
    const frame = resultFrame();
    delete (frame as Record<string, unknown>).structured_output;
    const exit = await sdkExecutor({ query: fakeQuery([frame]).query })(request());
    expect(exit.code).toBe(SDK_EXIT.noStructuredOutput);
    expect(exit.code).not.toBe(SDK_EXIT.ok);
    expect(exit.error).toContain('no structured output');
  });

  test('a null / non-object structured_output is the same failure', async () => {
    for (const value of [null, 'a string', 42, ['an', 'array']]) {
      const exit = await sdkExecutor({
        query: fakeQuery([resultFrame({ structured_output: value })]).query,
      })(request());
      expect(exit.code).toBe(SDK_EXIT.noStructuredOutput);
    }
  });

  test('the FALLBACK RUNG survives: the envelope is still returned intact', async () => {
    const frame = resultFrame({ result: '{"outcome":"completed","summary":"from the text channel"}' });
    delete (frame as Record<string, unknown>).structured_output;
    const exit = await sdkExecutor({ query: fakeQuery([frame]).query })(request());

    // Reporting a failure must NOT cost the caller the channels that still
    // hold the record — this is drive's final rung, reached through the very
    // same helper drive uses.
    const env = envelopeOf(exit)!;
    expect(env.is_error).toBe(false);
    expect(parseResultObject(env.result)).toEqual({ outcome: 'completed', summary: 'from the text channel' });
  });

  test('error_max_structured_output_retries is reported as a result error', async () => {
    const exit = await sdkExecutor({
      query: fakeQuery([
        {
          type: 'result',
          subtype: 'error_max_structured_output_retries',
          is_error: true,
          num_turns: 5,
          session_id: 'sess-1',
          total_cost_usd: 0.02,
          usage: { input_tokens: 1, output_tokens: 1 },
          permission_denials: [],
        },
      ]).query,
    })(request());
    expect(exit.code).toBe(SDK_EXIT.resultError);
    expect(exit.error).toContain('error_max_structured_output_retries');
    // Still summarised — drive needs the usage fold even on a failed turn.
    expect(exit.stream?.envelope?.subtype).toBe('error_max_structured_output_retries');
  });

  test('an is_error result is a failure even when the subtype says success', async () => {
    const exit = await sdkExecutor({
      query: fakeQuery([resultFrame({ is_error: true })]).query,
    })(request());
    expect(exit.code).toBe(SDK_EXIT.resultError);
  });
});

// ---------------------------------------------------------------------------
// The end-to-end proof: drive's ladder actually recovers
// ---------------------------------------------------------------------------

/** A minimal single-step sequential pipeline. */
function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'sdk-exec-'));
  created.push(root);
  writeFileSync(join(root, 'PIPELINE.md'), '# P\n\n## End State\ndone\n');
  mkdirSync(join(root, 'steps'), { recursive: true });
  writeFileSync(join(root, 'steps', '01-step.md'), '# step 1\n');
  return root;
}

/** Run `pipeline drive` in-process with cwd + home sandboxed to `root`. */
async function drive(root: string, runId: string, executor: ExecutorRunner) {
  const plan = computePlan(root);
  let outBuf = '';
  let errBuf = '';
  const prevCwd = process.cwd();
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.chdir(root);
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  try {
    const code = await runDrive(['--root', root, '--run-id', runId, '--start', plan.steps[0].path], {
      executor,
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
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
  }
}

describe('end to end: drive recovers from a success carrying no structured output', () => {
  test('the run still completes — through the RETAINED record-file rung', async () => {
    const root = scaffold();
    const observed: SdkOptions[] = [];

    // The fake stands in for the whole SDK: it writes the step record into the
    // directory the runner granted (exactly what a real step-executor does
    // under the --add-dir-equivalent grant), then returns a `success` result
    // with NO structured_output — the documented case 02 says must be treated
    // as a failure.
    const query: SdkQuery = ({ prompt, options }) => {
      observed.push(options!);
      const m = /^step_record_file = (.+)$/m.exec(prompt);
      if (m) {
        const file = m[1].trim();
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(
          file,
          JSON.stringify({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' }),
          'utf8',
        );
      }
      const frame = resultFrame();
      delete (frame as Record<string, unknown>).structured_output;
      return (async function* () {
        yield assistantFrame([{ id: 'toolu_agent', name: 'Agent' }]);
        yield assistantFrame([{ id: 'toolu_bash', name: 'Bash' }], 'toolu_agent');
        yield frame;
      })();
    };

    const r = await drive(root, 'sdkfallback', sdkExecutor({ query, schema: STEP_RECORD_SCHEMA as Record<string, unknown> }));

    // The ladder narrowed to one rung and that rung carried the run.
    expect(r.code).toBe(0);
    expect(r.json?.status).toBe('completed');

    // And the options drive's own step actually received are the mapped ones:
    // the record grant is what made that recovery possible at all.
    expect(observed).toHaveLength(1);
    expect(observed[0].allowedTools).toContain('Agent');
    expect(observed[0].outputFormat).toEqual({
      type: 'json_schema',
      schema: STEP_RECORD_SCHEMA as Record<string, unknown>,
    });
    expect('settingSources' in observed[0]).toBe(false);
    expect(observed[0].additionalDirectories?.length).toBeGreaterThan(0);
  }, 30000);

  test('the happy path: structured_output alone drives the run, no file needed', async () => {
    const root = scaffold();
    const query: SdkQuery = () =>
      (async function* () {
        yield resultFrame({
          structured_output: { outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE', summary: 'sdk' },
        });
      })();

    const r = await drive(root, 'sdkhappy', sdkExecutor({ query, schema: STEP_RECORD_SCHEMA as Record<string, unknown> }));
    expect(r.code).toBe(0);
    expect(r.json?.status).toBe('completed');
  }, 30000);
});

// ---------------------------------------------------------------------------
// The drift tripwire
// ---------------------------------------------------------------------------

describe('the SDK is an optional peer, and the local types are a verified subset', () => {
  test('a missing package is reported as a missing INSTALL, not a stack trace', async () => {
    // This is the expected state for every user who never selects standalone,
    // so the message has to name the package and the install command.
    let message = '';
    try {
      const q = await loadSdkQuery();
      // Installed in this checkout — then it must at least be callable.
      expect(typeof q).toBe('function');
      return;
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain(SDK_MODULE_ID);
    expect(message).toContain('not installed');
    // It must say HOW to get it, and that not having it is normal.
    expect(message).toContain(`bun add ${SDK_MODULE_ID}`);
    expect(message.toLowerCase()).toContain('optional peer dependency');
  });

  test('WHEN the real SDK is present, its surface still matches what we mapped', async () => {
    let mod: Record<string, unknown>;
    try {
      mod = (await import(SDK_MODULE_ID)) as Record<string, unknown>;
    } catch {
      // Not installed — the normal case. The subset types are documented
      // against VERIFIED_SDK_VERSION and re-checked whenever it IS present.
      expect(VERIFIED_SDK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
      return;
    }
    // The one runtime-observable part of the contract: the entry point.
    expect(typeof mod.query).toBe('function');
    expect((mod.query as (...a: never[]) => unknown).length).toBeGreaterThanOrEqual(1);
  });
});
