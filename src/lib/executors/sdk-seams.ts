// executors/sdk-seams.ts — the OTHER TWO `standalone` runners: improver and
// script-creator (c4, 02-standalone-executor.md E6 / the Work table's
// "improver / script-creator" row: *"the SDK runner covers all three or the
// mode is only half-implemented"*).
//
// ── WHY THIS FILE IS SMALL, AND MUST STAY SMALL ───────────────────────────
//
// `DriveDeps` carries THREE `ExecutorRunner` seams — `executor`, `improver`,
// `scriptCreator`. c3 built the runner; it is complete and it is not
// re-implemented here. The two self-improvement seams differ from the step
// seam in exactly three values:
//
//   | seam           | agent                            | schema                       | permission mode |
//   | step           | pipeline:step-executor           | STEP_RECORD_SCHEMA           | the step's own  |
//   | improver       | pipeline:pipeline-improver       | IMPROVER_RECORD_SCHEMA       | acceptEdits     |
//   | script-creator | pipeline:pipeline-script-creator | SCRIPT_CREATOR_RECORD_SCHEMA | acceptEdits     |
//
// …which is precisely the difference the three `claude -p` templates in
// `commands/drive.ts` encode as flags. TRANSPORT IS IDENTICAL, so this module
// calls {@link sdkExecutor} three times and adds nothing else. If a future
// change makes one of these seams need its own stream handling, its own exit
// mapping or its own recovery, that is a signal the seams have diverged in
// substance and belongs in a design note — not a fourth runner quietly copied
// in here.
//
// ── WHY ALL THREE COME OUT OF ONE CALL ────────────────────────────────────
//
// {@link sdkDriveSeams} returns all three seams TOGETHER, and there is no
// exported way to build just one. That shape is the whole point of c4.
//
// The failure this task exists to prevent is not a crash. It is a run that
// selects the SDK executor, executes every step through the SDK — and then,
// the first time self-improvement or script creation fires, silently spawns
// `claude -p` because only `DriveDeps.executor` was wired. Nothing reports it:
// the improver record that comes back is well-formed, the run completes, the
// terminal JSON looks right. The only visible symptom is a `claude` binary
// being required by a mode whose entire premise is not needing one — on a
// machine that may not have it, in a container that certainly does not.
//
// A caller therefore cannot select "the SDK executor" and get a subprocess
// improver by omission, because the object that carries one carries all three.
// `tests/sdk-seams.test.ts` proves the negative two independent ways: a static
// closure walk showing nothing reachable from this module can spawn a process
// at all, and a live `runDrive` with an armed spawn tripwire — plus the
// deliberate one-seam regression, to show the tripwire fires when the bug is
// present.
//
// ── ENVIRONMENT TEMPLATE OVERRIDES: REPORTED, NEVER SILENTLY DROPPED ──────
//
// `PIPELINE_DRIVE_EXECUTOR_CMD`, `PIPELINE_DRIVE_IMPROVER_CMD` and
// `PIPELINE_DRIVE_SCRIPT_CREATOR_CMD` override a `claude -p` COMMAND TEMPLATE.
// This executor runs no command, so there is no template for them to override
// and no honest way to apply them: their value is an argv, and an argv has
// nowhere to go in a `query({ prompt, options })` call. Honouring them by
// falling back to a subprocess for that one seam would re-create the exact
// split-brain run described above, on purpose.
//
// So the answer is the other branch: they DO NOT APPLY, and the run SAYS SO —
// one line per variable, on the run's own stderr sink, at the moment the seams
// are built. See {@link sdkSeamOverrideWarnings}. They keep working unchanged
// for `claude-cli`/`codex-cli`, which is where they mean something.

import { IMPROVER_RECORD_SCHEMA, SCRIPT_CREATOR_RECORD_SCHEMA } from '../improver-schema';
import { STEP_RECORD_SCHEMA } from '../step-schema';
import { sdkExecutor, type SdkExecutorOptions, type SdkPermissionMode } from './sdk';
import type { ExecutorRunner } from '../../commands/drive';

// ---------------------------------------------------------------------------
// The three agents, and the one permission mode
// ---------------------------------------------------------------------------
//
// These mirror `commands/drive.ts`'s DEFAULT_*_TEMPLATE flags. They are
// declared here rather than imported from there ON PURPOSE: `drive.ts` is the
// module that will IMPORT this one (c5 wires the selection), and a value
// import back into it would close a runtime cycle. `tests/sdk-seams.test.ts`
// parses the three templates and asserts every constant below still matches
// the flag it mirrors, so the duplication is checked rather than trusted —
// change a template's `--agent` and that test fails, naming this file.

/** `--agent pipeline:step-executor` (DEFAULT_EXECUTOR_TEMPLATE). */
export const SDK_STEP_AGENT = 'pipeline:step-executor';

/** `--agent pipeline:pipeline-improver` (DEFAULT_IMPROVER_TEMPLATE). */
export const SDK_IMPROVER_AGENT = 'pipeline:pipeline-improver';

/** `--agent pipeline:pipeline-script-creator` (DEFAULT_SCRIPT_CREATOR_TEMPLATE). */
export const SDK_SCRIPT_CREATOR_AGENT = 'pipeline:pipeline-script-creator';

/**
 * `--permission-mode acceptEdits`, hardcoded in BOTH self-improvement
 * templates and not derived from the request.
 *
 * This one needs saying out loud, because it is the only place the SDK path
 * would silently differ from the CLI path if it were left out.
 * `runSelfImproveSession` builds its `ExecutorRequest` with
 * `permission_mode: null` — the improver's mode was never carried on the
 * request, it was baked into the template's flags. Under `claude -p` that is
 * fine; the flag is right there in the string. Under the SDK, a null request
 * field maps to an ABSENT `permissionMode`, the SDK applies its own default,
 * and a headless session that cannot answer a permission prompt stalls or
 * refuses the edits it exists to make.
 *
 * So the fallback is explicit, and it MIRRORS the two CLI templates rather than
 * reasoning independently — `tests/sdk-seams.test.ts` fails if the two ever
 * disagree, which is the only thing keeping the SDK port honest.
 *
 * It was `acceptEdits`, "because a headless session cannot answer prompts".
 * The premise was right and the conclusion too small: a session that cannot
 * answer prompts is not merely at risk of stalling on an EDIT, it is denied
 * everything the mode does not pre-approve — and the improver shells out. See
 * DEFAULT_STEP_PERMISSION_MODE in `commands/drive.ts` for the full argument.
 */
export const SDK_SELF_IMPROVE_PERMISSION_MODE: SdkPermissionMode = 'bypassPermissions';

// ---------------------------------------------------------------------------
// Template environment overrides — the inapplicability report
// ---------------------------------------------------------------------------

/** The three command-template environment overrides, each with the seam it
 *  governs, in the order a reader of `drive.ts` meets them. */
export const TEMPLATE_OVERRIDE_ENV: ReadonlyArray<{ variable: string; seam: string; agent: string }> = [
  { variable: 'PIPELINE_DRIVE_EXECUTOR_CMD', seam: 'step executor', agent: SDK_STEP_AGENT },
  { variable: 'PIPELINE_DRIVE_IMPROVER_CMD', seam: 'improver', agent: SDK_IMPROVER_AGENT },
  { variable: 'PIPELINE_DRIVE_SCRIPT_CREATOR_CMD', seam: 'script-creator', agent: SDK_SCRIPT_CREATOR_AGENT },
];

/**
 * One warning line per command-template override that is SET but cannot apply
 * to an SDK-backed seam. Empty when none is set, which is the normal case.
 *
 * The wording has a job beyond politeness: a user who set the variable did so
 * to change what runs, so the line must say that it did not, why it could not,
 * what runs instead, and how to get the old behaviour back. "Ignoring
 * PIPELINE_DRIVE_IMPROVER_CMD" alone would leave them guessing at all four.
 *
 * Pure and exported so the report can be asserted directly, rather than
 * inferred from whatever reached a stderr buffer.
 */
export function sdkSeamOverrideWarnings(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  for (const { variable, seam, agent } of TEMPLATE_OVERRIDE_ENV) {
    const value = env[variable];
    if (typeof value !== 'string' || value.trim() === '') continue;
    out.push(
      `pipeline drive: ${variable} does NOT apply to the SDK executor and was not used. ` +
        `It overrides a \`claude -p\` command template, and this executor spawns no command — ` +
        `the ${seam} runs in-process through the Agent SDK with the ${agent} agent. ` +
        `Re-run with a CLI executor to keep the override.`,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// The factory
// ---------------------------------------------------------------------------

/** Options shared by all three seams. The per-seam values — `schema`, `agent`
 *  and the self-improvement permission mode — are set by
 *  {@link sdkDriveSeams} and are therefore not settable here: a caller that
 *  could hand the improver the step schema could produce records of the wrong
 *  shape, which is a failure `drive` cannot detect (it would parse them
 *  defensively and report `applied: false`). */
export type SdkSeamOptions = Omit<SdkExecutorOptions, 'schema' | 'agent' | 'permissionMode'> & {
  /**
   * The plugin root to load, i.e. what `--plugin-dir {plugin_dir}` expands to
   * in all three templates. Under the SDK there is NO plugin auto-discovery
   * (02 K-3), so without this the `pipeline:*` agent names above resolve to
   * nothing. Defaults to `CLAUDE_PLUGIN_ROOT`; absent/blank ⇒ no `plugins`
   * option at all, mirroring `buildExecutorArgv` dropping the flag+token pair
   * rather than expanding it to an empty string.
   *
   * An explicit `plugins` array on the same options object WINS — this is the
   * convenience path, not a second source of truth.
   */
  pluginDir?: string | null;
};

/** The three `DriveDeps` runner seams, produced together. Assignable straight
 *  into `DriveDeps` — `runDrive(args, { ...sdkDriveSeams(opts) })`. */
export interface SdkDriveSeams {
  executor: ExecutorRunner;
  improver: ExecutorRunner;
  scriptCreator: ExecutorRunner;
}

/** The plugin config for a resolved plugin root, or no config at all. */
function pluginsFor(opts: SdkSeamOptions): Pick<SdkExecutorOptions, 'plugins'> {
  if (opts.plugins !== undefined) return { plugins: opts.plugins };
  const dir = opts.pluginDir === undefined ? process.env.CLAUDE_PLUGIN_ROOT : opts.pluginDir;
  if (typeof dir !== 'string' || dir.trim() === '') return {};
  return { plugins: [{ type: 'local', path: dir }] };
}

/**
 * Build all three SDK-backed `ExecutorRunner`s.
 *
 * Every seam gets the SAME transport (c3's {@link sdkExecutor}), the same
 * stderr sink, the same progress hook, the same `settingSources` decision and
 * the same environment overlay. They differ only by the row of the table at
 * the top of this file.
 *
 * The inapplicable-override report (see {@link sdkSeamOverrideWarnings}) is
 * emitted HERE, once, at construction — not per spawn. A run that fires the
 * improver eleven times must not print the same warning eleven times, and a
 * run that never fires it must still be told that the variable it set did
 * nothing.
 *
 * It goes to `opts.err` and nowhere else. Without an `err` sink there is no
 * report — which is not the silent drop this design forbids but the ONE case
 * where it cannot be otherwise: `err` is the run's whole output channel (c3
 * documents an absent one as "discard"), so a caller that supplies none has
 * opted out of every warning this executor can produce, not just this one.
 * `drive` always supplies one. A caller that wants the lines without a sink
 * calls {@link sdkSeamOverrideWarnings} directly — it is exported for exactly
 * that.
 */
export function sdkDriveSeams(opts: SdkSeamOptions = {}): SdkDriveSeams {
  // `schema`, `agent` and `permissionMode` are stripped rather than merely
  // overridden. The type already forbids them, but an untyped caller reaching
  // this function must not be able to leave a stray `permissionMode` on the
  // step seam (the one seam below that deliberately sets no fallback) — and a
  // stray `schema` on any seam would silently produce records of the wrong
  // shape, which `drive` parses defensively instead of reporting.
  const {
    pluginDir: _pluginDir,
    plugins: _plugins,
    ...rest
  } = opts as SdkSeamOptions & Pick<SdkExecutorOptions, 'schema' | 'agent' | 'permissionMode'>;
  const { schema: _schema, agent: _agent, permissionMode: _permissionMode, ...shared } = rest;
  const base: SdkExecutorOptions = { ...shared, ...pluginsFor(opts) };

  const err = opts.err;
  if (err !== undefined) {
    for (const line of sdkSeamOverrideWarnings()) err(line + '\n');
  }

  return {
    executor: sdkExecutor({
      ...base,
      agent: SDK_STEP_AGENT,
      schema: STEP_RECORD_SCHEMA as unknown as Record<string, unknown>,
      // No permission-mode fallback: the step template spells `{permissions}`,
      // so the resolved value rides the request and null genuinely means
      // "inherit machine settings" there.
    }),
    improver: sdkExecutor({
      ...base,
      agent: SDK_IMPROVER_AGENT,
      schema: IMPROVER_RECORD_SCHEMA as unknown as Record<string, unknown>,
      permissionMode: SDK_SELF_IMPROVE_PERMISSION_MODE,
    }),
    scriptCreator: sdkExecutor({
      ...base,
      agent: SDK_SCRIPT_CREATOR_AGENT,
      schema: SCRIPT_CREATOR_RECORD_SCHEMA as unknown as Record<string, unknown>,
      permissionMode: SDK_SELF_IMPROVE_PERMISSION_MODE,
    }),
  };
}
