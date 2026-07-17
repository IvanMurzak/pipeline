// `pipeline step run <iteration.md> [--param k=v ...] [--var NAME=value ...]
//   [--vars-file <path>] [--json]`
//
// The author-facing DRY-RUN tool for `type: script` steps (roadmap/
// script-steps/DESIGN.md §13). It executes ONE script step exactly as the
// runtime would — same `## Params` parsing (via computePlan), same binding
// resolution + validation, same spawn/stdout-parse/classification machinery
// (lib/script-step.ts, reused verbatim, never reimplemented) — and prints the
// result plus the would-be engine step record, so a pipeline author can test a
// script step without a full `pipeline run`.
//
// It NEVER touches any run state: no `.runtime/` and no `.feedback/` under the
// pipeline are created or modified. executeScriptStep writes its params/ledger/
// failures under `<ctx.pipelineRoot>/.runtime/<run-id>/…`, so we hand it a
// THROWAWAY pipeline root under the system temp dir and pass the REAL pipeline
// root as `ctx.scriptRoot` so a relative `script:` still resolves (and T3b
// containment-checks) against the real tree. Consequence (documented dry-run
// limitation): the `${pipeline.root}` binding and PIPELINE_STEP_PIPELINE_ROOT
// env var point at the throwaway dir, not the real pipeline root.
//
// `--param <name>=<value>` is the override seam (resolveParams' `overrides`
// argument): a value parses as JSON when it can, else it is kept as a string.
// Because a dry run has no run state, every `${steps.*}` / `${run.task}`
// binding is UNRESOLVABLE and therefore REQUIRES a `--param` override — missing
// ones are listed and the command exits 2 (a usage error, not a script
// failure). The overrides ride the execution context (`ctx.overrides`)
// straight into executeScriptStep's own resolveParams call.
//
// Exit codes (match docs/cli.md + DESIGN §13): 0 = script ran ok:true,
// 1 = script ran but failed (any class), 2 = usage error (missing/agent step,
// unresolved `${steps…}`/`${run.task}` refs without --param, plan errors).

import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { computePlan, findEnclosingPipelineRoot, type Plan, type PlanStep } from '../lib/plan';
import { samePath } from '../lib/next';
import {
  addVarFlag,
  hasDeclarations,
  initRunVariables,
  loadVarsFile,
  mergeCliVars,
  type ResolvedVars,
} from '../lib/run-vars';
import { substituteArgv, substituteText } from '../lib/substitution';
import { executeScriptStep, resolveParams, type ScriptStepContext } from '../lib/script-step';
import type { ScriptStepSpec } from '../lib/script-types';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface StepRunArgs {
  iteration?: string;
  overrides: Record<string, unknown>;
  /** Set when a `--param` token had no `<name>=<value>` shape — loud usage error. */
  paramError?: string;
  /** PP_* variable overrides from repeated `--var NAME=value` (env-variables
   *  design, 05 §3): resolved against the pipeline's declarations exactly as
   *  a real run would, but NEVER frozen — a dry run is ephemeral. */
  varFlags?: Record<string, string>;
  /** Path passed via `--vars-file <path>` (dotenv format, strict load). */
  varsFile?: string;
  /** Set when a `--var` value was malformed — loud usage error. */
  varsError?: string;
  /** An unrecognized `--flag` — loud usage error rather than a silent no-op. */
  unknownFlag?: string;
  json: boolean;
}

/** Parse one `--param` payload (`<name>=<value>`); the value parses as JSON
 *  when possible (numbers/booleans/arrays/objects/null), else stays a string. */
function addParam(out: StepRunArgs, payload: string | undefined): void {
  const raw = payload ?? '';
  const eq = raw.indexOf('=');
  const name = eq > 0 ? raw.slice(0, eq).trim() : '';
  if (!name || eq < 0) {
    out.paramError = `--param expects <name>=<value>, got '${raw}'`;
    return;
  }
  const valRaw = raw.slice(eq + 1);
  let value: unknown;
  try {
    value = JSON.parse(valRaw);
  } catch {
    value = valRaw;
  }
  out.overrides[name] = value;
}

function parseArgs(args: string[]): StepRunArgs {
  const out: StepRunArgs = { overrides: {}, json: false };
  const take = (i: number) => args[i + 1];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = (p: string) => (a.startsWith(p + '=') ? a.slice(p.length + 1) : undefined);
    if (a === '--param') addParam(out, take(i++));
    else if (eq('--param') !== undefined) addParam(out, eq('--param'));
    else if (a === '--var') addVarFlag(out, take(i++));
    else if (eq('--var') !== undefined) addVarFlag(out, eq('--var'));
    else if (a === '--vars-file') out.varsFile = take(i++);
    else if (eq('--vars-file') !== undefined) out.varsFile = eq('--vars-file');
    else if (a === '--json') out.json = true;
    else if (a === '--') continue;
    else if (a.startsWith('--')) out.unknownFlag = a;
    else if (out.iteration === undefined) out.iteration = a;
    else out.unknownFlag = `unexpected extra argument '${a}'`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Run-state binding detection (§3.2 / §13)
// ---------------------------------------------------------------------------

/** A `from` template references run state (⇒ unresolvable in a dry run) when it
 *  contains a `${steps.<id>…}` output binding or the `${run.task}` binding. */
function referencesRunState(from: string): boolean {
  return /\$\{steps\.[^}]*\}/.test(from) || /\$\{run\.task\}/.test(from);
}

// ---------------------------------------------------------------------------
// Result formatting
// ---------------------------------------------------------------------------

interface StepRunResult {
  ok: boolean;
  step_id: string;
  iteration: string;
  target: string;
  class: string | null;
  attempts: number;
  ledger_reused: boolean;
  duration_s: number;
  params: Record<string, unknown>;
  record: unknown;
  flags: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  summary: string | null;
  next_iteration: string | null;
  failure: {
    class: string;
    detail: string;
    exit_code: number | null;
    timed_out: boolean;
    duration_s: number;
    attempt: number;
    stderr_tail: string;
    stdout_tail: string;
  } | null;
  feedback_category: string | null;
  warnings: string[];
}

function json(v: unknown): string {
  return JSON.stringify(v, null, 2);
}

/** Human-readable rendering of the dry-run result. */
function renderHuman(r: StepRunResult): string {
  const lines: string[] = [];
  lines.push(`Script step: ${r.step_id}   (${r.iteration})`);
  lines.push(`Target:      ${r.target}`);
  lines.push(
    r.ok
      ? `Result:      OK`
      : `Result:      FAILED — class ${r.class}${r.failure?.timed_out ? ' (timed out)' : ''}`,
  );
  lines.push(`Duration:    ${r.duration_s}s   Attempts: ${r.attempts}${r.ledger_reused ? '   (ledger reused)' : ''}`);
  lines.push(`Params:      ${Object.keys(r.params).length ? json(r.params) : '(none)'}`);
  if (r.summary) lines.push(`Summary:     ${r.summary}`);
  lines.push(`Flags:       ${r.flags && Object.keys(r.flags).length ? json(r.flags) : '(none)'}`);
  lines.push(`Output:      ${r.output && Object.keys(r.output).length ? json(r.output) : '(none)'}`);
  lines.push(`Next:        ${r.next_iteration ?? '(not applicable — graph/DAG routing)'}`);
  if (r.failure) {
    lines.push(`Failure:     ${r.failure.detail}`);
    if (r.failure.stderr_tail.trim()) lines.push(`stderr tail:\n${r.failure.stderr_tail.trimEnd()}`);
    if (r.failure.stdout_tail.trim()) lines.push(`stdout tail:\n${r.failure.stdout_tail.trimEnd()}`);
    if (r.feedback_category) lines.push(`Feedback:    would be category '${r.feedback_category}' (dry run — not written)`);
  }
  if (r.warnings.length) lines.push(`Warnings:\n- ${r.warnings.join('\n- ')}`);
  lines.push(`Would-be step record:\n${json(r.record)}`);
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Command entry points
// ---------------------------------------------------------------------------

/** `pipeline step <subcommand> …` group router (cli.ts calls this). v1 has a
 *  single subcommand, `run`. */
export function runStep(args: string[]): number {
  const sub = args[0];
  if (sub === 'run') return runStepRun(args.slice(1));
  const err = (s: string) => process.stderr.write(s);
  if (sub === undefined || sub === '--help' || sub === '-h') {
    err(
      'Usage: pipeline step run <iteration.md> [--param <name>=<value> ...] [--var NAME=value ...] [--vars-file <path>] [--json]\n',
    );
    return sub === undefined ? 2 : 0;
  }
  err(`pipeline step: unknown subcommand '${sub}' (expected 'run')\n`);
  return 2;
}

/** `pipeline step run <iteration.md> [--param k=v ...] [--var NAME=value ...]
 *  [--vars-file <path>] [--json]`. */
export function runStepRun(args: string[]): number {
  const a = parseArgs(args);
  const err = (s: string) => process.stderr.write(s);
  const usage = (msg: string): number => {
    err(`pipeline step run: ${msg}\n`);
    return 2;
  };

  if (a.paramError !== undefined) return usage(a.paramError);
  if (a.varsError !== undefined) return usage(a.varsError);
  if (a.unknownFlag !== undefined) return usage(a.unknownFlag);
  if (a.iteration === undefined) {
    return usage(
      'an iteration file path is required — usage: pipeline step run <iteration.md> [--param k=v ...] [--var NAME=value ...] [--vars-file <path>] [--json]',
    );
  }

  const iterationAbs = resolve(a.iteration);
  if (!existsSync(iterationAbs)) return usage(`iteration file not found: ${iterationAbs}`);

  const pipelineRoot = findEnclosingPipelineRoot(dirname(iterationAbs));
  if (pipelineRoot === null) {
    return usage(`no PIPELINE.md found walking up from ${iterationAbs} — not inside a pipeline`);
  }

  // Parse the WHOLE pipeline (not just this file) so frontmatter + `## Params`/
  // `## Output` parsing is byte-for-byte the runtime's (computePlan).
  const plan: Plan = computePlan(pipelineRoot);
  if (plan.errors.length) {
    return usage(`plan errors in ${pipelineRoot}:\n  - ${plan.errors.join('\n  - ')}`);
  }
  const step: PlanStep | undefined = plan.steps.find((s) => samePath(s.path, iterationAbs));
  if (step === undefined) {
    return usage(`${iterationAbs} is not an enumerated step of ${pipelineRoot}`);
  }
  if (step.type !== 'script') {
    return usage(
      `'${step.step_id}' is a type: agent step — step run only executes type: script steps (agent steps need a full pipeline run)`,
    );
  }
  const spec: ScriptStepSpec | null = step.script_spec;
  if (spec === null) {
    return usage(`'${step.step_id}' is type: script but the plan produced no script_spec (plan bug)`);
  }

  // PP_* variables (env-variables design, 05 §3): resolve `--var`/`--vars-file`
  // against the pipeline's `## Variables` declarations exactly as a real run's
  // init would (CLI > environment > manifest default, D2) — but EPHEMERALLY:
  // nothing is frozen or persisted (a dry run has no run state). L6 `missing`
  // is scoped to THIS step's occurrences (verifying one step must not demand
  // values the step never uses); L10 `unknown-cli-var` stays global (a typo'd
  // override is never silently dropped, T11).
  let vars: ResolvedVars | null = null;
  {
    let fileVars: Record<string, string> | undefined;
    if (a.varsFile !== undefined) {
      const loaded = loadVarsFile(a.varsFile);
      if (!loaded.ok) return usage(loaded.error);
      fileVars = loaded.vars;
    }
    const cliVars = mergeCliVars(fileVars, a.varFlags);
    if (hasDeclarations(plan.variables) || cliVars !== undefined) {
      let manifestRaw = '';
      try {
        manifestRaw = readFileSync(join(pipelineRoot, 'PIPELINE.md'), 'utf8');
      } catch {
        // computePlan above already surfaced a missing manifest
      }
      const init = initRunVariables(
        plan.variables,
        cliVars ?? {},
        process.env,
        [{ file: `steps/${step.rel}`, raw: readFileSync(iterationAbs, 'utf8') }],
        manifestRaw,
        { scopeMissingToOccurrences: true },
      );
      if (init.errors.length) return usage(`variable validation failed:\n${init.message}`);
      vars = init.resolved;
    }
  }

  // The a4 seam (05 §4): lib/script-step.ts performs the ONE substitution
  // pass itself at command build — `command:` argv per element (after
  // tokenization, E2), the `script:` value before the interpreter ladder +
  // the T3b containment gate, the Params PP_* root, and the D10 env overlay —
  // reading ctx.variables. Step run passes the resolved map INSTEAD of
  // pre-substituting: values are inert only under a single pass (T4), so the
  // spec below stays RAW. The `target` shown to the author is a DISPLAY-ONLY
  // render of the same substitution (safe post-validation; argv[0] is never
  // substituted, mirroring the runtime's T3b hardening).
  // Display never crashes the dry run: an unresolvable token here is an
  // engine edge validation did not mirror — fall back to the authored text
  // (the execution path reports the same condition as a clean class-'binding'
  // failure).
  const renderForDisplay = <T>(render: () => T, authored: T): T => {
    try {
      return render();
    } catch {
      return authored;
    }
  };
  const rawScript = spec.script;
  const rawCommand = spec.command;
  const displayScript =
    rawScript !== null && vars !== null
      ? renderForDisplay(() => substituteText(rawScript, vars), rawScript)
      : rawScript;
  const displayCommand =
    rawCommand !== null && vars !== null
      ? renderForDisplay(() => [rawCommand[0]!, ...substituteArgv(rawCommand.slice(1), vars)], rawCommand)
      : rawCommand;

  // §13 — every `${steps.*}` / `${run.task}` binding is unresolvable in a dry
  // run and REQUIRES a `--param` override. List every missing one at once.
  const missing: string[] = [];
  for (const [name, pspec] of Object.entries(spec.params ?? {})) {
    if (typeof pspec.from === 'string' && referencesRunState(pspec.from)) {
      if (!Object.prototype.hasOwnProperty.call(a.overrides, name)) missing.push(`${name}  (from: ${pspec.from})`);
    }
  }
  if (missing.length) {
    return usage(
      `${missing.length} param(s) bind to run state (\${steps…} / \${run.task}) and cannot resolve in a dry run — ` +
        `supply each with --param <name>=<value>:\n  - ${missing.join('\n  - ')}`,
    );
  }

  // Throwaway pipeline root: redirects executeScriptStep's params/ledger/
  // failures writes away from the real `.runtime/`; `ctx.scriptRoot` keeps
  // `script:` resolution (and T3b containment) on the REAL pipeline root.
  const tmpRoot = mkdtempSync(join(tmpdir(), 'pipeline-step-run-'));
  try {
    const ctx: ScriptStepContext = {
      runId: 'step-run',
      stepId: step.step_id,
      dispatchIndex: 1,
      // No call budget in step-run: the per-attempt cap stays the declared
      // timeout; retries all get the full timeout (DESIGN §13 "full timeout
      // honored, no budget").
      deadlineMs: Infinity,
      pipelineRoot: tmpRoot,
      projectRoot: process.cwd(),
      worktreePath: null,
      worktreeEnvFile: null,
      taskText: null,
      readOutput: () => null,
      scriptRoot: pipelineRoot,
      // The EPHEMERAL variables map (never frozen — a dry run has no state):
      // executeScriptStep substitutes command/script surfaces, resolves
      // Params PP_* refs, and overlays PP_* onto the child env from it —
      // render parity with a real run (05 §3).
      ...(vars !== null ? { variables: vars } : {}),
      // The --param seam: executeScriptStep threads these into its own
      // resolveParams call.
      overrides: a.overrides,
    };

    // Pre-resolve params (with the --param overrides) EXACTLY as the runtime
    // will — ONLY to render the pretty binding-error report below; on success
    // executeScriptStep re-resolves identically via ctx.overrides.
    const resolved = resolveParams(spec.params, ctx, a.overrides);

    // Display-only target (see the a4-seam note above — never fed to the
    // execution path).
    const scriptAbs =
      displayScript !== null
        ? isAbsolute(displayScript)
          ? displayScript
          : join(pipelineRoot, displayScript)
        : null;
    const target = scriptAbs ?? (displayCommand ? displayCommand.join(' ') : '<none>');

    if (!resolved.ok) {
      // A binding-class failure BEFORE any spawn (a bad --param type, an unset
      // required `${env.X}`, …). Class 'binding' ⇒ exit 1 (a real failure), not
      // a usage error — DESIGN §6.1 / docs/cli.md exit-code table.
      const out: StepRunResult = {
        ok: false,
        step_id: step.step_id,
        iteration: iterationAbs,
        target,
        class: 'binding',
        attempts: 0,
        ledger_reused: false,
        duration_s: 0,
        params: a.overrides,
        record: { kind: 'step', outcome: 'halted', halt_reason: `binding: ${resolved.detail}` },
        flags: null,
        output: null,
        summary: null,
        next_iteration: null,
        failure: {
          class: 'binding',
          detail: resolved.detail,
          exit_code: null,
          timed_out: false,
          duration_s: 0,
          attempt: 0,
          stderr_tail: '',
          stdout_tail: '',
        },
        feedback_category: 'doc-flaw',
        warnings: [],
      };
      process.stdout.write(a.json ? json(out) + '\n' : renderHuman(out));
      return 1;
    }

    // The RAW spec the plan produced — executeScriptStep owns the single
    // substitution pass (ctx.variables) and resolves a relative `script:`
    // against ctx.scriptRoot (the real pipeline root).
    const started = Date.now();
    const res = executeScriptStep(spec, iterationAbs, ctx);
    const durationS = Math.round((Date.now() - started)) / 1000;

    const out: StepRunResult = {
      ok: res.failure === null,
      step_id: step.step_id,
      iteration: iterationAbs,
      target,
      class: res.failure?.class ?? null,
      attempts: res.attempts,
      ledger_reused: res.ledgerReused,
      duration_s: durationS,
      params: resolved.params,
      record: res.record,
      flags: res.record.flags ?? null,
      output: res.record.output ?? null,
      summary: res.record.summary ?? null,
      next_iteration: res.record.next_iteration ?? null,
      failure: res.failure
        ? {
            class: res.failure.class,
            detail: res.failure.detail,
            exit_code: res.failure.exit_code,
            timed_out: res.failure.timed_out,
            duration_s: res.failure.duration_s,
            attempt: res.failure.attempt,
            stderr_tail: res.failure.stderr_tail,
            stdout_tail: res.failure.stdout_tail,
          }
        : null,
      feedback_category: res.feedback?.category ?? null,
      warnings: res.warnings,
    };
    process.stdout.write(a.json ? json(out) + '\n' : renderHuman(out));
    return out.ok ? 0 : 1;
  } finally {
    // The throwaway root is pure scratch — reap it (its records/tails were
    // already read into the printed result).
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}
