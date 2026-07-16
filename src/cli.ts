#!/usr/bin/env bun
// pipeline — the unified Claude-Pipeline CLI.
//
// Commands: `plan`, `match`, `event`, `route`, `next`, `gc`, `ci-wait`, `ui`, `logs`.
// Each is a deterministic, LLM-free computation the agents shell out to
// instead of doing in-context — keeping per-iteration token cost near zero.
// (`ui` is a thin launcher for the dashboard daemon, `logs` a read-only
// terminal tail of the event journal, and `gc` a git worktree/branch janitor,
// rather than pure computations.)

import { runPlan } from './commands/plan';
import { runMatch } from './commands/match';
import { runEvent } from './commands/event';
import { runRoute } from './commands/route';
import { runNext } from './commands/next';
import { runUi } from './commands/ui';
import { runLogs } from './commands/logs';
import { runSubmodule } from './commands/submodule';
import { runRelease } from './commands/release';
import { runStep } from './commands/step-run';

const VERSION = '0.1.0';

function usage(): string {
  return [
    'pipeline — Claude-Pipeline CLI',
    '',
    'Usage: pipeline <command> [options]',
    '',
    'Commands:',
    '  plan --root <pipeline_root> [--default-model <m>] [--model <step_id>=<m> ...]',
    '       [--default-effort <level>] [--effort <step_id>=<level> ...]',
    '      Compute the execution plan (mode, isolation, ordered steps with',
    '      resolved models + reasoning efforts, DAG layers, validation) as JSON.',
    '      Repeatable --model/--effort pin single steps for THIS run (beat the',
    '      step\'s own frontmatter). Effort levels: low|medium|high|xhigh|max|inherit.',
    '',
    '  match --pipelines-dir <dir> (--task <t> | --issue <ref>)',
    '        [--top <n>] [--neg-threshold <n>]',
    '      Match a task (or GitHub issue) against PIPELINE.md manifests via',
    '      BM25 positive scoring + Scope.Out keyword hard-filter. Prints JSON.',
    '',
    '  event <event-type|register-mirror-binding|write-liveness|clear-liveness>',
    '        [--project-root=/abs] [k=v ...]',
    '      Emit a Pipeline UI event to the project event journal (or manage',
    '      mirror bindings / per-run liveness lockfiles). Always exits 0.',
    '',
    '  route --root <pipeline_root> --run-id <id> --from <step_id>',
    '        --flags <json> [--default-model <m>]',
    '      Decide the next step for a graph (Variant-A) pipeline from the',
    '      routing graph + result flags + per-run edge counters. Prints the',
    '      next action JSON (run/done/halt); exit 1 on halt.',
    '',
    '  next --root <pipeline_root> --run-id <id> [--start <iteration-path>]',
    '       [--default-model <m>] [--model <step_id>=<m> ...]',
    '       [--default-effort <level>] [--effort <step_id>=<level> ...]',
    '       [--record <json> | --record-file <path>] [--resume]',
    '      Drive ONE pipeline run as a mechanical state machine: returns the',
    '      next orchestration action (run-step / run-improver / run-script-creator /',
    '      merge / retrospective / done / halt / blocked) given the run state +',
    '      the record of the action just performed (--record-file reads the same',
    '      record JSON from a UTF-8 file instead of inline argv). Folds',
    '      sequential/graph/DAG advancement and improver/script/retrospective',
    '      gating into code. Repeatable --model <step_id>=<m> / --effort',
    '      <step_id>=<level> override single steps for THIS run (persisted at',
    '      init — loop calls and resumes keep them; beat the step\'s frontmatter).',
    '',
    '  drive --root <pipeline_root> --run-id <id> --start <iteration-path>',
    '        [--default-model <m>] [--model <step_id>=<m> ...]',
    '        [--default-effort <level>] [--effort <step_id>=<level> ...] [--resume]',
    '        [--answer <text> | --answer-file <path>]',
    '        [--task <text> | --task-file <path>]',
    '        [--executor-cmd <template>] [--json]',
    '      EXPERIMENTAL headless runner: executes an ENTIRE pipeline run with NO',
    '      pipeline-manager LLM agent, looping over the same engine as `next` and',
    '      spawning each step-executor as a headless subprocess (default:',
    "      `claude -p --agent pipeline:step-executor --model {model}",
    '       --effort {effort} --permission-mode {permissions} --session-id {session}',
    '       --output-format json --json-schema {schema}`, prompt on stdin;',
    '      override the whole template with --executor-cmd or the env var',
    '      PIPELINE_DRIVE_EXECUTOR_CMD). The step record is taken from the',
    "      envelope's schema-validated structured_output (fallback: the record",
    '      file the executor wrote); envelope usage/cost feeds .stats/. Every',
    '      session is pinned to a UUID (.runtime/<run-id>/sessions/) — a step',
    '      that reports outcome needs-input parks the run (exit 4, question in',
    '      the final JSON); re-run with --resume --start <same-iteration>',
    '      --answer "<text>" and the SAME session resumes with the answer.',
    "      Per-step permissions: `permission-mode:` frontmatter (step, then",
    '      manifest, then acceptEdits; `inherit` drops the flag). v1 SKIPS',
    '      self-improvement (improver / script-creator / retrospective are',
    '      recorded as skipped; feedback is left in .feedback/<run-id>/ for a',
    '      manual pass). Exit 0 completed / 1 halted / 2 usage / 3 blocked',
    '      (resolve the blocker, re-run --resume) / 4 awaiting-input (answer,',
    '      re-run --resume --answer).',
    '',
    '  ui [--open] [--json] [--restart]',
    '      Start (if needed) and point at the local dashboard daemon. Thin',
    '      launcher: detects/spawns the shared Bun daemon, registers the current',
    '      project, prints the URL (--open also opens a browser). --restart asks',
    '      a running daemon to hand off to the newest installed plugin version',
    '      (or re-exec itself) and waits for the successor.',
    '',
    '  logs [--follow|-f] [--tail <n>] [--all] [--json] [--no-color]',
    '       [--project <path>]',
    '      Tail the event journal (.runtime/events.jsonl) to the terminal,',
    '      pretty-printing each event as it appears. Read-only and daemon-free —',
    '      works regardless of PIPELINE_UI_ENABLED (the UI is off by default).',
    '',
    '  gc [--project <path>] [--clean] [--json] [--no-submodules]',
    '     [--force-worktree-branches]',
    '      Verify (and with --clean, reap) leaked pipeline worktrees/branches:',
    '      reports registered worktrees under .claude/worktrees with merged',
    '      state, stale unregistered directories, prunable worktree records,',
    '      and orphaned worktree-* branches (squash-merged branches read as',
    '      unmerged — report-only). Initialized git submodules get the SAME scan',
    '      by default (runs leak one worktree-* branch into each submodule):',
    '      each submodule reports its own default branch, orphaned worktree-*',
    '      branches, worktrees registered under the superproject\'s',
    '      .claude/worktrees, and prunable records; --no-submodules skips it.',
    '      --clean prunes records, removes fully-merged worktrees, deletes stale',
    '      dirs, and safe-deletes (git branch -d, never -D) merged branches —',
    '      per submodule too — never touching the current branch/worktree; it',
    '      prints exactly what was kept and why. --force-worktree-branches',
    '      (requires --clean) additionally git branch -D UNMERGED worktree-*',
    '      branches: squash-merged run branches read as unmerged forever, so -d',
    '      can never reap them; only the machine-owned worktree-* namespace is',
    '      eligible and never the current branch. Always exits 0 (2 on usage).',
    '',
    '  ci-wait [--pr <number|url|branch> | --branch <name> | --sha <sha>]',
    '          [--repo <path>] [--timeout <sec>] [--interval <sec>] [--grace <sec>]',
    '          [--fail-fast|--no-fail-fast] [--json] [--verbose]',
    '      Token-efficient CI gate: block until GitHub CI reaches a terminal',
    '      state for a pull request (--pr, via `gh pr checks`) or a commit on a',
    '      branch (--branch/--sha via the check-runs API; no selector = the',
    "      repo's default branch, sha pinned once at start). Polls `gh`",
    '      IN-PROCESS and prints ONE compact result — no LLM poll loop. FAILS',
    '      FAST by default: the FIRST failed check ends the wait immediately,',
    '      even while other jobs still run or hang (--no-fail-fast waits for the',
    '      full picture), and --timeout caps stuck-forever CI. Exit 0 all',
    '      passed / 1 a check failed / 2 usage or gh missing / 3 timeout',
    '      (default 1800s) / 4 no checks appeared within --grace (default 120s).',
    '',
    '  submodule bump --project-root <path> [--submodules a,b] [--base <branch>]',
    '                 [--source-worktree <path>] [--dry-run] [--json]',
    '      Guarded submodule-pointer bump: record superproject pointer change(s)',
    '      on the base branch and push them, isolation-safely (throwaway worktree',
    '      off origin/<base>; the shared checkout is only ever fetch + merge',
    '      --ff-only). Auto-detects drifted pointers when --submodules is omitted.',
    '      Prints one JSON result; exit 0 (committed/noop/dry-run) / 1 (halted) /',
    '      2 (usage/env).',
    '',
    '  stats [--project <path>] [--json]',
    '      View per-run measurements (duration, per-step timings, outcomes,',
    '      tokens) recorded under <project>/.claude/pipeline/.stats/ by the',
    '      always-on stats system (pure software, no LLM; disable with',
    '      PIPELINE_STATS_ENABLED=0). Regenerates and prints SUMMARY.md;',
    '      --json dumps every run record. Per-run timelines live at',
    '      .stats/<pipeline>/runs/<run-id>.log.',
    '',
    '  release <patch|minor|major> [--plugin-root <path>] [--dry-run] [--json]',
    '      Bump the semver `version` in the plugin\'s .claude-plugin/plugin.json',
    '      (Claude Code caches plugins by name@version) and print the manual',
    '      follow-up checklist. NO git operations — it only edits plugin.json.',
    '',
    '  migrate --to <N> [--dry-run] [--root <dir>] [--json]',
    '      Migrate a pipeline folder (PIPELINE.md + steps/**) to format <N> along',
    '      the paired up/down transform ladder. --dry-run shows the diff and writes',
    '      nothing; without it the migrated result must pass plan-lint or the',
    '      migration ABORTS (never a half-migrated tree). Exit 0 ok/nothing-to-do /',
    '      1 failure or lint-abort / 2 usage. (Skeleton: the production ladder is',
    '      empty at format 1, so the only real migration today is the no-op --to 1.)',
    '',
    '  cloud connect [--server <url>] [--project <slug>] [--org <slug>]',
    '                [--reauth] [--json]',
    '      Link this project to the cloud control plane: run the device-flow',
    '      auth, store the session credential in a secure per-user location, and',
    '      write the NON-SECRET org/project binding to',
    '      .claude/pipeline/cloud.json (slugs + URL only — safe to commit; the',
    '      token never touches the project). Re-running updates the binding.',
    '      Exit 0 connected/updated · 1 auth/network failure · 2 usage.',
    '',
    '  step run <iteration.md> [--param <name>=<value> ...] [--json]',
    '      Dry-run ONE `type: script` step exactly as the runtime would (same',
    '      Params/binding parsing + spawn/classify machinery), printing the',
    '      result + would-be step record. Never touches run state (.runtime/ or',
    '      .feedback/). `${steps…}` / `${run.task}` bindings have no run to read,',
    '      so each REQUIRES a --param override (else exit 2). --param values parse',
    '      as JSON when possible, else string. Exit 0 ok / 1 script failed (any',
    '      class) / 2 usage (missing/agent step, unresolved refs, plan errors).',
    '',
  ].join('\n');
}

async function main(argv: string[]): Promise<number> {
  const command = argv[2];
  const rest = argv.slice(3);
  switch (command) {
    case 'plan':
      return runPlan(rest);
    case 'match':
      return runMatch(rest);
    case 'event':
      return runEvent(rest);
    case 'route':
      return runRoute(rest);
    case 'next':
      return runNext(rest);
    case 'drive': {
      // Lazy import: `drive` is EXPERIMENTAL and pulls in the subprocess/git
      // machinery — keep the hot `next` loop's per-spawn startup cost unchanged.
      const { runDrive } = await import('./commands/drive');
      return runDrive(rest);
    }
    case 'gc': {
      // Lazy import (mirrors `drive`): `gc` pulls in the git subprocess
      // machinery — keep the hot `next` loop's per-spawn startup cost unchanged.
      const { runGc } = await import('./commands/gc');
      return runGc(rest);
    }
    case 'ci-wait': {
      // Lazy import (mirrors `drive`/`gc`): `ci-wait` pulls in the gh subprocess
      // machinery — keep the hot `next` loop's per-spawn startup cost unchanged.
      const { runCiWait } = await import('./commands/ci-wait');
      return runCiWait(rest);
    }
    case 'ui':
      return runUi(rest);
    case 'logs':
      return runLogs(rest);
    case 'submodule':
      return runSubmodule(rest);
    case 'stats': {
      // Lazy import (mirrors `drive`/`gc`): keep the hot `next` loop's
      // per-spawn startup cost unchanged.
      const { runStats } = await import('./commands/stats');
      return runStats(rest);
    }
    case 'release':
      return runRelease(rest);
    case 'cloud': {
      // Lazy import (mirrors `drive`/`gc`): `cloud` pulls in the HTTP device-flow
      // machinery — keep the hot `next` loop's per-spawn startup cost unchanged.
      const { runCloud } = await import('./commands/cloud');
      return runCloud(rest);
    }
    case 'step':
      return runStep(rest);
    case 'migrate': {
      // T1-18 ADDITIVE: lazy import (mirrors `drive`/`gc`) — `migrate` pulls in
      // computePlan + the fs write machinery; keep the hot `next` loop's
      // per-spawn startup cost unchanged.
      const { runMigrate } = await import('./commands/migrate');
      return runMigrate(rest);
    }
    case '--version':
    case '-v':
      process.stdout.write(VERSION + '\n');
      return 0;
    case '--help':
    case '-h':
      process.stdout.write(usage());
      return 0;
    case undefined:
      process.stderr.write(usage());
      return 1;
    default:
      process.stderr.write(`pipeline: unknown command '${command}'\n\n` + usage());
      return 2;
  }
}

main(process.argv).then((code) => process.exit(code));
