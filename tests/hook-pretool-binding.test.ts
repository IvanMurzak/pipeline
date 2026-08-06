/**
 * PreToolUse mirror-binding writer — hooks/analytics_relay.ts (Phase 2).
 *
 *   bun test tests/hook-pretool-binding.test.ts
 *
 * PreToolUse lets the daemon start tailing a subagent's transcript as soon
 * as Claude Code is about to call Agent — before the subagent runs. As of
 * the Phase 2 rekey, the RUN ANCHOR is the `pipeline-manager` spawn:
 *
 *   • A Path-C MANAGER spawn (no /pipeline:run supervisor owning the run)
 *     emits the START half of the RUN lifecycle — `pipeline.started` ONLY
 *     (no `iteration.started`; the manager self-emits those) — plus a
 *     bypass-spawn mirror binding.
 *   • A Path-B manager spawn (the supervisor passes its run_id literally,
 *     or a recent pipeline.started exists in the journal) writes only a
 *     chain-controller binding and stays SILENT on lifecycle.
 *   • A WORKER spawn (step-executor / legacy pipeline-executor) is NOT a run
 *     anchor: it gets a chain-controller mirror binding (so the UI shows the
 *     step work) but NEVER synthesizes a run.
 *
 * Critical invariant: PreToolUse and PostToolUse must agree on the
 * synthesized run_id (sha1 prefix of tool_use_id) so the early binding and
 * the lifecycle events share one run identity.
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
  handlePreToolUse,
  handlePostToolUse,
  bypassRunIdFromToolUseId,
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
  tmpRoot = mkdtempSync(join(tmpdir(), "pipeline-pretool-"));
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
  kind: string;
  session_id: string | null;
  transcript_path: string | null;
  pipeline_name: string;
  iteration_path: string;
  schema: number;
}

function readBindings(): Binding[] {
  if (!existsSync(bindingsPath)) return [];
  return readFileSync(bindingsPath, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Binding);
}

function readEventTypes(): { type: string; run_id: string }[] {
  if (!existsSync(eventsPath)) return [];
  return readFileSync(eventsPath, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as { type: string; run_id: string });
}

function iterationPath(pipelineName: string, file = "01-x.md"): string {
  return join(projectRoot, ".pipeline", pipelineName, "steps", file);
}

/** A pipeline-manager spawn — the run anchor. */
function managerPrePayload(opts: {
  iter: string;
  subagentType?: string;
  transcriptPath?: string;
  sessionId?: string;
  toolUseId?: string;
  withRunIdLine?: string;
}): Record<string, unknown> {
  const runLine = opts.withRunIdLine ? `\nrun_id = ${opts.withRunIdLine}\n` : "";
  return {
    hook_event_name: "PreToolUse",
    tool_name: "Task",
    tool_input: {
      subagent_type: opts.subagentType ?? "pipeline-manager",
      prompt: `Orchestrate this pipeline run.${runLine}\ncurrent_iteration = ${opts.iter}\n`,
    },
    tool_use_id: opts.toolUseId ?? "toolu_pre_001",
    ...(opts.transcriptPath !== undefined ? { transcript_path: opts.transcriptPath } : {}),
    ...(opts.sessionId !== undefined ? { session_id: opts.sessionId } : {}),
  };
}

function managerPostPayload(opts: {
  iter: string;
  subagentType?: string;
  isError?: boolean;
  toolUseId?: string;
  transcriptPath?: string;
  sessionId?: string;
}): Record<string, unknown> {
  return {
    hook_event_name: "PostToolUse",
    tool_name: "Task",
    tool_input: {
      subagent_type: opts.subagentType ?? "pipeline-manager",
      prompt: `Orchestrate this pipeline run.\ncurrent_iteration = ${opts.iter}\n`,
    },
    tool_response: opts.isError ? { is_error: true } : { content: "ok" },
    tool_use_id: opts.toolUseId ?? "toolu_pre_001",
    ...(opts.transcriptPath !== undefined ? { transcript_path: opts.transcriptPath } : {}),
    ...(opts.sessionId !== undefined ? { session_id: opts.sessionId } : {}),
  };
}

/** `ver` — bits 48–51, the high nibble of byte 6 (the first char of a
 *  canonical UUID's third dash-group). Mirrors apps/pipeline-cli's
 *  tests/ids.test.ts decoder — duplicated here (not imported) because it is
 *  test-only decode logic, not product code. */
function versionNibbleOf(uuid: string): number {
  return Number.parseInt(uuid.slice(14, 16), 16) >>> 4;
}

/** `var` — bits 64–65, the top two bits of byte 8 (the first char of a
 *  canonical UUID's fourth dash-group). RFC variant is `0b10`. */
function variantBitsOf(uuid: string): number {
  return Number.parseInt(uuid.slice(19, 21), 16) >>> 6;
}

describe("bypassRunIdFromToolUseId", () => {
  // ux-v2 b2: this now derives via `hookIdFromToolUseId` (RFC 9562 §5.5
  // UUIDv5 over tool_use_id, apps/pipeline-cli/src/lib/ids.ts) instead of a
  // 12-hex sha1 slice — canonical 36-char UUID, version nibble 5. See
  // apps/pipeline-cli/tests/hook-bypass-id-determinism.test.ts for the
  // cross-PROCESS version of the determinism check below (the one that
  // would actually catch a regression to `newId()`).
  test("is deterministic for the same tool_use_id", () => {
    const a = bypassRunIdFromToolUseId("toolu_abc123");
    const b = bypassRunIdFromToolUseId("toolu_abc123");
    expect(a).toBe(b);
    expect(a).toHaveLength(36);
    expect(versionNibbleOf(a)).toBe(0b0101);
    expect(variantBitsOf(a)).toBe(0b10);
  });

  test("differs for different tool_use_ids", () => {
    expect(bypassRunIdFromToolUseId("toolu_a")).not.toBe(bypassRunIdFromToolUseId("toolu_b"));
  });

  test("falls back to a random UUIDv7 (newId()) when tool_use_id is null/empty", () => {
    const a = bypassRunIdFromToolUseId(null);
    const b = bypassRunIdFromToolUseId(null);
    expect(a).toHaveLength(36);
    expect(b).toHaveLength(36);
    expect(versionNibbleOf(a)).toBe(0b0111);
    expect(variantBitsOf(a)).toBe(0b10);
    expect(a).not.toBe(b);
  });
});

describe("handlePreToolUse — manager (run anchor)", () => {
  test("Path-C manager: bypass-spawn binding + START half (pipeline.started only)", () => {
    const iter = iterationPath("demo");
    handlePreToolUse(
      managerPrePayload({
        iter,
        transcriptPath: "/tmp/session.jsonl",
        sessionId: "session-pre",
        toolUseId: "toolu_pre_abc",
      }),
      projectRoot,
      null,
    );
    const bindings = readBindings();
    expect(bindings).toHaveLength(1);
    const b = bindings[0];
    expect(b.kind).toBe("bypass-spawn");
    expect(b.tool_use_id).toBe("toolu_pre_abc");
    expect(b.session_id).toBe("session-pre");
    expect(b.transcript_path).toBe("/tmp/session.jsonl");
    expect(b.iteration_path).toBe(iter);
    expect(b.schema).toBe(MIRROR_BINDING_SCHEMA);
    expect(b.run_id).toBe(bypassRunIdFromToolUseId("toolu_pre_abc"));
    // START half: pipeline.started ONLY (no iteration.started — the manager
    // self-emits those). The END half is emitted by PostToolUse on return.
    const events = readEventTypes();
    expect(events.map((e) => e.type)).toEqual(["pipeline.started"]);
    expect(events[0].run_id).toBe(bypassRunIdFromToolUseId("toolu_pre_abc"));
  });

  test("Path-B manager (literal run_id in prompt): no lifecycle, chain-controller binding", () => {
    const iter = iterationPath("demo");
    const supervisorRun = "abcdef012345";
    handlePreToolUse(
      managerPrePayload({ iter, withRunIdLine: supervisorRun, toolUseId: "toolu_chain_pre" }),
      projectRoot,
      null,
    );
    // No synthesized lifecycle — the supervisor owns it.
    expect(readEventTypes()).toHaveLength(0);
    const bindings = readBindings();
    expect(bindings).toHaveLength(1);
    expect(bindings[0].kind).toBe("chain-controller");
    expect(bindings[0].run_id).toBe(supervisorRun);
  });

  test("Path-B manager (journal pipeline.started): uses existing run_id, no synthesis", () => {
    const iter = iterationPath("demo");
    const existingRunId = "feedfacedead";
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
    handlePreToolUse(
      managerPrePayload({ iter, toolUseId: "toolu_chain_pre2" }),
      projectRoot,
      null,
    );
    // Only the pre-seeded pipeline.started remains.
    const events = readEventTypes();
    expect(events).toHaveLength(1);
    expect(events[0].run_id).toBe(existingRunId);
    const bindings = readBindings();
    expect(bindings).toHaveLength(1);
    expect(bindings[0].kind).toBe("chain-controller");
    expect(bindings[0].run_id).toBe(existingRunId);
  });
});

describe("handlePreToolUse — worker (mirror-bind only, never a run anchor)", () => {
  test("worker spawn with an owning run in the journal: chain-controller binding, NO lifecycle", () => {
    const iter02 = iterationPath("demo", "02-extract.md");
    const ownedRun = "chainowned02";
    // The manager emitted iteration.started for step 02 before spawning the
    // worker — this proves ownership.
    writeFileSync(
      eventsPath,
      JSON.stringify({
        schema: 3,
        ts: new Date(Date.now() - 1_000).toISOString(),
        type: "iteration.started",
        project_root: projectRoot,
        worktree: null,
        run_id: ownedRun,
        parent_run_id: null,
        session_id: null,
        data: { iteration_path: iter02, index: 2, resolved_model: null },
      }) + "\n",
      "utf-8",
    );
    handlePreToolUse(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Task",
        tool_input: {
          subagent_type: "step-executor",
          prompt: `Execute pipeline iteration: ${iter02}`,
        },
        tool_use_id: "toolu_worker_step2",
      },
      projectRoot,
      null,
    );
    // Worker binds under the owning run — NO new lifecycle event.
    const events = readEventTypes();
    expect(events).toHaveLength(1); // just the pre-seeded iteration.started
    expect(events[0].type).toBe("iteration.started");
    const bindings = readBindings();
    expect(bindings).toHaveLength(1);
    expect(bindings[0].kind).toBe("chain-controller");
    expect(bindings[0].run_id).toBe(ownedRun);
    expect(bindings[0].iteration_path).toBe(iter02);
  });

  test("worker spawn with no resolvable run: skips the binding (no phantom run)", () => {
    const iter = iterationPath("demo");
    handlePreToolUse(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Task",
        tool_input: {
          subagent_type: "step-executor",
          prompt: `Execute pipeline iteration: ${iter}`,
        },
        tool_use_id: "toolu_worker_orphan",
      },
      projectRoot,
      null,
    );
    // No owning run resolvable → no binding, and certainly no synthesized run.
    expect(readBindings()).toHaveLength(0);
    expect(readEventTypes()).toHaveLength(0);
  });

  test("legacy worker name (pipeline-executor) is still tolerated for binding", () => {
    const iter = iterationPath("demo");
    const ownedRun = "legacyowned1";
    writeFileSync(
      eventsPath,
      JSON.stringify({
        schema: 3,
        ts: new Date().toISOString(),
        type: "iteration.started",
        project_root: projectRoot,
        worktree: null,
        run_id: ownedRun,
        parent_run_id: null,
        session_id: null,
        data: { iteration_path: iter, index: 1, resolved_model: null },
      }) + "\n",
      "utf-8",
    );
    handlePreToolUse(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Task",
        tool_input: {
          subagent_type: "pipeline-executor",
          prompt: `Execute pipeline iteration: ${iter}`,
        },
        tool_use_id: "toolu_legacy_worker",
      },
      projectRoot,
      null,
    );
    const bindings = readBindings();
    expect(bindings).toHaveLength(1);
    expect(bindings[0].run_id).toBe(ownedRun);
  });

  test("non-pipeline subagent → no binding", () => {
    handlePreToolUse(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Task",
        tool_input: {
          subagent_type: "general-purpose",
          prompt: `Execute pipeline iteration: ${iterationPath("demo")}`,
        },
        tool_use_id: "toolu_general",
      },
      projectRoot,
      null,
    );
    expect(existsSync(bindingsPath)).toBe(false);
  });

  test("Read tool (not Agent) → no binding", () => {
    handlePreToolUse(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: "/x" },
        tool_use_id: "toolu_read",
      },
      projectRoot,
      null,
    );
    expect(existsSync(bindingsPath)).toBe(false);
  });
});

describe("PreToolUse + PostToolUse correlation (manager anchor)", () => {
  test("Pre then Post for the SAME tool_use_id share run_id", () => {
    const iter = iterationPath("demo");
    const toolUseId = "toolu_correlated_xyz";
    handlePreToolUse(managerPrePayload({ iter, toolUseId }), projectRoot, null);
    handlePostToolUse(managerPostPayload({ iter, toolUseId }), projectRoot, null);
    const bindings = readBindings();
    // PreToolUse writes 1 bound, PostToolUse writes 1 bound + 1 terminal.
    expect(bindings).toHaveLength(3);
    const bounds = bindings.filter((b) => b.event === "bound");
    expect(bounds).toHaveLength(2);
    expect(bounds[0].run_id).toBe(bounds[1].run_id);
    const events = readEventTypes();
    expect(events.some((e) => e.type === "pipeline.started" && e.run_id === bindings[0].run_id)).toBe(true);
    expect(events.some((e) => e.type === "pipeline.completed" && e.run_id === bindings[0].run_id)).toBe(true);
  });

  test("split lifecycle: Pre emits START half, Post emits END half (one run, no dup)", () => {
    const iter = iterationPath("demo");
    const toolUseId = "toolu_split_flow";
    const runId = bypassRunIdFromToolUseId(toolUseId);

    handlePreToolUse(
      managerPrePayload({ iter, subagentType: "pipeline:pipeline-manager", toolUseId }),
      projectRoot,
      null,
    );
    // After PreToolUse: run is ACTIVE (started, no completion yet). RUN-LEVEL
    // only — exactly one pipeline.started, no iteration.started.
    let events = readEventTypes();
    expect(events.map((e) => e.type)).toEqual(["pipeline.started"]);

    handlePostToolUse(
      managerPostPayload({ iter, subagentType: "pipeline:pipeline-manager", toolUseId }),
      projectRoot,
      null,
    );
    events = readEventTypes();
    // Exactly one of each lifecycle event — no duplicate pipeline.started, and
    // NO iteration.* — plus the tool.called from PostToolUse.
    expect(events.map((e) => e.type)).toEqual([
      "pipeline.started",
      "tool.called",
      "pipeline.completed",
    ]);
    for (const e of events) expect(e.run_id).toBe(runId);
    // Lifecycle ordering is monotone by timestamp (START before END).
    const full = readFileSync(eventsPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { ts: string; type: string });
    const started = full.find((e) => e.type === "pipeline.started")!.ts;
    const completed = full.find((e) => e.type === "pipeline.completed")!.ts;
    expect(started <= completed).toBe(true);
  });

  test("Post-only (no Pre, e.g. older Claude Code) still works — fallback synthesis", () => {
    const iter = iterationPath("demo");
    handlePostToolUse(
      managerPostPayload({ iter, toolUseId: "toolu_post_only" }),
      projectRoot,
      null,
    );
    // PostToolUse-only path: 1 bound + 1 terminal record.
    expect(readBindings()).toHaveLength(2);
    const events = readEventTypes();
    // tool.called + 2 RUN-level lifecycle = 3 (no iteration.*).
    expect(events.length).toBe(3);
    expect(events.map((e) => e.type)).toEqual([
      "tool.called",
      "pipeline.started",
      "pipeline.completed",
    ]);
  });
});
