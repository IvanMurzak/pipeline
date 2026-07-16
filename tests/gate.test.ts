// T3-14 approval gates (`type: gate`) — runner side.
//
// Covers the full contract:
//   - plan parse + lint: a valid gate (required_role + ## Message + ## Next),
//     the missing/invalid required_role plan ERRORs, warn-and-drop of
//     agent-/script-only fields, the sequential `## Next` mechanical lint,
//     and gate_spec: null on every other step kind.
//   - the emitted needs_input question: text/context/options + the ADDITIVE
//     `approval: { required_role }` marker (the cloud contract), byte-audited.
//   - the {decision, comment} answer parse: approve ⇒ the gate COMPLETES and
//     routing proceeds (sequential ## Next AND graph flags), reject ⇒ HALT
//     with the comment, missing/non-JSON/unknown-decision ⇒ HALT (an
//     unparseable answer is NEVER treated as approval), unknown sibling keys
//     ignored (additive-forward).
//   - `pipeline next` (manager mode): the gate dispatch passes through
//     annotated with `gate_question`; a {kind:'gate-answer'} record resolves
//     it. Parallel layers degrade to a loud halt (v1).
//   - `pipeline drive` (headless): the run parks on the gate (exit 4,
//     awaiting-input JSON carrying the approval question, NO executor spawn)
//     and `--resume --answer` delivers the decision.
//
// Harness style mirrors drive-script-steps.test.ts (in-process runDrive /
// invokeNext through the injectable seams, sandboxed cwd + HOME/USERPROFILE)
// and next-script.test.ts (computePlan over temp scaffolds).

import { test, expect, afterEach } from 'bun:test';
import { computePlan } from '../src/lib/plan';
import { buildGateQuestion, parseGateDecision } from '../src/lib/gate';
import { invokeNext } from '../src/commands/next';
import { runDrive, type ExecutorRunner } from '../src/commands/drive';
import type { GitRunner } from '../src/lib/git';
import type { NextRecord } from '../src/lib/next';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const created: string[] = [];
afterEach(() => {
  while (created.length) {
    try {
      rmSync(created.pop()!, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}, 30000);

// --- scaffolding -------------------------------------------------------------

interface World {
  project: string; // consumer project root (git repo, cwd during the run)
  root: string; // pipeline root at <project>/.claude/pipeline/demo
  steps: string;
}

function mkWorld(manifest = '# P\n\n## End State\nx\n'): World {
  const project = mkdtempSync(join(tmpdir(), 'gate-'));
  created.push(project);
  spawnSync('git', ['init', '-q'], { cwd: project });
  const root = join(project, '.claude', 'pipeline', 'demo');
  const steps = join(root, 'steps');
  mkdirSync(steps, { recursive: true });
  writeFileSync(join(root, 'PIPELINE.md'), manifest);
  return { project, root, steps };
}

function gateStepMd(opts: {
  stepId: string;
  role?: string | null;
  next?: string | null;
  message?: string | null;
  extraFm?: string[];
}): string {
  const fm = [
    '---',
    'type: gate',
    ...(opts.role != null ? [`required_role: ${opts.role}`] : []),
    `step_id: ${opts.stepId}`,
    ...(opts.extraFm ?? []),
    '---',
  ].join('\n');
  const body = [
    `# ${opts.stepId}`,
    ...(opts.message != null ? ['## Message', opts.message] : []),
    ...(opts.next != null ? ['## Next', opts.next] : []),
    '',
  ].join('\n');
  return fm + '\n' + body;
}

function agentStepMd(stepId: string): string {
  return `---\nstep_id: ${stepId}\n---\n# ${stepId}\n## Goal\ng\n## Success Criteria\ns\n`;
}

/** Run `fn` with cwd + HOME/USERPROFILE pinned inside the sandbox so
 *  auto-emitted UI events and stats land in the temp dir (the
 *  drive-script-steps.test.ts recipe). */
async function inSandbox<T>(w: World, fn: () => T | Promise<T>): Promise<T> {
  const prevCwd = process.cwd();
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = ['HOME', 'USERPROFILE', 'PIPELINE_UI_RUN_ID', 'PIPELINE_UI_PARENT_RUN_ID', 'CLAUDE_SESSION_ID', 'PIPELINE_STATS_RUNNER'];
  for (const k of envKeys) savedEnv[k] = process.env[k];
  process.chdir(w.project);
  process.env.HOME = w.project;
  process.env.USERPROFILE = w.project;
  delete process.env.PIPELINE_UI_RUN_ID;
  delete process.env.PIPELINE_UI_PARENT_RUN_ID;
  delete process.env.CLAUDE_SESSION_ID;
  try {
    return await fn();
  } finally {
    process.chdir(prevCwd);
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** In-process runDrive with a record-writing fake executor (spawns recorded —
 *  a gate must never reach the executor seam). */
async function drive(w: World, runId: string, args: string[], records: Record<string, unknown>) {
  const calls: string[] = [];
  const executor: ExecutorRunner = async (req) => {
    calls.push(req.step_id);
    const rec = records[req.step_id];
    if (rec === undefined) return { code: 7 };
    writeFileSync(req.record_file, JSON.stringify(rec), 'utf8');
    return { code: 0 };
  };
  const git: GitRunner = () => ({ code: 1, stdout: '', stderr: 'git disabled in this test' });
  let outBuf = '';
  let errBuf = '';
  const code = await inSandbox(w, () =>
    runDrive(['--root', w.root, '--run-id', runId, '--json', ...args], {
      executor,
      git,
      out: (s) => (outBuf += s),
      err: (s) => (errBuf += s),
    }),
  );
  let json: any = null;
  try {
    json = JSON.parse(outBuf);
  } catch {
    /* error paths have empty stdout */
  }
  return { code, json, stderr: errBuf, calls };
}

const APPROVE = '{"decision":"approve","comment":null}';

// ============================================================================
// Plan parse + lint
// ============================================================================

test('plan: a valid gate step parses — type, gate_spec, null model/effort; other kinds carry gate_spec null', () => {
  const w = mkWorld();
  const afterPath = join(w.steps, '02-after.md');
  writeFileSync(
    join(w.steps, '01-gate.md'),
    gateStepMd({ stepId: 'approve-deploy', role: 'admin', message: 'Deploy to production?', next: afterPath }),
  );
  writeFileSync(afterPath, agentStepMd('after'));

  const plan = computePlan(w.root);
  expect(plan.errors).toEqual([]);
  const gate = plan.steps[0];
  expect(gate.type).toBe('gate');
  expect(gate.gate_spec).toEqual({ required_role: 'admin', message: 'Deploy to production?' });
  // A gate spawns no agent — model/effort resolve to null, never the default.
  expect(gate.model).toBe(null);
  expect(gate.effort).toBe(null);
  expect(gate.script_spec).toBe(null);
  expect(gate.pipeline_spec).toBe(null);
  // Non-gate steps carry gate_spec: null.
  expect(plan.steps[1].type).toBe('agent');
  expect(plan.steps[1].gate_spec).toBe(null);
});

test('plan: required_role is case-insensitive and trimmed', () => {
  const w = mkWorld();
  writeFileSync(
    join(w.steps, '01-gate.md'),
    gateStepMd({ stepId: 'g', role: ' Owner ', message: 'ok?', next: 'Pipeline complete.' }),
  );
  const plan = computePlan(w.root);
  expect(plan.errors).toEqual([]);
  expect(plan.steps[0].gate_spec?.required_role).toBe('owner');
});

test('plan: a gate MISSING required_role is a plan ERROR', () => {
  const w = mkWorld();
  writeFileSync(join(w.steps, '01-gate.md'), gateStepMd({ stepId: 'g', message: 'ok?', next: 'Pipeline complete.' }));
  const plan = computePlan(w.root);
  expect(plan.errors.some((e) => e.includes("requires a 'required_role:'") && e.includes('owner|admin|member|viewer'))).toBe(true);
  expect(plan.steps[0].gate_spec?.required_role).toBe(null);
});

test('plan: a gate with an INVALID required_role is a plan ERROR', () => {
  const w = mkWorld();
  writeFileSync(
    join(w.steps, '01-gate.md'),
    gateStepMd({ stepId: 'g', role: 'superuser', message: 'ok?', next: 'Pipeline complete.' }),
  );
  const plan = computePlan(w.root);
  expect(plan.errors.some((e) => e.includes("invalid required_role 'superuser'"))).toBe(true);
  expect(plan.steps[0].gate_spec?.required_role).toBe(null);
});

test('plan: agent-/script-only fields on a gate warn-and-drop; missing ## Message warns', () => {
  const w = mkWorld();
  writeFileSync(
    join(w.steps, '01-gate.md'),
    gateStepMd({
      stepId: 'g',
      role: 'member',
      next: 'Pipeline complete.',
      extraFm: ['model: opus', 'effort: high', 'script: scripts/x.py', 'timeout: 60', 'pipeline: other'],
    }),
  );
  const plan = computePlan(w.root);
  expect(plan.errors).toEqual([]);
  expect(plan.warnings.some((x) => x.includes('model, effort') && x.includes('a gate spawns no agent'))).toBe(true);
  expect(plan.warnings.some((x) => x.includes('script, timeout') && x.includes('type: gate'))).toBe(true);
  expect(plan.warnings.some((x) => x.includes("'pipeline:' ignored on a type: gate step"))).toBe(true);
  expect(plan.warnings.some((x) => x.includes('no ## Message section'))).toBe(true);
  // Dropped, not honored: no script/pipeline spec materializes, model stays null.
  expect(plan.steps[0].gate_spec).toEqual({ required_role: 'member', message: null });
  expect(plan.steps[0].script_spec).toBe(null);
  expect(plan.steps[0].pipeline_spec).toBe(null);
  expect(plan.steps[0].model).toBe(null);
});

test('plan: a sequential gate needs a mechanical ## Next (one absolute path or Pipeline complete.) — ERROR otherwise', () => {
  const w = mkWorld();
  writeFileSync(join(w.steps, '01-gate.md'), gateStepMd({ stepId: 'g', role: 'admin', message: 'ok?' }));
  writeFileSync(join(w.steps, '02-after.md'), agentStepMd('after'));
  const plan = computePlan(w.root);
  expect(plan.errors.some((e) => e.includes('## Next of a sequential gate step'))).toBe(true);
});

// ============================================================================
// The needs_input question + the {decision, comment} parse (pure contracts)
// ============================================================================

test('buildGateQuestion: the exact wire shape — text/context/options + the additive approval marker', () => {
  expect(buildGateQuestion('approve-deploy', 'admin', 'Deploy to production?')).toEqual({
    text: 'Deploy to production?',
    context: "approval gate 'approve-deploy' — requires role 'admin' to answer",
    options: ['approve', 'reject'],
    approval: { required_role: 'admin' },
  });
  // No ## Message → a default prompt naming the step.
  expect(buildGateQuestion('g', 'viewer', null).text).toBe("Approval required to proceed past gate 'g'.");
});

test('parseGateDecision: approve/reject parse; everything unparseable fails CLOSED', () => {
  expect(parseGateDecision(APPROVE)).toEqual({ ok: true, decision: { decision: 'approve', comment: null } });
  expect(parseGateDecision('{"decision":"reject","comment":"not today"}')).toEqual({
    ok: true,
    decision: { decision: 'reject', comment: 'not today' },
  });
  // Unknown sibling keys ignored (additive-forward); non-string comment → null.
  expect(parseGateDecision('{"decision":"approve","comment":42,"reviewer":"ivan","extra":{"a":1}}')).toEqual({
    ok: true,
    decision: { decision: 'approve', comment: null },
  });
  // A pre-parsed object answer is tolerated (manager-mode --record).
  expect(parseGateDecision({ decision: 'approve', comment: 'ok' })).toEqual({
    ok: true,
    decision: { decision: 'approve', comment: 'ok' },
  });
  // Decision value tolerance: trim + case only — never anything but approve/reject.
  expect(parseGateDecision('{"decision":" Approve "}').ok).toBe(true);
  // Fail-closed set: missing, empty, non-JSON, non-object, unknown decision.
  for (const bad of [undefined, null, '', '   ', 'lgtm', '"approve"', '[1,2]', '{"decision":"maybe"}', '{"comment":"x"}', 42]) {
    const r = parseGateDecision(bad as unknown);
    expect(r.ok).toBe(false);
  }
});

// ============================================================================
// `pipeline next` (manager mode): pass-through + gate-answer record
// ============================================================================

test('next: a gate dispatch passes through annotated with gate_question; approve advances via ## Next; run completes', async () => {
  const w = mkWorld();
  const gatePath = join(w.steps, '01-gate.md');
  const afterPath = join(w.steps, '02-after.md');
  writeFileSync(gatePath, gateStepMd({ stepId: 'gate', role: 'admin', message: 'Deploy to production?', next: afterPath }));
  writeFileSync(afterPath, agentStepMd('after'));
  const run = 'nextgateok';

  await inSandbox(w, () => {
    // Init: the gate surfaces as a pass-through run-step (NOT executed).
    const r1 = invokeNext({ root: w.root, runId: run, start: gatePath, record: null });
    expect(r1.action.action).toBe('run-step');
    if (r1.action.action !== 'run-step') throw 0;
    expect(r1.action.steps[0].step_id).toBe('gate');
    expect(r1.action.steps[0].type).toBe('gate');
    // The AUDITABLE cloud contract: the question + the additive approval marker.
    expect(r1.out.gate_question).toEqual({
      text: 'Deploy to production?',
      context: "approval gate 'gate' — requires role 'admin' to answer",
      options: ['approve', 'reject'],
      approval: { required_role: 'admin' },
    });
    // The state parked in await-step on the gate.
    const state = JSON.parse(readFileSync(join(w.root, '.runtime', run, 'next.json'), 'utf8'));
    expect(state.phase).toBe('await-step');
    expect(state.current_step_id).toBe('gate');

    // The decision arrives as a gate-answer record → the gate COMPLETES and
    // the run advances to the ## Next step.
    const r2 = invokeNext({
      root: w.root,
      runId: run,
      record: { kind: 'gate-answer', answer: APPROVE } as NextRecord,
    });
    expect(r2.action.action).toBe('run-step');
    if (r2.action.action !== 'run-step') throw 0;
    expect(r2.action.steps[0].step_id).toBe('after');
    expect(r2.action.steps[0].type).toBe('agent');
    expect(r2.out.gate_question).toBeUndefined();

    // The agent step completes → done.
    const r3 = invokeNext({
      root: w.root,
      runId: run,
      record: { kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' },
    });
    expect(r3.action.action).toBe('done');
  });
}, 30000);

test('next: reject halts the run with the comment in the reason', async () => {
  const w = mkWorld();
  const gatePath = join(w.steps, '01-gate.md');
  writeFileSync(gatePath, gateStepMd({ stepId: 'gate', role: 'owner', message: 'Ship it?', next: 'Pipeline complete.' }));
  const run = 'nextgaterej';

  await inSandbox(w, () => {
    invokeNext({ root: w.root, runId: run, start: gatePath, record: null });
    const r = invokeNext({
      root: w.root,
      runId: run,
      record: { kind: 'gate-answer', answer: '{"decision":"reject","comment":"not today"}' } as NextRecord,
    });
    expect(r.action.action).toBe('halt');
    if (r.action.action !== 'halt') throw 0;
    expect(r.action.reason).toContain("approval gate 'gate' rejected: not today");
    expect(r.code).toBe(1);
  });
}, 30000);

test('next: graph mode — approve routes off the additive approved flag', async () => {
  const w = mkWorld(
    `# P\n\n## End State\nx\n\n## Graph\n\n\`\`\`json\n${JSON.stringify({ gate: [{ when: 'approved', goto: 'ship' }] })}\n\`\`\`\n`,
  );
  const gatePath = join(w.steps, '01-gate.md');
  // Graph mode: no ## Next needed (routing runs off flags).
  writeFileSync(gatePath, gateStepMd({ stepId: 'gate', role: 'member', message: 'Proceed?' }));
  writeFileSync(join(w.steps, '02-ship.md'), agentStepMd('ship'));
  const run = 'nextgategraph';

  await inSandbox(w, () => {
    const r1 = invokeNext({ root: w.root, runId: run, start: gatePath, record: null });
    if (r1.action.action !== 'run-step') throw 0;
    expect(r1.action.steps[0].type).toBe('gate');
    const r2 = invokeNext({ root: w.root, runId: run, record: { kind: 'gate-answer', answer: APPROVE } as NextRecord });
    expect(r2.action.action).toBe('run-step');
    if (r2.action.action !== 'run-step') throw 0;
    expect(r2.action.steps[0].step_id).toBe('ship');
  });
}, 30000);

test('next: an unparseable gate-answer halts (never approval); a gate-answer with no pending gate takes the wrong-record halt', async () => {
  const w = mkWorld();
  const gatePath = join(w.steps, '01-gate.md');
  writeFileSync(gatePath, gateStepMd({ stepId: 'gate', role: 'admin', message: 'ok?', next: 'Pipeline complete.' }));
  const run = 'nextgatebad';

  await inSandbox(w, () => {
    invokeNext({ root: w.root, runId: run, start: gatePath, record: null });
    const r = invokeNext({ root: w.root, runId: run, record: { kind: 'gate-answer', answer: 'lgtm!' } as NextRecord });
    expect(r.action.action).toBe('halt');
    if (r.action.action !== 'halt') throw 0;
    expect(r.action.reason).toContain('never treated as approval');
  });

  // A gate-answer aimed at a run whose pending dispatch is NOT a gate: the
  // record passes through and the engine's uniform wrong-record halt fires.
  const w2 = mkWorld();
  writeFileSync(join(w2.steps, '01-a.md'), agentStepMd('a'));
  const run2 = 'nextgatemiss';
  await inSandbox(w2, () => {
    invokeNext({ root: w2.root, runId: run2, start: join(w2.steps, '01-a.md'), record: null });
    const r = invokeNext({ root: w2.root, runId: run2, record: { kind: 'gate-answer', answer: APPROVE } as NextRecord });
    expect(r.action.action).toBe('halt');
    if (r.action.action !== 'halt') throw 0;
    expect(r.action.reason).toContain('expected a step/layer record');
  });
}, 30000);

test('next: a gate inside a PARALLEL layer degrades to a loud halt (v1)', async () => {
  const w = mkWorld('---\nexecution: parallel\nisolation: manual\n---\n# P\n\n## End State\nx\n');
  writeFileSync(join(w.steps, '01-gate.md'), gateStepMd({ stepId: 'g', role: 'admin', message: 'ok?' }));
  const run = 'nextgatepar';

  await inSandbox(w, () => {
    const r = invokeNext({ root: w.root, runId: run, record: null });
    expect(r.action.action).toBe('halt');
    if (r.action.action !== 'halt') throw 0;
    expect(r.action.reason).toContain('not supported inside a parallel layer');
    expect(r.action.reason).toContain("'g'");
  });
}, 30000);

// ============================================================================
// `pipeline drive` (headless): park (exit 4) → --answer resumes
// ============================================================================

/** Scaffold the canonical drive pipeline: 01-gate (admin) → 02-after (agent). */
function gateWorld(): { w: World; gatePath: string; records: Record<string, unknown> } {
  const w = mkWorld();
  const gatePath = join(w.steps, '01-gate.md');
  const afterPath = join(w.steps, '02-after.md');
  writeFileSync(gatePath, gateStepMd({ stepId: 'gate', role: 'admin', message: 'Deploy to production?', next: afterPath }));
  writeFileSync(afterPath, agentStepMd('after'));
  return {
    w,
    gatePath,
    records: { after: { kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' } },
  };
}

test('drive: a gate parks the run (exit 4) with the approval question — NO executor spawn', async () => {
  const { w, gatePath, records } = gateWorld();
  const r = await drive(w, 'drivegatepark', ['--start', gatePath], records);
  expect(r.code).toBe(4);
  expect(r.json.status).toBe('awaiting-input');
  expect(r.json.step_id).toBe('gate');
  expect(r.json.iteration_path).toBe(gatePath);
  expect(r.json.session_id).toBe(null); // no claude session behind a gate
  // The AUDITABLE wire shape, approval marker included.
  expect(r.json.question).toEqual({
    text: 'Deploy to production?',
    context: "approval gate 'gate' — requires role 'admin' to answer",
    options: ['approve', 'reject'],
    approval: { required_role: 'admin' },
  });
  expect(r.json.detail).toContain('--answer');
  expect(r.calls).toEqual([]); // deterministic: the executor seam never fired
  // Re-entry WITHOUT an answer re-parks (still no spawn).
  const again = await drive(w, 'drivegatepark', ['--resume', '--start', gatePath], records);
  expect(again.code).toBe(4);
  expect(again.json.question.approval).toEqual({ required_role: 'admin' });
  expect(again.calls).toEqual([]);
}, 30000);

test('drive: --answer approve completes the gate and the run proceeds through ## Next', async () => {
  const { w, gatePath, records } = gateWorld();
  const run = 'drivegateok';
  const first = await drive(w, run, ['--start', gatePath], records);
  expect(first.code).toBe(4);
  const second = await drive(w, run, ['--resume', '--start', gatePath, '--answer', APPROVE], records);
  expect(second.code).toBe(0);
  expect(second.json.status).toBe('completed');
  // Only the AGENT step ever reached the executor.
  expect(second.calls).toEqual(['after']);
}, 30000);

test('drive: --answer reject halts the run, comment in the halt reason', async () => {
  const { w, gatePath, records } = gateWorld();
  const run = 'drivegaterej';
  await drive(w, run, ['--start', gatePath], records);
  const r = await drive(w, run, ['--resume', '--start', gatePath, '--answer', '{"decision":"reject","comment":"needs a security review"}'], records);
  expect(r.code).toBe(1);
  expect(r.json.status).toBe('halted');
  expect(r.json.reason).toContain("approval gate 'gate' rejected: needs a security review");
  expect(r.calls).toEqual([]);
}, 30000);

test('drive: an unparseable / unknown-decision answer HALTS — never treated as approval', async () => {
  // Non-JSON text.
  {
    const { w, gatePath, records } = gateWorld();
    const run = 'drivegatebad1';
    await drive(w, run, ['--start', gatePath], records);
    const r = await drive(w, run, ['--resume', '--start', gatePath, '--answer', 'lgtm, ship it'], records);
    expect(r.code).toBe(1);
    expect(r.json.status).toBe('halted');
    expect(r.json.reason).toContain('never treated as approval');
    expect(r.calls).toEqual([]);
  }
  // Valid JSON, unknown decision value.
  {
    const { w, gatePath, records } = gateWorld();
    const run = 'drivegatebad2';
    await drive(w, run, ['--start', gatePath], records);
    const r = await drive(w, run, ['--resume', '--start', gatePath, '--answer', '{"decision":"maybe","comment":null}'], records);
    expect(r.code).toBe(1);
    expect(r.json.reason).toContain('unknown decision');
    expect(r.calls).toEqual([]);
  }
}, 30000);

test('drive: unknown sibling keys on the answer are ignored (additive-forward)', async () => {
  const { w, gatePath, records } = gateWorld();
  const run = 'drivegatefwd';
  await drive(w, run, ['--start', gatePath], records);
  const r = await drive(
    w,
    run,
    ['--resume', '--start', gatePath, '--answer', '{"decision":"approve","comment":"ok","approved_by":"ivan@example.com","role":"owner"}'],
    records,
  );
  expect(r.code).toBe(0);
  expect(r.json.status).toBe('completed');
}, 30000);

test('drive: the parked gate state survives on disk (await-step, no session file)', async () => {
  const { w, gatePath, records } = gateWorld();
  const run = 'drivegatestate';
  await drive(w, run, ['--start', gatePath], records);
  const state = JSON.parse(readFileSync(join(w.root, '.runtime', run, 'next.json'), 'utf8'));
  expect(state.phase).toBe('await-step');
  expect(state.current_step_id).toBe('gate');
  // A gate pins no executor session (nothing to resume but the engine state).
  expect(existsSync(join(w.root, '.runtime', run, 'sessions', 'gate.json'))).toBe(false);
}, 30000);
