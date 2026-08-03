// `pipeline init [<template>] [--no-plugin] [--no-run] [--run]
//               [--yes|-y] [--dir <path>] [--json]`
//
// The single local-first entry point (simplified-onboarding design, task a1):
// replaces the documented actions of setting up a project — install the
// plugin, clone a starter pipeline, offer to run it — with one command. See
// .claude/design/simplified-onboarding/03-pipeline-init.md (the contract,
// left as originally shipped — see the note below) and
// 02-target-experience.md §1 (the transcript — it wins on any conflict with
// prose).
//
// plugin-thin 01-remove-local-ui.md phase 1 (2026-08-02): the local dashboard
// used to be a fourth composed step here, started unconditionally as part of
// onboarding. It is being phased out in favor of the cloud dashboard, and
// phase 1 is "stop advertising it, keep it working" — so this command no
// longer starts it or mentions it; `pipeline ui` itself is untouched and
// still works when invoked directly. The immutable design doc above still
// describes the original four-step shape; this comment is the accurate
// record of what ships now.
//
// COMPOSITION, NOT REIMPLEMENTATION. Every side effect below delegates to an
// existing primitive:
//   - clone      → src/lib/templates.ts (the same copy-tree helper
//                  src/commands/clone.ts itself calls; its own idempotency
//                  rule — refuse to overwrite without --force — is checked
//                  here BEFORE calling it, because "already cloned" must read
//                  as a ✓, not clone's own exit-1 "already exists" error).
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
import { DEFAULT_SERVER, SERVER_ENV } from '../lib/cloud-config';
import { computePlan } from '../lib/plan';
import { runDrive, type DriveDeps } from './drive';

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

export interface InitOptions {
  template: string;
  noPlugin: boolean;
  noRun: boolean;
  run: boolean;
  yes: boolean;
  dir?: string;
  json: boolean;
  help: boolean;
  /** `--local`: skip the cloud entirely. The pre-cloud-first behaviour. */
  local: boolean;
  /** Passed through to `cloud connect` (see the cloud step in `runInit`). */
  server?: string;
  org?: string;
  project?: string;
  /** `--no-runner`: connect, but do not enrol THIS machine as a runner. */
  noRunner: boolean;
  /** DEPRECATED `--no-ui`, accepted as a no-op (see the parser). Recorded only
   *  so the run can print the one-line deprecation note. */
  deprecatedNoUi: boolean;
}

const DEFAULT_TEMPLATE = 'support-answer'; // O4 (10-decisions.md)

const USAGE =
  'Usage: pipeline init [<template>] [--local] [--server <url>] [--org <slug>]\n' +
  '                     [--project <slug>] [--no-runner] [--no-plugin]\n' +
  '                     [--no-run] [--run] [--yes|-y] [--dir <path>] [--json]\n';

export function parseInitArgs(args: string[]): InitOptions | { error: string } {
  const out: InitOptions = {
    template: DEFAULT_TEMPLATE,
    noPlugin: false,
    noRun: false,
    run: false,
    yes: false,
    json: false,
    help: false,
    local: false,
    noRunner: false,
    deprecatedNoUi: false,
  };
  let sawTemplate = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    const eq = (p: string) => (a.startsWith(p + '=') ? a.slice(p.length + 1) : undefined);
    /** `--flag value` or `--flag=value`, rejecting a missing value. */
    const takeValue = (flag: string): string | { error: string } => {
      const inline = eq(flag);
      if (inline !== undefined) return inline;
      const v = args[++i];
      if (v === undefined) return { error: `${flag} requires a value` };
      return v;
    };
    if (a === '--no-plugin') out.noPlugin = true;
    else if (a === '--no-run') out.noRun = true;
    else if (a === '--run') out.run = true;
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--local') out.local = true;
    else if (a === '--no-runner') out.noRunner = true;
    // DEPRECATED no-op (plugin-thin phase 1): `init` no longer starts the local
    // dashboard, so there is nothing left for `--no-ui` to suppress. It is still
    // ACCEPTED rather than rejected — a setup script that passes it predates the
    // change and must not start failing with a usage error over a flag whose
    // whole effect was "do less". Same stance as the deprecated `pipeline mesh`
    // alias (commands/mesh.ts): keep working, say so on stderr, remove later.
    else if (a === '--no-ui') out.deprecatedNoUi = true;
    else if (a === '--server' || eq('--server') !== undefined) {
      const v = takeValue('--server');
      if (typeof v !== 'string') return v;
      out.server = v;
    } else if (a === '--org' || eq('--org') !== undefined) {
      const v = takeValue('--org');
      if (typeof v !== 'string') return v;
      out.org = v;
    } else if (a === '--project' || eq('--project') !== undefined) {
      const v = takeValue('--project');
      if (typeof v !== 'string') return v;
      out.project = v;
    } else if (a === '--dir') {
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
  // A cloud flag alongside --local is a contradiction, and silently honouring
  // one of them is how a user ends up connected when they asked not to be.
  if (out.local) {
    const cloudFlag = out.server !== undefined ? '--server' : out.org !== undefined ? '--org' : out.project !== undefined ? '--project' : out.noRunner ? '--no-runner' : undefined;
    if (cloudFlag) return { error: `cannot combine --local and ${cloudFlag}` };
  }
  return out;
}

function helpText(): string {
  return (
    `${USAGE}\n` +
    'One command from a bare project to a completed run you can watch on your\n' +
    'account: authorizes in the browser, connects this project, installs the\n' +
    'Claude Code plugin, clones a starter pipeline, enrols this machine as a\n' +
    'runner, and offers to run it.\n\n' +
    'It connects to the cloud BY DEFAULT. `--local` does everything except\n' +
    'that, and sends nothing anywhere.\n\n' +
    'Options:\n' +
    '  <template>       Starter pipeline to clone. Default: support-answer.\n' +
    '                   Same names as `pipeline clone --list`.\n' +
    '  --local          Skip the cloud entirely: no browser, no account, no\n' +
    '                   network to ai-pipeline.dev.\n' +
    '  --server <url>   Control plane to connect to. Default: api.ai-pipeline.dev.\n' +
    '  --org <slug>     Organization to bind to. Omit and, on a brand-new\n' +
    '                   account, your first one is created for you.\n' +
    '  --project <slug> Project slug for the binding. Default: this folder.\n' +
    '  --no-runner      Connect, but do not enrol this machine as a runner.\n' +
    '  --no-plugin      Skip the Claude Code plugin install.\n' +
    '  --no-run         Do not offer to run the starter pipeline.\n' +
    '  --run            Run the starter pipeline without asking (pairs with --json).\n' +
    '  --yes, -y        Assume yes to every prompt.\n' +
    '  --dir <path>     Target project root. Default: cwd.\n' +
    '  --json           Non-interactive: never opens a browser, and declines\n' +
    '                   every optional side effect (the run) unless --run is\n' +
    '                   also given. Connects only with PIPELINE_MACHINE_TOKEN.\n\n' +
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

/** What the cloud step reports back to the checklist. */
export interface CloudConnectResult {
  status: 'connected' | 'skipped' | 'failed';
  /** Why, when the status is not `connected` — printed verbatim. */
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
  /** Runs `pipeline cloud connect <args>` in-process. Defaults to the real
   *  `runCloud` — init COMPOSES the connect command rather than reproducing
   *  the auth ladder, exactly as it composes `runDrive`. There is one browser
   *  flow, one device flow and one machine-credential exchange in this
   *  package, and this is not a second set. */
  cloudConnect: (args: string[]) => Promise<number>;
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
  // Lazy import, mirroring `cli.ts`'s own reason for lazily importing `cloud`:
  // it pulls in the HTTP device-flow + loopback-server machinery, which a
  // `--local` init must never load.
  //
  // In `--json` mode `cloud connect` prints its OWN result object to stdout,
  // which would make `pipeline init --json` emit two JSON documents and break
  // every `JSON.parse(stdout)` reading it. Init owns the single-object
  // contract, so it swallows that one — connect's human-facing progress
  // already goes to stderr under `--json` (its own `say()`), so nothing
  // diagnostic is lost, and a failure still arrives as a non-zero exit code.
  cloudConnect: async (args) => {
    const { runCloud, realDeps } = await import('./cloud');
    const quiet = args.includes('--json');
    return runCloud(['connect', ...args], quiet ? { ...realDeps, out: () => {} } : realDeps);
  },
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
 *  stderr and continues (the clone is still useful). */
function installPlugin(deps: InitDeps): { status: PluginStatus; warning?: string } {
  const marketplace = deps.claudeCli(['plugin', 'marketplace', 'add', 'IvanMurzak/pipeline-claude-marketplace']);
  const install = deps.claudeCli(['plugin', 'install', 'pipeline@ai-pipeline']);
  if (marketplace.code === 0 && install.code === 0) return { status: 'installed' };
  const detail = install.code !== 0 ? install.stderr || install.stdout : marketplace.stderr || marketplace.stdout;
  return {
    status: 'failed',
    warning: `claude plugin install failed: ${(detail || 'no output').trim()}`,
  };
}

/** The env var that names a machine credential — the ONE rung of the auth
 *  ladder that needs no browser and no TTY (`commands/cloud.ts`). */
const MACHINE_TOKEN_ENV = 'PIPELINE_MACHINE_TOKEN';

/** Where a connected run is visible. Resolved the same way `cloud connect`
 *  resolves its own server (flag, then the env var, then the default), so the
 *  line init prints can never name a different host than the one it just
 *  bound the project to. Imported from `lib/cloud-config.ts` rather than
 *  re-spelled, so there is one literal for this URL in the package. */
function dashboardUrl(opts: InitOptions, env: Record<string, string | undefined>): string {
  return (opts.server ?? env[SERVER_ENV] ?? DEFAULT_SERVER).replace(/\/+$/, '');
}

/**
 * Whether the cloud step may run, and if not, why — as a sentence a user can
 * act on. Pure, so the whole decision table is testable without a network.
 *
 * The rule that matters: `--json` NEVER opens a browser. `--json` is what CI,
 * a bot and an agent use, and there is no human there to approve a consent
 * screen — a browser flow would block until its five-minute timeout and then
 * fail. With a machine credential the connect is silent by construction, so it
 * proceeds; without one, the cloud step is skipped and the rest of init still
 * runs (exit 0), because a local setup is a perfectly good outcome and not
 * something CI should fail on.
 */
export function cloudStepDecision(
  opts: InitOptions,
  env: Record<string, string | undefined>,
): { run: true } | { run: false; reason: string | null } {
  // `--local` is an explicit opt-out; it gets no explanation line, exactly
  // like --no-run.
  if (opts.local) return { run: false, reason: null };
  const machineToken = env[MACHINE_TOKEN_ENV]?.trim();
  if (opts.json && !machineToken) {
    return {
      run: false,
      reason: `--json cannot open a browser — set ${MACHINE_TOKEN_ENV} to connect non-interactively, or run without --json`,
    };
  }
  return { run: true };
}

/** The `cloud connect` argv this init composes. Pure — the flag pass-through
 *  is exactly the kind of thing that silently drops one flag in a refactor. */
export function cloudConnectArgs(opts: InitOptions): string[] {
  const args: string[] = [];
  if (opts.server !== undefined) args.push('--server', opts.server);
  if (opts.org !== undefined) args.push('--org', opts.org);
  if (opts.project !== undefined) args.push('--project', opts.project);
  // Runner enrolment is answered rather than asked: `init`'s whole promise is
  // that the first run happens without further questions, and a machine that
  // is not a runner cannot pick up cloud-dispatched work.
  args.push(opts.noRunner ? '--no-runner' : '--runner');
  if (opts.json) args.push('--json');
  return args;
}

export type CloneStatus = 'cloned' | 'already-present' | 'failed';

/** The clone step: pre-checks existence itself (rather than calling
 *  src/commands/clone.ts's CLI wrapper and reading its exit code) because an
 *  existing target is clone's own exit-1 "refuse to overwrite" error — here
 *  it must read as ✓ (already present), never a failure (03 §4). Reuses the
 *  SAME copy-tree primitive clone.ts itself calls (lib/templates.ts). */
function cloneStarter(dir: string, template: string): { status: CloneStatus; dest: string; detail?: string } {
  const dest = join(dir, '.pipeline', template);
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
  return ['.pipeline', template].join('/');
}

interface RunOutcome {
  ok: boolean;
  detail?: string;
}

/** Step 4: drive the cloned starter pipeline to completion, printing a
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
  /** 'connected' | 'skipped' | 'failed' — a script reads THIS rather than
   *  grepping the warnings list to find out whether the cloud half happened. */
  cloud?: CloudConnectResult['status'];
  plugin?: PluginStatus;
  template?: string;
  path?: string;
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
  if (parsed.deprecatedNoUi) {
    // Stderr, not stdout: `init --json` owns the one-JSON-document contract on
    // stdout, so a note there would corrupt it for every scripted caller — which
    // is precisely the population still passing this flag.
    deps.err('pipeline init: --no-ui is deprecated and does nothing — init no longer starts the local dashboard.\n');
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

  const cloudDecision = cloudStepDecision(parsed, deps.env);

  if (!parsed.json) {
    deps.out(
      cloudDecision.run
        ? '  Pipeline — connecting to ai-pipeline.dev. Your keys and your code stay here.\n\n'
        : '  Pipeline — local only. No account; nothing goes to ai-pipeline.dev.\n\n',
    );
  }

  // --- Step 0.5: the cloud. FIRST, and by default (the browser consent is the
  // one thing that needs a human, so it should not wait behind a plugin
  // install and a clone). A failure here is a WARNING, never fatal: everything
  // below works unconnected, and an init that aborted on a declined consent
  // screen would leave the user with nothing at all.
  let cloud: CloudConnectResult = { status: 'skipped' };
  if (cloudDecision.run) {
    try {
      const code = await deps.cloudConnect(cloudConnectArgs(parsed));
      cloud =
        code === 0
          ? { status: 'connected' }
          : { status: 'failed', detail: `cloud connect exited ${code}` };
    } catch (e) {
      cloud = { status: 'failed', detail: e instanceof Error ? e.message : String(e) };
    }
    if (cloud.status === 'failed') {
      warnings.push(`cloud: ${cloud.detail ?? 'connect failed'} — continuing locally`);
      if (!parsed.json) {
        line(deps, `⚠ Not connected — ${cloud.detail}. Continuing locally; re-run: pipeline cloud connect`);
      }
    }
  } else if (cloudDecision.reason !== null) {
    cloud = { status: 'skipped', detail: cloudDecision.reason };
    warnings.push(`cloud: ${cloudDecision.reason}`);
    if (!parsed.json) line(deps, `⚠ Not connected — ${cloudDecision.reason}.`);
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
      // skipped by explicit flag — no additional checklist line, matches --no-run
    } else {
      const res = installPlugin(deps);
      pluginStatus = res.status;
      if (res.status === 'installed') {
        if (!parsed.json) line(deps, '✓ Plugin installed          pipeline@ai-pipeline');
      } else if (res.warning) {
        warnings.push(res.warning);
        if (!parsed.json) line(deps, `⚠ ${res.warning} — continuing (the clone is still useful).`);
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

  // --- Step 4: offer to run. `--json` implies non-interactive and DECLINES
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

  // --- Step 5: exactly one next-action line (03 §2 step 6) — printed only
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
      // A connected run is visible on the account; say where. Only when a run
      // actually happened — pointing someone at an empty dashboard is worse
      // than saying nothing.
      if (cloud.status === 'connected' && ran) {
        deps.out(`  This run is on your dashboard: ${dashboardUrl(parsed, deps.env)}\n`);
      }
    }
  }

  if (parsed.json) {
    const result: JsonResult = {
      ok: !runFailed,
      cloud: cloud.status,
      plugin: pluginStatus,
      template: entry.name,
      path: relPath,
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
