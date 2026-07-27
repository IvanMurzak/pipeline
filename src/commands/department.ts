// `pipeline department new` and `pipeline department validate`
// (simplified-onboarding design, task a8; refs 02 §4, 05 §3/§4, 06).
//
// A department is a project folder whose only REQUIRED file is
// `department.yml` (D3/D8). This module is the two commands that make that
// promise real:
//
//   `new`      — scaffold department.yml (and NOTHING else — D3 is a hard
//                requirement, not a default) in the current folder, or in a
//                new `<name>/` subfolder.
//   `validate` — run every check class 05 §4 names against a hand-written or
//                hand-edited file, so authoring one by hand is a reasonable
//                thing to ask of a user.
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
import { basename, dirname, join, relative, resolve } from 'node:path';
import {
  DEPARTMENT_API_VERSION_V1,
  DEPARTMENT_MANIFEST_FILENAME,
  bunYamlParser,
  engineDefinition,
  hasErrors,
  parseDepartmentManifest,
  readDepartmentManifest,
  SUPPORTED_ENGINES,
  type DepartmentManifest,
  type ManifestFinding,
} from '../lib/department-manifest';
import { findFirstIteration, findManifests, parseManifest as parsePipelineManifest } from '../lib/match';

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
    'Options:\n' +
    `  --file <path>  File to validate (default: ./${DEPARTMENT_MANIFEST_FILENAME}).\n` +
    '  --json         Print {file, valid, errors, warnings, findings}.\n' +
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
  if (m.scheduling.contextAffinity === 'required' && m.runtime.lifecycle === 'per-task') {
    out.push({
      severity: 'error',
      field: 'scheduling.contextAffinity',
      message: "'required' needs runtime.lifecycle 'per-context' or 'daemon' — 'per-task' cannot hold context across tasks",
    });
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
    if (!m.runtime.pipelineRoot) {
      out.push({
        severity: 'error',
        field: 'runtime.pipelineRoot',
        message: 'is required for engine: pipeline — the department has no pipeline to run',
      });
    } else {
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
  return out;
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
    const engineOk = engineDefinition(manifest.runtime.engine) !== undefined;
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
    const result = buildJsonResult(filePath, [{ severity: 'error', field: '$', message }]);
    if (a.json) out(JSON.stringify(result, null, 2) + '\n');
    else err(`pipeline department validate: ${message}\n`);
    return 2;
  }

  if (manifest === null) {
    // Unparseable (05 §4's exit-2 class, same as a missing file — a
    // best-effort manifest could not even be built).
    if (a.json) out(JSON.stringify(buildJsonResult(filePath, findings), null, 2) + '\n');
    else printHuman(out, filePath, null, findings);
    return 2;
  }

  findings.push(...coherenceFindings(manifest));
  findings.push(...localFindings(manifest, dirname(filePath)));
  findings.push(...skillAdvisoryFindings(manifest));
  findings.push(...claudeDirFindings(inspectClaudeDir(dirname(filePath))));
  findings.push(...visibilityAdvisory(text));

  if (a.json) {
    out(JSON.stringify(buildJsonResult(filePath, findings), null, 2) + '\n');
  } else {
    printHuman(out, filePath, manifest, findings);
  }
  return hasErrors(findings) ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Dispatcher: `pipeline department <verb> [args]`
// ---------------------------------------------------------------------------

export function runDepartment(args: string[]): number {
  const verb = args[0];
  const rest = args.slice(1);
  switch (verb) {
    case 'new':
      return runDepartmentNew(rest);
    case 'validate':
      return runDepartmentValidate(rest);
    case undefined:
      process.stderr.write('pipeline department: a verb is required (new, validate)\n');
      return 2;
    default:
      process.stderr.write(`pipeline department: unknown verb '${verb}' (expected: new, validate)\n`);
      return 2;
  }
}
