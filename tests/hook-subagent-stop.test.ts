/**
 * SubagentStop handler + depth-2 worker run-correlation —
 * hooks/analytics_relay.ts (Phase 2).
 *
 *   bun test tests/hook-subagent-stop.test.ts
 *
 * Phase 2 introduces an agent-lifecycle liveness signal: when a
 * `pipeline-manager` subagent stops, the SubagentStop hook emits a
 * `manager.stopped { run_id, agent_id }` event — the PRIMARY "the run's
 * orchestrator is gone" signal that the daemon consumes for dead-run
 * detection. A SubagentStop for any OTHER agent type is ignored.
 *
 * Because session_id is SHARED across all nesting depths (main = manager =
 * worker), the manager's run_id is resolved via the same session-keyed
 * mirror-binding recovery used by tool.called. The last describe block
 * asserts that a depth-2 worker's tool.called recovers its run_id through
 * that shared-session binding too.
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
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  handlePostToolUse,
  handleSubagentStop,
  mirrorBindingsPath,
  subagentTypeFromPayload,
  type MirrorBinding,
} from "../../../hooks/analytics_relay.ts";

let tmpRoot: string;
let homeRoot: string;
let projectRoot: string;
let runtimeDir: string;
let eventsPath: string;
let bindingsPath: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "pipeline-subagentstop-"));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpRoot, "proj-"));
  runtimeDir = join(projectRoot, ".pipeline", ".runtime");
  mkdirSync(runtimeDir, { recursive: true });
  eventsPath = join(runtimeDir, "events.jsonl");
  homeRoot = mkdtempSync(join(tmpRoot, "home-"));
  process.env.USERPROFILE = homeRoot;
  process.env.HOME = homeRoot;
  bindingsPath = mirrorBindingsPath();
  mkdirSync(join(homeRoot, ".claude", "pipeline-ui"), { recursive: true });
  delete process.env.PIPELINE_UI_RUN_ID;
  delete process.env.CLAUDE_SESSION_ID;
});

afterEach(() => {
  delete process.env.USERPROFILE;
  delete process.env.HOME;
  delete process.env.PIPELINE_UI_RUN_ID;
  delete process.env.CLAUDE_SESSION_ID;
});

interface JournalEvent {
  type: string;
  run_id: string | null;
  data: Record<string, unknown>;
}

function readEvents(): JournalEvent[] {
  try {
    return readFileSync(eventsPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as JournalEvent);
  } catch {
    return [];
  }
}

function writeBinding(rec: Partial<MirrorBinding>): void {
  const full: MirrorBinding = {
    event: "bound",
    tool_use_id: null,
    run_id: "missing-run-id",
    session_id: null,
    transcript_path: null,
    project_root: projectRoot,
    worktree: null,
    pipeline_name: "demo",
    iteration_path: join(projectRoot, ".pipeline", "demo", "steps", "01.md"),
    start_ts: new Date().toISOString(),
    kind: "chain-controller",
    schema: 1,
    ...rec,
  };
  appendFileSync(bindingsPath, JSON.stringify(full) + "\n", "utf-8");
}

describe("subagentTypeFromPayload", () => {
  test("reads agent_type / subagent_type / agent_name spellings", () => {
    expect(subagentTypeFromPayload({ agent_type: "pipeline-manager" })).toBe("pipeline-manager");
    expect(subagentTypeFromPayload({ subagent_type: "step-executor" })).toBe("step-executor");
    expect(subagentTypeFromPayload({ agent_name: "x" })).toBe("x");
    expect(subagentTypeFromPayload({})).toBe("");
  });
});

describe("handleSubagentStop — manager.stopped emission", () => {
  test("(a) SubagentStop for pipeline-manager emits manager.stopped with the resolved run_id", () => {
    // The supervisor's mirror binding ties session → run_id; the manager
    // shares the session, so resolveRunIdFromEnvOrSession recovers it.
    writeBinding({ run_id: "run-mgr-1", session_id: "sess-1" });
    handleSubagentStop(
      {
        hook_event_name: "SubagentStop",
        agent_type: "pipeline-manager",
        agent_id: "agent_xyz",
        session_id: "sess-1",
      },
      projectRoot,
      null,
    );
    const events = readEvents();
    const stopped = events.filter((e) => e.type === "manager.stopped");
    expect(stopped).toHaveLength(1);
    expect(stopped[0].run_id).toBe("run-mgr-1");
    expect(stopped[0].data.run_id).toBe("run-mgr-1");
    expect(stopped[0].data.agent_id).toBe("agent_xyz");
  });

  test("manager.stopped resolves run_id via the env var when set", () => {
    process.env.PIPELINE_UI_RUN_ID = "run-from-env";
    handleSubagentStop(
      {
        hook_event_name: "SubagentStop",
        subagent_type: "pipeline-manager",
        session_id: "sess-none",
      },
      projectRoot,
      null,
    );
    const stopped = readEvents().filter((e) => e.type === "manager.stopped");
    expect(stopped).toHaveLength(1);
    expect(stopped[0].run_id).toBe("run-from-env");
  });

  test("plugin-namespaced manager (pipeline:pipeline-manager) is recognized", () => {
    writeBinding({ run_id: "run-ns-1", session_id: "sess-ns" });
    handleSubagentStop(
      { agent_type: "pipeline:pipeline-manager", session_id: "sess-ns" },
      projectRoot,
      null,
    );
    const stopped = readEvents().filter((e) => e.type === "manager.stopped");
    expect(stopped).toHaveLength(1);
    expect(stopped[0].run_id).toBe("run-ns-1");
  });

  test("(b) SubagentStop for a non-manager agent does NOT emit manager.stopped", () => {
    writeBinding({ run_id: "run-w-1", session_id: "sess-1" });
    for (const agentType of ["step-executor", "pipeline-executor", "pipeline-improver", "general-purpose"]) {
      handleSubagentStop(
        { agent_type: agentType, session_id: "sess-1" },
        projectRoot,
        null,
      );
    }
    const stopped = readEvents().filter((e) => e.type === "manager.stopped");
    expect(stopped).toHaveLength(0);
  });

  test("manager stop with no resolvable run_id emits nothing (pid-sweep fallback handles it)", () => {
    handleSubagentStop(
      { agent_type: "pipeline-manager", session_id: "sess-unknown" },
      projectRoot,
      null,
    );
    expect(readEvents().filter((e) => e.type === "manager.stopped")).toHaveLength(0);
  });
});

describe("(d) depth-2 worker tool.called resolves run_id via the shared-session mirror binding", () => {
  test("a worker's internal Read at depth 2 binds to the run via the shared session_id", () => {
    // session_id is shared across depths: the supervisor (depth 0) wrote a
    // binding keyed on sess-shared → run-shared. A depth-2 worker's internal
    // tool call carries the SAME session_id, so the session lookup recovers
    // the run_id even though PIPELINE_UI_RUN_ID never propagated.
    writeBinding({ run_id: "run-shared", session_id: "sess-shared" });
    handlePostToolUse(
      {
        hook_event_name: "PostToolUse",
        tool_name: "Read",
        tool_input: { file_path: "/some/file.ts" },
        tool_response: { content: "ok" },
        tool_use_id: "toolu_worker_read",
        session_id: "sess-shared",
      },
      projectRoot,
      null,
    );
    const toolCalled = readEvents().filter((e) => e.type === "tool.called");
    expect(toolCalled).toHaveLength(1);
    expect(toolCalled[0].run_id).toBe("run-shared");
  });

  test("a worker's Bash at depth 2 with no binding stamps run_id=null", () => {
    handlePostToolUse(
      {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        tool_response: { content: "files" },
        tool_use_id: "toolu_worker_bash",
        session_id: "sess-orphan",
      },
      projectRoot,
      null,
    );
    const toolCalled = readEvents().filter((e) => e.type === "tool.called");
    expect(toolCalled).toHaveLength(1);
    expect(toolCalled[0].run_id).toBeNull();
  });
});
