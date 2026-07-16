// Library entry point — import these instead of shelling out to the CLI when
// embedding the planner in another local project.

export { computePlan, normalizeModel } from './lib/plan';
export type {
  Plan,
  PlanStep,
  PipelineMode,
  Isolation,
  ComputePlanOptions,
} from './lib/plan';
export { parseFrontmatter } from './lib/frontmatter';
export type { ParsedFrontmatter, FrontmatterValue } from './lib/frontmatter';

export {
  matchPipelines,
  tokenize,
  bm25Scores,
  matchedTerms,
  splitSections,
  parseScope,
  parseManifest,
  positiveCorpus,
  negativeCorpus,
  findFirstIteration,
  findManifests,
} from './lib/match';
export type {
  MatchResult,
  MatchOptions,
  Manifest,
  Candidate,
  Excluded,
} from './lib/match';

export {
  emitEvent,
  registerMirrorBinding,
  writeLiveness,
  clearLiveness,
  parseKvArgs,
  resolveProjectRoot,
  SCHEMA_VERSION,
  MIRROR_BINDING_SCHEMA,
} from './lib/event';
export type { ResolvedRoot, KvValue, ParsedKv } from './lib/event';

export {
  extractGraph,
  validateGraph,
  nodeEdges,
  routeNext,
  emptyRouteState,
  ROUTE_TRANSITION_CAP,
} from './lib/graph';
export type { Graph, GraphNode, GraphEdge, RouteState, RouteAction } from './lib/graph';

// Guarded submodule-pointer bump primitive (Phase-1 guarded CLI).
export { landToMain } from './lib/land';
export type { GitlinkChange, LandResult, LandOptions, LandStatus, ReconcileStatus } from './lib/land';
export {
  classifyDrift,
  classifyAll,
  resolveSubmodulePaths,
  buildBumpMessage,
  isBumpable,
} from './lib/drift';
export type { DriftEntry, DriftStatus, ClassifyOptions } from './lib/drift';
export { bump, runSubmodule, runSubmoduleBump } from './commands/submodule';
export type { BumpReport } from './commands/submodule';
export {
  realGit,
  realGh,
  stableEnv,
  gitAvailable,
  ghAvailable,
} from './lib/git';
export type { GitRunner, GhRunner, GitResult } from './lib/git';

// Frozen script-step contracts (roadmap/script-steps/DESIGN.md §14).
export {
  DEFAULT_SCRIPT_TIMEOUT_S,
  CALL_BUDGET_MS,
  SAFETY_MARGIN_MS,
  MANAGER_SAFE_TIMEOUT_S,
  MAX_SCRIPT_EXECS_PER_CALL,
  STDOUT_CAP_BYTES,
  OUTPUT_PERSIST_CAP_BYTES,
  SECRET_ENV_PATTERN,
} from './lib/script-types';
export type {
  StepType,
  FailureClass,
  OnFailurePolicy,
  ScriptParamSpec,
  ScriptStepSpec,
  ScriptResult,
  ScriptFailureRecord,
  LedgerEntry,
} from './lib/script-types';

// Approval gates (`type: gate` steps — T3-14, runner side): the role set, the
// needs_input question construction (approval marker included), and the
// fail-closed {decision, comment} answer parser.
export {
  APPROVAL_ROLES,
  buildGateQuestion,
  normalizeApprovalRole,
  parseGateDecision,
} from './lib/gate';
export type {
  ApprovalRole,
  GateStepSpec,
  GateQuestion,
  GateDecision,
  GateDecisionParse,
} from './lib/gate';

// Composition (`type: pipeline` steps) — format & plan half (T3-09):
// reference resolution + cross-pipeline reference-graph lint (cycles, depth).
export {
  lintComposition,
  resolvePipelineRef,
  realComposeFs,
  MAX_COMPOSITION_DEPTH,
} from './lib/compose';
export type {
  PipelineStepSpec,
  ComposeFs,
  CompositionEdge,
  CompositionOptions,
  ResolvedPipelineRef,
} from './lib/compose';

// Composition — execution half (T3-10): run-tree records, deterministic child
// run ids, child input delivery and child-output capture. The descend/pop
// orchestration itself lives in the `pipeline next` command (invokeNext).
export {
  COMPOSE_EXEC_GUARD,
  activeChildOf,
  childRunIdFor,
  childRunOutput,
  composedDepthOf,
  deliverChildInputs,
  readRunTree,
  registerChildRun,
  rootRunTree,
  runTreeFile,
  taskFileFor,
} from './lib/compose-exec';
export type { RunTreeRecord, RunTreeChildRef } from './lib/compose-exec';

// Script-step execution core (roadmap/script-steps/DESIGN.md §§3–8) —
// bindings, spawn, stdout parse, classification, failure records, ledger.
export {
  executeScriptStep,
  resolveParams,
  parseScriptStdout,
  parseNextSection,
  classifyFailure,
  realProcessRunner,
} from './lib/script-step';
export type {
  ProcessRunner,
  ProcessRunOptions,
  ProcessRunResult,
  BindingSources,
  ScriptStepContext,
  ScriptStepResult,
  ScriptStepRecord,
  ScriptFeedbackDraft,
  ResolveParamsResult,
  ParsedStdout,
  ClassifiedRun,
  NextParse,
} from './lib/script-step';

// Pure PP_* variable substitution engine (env-variables design 04) — grammar,
// `## Variables` parsing, resolution (CLI > env > manifest default), run-init
// validation, and single-pass inert substitution. No I/O; never reads
// process.env (env is an injected parameter).
export {
  PP_NAME_RE,
  PP_TOKEN_RE,
  PP_NEARMISS_RE,
  parseVariablesSection,
  scanOccurrences,
  scanNearMisses,
  scanFrontmatter,
  resolveVariables,
  parseVarAssignment,
  validateRun,
  substituteText,
  substituteArgv,
  hasDeclarations,
} from './lib/substitution';
export type {
  VariableDecl,
  ResolvedVars,
  Occurrence,
  SubstitutionIssue,
  SubstitutionIssueKind,
} from './lib/substitution';

export { computeNext } from './lib/next';
export type {
  NextState,
  NextAction,
  NextRecord,
  NextOpts,
  NextResult,
  NextPhase,
  RunMode,
  TerminalStatus,
  ActionStep,
  ActiveChildRun,
  MergeBranch,
  ImproveItem,
  StepRecord,
  LayerRecord,
  LayerResultEntry,
  MergeRecord,
  ImproverRecord,
  ScriptRecord,
  RetroRecord,
  GateAnswerRecord,
} from './lib/next';
