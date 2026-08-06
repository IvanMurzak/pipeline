/**
 * PostToolUse mirror-binding writer — hooks/analytics_relay.ts.
 *
 *   bun test tests/mirror-binding.test.ts
 *
 * The hook mirror-binds TWO transcripts so the UI shows both the
 * orchestration and the step work:
 *
 *   • the `pipeline-manager` spawn — the RUN ANCHOR (Phase 2). A Path-C
 *     manager spawn gets a `bypass-spawn` binding + a `terminal` record
 *     (the manager finished in the same hook tick, so the daemon must stop
 *     tailing after the initial drain). A Path-B manager spawn gets a
 *     `chain-controller` binding under the supervisor's run_id.
 *   • the WORKER spawn (`step-executor` / legacy `pipeline-executor`) — gets
 *     a `chain-controller` binding under the owning run, but NEVER
 *     synthesizes a run and NEVER writes a terminal record.
 *
 * These tests cover the binding-write side only — the daemon-side tail
 * lived in the deleted dashboard's tests/mirror-tail.test.ts (removed with the
 * daemon in plugin-thin `p3`; nothing tails transcripts in-process any more).
 *
 * The HOME dir is overridden per-test via the HOME env var so the
 * binding file lives under a tmpdir, not the real ~/.claude/.
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
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  handlePostToolUse,
  MIRROR_BINDING_SCHEMA,
} from "../../../hooks/analytics_relay.ts";

let tmpRoot: string;
let homeDir: string;
let projectRoot: string;
let runtimeDir: string;
let eventsPath: string;
let bindingsPath: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "pipeline-mirror-binding-"));
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
  runtimeDir = join(projectRoot, ".pipeline", ".runtime");
  mkdirSync(runtimeDir, { recursive: true });
  eventsPath = join(runtimeDir, "events.jsonl");
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
});

interface Binding {
  event: string;
  tool_use_id: string | null;
  run_id: string;
  session_id: string | null;
  transcript_path: string | null;
  project_root: string;
  worktree: string | null;
  pipeline_name: string;
  iteration_path: string;
  start_ts: string;
  kind: string;
  schema: number;
}

function readBindings(): Binding[] {
  if (!existsSync(bindingsPath)) return [];
  return readFileSync(bindingsPath, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Binding);
}

function iterationPath(pipelineName: string, file = "03-do-the-thing.md"): string {
  return join(projectRoot, ".pipeline", pipelineName, "steps", file);
}

interface PayloadOpts {
  /** Defaults to "pipeline-manager" (the run anchor). */
  subagentType?: string;
  /** Either a manager prompt (`current_iteration = …`) or a worker prompt
   *  (`Execute pipeline iteration: …`). */
  prompt: string;
  isError?: boolean;
  errorMessage?: string;
  transcriptPath?: string | null;
  sessionId?: string | null;
  toolUseId?: string;
}

function makeTaskPayload(opts: PayloadOpts): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    hook_event_name: "PostToolUse",
    tool_name: "Task",
    tool_input: {
      subagent_type: opts.subagentType ?? "pipeline-manager",
      prompt: opts.prompt,
    },
    tool_response: opts.isError
      ? { is_error: true, ...(opts.errorMessage ? { error: opts.errorMessage } : {}) }
      : { content: "agent finished" },
    tool_use_id: opts.toolUseId ?? "toolu_test_001",
  };
  if (opts.transcriptPath !== undefined) payload.transcript_path = opts.transcriptPath;
  if (opts.sessionId !== undefined) payload.session_id = opts.sessionId;
  return payload;
}

/** A pipeline-manager (run-anchor) prompt. */
function managerPrompt(iter: string): string {
  return `Orchestrate this pipeline run.\ncurrent_iteration = ${iter}\n`;
}

/** A worker (step-executor) prompt. */
function workerPrompt(iter: string): string {
  return `Execute pipeline iteration: ${iter}`;
}

/** Seed events.jsonl so findChainControllerRunId resolves `runId` for `iter`. */
function seedOwningRun(iter: string, runId: string): void {
  writeFileSync(
    eventsPath,
    JSON.stringify({
      schema: 3,
      ts: new Date().toISOString(),
      type: "iteration.started",
      project_root: projectRoot,
      worktree: null,
      run_id: runId,
      parent_run_id: null,
      session_id: null,
      data: { iteration_path: iter, index: 1, resolved_model: null },
    }) + "\n",
    "utf-8",
  );
}

describe("appendMirrorBinding writer (PostToolUse path) — manager anchor", () => {
  test("Path-C manager success → binding kind 'bypass-spawn' + bound run_id + terminal record", () => {
    const iter = iterationPath("demo");
    handlePostToolUse(
      makeTaskPayload({
        prompt: managerPrompt(iter),
        transcriptPath: "C:/Users/test/.claude/projects/encoded/session-1.jsonl",
        sessionId: "session-1",
        toolUseId: "toolu_bypass_ok",
      }),
      projectRoot,
      null,
    );
    const bindings = readBindings();
    // Path C synthesizes pipeline.completed in the same hook tick — to
    // avoid a race where the daemon's journal poll observes the
    // completion event before the bindings poll registers the binding
    // (then tails forever as non-terminal), the hook ALSO writes a
    // terminal record so the daemon stops after the initial drain.
    expect(bindings).toHaveLength(2);
    const b = bindings[0];
    expect(b.event).toBe("bound");
    expect(bindings[1].event).toBe("terminal");
    expect(bindings[1].run_id).toBe(b.run_id);
    expect(b.kind).toBe("bypass-spawn");
    expect(b.tool_use_id).toBe("toolu_bypass_ok");
    expect(b.session_id).toBe("session-1");
    expect(b.transcript_path).toBe("C:/Users/test/.claude/projects/encoded/session-1.jsonl");
    expect(b.project_root).toBe(projectRoot);
    expect(b.worktree).toBeNull();
    expect(b.pipeline_name).toBe("demo");
    expect(b.iteration_path).toBe(iter);
    expect(typeof b.run_id).toBe("string");
    // ux-v2 b2: canonical UUIDv5 (hookIdFromToolUseId), not a 12-hex sha1
    // slice — 36 chars, version nibble 5.
    expect(b.run_id.length).toBe(36);
    expect(Number.parseInt(b.run_id.slice(14, 16), 16) >>> 4).toBe(0b0101);
    expect(Number.parseInt(b.run_id.slice(19, 21), 16) >>> 6).toBe(0b10);
    expect(b.schema).toBe(MIRROR_BINDING_SCHEMA);
    expect(Number.isFinite(Date.parse(b.start_ts))).toBe(true);
  });

  test("Path-C manager failure → binding kind 'bypass-spawn-failed' + terminal record", () => {
    const iter = iterationPath("demo");
    handlePostToolUse(
      makeTaskPayload({
        prompt: managerPrompt(iter),
        isError: true,
        errorMessage: "manager blew up",
        transcriptPath: "/tmp/session-2.jsonl",
        sessionId: "session-2",
      }),
      projectRoot,
      null,
    );
    const bindings = readBindings();
    expect(bindings).toHaveLength(2);
    expect(bindings[0].kind).toBe("bypass-spawn-failed");
    expect(bindings[1].event).toBe("terminal");
  });

  test("Path-B manager (controller owns) → binding kind 'chain-controller' with existing run_id; no synthesis", () => {
    const iter = iterationPath("demo");
    const existingRunId = "abcdef012345";
    writeFileSync(
      eventsPath,
      JSON.stringify({
        schema: 3,
        ts: new Date().toISOString(),
        type: "pipeline.started",
        project_root: projectRoot,
        worktree: null,
        run_id: existingRunId,
        parent_run_id: null,
        session_id: null,
        data: {
          pipeline_name: "demo",
          first_iteration_path: iter,
          pipeline_root: join(projectRoot, ".pipeline", "demo"),
          default_model: null,
        },
      }) + "\n",
      "utf-8",
    );
    handlePostToolUse(
      makeTaskPayload({
        prompt: managerPrompt(iter),
        transcriptPath: "/tmp/session-3.jsonl",
        sessionId: "session-3",
      }),
      projectRoot,
      null,
    );

    const bindings = readBindings();
    // chain-controller path does NOT write a terminal record.
    expect(bindings).toHaveLength(1);
    expect(bindings[0].kind).toBe("chain-controller");
    expect(bindings[0].run_id).toBe(existingRunId);
    expect(bindings[0].iteration_path).toBe(iter);

    const events = readFileSync(eventsPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    expect(events).toHaveLength(2);
    expect(JSON.parse(events[1]).type).toBe("tool.called");
  });

  test("non-pipeline subagent → no binding written", () => {
    const iter = iterationPath("demo");
    handlePostToolUse(
      makeTaskPayload({
        subagentType: "general-purpose",
        prompt: managerPrompt(iter),
      }),
      projectRoot,
      null,
    );
    expect(existsSync(bindingsPath)).toBe(false);
  });

  test("missing transcript_path / session_id in payload → binding still written with nulls", () => {
    const iter = iterationPath("demo");
    handlePostToolUse(
      makeTaskPayload({ prompt: managerPrompt(iter) }),
      projectRoot,
      null,
    );
    const bindings = readBindings();
    // bound + terminal for bypass (manager) spawns.
    expect(bindings).toHaveLength(2);
    expect(bindings[0].transcript_path).toBeNull();
    expect(bindings[0].session_id).toBeNull();
    expect(bindings[0].tool_use_id).toBe("toolu_test_001");
  });

  test("worktree path is propagated to the binding", () => {
    const iter = iterationPath("demo");
    const worktree = join(projectRoot, "..", "worktrees", "feat-x");
    handlePostToolUse(
      makeTaskPayload({ prompt: managerPrompt(iter) }),
      projectRoot,
      worktree,
    );
    const bindings = readBindings();
    expect(bindings).toHaveLength(2);
    expect(bindings[0].worktree).toBe(worktree);
  });

  test("plugin-namespaced manager subagent_type still emits a binding", () => {
    const iter = iterationPath("demo");
    handlePostToolUse(
      makeTaskPayload({
        subagentType: "pipeline:pipeline-manager",
        prompt: managerPrompt(iter),
      }),
      projectRoot,
      null,
    );
    const bindings = readBindings();
    expect(bindings).toHaveLength(2);
    expect(bindings[0].kind).toBe("bypass-spawn");
    expect(bindings[1].event).toBe("terminal");
  });

  test("two consecutive Path-C manager spawns produce two distinct bindings (each with its terminal record)", () => {
    const iterA = iterationPath("demo", "01-a.md");
    const iterB = iterationPath("demo", "02-b.md");
    handlePostToolUse(
      makeTaskPayload({ prompt: managerPrompt(iterA), toolUseId: "toolu_a" }),
      projectRoot,
      null,
    );
    handlePostToolUse(
      makeTaskPayload({ prompt: managerPrompt(iterB), toolUseId: "toolu_b" }),
      projectRoot,
      null,
    );
    const bindings = readBindings();
    // 2 spawns × (bound + terminal) = 4 records.
    expect(bindings).toHaveLength(4);
    const bounds = bindings.filter((b) => b.event === "bound");
    expect(bounds).toHaveLength(2);
    expect(bounds[0].iteration_path).toBe(iterA);
    expect(bounds[1].iteration_path).toBe(iterB);
    expect(bounds[0].run_id).not.toBe(bounds[1].run_id);
  });
});

describe("appendMirrorBinding writer (PostToolUse path) — worker (step-executor)", () => {
  test("worker with an owning run → chain-controller binding, NO terminal record, NO synthesis", () => {
    const iter = iterationPath("demo");
    const ownedRun = "ownedworker1";
    seedOwningRun(iter, ownedRun);
    handlePostToolUse(
      makeTaskPayload({
        subagentType: "step-executor",
        prompt: workerPrompt(iter),
        transcriptPath: "/tmp/worker.jsonl",
        sessionId: "session-w",
      }),
      projectRoot,
      null,
    );
    const bindings = readBindings();
    // A worker is never a run anchor: exactly one bound record, no terminal.
    expect(bindings).toHaveLength(1);
    expect(bindings[0].event).toBe("bound");
    expect(bindings[0].kind).toBe("chain-controller");
    expect(bindings[0].run_id).toBe(ownedRun);
    expect(bindings[0].iteration_path).toBe(iter);
    expect(bindings[0].transcript_path).toBe("/tmp/worker.jsonl");
    // No synthesized lifecycle — just the seeded iteration.started + tool.called.
    const types = readFileSync(eventsPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l).type);
    expect(types).toEqual(["iteration.started", "tool.called"]);
  });

  test("legacy worker name (pipeline-executor) with an owning run → chain-controller binding", () => {
    const iter = iterationPath("demo");
    const ownedRun = "ownedlegacy1";
    seedOwningRun(iter, ownedRun);
    handlePostToolUse(
      makeTaskPayload({
        subagentType: "pipeline-executor",
        prompt: workerPrompt(iter),
      }),
      projectRoot,
      null,
    );
    const bindings = readBindings();
    expect(bindings).toHaveLength(1);
    expect(bindings[0].kind).toBe("chain-controller");
    expect(bindings[0].run_id).toBe(ownedRun);
  });

  test("worker with NO resolvable run → no binding (but tool.called still lands)", () => {
    const iter = iterationPath("demo");
    handlePostToolUse(
      makeTaskPayload({
        subagentType: "step-executor",
        prompt: workerPrompt(iter),
        sessionId: "session-orphan",
      }),
      projectRoot,
      null,
    );
    expect(existsSync(bindingsPath)).toBe(false);
    // tool.called is still journaled (with run_id=null).
    const types = readFileSync(eventsPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l).type);
    expect(types).toEqual(["tool.called"]);
  });
});
