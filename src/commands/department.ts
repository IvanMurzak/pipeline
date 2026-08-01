// `pipeline department new`, `validate` and `serve`
// (simplified-onboarding design, tasks a8 + a9; refs 02 §4, 05 §3/§4/§5, 06).
//
// A department is a project folder whose only REQUIRED file is
// `department.yml` (D3/D8). This module is the commands that make that
// promise real:
//
//   `new`      — scaffold department.yml (and NOTHING else — D3 is a hard
//                requirement, not a default) in the current folder, or in a
//                new `<name>/` subfolder.
//   `validate` — run every check class 05 §4 names against a hand-written or
//                hand-edited file, so authoring one by hand is a reasonable
//                thing to ask of a user.
//   `serve`    — one command from an authored file to a live, callable
//                department: 05 §5's nine steps, in order, idempotent and
//                resumable from any partial state (task a9). The steps that
//                talk to the control plane or to `pipeline-runner` live in
//                `lib/department-serve.ts`; this file owns the order, the
//                printed transcript, and the exit code.
//
// Both commands sit ON TOP of `lib/department-manifest.ts` (task a7, merged
// as 29b7560) and never re-implement it: a7 owns the schema, `apiVersion`
// handling, canonicalization and the digest, and its own header comment says
// exactly which check classes are NOT its job — Coherence, Engine,
// Advisory and Local — because they need the machine (env, filesystem) and
// belong here. `validate`'s extra findings below are additive to whatever
// `parseDepartmentManifest` already found; nothing here re-derives Schema or
// Version findings.
//
// ── Where this module DELIBERATELY resolves ambiguity in the design docs ───
//
// 1. **A missing skill description is an ERROR, not the warning 05 §4's
//    Advisory table would suggest.** Both 05 §4 and 02 §4 embed the SAME
//    worked `validate` transcript, and it renders `✗ skills[1]  description
//    missing` — contributing to "1 error, 1 warning" — even though the prose
//    table two paragraphs above files "a skill with no description" under
//    Advisory. 02's own preamble is explicit about this exact situation:
//    *"Where an implementation detail conflicts with a transcript, the
//    transcript wins."* This module follows that rule. A description under
//    20 characters (present but thin) stays a WARNING — nothing conflicts on
//    that one.
// 2. **`visibility` not being set is reported as a warning**, matching both
//    transcripts' `⚠ visibility  not set — defaults to 'organization'` line,
//    even though 05 §4's check-class table never names it. Detecting "not
//    set" (vs. "set to the same value as the default") needs the file's RAW
//    parsed document, which the resolved `DepartmentManifest` cannot supply —
//    see `visibilityAdvisory()` below for how this stays a thin, additive
//    check rather than a parser change.
// 3. **`new`'s scaffold shape is 05 §2's "Minimum viable file" verbatim** —
//    the design states outright, directly under that code block, *"This is
//    what `pipeline department new` writes"*: `apiVersion`, `name`,
//    `description`, one `skills` entry (id + name + description), and
//    `runtime.engine`. No `displayName`, `visibility`, `communication`,
//    `scheduling`, `limits`, or `retention` — those all have defaults and
//    are the user's to add. The only difference from the example is content:
//    a fresh scaffold cannot know a real name/description/skill, so those
//    are TODO placeholders sized to clear the "under 20 characters" advisory
//    (so a fresh file doesn't ALSO nag about its own placeholder).
// 4. **The `--engine <id>` flag** appears in 05 §3's usage line
//    (`pipeline department new [<name>] [--engine <id>] [--from-pipeline
//    <name>] [--force] [--json]`) but is not called out in this task's own
//    "Scope & seams" bullet list. Implemented per the usage line: defaults to
//    `claude-code` (05 §2's own default), validated against the same
//    registry `validate` checks against, and forced to `pipeline` (erroring
//    on a conflicting explicit value) when `--from-pipeline` is given.
// 5. **`--dir <path>`** is an ADDITIONAL flag, not in either design usage
//    line, mirroring `pipeline clone`'s own `--dir` extension
//    (`src/commands/clone.ts`) — a project root override so tests (and
//    scripted callers) don't need `process.chdir`. `new`'s default target
//    without it is the current working directory, exactly as D4 specifies.
// 6. **"`new <name>` onto an existing non-empty folder" is a DISTINCT refusal
//    from "`new` refuses to overwrite an existing `department.yml`" (05 §3).**
//    The bare `new` (current folder) never inspects folder contents beyond
//    `department.yml` itself — the current folder is virtually always an
//    existing project with unrelated content, and the DoD explicitly
//    requires that case to succeed, adding exactly one file. `new <name>`
//    creates a NEW logical subfolder — landing `department.yml` into an
//    already-occupied, unrelated directory there is far more likely a
//    mistake than a wanted merge, so it is refused unless `--force` (which
//    covers both refusal reasons uniformly: "yes, write here anyway").

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync as fsReadFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir as osHomedir, hostname as osHostname } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import {
  buildRegistrationRequest,
  DEPARTMENT_API_VERSION_V1,
  DEPARTMENT_MANIFEST_FILENAME,
  bunYamlParser,
  engineDefinition,
  hasErrors,
  isSupportedEngine,
  missingRequiredRuntimeFields,
  parseDepartmentManifest,
  readDepartmentManifest,
  SUPPORTED_ENGINES,
  type DepartmentManifest,
  type ManifestFinding,
} from '../lib/department-manifest';
// a9: the steps that leave this process — HTTP to the control plane, argv to
// `pipeline-runner`. See that module's doc for the three rules it keeps.
import {
  assessLiveness,
  bindRuntime,
  claimInstall,
  departmentUrlFor,
  ensureSupervisor,
  fetchDeptTasks,
  fetchDeptUsage,
  fetchDepartmentProfile,
  fetchInstalls,
  findDepartmentBySlug,
  localSupervisorIsUp,
  registerOrUpdateDepartment,
  renderState,
  resolveLocalDepartmentId,
  retireDepartmentRequest,
  runtimeBindingFor,
  SUPERVISOR_FOREGROUND_HINT,
  unbindRuntime,
  type CloudContext,
  type DeptTaskSummary,
  type DeptUsage,
  type DepartmentProfile,
  type InstallSummary,
  type Liveness,
  type LocalDaemonState,
  type ServeDeps,
  type ServeFetch,
  type ServeHttpResponse,
  type ServeState,
} from '../lib/department-serve';
// a10: the silent (never-interactive) credential read `status` uses — the
// SAME store `cloud connect`/`serve` write, read WITHOUT the interactive
// ladder so a routine, possibly-scripted `status` call never pops a browser
// or a device code. `ensureFreshCredential` is the one function in this
// package allowed to call the refresh grant (a5's single-flight rule).
import { ensureFreshCredential, type RefreshDeps } from '../lib/credential-refresh';
// x19: the LOCAL half of a task's identity. The control plane knows a task's
// state and its authenticated CALLER; only the machine that ran the work knows
// who ADDRESSED it and which engine executed it — pipeline-runner writes both
// into its own execution journal (b4). Read-only, never through pipeline-runner's
// code; see that module's doc for the three rules it keeps.
// x44: `readDepartmentJournal` asks `pipeline-runner journal --json` first and
// keeps x19's own reader as the fallback — the mirror resolved the data dir as
// the INVOKING user and therefore saw nothing at all when the runner runs as a
// service under another OS account (x22).
import { readDepartmentJournal, type LocalJournalReading, type LocalTaskFacts } from '../lib/department-journal';
import {
  credentialFilePath,
  DEFAULT_SERVER,
  normalizeServerUrl,
  readCredentialStore,
  realFs,
  SERVER_ENV,
  type CloudFs,
  type StoredCredential,
} from '../lib/cloud-config';
import {
  enrolRunner,
  readRunnerIdentity,
  readRunnerServiceState,
  realShell,
  type RunnerEnrolDeps,
  type RunnerServiceState,
  type ShellRunner,
} from '../lib/runner-enrol';
// a9 (step 2): the ONE authentication ladder, shared with `cloud connect`
// (D12). This is the single place a command in this package imports another
// command's module — deliberate, and cheaper than the alternative: duplicating
// the browser + device + machine-credential flows would mean two ladders, two
// sets of 04 §9 failure messages, and two places to fix an OAuth bug. What is
// imported statically is only the TYPES plus the env-var NAME (so `serve` and
// `connect` cannot disagree about what the machine credential is called); the
// implementation arrives through `ServeCommandDeps.authenticate`, whose
// production wiring dynamic-imports it at call time.
// x50: `exchangeMachineCredential` joins them — a VALUE, deliberately. It is
// the machine rung of that same ladder and the only rung that is silent by
// construction (one `client_credentials` POST, no TTY, no browser), which is
// what lets `status` — which must never prompt — run it directly instead of
// growing a second machine-credential flow. Nothing interactive is imported.
import { exchangeMachineCredential, MACHINE_TOKEN_ENV, type ApiAuth, type ApiAuthOptions } from './cloud';
import { findFirstIteration, findManifests, parseManifest as parsePipelineManifest } from '../lib/match';
import { parseFrontmatter } from '../lib/frontmatter';
// a11: `notify` is the SAME poll/toast/journal daemon as before (task a1),
// just addressed as a `department` verb instead of the standalone `mesh`
// top-level command (08-terminology.md / D10 / D31) — `commands/mesh.ts`
// keeps the old `pipeline mesh notify` spelling alive as a deprecated,
// warning alias that delegates to the exact same function.
import { runDepartmentNotify } from './department-notify';

// ---------------------------------------------------------------------------
// Small text helpers shared by `new`'s scaffold writer
// ---------------------------------------------------------------------------

/** The engine 05 §2's minimum-viable-file example uses, and `new`'s default
 *  when neither `--engine` nor `--from-pipeline` says otherwise. */
const DEFAULT_ENGINE = 'claude-code';

const DEFAULT_DEPARTMENT_DESCRIPTION =
  'TODO: describe what this department does and when someone should ask for it.';
const DEFAULT_SKILL_DESCRIPTION = 'TODO: describe this skill so callers know when to use it.';

/**
 * Best-effort conversion of arbitrary text (a folder name, a pipeline name, a
 * user-typed `<name>` argument) into the slug grammar the schema requires
 * (`^[a-z0-9]([a-z0-9-]*[a-z0-9])?$` — `lib/department-manifest.ts`'s
 * `SLUG_RE`, not exported, so this is a DELIBERATELY separate, much simpler
 * transform: lowercase, collapse every run of non-alphanumerics to a single
 * hyphen, trim leading/trailing hyphens). By construction the result is
 * either empty (falls back to `'department'`) or matches that grammar — there
 * is no character or position this can produce that the schema would reject.
 * This is scaffolding only; a hand-edited `name:` is still checked for real
 * by `validate`, which reads `department-manifest.ts`'s actual rule.
 */
function slugify(input: string): string {
  const s = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.length > 0 ? s : 'department';
}

/** `unity-review` -> `Unity Review` — the display form 05 §2's examples use
 *  for a skill/department `name`. Input is expected to already be slug-shaped
 *  (only `slugify()`'s own output is ever passed in). */
function titleCase(slug: string): string {
  return slug
    .split('-')
    .filter((w) => w.length > 0)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ');
}

/** A double-quoted YAML flow scalar via `JSON.stringify` — YAML's flow-scalar
 *  grammar is a superset of JSON's, so this is correct for ANY input (colons,
 *  quotes, unicode, leading/trailing whitespace) with no hand-rolled escaping
 *  to get wrong. Used for every value this module writes that did not
 *  originate as a compile-time literal. */
function yq(value: string): string {
  return JSON.stringify(value);
}

/**
 * Render `value` as a folded block scalar (`description: >-`) on ONE
 * indented line. Internal whitespace/newlines are collapsed first — a `new`
 * scaffold's prose comes from either a fixed placeholder or an `End
 * State`/`Scope.In` section that may itself contain paragraph breaks, and
 * folding those by hand risks a YAML block-scalar indentation mistake for
 * negligible benefit (nothing here needs the ORIGINAL line breaks preserved,
 * only the text). A folded block scalar is valid YAML at any length, so this
 * needs no wrapping.
 */
function yamlProseLine(indent: string, key: string, value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return `${indent}${key}: >-\n${indent}  ${collapsed}\n`;
}

// ---------------------------------------------------------------------------
// `new` — scaffold department.yml
// ---------------------------------------------------------------------------

interface NewArgs {
  name?: string;
  engine?: string;
  fromPipeline?: string;
  force: boolean;
  json: boolean;
  help: boolean;
  /** Project root override (an addition over 05 §3's usage line — see the
   *  header comment's point 5). Default: `process.cwd()`. */
  dir?: string;
  unknownFlag?: string;
  extra?: string;
}

const NEW_USAGE =
  'Usage: pipeline department new [<name>] [--engine <id>] [--from-pipeline <name>] [--force] [--json]';

function parseNewArgs(args: string[]): NewArgs {
  const out: NewArgs = { force: false, json: false, help: false };
  const take = (i: number) => args[i + 1];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = (p: string) => (a.startsWith(p + '=') ? a.slice(p.length + 1) : undefined);
    if (a === '--force' || a === '-f') out.force = true;
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--engine') out.engine = take(i++);
    else if (eq('--engine') !== undefined) out.engine = eq('--engine');
    else if (a === '--from-pipeline') out.fromPipeline = take(i++);
    else if (eq('--from-pipeline') !== undefined) out.fromPipeline = eq('--from-pipeline');
    else if (a === '--dir') out.dir = take(i++);
    else if (eq('--dir') !== undefined) out.dir = eq('--dir');
    else if (a === '--') continue;
    else if (a.startsWith('-')) out.unknownFlag = a;
    else if (out.name === undefined) out.name = a;
    else out.extra = a;
  }
  return out;
}

function newHelpText(): string {
  return (
    `${NEW_USAGE}\n\n` +
    `Scaffold ${DEPARTMENT_MANIFEST_FILENAME} — the only file a department project\n` +
    'folder requires. Creates that ONE file and nothing else: no .claude/, no\n' +
    'README, no starter agent.\n\n' +
    'Options:\n' +
    '  <name>              Create ./<name>/department.yml instead of the current\n' +
    '                      folder; also prefills the name field (default: the\n' +
    '                      current/target folder name).\n' +
    `  --engine <id>       Runtime engine (default: ${DEFAULT_ENGINE}). Supported:\n` +
    `                      ${SUPPORTED_ENGINES.join(', ')}.\n` +
    '  --from-pipeline <n> Prefill description + one skill from an EXISTING\n' +
    '                      ./.claude/pipeline/<n>/PIPELINE.md (its End State and\n' +
    '                      Scope.In) and write engine: pipeline pointing at it.\n' +
    '  --force, -f         Overwrite an existing department.yml (or write into an\n' +
    '                      already-occupied <name> folder) anyway.\n' +
    '  --dir <path>        Project root (default: current directory).\n' +
    '  --json              Print the result as JSON.\n' +
    '  --help, -h          Show this help.\n'
  );
}

interface FromPipelineInfo {
  pipelineName: string;
  description: string;
  skillDescription: string;
  /** POSIX-relative to the department.yml being written. */
  pipelineRoot: string;
  /** POSIX-relative to `pipelineRoot`. */
  startIteration: string;
}

/** Cross-platform "path B relative to path A", forward-slashed regardless of
 *  OS — YAML values that get committed to git and read on any machine should
 *  not carry a Windows backslash. */
function posixRelative(fromDir: string, toPath: string): string {
  return relative(fromDir, toPath).split('\\').join('/');
}

/**
 * Resolve `--from-pipeline <name>` against an EXISTING pipeline already
 * living at `<projectRoot>/.claude/pipeline/<name>/` — the plugin's own
 * "pipelines live in the consumer project" invariant (this repo's
 * `CLAUDE.md`), not the bundled `templates/` a fresh `pipeline clone` copies
 * from. A department wraps a pipeline the user already authored or cloned;
 * it does not scaffold one.
 *
 * Reuses `lib/match.ts`'s `parseManifest`/`findFirstIteration` — the SAME
 * `End State`/`Scope.In` parser `pipeline match` itself is built on — rather
 * than re-reading `PIPELINE.md`'s sections by hand.
 */
function resolveFromPipeline(
  projectRoot: string,
  manifestPath: string,
  pipelineName: string,
): FromPipelineInfo | { error: string } {
  const pipelineRootAbs = join(projectRoot, '.claude', 'pipeline', pipelineName);
  const pipelineMdPath = join(pipelineRootAbs, 'PIPELINE.md');
  if (!existsSync(pipelineMdPath)) {
    return {
      error:
        `no pipeline named '${pipelineName}' — expected ${pipelineMdPath}\n` +
        `  (pipelines live under ./.claude/pipeline/<name>/ in this project; ` +
        `'pipeline clone ${pipelineName}' fetches a bundled template of that name, if one exists)`,
    };
  }
  const pm = parsePipelineManifest(pipelineMdPath);
  const firstIteration = findFirstIteration(pipelineMdPath);
  if (firstIteration === null) {
    return { error: `pipeline '${pipelineName}' has no steps/*.md iteration files — nothing to run` };
  }

  const endState = pm.end_state.trim();
  const scopeIn = pm.scope_in.join('; ').trim();
  const fallback = `Runs the '${pipelineName}' pipeline.`;

  return {
    pipelineName,
    description: endState.length > 0 ? endState : fallback,
    // Scope.In is what tells a CALLER when to reach for this skill; End State
    // is the fallback for a pipeline whose Scope section is empty or
    // unparseable (both are optional PIPELINE.md sections in practice, even
    // though the designer agent always fills them in).
    skillDescription: scopeIn.length > 0 ? scopeIn : endState.length > 0 ? endState : fallback,
    pipelineRoot: posixRelative(dirname(manifestPath), pipelineRootAbs),
    startIteration: posixRelative(pipelineRootAbs, firstIteration),
  };
}

interface RenderOptions {
  name: string;
  engine: string;
  description: string;
  skillId: string;
  skillName: string;
  skillDescription: string;
  pipelineRoot?: string;
  startIteration?: string;
}

/** Build the `department.yml` TEXT — 05 §2's "Minimum viable file" shape
 *  exactly (see the header comment's point 3): `apiVersion`, `name`,
 *  `description`, one `skills` entry, `runtime.engine` (+ `pipelineRoot` /
 *  `startIteration` for `engine: pipeline`). Nothing else. */
function renderManifest(o: RenderOptions): string {
  let text = `apiVersion: ${DEPARTMENT_API_VERSION_V1}\n`;
  text += `name: ${yq(o.name)}\n`;
  text += yamlProseLine('', 'description', o.description);
  text += '\n';
  text += 'skills:\n';
  text += `  - id: ${yq(o.skillId)}\n`;
  text += `    name: ${yq(o.skillName)}\n`;
  text += yamlProseLine('    ', 'description', o.skillDescription);
  text += '\n';
  text += 'runtime:\n';
  text += `  engine: ${yq(o.engine)}\n`;
  if (o.pipelineRoot !== undefined) text += `  pipelineRoot: ${yq(o.pipelineRoot)}\n`;
  if (o.startIteration !== undefined) text += `  startIteration: ${yq(o.startIteration)}\n`;
  return text;
}

export function runDepartmentNew(args: string[]): number {
  const a = parseNewArgs(args);
  const err = (s: string) => process.stderr.write(s);
  const out = (s: string) => process.stdout.write(s);
  const usage = (msg: string): number => {
    err(`pipeline department new: ${msg}\n${NEW_USAGE}\n`);
    return 2;
  };

  if (a.help) {
    out(newHelpText());
    return 0;
  }
  if (a.unknownFlag !== undefined) return usage(`unknown flag '${a.unknownFlag}'`);
  if (a.extra !== undefined) return usage(`unexpected extra argument '${a.extra}' — takes at most one <name>`);
  if (a.engine !== undefined && engineDefinition(a.engine) === undefined) {
    return usage(`unsupported --engine '${a.engine}' — supported: ${SUPPORTED_ENGINES.join(', ')}`);
  }
  if (a.fromPipeline !== undefined && a.engine !== undefined && a.engine !== 'pipeline') {
    return usage(
      `--from-pipeline always writes 'engine: pipeline' — drop --engine ${a.engine}, or set it to 'pipeline'`,
    );
  }

  const projectRoot = resolve(a.dir ?? process.cwd());
  const targetDir = a.name !== undefined ? join(projectRoot, a.name) : projectRoot;
  const manifestPath = join(targetDir, DEPARTMENT_MANIFEST_FILENAME);

  // --- refusal checks BEFORE any write, and before resolving --from-pipeline
  // (a bad --from-pipeline value should not matter if we were going to refuse
  // anyway) ---------------------------------------------------------------
  if (existsSync(targetDir)) {
    if (!statSync(targetDir).isDirectory()) {
      err(`pipeline department new: '${targetDir}' already exists and is not a directory\n`);
      return 1;
    }
    // Only the `<name>` form checks for unrelated existing content (header
    // comment point 6) — the bare `new` (current folder) is expected to
    // already contain the user's project.
    if (a.name !== undefined && !a.force && readdirSync(targetDir).length > 0) {
      err(
        `pipeline department new: '${targetDir}' already exists and is not empty\n` +
          '  pass --force to write into it anyway.\n',
      );
      return 1;
    }
  }
  if (existsSync(manifestPath) && !a.force) {
    err(`pipeline department new: ${manifestPath} already exists\n  pass --force to overwrite it.\n`);
    return 1;
  }

  let fromPipelineInfo: FromPipelineInfo | undefined;
  if (a.fromPipeline !== undefined) {
    const resolved = resolveFromPipeline(projectRoot, manifestPath, a.fromPipeline);
    if ('error' in resolved) {
      err(`pipeline department new: ${resolved.error}\n`);
      return 1;
    }
    fromPipelineInfo = resolved;
  }

  const departmentName = slugify(a.name ?? fromPipelineInfo?.pipelineName ?? basename(projectRoot));
  const engine = fromPipelineInfo !== undefined ? 'pipeline' : (a.engine ?? DEFAULT_ENGINE);
  const skillId = fromPipelineInfo !== undefined ? slugify(fromPipelineInfo.pipelineName) : departmentName;
  const skillName = titleCase(skillId);

  const yamlText = renderManifest({
    name: departmentName,
    engine,
    description: fromPipelineInfo?.description ?? DEFAULT_DEPARTMENT_DESCRIPTION,
    skillId,
    skillName,
    skillDescription: fromPipelineInfo?.skillDescription ?? DEFAULT_SKILL_DESCRIPTION,
    pipelineRoot: fromPipelineInfo?.pipelineRoot,
    startIteration: fromPipelineInfo?.startIteration,
  });

  try {
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(manifestPath, yamlText, 'utf8');
  } catch (e) {
    err(`pipeline department new: could not write ${manifestPath}: ${(e as Error).message}\n`);
    return 1;
  }

  if (a.json) {
    out(
      JSON.stringify(
        {
          created: true,
          path: manifestPath,
          name: departmentName,
          engine,
          fromPipeline: fromPipelineInfo?.pipelineName ?? null,
        },
        null,
        2,
      ) + '\n',
    );
    return 0;
  }

  out(`✓ ${DEPARTMENT_MANIFEST_FILENAME} created${fromPipelineInfo ? ` from pipeline '${fromPipelineInfo.pipelineName}'` : ''}\n\n`);
  out(`  ${manifestPath}\n\n`);
  if (fromPipelineInfo !== undefined) {
    out('Review it, then:  pipeline department validate\n');
  } else {
    out('Describe your department there — a name, what it does, and the skills it\n');
    out('offers — then:  pipeline department validate\n');
  }
  return 0;
}

// ---------------------------------------------------------------------------
// `validate` — the a8 check classes ON TOP of a7's Schema + Version findings
// ---------------------------------------------------------------------------

interface ValidateArgs {
  file?: string;
  json: boolean;
  help: boolean;
  unknownFlag?: string;
  extra?: string;
}

const VALIDATE_USAGE = 'Usage: pipeline department validate [--file <path>] [--json]';

function parseValidateArgs(args: string[]): ValidateArgs {
  const out: ValidateArgs = { json: false, help: false };
  const take = (i: number) => args[i + 1];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = (p: string) => (a.startsWith(p + '=') ? a.slice(p.length + 1) : undefined);
    if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--file') out.file = take(i++);
    else if (eq('--file') !== undefined) out.file = eq('--file');
    else if (a === '--') continue;
    else if (a.startsWith('-')) out.unknownFlag = a;
    else if (out.extra === undefined) out.extra = a;
  }
  return out;
}

function validateHelpText(): string {
  return (
    `${VALIDATE_USAGE}\n\n` +
    `Validate a hand-written or hand-edited ${DEPARTMENT_MANIFEST_FILENAME} (05 §4):\n` +
    'schema + apiVersion, coherence (engine vs. declared capabilities), engine\n' +
    'support, advisory nits, and local filesystem facts.\n\n' +
    'It checks the FILE and the local paths it names. It cannot check a runner,\n' +
    'a credential or the control plane — the report ends with the list of what\n' +
    '`serve` checks that this command structurally cannot.\n\n' +
    'Options:\n' +
    `  --file <path>  File to validate (default: ./${DEPARTMENT_MANIFEST_FILENAME}).\n` +
    '  --json         Print {file, valid, errors, warnings, findings, notChecked}.\n' +
    '  --help, -h     Show this help.\n'
  );
}

const COMMUNICATION_CAPABILITY_KEYS = [
  'acceptsMidTaskInput',
  'supportsCancellation',
  'supportsStreaming',
  'supportsCheckpoint',
] as const;

/**
 * Coherence (05 §4): a `communication` capability the manifest resolves to
 * `true` that the named engine cannot actually honour — verbatim the
 * `department-mesh/06-department-registry.md` §3.1 rule ("`acceptsMidTaskInput:
 * true` with `adapter: pipeline-drive` is rejected"), plus the
 * `contextAffinity: required` / lifecycle pairing 05 §4's table names as its
 * second example. Engines whose capabilities are negotiated at runtime
 * (`process`, `container` — `EngineDefinition.capabilities === null`) have
 * nothing to check an author's claim against and are skipped; an
 * unrecognized engine already has its own Schema-class finding from a7.
 *
 * ⚠ **This function is the ONLY enforcement of these rules that can still
 * fire** (task a9). The cloud has the same rules — `validateManifestCoherence`
 * in `mesh-registry/manifest.ts` — but every one of them is guarded by
 * `effective.adapter === 'pipeline-drive'`, and a7's `advertisedManifest()`
 * never sends `runtime` at all (the whole block is local by construction). The
 * server therefore evaluates an EMPTY shape and returns no errors, for every
 * department, always. `serve` runs this check before it registers anything
 * (05 §5 step 1), which is where a manifest the cloud would once have rejected
 * is now stopped — locally, and earlier. Anything added to the server's list
 * must be mirrored here, in the engine registry, or it is dead code.
 */
function coherenceFindings(m: DepartmentManifest): ManifestFinding[] {
  const out: ManifestFinding[] = [];
  const def = engineDefinition(m.runtime.engine);
  if (def !== undefined && def.capabilities !== null) {
    for (const cap of COMMUNICATION_CAPABILITY_KEYS) {
      if (m.communication[cap] === true && def.capabilities[cap] !== true) {
        out.push({
          severity: 'error',
          field: `communication.${cap}`,
          message: `engine '${m.runtime.engine}' cannot honour this — the cloud would reject it at install time`,
        });
      }
    }
  }
  // The lifecycle half of the same server-side rule set (`pipeline-drive` "only
  // supports runtime.lifecycle 'per-task'"), expressed on a7's registry so
  // adding an engine with its own restriction is one field, not a new branch.
  if (
    def !== undefined &&
    def.supportedLifecycles !== null &&
    !def.supportedLifecycles.includes(m.runtime.lifecycle)
  ) {
    out.push({
      severity: 'error',
      field: 'runtime.lifecycle',
      message:
        `engine '${m.runtime.engine}' only supports ${def.supportedLifecycles.map((l) => `'${l}'`).join(', ')} — ` +
        `'${m.runtime.lifecycle}' cannot be honoured`,
    });
  }
  if (m.scheduling.contextAffinity === 'required' && m.runtime.lifecycle === 'per-task') {
    out.push({
      severity: 'error',
      field: 'scheduling.contextAffinity',
      message: "'required' needs runtime.lifecycle 'per-context' or 'daemon' — 'per-task' cannot hold context across tasks",
    });
  }
  // x51 — every `runtime:` key this engine cannot be bound without, from the
  // SAME registry rows `serve` refuses on (`missingRequiredRuntimeFields`),
  // with the SAME sentence.
  //
  // This replaced a hand-written `runtime.command` check that was validate's
  // only required-field rule, while `serve` had three. The missing one —
  // `runtime.startIteration` for `engine: pipeline` — is x51: validate printed
  // "0 errors" for a manifest serve then refused. There is no longer a list
  // here to fall behind the one over there.
  //
  // Severity comes from the row, so the ONE deliberate disagreement survives
  // and is now declared rather than accidental: `runtime.command` is a
  // WARNING because `department new --engine process` scaffolds without one
  // (no honest placeholder exists for another project's binary), and `serve`
  // still refuses it at step 1. A warning that names `serve` is the honest
  // shape for "valid file, not yet servable"; silence was not.
  for (const missing of missingRequiredRuntimeFields(m)) {
    out.push({ severity: missing.severity, field: `runtime.${missing.field}`, message: missing.why });
  }
  return out;
}

/**
 * Local (05 §4): filesystem facts only the machine running `validate` can
 * check — an `engine: pipeline` runtime that does not point at a real
 * pipeline, and any other local `runtime` path that does not exist. Resolved
 * relative to the MANIFEST's own directory, mirroring exactly how `new
 * --from-pipeline` writes `pipelineRoot`/`startIteration` above.
 */
function localFindings(m: DepartmentManifest, manifestDir: string): ManifestFinding[] {
  const out: ManifestFinding[] = [];
  if (m.runtime.engine === 'pipeline') {
    // x51: the PRESENCE of `pipelineRoot`/`startIteration` is no longer
    // checked here — it is a registry fact (`missingRequiredRuntimeFields`,
    // reported by `coherenceFindings` and enforced by `serve`). What is left
    // is what only THIS machine can answer: whether the paths they name exist.
    if (m.runtime.pipelineRoot) {
      const rootAbs = resolve(manifestDir, m.runtime.pipelineRoot);
      if (!existsSync(rootAbs) || !statSync(rootAbs).isDirectory()) {
        out.push({ severity: 'error', field: 'runtime.pipelineRoot', message: `does not exist: ${rootAbs}` });
      } else if (!existsSync(join(rootAbs, 'PIPELINE.md'))) {
        out.push({
          severity: 'error',
          field: 'runtime.pipelineRoot',
          message: `has no PIPELINE.md — not a pipeline root: ${rootAbs}`,
        });
      } else if (m.runtime.startIteration) {
        const iterAbs = resolve(rootAbs, m.runtime.startIteration);
        if (!existsSync(iterAbs)) {
          out.push({ severity: 'error', field: 'runtime.startIteration', message: `does not exist: ${iterAbs}` });
        }
      }
    }
  }
  if (m.runtime.workingDirectory) {
    const abs = resolve(manifestDir, m.runtime.workingDirectory);
    if (!existsSync(abs)) {
      out.push({ severity: 'error', field: 'runtime.workingDirectory', message: `does not exist: ${abs}` });
    }
  }
  // The entry-point agent must actually EXIST inside this department: naming
  // one that does not is the difference between a department that answers and
  // one that fails on its first message, and only this machine can tell. WHERE
  // to look comes off the engine's own registry row, so this check cannot
  // outlive the engine it was written for.
  const agentEntrypoint = engineDefinition(m.runtime.engine)?.entrypoint.agent;
  if (m.runtime.agent !== undefined && agentEntrypoint !== undefined) {
    const agentsDir = join(manifestDir, ...agentEntrypoint.agentsDir.split('/'));
    if (!departmentDefinesAgent(agentsDir, m.runtime.agent)) {
      out.push({
        severity: 'error',
        field: 'runtime.agent',
        message:
          `no agent '${m.runtime.agent}' in this department — expected a Markdown file under ` +
          `${agentsDir} whose name (or filename) is '${m.runtime.agent}'. ` +
          'The entry-point agent has to be defined inside the department, because that folder is the ' +
          'only thing the engine loads.',
      });
    }
  }
  return out;
}

/**
 * Does this department define the named agent? Matched on the `name:` in an
 * agent file's frontmatter OR on its filename, because both are how Claude
 * Code itself resolves `--agent`, and a validator that accepted only one of
 * them would reject working departments.
 *
 * An unreadable folder answers `false`: unreadable and absent are the same
 * answer to "can the engine load this agent".
 */
function departmentDefinesAgent(agentsDir: string, agent: string): boolean {
  if (!existsSync(agentsDir)) return false;
  let entries: string[];
  try {
    entries = readdirSync(agentsDir);
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    if (entry.slice(0, -'.md'.length) === agent) return true;
    try {
      const { fields } = parseFrontmatter(fsReadFileSync(join(agentsDir, entry), 'utf8'));
      const name = fields['name'];
      if (typeof name === 'string' && name.trim() === agent) return true;
    } catch {
      // An unreadable or frontmatter-less file simply is not a match.
    }
  }
  return false;
}

/**
 * Advisory (05 §4) over `skills[]`: a missing description is an ERROR (see
 * the header comment's point 1 — the transcript overrides the table's own
 * classification); a present-but-thin one (< 20 characters) stays a WARNING,
 * matching the table's other example exactly. Duplicate skill ids are
 * ALREADY a warning from a7's own parser (`parseDepartmentManifest`'s
 * `parseSkills`) and are not re-derived here.
 */
function skillAdvisoryFindings(m: DepartmentManifest): ManifestFinding[] {
  const out: ManifestFinding[] = [];
  m.skills.forEach((s, i) => {
    if (s.description === undefined) {
      out.push({
        severity: 'error',
        field: `skills[${i}]`,
        message: "description missing — callers won't know when to use it",
      });
    } else if (s.description.length < 20) {
      out.push({
        severity: 'warning',
        field: `skills[${i}].description`,
        message: `very short (${s.description.length} characters) — callers may not understand when to use this skill`,
      });
    }
  });
  return out;
}

interface ClaudeDirInfo {
  present: boolean;
  agents: number;
  skills: number;
  pipelines: number;
  empty: boolean;
}

/** Count what `.claude/` carries, for both the printed summary line and the
 *  "present but empty" advisory. Never a warning when `.claude/` is simply
 *  absent (05 §4: "its absence is never a warning"). */
function inspectClaudeDir(manifestDir: string): ClaudeDirInfo {
  const claudeDir = join(manifestDir, '.claude');
  if (!existsSync(claudeDir) || !statSync(claudeDir).isDirectory()) {
    return { present: false, agents: 0, skills: 0, pipelines: 0, empty: false };
  }
  const listDir = (dir: string): string[] => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };
  const countFiles = (dir: string, suffix: string): number =>
    listDir(dir).filter((f) => f.endsWith(suffix) && statSync(join(dir, f)).isFile()).length;
  const countDirs = (dir: string): number =>
    listDir(dir).filter((f) => {
      try {
        return statSync(join(dir, f)).isDirectory();
      } catch {
        return false;
      }
    }).length;

  const topLevel = listDir(claudeDir);
  return {
    present: true,
    agents: countFiles(join(claudeDir, 'agents'), '.md'),
    skills: countDirs(join(claudeDir, 'skills')),
    // Reuses the SAME PIPELINE.md walker `pipeline match` is built on, rather
    // than re-implementing "does this look like a pipeline folder" here.
    pipelines: findManifests(join(claudeDir, 'pipeline')).length,
    empty: topLevel.length === 0,
  };
}

function claudeDirFindings(info: ClaudeDirInfo): ManifestFinding[] {
  if (info.present && info.empty) {
    return [{ severity: 'warning', field: '.claude', message: 'present but empty' }];
  }
  return [];
}

/**
 * `visibility` not being set (05 §4/02 §4's `⚠ visibility  not set —
 * defaults to 'organization'` line). Not in 05 §4's Advisory table, but
 * present verbatim in BOTH transcripts — see the header comment's point 2.
 *
 * The resolved `DepartmentManifest.visibility` cannot tell "the author wrote
 * `organization`" from "the author wrote nothing" apart — a7 resolves the
 * default before this module ever sees the object, by design (a settled
 * object is what the digest must derive from). Answering "was the key
 * present" needs the RAW document, so this re-parses with the exact same
 * YAML seam `parseDepartmentManifest` uses (`bunYamlParser`, plus its BOM
 * strip) — a ONE-KEY presence check, not a second schema implementation. If
 * this throws for any reason, `parseDepartmentManifest`'s own findings have
 * already reported the underlying problem, so this fails silently rather
 * than duplicating it.
 */
function visibilityAdvisory(text: string): ManifestFinding[] {
  try {
    // Mirrors department-manifest.ts's own BOM guard exactly (parseDepartmentManifest
    // comment: "A UTF-8 BOM is NOT stripped by the YAML parser").
    const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    const doc = bunYamlParser(source);
    if (
      doc !== null &&
      typeof doc === 'object' &&
      !Array.isArray(doc) &&
      !Object.prototype.hasOwnProperty.call(doc, 'visibility')
    ) {
      return [{ severity: 'warning', field: 'visibility', message: "not set — defaults to 'organization'" }];
    }
  } catch {
    // Already surfaced by parseDepartmentManifest's own findings.
  }
  return [];
}

/** `true` when no ERROR finding's field is this exact field or a child of it
 *  (`'runtime.engine'.startsWith('runtime.')`) — used to decide whether a
 *  human-readable "known good" summary line is honest to print. */
function fieldIsClean(findings: readonly ManifestFinding[], field: string): boolean {
  return !findings.some(
    (f) => f.severity === 'error' && (f.field === field || f.field.startsWith(`${field}.`) || f.field.startsWith(`${field}[`)),
  );
}

interface ValidateJson {
  file: string;
  valid: boolean;
  errors: number;
  warnings: number;
  findings: ManifestFinding[];
}

function buildJsonResult(filePath: string, findings: ManifestFinding[]): ValidateJson {
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.filter((f) => f.severity === 'warning').length;
  return { file: filePath, valid: errors === 0, errors, warnings, findings };
}

/**
 * x51 — what `validate` structurally CANNOT decide, said out loud.
 *
 * The required-field fix above closes the case where validate and `serve`
 * disagreed about the FILE. These are the checks that genuinely cannot run at
 * validate time — they need a runner, a credential, or a control plane — and
 * the honest thing is to name them rather than let "0 errors" be read as
 * "this will serve". A user who has just been told a manifest is valid and is
 * then refused by `serve` has been misled by validate's silence, whether the
 * cause was a missing field (a bug, fixed) or an unreachable machine fact (not
 * a bug, but still worth stating).
 *
 * Deliberately short and deliberately not a to-do list: each line is a thing
 * `serve` checks, in the order `serve` checks it.
 */
const VALIDATE_NOT_CHECKED: readonly string[] = [
  'that `pipeline-runner` is installed on this machine and its supervisor can start this engine',
  'that the control plane accepts the registration — sign-in, org, plan limits, and (per policy) an admin approving this machine',
  'that the paths above exist on the OTHER machines serving this department — every filesystem check here is about this one',
];

/** The `--json` document `validate` itself emits: `buildJsonResult` plus x51's
 *  `notChecked`. Separate from `buildJsonResult` because the other commands
 *  that render manifest findings (`serve`/`stop`/`retire`/`status`) are not
 *  reporting on a validation run and have nothing to say about its limits. */
function buildValidateJson(filePath: string, findings: ManifestFinding[]): ValidateJson & { notChecked: readonly string[] } {
  return { ...buildJsonResult(filePath, findings), notChecked: VALIDATE_NOT_CHECKED };
}

/** The human-readable renderer — a summary line per core field (✓/✗
 *  depending on whether an error already covers it) mirroring 05 §4's
 *  transcript in SPIRIT, then every finding, then the tally line whose exact
 *  wording ("N error(s), M warning(s).") the transcripts also share. */
function printHuman(
  out: (s: string) => void,
  filePath: string,
  manifest: DepartmentManifest | null,
  findings: ManifestFinding[],
): void {
  out(`${filePath}\n\n`);

  if (manifest !== null) {
    const ok = (field: string) => fieldIsClean(findings, field);
    out(`${ok('apiVersion') ? '✓' : '✗'} apiVersion    ${manifest.apiVersion}\n`);
    out(`${ok('name') ? '✓' : '✗'} name          ${manifest.name || '(missing)'}\n`);
    out(`${ok('description') ? '✓' : '✗'} description   ${manifest.description ? 'set' : '(missing)'}\n`);
    if (ok('skills')) {
      out(`✓ skills        ${manifest.skills.length}  (${manifest.skills.map((s) => s.id).join(', ')})\n`);
    } else {
      out('✗ skills        (see findings below)\n');
    }
    // x32: the SAME predicate `serve` binds on (`lib/department-manifest.ts`).
    // This line is the one that used to say "(supported)" about an engine
    // `serve` then refused; there is no longer a second list for it to
    // disagree with.
    const engineOk = isSupportedEngine(manifest.runtime.engine);
    out(
      `${engineOk ? '✓' : '✗'} engine        ${manifest.runtime.engine || '(missing)'}${engineOk ? '  (supported)' : ''}\n`,
    );
    const claudeInfo = inspectClaudeDir(dirname(filePath));
    if (claudeInfo.present && !claudeInfo.empty) {
      out(
        `✓ .claude/      found — ${claudeInfo.agents} agent${claudeInfo.agents === 1 ? '' : 's'}, ` +
          `${claudeInfo.skills} skill${claudeInfo.skills === 1 ? '' : 's'}, ` +
          `${claudeInfo.pipelines} pipeline${claudeInfo.pipelines === 1 ? '' : 's'}\n`,
      );
    }
    out('\n');
  }

  for (const f of findings) {
    out(`${f.severity === 'error' ? '✗' : '⚠'} ${f.field}  ${f.message}\n`);
  }

  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.filter((f) => f.severity === 'warning').length;
  out(`\n${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}.\n`);
}

/**
 * Every check class 05 §4 names, run over one file: a7's Schema + Version
 * findings, then this module's Coherence / Local / Advisory / `.claude`
 * additions. The ONE place that composition exists — `validate` renders it,
 * and `serve` (a9, 05 §5 step 1) runs "§4 in full" by calling exactly this.
 * Two callers, one answer, so a rule can never apply to the linter and not to
 * the publisher.
 *
 * `manifest: null` is 05 §4's exit-2 class (missing, unreadable, unparseable);
 * `fatal` carries the reason when the file could not even be read.
 */
export interface ManifestInspection {
  filePath: string;
  manifest: DepartmentManifest | null;
  findings: ManifestFinding[];
  /** Set only when the bytes could not be read at all (ENOENT/EACCES). */
  fatal?: string;
}

export function inspectManifestFile(filePath: string): ManifestInspection {
  // Reuse `readDepartmentManifest` for its ENOENT/EACCES message logic
  // (05 §4's exit-2 class) rather than re-deriving it, while capturing the
  // raw text this module ALSO needs for `visibilityAdvisory()`.
  let text = '';
  let manifest: DepartmentManifest | null;
  let findings: ManifestFinding[];
  try {
    const parsed = readDepartmentManifest(filePath, {
      readFile: (p) => {
        text = fsReadFileSync(p, 'utf-8');
        return text;
      },
    });
    manifest = parsed.manifest;
    findings = [...parsed.findings];
  } catch (e) {
    const message = (e as Error).message;
    return { filePath, manifest: null, findings: [{ severity: 'error', field: '$', message }], fatal: message };
  }

  if (manifest === null) {
    // Unparseable (05 §4's exit-2 class, same as a missing file — a
    // best-effort manifest could not even be built).
    return { filePath, manifest: null, findings };
  }

  findings.push(...coherenceFindings(manifest));
  findings.push(...localFindings(manifest, dirname(filePath)));
  findings.push(...skillAdvisoryFindings(manifest));
  findings.push(...claudeDirFindings(inspectClaudeDir(dirname(filePath))));
  findings.push(...visibilityAdvisory(text));
  return { filePath, manifest, findings };
}

export function runDepartmentValidate(args: string[]): number {
  const a = parseValidateArgs(args);
  const err = (s: string) => process.stderr.write(s);
  const out = (s: string) => process.stdout.write(s);

  if (a.help) {
    out(validateHelpText());
    return 0;
  }
  if (a.unknownFlag !== undefined) {
    err(`pipeline department validate: unknown flag '${a.unknownFlag}'\n${VALIDATE_USAGE}\n`);
    return 2;
  }
  if (a.extra !== undefined) {
    err(`pipeline department validate: unexpected argument '${a.extra}'\n${VALIDATE_USAGE}\n`);
    return 2;
  }

  const filePath = resolve(a.file ?? DEPARTMENT_MANIFEST_FILENAME);
  const inspection = inspectManifestFile(filePath);

  if (inspection.fatal !== undefined) {
    if (a.json) out(JSON.stringify(buildValidateJson(filePath, inspection.findings), null, 2) + '\n');
    else err(`pipeline department validate: ${inspection.fatal}\n`);
    return 2;
  }
  if (inspection.manifest === null) {
    if (a.json) out(JSON.stringify(buildValidateJson(filePath, inspection.findings), null, 2) + '\n');
    else printHuman(out, filePath, null, inspection.findings);
    return 2;
  }

  if (a.json) {
    out(JSON.stringify(buildValidateJson(filePath, inspection.findings), null, 2) + '\n');
  } else {
    printHuman(out, filePath, inspection.manifest, inspection.findings);
    // x51: printed by `validate` ONLY — the other renderers of `printHuman`
    // are reporting a broken manifest, not the scope of a validation run.
    out('\nNot checked here — `pipeline department serve` is the first command that can:\n');
    for (const line of VALIDATE_NOT_CHECKED) out(`  · ${line}\n`);
  }
  return hasErrors(inspection.findings) ? 1 : 0;
}

// ---------------------------------------------------------------------------
// `serve` — 05 §5's nine steps (task a9)
// ---------------------------------------------------------------------------

/**
 * Every side effect `serve` performs, injected — so the whole nine-step flow
 * is testable with no network, no browser, no `pipeline-runner` binary and no
 * real home directory, exactly like `commands/cloud.ts`'s `CloudDeps`.
 */
export interface ServeCommandDeps {
  fetch: ServeFetch;
  /** Shells `pipeline-runner …` / `bun add -g …` (lib/runner-enrol.ts). */
  shell: ShellRunner;
  out: (s: string) => void;
  err: (s: string) => void;
  env: Record<string, string | undefined>;
  /** Where a bare `serve` looks for `department.yml`. */
  cwd: string;
  /** Default runner name (04 §5), overridden by `--runner-name`. */
  hostname: () => string;
  /**
   * Step 2: the 04 §4 authentication ladder, `PIPELINE_MACHINE_TOKEN`
   * included. Injected rather than imported at module scope for two reasons:
   * `lib/` must never depend on `commands/`, and the real implementation
   * (`commands/cloud.ts`'s `authenticateApi`) pulls in the whole loopback +
   * device-grant machinery, which `new` and `validate` must not pay for.
   *
   * It is the SAME ladder `cloud connect` runs — one browser flow, one device
   * flow, one machine-credential exchange, one set of 04 §9 failure messages
   * (D12) — minus the project binding: `serve` must never write
   * `.claude/pipeline/cloud.json` into a department folder, because that would
   * pin a clonable repo to one org and one server.
   */
  authenticate: (opts: ApiAuthOptions) => Promise<ApiAuth>;
  /**
   * a10 (`retire`): whether this process can actually prompt someone right
   * now. Optional — production defaults to `defaultIsInteractive` (a real
   * TTY); `--json` overrides it to `false` regardless (D27), so this is only
   * ever consulted for the plain-text path. Injected (rather than reading
   * `process.stdin.isTTY` inline) so the "refuses without --yes when
   * non-interactive" DoD box is testable without faking a real terminal.
   */
  isInteractive?: () => boolean;
  /** a10 (`retire`): the confirmation prompt shown when `--yes` was not
   *  passed and `isInteractive()` is true. Optional — production reads one
   *  line from stdin (`defaultConfirm`). */
  confirm?: (message: string) => Promise<boolean>;
  /**
   * x13 (step 9): the only wait `serve` ever performs — the short backoff
   * between re-reads of the department's `online` flag while a RUNNING
   * supervisor has not yet been seen by the control plane. Optional;
   * production is a real timer. Injected so the verification tests are
   * instant and so the wait can never leak into a suite as a real sleep.
   */
  sleep?: (ms: number) => Promise<void>;
}

function realHostname(): string {
  try {
    return osHostname();
  } catch {
    return 'this-machine';
  }
}

/** Production wiring. Built lazily (and the `cloud` import is dynamic) so the
 *  cost lands only on a `serve` invocation. */
export function realServeDeps(): ServeCommandDeps {
  return {
    fetch: async (url, init) => (await fetch(url, init as RequestInit)) as unknown as ServeHttpResponse,
    shell: realShell,
    out: (s) => {
      process.stdout.write(s);
    },
    err: (s) => {
      process.stderr.write(s);
    },
    env: process.env,
    cwd: process.cwd(),
    hostname: realHostname,
    authenticate: async (opts) => {
      const { authenticateApi, realDeps } = await import('./cloud');
      return await authenticateApi(realDeps, opts);
    },
    sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
  };
}

interface ServeArgs {
  file?: string;
  org?: string;
  server?: string;
  runnerName?: string;
  runtimeCommand?: string;
  machineToken?: string;
  device: boolean;
  reauth: boolean;
  foreground: boolean;
  json: boolean;
  help: boolean;
  unknownFlag?: string;
  extra?: string;
}

const SERVE_USAGE =
  'Usage: pipeline department serve [--org <slug>] [--runner-name <n>] [--detach|--foreground] [--json]\n' +
  '                                 [--file <path>] [--server <url>] [--device] [--reauth]\n' +
  '                                 [--machine-token <token>] [--runtime-command <cmd>]';

function parseServeArgs(args: string[]): ServeArgs {
  const out: ServeArgs = { device: false, reauth: false, foreground: false, json: false, help: false };
  const take = (i: number) => args[i + 1];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    const eq = (p: string) => (a.startsWith(p + '=') ? a.slice(p.length + 1) : undefined);
    if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--device') out.device = true;
    else if (a === '--reauth') out.reauth = true;
    // `--detach` is the DEFAULT (a supervisor service that starts on boot), so
    // it is accepted and does nothing — a user who types it should not get a
    // usage error for asking for what already happens.
    else if (a === '--detach') out.foreground = false;
    else if (a === '--foreground') out.foreground = true;
    else if (a === '--file') out.file = take(i++);
    else if (eq('--file') !== undefined) out.file = eq('--file');
    else if (a === '--org') out.org = take(i++);
    else if (eq('--org') !== undefined) out.org = eq('--org');
    else if (a === '--server') out.server = take(i++);
    else if (eq('--server') !== undefined) out.server = eq('--server');
    else if (a === '--runner-name') out.runnerName = take(i++);
    else if (eq('--runner-name') !== undefined) out.runnerName = eq('--runner-name');
    else if (a === '--runtime-command') out.runtimeCommand = take(i++);
    else if (eq('--runtime-command') !== undefined) out.runtimeCommand = eq('--runtime-command');
    else if (a === '--machine-token') out.machineToken = take(i++);
    else if (eq('--machine-token') !== undefined) out.machineToken = eq('--machine-token');
    else if (a === '--') continue;
    else if (a.startsWith('-')) out.unknownFlag = a;
    else out.extra = a;
  }
  return out;
}

function serveHelpText(): string {
  return (
    `${SERVE_USAGE}\n\n` +
    'Take the department described by department.yml live: validate it, sign in,\n' +
    'register it (or update it when the manifest changed), enrol this machine as a\n' +
    'runner if it is not one, bind the runtime locally, make sure a supervisor is\n' +
    'installed, claim the install, and report.\n\n' +
    'Idempotent and resumable: re-running after any failure re-checks each step and\n' +
    'performs only what is missing. Nothing is ever written INSIDE the department\n' +
    'folder — the credential lives in the per-user store and the runtime binding in\n' +
    "pipeline-runner's own config dir (written by `pipeline-runner bind`).\n\n" +
    'The final line reports only what was OBSERVED: `online` is printed when the\n' +
    'control plane says so, `registered — not serving` with the reason and the fix\n' +
    'when this machine has no running supervisor (or the department is offline), and\n' +
    '`could not confirm it is live` when neither could be read.\n\n' +
    'Options:\n' +
    `  --file <path>          The manifest (default: ./${DEPARTMENT_MANIFEST_FILENAME}).\n` +
    '  --org <slug>           Which org to publish into (required with a machine\n' +
    '                         credential, which has no discoverable org).\n' +
    '  --server <url>         Control-plane base URL.\n' +
    "  --runner-name <n>      Name for this machine's runner (default: hostname).\n" +
    '  --runtime-command <c>  Executable this machine runs for engines whose\n' +
    "                         binary is not authored: 'pipeline' (engine:\n" +
    "                         pipeline) and 'claude' (engine: claude-code).\n" +
    '  --detach               Install the supervisor as a service (the default).\n' +
    '  --foreground           Do not install a service — you run the supervisor\n' +
    '                         yourself. One ALREADY running here (foreground or\n' +
    '                         otherwise) is detected and reported as serving.\n' +
    '  --device / --reauth    Passed to the authentication ladder.\n' +
    `  --machine-token <t>    ${MACHINE_TOKEN_ENV} is the documented form (argv is\n` +
    '                         world-readable in `ps`).\n' +
    '  --json                 Emit one JSON object on stdout; progress to stderr.\n' +
    '  --help, -h             Show this help.\n' +
    '\n' +
    'Exit: 0 online / waiting for approval / could not be confirmed (every step this\n' +
    'command controls succeeded) · 1 a step failed, or the department is registered\n' +
    'and NOT serving · 2 usage, or a missing or unparseable manifest.\n'
  );
}

/** Everything `serve` learned, for `--json`. Mirrors the human transcript one
 *  key per line, so a scripted caller never has to parse prose. */
interface ServeJson {
  ok: boolean;
  state: ServeState;
  org: string;
  department: { id: string | null; slug: string; digest: string; registration: string | null };
  runner: { id: string | null; name: string; enrolment: 'existing' | 'new' | null };
  binding: { adapter: string; command: string; lifecycle?: string } | null;
  supervisor: 'installed' | 'already-installed' | 'skipped' | null;
  install: { id: string; pendingApproval: boolean; policy?: string; changed: boolean } | null;
  /**
   * x13: the EVIDENCE behind the state, so a scripted caller gets the same
   * three-way distinction the transcript does and never has to infer liveness
   * from `ok`. `verdict` is the answer; `supervisorState` and `cloudOnline`
   * are what it was derived from — including `cloudOnline: null`, which is
   * "not observed" and is deliberately not spelled `false`. `null` on this
   * key means step 9 was never reached (an earlier step failed, or the
   * install is awaiting approval).
   *
   * x39: `supervisorState` is the SERVICE probe and `localDaemon` is the
   * PROCESS probe, and they are reported separately because they answer
   * different questions and neither subsumes the other. A `--foreground` run
   * on a live machine is `supervisorState: "not-installed"` with
   * `localDaemon: "running"`; reading only the first is what produced a
   * `not-live` verdict, exit 1, and an invented "another machine" for a
   * department that was serving from this one.
   */
  liveness: {
    verdict: Liveness['verdict'];
    supervisorState: RunnerServiceState;
    localDaemon: LocalDaemonState;
    cloudOnline: boolean | null;
    reason?: string;
    nextStep?: string;
    cloudError?: string;
  } | null;
  url: string;
  warnings: string[];
  error?: string;
}

/**
 * `pipeline department serve` — 05 §5's nine steps, in order.
 *
 * Ordering is load-bearing, not stylistic:
 *  - **1–3 are local and happen before ANY registration.** Validation, and the
 *    local runtime binding this machine would write, are both resolved first,
 *    so a manifest that cannot be served never becomes a cloud record. (05 §5
 *    step 1: "any error aborts before anything is registered".)
 *  - **5 before 8**, because the install claim requires a `runner_id` and a
 *    freshly cloned machine has none (D26 — the whole reason enrolment folds
 *    into `serve`).
 *  - **6 before 7**: binding first means a machine that ALREADY runs a
 *    supervisor is serving the moment the binding lands (b1 signals a reload),
 *    and the service step is then a no-op rather than a restart.
 *  - **9 is a MEASUREMENT, not a summary** (x13). Steps 1–8 are things this
 *    command does; whether the result is actually taking work is a thing only
 *    the machine and the control plane know. Step 9 asks both and says only
 *    what they answered — see `confirmOnline` below and `assessLiveness` in
 *    `lib/department-serve.ts`. Deriving the final line from "the previous
 *    eight steps returned ok" is exactly the bug x13 fixed.
 *
 * There is no rollback and none is wanted (05 §5): a registered-but-not-
 * serving department is inert and visible, and deleting cloud state because a
 * local step failed would be worse. Every failure therefore states what DID
 * happen, names the recovery, and leaves the rest for the next run.
 */
export async function runDepartmentServe(args: string[], deps: ServeCommandDeps = realServeDeps()): Promise<number> {
  const a = parseServeArgs(args);
  const say = (s: string): void => (a.json ? deps.err(s) : deps.out(s));
  const usage = (msg: string): number => {
    deps.err(`pipeline department serve: ${msg}\n${SERVE_USAGE}\n`);
    return 2;
  };

  if (a.help) {
    deps.out(serveHelpText());
    return 0;
  }
  if (a.unknownFlag !== undefined) return usage(`unknown flag '${a.unknownFlag}'`);
  if (a.extra !== undefined) return usage(`unexpected argument '${a.extra}'`);

  // 04 §3: "Ambiguity is an error, not a guess" — the same rule `cloud
  // connect` applies, checked here before any I/O so it is a clean exit 2
  // regardless of which source named the credential.
  const machineToken = (a.machineToken ?? deps.env[MACHINE_TOKEN_ENV] ?? '').trim();
  if (machineToken.length > 0 && a.device) {
    return usage(`--machine-token (or ${MACHINE_TOKEN_ENV}) cannot be combined with --device`);
  }

  // Resolved against the INJECTED cwd, never `process.cwd()` — the same seam
  // every other side effect goes through, so a test (and a scripted caller
  // that passes `--file`) never depends on the real working directory.
  const filePath = a.file !== undefined ? resolve(deps.cwd, a.file) : join(deps.cwd, DEPARTMENT_MANIFEST_FILENAME);
  const manifestDir = dirname(filePath);
  const warnings: string[] = [];
  /** Say a non-fatal fact AT THE MOMENT IT IS DISCOVERED, and keep it for
   *  `--json`. Printing warnings where they happen (rather than batched at the
   *  end) means a run that fails three steps later still showed them. */
  const warn = (message: string): void => {
    warnings.push(message);
    say(`⚠ ${message}\n`);
  };

  // ---- Step 1: validate, in full ------------------------------------------
  // A step-1 failure emits `validate --json`'s OWN payload rather than the
  // serve payload below: what a caller needs here is the findings, in the
  // shape it already parses from `validate`, and there is no serve state yet
  // to report (nothing has been contacted, let alone registered).
  const inspection = inspectManifestFile(filePath);
  if (inspection.fatal !== undefined || inspection.manifest === null) {
    // 05 §4's exit-2 class: missing or unparseable. Nothing was registered.
    if (a.json) deps.out(JSON.stringify(buildJsonResult(filePath, inspection.findings), null, 2) + '\n');
    else if (inspection.fatal !== undefined) deps.err(`pipeline department serve: ${inspection.fatal}\n`);
    else printHuman(deps.err, filePath, null, inspection.findings);
    return 2;
  }
  const manifest = inspection.manifest;
  if (hasErrors(inspection.findings)) {
    // The `validate` findings, verbatim — 05 §5's step-1 failure row is "the
    // validate findings", so this prints the same report the user would get
    // from `pipeline department validate`, then stops.
    if (a.json) deps.out(JSON.stringify(buildJsonResult(filePath, inspection.findings), null, 2) + '\n');
    else {
      printHuman(deps.err, filePath, manifest, inspection.findings);
      deps.err('\nNothing was registered. Fix the errors above and re-run.\n');
    }
    return 1;
  }
  for (const f of inspection.findings) {
    if (f.severity === 'warning') warn(`${f.field}: ${f.message}`);
  }

  // Still step 1, and deliberately so: the LOCAL runtime binding is resolved
  // before anything is registered, because a manifest this machine cannot bind
  // is a manifest it cannot serve, and a cloud record for it would be inert.
  const bindingResult = runtimeBindingFor(manifest, {
    manifestDir,
    ...(a.runtimeCommand !== undefined ? { runtimeCommand: a.runtimeCommand } : {}),
  });
  if (!bindingResult.ok) {
    deps.err(`pipeline department serve: ${bindingResult.message}\n  Nothing was registered.\n`);
    return 1;
  }
  const binding = bindingResult.binding;
  for (const w of binding.warnings) warn(w);

  // ---- Step 2: authenticate (04 §4's ladder) ------------------------------
  let auth: ApiAuth;
  try {
    auth = await deps.authenticate({
      ...(a.server !== undefined ? { server: a.server } : {}),
      ...(a.org !== undefined ? { org: a.org } : {}),
      ...(machineToken.length > 0 ? { machineToken } : {}),
      device: a.device,
      reauth: a.reauth,
      json: a.json,
    });
  } catch (e) {
    deps.err(`pipeline department serve: ${(e as Error).message}\n  Nothing was registered.\n`);
    return 1;
  }
  const ctx: CloudContext = {
    server: auth.server,
    accessToken: auth.accessToken,
    orgSlug: auth.orgSlug,
    ...(auth.orgId !== undefined ? { orgId: auth.orgId } : {}),
  };
  // 05 §5's transcript line. The email is printed only when the identity
  // endpoint supplied one (never for a machine credential, which has no human
  // behind it) — an invented "as <someone>" would be worse than its absence.
  say(auth.userEmail ? `✓ Authorized as ${auth.userEmail}    org: ${auth.orgSlug}\n` : `✓ Authorized      org: ${auth.orgSlug}\n`);

  // ---- Step 3: compute the digest (never authored — D15) ------------------
  // `buildRegistrationRequest` computes the digest over the SAME advertised
  // object that becomes the body, and re-checks that body against a7's
  // deny-list — so what an admin approves is literally what was published, and
  // the `runtime:` half provably never leaves this machine.
  const request = buildRegistrationRequest(manifest);

  const json: ServeJson = {
    ok: false,
    state: 'registered-not-serving',
    org: auth.orgSlug,
    department: { id: null, slug: request.slug, digest: request.manifest_digest, registration: null },
    runner: { id: null, name: '', enrolment: null },
    binding: null,
    supervisor: null,
    install: null,
    liveness: null,
    url: departmentUrlFor(auth.server, request.slug),
    warnings,
  };
  /** One exit point for every outcome: prints the JSON object (or nothing, in
   *  human mode, where each step already printed its own line) and returns. */
  const finish = (code: number, state: ServeState, error?: string): number => {
    json.ok = code === 0;
    json.state = state;
    if (error !== undefined) json.error = error;
    if (a.json) deps.out(JSON.stringify(json, null, 2) + '\n');
    return code;
  };
  const fail = (message: string, state: ServeState = 'registered-not-serving'): number => {
    deps.err(`pipeline department serve: ${message}\n`);
    return finish(1, state, message);
  };

  // ---- Step 4: register or update -----------------------------------------
  const registration = await registerOrUpdateDepartment(deps, ctx, request);
  if (!registration.ok) {
    // Every failure here happened BEFORE the department existed (or before an
    // edit landed on it), so the reported state says exactly that rather than
    // implying a record the org does not have.
    return fail(registration.message, 'not-registered');
  }
  const department = registration.department;
  json.department.id = department.id;
  json.department.registration = registration.action;
  say(
    `✓ Registered      ${auth.orgSlug} / ${department.slug}` +
      (registration.action === 'updated'
        ? '  (manifest changed)\n'
        : registration.action === 'unchanged'
          ? '  (unchanged)\n'
          : '\n'),
  );

  // ---- Step 5: enrol this machine as a runner (D26) -----------------------
  // `lib/runner-enrol.ts` declares its own structurally-identical HTTP seam
  // (lib/ must not depend on commands/, so it duplicates the shape rather
  // than importing one) — the two are assignable, no cast needed.
  const runnerDeps: RunnerEnrolDeps = { shell: deps.shell, fetch: deps.fetch, out: say, err: say };
  // ONE `service status` shell per invocation (a6's rule): the answer is used
  // both to decide whether enrolment may install a service and by step 7.
  // x13: the FULL state is kept, not just the boolean — `stopped` and
  // `running` are both "installed", and step 9 may not treat them alike.
  let serviceState: RunnerServiceState = readRunnerServiceState(runnerDeps);
  const serviceInstalled = serviceState !== 'not-installed';
  const identity = readRunnerIdentity(runnerDeps);
  const runnerName =
    a.runnerName && a.runnerName.length > 0 ? a.runnerName : deps.hostname();
  json.runner.name = runnerName;

  let runnerId = identity?.runnerId ?? null;
  if (runnerId !== null) {
    json.runner.enrolment = 'existing';
    say(`✓ This machine    already a runner\n`);
    // A machine enrolled against a DIFFERENT control plane holds a runner id
    // this org has never heard of, so the claim in step 8 would 404 with a
    // message that does not explain itself. Say it here instead, where the
    // cause is visible. Not fatal: the operator may have deliberately pointed
    // one machine at two servers, and the claim's own error still decides.
    if (identity?.baseUrl && identity.baseUrl.replace(/\/+$/, '') !== auth.server) {
      warn(
        `this machine is registered as a runner against ${identity.baseUrl}, but you are serving to ${auth.server} — ` +
          're-run `pipeline-runner register --url <this server> …` if the install claim below fails',
      );
    }
  } else {
    // 05 §5 step 5: shell out to `pipeline-runner register`, never write its
    // config store. `installService: false` keeps step 7's one-service-per-
    // machine decision where it belongs — here, not inside enrolment.
    const outcome = await enrolRunner(runnerDeps, {
      server: auth.server,
      accessToken: auth.accessToken,
      ...(auth.orgId !== undefined ? { orgId: auth.orgId } : {}),
      name: runnerName,
      installService: false,
    });
    runnerId = outcome.runnerId ?? null;
    if (outcome.status === 'install-failed' || outcome.status === 'mint-failed' || outcome.status === 'register-failed' || runnerId === null) {
      return fail(
        `Registered, but this machine could not be enrolled: ${outcome.detail ?? outcome.status}\n` +
          '  The department stays registered and offline. Re-run `pipeline department serve` once the cause is fixed.',
      );
    }
    json.runner.enrolment = 'new';
    say(`✓ This machine    registered as runner '${runnerName}'\n`);
  }
  json.runner.id = runnerId;

  // ---- Step 6: bind the runtime locally (b1's store, via its own CLI) -----
  const bound = bindRuntime(deps, department.id, binding);
  if (!bound.ok) {
    return fail(`${bound.message}\n  Fix it and re-run — the department stays registered.`);
  }
  json.binding = {
    adapter: binding.adapterId,
    command: binding.command,
    ...(binding.lifecycle !== undefined ? { lifecycle: binding.lifecycle } : {}),
  };
  // x39: `bind` reports whether a supervisor PROCESS holds this machine's
  // runner home — the one local observation that sees a FOREGROUND supervisor,
  // which `service status` structurally cannot. Step 7 and step 9 both need
  // it; it is read exactly here, where it was produced.
  const localDaemon = bound.daemon;
  say(`✓ Runtime bound   ${manifest.runtime.engine} → ${binding.command}\n`);

  // ---- Step 7: ensure the supervisor (one per machine — D26) --------------
  if (a.foreground) {
    json.supervisor = 'skipped';
    // x39: `--foreground` means "I run the supervisor myself", so the
    // interesting question is whether one IS running — not whether a service
    // was installed (this run deliberately installed none). Telling a user
    // with a live foreground supervisor to go start one is the same wrong
    // narration step 9 used to close with.
    if (localDaemon === 'running') {
      say('✓ Supervisor      a foreground supervisor is running here (--foreground: no service installed)\n');
    } else {
      say('· Supervisor      not installed (--foreground)\n');
      say(
        localDaemon === 'none'
          ? `    None is running here either. Run it here:  ${SUPERVISOR_FOREGROUND_HINT}\n`
          : `    Run it here:  ${SUPERVISOR_FOREGROUND_HINT}\n`,
      );
    }
  } else {
    const supervisor = ensureSupervisor(deps, serviceInstalled);
    if (!supervisor.ok) {
      return fail(
        `Registered and bound, but ${supervisor.message}\n` +
          '  Install it manually (`pipeline-runner service install`), or re-run.',
      );
    }
    json.supervisor = supervisor.action;
    if (supervisor.action === 'installed') {
      // x13: the world just changed, so the state read at step 5 is stale.
      // This is the ONE case that re-shells `service status` — a6's rule is
      // "ask the machine-level question once", not "never notice an answer
      // this command itself invalidated". Windows' backend starts the service
      // best-effort (`sc start`'s exit code is deliberately not checked), so
      // "install succeeded" is not by itself evidence that one is running.
      serviceState = readRunnerServiceState(runnerDeps);
      say(
        serviceState === 'running'
          ? '✓ Supervisor      installed, starts on boot\n'
          : '⚠ Supervisor      installed, but it is not running\n',
      );
    } else if (serviceState === 'running') {
      say('✓ Supervisor      already installed and running (shared with cloud pipeline dispatch)\n');
    } else if (serviceState === 'stopped') {
      // x39: "the SERVICE is down" and "nothing is running here" are different
      // facts, and a foreground supervisor makes the second one false without
      // touching the first.
      say(
        localDaemon === 'running'
          ? '⚠ Supervisor      the installed service is NOT running — but a supervisor process is holding this runner home\n'
          : '⚠ Supervisor      already installed, but NOT running\n',
      );
    } else {
      say('· Supervisor      already installed (its state could not be read)\n');
    }
  }

  // ---- Step 8: claim the install, then the org's approval policy ----------
  const claim = await claimInstall(deps, ctx, department.id, runnerId, request.manifest_digest);
  if (!claim.ok) {
    return fail(`Registered, but ${claim.message}\n  Re-run to try again.`);
  }
  json.install = {
    id: claim.claim.id,
    pendingApproval: claim.claim.pendingApproval,
    ...(claim.claim.policy !== undefined ? { policy: claim.claim.policy } : {}),
    changed: claim.claim.changed,
  };

  // ---- Step 9: report ------------------------------------------------------
  // (Every warning was already said where it was found — see `warn` above.)
  if (claim.claim.pendingApproval) {
    // 07 §4's second transcript. The department is registered and claimed; it
    // is an ADMIN's decision away from serving, which is not a failure.
    say(`\n${renderState('waiting-approval', department.slug)}\n`);
    say(`   ${json.url}\n\n`);
    say("You'll be notified when it's approved.\n");
    return finish(0, 'waiting-approval');
  }

  // x13: everything above this point is a thing `serve` DID. What follows is
  // the one thing it can only OBSERVE — whether the result is actually taking
  // work — and 05 §5's closing rule ("never a bare `online`") is enforced by
  // making the claim a function of that observation rather than of the steps.
  const evidence = { supervisor: serviceState, localDaemon, foreground: a.foreground, server: auth.server };
  // x39: the backoff exists for a supervisor that is coming up but has not
  // reported in yet — and a foreground one is exactly as worth waiting for as
  // a service one. Same predicate step 9 judges by, so the wait and the
  // verdict can never disagree about whether a supervisor is up.
  const cloud = await confirmOnline(deps, ctx, department.id, localSupervisorIsUp(evidence), say);
  const liveness = assessLiveness({
    ...evidence,
    cloudOnline: cloud.online,
    ...(cloud.error !== undefined ? { cloudError: cloud.error } : {}),
  });
  json.liveness = {
    verdict: liveness.verdict,
    supervisorState: serviceState,
    // x39: the SECOND local observation, reported next to the first so a
    // scripted caller can tell "no service, but a supervisor process is
    // running here" from "nothing is running here" — the distinction the
    // human transcript now makes, and the one whose absence produced a wrong
    // verdict and an invented cause.
    localDaemon,
    cloudOnline: cloud.online,
    ...(liveness.verdict !== 'live' ? { reason: liveness.reason, nextStep: liveness.nextStep } : {}),
    ...(cloud.error !== undefined ? { cloudError: cloud.error } : {}),
  };

  if (liveness.verdict === 'live') {
    say(`\n${renderState('online', department.slug)}\n\n`);
    say(`Callable now:  "ask the ${department.slug} department to …"\n`);
    return finish(0, 'online');
  }

  if (liveness.verdict === 'undetermined') {
    // Every step this command controls succeeded; only the confirmation did
    // not. That is not a failed `serve`, so it is not exit 1 — but it is also
    // not `online`, so it does not get that line.
    say(`\n${renderState('unconfirmed', department.slug, liveness.reason)}\n`);
    say(`   ${liveness.nextStep}\n`);
    return finish(0, 'unconfirmed');
  }

  // Registered, bound and claimed — and positively NOT taking work. 05 §5's
  // closing rule, with the cause and the remedy attached.
  say(`\n${renderState('registered-not-serving', department.slug, liveness.reason)}\n`);
  say(`   ${liveness.nextStep}\n`);
  return finish(1, 'registered-not-serving', liveness.reason);
}

/** The re-read schedule when a RUNNING supervisor has not been seen by the
 *  control plane yet — ~15s worst case, and only ever spent on the one case
 *  where a `false` is likely to become a `true` on its own. */
const ONLINE_RECHECK_BACKOFF_MS = [1000, 2000, 4000, 8000] as const;

/**
 * x13, step 9's remote half: ask the control plane whether it considers this
 * department online — the ONE authority for that word (a department is online
 * iff an `active` install's runner holds a live gateway connection).
 *
 * **Why this tolerates a short delay.** On a machine where step 7 just
 * installed the service, the supervisor is starting while this runs; its
 * gateway connection — and therefore the department's online-ness — arrives a
 * moment later. Reading once and reporting "not serving" would replace one
 * wrong answer with another on the healthiest possible path. So when a
 * supervisor is RUNNING and the answer is still `false`, this re-reads on a
 * short backoff (~15s worst case) and says out loud that it is waiting. It
 * never waits when there is nothing to wait FOR: a stopped or unreadable
 * supervisor is not going to connect, and a transport failure will not fix
 * itself inside fifteen seconds.
 *
 * x39: `supervisorIsUp` is `localSupervisorIsUp()`'s answer, not
 * `serviceState === 'running'`. A FOREGROUND supervisor that just received
 * the binding is precisely as worth waiting for, and keying the wait off the
 * service probe alone meant a `--foreground` run gave the one supervisor it
 * expects to exist zero seconds to report in.
 *
 * A read that fails returns `online: null` — "not observed" — and never
 * `false`. That distinction is the whole point: `false` is a fact about the
 * department, `null` is a fact about this command.
 */
async function confirmOnline(
  deps: ServeCommandDeps,
  ctx: CloudContext,
  departmentId: string,
  supervisorIsUp: boolean,
  say: (s: string) => void,
): Promise<{ online: boolean | null; error?: string }> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let announced = false;

  for (let attempt = 0; ; attempt++) {
    const res = await fetchDepartmentProfile(deps, ctx, departmentId);
    if (!res.ok) return { online: null, error: res.message };
    if (res.profile.online) return { online: true };
    // Only a running supervisor is worth waiting for.
    if (!supervisorIsUp || attempt >= ONLINE_RECHECK_BACKOFF_MS.length) return { online: false };
    if (!announced) {
      say('· Confirming      waiting for the supervisor to report in …\n');
      announced = true;
    }
    await sleep(ONLINE_RECHECK_BACKOFF_MS[attempt]!);
  }
}

// ---------------------------------------------------------------------------
// Shared: resolve `manifest.name` to a department id (task a10)
// ---------------------------------------------------------------------------

/**
 * `status`/`stop`/`retire` all need a department id, and a10 builds on a9's
 * hard rule that a department folder is a clonable git repo and stores none
 * of its own — the id lives only in the cloud and in `pipeline-runner`'s own
 * binding store (b1). Resolution order: THIS machine's own binding first
 * (zero network — see `department-serve.ts`'s "a10" section doc for why
 * `cwd` alone is already a unique local key), the cloud's slug list
 * otherwise. `stop` calls `resolveLocalDepartmentId` directly (it has no use
 * for the cloud fallback — see its own doc); this shared helper is for the
 * two verbs that DO have (or, for `retire`, must have) a live credential.
 */
async function resolveDepartmentId(
  shell: ShellRunner,
  manifest: DepartmentManifest,
  manifestDir: string,
  cloud: { deps: ServeDeps; ctx: CloudContext } | null,
): Promise<{ ok: true; departmentId: string; source: 'local' | 'cloud' } | { ok: false; message: string }> {
  const bindingResult = runtimeBindingFor(manifest, { manifestDir });
  if (bindingResult.ok) {
    const local = resolveLocalDepartmentId(shell, bindingResult.binding);
    if (local.departmentId !== null) return { ok: true, departmentId: local.departmentId, source: 'local' };
  }
  if (cloud === null) {
    return {
      ok: false,
      message: `'${manifest.name}' is not bound on this machine, and no cloud connection is available to look it up by name`,
    };
  }
  const found = await findDepartmentBySlug(cloud.deps, cloud.ctx, manifest.name);
  if (!found.ok) return { ok: false, message: found.message };
  return { ok: true, departmentId: found.department.id, source: 'cloud' };
}

// ---------------------------------------------------------------------------
// `stop` — 05 §5's "stop" verb (task a10)
// ---------------------------------------------------------------------------
//
// Deliberately, ENTIRELY LOCAL: "finish in-flight tasks, refuse new offers,
// report offline, leave the registration intact" (05 §5) describes exactly
// what `pipeline-runner unbind` already does (b1's own doc: "executions
// already running for it are NOT cancelled; they finish on their own
// terms") and NOTHING that touches the cloud — no HTTP call, no
// authentication ladder. This is the most literal reading of "leave the
// registration intact": `stop` never asks the control plane about the
// registration at all, so there is structurally nothing it could change.
// It also makes `stop` (unlike `serve`/`retire`) work with the network
// down by construction, not by a fallback path.

interface StopArgs {
  file?: string;
  json: boolean;
  help: boolean;
  unknownFlag?: string;
  extra?: string;
}

const STOP_USAGE = 'Usage: pipeline department stop [--file <path>] [--json]';

function parseStopArgs(args: string[]): StopArgs {
  const out: StopArgs = { json: false, help: false };
  const take = (i: number) => args[i + 1];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = (p: string) => (a.startsWith(p + '=') ? a.slice(p.length + 1) : undefined);
    if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--file') out.file = take(i++);
    else if (eq('--file') !== undefined) out.file = eq('--file');
    else if (a === '--') continue;
    else if (a.startsWith('-')) out.unknownFlag = a;
    else if (out.extra === undefined) out.extra = a;
  }
  return out;
}

function stopHelpText(): string {
  return (
    `${STOP_USAGE}\n\n` +
    'Finish in-flight tasks, refuse new offers, and report offline — WITHOUT\n' +
    'touching the cloud registration, so `pipeline department serve` brings it\n' +
    'straight back with no re-registration and no re-approval.\n\n' +
    'Local only: unbinds this department from the pipeline-runner supervisor on\n' +
    'THIS machine (`pipeline-runner unbind`). Never contacts the control plane —\n' +
    'a department served from another machine is unaffected, and this works with\n' +
    'the network down.\n\n' +
    'Options:\n' +
    `  --file <path>  The manifest (default: ./${DEPARTMENT_MANIFEST_FILENAME}).\n` +
    '  --json         Print the result as JSON.\n' +
    '  --help, -h     Show this help.\n'
  );
}

export function runDepartmentStop(args: string[], deps: ServeCommandDeps = realServeDeps()): number {
  const a = parseStopArgs(args);
  const say = (s: string): void => (a.json ? deps.err(s) : deps.out(s));

  if (a.help) {
    deps.out(stopHelpText());
    return 0;
  }
  if (a.unknownFlag !== undefined) {
    deps.err(`pipeline department stop: unknown flag '${a.unknownFlag}'\n${STOP_USAGE}\n`);
    return 2;
  }
  if (a.extra !== undefined) {
    deps.err(`pipeline department stop: unexpected argument '${a.extra}'\n${STOP_USAGE}\n`);
    return 2;
  }

  const filePath = a.file !== undefined ? resolve(deps.cwd, a.file) : join(deps.cwd, DEPARTMENT_MANIFEST_FILENAME);
  const inspection = inspectManifestFile(filePath);
  if (inspection.fatal !== undefined || inspection.manifest === null) {
    if (a.json) deps.out(JSON.stringify(buildJsonResult(filePath, inspection.findings), null, 2) + '\n');
    else if (inspection.fatal !== undefined) deps.err(`pipeline department stop: ${inspection.fatal}\n`);
    else printHuman(deps.err, filePath, null, inspection.findings);
    return 2;
  }
  const manifest = inspection.manifest;
  const manifestDir = dirname(filePath);

  const bindingResult = runtimeBindingFor(manifest, { manifestDir });
  if (!bindingResult.ok) {
    deps.err(`pipeline department stop: ${bindingResult.message}\n`);
    return 1;
  }
  const local = resolveLocalDepartmentId(deps.shell, bindingResult.binding);
  if (local.error !== undefined) {
    deps.err(`pipeline department stop: ${local.error}\n`);
    return 1;
  }
  if (local.refusal !== undefined) {
    deps.err(`pipeline department stop: the runtime binding store was refused — ${local.refusal}\n`);
    return 1;
  }
  if (local.departmentId === null) {
    // Idempotent, matching `serve`'s own ethos: asking to stop something
    // that is not running here is success, not an error.
    if (a.json) {
      deps.out(JSON.stringify({ ok: true, stopped: false, slug: manifest.name }, null, 2) + '\n');
    } else {
      deps.out(`'${manifest.name}' is not currently being served on this machine — nothing to stop.\n`);
    }
    return 0;
  }

  const result = unbindRuntime(deps.shell, local.departmentId);
  if (!result.ok) {
    deps.err(`pipeline department stop: could not unbind — ${result.message}\n`);
    return 1;
  }
  say(`${renderState('stopped', manifest.name)}\n`);
  say('In-flight tasks finish on their own; new offers are refused on this machine.\n');
  say('Registration is untouched — `pipeline department serve` brings it straight back.\n');
  if (a.json) {
    deps.out(
      JSON.stringify({ ok: true, stopped: true, slug: manifest.name, departmentId: local.departmentId }, null, 2) + '\n',
    );
  }
  return 0;
}

// ---------------------------------------------------------------------------
// `retire` — 05 §5's "retire" verb (task a10)
// ---------------------------------------------------------------------------

function defaultIsInteractive(): boolean {
  return process.stdin.isTTY === true;
}

/** A single stdin prompt, `y`/`yes` (case-insensitive) accepted, anything
 *  else (including a blank line — Enter alone must never confirm a
 *  destructive action) declined. */
async function defaultConfirm(message: string): Promise<boolean> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${message} `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

interface RetireArgs {
  file?: string;
  org?: string;
  server?: string;
  machineToken?: string;
  device: boolean;
  reauth: boolean;
  yes: boolean;
  json: boolean;
  help: boolean;
  unknownFlag?: string;
  extra?: string;
}

const RETIRE_USAGE =
  'Usage: pipeline department retire [--yes] [--file <path>] [--org <slug>] [--server <url>]\n' +
  '                                  [--device] [--reauth] [--machine-token <token>] [--json]';

function parseRetireArgs(args: string[]): RetireArgs {
  const out: RetireArgs = { device: false, reauth: false, yes: false, json: false, help: false };
  const take = (i: number) => args[i + 1];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    const eq = (p: string) => (a.startsWith(p + '=') ? a.slice(p.length + 1) : undefined);
    if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--device') out.device = true;
    else if (a === '--reauth') out.reauth = true;
    else if (a === '--file') out.file = take(i++);
    else if (eq('--file') !== undefined) out.file = eq('--file');
    else if (a === '--org') out.org = take(i++);
    else if (eq('--org') !== undefined) out.org = eq('--org');
    else if (a === '--server') out.server = take(i++);
    else if (eq('--server') !== undefined) out.server = eq('--server');
    else if (a === '--machine-token') out.machineToken = take(i++);
    else if (eq('--machine-token') !== undefined) out.machineToken = eq('--machine-token');
    else if (a === '--') continue;
    else if (a.startsWith('-')) out.unknownFlag = a;
    else out.extra = a;
  }
  return out;
}

function retireHelpText(): string {
  return (
    `${RETIRE_USAGE}\n\n` +
    'The unpublish verb: soft-delete this department from the org, fail its open\n' +
    'tasks with a stated reason (06-department-registry.md §6), and only then\n' +
    'unbind it from this machine. Requires the owner role.\n\n' +
    'The cloud half goes first on purpose: if it fails (a non-owner, an offline\n' +
    'control plane), this machine is left exactly as it was — still bound, still\n' +
    'serving — instead of unserved while the cloud keeps routing tasks to it.\n\n' +
    'Refused without --yes unless running interactively — this is destructive and\n' +
    'irreversible from the CLI. --json always counts as non-interactive (D27).\n\n' +
    'Options:\n' +
    '  --yes, -y              Confirm without prompting.\n' +
    `  --file <path>          The manifest (default: ./${DEPARTMENT_MANIFEST_FILENAME}).\n` +
    '  --org <slug>           Which org to retire from (required with a machine\n' +
    '                         credential, which has no discoverable org).\n' +
    '  --server <url>         Control-plane base URL.\n' +
    '  --device / --reauth    Passed to the authentication ladder.\n' +
    `  --machine-token <t>    ${MACHINE_TOKEN_ENV} is the documented form.\n` +
    '  --json                 Emit one JSON object on stdout; progress to stderr.\n' +
    '  --help, -h             Show this help.\n'
  );
}

export async function runDepartmentRetire(args: string[], deps: ServeCommandDeps = realServeDeps()): Promise<number> {
  const a = parseRetireArgs(args);
  const say = (s: string): void => (a.json ? deps.err(s) : deps.out(s));

  if (a.help) {
    deps.out(retireHelpText());
    return 0;
  }
  if (a.unknownFlag !== undefined) {
    deps.err(`pipeline department retire: unknown flag '${a.unknownFlag}'\n${RETIRE_USAGE}\n`);
    return 2;
  }
  if (a.extra !== undefined) {
    deps.err(`pipeline department retire: unexpected argument '${a.extra}'\n${RETIRE_USAGE}\n`);
    return 2;
  }
  const machineToken = (a.machineToken ?? deps.env[MACHINE_TOKEN_ENV] ?? '').trim();
  if (machineToken.length > 0 && a.device) {
    deps.err(
      `pipeline department retire: --machine-token (or ${MACHINE_TOKEN_ENV}) cannot be combined with --device\n${RETIRE_USAGE}\n`,
    );
    return 2;
  }

  const filePath = a.file !== undefined ? resolve(deps.cwd, a.file) : join(deps.cwd, DEPARTMENT_MANIFEST_FILENAME);
  const inspection = inspectManifestFile(filePath);
  if (inspection.fatal !== undefined || inspection.manifest === null) {
    if (a.json) deps.out(JSON.stringify(buildJsonResult(filePath, inspection.findings), null, 2) + '\n');
    else if (inspection.fatal !== undefined) deps.err(`pipeline department retire: ${inspection.fatal}\n`);
    else printHuman(deps.err, filePath, null, inspection.findings);
    return 2;
  }
  const manifest = inspection.manifest;
  const manifestDir = dirname(filePath);

  // D27: `--json` always implies non-interactive, product-wide. Otherwise
  // "interactive" means this process could actually show a prompt and read
  // an answer right now.
  const isInteractive = !a.json && (deps.isInteractive ?? defaultIsInteractive)();
  if (!a.yes) {
    if (!isInteractive) {
      deps.err(
        `pipeline department retire: refusing to retire '${manifest.name}' without --yes (not running interactively)\n` +
          '  This soft-deletes the department and fails every open task. Pass --yes to confirm.\n',
      );
      return 1;
    }
    const confirm = deps.confirm ?? defaultConfirm;
    const confirmed = await confirm(
      `Retire '${manifest.name}'? This soft-deletes it and fails every open task. Type 'yes' to confirm:`,
    );
    if (!confirmed) {
      deps.out('Aborted — nothing was retired.\n');
      return 1;
    }
  }

  let auth: ApiAuth;
  try {
    auth = await deps.authenticate({
      ...(a.server !== undefined ? { server: a.server } : {}),
      ...(a.org !== undefined ? { org: a.org } : {}),
      ...(machineToken.length > 0 ? { machineToken } : {}),
      device: a.device,
      reauth: a.reauth,
      json: a.json,
    });
  } catch (e) {
    deps.err(`pipeline department retire: ${(e as Error).message}\n`);
    return 1;
  }
  const ctx: CloudContext = {
    server: auth.server,
    accessToken: auth.accessToken,
    orgSlug: auth.orgSlug,
    ...(auth.orgId !== undefined ? { orgId: auth.orgId } : {}),
  };
  say(
    auth.userEmail
      ? `✓ Authorized as ${auth.userEmail}    org: ${auth.orgSlug}\n`
      : `✓ Authorized      org: ${auth.orgSlug}\n`,
  );

  const resolved = await resolveDepartmentId(deps.shell, manifest, manifestDir, { deps, ctx });
  if (!resolved.ok) {
    deps.err(`pipeline department retire: ${resolved.message}\n`);
    return 1;
  }

  // x49 — the CLOUD half runs first, and the local unbind only after it has
  // succeeded.
  //
  // It used to be the other way round: 05 §5/§6's "retire is stop, then
  // remove" was read as an ordering instruction, and the local unbind was
  // done up front as a best-effort no-op. It is not an ordering instruction —
  // the two halves fail INDEPENDENTLY, and unbinding first means a failed
  // DELETE (the observed case is a NON-OWNER retire, since `DELETE` is
  // owner-only) leaves the department still callable in the cloud and no
  // longer served on this machine. That is strictly worse than either outcome
  // alone: the control plane keeps routing tasks to a department nothing will
  // execute, and `pipeline department stop` — the obvious repair — then
  // reports "nothing to stop", because the binding is already gone.
  //
  // In this order every failure lands in a state that already has a name:
  //   · DELETE fails            -> NOTHING changed. Still registered, still
  //                               served here, still consistent. Re-runnable.
  //   · DELETE ok, unbind fails -> retired in the cloud (a retired department
  //                               is never dispatched to, so it is inert, not
  //                               split) with a stale local binding, and the
  //                               message below names the one command that
  //                               clears it.
  // Nothing ever needs "restoring", because nothing local is undone until the
  // irreversible half has already succeeded — which is why this fix reorders
  // rather than adding a rollback that could itself fail.
  const result = await retireDepartmentRequest(deps, ctx, resolved.departmentId);
  if (!result.ok) {
    deps.err(`pipeline department retire: ${result.message}\n`);
    deps.err(
      `  Nothing on this machine changed: '${manifest.name}' is still bound here and still accepting tasks,\n` +
        '  so the cloud and this machine still agree. Fix the cause above and run retire again.\n',
    );
    if (a.json) {
      deps.out(
        JSON.stringify(
          { ok: false, slug: manifest.name, org: ctx.orgSlug, retired: false, locallyUnbound: false, error: result.message },
          null,
          2,
        ) + '\n',
      );
    }
    return 1;
  }

  // The cloud half is done and cannot be undone from here. Unbinding is
  // best-effort and still never fatal — a machine that never served this
  // department (retiring one served elsewhere) has nothing to unbind, which
  // is exactly `resolveDepartmentId`'s `source: 'cloud'` — but a FAILED
  // unbind is now reported instead of swallowed.
  let locallyUnbound = false;
  let unbindError: string | undefined;
  if (resolved.source === 'local') {
    const unbind = unbindRuntime(deps.shell, resolved.departmentId);
    if (unbind.ok) locallyUnbound = unbind.wasBound;
    else unbindError = unbind.message;
  }

  say(`✓ Retired ${result.slug || manifest.name} from ${ctx.orgSlug}.\n`);
  say(
    result.failedTaskCount > 0
      ? `  ${result.failedTaskCount} open task${result.failedTaskCount === 1 ? '' : 's'} failed with reason "department retired".\n`
      : '  No open tasks were affected.\n',
  );
  if (unbindError !== undefined) {
    // Exit stays 0: the retire itself succeeded and is irreversible, so a
    // non-zero code would push a script into re-running a DELETE that now
    // 404s. The residue is local, inert and repairable, and saying so is the
    // whole point — this is the message whose absence made x49 invisible.
    deps.err(
      `⚠ Retired in ${ctx.orgSlug}, but this machine could not unbind it — ${unbindError}\n` +
        '  It can no longer receive tasks (a retired department is never dispatched to), but the local\n' +
        '  binding is still here. Run `pipeline department stop` to clear it.\n',
    );
  }
  if (a.json) {
    deps.out(
      JSON.stringify(
        {
          ok: true,
          slug: result.slug || manifest.name,
          org: ctx.orgSlug,
          failedTaskCount: result.failedTaskCount,
          locallyUnbound,
          ...(unbindError !== undefined ? { localUnbindError: unbindError } : {}),
        },
        null,
        2,
      ) + '\n',
    );
  }
  return 0;
}

// ---------------------------------------------------------------------------
// `status` — 05 §6 (task a10)
// ---------------------------------------------------------------------------

/**
 * Every side effect `status` performs — its OWN shape, deliberately distinct
 * from `ServeCommandDeps`. `status` NEVER runs the interactive authentication
 * ladder: a routine, possibly-scripted, possibly-`--follow` diagnostic
 * command must never pop a browser or a device code. It needs the
 * credential-READ seam instead (`fs`/`platform`/`homedir`/`now`, mirroring
 * `lib/department-notify.ts`'s `DepartmentNotifyDeps`, which has the identical
 * "headless, silent-or-nothing" requirement) so it can reuse an already-live credential
 * through `ensureFreshCredential` — the ONE function allowed to call the
 * refresh grant (a5) — and fall back to a local-only view for everything
 * else (DoD box 1: "status works with the network down").
 */
export interface StatusCommandDeps {
  shell: ShellRunner;
  fetch: ServeFetch;
  out: (s: string) => void;
  err: (s: string) => void;
  env: Record<string, string | undefined>;
  /** Where a bare `status` looks for `department.yml`. */
  cwd: string;
  fs: CloudFs;
  platform: string;
  homedir: string;
  now: () => number;
  /** Injectable so `--follow` is testable without a real timer. */
  sleep: (ms: number) => Promise<void>;
}

export function realStatusDeps(): StatusCommandDeps {
  return {
    shell: realShell,
    fetch: async (url, init) => (await fetch(url, init as RequestInit)) as unknown as ServeHttpResponse,
    out: (s) => {
      process.stdout.write(s);
    },
    err: (s) => {
      process.stderr.write(s);
    },
    env: process.env,
    cwd: process.cwd(),
    fs: realFs,
    platform: process.platform,
    homedir: osHomedir(),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

interface StatusArgs {
  file?: string;
  follow: boolean;
  json: boolean;
  help: boolean;
  org?: string;
  server?: string;
  /** x50 — the machine credential, same flag and same precedence as
   *  `serve`/`retire` (`--machine-token` beats the environment). */
  machineToken?: string;
  unknownFlag?: string;
  extra?: string;
}

const STATUS_USAGE =
  'Usage: pipeline department status [--follow] [--json] [--file <path>] [--org <slug>] [--server <url>]\n' +
  '                                  [--machine-token <token>]';

function parseStatusArgs(args: string[]): StatusArgs {
  const out: StatusArgs = { follow: false, json: false, help: false };
  const take = (i: number) => args[i + 1];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = (p: string) => (a.startsWith(p + '=') ? a.slice(p.length + 1) : undefined);
    if (a === '--follow') out.follow = true;
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--file') out.file = take(i++);
    else if (eq('--file') !== undefined) out.file = eq('--file');
    else if (a === '--org') out.org = take(i++);
    else if (eq('--org') !== undefined) out.org = eq('--org');
    else if (a === '--server') out.server = take(i++);
    else if (eq('--server') !== undefined) out.server = eq('--server');
    else if (a === '--machine-token') out.machineToken = take(i++);
    else if (eq('--machine-token') !== undefined) out.machineToken = eq('--machine-token');
    else if (a === '--') continue;
    else if (a.startsWith('-')) out.unknownFlag = a;
    else if (out.extra === undefined) out.extra = a;
  }
  return out;
}

function statusHelpText(): string {
  return (
    `${STATUS_USAGE}\n\n` +
    'Show what this department is doing: state, the plan budget, and recent\n' +
    "tasks — from the control plane when a live credential is already stored,\n" +
    'from this machine’s own binding state when it is not. Never triggers an\n' +
    'interactive sign-in (run `pipeline cloud connect` first for the full view).\n\n' +
    'Each task line also shows who asked (sender) and what ran it (engine),\n' +
    'read from this machine’s own runner journal. A task this machine did not\n' +
    'run shows `?` for both — it is never attributed to somebody else.\n\n' +
    'Options:\n' +
    '  --follow       Keep printing an updated snapshot every few seconds until\n' +
    '                 interrupted.\n' +
    `  --file <path>  The manifest (default: ./${DEPARTMENT_MANIFEST_FILENAME}).\n` +
    '  --org <slug>   Which org to read, if the stored credential fits more than\n' +
    '                 one. REQUIRED with a machine credential, which has no\n' +
    '                 discoverable org (unless `pipeline cloud connect` already\n' +
    '                 recorded one for this server).\n' +
    '  --server <url> Control-plane base URL.\n' +
    `  --machine-token <t>  The no-human path; ${MACHINE_TOKEN_ENV} is the documented\n` +
    '                 form. Exchanged silently — it never prompts, which is why\n' +
    '                 this command accepts it at all.\n' +
    '  --json         Print one JSON object per snapshot.\n' +
    '  --help, -h     Show this help.\n'
  );
}

// ---- silent (never-interactive) credential reuse --------------------------

interface MeOrgLite {
  id: string;
  slug: string;
}

function parseMeOrgs(raw: unknown): MeOrgLite[] {
  if (!Array.isArray(raw)) return [];
  const out: MeOrgLite[] = [];
  for (const o of raw) {
    if (typeof o === 'object' && o !== null) {
      const r = o as Record<string, unknown>;
      if (typeof r['id'] === 'string' && typeof r['slug'] === 'string') out.push({ id: r['id'], slug: r['slug'] });
    }
  }
  return out;
}

/**
 * What `GET /api/v1/me` answered. x50 made this a THREE-way outcome instead of
 * `orgs | null`, because the three cases need different sentences and one of
 * them is not a failure at all:
 *
 *  - `unauthorized` — 401. For a MACHINE credential this is the endpoint's
 *    correct answer, not a broken credential: `auth.userId` is a
 *    `machine_credentials` row id, `/me` does `getUserById` on it (cloud
 *    `modules/auth/routes.ts`), and no `users` row will ever match. Reading
 *    that as "offline" is exactly the bug.
 *  - `unavailable` — anything else (network down, 5xx). The offline view is
 *    right, and there is nothing to add to it.
 *  - `ok` — a human identity, with the orgs it belongs to.
 */
type MeOutcome = { kind: 'ok'; orgs: MeOrgLite[] } | { kind: 'unauthorized' } | { kind: 'unavailable' };

/** `GET /api/v1/me` — the SAME identity call `cloud connect`/`department-notify`
 *  make, duplicated in shape rather than imported (`lib/` must not depend on
 *  `commands/`, and this is a one-off read not worth a shared module — the
 *  same call this file already makes twice elsewhere, `department-notify.ts`'s
 *  `fetchMe` and `cloud.ts`'s own). */
async function fetchMeOrgs(deps: Pick<StatusCommandDeps, 'fetch'>, server: string, accessToken: string): Promise<MeOutcome> {
  try {
    const res = await deps.fetch(`${server}/api/v1/me`, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 401 || res.status === 403) return { kind: 'unauthorized' };
    if (res.status !== 200) return { kind: 'unavailable' };
    const body = (await res.json()) as { orgs?: unknown };
    return { kind: 'ok', orgs: parseMeOrgs(body.orgs) };
  } catch {
    return { kind: 'unavailable' };
  }
}

interface SilentAuth {
  server: string;
  accessToken: string;
  orgSlug: string;
  /** The org UUID, when a human identity supplied one. ABSENT on the
   *  machine-credential path — that token carries its own `org_id` claim, so
   *  no `X-Org-Id` header is needed (or knowable): `cloud.ts`'s `ApiAuth` says
   *  the same thing about the same rung of the same ladder. */
  orgId?: string;
}

/**
 * The outcome of one never-interactive auth attempt. `none` carries an
 * optional `reason` — the sentence `status` prints under its offline line.
 *
 * x50: the reason is the point. Every one of these paths used to collapse to
 * a bare `null` and render as "offline — no cloud connection", including the
 * cases that had nothing to do with the network: no credential stored at all,
 * an expired one, and (the reported bug) a machine credential, for which the
 * identity endpoint's 401 is the CORRECT answer and not a connection problem.
 */
type SilentAuthOutcome = { kind: 'ok'; auth: SilentAuth } | { kind: 'none'; reason?: string };

/** What a machine credential needs and cannot discover — the SAME sentence
 *  `cloud connect`'s machine branch throws (`commands/cloud.ts`'s
 *  `authenticateWithMachineCredential`), because it is the same missing fact
 *  for the same reason. */
const MACHINE_ORG_REQUIRED =
  'a machine credential has no discoverable organization — pass --org <slug> (the org it was issued for)';

/**
 * One invocation's memory of an exchanged machine token — created per
 * `runDepartmentStatus` call, never module-global (a module-global cache
 * would outlive an injected clock and leak between tests).
 *
 * `--follow` gathers a fresh snapshot every 5 seconds, and a machine
 * credential has no refresh token, so without this every poll would be a new
 * `client_credentials` exchange: 12 token mints per minute against the AS for
 * a read-only diagnostic. Reusing the bearer until it is nearly expired is
 * what the runner's own client does with the same credential class.
 */
interface MachineTokenCache {
  entry?: { server: string; raw: string; accessToken: string; expiresAt: number | null };
}

/** 30s of slack, so a token is re-exchanged just BEFORE it dies rather than
 *  just after — the same posture as `credential-refresh.ts`'s skew. */
const MACHINE_TOKEN_SKEW_MS = 30_000;

function machineTokenIsStale(entry: { expiresAt: number | null }, now: number): boolean {
  return entry.expiresAt !== null && entry.expiresAt - MACHINE_TOKEN_SKEW_MS <= now;
}

/** The stored record for `server`, or `undefined` for anything that is not a
 *  readable one. Never throws: a corrupt store is a reason to fall back to the
 *  local view, never to crash a diagnostic command. */
function storedCredentialFor(deps: StatusCommandDeps, server: string): StoredCredential | undefined {
  try {
    const path = credentialFilePath({ platform: deps.platform, env: deps.env, homedir: deps.homedir });
    return readCredentialStore(deps.fs, path).servers[server];
  } catch {
    return undefined;
  }
}

/**
 * x50 — the machine-credential rung, for `status`.
 *
 * `cloud connect` already solved this (04§4's ladder, top rung): exchange
 * `PIPELINE_MACHINE_TOKEN` for a bearer, NEVER call `/api/v1/me` (it 401s for
 * this token class by construction), and take the org SLUG from `--org` —
 * the operator who minted the credential from that org's dashboard is the
 * only party that knows it. This runs the very same exchange function, imported
 * rather than re-implemented, so there is one machine-credential flow in this
 * package and not two.
 *
 * It is also the one credential class `status` may obtain rather than merely
 * reuse: the whole reason `status` never runs the ladder is that a routine or
 * `--follow` diagnostic must not pop a browser or a device code, and a
 * `client_credentials` exchange does neither — it is a single POST with no
 * human in it. That is what makes the documented no-human path work here at
 * all, including after the previous token expired (there is no refresh token
 * for this class; re-exchanging IS the refresh, exactly as pipeline-runner's
 * own client does it).
 *
 * `null` means "no machine token anywhere" — the caller falls through to the
 * human path.
 */
async function tryMachineAuth(
  deps: StatusCommandDeps,
  opts: { org?: string; machineToken?: string; machineTokenCache?: MachineTokenCache },
  server: string,
): Promise<SilentAuthOutcome | null> {
  const raw = (opts.machineToken ?? deps.env[MACHINE_TOKEN_ENV] ?? '').trim();
  if (raw.length === 0) return null;

  const cache = opts.machineTokenCache;
  const cached = cache?.entry;
  let accessToken: string | undefined =
    cached !== undefined && cached.server === server && cached.raw === raw && !machineTokenIsStale(cached, deps.now())
      ? cached.accessToken
      : undefined;
  if (accessToken === undefined) {
    try {
      const tok = await exchangeMachineCredential(deps, server, raw);
      accessToken = tok.access_token;
      if (cache !== undefined) {
        cache.entry = {
          server,
          raw,
          accessToken: tok.access_token,
          expiresAt: tok.expires_in ? deps.now() + tok.expires_in * 1000 : null,
        };
      }
    } catch (e) {
      // Relayed verbatim: the server collapses every reject reason (unknown
      // secret, revoked, expired) into one `error_description` on purpose.
      return { kind: 'none', reason: (e as Error).message };
    }
  }

  let orgSlug = opts.org ?? storedCredentialFor(deps, server)?.org_slug;
  if (orgSlug === undefined) {
    // Forward-compatibility, not a workaround: TODAY `/me` 401s for this token
    // class and this costs one wasted request on a path that is otherwise a
    // hard failure. If the control plane ever answers for a machine principal
    // (it now knows it is one — `AuthContext.principalType`, x34), `status`
    // picks the slug up with no new release.
    const me = await fetchMeOrgs(deps, server, accessToken);
    if (me.kind === 'ok' && me.orgs.length === 1) orgSlug = me.orgs[0]!.slug;
  }
  if (orgSlug === undefined) return { kind: 'none', reason: MACHINE_ORG_REQUIRED };
  return { kind: 'ok', auth: { server, accessToken, orgSlug } };
}

/**
 * Best-effort, NEVER-interactive auth: the machine-credential exchange when a
 * machine token is present, otherwise a stored, live (or silently refreshable)
 * human credential. Anything else is `none` WITH A REASON — nothing stored, an
 * expired credential with no refresh token, a refresh that needs a fresh
 * sign-in (`ensureFreshCredential`'s `REAUTH_REQUIRED_MESSAGE`), the server
 * being unreachable, or an ambiguous org. `status` treats `none` exactly like
 * "offline" (DoD box 1) — it renders what it can locally and never pretends to
 * be more than that — but it now says WHICH of those happened.
 */
async function trySilentAuth(
  deps: StatusCommandDeps,
  opts: { server?: string; org?: string; machineToken?: string; machineTokenCache?: MachineTokenCache },
): Promise<SilentAuthOutcome> {
  const server = normalizeServerUrl(opts.server ?? deps.env[SERVER_ENV] ?? DEFAULT_SERVER);

  const machine = await tryMachineAuth(deps, opts, server);
  if (machine !== null) return machine;

  const refreshDeps: RefreshDeps = {
    fetch: deps.fetch,
    fs: deps.fs,
    now: deps.now,
    platform: deps.platform,
    env: deps.env,
    homedir: deps.homedir,
  };
  let cred: StoredCredential;
  try {
    cred = await ensureFreshCredential(refreshDeps, server);
  } catch (e) {
    // An EXPIRED machine credential says so in the vocabulary that can fix it
    // (`--reauth` is a browser flow — meaningless without a human).
    if (storedCredentialFor(deps, server)?.principal === 'machine') {
      return {
        kind: 'none',
        reason:
          `the stored machine credential for ${server} has expired — set ${MACHINE_TOKEN_ENV} ` +
          '(it is re-exchanged automatically) or re-run `pipeline cloud connect --machine-token <token> --org <slug>`',
      };
    }
    return { kind: 'none', reason: (e as Error).message };
  }

  // x50: a credential `cloud connect` recorded as a machine one skips `/me`
  // entirely — the same decision `connect` itself makes, made from the same
  // fact rather than re-derived from a 401.
  if (cred.principal === 'machine') {
    const orgSlug = opts.org ?? cred.org_slug;
    if (orgSlug === undefined) return { kind: 'none', reason: MACHINE_ORG_REQUIRED };
    return { kind: 'ok', auth: { server, accessToken: cred.access_token, orgSlug } };
  }

  const me = await fetchMeOrgs(deps, server, cred.access_token);
  if (me.kind === 'unauthorized') {
    // A credential predating the `principal` marker, or a genuinely dead one.
    // Both are worth a sentence: "offline" alone sent the reporter of x50
    // looking for a network problem that was never there.
    return {
      kind: 'none',
      reason:
        'the stored credential was rejected by the identity endpoint (HTTP 401). If it is a machine credential, ' +
        `set ${MACHINE_TOKEN_ENV} or re-run \`pipeline cloud connect --machine-token <token> --org <slug>\`; ` +
        'otherwise run `pipeline cloud connect --reauth`',
    };
  }
  if (me.kind === 'unavailable') return { kind: 'none' };
  const orgs = me.orgs;
  if (orgs.length === 0) return { kind: 'none', reason: 'this account belongs to no organization yet' };
  const wanted = opts.org ?? cred.org_slug;
  const org = (wanted !== undefined ? orgs.find((o) => o.slug === wanted) : undefined) ?? (orgs.length === 1 ? orgs[0] : undefined);
  if (org === undefined) {
    return {
      kind: 'none',
      reason: `this credential fits ${orgs.length} organizations — pass --org <slug> to say which`,
    };
  }
  return { kind: 'ok', auth: { server, accessToken: cred.access_token, orgSlug: org.slug, orgId: org.id } };
}

// ---- gather + render --------------------------------------------------------

interface StatusCloudView {
  orgSlug: string;
  profile: DepartmentProfile;
  thisInstall: InstallSummary | null;
  /** True when THIS runner's claimed digest lags the department's current
   *  one (05 §5: "several machines serving one department" §6: "a machine
   *  whose digest differs … shows ⚠ serving an older manifest"). */
  staleDigest: boolean;
  usage: DeptUsage | null;
  usageError?: string;
  tasks: DeptTaskSummary[] | null;
  tasksError?: string;
}

interface StatusSnapshot {
  slug: string;
  localDigest: string;
  /** Whether THIS machine currently accepts offers for this department
   *  (`resolveLocalDepartmentId`) — known with the network down. */
  boundLocally: boolean;
  localBindError?: string;
  /** x19: what THIS machine's runner journal recorded for this department —
   *  the only source of `sender`/`engine` there is. `null` when no department
   *  id could be resolved at all (offline and unbound), i.e. there is not even
   *  a file to name. Any other outcome — absent, unreadable, partial — is a
   *  `LocalJournalReading` carrying its own status; none of them is an error. */
  localJournal: LocalJournalReading | null;
  cloud: StatusCloudView | null;
  cloudError?: string;
  warnings: string[];
}

/** One rendered task row: the cloud's task joined to whatever THIS machine
 *  recorded for it. `facts === null` means the local journal has no record of
 *  this task — it ran elsewhere, or no journal is readable here — which is
 *  rendered as UNKNOWN and never as a substituted identity. */
interface TaskRow {
  task: DeptTaskSummary;
  facts: LocalTaskFacts | null;
}

function joinTaskRows(tasks: readonly DeptTaskSummary[], journal: LocalJournalReading | null): TaskRow[] {
  return tasks.map((task) => ({ task, facts: journal?.byTaskId.get(task.id) ?? null }));
}

/**
 * Gather one snapshot. Local facts first (always available), then — only if
 * a credential is already usable, silently — everything the cloud can add.
 * Never throws: every failure narrows what is reported, never crashes the
 * command (DoD box 1).
 */
async function gatherStatusSnapshot(
  deps: StatusCommandDeps,
  manifest: DepartmentManifest,
  manifestDir: string,
  opts: { org?: string; server?: string; machineToken?: string; machineTokenCache?: MachineTokenCache },
): Promise<StatusSnapshot> {
  const warnings: string[] = [];
  const request = buildRegistrationRequest(manifest);

  let boundLocally = false;
  let localBindError: string | undefined;
  let localDepartmentId: string | null = null;
  const bindingResult = runtimeBindingFor(manifest, { manifestDir });
  if (bindingResult.ok) {
    const local = resolveLocalDepartmentId(deps.shell, bindingResult.binding);
    boundLocally = local.bound;
    localDepartmentId = local.departmentId;
    localBindError = local.error ?? local.refusal;
  } else {
    localBindError = bindingResult.message;
  }

  const base = {
    slug: request.slug,
    localDigest: request.manifest_digest,
    boundLocally,
    ...(localBindError !== undefined ? { localBindError } : {}),
    warnings,
  };

  /** x19: the local journal is keyed by department id, so it can only be read
   *  once one is known. x44: asked of `pipeline-runner journal` first, since
   *  only the runner can follow a service-pinned home or name the account that
   *  owns a journal this process cannot read. Never throws, and falls back to
   *  x19's own reader — see `readDepartmentJournal`. */
  const readJournal = (departmentId: string | null): LocalJournalReading | null =>
    departmentId === null
      ? null
      : readDepartmentJournal(deps.shell, deps.fs, { env: deps.env, platform: deps.platform, departmentId });

  const outcome = await trySilentAuth(deps, opts);
  if (outcome.kind !== 'ok') {
    return {
      ...base,
      localJournal: readJournal(localDepartmentId),
      cloud: null,
      ...(outcome.reason !== undefined ? { cloudError: outcome.reason } : {}),
    };
  }
  const auth = outcome.auth;

  const ctx: CloudContext = {
    server: auth.server,
    accessToken: auth.accessToken,
    orgSlug: auth.orgSlug,
    // Absent on the machine path — the token's own claim carries the org.
    ...(auth.orgId !== undefined ? { orgId: auth.orgId } : {}),
  };
  const serveDeps: ServeDeps = { fetch: deps.fetch, shell: deps.shell };

  let departmentId = localDepartmentId;
  if (departmentId === null) {
    const found = await findDepartmentBySlug(serveDeps, ctx, manifest.name);
    if (!found.ok) return { ...base, localJournal: readJournal(localDepartmentId), cloud: null, cloudError: found.message };
    departmentId = found.department.id;
  }
  const localJournal = readJournal(departmentId);

  const profileResult = await fetchDepartmentProfile(serveDeps, ctx, departmentId);
  if (!profileResult.ok) return { ...base, localJournal, cloud: null, cloudError: profileResult.message };
  const profile = profileResult.profile;

  let thisInstall: InstallSummary | null = null;
  let staleDigest = false;
  const identity = readRunnerIdentity({ shell: deps.shell });
  if (identity?.runnerId) {
    const installsResult = await fetchInstalls(serveDeps, ctx, departmentId);
    if (installsResult.ok) {
      thisInstall = installsResult.installs.find((i) => i.runnerId === identity.runnerId) ?? null;
      if (thisInstall !== null && thisInstall.manifestDigest !== null && thisInstall.manifestDigest !== profile.manifestDigest) {
        staleDigest = true;
      }
    } else {
      warnings.push(`could not read this runner's install: ${installsResult.message}`);
    }
  }

  const usageResult = await fetchDeptUsage(serveDeps, ctx);
  const tasksResult = await fetchDeptTasks(serveDeps, ctx, departmentId);

  return {
    ...base,
    localJournal,
    cloud: {
      orgSlug: ctx.orgSlug,
      profile,
      thisInstall,
      staleDigest,
      usage: usageResult.ok ? usageResult.usage : null,
      ...(usageResult.ok ? {} : { usageError: usageResult.message }),
      tasks: tasksResult.ok ? tasksResult.tasks : null,
      ...(tasksResult.ok ? {} : { tasksError: tasksResult.message }),
    },
  };
}

const TASK_STATE_ICON: Record<string, string> = {
  SUBMITTED: '•',
  WORKING: '▶',
  COMPLETED: '✓',
  FAILED: '✗',
  CANCELED: '✗',
  INPUT_REQUIRED: '⏸',
  REJECTED: '✗',
  AUTH_REQUIRED: '⏸',
};
const TASK_STATE_LABEL: Record<string, string> = {
  SUBMITTED: 'queued',
  WORKING: 'running',
  COMPLETED: 'done',
  FAILED: 'failed',
  CANCELED: 'canceled',
  INPUT_REQUIRED: "waiting for the sender's answer",
  REJECTED: 'rejected',
  AUTH_REQUIRED: 'waiting for authorization',
};

function isSameUtcDay(iso: string, now: Date): boolean {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  return (
    d.getUTCFullYear() === now.getUTCFullYear() &&
    d.getUTCMonth() === now.getUTCMonth() &&
    d.getUTCDate() === now.getUTCDate()
  );
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** The first 8 hex characters of a UUID, dashes stripped — matches 05 §6's
 *  own transcript (`8f3c`, `9d11`, …), just longer for less collision risk in
 *  a busy department's history. */
function shortId(id: string): string {
  return id.replace(/-/g, '').slice(0, 8);
}

function shortDigest(d: string | null): string {
  if (d === null) return '—';
  return d.length > 19 ? `${d.slice(0, 19)}…` : d;
}

// ---- sender / engine, from the local runner journal (x19) ------------------

/** This machine has NO record of the task — it ran somewhere else, or nothing
 *  here is readable. Deliberately a different glyph from `—`: `—` is a fact
 *  ("the offer stated no sender"), `?` is the absence of one. Conflating them
 *  is how a status line starts asserting things it does not know. */
const UNKNOWN_CELL = '?';
/** The journal HAS this task, and recorded no value for the column. */
const NONE_CELL = '—';

function senderCell(facts: LocalTaskFacts | null): string {
  if (facts === null) return UNKNOWN_CELL;
  return facts.sender ?? NONE_CELL;
}

function engineCell(facts: LocalTaskFacts | null): string {
  if (facts === null) return UNKNOWN_CELL;
  return facts.engine ?? NONE_CELL;
}

/** Pad to a column width measured over the rows actually being printed —
 *  capped so one pathological 200-char sender (b4's own `MAX_SENDER`) cannot
 *  push the state column off the right edge of every other line. */
const MAX_COLUMN_WIDTH = 32;

function padCell(value: string, width: number): string {
  const clipped = value.length > MAX_COLUMN_WIDTH ? `${value.slice(0, MAX_COLUMN_WIDTH - 1)}…` : value;
  return clipped.padEnd(Math.min(width, MAX_COLUMN_WIDTH));
}

/**
 * x44 — WHOSE journal it is, when this process could not see one.
 *
 * This is the sentence x22 is about, and the whole reason `status` now asks
 * `pipeline-runner journal` rather than reading the file itself. `serve`
 * installs a SERVICE, and on Windows `sc.exe create` with no `obj=` runs it as
 * `LocalSystem`, whose profile directory — and therefore whose journal — is
 * not the invoking user's. The runner reads its own installed definition and
 * reports the account; a `?` renders "never ran here" and "ran here, under an
 * account you cannot read" identically, and only one of those has a fix.
 *
 * `null` whenever nothing was observed, nothing was installed, or the backend
 * genuinely cannot name an account (systemd/launchd install a per-user unit,
 * so the account IS the invoking one and there is nothing to disclose). Says
 * only what the observation established — never "another account has it"
 * inferred from an empty read.
 */
function supervisorOwnershipNote(journal: LocalJournalReading | null | undefined): string | null {
  if (journal === null || journal === undefined) return null;
  const supervisor = journal.supervisor;
  if (supervisor === null || supervisor === undefined || !supervisor.installed) return null;
  // Only meaningful when this process did NOT get the journal. On `ok` it was
  // read — the tasks are simply not in it — and telling a reader whose account
  // owns a file we just read out of would be an explanation of nothing.
  if (journal.status !== 'absent' && journal.status !== 'unreadable') return null;
  // Checked FIRST, because a pinned home means the runner FOLLOWED it: the
  // reading came from the supervisor's own journal, so whose account runs the
  // service is no longer the interesting fact about where we looked.
  if (supervisor.home !== null) {
    return `This machine's supervisor service pins PIPELINE_RUNNER_HOME=${supervisor.home} — that is where this reading looked.`;
  }
  if (supervisor.systemAccount && supervisor.account !== null) {
    return (
      `This machine's supervisor service runs as ${supervisor.account}, a MACHINE account: its journal lives under ` +
      "that account's own profile directory and cannot be read from this one. Read it as that account, or reinstall " +
      'the service pinned to a shared home:  pipeline-runner service install --home <path>'
    );
  }
  if (supervisor.account !== null) {
    return `This machine's supervisor service runs as ${supervisor.account}; its journal belongs to that account, not this one.`;
  }
  return null;
}

/**
 * The one-line explanation printed under a task list that contains at least
 * one unknown cell. It states WHY, per journal status, so `?` is never left
 * looking like a bug: the whole point of x19 is that "we do not know" is said
 * out loud instead of being filled in with the nearest plausible identity.
 *
 * x44 adds the second line the first one could never carry: WHOSE journal was
 * looked at. It is appended, not substituted, so x19's three states (a real
 * sender, `—` for "the offer stated none", `?` for "no local record") and the
 * sentences that explain them are untouched.
 */
function unknownSenderNote(journal: LocalJournalReading | null, unknownCount: number): string | null {
  if (unknownCount === 0) return null;
  const subject = `sender/engine unknown for ${unknownCount} task${unknownCount === 1 ? '' : 's'}`;
  const ownership = supervisorOwnershipNote(journal);
  let head: string;
  switch (journal?.status) {
    case 'ok':
      head = `  ${UNKNOWN_CELL} ${subject} — not run on this machine.`;
      break;
    case 'unreadable':
      head = `  ⚠ ${subject}: this machine's runner journal could not be read (${journal.message ?? 'unknown error'}) — ${journal.path}`;
      break;
    case 'unlocatable':
      head = `  ${UNKNOWN_CELL} ${subject} — ${journal.message ?? "pipeline-runner's data directory could not be located"}.`;
      break;
    case 'absent':
    default:
      // x19's sentence, and its claim ("they ran elsewhere"), hold only while
      // nothing has been observed to the contrary. Once the runner has named
      // an owner for the journal, "elsewhere" is a cause nothing established
      // — the x39 rule — so the head narrows to what the read actually did
      // and the ownership line below carries the rest.
      head =
        ownership === null
          ? `  ${UNKNOWN_CELL} ${subject} — no local runner journal on this machine; they ran elsewhere.`
          : `  ${UNKNOWN_CELL} ${subject} — nothing was recorded for them in the runner journal this account can read.`;
      break;
  }
  return ownership === null ? head : `${head}\n    ${ownership}`;
}

/**
 * 05 §6's `Free plan · department 1 of 3 · 47 of 100 actions used today
 * (resets 00:00 UTC)` line, built ENTIRELY from `GET /api/v1/dept-usage`'s
 * own numbers (a10 DoD: "no client-side arithmetic on quotas") — this
 * function only formats, it never computes a limit/used/remaining figure
 * itself. "Free plan" is inferred from boundedness, never asserted from a
 * plan name this endpoint does not return: D30 is explicit that Free is the
 * only plan bounded on either axis, so a bounded response can only be Free —
 * but this deliberately never claims "Pro"/"Team" for an unbounded one, since
 * nothing here actually says which unlimited plan applies.
 */
function formatBudgetLine(usage: DeptUsage): string {
  const deptPart =
    usage.departments.limit !== null
      ? `department ${usage.departments.used} of ${usage.departments.limit}`
      : `department ${usage.departments.used} used (unlimited)`;
  const dailyPart =
    usage.dailyActions.limit !== null
      ? `${usage.dailyActions.used} of ${usage.dailyActions.limit} actions used today` +
        (usage.dailyActions.resetAt !== null ? ` (resets ${usage.dailyActions.resetAt})` : '')
      : `${usage.dailyActions.used} actions used today (unlimited)`;
  const bounded = usage.departments.limit !== null || usage.dailyActions.limit !== null;
  return `${bounded ? 'Free plan · ' : ''}${deptPart} · ${dailyPart}`;
}

function renderStatusHuman(out: (s: string) => void, snapshot: StatusSnapshot, now: Date): void {
  if (snapshot.cloud === null) {
    const marker = snapshot.boundLocally ? '●' : '○';
    const headline = snapshot.boundLocally ? 'accepting tasks on this machine' : 'not bound on this machine';
    out(`${marker} ${snapshot.slug} — ${headline} (offline — no cloud connection)\n`);
    if (snapshot.localBindError !== undefined) out(`  ⚠ ${snapshot.localBindError}\n`);
    if (snapshot.cloudError !== undefined) out(`  (${snapshot.cloudError})\n`);
    // x19: the journal is the ONE thing here that survives the network being
    // down, so say what it holds rather than nothing. It is not a task list —
    // it records executions this machine admitted, with no state or outcome —
    // so it is reported as a count, never rendered as one.
    const journal = snapshot.localJournal;
    if (journal?.status === 'ok' && journal.executions > 0) {
      out(`  This machine's runner journal has ${journal.executions} recorded execution${journal.executions === 1 ? '' : 's'} for this department.\n`);
    }
    // x44: the same ownership fact the task list prints under its `?` column.
    // It survives the network being down for the same reason the journal does
    // — it comes from this machine's own installed service definition.
    const offlineOwnership = supervisorOwnershipNote(journal);
    if (offlineOwnership !== null) out(`  ${offlineOwnership}\n`);
    out(
      '  The department id, the budget and the task history all need the control\n' +
        '  plane — they stay hidden until it is reachable. Sender and engine come\n' +
        "  from this machine's own runner journal and appear against each task as\n" +
        '  soon as that list is.\n',
    );
    return;
  }

  const { cloud } = snapshot;
  const tasks = cloud.tasks ?? [];
  const running = tasks.filter((t) => t.state === 'WORKING').length;
  const completedToday = tasks.filter((t) => t.state === 'COMPLETED' && isSameUtcDay(t.updatedAt, now)).length;

  let marker: string;
  let headline: string;
  if (cloud.profile.retired) {
    marker = '✗';
    headline = 'retired';
  } else if (!cloud.profile.enabled) {
    marker = '○';
    headline = 'disabled by an admin';
  } else if (cloud.profile.online) {
    marker = '●';
    headline = `online · ${running} running · ${completedToday} completed today`;
  } else if (cloud.thisInstall?.pendingApproval === true) {
    marker = '⏸';
    headline = 'waiting for an admin to approve';
  } else {
    marker = '○';
    headline = `registered — not serving${snapshot.boundLocally ? '' : ' (stopped on this machine)'}`;
  }
  out(`${marker} ${snapshot.slug} — ${headline}\n`);

  if (cloud.usage !== null) out(`${formatBudgetLine(cloud.usage)}\n`);
  else if (cloud.usageError !== undefined) out(`  (budget unavailable: ${cloud.usageError})\n`);

  if (cloud.staleDigest) {
    out(
      `⚠ serving an older manifest — this machine claimed ${shortDigest(cloud.thisInstall!.manifestDigest)}, ` +
        `the department is now at ${shortDigest(cloud.profile.manifestDigest)}. Run \`pipeline department serve\` to update.\n`,
    );
  }
  for (const w of snapshot.warnings) out(`⚠ ${w}\n`);

  if (cloud.tasks === null) {
    out(`\n  (task history unavailable: ${cloud.tasksError ?? 'unknown error'})\n`);
    return;
  }
  if (tasks.length === 0) {
    out('\n  No tasks yet.\n');
    return;
  }
  out('\n');
  // x19: `who asked` + `what ran it`, joined from the LOCAL runner journal.
  // The column here used to be `originPrincipal` — the cloud's authenticated
  // CALLER, which is a different identity from the sender and was being read
  // as one. A cell this machine cannot vouch for now says so (`?`) instead.
  const rows = joinTaskRows(tasks, snapshot.localJournal).sort((x, y) => x.task.updatedAt.localeCompare(y.task.updatedAt));
  const senderWidth = Math.max(...rows.map((r) => senderCell(r.facts).length));
  const engineWidth = Math.max(...rows.map((r) => engineCell(r.facts).length));
  for (const { task, facts } of rows) {
    const icon = TASK_STATE_ICON[task.state] ?? '•';
    const label = TASK_STATE_LABEL[task.state] ?? task.state;
    out(
      `${hhmm(task.updatedAt)}  ${shortId(task.id)}  ${padCell(senderCell(facts), senderWidth)}  ` +
        `${padCell(engineCell(facts), engineWidth)}  ${icon} ${label}\n`,
    );
  }
  const note = unknownSenderNote(snapshot.localJournal, rows.filter((r) => r.facts === null).length);
  if (note !== null) out(`${note}\n`);
}

/** The journal, for `--json`: the same facts the human view uses to decide
 *  what to print and what to say about `?`. `byTaskId` is NOT emitted here —
 *  it is emitted per task, where a consumer needs it.
 *
 *  x44 adds `source`/`supervisor`/`homeSource`/`fallbackReason` — additively,
 *  so nothing a script already reads moves. `source` is what lets a scripted
 *  caller tell a reading pipeline-runner vouched for from one this CLI made by
 *  guessing at the runner's path conventions, and `supervisor` carries the
 *  account that owns a journal this process could not read. */
function localJournalJson(journal: LocalJournalReading | null): Record<string, unknown> | null {
  if (journal === null) return null;
  return {
    status: journal.status,
    path: journal.path,
    executions: journal.executions,
    skippedLines: journal.skipped,
    ...(journal.message !== undefined ? { message: journal.message } : {}),
    source: journal.source,
    ...(journal.homeSource !== undefined ? { homeSource: journal.homeSource } : {}),
    ...(journal.supervisor !== undefined ? { supervisor: journal.supervisor } : {}),
    ...(journal.fallbackReason !== undefined ? { fallbackReason: journal.fallbackReason } : {}),
  };
}

/**
 * A task, with the local join applied — the SAME fields the human view shows
 * (DoD box 4). `localRecord` is what makes `sender: null` unambiguous in JSON:
 * `true` means this machine ran it and recorded no sender; `false` means this
 * machine has no record of the task at all (the human `?`). Every cloud field
 * is passed through untouched, `originPrincipal` included — it is a real field
 * with a real meaning (the authenticated CALLER); it is simply not the sender,
 * which is why the human view no longer prints it where a sender belongs.
 */
function taskJson(row: TaskRow): Record<string, unknown> {
  return {
    ...row.task,
    sender: row.facts?.sender ?? null,
    engine: row.facts?.engine ?? null,
    localRecord: row.facts !== null,
  };
}

function toStatusJson(snapshot: StatusSnapshot, now: Date): Record<string, unknown> {
  if (snapshot.cloud === null) {
    return {
      ok: true,
      slug: snapshot.slug,
      localDigest: snapshot.localDigest,
      boundLocally: snapshot.boundLocally,
      localJournal: localJournalJson(snapshot.localJournal),
      cloud: null,
      ...(snapshot.localBindError !== undefined ? { localBindError: snapshot.localBindError } : {}),
      ...(snapshot.cloudError !== undefined ? { cloudError: snapshot.cloudError } : {}),
    };
  }
  const { cloud } = snapshot;
  const tasks = cloud.tasks ?? [];
  return {
    ok: true,
    slug: snapshot.slug,
    localDigest: snapshot.localDigest,
    boundLocally: snapshot.boundLocally,
    localJournal: localJournalJson(snapshot.localJournal),
    cloud: {
      org: cloud.orgSlug,
      online: cloud.profile.online,
      enabled: cloud.profile.enabled,
      retired: cloud.profile.retired,
      manifestDigest: cloud.profile.manifestDigest,
      staleDigest: cloud.staleDigest,
      thisInstallDigest: cloud.thisInstall?.manifestDigest ?? null,
      pendingApproval: cloud.thisInstall?.pendingApproval ?? false,
      usage: cloud.usage,
      ...(cloud.usageError !== undefined ? { usageError: cloud.usageError } : {}),
      running: tasks.filter((t) => t.state === 'WORKING').length,
      completedToday: tasks.filter((t) => t.state === 'COMPLETED' && isSameUtcDay(t.updatedAt, now)).length,
      // x19: `null` (task history unavailable) stays `null`; a real list
      // carries the same sender/engine the human view renders.
      tasks: cloud.tasks === null ? null : joinTaskRows(cloud.tasks, snapshot.localJournal).map(taskJson),
      ...(cloud.tasksError !== undefined ? { tasksError: cloud.tasksError } : {}),
    },
    warnings: snapshot.warnings,
  };
}

/** Poll interval for `--follow` — frequent enough to feel live, far below any
 *  rate limit (the endpoints this hits are plain org-member reads). */
const STATUS_FOLLOW_INTERVAL_MS = 5000;

/**
 * `pipeline department status` — 05 §6. `maxIterations` is a TEST-ONLY hook
 * (mirrors `lib/department-notify.ts`'s `PollLoopOptions.maxIterations`) so
 * `--follow` is verifiable without an infinite loop or a real timer; a real
 * invocation runs until interrupted.
 */
export async function runDepartmentStatus(
  args: string[],
  deps: StatusCommandDeps = realStatusDeps(),
  maxIterations: number = Number.POSITIVE_INFINITY,
): Promise<number> {
  const a = parseStatusArgs(args);
  if (a.help) {
    deps.out(statusHelpText());
    return 0;
  }
  if (a.unknownFlag !== undefined) {
    deps.err(`pipeline department status: unknown flag '${a.unknownFlag}'\n${STATUS_USAGE}\n`);
    return 2;
  }
  if (a.extra !== undefined) {
    deps.err(`pipeline department status: unexpected argument '${a.extra}'\n${STATUS_USAGE}\n`);
    return 2;
  }

  const filePath = a.file !== undefined ? resolve(deps.cwd, a.file) : join(deps.cwd, DEPARTMENT_MANIFEST_FILENAME);
  const inspection = inspectManifestFile(filePath);
  if (inspection.fatal !== undefined || inspection.manifest === null) {
    if (a.json) deps.out(JSON.stringify(buildJsonResult(filePath, inspection.findings), null, 2) + '\n');
    else if (inspection.fatal !== undefined) deps.err(`pipeline department status: ${inspection.fatal}\n`);
    else printHuman(deps.err, filePath, null, inspection.findings);
    return 2;
  }
  const manifest = inspection.manifest;
  const manifestDir = dirname(filePath);
  const cloudOpts = {
    ...(a.org !== undefined ? { org: a.org } : {}),
    ...(a.server !== undefined ? { server: a.server } : {}),
    ...(a.machineToken !== undefined ? { machineToken: a.machineToken } : {}),
    // Lives exactly as long as this invocation — see `MachineTokenCache`.
    machineTokenCache: {} as MachineTokenCache,
  };

  const iterations = a.follow ? maxIterations : 1;
  for (let i = 0; i < iterations; i++) {
    const snapshot = await gatherStatusSnapshot(deps, manifest, manifestDir, cloudOpts);
    const now = new Date(deps.now());
    if (a.json) deps.out(JSON.stringify(toStatusJson(snapshot, now), null, 2) + '\n');
    else renderStatusHuman(deps.out, snapshot, now);
    if (a.follow && i + 1 < iterations) await deps.sleep(STATUS_FOLLOW_INTERVAL_MS);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Dispatcher: `pipeline department <verb> [args]`
// ---------------------------------------------------------------------------

const VERBS = 'new, validate, serve, status, stop, retire, notify';

export async function runDepartment(args: string[]): Promise<number> {
  const verb = args[0];
  const rest = args.slice(1);
  switch (verb) {
    case 'new':
      return runDepartmentNew(rest);
    case 'validate':
      return runDepartmentValidate(rest);
    case 'serve':
      return await runDepartmentServe(rest);
    case 'status':
      return await runDepartmentStatus(rest);
    case 'stop':
      return runDepartmentStop(rest);
    case 'retire':
      return await runDepartmentRetire(rest);
    case 'notify':
      // a1/a11: the background department-task notifier (lib/department-notify.ts) —
      // poll/diff/journal + OS toast, normally spawned detached by
      // hooks/department_notifier_relay.ts. Not part of 05's nine-step serve
      // flow; listed here only because it is the `department` verb.
      return await runDepartmentNotify(rest);
    case undefined:
      process.stderr.write(`pipeline department: a verb is required (${VERBS})\n`);
      return 2;
    default:
      process.stderr.write(`pipeline department: unknown verb '${verb}' (expected: ${VERBS})\n`);
      return 2;
  }
}
