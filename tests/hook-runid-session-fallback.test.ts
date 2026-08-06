/**
 * Run-id session fallback — hooks/analytics_relay.ts.
 *
 *   bun test tests/hook-runid-session-fallback.test.ts
 *
 * Regression coverage for the "RUN_ANALYTICS panel always shows zero"
 * bug. The PostToolUse and Stop hooks emit tool.called and turn.usage
 * events that the UI folds into RunState.stats. Before this fix, both
 * relied solely on `process.env.PIPELINE_UI_RUN_ID` for run correlation
 * — but /pipeline:run exports that variable inside a Bash subshell that
 * never propagates back to Claude Code's parent process, so the env var
 * was always unset when these hook subprocesses ran. The result: every
 * tool.called and turn.usage event stamped run_id=null and the per-run
 * stats stayed at zero on every actively-running pipeline.
 *
 * The fix: when the env var is missing, look the run_id up by
 * session_id in ~/.claude/pipeline-ui/active-mirror-bindings.jsonl.
 * Both /pipeline:run (via `pipeline event` register-mirror-binding) and the
 * Path-C bypass PreToolUse hook write session-keyed bindings, so this
 * recovers the run_id for Paths B and C without changing Path A
 * behavior.
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
  BINDING_MAX_AGE_MS,
  collectTerminatedRunIds,
  findRunIdForSession,
  handlePostToolUse,
  handleStop,
  mirrorBindingsPath,
  pathsMatch,
  resolveRunIdFromEnvOrSession,
  type MirrorBinding,
} from "../../../hooks/analytics_relay.ts";

let tmpRoot: string;
let homeRoot: string;
let projectRoot: string;
let runtimeDir: string;
let eventsPath: string;
let bindingsPath: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "pipeline-runid-"));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpRoot, "proj-"));
  runtimeDir = join(projectRoot, ".pipeline", ".runtime");
  mkdirSync(runtimeDir, { recursive: true });
  eventsPath = join(runtimeDir, "events.jsonl");
  // Isolate the home dir so the test never touches the developer's real
  // active-mirror-bindings.jsonl. mirrorBindingsPath() reads
  // process.env.USERPROFILE first, then HOME, then os.homedir() — match
  // analytics_relay's resolution exactly so the test rewires only what
  // the production code reads.
  homeRoot = mkdtempSync(join(tmpRoot, "home-"));
  process.env.USERPROFILE = homeRoot;
  process.env.HOME = homeRoot;
  bindingsPath = mirrorBindingsPath();
  mkdirSync(join(homeRoot, ".claude", "pipeline-ui"), { recursive: true });

  delete process.env.PIPELINE_UI_RUN_ID;
  delete process.env.PIPELINE_UI_PARENT_RUN_ID;
  delete process.env.CLAUDE_SESSION_ID;
});

afterEach(() => {
  delete process.env.USERPROFILE;
  delete process.env.HOME;
  delete process.env.PIPELINE_UI_RUN_ID;
  delete process.env.PIPELINE_UI_PARENT_RUN_ID;
  delete process.env.CLAUDE_SESSION_ID;
});

interface JournalEvent {
  schema: number;
  type: string;
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

describe("findRunIdForSession", () => {
  test("returns null when bindings file is absent", () => {
    expect(findRunIdForSession("sess-1", projectRoot)).toBeNull();
  });

  test("returns the bound run_id for a matching session", () => {
    writeBinding({ run_id: "run-aaa", session_id: "sess-1" });
    expect(findRunIdForSession("sess-1", projectRoot)).toBe("run-aaa");
  });

  test("ignores bindings for a different session", () => {
    writeBinding({ run_id: "run-aaa", session_id: "sess-1" });
    writeBinding({ run_id: "run-bbb", session_id: "sess-2" });
    expect(findRunIdForSession("sess-1", projectRoot)).toBe("run-aaa");
    expect(findRunIdForSession("sess-2", projectRoot)).toBe("run-bbb");
  });

  test("ignores bindings for a different project_root", () => {
    writeBinding({ run_id: "run-aaa", session_id: "sess-1", project_root: "/some/other/project" });
    expect(findRunIdForSession("sess-1", projectRoot)).toBeNull();
  });

  test("skips bindings whose run_id was terminated", () => {
    writeBinding({ run_id: "run-aaa", session_id: "sess-1", event: "bound" });
    writeBinding({ run_id: "run-aaa", session_id: "sess-1", event: "terminal" });
    expect(findRunIdForSession("sess-1", projectRoot)).toBeNull();
  });

  test("picks the most-recent non-terminated run when multiple coexist", () => {
    const olderTs = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
    const newerTs = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5m ago
    writeBinding({
      run_id: "run-old",
      session_id: "sess-1",
      start_ts: olderTs,
    });
    writeBinding({
      run_id: "run-new",
      session_id: "sess-1",
      start_ts: newerTs,
    });
    expect(findRunIdForSession("sess-1", projectRoot)).toBe("run-new");
  });

  test("returns null for missing session_id", () => {
    writeBinding({ run_id: "run-aaa", session_id: null });
    expect(findRunIdForSession(null, projectRoot)).toBeNull();
  });
});

describe("resolveRunIdFromEnvOrSession", () => {
  test("env var wins over a session binding when both exist", () => {
    writeBinding({ run_id: "run-from-binding", session_id: "sess-1" });
    process.env.PIPELINE_UI_RUN_ID = "run-from-env";
    expect(resolveRunIdFromEnvOrSession("sess-1", projectRoot)).toBe("run-from-env");
  });

  test("falls back to session binding when env is unset", () => {
    writeBinding({ run_id: "run-from-binding", session_id: "sess-1" });
    expect(resolveRunIdFromEnvOrSession("sess-1", projectRoot)).toBe("run-from-binding");
  });

  test("returns null when neither env nor binding applies", () => {
    expect(resolveRunIdFromEnvOrSession("sess-1", projectRoot)).toBeNull();
  });
});

describe("handlePostToolUse — tool.called run_id attribution", () => {
  test("non-Agent tool inherits run_id from session binding when env is unset", () => {
    // Simulate the Path-B chain controller: /pipeline:run wrote a
    // mirror binding at chain start with run_id=run-b1 + session=sess-1,
    // but exporting PIPELINE_UI_RUN_ID happened in a bash subshell so
    // the env var is NOT set in this hook subprocess.
    writeBinding({ run_id: "run-b1", session_id: "sess-1" });
    handlePostToolUse(
      {
        tool_name: "Read",
        tool_input: { file_path: "/x/y.md" },
        tool_response: { content: "ok" },
        tool_use_id: "toolu_read_001",
        session_id: "sess-1",
      },
      projectRoot,
      null,
    );
    const events = readEvents();
    const toolCalled = events.filter((e) => e.type === "tool.called");
    expect(toolCalled).toHaveLength(1);
    expect(toolCalled[0].run_id).toBe("run-b1");
  });

  test("non-Agent tool with no env and no binding stamps run_id=null", () => {
    handlePostToolUse(
      {
        tool_name: "Read",
        tool_input: { file_path: "/x/y.md" },
        tool_response: { content: "ok" },
        tool_use_id: "toolu_read_002",
        session_id: "sess-orphan",
      },
      projectRoot,
      null,
    );
    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("tool.called");
    expect(events[0].run_id).toBeNull();
  });

  test("env var still wins when set", () => {
    writeBinding({ run_id: "run-from-binding", session_id: "sess-1" });
    process.env.PIPELINE_UI_RUN_ID = "run-from-env";
    handlePostToolUse(
      {
        tool_name: "Read",
        tool_input: { file_path: "/x/y.md" },
        tool_response: { content: "ok" },
        tool_use_id: "toolu_read_003",
        session_id: "sess-1",
      },
      projectRoot,
      null,
    );
    const events = readEvents();
    const toolCalled = events.filter((e) => e.type === "tool.called");
    expect(toolCalled).toHaveLength(1);
    expect(toolCalled[0].run_id).toBe("run-from-env");
  });

  test("Path-B Agent spawn binds tool.called to the chain-controller's owned run_id", () => {
    // Pre-seed events.jsonl with a pipeline.started so findChainController
    // RunId returns the owned run_id for this iteration.
    const iter = join(projectRoot, ".pipeline", "demo", "steps", "01-warmup.md");
    const fakeStarted = {
      schema: 3,
      ts: new Date().toISOString(),
      type: "pipeline.started",
      project_root: projectRoot,
      worktree: null,
      run_id: "run-chain-1",
      parent_run_id: null,
      session_id: null,
      data: { pipeline_name: "demo", first_iteration_path: iter, pipeline_root: join(projectRoot, ".pipeline", "demo") },
    };
    appendFileSync(eventsPath, JSON.stringify(fakeStarted) + "\n", "utf-8");

    handlePostToolUse(
      {
        tool_name: "Task",
        tool_input: {
          subagent_type: "pipeline-executor",
          prompt: `Execute pipeline iteration: \`${iter}\`\n\nMore context...`,
        },
        tool_response: { content: "executor finished" },
        tool_use_id: "toolu_spawn_001",
        session_id: "sess-1",
      },
      projectRoot,
      null,
    );

    const events = readEvents();
    const toolCalled = events.find((e) => e.type === "tool.called");
    expect(toolCalled).toBeDefined();
    expect(toolCalled!.run_id).toBe("run-chain-1");
    expect(toolCalled!.data.agent_spawn).toBe(true);
  });
});

describe("findRunIdForSession — terminal-state second-source from events.jsonl", () => {
  function writeJournalEvent(type: string, runId: string, ts: string = new Date().toISOString()): void {
    appendFileSync(
      eventsPath,
      JSON.stringify({
        schema: 3,
        ts,
        type,
        project_root: projectRoot,
        worktree: null,
        run_id: runId,
        parent_run_id: null,
        session_id: null,
        data: { pipeline_name: "demo" },
      }) + "\n",
      "utf-8",
    );
  }

  test("treats a binding as terminated when pipeline.completed has been emitted for its run_id (closes the 'completed run inflation' bug)", () => {
    writeBinding({ run_id: "run-complete-1", session_id: "sess-1", event: "bound" });
    writeJournalEvent("pipeline.completed", "run-complete-1");
    expect(findRunIdForSession("sess-1", projectRoot)).toBeNull();
  });

  test("treats a binding as terminated when pipeline.halted has been emitted", () => {
    writeBinding({ run_id: "run-halt-1", session_id: "sess-1", event: "bound" });
    writeJournalEvent("pipeline.halted", "run-halt-1");
    expect(findRunIdForSession("sess-1", projectRoot)).toBeNull();
  });

  test("an active run survives even when an UNRELATED completed run exists for the same session", () => {
    const doneTs = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
    const liveTs = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5m ago
    writeBinding({
      run_id: "run-done",
      session_id: "sess-1",
      event: "bound",
      start_ts: doneTs,
    });
    writeBinding({
      run_id: "run-live",
      session_id: "sess-1",
      event: "bound",
      start_ts: liveTs,
    });
    writeJournalEvent("pipeline.completed", "run-done");
    expect(findRunIdForSession("sess-1", projectRoot)).toBe("run-live");
  });

  test("collectTerminatedRunIds picks up both completed and halted events", () => {
    writeJournalEvent("pipeline.completed", "run-c");
    writeJournalEvent("pipeline.halted", "run-h");
    writeJournalEvent("pipeline.started", "run-running"); // not terminated
    const terminated = collectTerminatedRunIds(projectRoot);
    expect(terminated.has("run-c")).toBe(true);
    expect(terminated.has("run-h")).toBe(true);
    expect(terminated.has("run-running")).toBe(false);
  });
});

describe("findRunIdForSession — staleness window", () => {
  test("a binding older than BINDING_MAX_AGE_MS is treated as stale", () => {
    const oldTs = new Date(Date.now() - (BINDING_MAX_AGE_MS + 60_000)).toISOString();
    writeBinding({ run_id: "run-ancient", session_id: "sess-1", start_ts: oldTs });
    expect(findRunIdForSession("sess-1", projectRoot)).toBeNull();
  });

  test("a binding just inside the staleness window is still returned", () => {
    const recentTs = new Date(Date.now() - (BINDING_MAX_AGE_MS - 60_000)).toISOString();
    writeBinding({ run_id: "run-recent", session_id: "sess-1", start_ts: recentTs });
    expect(findRunIdForSession("sess-1", projectRoot)).toBe("run-recent");
  });
});

describe("findRunIdForSession — full-file fallback when tail window misses", () => {
  test("an old binding past the 2000-line tail is still recovered by the full-scan fallback", () => {
    // Stage 1: write the active binding first (it will sit at line 0).
    writeBinding({ run_id: "run-old-but-active", session_id: "sess-1" });
    // Stage 2: pad with 2500 unrelated bindings to push run-old-but-active
    // out of the tail window.
    for (let i = 0; i < 2500; i++) {
      writeBinding({
        run_id: `padding-${i}`,
        session_id: `other-session-${i}`,
        project_root: "/nope",
      });
    }
    expect(findRunIdForSession("sess-1", projectRoot)).toBe("run-old-but-active");
  });
});

describe("pathsMatch — Windows drive-letter casing tolerance", () => {
  test("identical paths match", () => {
    expect(pathsMatch("/foo/bar", "/foo/bar")).toBe(true);
  });

  test("on Windows, different drive-letter case still matches", () => {
    if (process.platform !== "win32") {
      // pathsMatch is strict on POSIX; nothing to assert about Windows
      // semantics here.
      return;
    }
    expect(pathsMatch("C:\\Projects\\X", "c:\\projects\\x")).toBe(true);
    expect(pathsMatch("C:/Projects/X", "c:\\projects\\x")).toBe(true);
  });

  test("different paths do not match", () => {
    expect(pathsMatch("/foo/a", "/foo/b")).toBe(false);
  });
});

describe("resolveRunIdFromEnvOrSession — empty PIPELINE_UI_RUN_ID is treated as unset", () => {
  test("empty env string falls through to session lookup (does not leak as run_id='')", () => {
    writeBinding({ run_id: "run-from-binding", session_id: "sess-1" });
    process.env.PIPELINE_UI_RUN_ID = "";
    expect(resolveRunIdFromEnvOrSession("sess-1", projectRoot)).toBe("run-from-binding");
  });
});

describe("handleStop — turn.usage run_id attribution", () => {
  function writeTranscript(path: string, turns: Array<{ in: number; out: number; cr?: number; cc?: number }>): void {
    mkdirSync(join(path, ".."), { recursive: true });
    const lines = turns.map((t, i) =>
      JSON.stringify({
        type: "assistant",
        message: {
          id: `msg_${i}`,
          usage: {
            input_tokens: t.in,
            output_tokens: t.out,
            cache_read_input_tokens: t.cr ?? 0,
            cache_creation_input_tokens: t.cc ?? 0,
          },
        },
      }),
    );
    appendFileSync(path, lines.join("\n") + "\n", "utf-8");
  }

  test("turn.usage inherits run_id from session binding when env is unset", () => {
    const transcriptPath = join(tmpRoot, `transcript-${Date.now()}.jsonl`);
    writeTranscript(transcriptPath, [{ in: 100, out: 50, cr: 10, cc: 5 }]);
    writeBinding({ run_id: "run-stop-1", session_id: "sess-stop" });

    handleStop(
      {
        transcript_path: transcriptPath,
        session_id: "sess-stop",
      },
      projectRoot,
      null,
    );

    const events = readEvents();
    const usage = events.find((e) => e.type === "turn.usage");
    expect(usage).toBeDefined();
    expect(usage!.run_id).toBe("run-stop-1");
    expect(usage!.data.input_tokens).toBe(100);
    expect(usage!.data.output_tokens).toBe(50);
  });

  test("turn.usage stamps run_id=null when no env and no binding", () => {
    const transcriptPath = join(tmpRoot, `transcript-orphan-${Date.now()}.jsonl`);
    writeTranscript(transcriptPath, [{ in: 1, out: 2 }]);

    handleStop(
      {
        transcript_path: transcriptPath,
        session_id: "sess-orphan",
      },
      projectRoot,
      null,
    );

    const events = readEvents();
    const usage = events.find((e) => e.type === "turn.usage");
    expect(usage).toBeDefined();
    expect(usage!.run_id).toBeNull();
  });
});
