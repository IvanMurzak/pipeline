/**
 * PIPELINE_JOURNAL_TRANSCRIPTS — the transcript opt-out split.
 *
 *   bun test tests/transcript-opt-out.test.ts
 *
 * A separate, backward-compatible switch that gates ONLY the privacy-sensitive
 * transcript work: the transcript POINTER recorded on a mirror binding (which
 * is what makes a session's transcript reachable by anything downstream) and
 * the Stop hook's transcript token tail (analytics_relay.ts handleStop). It is
 * orthogonal to the MASTER switch PIPELINE_JOURNAL_ENABLED and to
 * PIPELINE_STATS_ENABLED.
 *
 * Semantics matrix under test:
 *   • both unset (default)                    → FULL (unchanged behaviour)
 *   • PIPELINE_JOURNAL_TRANSCRIPTS=0, master on    → basic lifecycle events + run
 *                                               correlation stay; NO transcript
 *                                               pointer on the binding, NO
 *                                               turn.usage tail
 *   • PIPELINE_JOURNAL_ENABLED=0 (master off)      → the hook no-ops entirely
 *
 * The local dashboard's MirrorService — the third consumer this switch used to
 * gate, which copied transcript content into a browser chat panel — is deleted
 * (plugin-thin `p3`), and its section of this file went with it. The switch
 * itself is untouched: the pointer it withholds is what the surviving readers
 * key off, and `pipeline logs --chat` reads a transcript the user already owns
 * on their own disk, on demand, with no pointer involved.
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
  handlePreToolUse,
  handleStop,
  journalEnabled,
  journalTranscriptsEnabled as hookTranscriptsEnabled,
} from "../../../hooks/analytics_relay.ts";
import { journalTranscriptsEnabled as cliTranscriptsEnabled } from "../src/lib/event.ts";

const HOOK_PATH = join(import.meta.dir, "..", "..", "..", "hooks", "analytics_relay.ts");

// --------------------------------------------------------------------
// 1. Reader parse — three-way, default ON, for BOTH surviving copies of
//    the reader (the standalone hook copy + the CLI's in lib/event.ts,
//    which `pipeline event register-mirror-binding` and `pipeline drive`
//    both go through). The daemon's third copy died with the dashboard.
// --------------------------------------------------------------------

describe("journalTranscriptsEnabled — three-way parse (default ON)", () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.PIPELINE_JOURNAL_TRANSCRIPTS;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.PIPELINE_JOURNAL_TRANSCRIPTS;
    else process.env.PIPELINE_JOURNAL_TRANSCRIPTS = prev;
  });

  const readers: Array<[string, () => boolean]> = [
    ["hook", hookTranscriptsEnabled],
    ["cli", cliTranscriptsEnabled],
  ];

  for (const [label, reader] of readers) {
    test(`${label}: unset → ON`, () => {
      delete process.env.PIPELINE_JOURNAL_TRANSCRIPTS;
      expect(reader()).toBe(true);
    });
    test(`${label}: empty → ON`, () => {
      process.env.PIPELINE_JOURNAL_TRANSCRIPTS = "";
      expect(reader()).toBe(true);
    });
    test(`${label}: unrelated value (e.g. "1"/"yes") → ON`, () => {
      process.env.PIPELINE_JOURNAL_TRANSCRIPTS = "1";
      expect(reader()).toBe(true);
      process.env.PIPELINE_JOURNAL_TRANSCRIPTS = "yes";
      expect(reader()).toBe(true);
    });
    for (const falsy of ["0", "false", "no", "off", "OFF", " Off "]) {
      test(`${label}: ${JSON.stringify(falsy)} → OFF`, () => {
        process.env.PIPELINE_JOURNAL_TRANSCRIPTS = falsy;
        expect(reader()).toBe(false);
      });
    }
  }

  test("master reader (PIPELINE_JOURNAL_ENABLED) is independent and also default-ON", () => {
    const prevMaster = process.env.PIPELINE_JOURNAL_ENABLED;
    try {
      delete process.env.PIPELINE_JOURNAL_ENABLED;
      expect(journalEnabled()).toBe(true);
      process.env.PIPELINE_JOURNAL_ENABLED = "0";
      expect(journalEnabled()).toBe(false);
    } finally {
      if (prevMaster === undefined) delete process.env.PIPELINE_JOURNAL_ENABLED;
      else process.env.PIPELINE_JOURNAL_ENABLED = prevMaster;
    }
  });
});

// --------------------------------------------------------------------
// 2. Hook handlers — the "just-transcripts" split (master stays ON).
// --------------------------------------------------------------------

interface Binding {
  event: string;
  run_id: string;
  session_id: string | null;
  transcript_path: string | null;
  kind: string;
}

describe("hook: PIPELINE_JOURNAL_TRANSCRIPTS gates ONLY transcript work", () => {
  let tmpRoot: string;
  let homeDir: string;
  let projectRoot: string;
  let eventsPath: string;
  let bindingsPath: string;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;
  let prevTranscripts: string | undefined;
  let prevMaster: string | undefined;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "pp-transcripts-"));
  });
  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpRoot, "home-"));
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    prevTranscripts = process.env.PIPELINE_JOURNAL_TRANSCRIPTS;
    prevMaster = process.env.PIPELINE_JOURNAL_ENABLED;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    // These handler-level tests run with the MASTER switch ON (default); the
    // handlers themselves never consult it (main() does), so we assert the
    // transcript switch in isolation.
    delete process.env.PIPELINE_JOURNAL_ENABLED;
    projectRoot = mkdtempSync(join(tmpRoot, "proj-"));
    mkdirSync(join(projectRoot, ".pipeline", ".runtime"), { recursive: true });
    eventsPath = join(projectRoot, ".pipeline", ".runtime", "events.jsonl");
    bindingsPath = join(homeDir, ".claude", "pipeline-ui", "active-mirror-bindings.jsonl");
  });

  afterEach(() => {
    const restore = (k: string, v: string | undefined) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };
    restore("HOME", prevHome);
    restore("USERPROFILE", prevUserProfile);
    restore("PIPELINE_JOURNAL_TRANSCRIPTS", prevTranscripts);
    restore("PIPELINE_JOURNAL_ENABLED", prevMaster);
  });

  function readBindings(): Binding[] {
    if (!existsSync(bindingsPath)) return [];
    return readFileSync(bindingsPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Binding);
  }

  function readEventTypes(): string[] {
    if (!existsSync(eventsPath)) return [];
    return readFileSync(eventsPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => (JSON.parse(l) as { type: string }).type);
  }

  function managerPre(transcriptPath: string): Record<string, unknown> {
    const iter = join(projectRoot, ".pipeline", "demo", "steps", "01-x.md");
    return {
      hook_event_name: "PreToolUse",
      tool_name: "Task",
      tool_input: {
        subagent_type: "pipeline-manager",
        prompt: `Orchestrate this pipeline run.\ncurrent_iteration = ${iter}\n`,
      },
      tool_use_id: "toolu_split_1",
      transcript_path: transcriptPath,
      session_id: "sess-split",
    };
  }

  /** A main-session transcript carrying one assistant turn with usage — what
   *  the Stop handler tails to emit turn.usage. */
  function writeUsageTranscript(): string {
    const p = join(homeDir, "session.jsonl");
    writeFileSync(
      p,
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", usage: { input_tokens: 20, output_tokens: 7 } },
      }) + "\n",
      "utf-8",
    );
    return p;
  }

  test("DEFAULT (unset): binding carries the transcript pointer + Stop emits turn.usage", () => {
    delete process.env.PIPELINE_JOURNAL_TRANSCRIPTS;
    const transcript = writeUsageTranscript();

    handlePreToolUse(managerPre("/tmp/session-abc.jsonl"), projectRoot, null);
    const bindings = readBindings();
    expect(bindings).toHaveLength(1);
    expect(bindings[0].transcript_path).toBe("/tmp/session-abc.jsonl");
    // Basic lifecycle still present (Path-C START half).
    expect(readEventTypes()).toContain("pipeline.started");

    handleStop({ hook_event_name: "Stop", transcript_path: transcript, session_id: "sess-split" }, projectRoot, null);
    expect(readEventTypes()).toContain("turn.usage");
  });

  test("PIPELINE_JOURNAL_TRANSCRIPTS=0: basic events survive, pointer nulled, NO turn.usage", () => {
    process.env.PIPELINE_JOURNAL_TRANSCRIPTS = "0";
    const transcript = writeUsageTranscript();

    handlePreToolUse(managerPre("/tmp/session-abc.jsonl"), projectRoot, null);
    const bindings = readBindings();
    // The binding is STILL written (run correlation preserved) …
    expect(bindings).toHaveLength(1);
    expect(bindings[0].run_id).toBeTruthy();
    expect(bindings[0].session_id).toBe("sess-split");
    // … but the transcript pointer is withheld, so nothing downstream can
    // reach that session's transcript from the binding.
    expect(bindings[0].transcript_path).toBeNull();
    // Basic lifecycle event is untouched by the transcript switch.
    expect(readEventTypes()).toContain("pipeline.started");

    // The Stop token tail never runs — no transcript read, no turn.usage.
    handleStop({ hook_event_name: "Stop", transcript_path: transcript, session_id: "sess-split" }, projectRoot, null);
    expect(readEventTypes()).not.toContain("turn.usage");
  });
});

// --------------------------------------------------------------------
// 3. Master switch PIPELINE_JOURNAL_ENABLED=0 → the hook no-ops entirely
//    (all-off). Driven end-to-end through the hook's stdin entry point.
// --------------------------------------------------------------------

describe("hook master switch PIPELINE_JOURNAL_ENABLED=0 → all off", () => {
  let tmpRoot: string;
  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "pp-master-"));
  });
  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function makeProject(): { projectRoot: string; homeDir: string; eventsPath: string; bindingsPath: string } {
    const projectRoot = mkdtempSync(join(tmpRoot, "proj-"));
    const homeDir = mkdtempSync(join(tmpRoot, "home-"));
    mkdirSync(join(projectRoot, ".pipeline", ".runtime"), { recursive: true });
    return {
      projectRoot,
      homeDir,
      eventsPath: join(projectRoot, ".pipeline", ".runtime", "events.jsonl"),
      bindingsPath: join(homeDir, ".claude", "pipeline-ui", "active-mirror-bindings.jsonl"),
    };
  }

  async function runHook(cwd: string, homeDir: string, master: string): Promise<void> {
    const payload = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_response: { content: "ok" },
      tool_use_id: "toolu_master",
      session_id: "sess-master",
    });
    const proc = Bun.spawn({
      cmd: [process.execPath, HOOK_PATH],
      cwd,
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        PIPELINE_JOURNAL_ENABLED: master,
        PIPELINE_JOURNAL_DEBUG: "0",
      },
      stdin: new Blob([payload]),
      stdout: "ignore",
      stderr: "ignore",
    });
    await proc.exited;
  }

  test("baseline (master ON) writes a tool.called event", async () => {
    const { projectRoot, homeDir, eventsPath } = makeProject();
    await runHook(projectRoot, homeDir, "1");
    expect(existsSync(eventsPath)).toBe(true);
    const types = readFileSync(eventsPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => (JSON.parse(l) as { type: string }).type);
    expect(types).toContain("tool.called");
  });

  test("master OFF writes NO events and NO bindings", async () => {
    const { projectRoot, homeDir, eventsPath, bindingsPath } = makeProject();
    await runHook(projectRoot, homeDir, "0");
    // No events journal, no mirror bindings — the hook short-circuited at the
    // master gate before touching anything.
    const events = existsSync(eventsPath)
      ? readFileSync(eventsPath, "utf-8").split("\n").filter((l) => l.trim())
      : [];
    expect(events).toHaveLength(0);
    expect(existsSync(bindingsPath)).toBe(false);
  });
});
