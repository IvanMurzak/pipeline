/**
 * Run-id SHAPE consumers in the analytics relay — ux-v2 b3, matrix 18.
 *
 *   bun test tests/hook-runid-shape-ownership.test.ts
 *
 * `extractRunIdFromPrompt` (hooks/analytics_relay.ts) reads the literal
 * `run_id = <id>` line that `/pipeline:run` writes into the `pipeline-manager`
 * spawn prompt (skills/run/SKILL.md, agents/pipeline-manager.md). It is the
 * STRONG Path-B ownership signal — the one that survives a resume, where the
 * journal scan by iteration_path can miss because the supervisor's single
 * `pipeline.started` carries the FIRST iteration path, not the resume one.
 *
 * ux-v2 b2 made every minted run id a 36-char UUIDv7. The old shape check
 * (`[0-9a-f]{12}`) cannot match one — a UUID has a hyphen after 8 hex chars —
 * so ownership silently degrades to `findChainControllerRunId`.
 *
 * WHY A HAPPY-PATH TEST PROVES NOTHING HERE. `findChainControllerRunId` does
 * NOT match on run-id shape: it matches `iteration_path` against the journal.
 * It keeps working under UUIDv7, so a *typical fresh* `/pipeline:run` is still
 * classified `chain-controller` even with the shape bug present. The phantom
 * only appears where the fallback ALSO misses:
 *
 *   1. the matching journal event is older than `BYPASS_DEDUP_WINDOW_MS`
 *      (10 min) — a long step, a slow manager, a resumed chain;
 *   2. it has been pushed beyond the 500-line tail cap by a busy journal;
 *   3. it is absent entirely.
 *
 * In that population the relay mints a DIFFERENT run id, classifies the spawn
 * `bypass-spawn`, and `synthesizeBypassStart` emits a spurious
 * `pipeline.started` — a PHANTOM SECOND RUN on the dashboard (breaks D9, and
 * the hard run-count budget in `08` J2).
 *
 * Every scenario below therefore ships with a CONTROL arm that removes only
 * the `run_id = …` line: the control asserts the trap is genuinely armed (a
 * phantom really does appear from that fixture), so the passing arm cannot
 * quietly degrade into a happy path if `BYPASS_DEDUP_WINDOW_MS` or the tail
 * cap is ever retuned.
 *
 * Phantom emissions are COUNTED directly (`countEvents("pipeline.started")`),
 * never inferred from the binding kind.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  bypassRunIdFromToolUseId,
  extractRunIdFromPrompt,
  handlePostToolUse,
  handlePreToolUse,
} from "../../../hooks/analytics_relay.ts";
import { hookIdFromToolUseId, newId } from "../src/lib/ids.ts";

let tmpRoot: string;
let homeDir: string;
let projectRoot: string;
let eventsPath: string;
let bindingsPath: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "pipeline-runid-shape-"));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpRoot, "home-"));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  projectRoot = mkdtempSync(join(tmpRoot, "proj-"));
  mkdirSync(join(projectRoot, ".pipeline", ".runtime"), { recursive: true });
  eventsPath = join(projectRoot, ".pipeline", ".runtime", "events.jsonl");
  bindingsPath = join(homeDir, ".claude", "pipeline-ui", "active-mirror-bindings.jsonl");
  delete process.env.PIPELINE_UI_RUN_ID;
  delete process.env.PIPELINE_UI_PARENT_RUN_ID;
  delete process.env.CLAUDE_SESSION_ID;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  delete process.env.PIPELINE_UI_RUN_ID;
  delete process.env.PIPELINE_UI_PARENT_RUN_ID;
  delete process.env.CLAUDE_SESSION_ID;
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface JournalEvent {
  type: string;
  run_id: string | null;
  data: Record<string, unknown>;
}

interface Binding {
  event: string;
  run_id: string;
  kind: string;
  iteration_path: string;
}

function readEvents(): JournalEvent[] {
  if (!existsSync(eventsPath)) return [];
  return readFileSync(eventsPath, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as JournalEvent);
}

/** COUNT the emissions — the DoD asks for a direct count of spurious
 *  `pipeline.started`, not an inference from the binding kind. */
function countEvents(type: string): number {
  return readEvents().filter((e) => e.type === type).length;
}

function readBindings(): Binding[] {
  if (!existsSync(bindingsPath)) return [];
  return readFileSync(bindingsPath, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Binding);
}

function iterationPath(pipelineName = "demo", file = "07-long-step.md"): string {
  return join(projectRoot, ".pipeline", pipelineName, "steps", file);
}

function journalLine(ev: Record<string, unknown>): string {
  return (
    JSON.stringify({
      schema: 3,
      project_root: projectRoot,
      worktree: null,
      parent_run_id: null,
      session_id: null,
      ...ev,
    }) + "\n"
  );
}

/** The manager's `iteration.started` for this step — the event
 *  `findChainControllerRunId` looks for. `ageMs` ages it out of the window. */
function iterationStartedLine(iter: string, runId: string, ageMs: number): string {
  return journalLine({
    ts: new Date(Date.now() - ageMs).toISOString(),
    type: "iteration.started",
    run_id: runId,
    data: { iteration_path: iter, index: 7, resolved_model: null },
  });
}

/** Fresh, well-formed, NON-matching journal traffic — what a busy project
 *  writes between the manager's `iteration.started` and the spawn. */
function fillerLines(n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) {
    out += journalLine({
      ts: new Date(Date.now() - 1_000).toISOString(),
      type: "tool.called",
      run_id: "unrelated-run",
      data: { tool_name: "Read", success: true, agent_spawn: false, seq: i },
    });
  }
  return out;
}

/** A `/pipeline:run` → `pipeline-manager` spawn. `runIdLine` present = the
 *  real Path-B prompt shape (SKILL.md's `run_id = <literal run id>`);
 *  omitted = the CONTROL arm, which must produce a phantom. */
function managerPayload(opts: {
  hook: "PreToolUse" | "PostToolUse";
  iter: string;
  runIdLine?: string;
  toolUseId: string;
}): Record<string, unknown> {
  const runLine = opts.runIdLine ? `\nrun_id = ${opts.runIdLine}\n` : "";
  return {
    hook_event_name: opts.hook,
    tool_name: "Task",
    tool_input: {
      subagent_type: "pipeline-manager",
      prompt:
        `Orchestrate this pipeline run. Drive the chain to completion via fresh` +
        ` step-executors.${runLine}\ncurrent_iteration = ${opts.iter}\n`,
    },
    tool_use_id: opts.toolUseId,
    session_id: "session-b3",
    transcript_path: "/tmp/manager.jsonl",
    ...(opts.hook === "PostToolUse" ? { tool_response: { content: "manager finished" } } : {}),
  };
}

const ELEVEN_MINUTES = 11 * 60 * 1_000;

// ---------------------------------------------------------------------------
// The shape check itself
// ---------------------------------------------------------------------------

describe("extractRunIdFromPrompt — accepts every id shape a mint site produces", () => {
  test("a UUIDv7 from newId() — what EVERY run id is since ux-v2 b2", () => {
    const id = newId();
    expect(id).toHaveLength(36);
    expect(extractRunIdFromPrompt({ prompt: `run_id = ${id}\npipeline_name = demo\n` })).toBe(id);
  });

  test("a UUIDv5 from hookIdFromToolUseId() — the relay's own derived ids", () => {
    const id = hookIdFromToolUseId("toolu_abc123");
    expect(extractRunIdFromPrompt({ prompt: `run_id = ${id}\n` })).toBe(id);
  });

  test("the pre-b2 12-hex id still extracts (runs in flight across the migration)", () => {
    expect(extractRunIdFromPrompt({ prompt: "run_id = abcdef012345\n" })).toBe("abcdef012345");
  });

  test("the `run_id: <uuid>` colon spelling and UPPERCASE hex both extract", () => {
    const id = newId();
    expect(extractRunIdFromPrompt({ prompt: `run_id: ${id}` })).toBe(id);
    const upper = id.toUpperCase();
    expect(extractRunIdFromPrompt({ prompt: `run_id = ${upper}` })).toBe(upper);
  });

  test("description / message carry the line too, and a UUID is read whole", () => {
    const id = newId();
    expect(extractRunIdFromPrompt({ description: `run_id = ${id}` })).toBe(id);
    expect(extractRunIdFromPrompt({ message: `run_id = ${id}` })).toBe(id);
    // Never a 12-char prefix of the UUID: a truncated id would bind the
    // manager's transcript to a run that does not exist.
    expect(extractRunIdFromPrompt({ prompt: `run_id = ${id}` })).not.toBe(id.slice(0, 12));
  });

  test("`parent_run_id` / `child_run_id` are NOT mistaken for `run_id`, in either order", () => {
    // A blocker-delegation child spawn carries BOTH lines (skills/run/SKILL.md
    // §4: "its own run_id=<child_run_id> and parent_run_id=<id>"), and since b2
    // both are UUIDs — so the prompt now holds two ids of identical shape and
    // only the `\b` prefix guard separates them. Picking the wrong one would
    // bind the child's manager transcript to the PARENT's run.
    const child = "019fd0b9-6313-701d-8b44-9861d85e1be7";
    const parent = "019fd0a0-0000-7000-8000-000000000001";
    expect(extractRunIdFromPrompt({ prompt: `parent_run_id = ${parent}\nrun_id = ${child}\n` })).toBe(child);
    expect(extractRunIdFromPrompt({ prompt: `run_id = ${child}\nparent_run_id = ${parent}\n` })).toBe(child);
    expect(extractRunIdFromPrompt({ prompt: `child_run_id = ${child}\n` })).toBeNull();
    expect(extractRunIdFromPrompt({ prompt: `parent_run_id = ${parent}\n` })).toBeNull();
  });

  test("the un-substituted SKILL.md placeholder and a shapeless id return null", () => {
    expect(extractRunIdFromPrompt({ prompt: "run_id = <literal run id>" })).toBeNull();
    expect(extractRunIdFromPrompt({ prompt: "run_id = not-an-id" })).toBeNull();
    expect(extractRunIdFromPrompt({ prompt: "no run id here at all" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Matrix 18 — the population that actually breaks
// ---------------------------------------------------------------------------

describe("Path-B under UUIDv7 where findChainControllerRunId ALSO misses (matrix 18)", () => {
  test("CONTROL — stale journal, no run_id line: the trap is armed (phantom appears)", () => {
    const iter = iterationPath();
    const supervisorRun = newId();
    writeFileSync(eventsPath, iterationStartedLine(iter, supervisorRun, ELEVEN_MINUTES), "utf-8");

    handlePreToolUse(
      managerPayload({ hook: "PreToolUse", iter, toolUseId: "toolu_ctrl_stale" }),
      projectRoot,
      null,
    );

    // Without the prompt signal the journal scan is the ONLY hope, and it
    // misses: a phantom run is minted and announced.
    expect(countEvents("pipeline.started")).toBe(1);
    const b = readBindings();
    expect(b).toHaveLength(1);
    expect(b[0].kind).toBe("bypass-spawn");
    expect(b[0].run_id).toBe(bypassRunIdFromToolUseId("toolu_ctrl_stale"));
    expect(b[0].run_id).not.toBe(supervisorRun);
  });

  test("stale journal (iteration.started 11 min old): chain-controller, ZERO pipeline.started", () => {
    const iter = iterationPath();
    const supervisorRun = newId();
    writeFileSync(eventsPath, iterationStartedLine(iter, supervisorRun, ELEVEN_MINUTES), "utf-8");

    handlePreToolUse(
      managerPayload({ hook: "PreToolUse", iter, runIdLine: supervisorRun, toolUseId: "toolu_stale" }),
      projectRoot,
      null,
    );

    expect(countEvents("pipeline.started")).toBe(0);
    const b = readBindings();
    expect(b).toHaveLength(1);
    expect(b[0].kind).toBe("chain-controller");
    expect(b[0].run_id).toBe(supervisorRun);
    expect(b[0].iteration_path).toBe(iter);
  });

  test("CONTROL — tail-capped journal, no run_id line: the trap is armed (phantom appears)", () => {
    const iter = iterationPath();
    const supervisorRun = newId();
    // Fresh match, but 600 later lines push it past the 500-line tail cap.
    writeFileSync(
      eventsPath,
      iterationStartedLine(iter, supervisorRun, 5_000) + fillerLines(600),
      "utf-8",
    );

    handlePreToolUse(
      managerPayload({ hook: "PreToolUse", iter, toolUseId: "toolu_ctrl_tail" }),
      projectRoot,
      null,
    );

    expect(countEvents("pipeline.started")).toBe(1);
    expect(readBindings()[0].kind).toBe("bypass-spawn");
  });

  test("tail-capped journal (600 lines of traffic): chain-controller, ZERO pipeline.started", () => {
    const iter = iterationPath();
    const supervisorRun = newId();
    writeFileSync(
      eventsPath,
      iterationStartedLine(iter, supervisorRun, 5_000) + fillerLines(600),
      "utf-8",
    );

    handlePreToolUse(
      managerPayload({ hook: "PreToolUse", iter, runIdLine: supervisorRun, toolUseId: "toolu_tail" }),
      projectRoot,
      null,
    );

    expect(countEvents("pipeline.started")).toBe(0);
    const b = readBindings();
    expect(b).toHaveLength(1);
    expect(b[0].kind).toBe("chain-controller");
    expect(b[0].run_id).toBe(supervisorRun);
  });

  test("journal absent entirely (resumed chain, fresh runtime dir): ZERO pipeline.started", () => {
    const iter = iterationPath();
    const supervisorRun = newId();
    expect(existsSync(eventsPath)).toBe(false);

    handlePreToolUse(
      managerPayload({ hook: "PreToolUse", iter, runIdLine: supervisorRun, toolUseId: "toolu_absent" }),
      projectRoot,
      null,
    );

    expect(countEvents("pipeline.started")).toBe(0);
    const b = readBindings();
    expect(b).toHaveLength(1);
    expect(b[0].kind).toBe("chain-controller");
    expect(b[0].run_id).toBe(supervisorRun);
  });

  test("PostToolUse, stale journal: no synthesis, tool.called lands on the SUPERVISOR's run", () => {
    const iter = iterationPath();
    const supervisorRun = newId();
    writeFileSync(eventsPath, iterationStartedLine(iter, supervisorRun, ELEVEN_MINUTES), "utf-8");

    handlePostToolUse(
      managerPayload({
        hook: "PostToolUse",
        iter,
        runIdLine: supervisorRun,
        toolUseId: "toolu_post_stale",
      }),
      projectRoot,
      null,
    );

    expect(countEvents("pipeline.started")).toBe(0);
    expect(countEvents("pipeline.completed")).toBe(0);
    expect(countEvents("pipeline.halted")).toBe(0);
    const toolCalled = readEvents().filter((e) => e.type === "tool.called");
    expect(toolCalled).toHaveLength(1);
    expect(toolCalled[0].run_id).toBe(supervisorRun);
    expect(readBindings().every((b) => b.kind === "chain-controller")).toBe(true);
  });

  test("full Pre→Post spawn under a tail-capped journal emits NO lifecycle at all", () => {
    const iter = iterationPath();
    const supervisorRun = newId();
    const toolUseId = "toolu_full_flow";
    writeFileSync(
      eventsPath,
      iterationStartedLine(iter, supervisorRun, 5_000) + fillerLines(600),
      "utf-8",
    );

    handlePreToolUse(
      managerPayload({ hook: "PreToolUse", iter, runIdLine: supervisorRun, toolUseId }),
      projectRoot,
      null,
    );
    handlePostToolUse(
      managerPayload({ hook: "PostToolUse", iter, runIdLine: supervisorRun, toolUseId }),
      projectRoot,
      null,
    );

    // The supervisor owns the whole lifecycle. The relay contributes exactly
    // one tool.called and nothing else — no phantom run, no phantom terminal.
    expect(countEvents("pipeline.started")).toBe(0);
    expect(countEvents("pipeline.completed")).toBe(0);
    expect(countEvents("pipeline.halted")).toBe(0);
    // Only the spawn's own tool.called — the fillers are agent_spawn=false.
    const spawnCalls = readEvents().filter((e) => e.type === "tool.called" && e.data.agent_spawn === true);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].run_id).toBe(supervisorRun);
    expect(readBindings().map((b) => b.kind)).toEqual(["chain-controller", "chain-controller"]);
  });

  // Kept as a floor, and labelled honestly: this one passes with the shape bug
  // present, because findChainControllerRunId carries it. It is NOT evidence.
  test("(floor, not evidence) a FRESH chain still classifies chain-controller", () => {
    const iter = iterationPath();
    const supervisorRun = newId();
    writeFileSync(eventsPath, iterationStartedLine(iter, supervisorRun, 5_000), "utf-8");
    handlePreToolUse(
      managerPayload({ hook: "PreToolUse", iter, runIdLine: supervisorRun, toolUseId: "toolu_fresh" }),
      projectRoot,
      null,
    );
    expect(countEvents("pipeline.started")).toBe(0);
    expect(readBindings()[0].kind).toBe("chain-controller");
  });
});
