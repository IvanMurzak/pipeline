// `pipeline init [<template>] [--no-plugin] [--no-ui] [--no-run] [--run]
//               [--yes|-y] [--dir <path>] [--json]`
//
// The single local-first entry point (simplified-onboarding design, task a1):
// replaces four documented actions across three surfaces — install the
// plugin, clone a starter pipeline, start the dashboard, offer to run it —
// with one command. See .claude/design/simplified-onboarding/03-pipeline-init.md
// (the contract) and 02-target-experience.md §1 (the transcript — it wins on
// any conflict with prose).
//
// COMPOSITION, NOT REIMPLEMENTATION. Every side effect below delegates to an
// existing primitive:
//   - clone      → src/lib/templates.ts (the same copy-tree helper
//                  src/commands/clone.ts itself calls; its own idempotency
//                  rule — refuse to overwrite without --force — is checked
//                  here BEFORE calling it, because "already cloned" must read
//                  as a ✓, not clone's own exit-1 "already exists" error).
//   - dashboard  → src/commands/ui.ts's runUi(['--json']), captured (ui.ts has
//                  no injectable deps of its own, so its stdout is captured
//                  and parsed rather than left to print its own format,
//                  matching the ONE consolidated checklist line the target
//                  transcript specifies).
//   - plugin     → a `claude plugin marketplace add` / `claude plugin
//                  install` shell-out (spawnSync, mirrors lib/git.ts's
//                  realGit/gitAvailable pattern).
//   - run        → src/commands/drive.ts's runDrive() in-process, which
//                  already emits a step.started/step.completed/step.failed
//                  progress stream on --json; this module only reformats that
//                  stream into the compact per-step display, it does not
//                  reimplement the headless run engine.
//
// Every side effect is behind an InitDeps seam (mirrors commands/cloud.ts) so
// tests drive the whole composition with zero real subprocess/network/stdin.

import { existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { findTemplate, copyTemplateTree, formatTemplateList, TEMPLATES } from '../lib/templates';
import { computePlan } from '../lib/plan';
import { runDrive, type DriveDeps } from './drive';
import { runUi } from './ui';

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

export interface InitOptions {
  template: string;
  noPlugin: boolean;
  noUi: boolean;
  noRun: boolean;
  run: boolean;
  yes: boolean;
  dir?: string;
  json: boolean;
  help: boolean;
}

const DEFAULT_TEMPLATE = 'support-answer'; // O4 (10-decisions.md)

const USAGE =
  'Usage: pipeline init [<template>] [--no-plugin] [--no-ui] [--no-run] [--run]\n' +
  '                     [--yes|-y] [--dir <path>] [--json]\n';

export function parseInitArgs(args: string[]): InitOptions | { error: string } {
  const out: InitOptions = {
    template: DEFAULT_TEMPLATE,
    noPlugin: false,
    noUi: false,
    noRun: false,
    run: false,
    yes: false,
    json: false,
    help: false,
  };
  let sawTemplate = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    const eq = (p: string) => (a.startsWith(p + '=') ? a.slice(p.length + 1) : undefined);
    if (a === '--no-plugin') out.noPlugin = true;
    else if (a === '--no-ui') out.noUi = true;
    else if (a === '--no-run') out.noRun = true;
    else if (a === '--run') out.run = true;
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--dir') {
      const v = args[++i];
      if (v === undefined) return { error: '--dir requires a path' };
      out.dir = v;
    } else if (eq('--dir') !== undefined) out.dir = eq('--dir');
    else if (a === '--') continue;
    else if (a.startsWith('-')) return { error: `unknown flag '${a}'` };
    else if (!sawTemplate) {
      out.template = a;
      sawTemplate = true;
    } else return { error: `unexpected extra argument '${a}' — init takes at most one <template>` };
  }
  if (out.run && out.noRun) return { error: 'cannot combine --run and --no-run' };
  return out;
}

function helpText(): string {
  return (
    `${USAGE}\n` +
    'One command from a bare project to a completed run: installs the Claude\n' +
    'Code plugin, clones a starter pipeline, starts the local dashboard, and\n' +
    'offers to run it.\n\n' +
    'Options:\n' +
    '  <template>     Starter pipeline to clone. Default: support-answer.\n' +
    '                 Same names as `pipeline clone --list`.\n' +
    '  --no-plugin    Skip the Claude Code plugin install.\n' +
    '  --no-ui        Do not start the local dashboard.\n' +
    '  --no-run       Do not offer to run the starter pipeline.\n' +
    '  --run          Run the starter pipeline without asking (pairs with --json).\n' +
    '  --yes, -y      Assume yes to every prompt.\n' +
    '  --dir <path>   Target project root. Default: cwd.\n' +
    '  --json         Non-interactive; declines every optional side effect\n' +
    '                 (the run) unless --run is also given.\n\n' +
    'Available templates:\n' +
    `${formatTemplateList()}\n`
  );
}

// ---------------------------------------------------------------------------
// Injectable seams
// ---------------------------------------------------------------------------

export interface ShellResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `claude <args>`. Mirrors lib/git.ts's GitRunner shape. */
export type ClaudeCliRunner = (args: string[]) => ShellResult;

export interface UiStartResult {
  ok: boolean;
  /** Resolved dashboard URL — the RESOLVED port from the daemon lock, never a
   *  literal (03-pipeline-init.md §2 step 4). */
  url?: string;
  /** Set when the UI system is explicitly opted out (PIPELINE_UI_ENABLED). */
  disabled?: boolean;
  /** Failure detail for the "UI port unavailable" warning row. */
  detail?: string;
}

export interface InitDeps {
  cwd: string;
  env: Record<string, string | undefined>;
  now: () => number;
  out: (s: string) => void;
  err: (s: string) => void;
  bunAvailable: () => boolean;
  claudeAvailable: () => boolean;
  claudeCli: ClaudeCliRunner;
  startUi: () => Promise<UiStartResult>;
  /** In-process pipeline drive engine — defaults to the real runDrive(). */
  runDrive: (args: string[], deps: DriveDeps) => Promise<number>;
  /** Ask a yes/no question; resolves the answer. The real implementation
   *  handles its own prompt printing (a real TTY echoes the typed answer
   *  itself; a non-TTY has nothing to echo and must print one). */
  promptYesNo: (promptText: string) => Promise<boolean>;
}

function claudeBin(): string {
  return process.env.PIPELINE_CLAUDE_BIN || 'claude';
}

const realClaudeCli: ClaudeCliRunner = (args) => {
  const r = spawnSync(claudeBin(), args, { encoding: 'utf8', windowsHide: true });
  if (r.error) {
    return { code: 127, stdout: r.stdout ?? '', stderr: String((r.error as Error).message ?? r.error) };
  }
  return { code: r.status ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

/** True iff `claude` is invokable on PATH. */
function realClaudeAvailable(): boolean {
  const r = spawnSync(claudeBin(), ['--version'], { encoding: 'utf8', windowsHide: true });
  return !r.error && (r.status ?? 1) === 0;
}

/** True iff Bun is available: either we're already running under it (the
 *  common case — the published `bin` is raw src/cli.ts) or `bun` resolves on
 *  PATH (a Node-bundled invocation). */
function realBunAvailable(): boolean {
  if (typeof (process as { versions?: { bun?: string } }).versions?.bun === 'string') return true;
  const r = spawnSync('bun', ['--version'], { encoding: 'utf8', windowsHide: true });
  return !r.error && (r.status ?? 1) === 0;
}

/** Capture whatever `fn` writes to process.stdout while it runs. ui.ts (like
 *  clone.ts) has no output seam of its own, so this is the only way to reuse
 *  its daemon detect/spawn/register logic without reprinting its own text —
 *  the target transcript specifies ONE consolidated dashboard line, not
 *  ui.ts's own format. Restores the real stdout.write in a finally so a throw
 *  can never leave stdout captured. */
async function captureStdout<T>(fn: () => Promise<T>): Promise<{ result: T; stdout: string }> {
  const real = process.stdout.write.bind(process.stdout);
  let buf = '';
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    buf += typeof chunk === 'string' ? chunk : String(chunk);
    const cb = rest.find((r): r is () => void => typeof r === 'function');
    if (cb) cb();
    return true;
  }) as typeof process.stdout.write;
  try {
    const result = await fn();
    return { result, stdout: buf };
  } finally {
    process.stdout.write = real;
  }
}

async function defaultStartUi(): Promise<UiStartResult> {
  const { result: code, stdout } = await captureStdout(() => runUi(['--json']));
  const lastLine = stdout.trim().split('\n').pop() ?? '';
  let parsed: { enabled?: boolean; url?: string } = {};
  try {
    parsed = JSON.parse(lastLine) as { enabled?: boolean; url?: string };
  } catch {
    // fall through — treated as a plain failure below
  }
  if (parsed.enabled === false) return { ok: true, disabled: true };
  if (code === 0 && typeof parsed.url === 'string') return { ok: true, url: parsed.url };
  return { ok: false, detail: `pipeline ui exited ${code}` };
}

async function defaultPromptYesNo(promptText: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    // Nothing to prompt — echo the documented default (yes) so the printed
    // transcript still reads "Run it now? [Y/n] y" in a piped/CI shell.
    process.stdout.write(`${promptText}y\n`);
    return true;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return await new Promise<boolean>((resolvePromise) => {
    let answered = false;
    rl.question(promptText, (answer) => {
      answered = true;
      rl.close();
      const a = answer.trim().toLowerCase();
      resolvePromise(a === '' || a === 'y' || a === 'yes');
    });
    rl.on('close', () => {
      if (!answered) resolvePromise(true); // EOF with no input — default yes
    });
  });
}

export const realInitDeps: InitDeps = {
  cwd: process.cwd(),
  env: process.env,
  now: () => Date.now(),
  out: (s) => {
    process.stdout.write(s);
  },
  err: (s) => {
    process.stderr.write(s);
  },
  bunAvailable: realBunAvailable,
  claudeAvailable: realClaudeAvailable,
  claudeCli: realClaudeCli,
  startUi: defaultStartUi,
  runDrive: (args, deps) => runDrive(args, deps),
  promptYesNo: defaultPromptYesNo,
};

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export type PluginStatus = 'installed' | 'skipped' | 'failed';

/** `claude plugin marketplace add` + `claude plugin install` (03 §2 step 2).
 *  Both are documented as idempotent no-ops when already satisfied, so
 *  re-running init re-invokes them and still reports ✓ — no local
 *  "already done" tracking needed. A non-zero exit from either warns with its
 *  stderr and continues (the clone + dashboard are still useful). */
function installPlugin(deps: InitDeps): { status: PluginStatus; warning?: string } {
  const marketplace = deps.claudeCli(['plugin', 'marketplace', 'add', 'IvanMurzak/ai-pipeline-plugin']);
  const install = deps.claudeCli(['plugin', 'install', 'pipeline@ai-pipeline']);
  if (marketplace.code === 0 && install.code === 0) return { status: 'installed' };
  const detail = install.code !== 0 ? install.stderr || install.stdout : marketplace.stderr || marketplace.stdout;
  return {
    status: 'failed',
    warning: `claude plugin install failed: ${(detail || 'no output').trim()}`,
  };
}

export type CloneStatus = 'cloned' | 'already-present' | 'failed';

/** The clone step: pre-checks existence itself (rather than calling
 *  src/commands/clone.ts's CLI wrapper and reading its exit code) because an
 *  existing target is clone's own exit-1 "refuse to overwrite" error — here
 *  it must read as ✓ (already present), never a failure (03 §4). Reuses the
 *  SAME copy-tree primitive clone.ts itself calls (lib/templates.ts). */
function cloneStarter(dir: string, template: string): { status: CloneStatus; dest: string; detail?: string } {
  const dest = join(dir, '.claude', 'pipeline', template);
  if (existsSync(dest)) return { status: 'already-present', dest };
  try {
    copyTemplateTree(template, dest);
    return { status: 'cloned', dest };
  } catch (e) {
    return { status: 'failed', dest, detail: e instanceof Error ? e.message : String(e) };
  }
}

/** POSIX-relative display path, independent of the host path separator, so
 *  human output and --json's `path` field are stable across platforms. */
function relPosixPath(template: string): string {
  return ['.claude', 'pipeline', template].join('/');
}

interface RunOutcome {
  ok: boolean;
  detail?: string;
}

/** Step 5: drive the cloned starter pipeline to completion, printing a
 *  compact per-step line as it goes. Delegates the ENTIRE run engine to
 *  commands/drive.ts's runDrive() (in-process) — this function only
 *  reformats the step.started/step.completed/step.failed progress stream
 *  drive already emits on --json into the target transcript's display; it
 *  does not reimplement any part of run orchestration. */
async function runStarter(root: string, deps: InitDeps): Promise<RunOutcome> {
  let plan;
  try {
    plan = computePlan(root);
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
  if (plan.errors.length > 0) {
    return { ok: false, detail: `pipeline plan errors: ${plan.errors.join('; ')}` };
  }
  const first = plan.steps[0];
  if (!first) return { ok: false, detail: 'the starter pipeline has no steps' };

  const runId = `init-${deps.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const padWidth = Math.max(14, ...plan.steps.map((s) => s.step_id.length + 3));
  const startedAt = new Map<string, number>();
  let lastFailureDetail: string | null = null;

  deps.out(`\n  ▶ ${basename(root)}\n`);

  const errSink = (chunk: string): void => {
    for (const raw of chunk.split('\n')) {
      const line = raw.trim();
      if (!line || line[0] !== '{') continue;
      let evt: Record<string, unknown>;
      try {
        evt = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const event = evt.event;
      const stepId = typeof evt.step_id === 'string' ? evt.step_id : null;
      if (event === 'step.started' && stepId) {
        startedAt.set(stepId, deps.now());
      } else if (event === 'step.completed' && stepId) {
        const t0 = startedAt.get(stepId);
        const secs = t0 !== undefined ? ((deps.now() - t0) / 1000).toFixed(1) : '?';
        deps.out(`    ${stepId.padEnd(padWidth)}✓ ${secs}s\n`);
      } else if (event === 'step.failed' && stepId) {
        lastFailureDetail = typeof evt.reason === 'string' ? evt.reason : 'step failed';
        deps.out(`    ${stepId.padEnd(padWidth)}✗ ${lastFailureDetail}\n`);
      } else if (event === 'step.awaiting_input' && stepId) {
        lastFailureDetail = `step ${stepId} is waiting for input (headless runs cannot answer it): ${
          typeof evt.question === 'string' ? evt.question : ''
        }`.trim();
      } else if (event === 'run.halted' && typeof evt.reason === 'string') {
        lastFailureDetail = evt.reason;
      }
    }
  };

  const code = await deps.runDrive(['--root', root, '--run-id', runId, '--start', first.path, '--json'], {
    err: errSink,
    out: () => {
      /* the final drive JSON report is not needed — per-event progress already
       * printed everything the transcript needs */
    },
  });

  if (code === 0) {
    deps.out(`    ✓ Complete\n`);
    return { ok: true };
  }
  return { ok: false, detail: lastFailureDetail ?? `the starter run exited ${code}` };
}

// ---------------------------------------------------------------------------
// Main composition
// ---------------------------------------------------------------------------

interface JsonResult {
  ok: boolean;
  plugin?: PluginStatus;
  template?: string;
  path?: string;
  ui?: string | null;
  ran?: boolean;
  runOk?: boolean;
  warnings?: string[];
  error?: string;
}

function line(deps: InitDeps, s: string): void {
  deps.out(`  ${s}\n`);
}

export async function runInit(args: string[], deps: InitDeps = realInitDeps): Promise<number> {
  const parsed = parseInitArgs(args);
  if ('error' in parsed) {
    deps.err(`pipeline init: ${parsed.error}\n${USAGE}`);
    return 2;
  }
  if (parsed.help) {
    deps.out(helpText());
    return 0;
  }
  const entry = findTemplate(parsed.template);
  if (!entry) {
    deps.err(
      `pipeline init: unknown template '${parsed.template}'.\n\n` + `Available templates:\n${formatTemplateList()}\n`,
    );
    return 2;
  }

  const dir = resolve(deps.cwd, parsed.dir ?? '.');
  const warnings: string[] = [];

  // --- Step 0: preflight — bun is the one hard precondition (D32). Nothing
  // else can work without it, so this fails loudly before anything else runs.
  if (!deps.bunAvailable()) {
    const msg = 'bun is required and was not found — install it from https://bun.sh, then re-run: pipeline init';
    if (parsed.json) deps.out(JSON.stringify({ ok: false, error: msg } satisfies JsonResult) + '\n');
    else deps.err(`pipeline init: ${msg}\n`);
    return 1;
  }

  if (!parsed.json) {
    deps.out('  Pipeline — local first. No account; nothing goes to ai-pipeline.dev.\n\n');
  }

  // --- Step 1/2: claude on PATH, then the plugin install. A missing `claude`
  // skips BOTH the plugin install and the run (D19) but exits 0 — a
  // precondition, not a failure.
  const claudeFound = deps.claudeAvailable();
  let pluginStatus: PluginStatus = 'skipped';
  if (!claudeFound) {
    warnings.push('claude not found on PATH — the plugin install and the run were skipped');
    if (!parsed.json) {
      line(deps, '⚠ Claude Code not found on PATH — skipping the plugin install and the run.');
    }
  } else {
    if (!parsed.json) line(deps, '✓ Claude Code found');
    if (parsed.noPlugin) {
      // skipped by explicit flag — no additional checklist line, matches --no-ui/--no-run
    } else {
      const res = installPlugin(deps);
      pluginStatus = res.status;
      if (res.status === 'installed') {
        if (!parsed.json) line(deps, '✓ Plugin installed          pipeline@ai-pipeline');
      } else if (res.warning) {
        warnings.push(res.warning);
        if (!parsed.json) line(deps, `⚠ ${res.warning} — continuing (the clone and dashboard are still useful).`);
      }
    }
  }

  // --- Step 3: clone the starter pipeline. Always attempted — there is no
  // --no-clone flag; the clone is the one thing every path needs.
  const clone = cloneStarter(dir, entry.name);
  const relPath = relPosixPath(entry.name);
  if (clone.status === 'failed') {
    const msg = `could not clone the starter pipeline: ${clone.detail ?? 'unknown error'}`;
    if (parsed.json) {
      deps.out(JSON.stringify({ ok: false, error: msg, template: entry.name } satisfies JsonResult) + '\n');
    } else {
      deps.err(`pipeline init: ${msg}\n`);
    }
    return 1;
  }
  if (!parsed.json) {
    const suffix = clone.status === 'already-present' ? ' (already present)' : '';
    line(deps, `✓ Starter pipeline cloned   ${relPath}${suffix}`);
  }

  // --- Step 4: the dashboard.
  let uiUrl: string | null = null;
  if (!parsed.noUi) {
    const ui = await deps.startUi();
    if (ui.disabled) {
      // explicit opt-out — nothing to report, matches --no-ui's silence
    } else if (ui.ok && ui.url) {
      uiUrl = ui.url;
      if (!parsed.json) line(deps, `✓ Dashboard running         ${ui.url}`);
    } else {
      const detail = ui.detail ?? 'the dashboard did not start';
      warnings.push(`dashboard: ${detail}`);
      if (!parsed.json) line(deps, `⚠ Dashboard did not start — ${detail}. Continuing (the pipeline still runs).`);
    }
  }

  // --- Step 5: offer to run. `--json` implies non-interactive and DECLINES
  // the optional run unless --run is also given (D27) — the opposite of the
  // naive reading. A missing `claude` skips this step outright (D19).
  //
  // A failed run's report always names the `claude` login command alongside
  // the raw failure detail (03 §4's "claude present but unauthenticated" row:
  // "report its output and the `claude` login command") — an unauthenticated
  // headless `claude -p` session is the single most common way this step
  // fails, and the raw error text alone rarely says so.
  const reportRunFailure = (detail: string | undefined): void => {
    deps.err(
      `pipeline init: the starter run failed — ${detail ?? 'no detail'}\n` +
        '  If this looks like an authentication problem, run: claude /login\n',
    );
  };

  let ran = false;
  let runOk: boolean | undefined;
  let runFailed = false;
  if (!claudeFound) {
    // already reported above; nothing to run.
  } else if (parsed.noRun) {
    // skipped by explicit flag
  } else if (parsed.json) {
    if (parsed.run) {
      ran = true;
      const outcome = await runStarterQuiet(clone.dest, deps);
      runOk = outcome.ok;
      runFailed = !outcome.ok;
      if (!outcome.ok && outcome.detail) warnings.push(`run failed: ${outcome.detail}`);
    }
    // else: declined — no prompt, ever, in --json mode.
  } else if (parsed.run) {
    ran = true;
    const outcome = await runStarter(clone.dest, deps);
    runOk = outcome.ok;
    runFailed = !outcome.ok;
    if (!outcome.ok) reportRunFailure(outcome.detail);
  } else {
    deps.out('\n');
    const doRun = parsed.yes
      ? (line(deps, 'Run it now? [Y/n] y'), true)
      : await deps.promptYesNo('  Run it now? [Y/n] ');
    if (doRun) {
      ran = true;
      const outcome = await runStarter(clone.dest, deps);
      runOk = outcome.ok;
      runFailed = !outcome.ok;
      if (!outcome.ok) reportRunFailure(outcome.detail);
    }
  }

  // --- Step 6: exactly one next-action line (03 §2 step 6) — printed only
  // when nothing failed (a failed run already reported itself, exit 1).
  if (!runFailed) {
    if (!parsed.json) {
      const nextLine = !claudeFound
        ? 'Install Claude Code, then re-run: pipeline init'
        : parsed.noRun || !ran
          ? `Next: pipeline run ${entry.name}`
          : isSessionLikelyOpen(deps.env)
            ? 'Restart Claude Code to load the plugin.'
            : 'Next: open Claude Code here and type  /pipeline:design <your goal>';
      deps.out(`\n  ${nextLine}\n`);
    }
  }

  if (parsed.json) {
    const result: JsonResult = {
      ok: !runFailed,
      plugin: pluginStatus,
      template: entry.name,
      path: relPath,
      ui: uiUrl,
      ran,
    };
    if (ran) result.runOk = runOk;
    if (warnings.length > 0) result.warnings = warnings;
    deps.out(JSON.stringify(result) + '\n');
  }

  return runFailed ? 1 : 0;
}

/** Same as runStarter but swallows the per-step display (used for
 *  `--json --run`, which prints only the final JSON object — no prompt, no
 *  step lines, per 03 §5). */
async function runStarterQuiet(root: string, deps: InitDeps): Promise<RunOutcome> {
  const quietDeps: InitDeps = { ...deps, out: () => {} };
  return runStarter(root, quietDeps);
}

/** Best-effort, non-authoritative signal for "a Claude Code session is
 *  already open" (03 §2 step 6 / 02 §1). No first-party lock file or session
 *  registry exists to answer this authoritatively (verified against this
 *  repo: hooks only ever WRITE session.opened, with no matching close event,
 *  and no env var advertises live session state to an arbitrary subprocess).
 *  This checks env vars Claude Code plausibly sets for processes it spawns
 *  (a Bash tool call inherits its session's environment) — CLAUDECODE,
 *  CLAUDE_SESSION_ID, CLAUDE_PLUGIN_ROOT. When `pipeline init` runs from a
 *  bare terminal (the documented path) none of these are set, so this
 *  correctly reads "no session running". */
function isSessionLikelyOpen(env: Record<string, string | undefined>): boolean {
  return Boolean(env.CLAUDECODE) || Boolean(env.CLAUDE_SESSION_ID) || Boolean(env.CLAUDE_PLUGIN_ROOT);
}

// Re-exported for tests that want the template registry without a second import.
export { TEMPLATES };
