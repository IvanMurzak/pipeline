/**
 * Session→(run, step) binding propagation — ux-v2 b7.
 *
 *   bun test tests/hook-step-binding.test.ts
 *
 * `pipeline drive` spawns every step as a headless `claude -p` with a session
 * id IT pins. The plugin's hooks fire inside that child, but nothing there
 * knows which run — let alone which step — the child belongs to: the child
 * inherits no `PIPELINE_RUN_ID`, and before b7 no binding was keyed by the
 * child's session either. Measured on a live `pipeline drive` run, 100% of the
 * hook events emitted from inside the child stamped `run_id: null`.
 *
 * b7 closes that by having drive PRE-WRITE a binding for the session id it is
 * about to pin, carrying the run UUID and the step UUID (ux-v2 b4). This suite
 * is the contract for the READ half — `resolveBindingFromEnvOrSession` — plus
 * one true round-trip through the CLI's writer, so the two halves cannot drift
 * into disagreeing about the record's shape.
 *
 * Shelf life is deliberate and documented in analytics_relay.ts's header: when
 * `-p` defaults to `--bare` the hooks stop firing inside the child and this
 * mechanism has nothing to attach to.
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
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  findBindingForSession,
  handleNotification,
  handlePostToolUse,
  handleStop,
  handleSubagentStop,
  mirrorBindingsPath,
  resolveBindingFromEnvOrSession,
  resolveRunIdFromEnvOrSession,
  type MirrorBinding,
} from "../../../hooks/analytics_relay.ts";
// The CLI-side WRITER, imported for the round-trip case only.
import { registerDriveSessionBinding } from "../src/lib/event.ts";
import { newId } from "../src/lib/ids.ts";

let tmpRoot: string;
let homeRoot: string;
let projectRoot: string;
let runtimeDir: string;
let eventsPath: string;
let bindingsPath: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "pipeline-stepbind-"));
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

  delete process.env.PIPELINE_RUN_ID;
  delete process.env.PIPELINE_PARENT_RUN_ID;
  delete process.env.CLAUDE_SESSION_ID;
  delete process.env.PIPELINE_JOURNAL_ENABLED;
});

afterEach(() => {
  delete process.env.USERPROFILE;
  delete process.env.HOME;
  delete process.env.PIPELINE_RUN_ID;
  delete process.env.PIPELINE_PARENT_RUN_ID;
  delete process.env.CLAUDE_SESSION_ID;
  delete process.env.PIPELINE_JOURNAL_ENABLED;
});

interface JournalEvent {
  type: string;
  run_id: string | null;
  data: Record<string, unknown>;
}

function readEvents(): JournalEvent[] {
  return readFileSync(eventsPath, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as JournalEvent);
}

/** A drive-shaped pre-spawn binding, written by hand (the writer's own output
 *  is asserted separately in the round-trip case below). */
function writeDriveBinding(rec: Partial<MirrorBinding>): void {
  const full: MirrorBinding = {
    event: "bound",
    tool_use_id: null,
    run_id: "run-drive",
    step_uuid: null,
    session_id: null,
    transcript_path: null,
    project_root: projectRoot,
    worktree: null,
    pipeline_name: "demo",
    iteration_path: join(projectRoot, ".pipeline", "demo", "steps", "01.md"),
    start_ts: new Date().toISOString(),
    kind: "drive-session",
    schema: 1,
    ...rec,
  };
  appendFileSync(bindingsPath, JSON.stringify(full) + "\n", "utf-8");
}

/** A PRE-b7 binding: the field is absent entirely, not null — every binding
 *  already on a user's disk looks like this. */
function writeLegacyBinding(runId: string, sessionId: string): void {
  const rec = {
    event: "bound",
    tool_use_id: null,
    run_id: runId,
    session_id: sessionId,
    transcript_path: null,
    project_root: projectRoot,
    worktree: null,
    pipeline_name: "demo",
    iteration_path: "",
    start_ts: new Date().toISOString(),
    kind: "chain-controller",
    schema: 1,
  };
  appendFileSync(bindingsPath, JSON.stringify(rec) + "\n", "utf-8");
}

describe("findBindingForSession — the step rides along with the run", () => {
  test("returns the bound run AND step for a matching session", () => {
    const step = newId();
    writeDriveBinding({ run_id: "run-1", session_id: "sess-1", step_uuid: step });
    expect(findBindingForSession("sess-1", projectRoot)).toEqual({
      runId: "run-1",
      stepUuid: step,
    });
  });

  test("a PRE-b7 binding (no step_uuid field) still resolves its run, with a null step", () => {
    writeLegacyBinding("run-legacy", "sess-legacy");
    expect(findBindingForSession("sess-legacy", projectRoot)).toEqual({
      runId: "run-legacy",
      stepUuid: null,
    });
    // The narrow run-id wrapper is unchanged for every existing caller.
    expect(resolveRunIdFromEnvOrSession("sess-legacy", projectRoot)).toBe("run-legacy");
  });

  test("a later binding for the SAME session replaces the step (an answer/crash resume re-states it)", () => {
    const first = newId();
    const second = newId();
    writeDriveBinding({
      run_id: "run-1",
      session_id: "sess-1",
      step_uuid: first,
      start_ts: new Date(Date.now() - 60_000).toISOString(),
    });
    writeDriveBinding({ run_id: "run-1", session_id: "sess-1", step_uuid: second });
    expect(findBindingForSession("sess-1", projectRoot)!.stepUuid).toBe(second);
  });

  test("a terminal record does not blank the step its bound record established", () => {
    // The terminal record carries no step_uuid; it must not erase one. (It DOES
    // still terminate the run — asserted by the null result.)
    const step = newId();
    writeDriveBinding({ run_id: "run-1", session_id: "sess-1", step_uuid: step });
    writeDriveBinding({ run_id: "run-1", session_id: "sess-1", event: "terminal" });
    expect(findBindingForSession("sess-1", projectRoot)).toBeNull();

    // Same file, a DIFFERENT still-live run: the terminal above must not have
    // corrupted the surviving record's step identity.
    writeDriveBinding({ run_id: "run-2", session_id: "sess-2", step_uuid: step });
    writeDriveBinding({ run_id: "run-2", session_id: "sess-2" }); // no step field carried
    expect(findBindingForSession("sess-2", projectRoot)!.stepUuid).toBe(step);
  });

  test("no binding ⇒ null, not a fabricated step", () => {
    expect(findBindingForSession("sess-nobody", projectRoot)).toBeNull();
    expect(resolveBindingFromEnvOrSession("sess-nobody", projectRoot)).toEqual({
      runId: null,
      stepUuid: null,
    });
  });
});

describe("resolveBindingFromEnvOrSession — env precedence is unchanged", () => {
  test("PIPELINE_RUN_ID still wins for the run id", () => {
    writeDriveBinding({ run_id: "run-binding", session_id: "sess-1", step_uuid: newId() });
    process.env.PIPELINE_RUN_ID = "run-env";
    expect(resolveBindingFromEnvOrSession("sess-1", projectRoot).runId).toBe("run-env");
  });

  test("a step is adopted from the binding only when it agrees with the env run", () => {
    const step = newId();
    writeDriveBinding({ run_id: "run-same", session_id: "sess-1", step_uuid: step });
    process.env.PIPELINE_RUN_ID = "run-same";
    expect(resolveBindingFromEnvOrSession("sess-1", projectRoot)).toEqual({
      runId: "run-same",
      stepUuid: step,
    });
  });

  test("a step from a DIFFERENT run is refused — a wrong step is worse than none", () => {
    writeDriveBinding({ run_id: "run-other", session_id: "sess-1", step_uuid: newId() });
    process.env.PIPELINE_RUN_ID = "run-env";
    expect(resolveBindingFromEnvOrSession("sess-1", projectRoot)).toEqual({
      runId: "run-env",
      stepUuid: null,
    });
  });

  test('PIPELINE_RUN_ID="" is still treated as unset', () => {
    const step = newId();
    writeDriveBinding({ run_id: "run-binding", session_id: "sess-1", step_uuid: step });
    process.env.PIPELINE_RUN_ID = "";
    expect(resolveBindingFromEnvOrSession("sess-1", projectRoot)).toEqual({
      runId: "run-binding",
      stepUuid: step,
    });
  });
});

describe("hook events carry BOTH ids", () => {
  test("tool.called names the run and the step", () => {
    const step = newId();
    writeDriveBinding({ run_id: "run-1", session_id: "sess-exec", step_uuid: step });
    handlePostToolUse(
      {
        tool_name: "Edit",
        tool_input: { file_path: "/x/y.ts" },
        tool_response: { content: "ok" },
        tool_use_id: "toolu_edit_1",
        session_id: "sess-exec",
      },
      projectRoot,
      null,
    );
    const ev = readEvents().find((e) => e.type === "tool.called")!;
    expect(ev.run_id).toBe("run-1");
    expect(ev.data.step_uuid).toBe(step);
  });

  test("tool.called OMITS step_uuid entirely when none resolves (absent ≠ null)", () => {
    writeLegacyBinding("run-legacy", "sess-legacy");
    handlePostToolUse(
      {
        tool_name: "Read",
        tool_input: { file_path: "/x/y.ts" },
        tool_response: { content: "ok" },
        tool_use_id: "toolu_read_1",
        session_id: "sess-legacy",
      },
      projectRoot,
      null,
    );
    const ev = readEvents().find((e) => e.type === "tool.called")!;
    expect(ev.run_id).toBe("run-legacy");
    expect("step_uuid" in ev.data).toBe(false);
  });

  test("turn.usage attributes the step's tokens to the step", () => {
    const step = newId();
    const transcript = join(tmpRoot, `t-${Date.now()}-${Math.random()}.jsonl`);
    appendFileSync(
      transcript,
      JSON.stringify({
        type: "assistant",
        message: { id: "msg_1", usage: { input_tokens: 7, output_tokens: 11 } },
      }) + "\n",
      "utf-8",
    );
    writeDriveBinding({ run_id: "run-1", session_id: "sess-stop", step_uuid: step });

    handleStop({ transcript_path: transcript, session_id: "sess-stop" }, projectRoot, null);

    const ev = readEvents().find((e) => e.type === "turn.usage")!;
    expect(ev.run_id).toBe("run-1");
    expect(ev.data.step_uuid).toBe(step);
    expect(ev.data.output_tokens).toBe(11);
  });

  test("manager.stopped carries the step when the binding names one", () => {
    const step = newId();
    writeDriveBinding({ run_id: "run-1", session_id: "sess-mgr", step_uuid: step });
    handleSubagentStop(
      { agent_type: "pipeline-manager", session_id: "sess-mgr", agent_id: "agent-9" },
      projectRoot,
      null,
    );
    const ev = readEvents().find((e) => e.type === "manager.stopped")!;
    expect(ev.run_id).toBe("run-1");
    expect(ev.data.step_uuid).toBe(step);
  });

  test("run.awaiting_input names the step that is blocked", () => {
    const step = newId();
    writeDriveBinding({ run_id: "run-1", session_id: "sess-ask", step_uuid: step });
    handleNotification(
      {
        notification_type: "agent_needs_input",
        message: "waiting for your input",
        session_id: "sess-ask",
      },
      projectRoot,
      null,
    );
    const ev = readEvents().find((e) => e.type === "run.awaiting_input")!;
    expect(ev.run_id).toBe("run-1");
    expect(ev.data.step_uuid).toBe(step);
  });
});

describe("round trip — the CLI writes it, the hook reads it", () => {
  test("registerDriveSessionBinding → resolveBindingFromEnvOrSession → tool.called", () => {
    const runId = newId();
    const stepUuid = newId();
    const sessionId = newId(); // drive pins this and passes it to `claude --session-id`

    // The write half, called EXACTLY as drive calls it (project root passed
    // explicitly — drive's cwd is the project, this test's is not).
    registerDriveSessionBinding({
      runId,
      sessionId,
      stepUuid,
      projectRoot,
      pipelineName: "demo",
      iterationPath: join(projectRoot, ".pipeline", "demo", "steps", "01.md"),
    });

    // The read half, as the hook inside `claude -p` runs it.
    expect(resolveBindingFromEnvOrSession(sessionId, projectRoot)).toEqual({ runId, stepUuid });

    handlePostToolUse(
      {
        tool_name: "Bash",
        tool_input: { command: "ls" },
        tool_response: { content: "ok" },
        tool_use_id: "toolu_bash_1",
        session_id: sessionId,
      },
      projectRoot,
      null,
    );
    const ev = readEvents().find((e) => e.type === "tool.called")!;
    expect(ev.run_id).toBe(runId);
    expect(ev.data.step_uuid).toBe(stepUuid);
  });

  test("the record the writer emits is transcript-pointer-free (issue #11 scope discipline)", () => {
    registerDriveSessionBinding({
      runId: newId(),
      sessionId: newId(),
      stepUuid: newId(),
      projectRoot,
    });
    const rec = JSON.parse(readFileSync(bindingsPath, "utf-8").trim().split("\n").pop()!);
    expect(rec.kind).toBe("drive-session");
    expect(rec.transcript_path).toBeNull();
    expect(rec.event).toBe("bound");
  });

  test("PIPELINE_JOURNAL_ENABLED=0 writes no binding at all (master opt-out)", () => {
    process.env.PIPELINE_JOURNAL_ENABLED = "0";
    const sessionId = newId();
    registerDriveSessionBinding({
      runId: newId(),
      sessionId,
      stepUuid: newId(),
      projectRoot,
    });
    expect(findBindingForSession(sessionId, projectRoot)).toBeNull();
  });

  test("a completed run retires every binding that shares its run_id — no terminal record needed", () => {
    // This is the binding's whole lifecycle story: drive writes one record per
    // step session and NO terminal record. When the run ends, its own
    // pipeline.completed in events.jsonl terminates all of them at once.
    const runId = newId();
    const sessions = [newId(), newId(), newId()];
    for (const s of sessions) {
      registerDriveSessionBinding({ runId, sessionId: s, stepUuid: newId(), projectRoot });
      expect(findBindingForSession(s, projectRoot)!.runId).toBe(runId);
    }
    appendFileSync(
      eventsPath,
      JSON.stringify({
        schema: 5,
        ts: new Date().toISOString(),
        type: "pipeline.completed",
        project_root: projectRoot,
        worktree: null,
        run_id: runId,
        parent_run_id: null,
        session_id: null,
        data: {},
      }) + "\n",
      "utf-8",
    );
    for (const s of sessions) {
      expect(findBindingForSession(s, projectRoot)).toBeNull();
    }
  });
});
