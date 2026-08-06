/**
 * PostToolUse bypass-path synthesis — hooks/analytics_relay.ts.
 *
 *   bun test tests/hook-bypass-detection.test.ts
 *
 * As of Phase 2 the RUN ANCHOR is the `pipeline-manager` spawn, not the
 * worker. Three invocation paths produce a pipeline run:
 *
 *   A. /api/chat (daemon-side, server.ts) — emits lifecycle events itself.
 *   B. /pipeline:run supervisor — emits the run-level lifecycle itself and
 *      spawns a pipeline-manager (which emits the per-iteration events).
 *   C. Direct spawn of a pipeline-manager from a terminal session —
 *      uninstrumented. The PostToolUse hook detects this case and
 *      synthesizes the missing RUN-LEVEL events (pipeline.started +
 *      pipeline.completed/halted). It NEVER synthesizes iteration.* — the
 *      manager self-emits those.
 *
 * These tests cover Path C only. The discriminator that prevents
 * double-emission for Paths A/B is JOURNAL-based (a recent pipeline.started
 * / iteration.started on the same iteration path with a DIFFERENT run_id),
 * plus the literal `run_id = …` the supervisor writes into the manager
 * prompt. A WORKER (step-executor / legacy pipeline-executor) spawn is NOT a
 * run anchor and never synthesizes a run.
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
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  handlePostToolUse,
  parseManagerSpawn,
  parseWorkerSpawn,
  SCHEMA_VERSION,
} from "../../../hooks/analytics_relay.ts";

let tmpRoot: string;
let projectRoot: string;
let runtimeDir: string;
let eventsPath: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "pipeline-bypass-"));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  // Fresh per-test project root so events.jsonl is isolated.
  projectRoot = mkdtempSync(join(tmpRoot, "proj-"));
  runtimeDir = join(projectRoot, ".pipeline", ".runtime");
  mkdirSync(runtimeDir, { recursive: true });
  eventsPath = join(runtimeDir, "events.jsonl");
  delete process.env.PIPELINE_UI_RUN_ID;
  delete process.env.PIPELINE_UI_PARENT_RUN_ID;
  delete process.env.CLAUDE_SESSION_ID;
});

afterEach(() => {
  delete process.env.PIPELINE_UI_RUN_ID;
  delete process.env.PIPELINE_UI_PARENT_RUN_ID;
  delete process.env.CLAUDE_SESSION_ID;
});

interface JournalEvent {
  schema: number;
  ts: string;
  type: string;
  project_root: string;
  worktree: string | null;
  run_id: string | null;
  parent_run_id: string | null;
  session_id: string | null;
  data: Record<string, unknown>;
}

function readEvents(): JournalEvent[] {
  const raw = readFileSync(eventsPath, "utf-8");
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as JournalEvent);
}

function iterationPath(pipelineName: string, file = "03-do-the-thing.md"): string {
  return join(projectRoot, ".pipeline", pipelineName, "steps", file);
}

/** A Path-C pipeline-manager spawn — the run anchor. The supervisor's
 *  prompt carries `current_iteration = <abs>`; a hand spawn omits the
 *  literal run_id so it is treated as Path C. */
function makeManagerPayload(opts: {
  subagentType?: string;
  iter: string;
  isError?: boolean;
  errorMessage?: string;
  withRunIdLine?: string;
}): Record<string, unknown> {
  const runLine = opts.withRunIdLine ? `\nrun_id = ${opts.withRunIdLine}\n` : "";
  return {
    hook_event_name: "PostToolUse",
    tool_name: "Task",
    tool_input: {
      subagent_type: opts.subagentType ?? "pipeline-manager",
      prompt: `Orchestrate this pipeline run.${runLine}\ncurrent_iteration = ${opts.iter}\n`,
    },
    tool_response: opts.isError
      ? { is_error: true, ...(opts.errorMessage ? { error: opts.errorMessage } : {}) }
      : { content: "manager finished" },
    tool_use_id: "toolu_test_001",
  };
}

/** A worker spawn (step-executor / legacy pipeline-executor). */
function makeWorkerPayload(opts: {
  subagentType: string;
  prompt: string;
  isError?: boolean;
}): Record<string, unknown> {
  return {
    hook_event_name: "PostToolUse",
    tool_name: "Task",
    tool_input: {
      subagent_type: opts.subagentType,
      prompt: opts.prompt,
    },
    tool_response: opts.isError ? { is_error: true } : { content: "executor finished" },
    tool_use_id: "toolu_worker_001",
  };
}

describe("parseManagerSpawn / parseWorkerSpawn (pure parsers)", () => {
  test("manager spawn with current_iteration parses cleanly", () => {
    const iter = iterationPath("demo");
    const parsed = parseManagerSpawn({
      subagent_type: "pipeline-manager",
      prompt: `Orchestrate this pipeline run.\ncurrent_iteration = ${iter}\n`,
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.iterationPath).toBe(iter);
    expect(parsed!.pipelineName).toBe("demo");
    expect(parsed!.iterationIndex).toBe(3);
    expect(parsed!.resolvedModel).toBeNull();
  });

  test("plugin-namespaced manager (pipeline:pipeline-manager) parses", () => {
    const iter = iterationPath("demo");
    const parsed = parseManagerSpawn({
      subagent_type: "pipeline:pipeline-manager",
      prompt: `current_iteration = ${iter}`,
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.iterationPath).toBe(iter);
  });

  test("worker spawn parses with new name (step-executor)", () => {
    const iter = iterationPath("demo");
    const parsed = parseWorkerSpawn({
      subagent_type: "step-executor",
      prompt: `Execute pipeline iteration: \`${iter}\``,
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.iterationPath).toBe(iter);
    expect(parsed!.pipelineName).toBe("demo");
  });

  test("worker spawn parses legacy name + tier suffix (pipeline-executor-*)", () => {
    const iter = iterationPath("demo", "01-warmup.md");
    for (const tier of ["haiku", "sonnet", "opus"] as const) {
      const parsed = parseWorkerSpawn({
        subagent_type: `pipeline-executor-${tier}`,
        prompt: `Execute pipeline iteration: ${iter}`,
      });
      expect(parsed).not.toBeNull();
      expect(parsed!.resolvedModel).toBe(tier);
    }
    // Bare legacy name still parses.
    const bare = parseWorkerSpawn({
      subagent_type: "pipeline-executor",
      prompt: `Execute pipeline iteration: ${iter}`,
    });
    expect(bare).not.toBeNull();
    expect(bare!.resolvedModel).toBeNull();
  });

  test("plugin-namespaced worker (both new + legacy names) parses", () => {
    const iter = iterationPath("demo");
    for (const subagentType of [
      "pipeline:step-executor",
      "pipeline:pipeline-executor",
      "pipeline:pipeline-executor-haiku",
      "myorg-pipeline:step-executor",
    ]) {
      const parsed = parseWorkerSpawn({
        subagent_type: subagentType,
        prompt: `Execute pipeline iteration: ${iter}`,
      });
      expect(parsed).not.toBeNull();
      expect(parsed!.iterationPath).toBe(iter);
    }
  });

  test("a rendered shadow-copy spawn path normalizes back to the SOURCE path (env-variables P4)", () => {
    // On a PP_*-variable-declaring run the manager spawns the executor with
    // the CLI-rendered copy under `<pipeline_root>/.runtime/<run>/rendered/
    // <slug>/steps/…` while journal events carry the SOURCE path — the parser
    // must key everything (ownership match, root, name) on the source.
    const source = iterationPath("demo");
    const rendered = join(
      projectRoot,
      ".pipeline",
      "demo",
      ".runtime",
      "run-42",
      "rendered",
      "demo",
      "steps",
      "03-do-the-thing.md",
    );
    const parsed = parseWorkerSpawn({
      subagent_type: "step-executor",
      prompt: `Execute pipeline iteration: ${rendered}`,
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.iterationPath).toBe(source);
    expect(parsed!.pipelineName).toBe("demo");
    expect(parsed!.pipelineRoot).toBe(join(projectRoot, ".pipeline", "demo"));
  });

  test("a manager is NOT parsed as a worker, and vice versa", () => {
    const iter = iterationPath("demo");
    expect(
      parseWorkerSpawn({ subagent_type: "pipeline-manager", prompt: `current_iteration = ${iter}` }),
    ).toBeNull();
    expect(
      parseManagerSpawn({ subagent_type: "step-executor", prompt: `Execute pipeline iteration: ${iter}` }),
    ).toBeNull();
  });

  test("non-pipeline subagent returns null for both parsers", () => {
    const iter = iterationPath("demo");
    expect(parseManagerSpawn({ subagent_type: "general-purpose", prompt: `current_iteration = ${iter}` })).toBeNull();
    expect(parseWorkerSpawn({ subagent_type: "general-purpose", prompt: `Execute pipeline iteration: ${iter}` })).toBeNull();
  });

  test("path outside .pipeline/*/steps/ returns null", () => {
    expect(
      parseManagerSpawn({
        subagent_type: "pipeline-manager",
        prompt: "current_iteration = /tmp/random/notes/01-thing.md",
      }),
    ).toBeNull();
  });

  test("prompt with no iteration path returns null", () => {
    expect(
      parseManagerSpawn({
        subagent_type: "pipeline-manager",
        prompt: "Please go orchestrate something vague.",
      }),
    ).toBeNull();
  });

  test("missing prompt returns null", () => {
    expect(parseManagerSpawn({ subagent_type: "pipeline-manager" })).toBeNull();
  });

  test("filename without leading digits defaults index to 1", () => {
    const iter = iterationPath("demo", "intro.md");
    const parsed = parseManagerSpawn({
      subagent_type: "pipeline-manager",
      prompt: `current_iteration = ${iter}`,
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.iterationIndex).toBe(1);
  });
});

describe("handlePostToolUse synthesizes Path-C RUN-LEVEL lifecycle (manager anchor)", () => {
  test("happy path: pipeline.started + pipeline.completed, no iteration.* events", () => {
    const iter = iterationPath("demo");
    handlePostToolUse(makeManagerPayload({ iter }), projectRoot, null);

    const events = readEvents();
    // 1 tool.called + 2 RUN-level lifecycle events = 3.
    expect(events).toHaveLength(3);

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "tool.called",
      "pipeline.started",
      "pipeline.completed",
    ]);
    // The hook must NOT synthesize iteration.* for a manager spawn (the
    // manager self-emits those).
    expect(types).not.toContain("iteration.started");
    expect(types).not.toContain("iteration.completed");

    // All three events share the synthesized run_id so the manager-spawn
    // tool call shows up in the synthesized run's stats panel. ux-v2 b2:
    // this is now a canonical UUIDv5 (hookIdFromToolUseId over tool_use_id),
    // not a 12-hex sha1 slice — 36 chars, version nibble 5.
    const runId = events[0].run_id;
    expect(runId).not.toBeNull();
    expect(typeof runId).toBe("string");
    expect((runId as string).length).toBe(36);
    expect(Number.parseInt((runId as string).slice(14, 16), 16) >>> 4).toBe(0b0101);
    expect(Number.parseInt((runId as string).slice(19, 21), 16) >>> 6).toBe(0b10);
    for (const e of events) {
      expect(e.run_id).toBe(runId);
      expect(e.schema).toBe(SCHEMA_VERSION);
      expect(e.project_root).toBe(projectRoot);
      expect(e.worktree).toBeNull();
      // Synthesized lifecycle events must NOT inherit parent/session env.
      expect(e.parent_run_id).toBeNull();
      expect(e.session_id).toBeNull();
    }
    const synth = events.slice(1);
    // pipeline.started shape (v3 fields).
    expect(synth[0].data).toEqual({
      pipeline_name: "demo",
      first_iteration_path: iter,
      pipeline_root: join(projectRoot, ".pipeline", "demo"),
      default_model: null,
    });
    // pipeline.completed shape.
    expect(synth[1].data).toEqual({ pipeline_name: "demo" });
  });

  test("recent pipeline.started in journal → no synthesis (supervisor owns the run)", () => {
    const iter = iterationPath("demo");
    const existingRunId = "existing-run";
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
    handlePostToolUse(makeManagerPayload({ iter }), projectRoot, null);
    const events = readEvents();
    // One pre-existing pipeline.started + one new tool.called = 2.
    expect(events).toHaveLength(2);
    expect(events[1].type).toBe("tool.called");
    // The hook bypasses synthesis (supervisor already owns the run) but
    // MUST still attribute the manager-spawn's tool.called to the owned run.
    expect(events[1].run_id).toBe(existingRunId);
    expect(events[1].data.agent_spawn).toBe(true);
  });

  test("literal run_id in the manager prompt → no synthesis (Path B discriminator)", () => {
    const iter = iterationPath("demo");
    const supervisorRun = "abcdef012345";
    handlePostToolUse(
      makeManagerPayload({ iter, withRunIdLine: supervisorRun }),
      projectRoot,
      null,
    );
    const events = readEvents();
    // Only the tool.called — no synthesized lifecycle (the supervisor owns it).
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("tool.called");
    expect(events[0].run_id).toBe(supervisorRun);
    expect(events[0].data.agent_spawn).toBe(true);
  });

  test("WORKER spawn is NOT a run anchor: emits tool.called only, no synthesized run", () => {
    const iter = iterationPath("demo");
    handlePostToolUse(
      makeWorkerPayload({
        subagentType: "step-executor",
        prompt: `Execute pipeline iteration: \`${iter}\``,
      }),
      projectRoot,
      null,
    );
    const events = readEvents();
    // Just the tool.called — no pipeline.started / pipeline.completed.
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("tool.called");
    expect(events[0].data.agent_spawn).toBe(true);
  });

  test("legacy WORKER spawn (pipeline-executor) is ALSO not a run anchor", () => {
    const iter = iterationPath("demo");
    handlePostToolUse(
      makeWorkerPayload({
        subagentType: "pipeline-executor",
        prompt: `Execute pipeline iteration: ${iter}`,
      }),
      projectRoot,
      null,
    );
    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("tool.called");
  });

  test("stale pipeline.started (older than dedup window) → synthesis still fires", () => {
    const iter = iterationPath("demo");
    const staleTs = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    writeFileSync(
      eventsPath,
      JSON.stringify({
        schema: 3,
        ts: staleTs,
        type: "pipeline.started",
        project_root: projectRoot,
        worktree: null,
        run_id: "stale-run",
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
    handlePostToolUse(makeManagerPayload({ iter }), projectRoot, null);
    const events = readEvents();
    expect(events).toHaveLength(4); // 1 stale + 1 tool.called + 2 synth
    const synthRunId = events[1].run_id;
    expect(synthRunId).not.toBe("stale-run");
  });

  test("stale env vars (PARENT_RUN_ID, CLAUDE_SESSION_ID) are NOT inherited", () => {
    process.env.PIPELINE_UI_PARENT_RUN_ID = "stale-parent";
    process.env.CLAUDE_SESSION_ID = "stale-session";
    const iter = iterationPath("demo");
    handlePostToolUse(makeManagerPayload({ iter }), projectRoot, null);
    const events = readEvents();
    for (const e of events) {
      expect(e.parent_run_id).toBeNull();
      expect(e.session_id).toBeNull();
    }
  });

  test("nested step subfolder (steps/phase-2/01.md) parses + synthesizes correctly", () => {
    const iter = join(
      projectRoot,
      ".pipeline",
      "nested-demo",
      "steps",
      "phase-2",
      "01-deep.md",
    );
    handlePostToolUse(makeManagerPayload({ iter }), projectRoot, null);
    const events = readEvents();
    expect(events).toHaveLength(3);
    const started = events.find((e) => e.type === "pipeline.started")!;
    expect(started.data.pipeline_name).toBe("nested-demo");
    expect(started.data.pipeline_root).toBe(
      join(projectRoot, ".pipeline", "nested-demo"),
    );
    expect(started.data.first_iteration_path).toBe(iter);
  });

  test("non-pipeline subagent → no synthesis", () => {
    const iter = iterationPath("demo");
    handlePostToolUse(
      {
        hook_event_name: "PostToolUse",
        tool_name: "Task",
        tool_input: { subagent_type: "general-purpose", prompt: `current_iteration = ${iter}` },
        tool_response: { content: "ok" },
        tool_use_id: "toolu_designer",
      },
      projectRoot,
      null,
    );
    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("tool.called");
  });

  test("tool_response.is_error=true → pipeline.halted (run-level), no iteration.completed", () => {
    const iter = iterationPath("demo");
    handlePostToolUse(
      makeManagerPayload({ iter, isError: true, errorMessage: "manager crashed in step 7" }),
      projectRoot,
      null,
    );
    const events = readEvents();
    expect(events).toHaveLength(3);
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "tool.called",
      "pipeline.started",
      "pipeline.halted",
    ]);
    expect(types).not.toContain("iteration.completed");
    const halted = events.find((e) => e.type === "pipeline.halted")!;
    expect(halted.data).toEqual({
      pipeline_name: "demo",
      iteration_path: iter,
      halt_reason: "manager crashed in step 7",
    });
    // tool.called must reflect the failure.
    expect(events[0].data.success).toBe(false);
  });

  test("iteration path outside .pipeline/*/steps/ → no synthesis", () => {
    handlePostToolUse(
      {
        hook_event_name: "PostToolUse",
        tool_name: "Task",
        tool_input: {
          subagent_type: "pipeline-manager",
          prompt: "current_iteration = /tmp/elsewhere/random.md",
        },
        tool_response: { content: "ok" },
        tool_use_id: "toolu_zzz",
      },
      projectRoot,
      null,
    );
    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("tool.called");
  });

  test("non-spawn tool name (Bash) → no synthesis", () => {
    handlePostToolUse(
      {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        tool_response: { content: "files" },
        tool_use_id: "toolu_aaa",
      },
      projectRoot,
      null,
    );
    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("tool.called");
    expect(events[0].data.tool_name).toBe("Bash");
    expect(events[0].data.agent_spawn).toBe(false);
  });

  test("worktree argument propagates to every synthesized event", () => {
    const iter = iterationPath("demo");
    const worktree = join(projectRoot, "worktree-copy");
    handlePostToolUse(makeManagerPayload({ iter }), projectRoot, worktree);
    const events = readEvents();
    for (const e of events) {
      expect(e.worktree).toBe(worktree);
    }
  });
});
