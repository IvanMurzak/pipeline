// Tests for the VENDORED privacy filter (src/lib/vendor/privacy.ts) — see
// that file's header for what it is and why it exists (ux-v2 interim: the
// CLI ships with zero dependencies and no install step reachable from a
// plugin skill, so the filter travels as a commented copy of
// pipeline-runner's shipper/privacy.ts rather than an import).
//
// This is THE privacy contract for anything that later ships journal events
// or stats records off this machine: nothing in this package currently CALLS
// this filter (it is vendored, not wired in — see the source header), but
// the filter itself must already be trustworthy before any caller is added.
// Deliberately self-contained (no cross-repo import of pipeline-runner's own
// tests/_shipper-helpers.ts — the whole point of vendoring is that this
// package cannot reach outside itself at runtime, and its tests shouldn't
// either) — mirrors the SHAPE of pipeline-runner's tests/shipper-privacy.test.ts
// without depending on it.
//
// ── WHAT ux-v2 `b23` CHANGED HERE, AND WHY ─────────────────────────────────
//
// This suite was VACUOUS for the `keep`-classified path fields, in the exact
// way that let the SG4 defect live in production for three weeks. Two habits
// did it, and both are corrected below rather than deleted, because each was
// testing something real:
//
//   1. absolute paths were only ever planted in fields the filter ALREADY
//      fingerprints, so the "absolute machine paths become fingerprints" test
//      proved the `fingerprint` rule and said nothing about `keep`;
//   2. `iteration_path` was planted as an ALREADY-RELATIVE
//      `'steps/03-review.md'` and asserted to SURVIVE. Correct, and kept — but
//      on its own it encoded the filter's false assumption (that the emitter
//      hands it relative paths) as the contract.
//
// `b22` recorded the gap here as a deliberate tripwire test, pinned to go RED
// the moment upstream shipped. Upstream is `b23`, it shipped, and that test is
// deleted along with the CLI-side composition it pointed at — one without the
// other would leave two rules where there should be one. In its place each path
// value is planted BOTH ways, and the rule itself gets its own section at the
// bottom of this file.

import { describe, expect, test } from 'bun:test';
import { userInfo } from 'node:os';
import {
  collectPathRoots,
  defaultAccountNames,
  looksAbsolutePath,
  scrubPathString,
  SG4_PATH_RE,
  DEFAULT_PRIVACY_TIER,
  fingerprintString,
  filterEventForTier,
  filterStatsRecordMetadata,
  MESSAGE_PARTS_PLACEHOLDER,
  PRIVACY_TIER_ENV,
  QUESTION_PLACEHOLDER,
  resolvePrivacyTier,
  STEP_IDENTITY_FIELD,
  STEP_SCOPED_EVENT_TYPES,
  stepShapedAllowlistViolations,
  stripStatsFailureExcerpts,
  SUMMARY_MAX_CHARS,
} from '../src/lib/vendor/privacy';

/** A real CLI-minted step identity (`b4`): UUIDv7, version nibble `7`. */
const STEP_UUID = '019fded9-3a7c-7c31-9f0e-2b5a1d4e8c60';

/** The same journal-event envelope shape pipeline-runner's shipper reads —
 *  local factory so this test file needs nothing outside this package. */
function journalEvent(
  type: string,
  runId: string | null,
  data: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema: 4,
    ts: '2026-08-02T12:00:00.000Z',
    type,
    project_root: 'C:/Users/ivan/very-secret-client-project',
    worktree: null,
    run_id: runId,
    parent_run_id: null,
    session_id: 'sess-1',
    data,
    ...extra,
  };
}

// A record stuffed with prompt-like text, absolute paths, tool arguments,
// and error excerpts — the privacy contract's entire job is that NONE of
// these values survive the metadata-tier filter, anywhere.
const SECRETS = {
  questionText: 'SECRET_QUESTION_should-we-deploy-the-payment-hotfix',
  questionContext: 'SECRET_CONTEXT_the-diff-touches-billing.ts-lines-40-90',
  questionOption: 'SECRET_OPTION_deploy-to-prod-now',
  promptText: 'SECRET_PROMPT_full-step-instructions-with-code',
  responseText: 'SECRET_RESPONSE_assistant-transcript-chunk',
  messageText: 'SECRET_MESSAGE_free-text-from-a-newer-emitter',
  fileContent: 'SECRET_FILE_CONTENT_api-key=sk-live-123',
  toolArgs: 'SECRET_TOOL_ARGS_rm -rf /var/secrets --force',
  toolOutput: 'SECRET_TOOL_OUTPUT_stdout-dump-with-customer-data',
  errorExcerpt: 'SECRET_ERROR_EXCERPT_stack-trace-with-code-and-paths',
  hookDetail: 'SECRET_HOOK_STDERR_dump-with-paths-and-code',
  envelopeExtra: 'SECRET_ENVELOPE_note-field-added-by-newer-peer',
  unknownTypePayload: 'SECRET_UNKNOWN_TYPE_chat-message-body',
  departmentMessage: 'SECRET_DEPARTMENT_MESSAGE_task-content',
  projectRoot: 'C:/Users/ivan/very-secret-client-project',
  worktreePath: 'C:/Users/ivan/very-secret-client-project/.worktrees/run-1',
  // `b23`: absolute paths in `keep`-CLASSIFIED fields — the disposition this
  // file never planted one in. One under the run's own project root (which must
  // come back as the relative remainder) and one under no root at all (which
  // must fail closed to a fingerprint).
  keepFieldPathInRoot: 'C:/Users/ivan/very-secret-client-project/.pipeline/release/steps/03-review.md',
  keepFieldPathOffRoot: 'C:/Users/ivan/Documents/another-client/hand-off.md',
} as const;

describe('vendored privacy filter — metadata tier is the trust boundary', () => {
  test('a record stuffed with prompt-like text, absolute paths, tool arguments and error excerpts carries NONE of them at metadata tier', () => {
    const events: Record<string, unknown>[] = [
      // Prompt-like text: the needs-input question (text/context/options).
      journalEvent('awaiting_input', 'r1', {
        run_id: 'r1',
        iteration: 3,
        question_id: 'q-77',
        question: {
          text: SECRETS.questionText,
          context: SECRETS.questionContext,
          options: [SECRETS.questionOption],
        },
      }),
      // Prompt/response/message/file-content passthrough on a KNOWN type —
      // fields the allowlist for this type does not name.
      // `b23`: ABSOLUTE paths in the two `keep`-classified fields whose
      // verbatim copy is the SG4 defect i1 found in production.
      journalEvent('iteration.completed', 'r1', {
        iteration_path: SECRETS.keepFieldPathInRoot,
        outcome: 'completed',
        next_iteration_path: SECRETS.keepFieldPathOffRoot,
        prompt: SECRETS.promptText,
        response: SECRETS.responseText,
        message: SECRETS.messageText,
        file_content: SECRETS.fileContent,
      }),
      // Tool arguments and output on tool.called — NOT in that type's
      // allowlist (only tool_name/success/agent_spawn/tool_use_id are).
      journalEvent('tool.called', 'r1', {
        tool_name: 'Bash',
        success: true,
        agent_spawn: false,
        tool_use_id: 't-1',
        args: SECRETS.toolArgs,
        output: SECRETS.toolOutput,
      }),
      // An entirely UNKNOWN event type: data must be stripped wholesale.
      journalEvent('chat.message', 'r1', { body: SECRETS.unknownTypePayload }),
      // Envelope-level passthrough addition (a newer peer's extra field).
      journalEvent('run.started', 'r1', { pipeline_name: 'release', pipeline_root: SECRETS.worktreePath }, { note: SECRETS.envelopeExtra }),
      // Free-text hook stderr on a worktree event: dropped (not a FAIL summary).
      journalEvent('worktree.created', 'r1', { ok: false, detail: SECRETS.hookDetail, worktree_path: SECRETS.worktreePath }),
      // A department message: task content, not telemetry.
      journalEvent('department.message', 'r1', { parts: [{ text: SECRETS.departmentMessage, media_type: 'text/plain' }] }),
      // `b23`: the same field with an ALREADY-RELATIVE value, which must
      // survive untouched. Both halves are the contract; only this one was ever
      // planted, and only the other one was ever asserted.
      journalEvent('iteration.started', 'r1', { iteration_path: 'steps/03-review.md', index: 3 }),
    ];

    const filtered = events.map((event) => filterEventForTier(event, 'metadata'));
    const wire = JSON.stringify(filtered);

    for (const secret of Object.values(SECRETS)) {
      expect(wire).not.toContain(secret);
    }

    // …while the metadata the product actually runs on survives.
    const [awaiting, completed, tool, unknown, started] = filtered as Array<Record<string, unknown>>;
    expect(awaiting.run_id).toBe('r1');
    expect((awaiting.data as Record<string, unknown>).question_id).toBe('q-77');
    expect((awaiting.data as Record<string, unknown>).iteration).toBe(3);
    expect((awaiting.data as Record<string, unknown>).question).toEqual({ text: QUESTION_PLACEHOLDER });
    expect((completed.data as Record<string, unknown>).outcome).toBe('completed');
    // `b23`: the step is STILL NAMED — relative to the run's own root. The fix
    // is not "ship nothing".
    expect((completed.data as Record<string, unknown>).iteration_path).toBe(
      '.pipeline/release/steps/03-review.md',
    );
    // …and the one under no known root fails CLOSED rather than shipping raw.
    expect((completed.data as Record<string, unknown>).next_iteration_path).toMatch(
      /^fp:[0-9a-f]{16}$/,
    );
    // An already-relative value is untouched.
    expect(
      ((filtered[7] as Record<string, unknown>).data as Record<string, unknown>).iteration_path,
    ).toBe('steps/03-review.md');
    expect((tool.data as Record<string, unknown>).tool_name).toBe('Bash');
    expect((tool.data as Record<string, unknown>).success).toBe(true);
    expect((tool.data as Record<string, unknown>)).not.toHaveProperty('args');
    expect((tool.data as Record<string, unknown>)).not.toHaveProperty('output');
    expect(unknown.type).toBe('chat.message');
    expect(unknown.data).toEqual({}); // unknown type: stripped, never leaked
    expect((started.data as Record<string, unknown>).pipeline_name).toBe('release');
    expect(started.note).toBeUndefined(); // envelope-level passthrough dropped
  });

  test('absolute machine paths become deterministic, salt-hardened fingerprints — never the raw path', () => {
    const event = journalEvent('run.started', 'r1', {
      pipeline_name: 'release',
      pipeline_root: SECRETS.worktreePath,
      // `b23`: a `keep`-classified path field in the SAME payload. Same filter,
      // two dispositions, and only one of them was ever looked at — which is
      // precisely why a spot check passed.
      first_iteration_path: SECRETS.keepFieldPathInRoot,
    });
    const a = filterEventForTier(event, 'metadata') as Record<string, unknown>;
    const b = filterEventForTier(event, 'metadata') as Record<string, unknown>;
    expect(a.project_root).not.toBe(SECRETS.projectRoot);
    expect(a.project_root).toMatch(/^fp:[0-9a-f]{16}$/);
    expect(a.project_root).toBe(b.project_root); // deterministic — correlates across events
    const pipelineRoot = (a.data as Record<string, unknown>).pipeline_root as string;
    expect(pipelineRoot).not.toBe(SECRETS.worktreePath);
    expect(pipelineRoot).toMatch(/^fp:[0-9a-f]{16}$/);
    expect((a.data as Record<string, unknown>).first_iteration_path).toBe(
      '.pipeline/release/steps/03-review.md',
    );
    expect(JSON.stringify(a)).not.toContain(SECRETS.keepFieldPathInRoot);
    // Null worktree passes through as null (parseable envelope) — not stripped, not faked.
    expect(a.worktree).toBeNull();
    // A salt changes the fingerprint (hardening against dictionary attacks on guessable paths).
    const salted = filterEventForTier(event, 'metadata', { fingerprintSalt: 's1' }) as Record<string, unknown>;
    expect(salted.project_root).not.toBe(a.project_root);
    expect(fingerprintString('x', 'a')).not.toBe(fingerprintString('x', 'b'));
  });

  test('error excerpts inside a stats record are stripped by stripStatsFailureExcerpts AND absent from the metadata-tier allowlist', () => {
    const record: Record<string, unknown> = {
      run_id: 'r1',
      pipeline: 'workflows/release',
      outcome: 'halted',
      failures: [{ ts: '2026-08-02T12:00:00.000Z', tool: 'Bash', step: '02-build', error: SECRETS.errorExcerpt }],
    };
    // The G-sec-2 pre-strip (runs before spooling, at every tier).
    const preStripped = stripStatsFailureExcerpts(record);
    expect(JSON.stringify(preStripped)).not.toContain(SECRETS.errorExcerpt);
    expect((preStripped.failures as Array<Record<string, unknown>>)[0]).toEqual({
      ts: '2026-08-02T12:00:00.000Z',
      tool: 'Bash',
      step: '02-build',
    });
    // Belt-and-braces: even an UN-pre-stripped record loses the excerpt at
    // the metadata-tier allowlist, because 'error' is deliberately absent
    // from STATS_FAILURE_ALLOWLIST.
    const filtered = filterStatsRecordMetadata(record);
    expect(JSON.stringify(filtered)).not.toContain(SECRETS.errorExcerpt);
    expect((filtered.failures as Array<Record<string, unknown>>)[0]).toEqual({
      ts: '2026-08-02T12:00:00.000Z',
      tool: 'Bash',
      step: '02-build',
    });
  });

  test('halt_reason survives as a FAIL summary but is bounded to SUMMARY_MAX_CHARS', () => {
    const long = 'x'.repeat(SUMMARY_MAX_CHARS + 100);
    const event = journalEvent('pipeline.halted', 'r1', { pipeline_name: 'p', iteration_path: 's.md', halt_reason: long });
    const filtered = filterEventForTier(event, 'metadata') as Record<string, unknown>;
    const reason = (filtered.data as Record<string, unknown>).halt_reason as string;
    expect(reason.length).toBe(SUMMARY_MAX_CHARS + 1); // truncated + ellipsis
    expect(reason.startsWith('x'.repeat(SUMMARY_MAX_CHARS))).toBe(true);
    const nullEvent = journalEvent('run.halted', 'r1', { halt_reason: null });
    expect(((filterEventForTier(nullEvent, 'metadata') as Record<string, unknown>).data as Record<string, unknown>).halt_reason).toBeNull();
  });

  test('a department message keeps zero authored content — a schema-valid placeholder part, not the text', () => {
    const event = journalEvent('department.message', 'r1', {
      parts: [{ text: SECRETS.departmentMessage, media_type: 'text/plain' }],
    });
    const filtered = filterEventForTier(event, 'metadata') as Record<string, unknown>;
    expect((filtered.data as Record<string, unknown>).parts).toEqual([
      { text: MESSAGE_PARTS_PLACEHOLDER, media_type: 'text/plain' },
    ]);
  });

  test('numeric usage/count events pass complete at metadata — these ARE the measurement', () => {
    const usage = journalEvent('turn.usage', 'r1', {
      assistant_turns: 4,
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_tokens: 5000,
      cache_creation_tokens: 100,
    });
    const filtered = filterEventForTier(usage, 'metadata') as Record<string, unknown>;
    expect(filtered.data).toEqual({
      assistant_turns: 4,
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_tokens: 5000,
      cache_creation_tokens: 100,
    });
  });
});

describe('vendored privacy filter — tier ordering', () => {
  test('events/full pass the event verbatim (including content); metadata is a strict subset', () => {
    const event = journalEvent('awaiting_input', 'r1', {
      run_id: 'r1',
      iteration: 1,
      question_id: 'q1',
      question: { text: SECRETS.questionText },
    });
    for (const tier of ['events', 'full'] as const) {
      const filtered = filterEventForTier(event, tier);
      expect(filtered).toEqual(event);
      expect(JSON.stringify(filtered)).toContain(SECRETS.questionText);
    }
    const metadata = JSON.stringify(filterEventForTier(event, 'metadata'));
    expect(metadata).not.toContain(SECRETS.questionText);
  });
});

describe('vendored privacy filter — tier resolution (fail-closed)', () => {
  test('defaults to metadata', () => {
    expect(resolvePrivacyTier(undefined, {})).toEqual({ tier: 'metadata', warning: null });
    expect(DEFAULT_PRIVACY_TIER).toBe('metadata');
  });

  test('explicit config wins over env; both accept valid tiers', () => {
    expect(resolvePrivacyTier('events', { [PRIVACY_TIER_ENV]: 'full' }).tier).toBe('events');
    expect(resolvePrivacyTier(undefined, { [PRIVACY_TIER_ENV]: 'full' }).tier).toBe('full');
  });

  test('an unrecognized tier FAILS CLOSED to metadata with a warning — never to a more permissive tier', () => {
    const fromConfig = resolvePrivacyTier('everything', {});
    expect(fromConfig.tier).toBe('metadata');
    expect(fromConfig.warning).toContain("'everything'");
    const fromEnv = resolvePrivacyTier(undefined, { [PRIVACY_TIER_ENV]: 'debug' });
    expect(fromEnv.tier).toBe('metadata');
    expect(fromEnv.warning).toContain('failing closed');
  });
});

describe('vendored privacy filter — v5 step-key rename', () => {
  // `step_name` (v5) replaced `step_id` (v4) as the iteration events' step
  // identity. Both must survive the metadata tier: step identity is metadata
  // the product's per-step dashboards are built on. Allowlisting only the new
  // name would silently strip the identity out of every journal written before
  // the rename. (`b23`: a step NAME is a name, not a path — it is not
  // path-shaped and the SG4 scrub does not touch it. The step's PATH is covered
  // in the SG4 section at the bottom of this file.)
  // ux-v2 `b24` CORRECTED THIS TEST. It asserted the two NAME fields and
  // stopped there, so it passed green against a filter that was stripping the
  // step's ROW IDENTITY (`step_uuid`) off these same three events — the
  // omission that made the cloud write two rows per step. A conformance test
  // that enumerates an allowlist's fields by hand encodes whatever the
  // allowlist happened to contain when it was written; that is how it survived.
  test.each(['iteration.started', 'iteration.resumed', 'iteration.completed'])(
    '%s keeps step_name (v5), step_id (v4) AND step_uuid (b4 row identity)',
    (type) => {
      const event = journalEvent(type, 'r1', {
        iteration_path: 'steps/03-review.md',
        outcome: 'completed',
        step_name: 'review',
        step_id: 'review',
        step_uuid: STEP_UUID,
      });
      const data = (filterEventForTier(event, 'metadata') as { data: Record<string, unknown> }).data;
      expect(data.step_name).toBe('review');
      expect(data.step_id).toBe('review');
      expect(data.step_uuid).toBe(STEP_UUID);
    },
  );

  test('the step identity is still NOT a way to smuggle content through', () => {
    // `keep` is verbatim by design, so the guard is the allowlist itself: a
    // sibling field that merely LOOKS like step identity is dropped.
    const event = journalEvent('iteration.started', 'r1', {
      iteration_path: 'steps/01-a.md',
      step_name: 'a',
      step_description: SECRETS.promptText,
    });
    const data = (filterEventForTier(event, 'metadata') as { data: Record<string, unknown> }).data;
    expect(data.step_name).toBe('a');
    expect(data.step_description).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain(SECRETS.promptText);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SG4 — the RULE (ux-v2 `b23`; `07-security.md` §4.1 and gate SG4)
// ─────────────────────────────────────────────────────────────────────────────
//
// SG4 was violated in production from 2026-07-19 to 2026-08-07, and it survived
// because the leak is INCONSISTENT: the same step's `iteration.started` carried
// a relative `01-prepare.md` while its `iteration.completed`, eight seconds
// later in the same run, carried `C:\Users\<account>\…\steps\01-prepare.md`. A
// spot check finds the first and concludes the filter works.
//
// So this section tests the RULE — the shape of the value — not the two fields
// `i1` happened to observe. `b22` proved exactly this by COMPOSING a scrub over
// this filter at the CLI's seams; `b23` moved it INTO the filter, and these
// tests exercise the filter ALONE. That is the whole point: if the rule had
// merely been duplicated rather than moved, deleting the composition would turn
// this section red.

/** Every string leaf of a payload, with its dotted location — the same walk
 *  `scripts/i1-production-e2e/check-sg4.mjs:scanStrings` performs against the
 *  production rows. */
function stringLeaves(node: unknown, at = 'payload'): Array<[string, string]> {
  if (typeof node === 'string') return [[at, node]];
  if (Array.isArray(node)) return node.flatMap((v, i) => stringLeaves(v, `${at}[${i}]`));
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([k, v]) => stringLeaves(v, `${at}.${k}`));
  }
  return [];
}

/** The SG4 verdict on a payload, as `location -> value` findings. Returned
 *  rather than asserted so a failure NAMES the field and the value. */
function sg4Findings(payload: unknown): string[] {
  return stringLeaves(payload)
    .filter(([, v]) => SG4_PATH_RE.test(v))
    .map(([at, v]) => `${at} -> ${JSON.stringify(v.slice(0, 140))}`);
}

const SG4_SALT = 'test-salt-b23';
/** The user's home in each of the three absolute shapes, with a recognisable
 *  account name. Fixture values (not this machine's) so the sweep is
 *  deterministic; the live account gets its own test at the end. */
const WIN_ROOT = 'C:\\Users\\IvanD\\AppData\\Local\\Temp\\claude\\proj-i1-e2e';
const POSIX_ROOT = '/home/ivand/work/proj-i1-e2e';
const UNC_ROOT = '\\\\fileserver\\team\\ivand\\proj-i1-e2e';

function sg4Envelope(type: string, data: Record<string, unknown>): Record<string, unknown> {
  return {
    schema: 5,
    ts: '2026-08-07T10:58:39.207Z',
    type,
    project_root: WIN_ROOT,
    worktree: null,
    run_id: 'r1',
    parent_run_id: null,
    session_id: null,
    data,
  };
}

describe('vendored privacy filter — SG4: an absolute path never survives, whatever field carries it', () => {
  test('EVERY `keep`-classified path field is scrubbed — not just the two i1 saw', () => {
    // The full set of fields DATA_ALLOWLISTS maps to `keep` and whose value is
    // a path. Enumerated from the allowlist tables, not from the defect report:
    // fixing only `iteration_path`/`next_iteration_path` would leave the rest
    // leaking on day one.
    const cases: Array<[string, Record<string, unknown>]> = [
      ['iteration.started', { iteration_path: `${WIN_ROOT}\\.pipeline\\p\\steps\\01.md`, index: 1 }],
      [
        'iteration.completed',
        {
          iteration_path: `${WIN_ROOT}\\.pipeline\\p\\steps\\01.md`,
          next_iteration_path: `${WIN_ROOT}\\.pipeline\\p\\steps\\02.md`,
          outcome: 'completed',
        },
      ],
      ['iteration.resumed', { iteration_path: `${WIN_ROOT}\\.pipeline\\p\\steps\\01.md` }],
      ['pipeline.started', { first_iteration_path: `${WIN_ROOT}\\.pipeline\\p\\steps\\01.md` }],
      ['run.started', { first_iteration_path: `${WIN_ROOT}\\.pipeline\\p\\steps\\01.md` }],
      ['pipeline.halted', { iteration_path: `${WIN_ROOT}\\.pipeline\\p\\steps\\01.md` }],
      ['run.halted', { iteration_path: `${WIN_ROOT}\\.pipeline\\p\\steps\\01.md` }],
      ['improver.started', { iteration_path: `${WIN_ROOT}\\.pipeline\\p\\steps\\01.md` }],
      ['improver.completed', { iteration_path: `${WIN_ROOT}\\.pipeline\\p\\steps\\01.md` }],
      ['script_creator.started', { iteration_path: `${WIN_ROOT}\\.pipeline\\p\\steps\\01.md` }],
      [
        'script_creator.completed',
        {
          iteration_path: `${WIN_ROOT}\\.pipeline\\p\\steps\\01.md`,
          script_path: `${WIN_ROOT}\\.pipeline\\p\\scripts\\build.ts`,
        },
      ],
      ['blocker.delegated', { parent_iteration_path: `${WIN_ROOT}\\.pipeline\\p\\steps\\01.md` }],
    ];

    for (const [type, data] of cases) {
      const filtered = filterEventForTier(sg4Envelope(type, data), 'metadata', {
        fingerprintSalt: SG4_SALT,
      });
      const findings = sg4Findings(filtered);
      expect(`${type}: ${findings.join(' | ') || 'clean'}`).toBe(`${type}: clean`);

      // …and not by DELETING the field: it still names the step, relative to
      // the run's own root.
      const out = filtered.data as Record<string, unknown>;
      for (const key of Object.keys(data)) {
        if (!key.endsWith('_path')) continue;
        const expected =
          key === 'script_path'
            ? '.pipeline/p/scripts/build.ts'
            : `.pipeline/p/steps/${key === 'next_iteration_path' ? '02' : '01'}.md`;
        expect(`${type}.${key} = ${String(out[key])}`).toBe(`${type}.${key} = ${expected}`);
      }
    }
  });

  test('`stats.failures[].step` and `steps[].id` are scrubbed — neither is `*_path`-named', () => {
    // TRAP: these two are `keep`-classified plain identifiers, so no field-NAME
    // rule would ever have reached them, and `b21`'s run-exit ship path carries
    // them.
    const abs = `${WIN_ROOT}\\.pipeline\\p\\steps\\02-build.md`;
    const record: Record<string, unknown> = {
      run_id: 'r1',
      pipeline: 'workflows/release',
      outcome: 'halted',
      steps: [{ id: abs, seconds: 4, outcome: 'FAIL' }],
      failures: [{ ts: '2026-08-07T10:00:00.000Z', tool: 'Bash', step: abs }],
    };

    // Wrapped in an envelope, the root comes from the envelope.
    const wrapped = filterEventForTier(sg4Envelope('stats.run_record', record), 'metadata', {
      fingerprintSalt: SG4_SALT,
    });
    const wrappedData = wrapped.data as Record<string, unknown>;
    expect((wrappedData.failures as Array<Record<string, unknown>>)[0]?.step).toBe(
      '.pipeline/p/steps/02-build.md',
    );
    expect((wrappedData.steps as Array<Record<string, unknown>>)[0]?.id).toBe(
      '.pipeline/p/steps/02-build.md',
    );
    expect(sg4Findings(wrapped)).toEqual([]);

    // A BARE record has no root of its own, so the caller supplies one…
    const withRoot = filterStatsRecordMetadata(record, {
      fingerprintSalt: SG4_SALT,
      pathRoots: [WIN_ROOT],
    });
    expect((withRoot.failures as Array<Record<string, unknown>>)[0]?.step).toBe(
      '.pipeline/p/steps/02-build.md',
    );
    // …and without one it fails closed rather than shipping raw.
    const noRoot = filterStatsRecordMetadata(record, { fingerprintSalt: SG4_SALT });
    expect((noRoot.failures as Array<Record<string, unknown>>)[0]?.step).toMatch(/^fp:[0-9a-f]{16}$/);
    expect((noRoot.steps as Array<Record<string, unknown>>)[0]?.id).toMatch(/^fp:[0-9a-f]{16}$/);
    expect(sg4Findings(noRoot)).toEqual([]);
  });

  test('a path in a field NOBODY allowlisted as a path is still scrubbed — the shape is the rule', () => {
    // `halt_reason` is a `summary` field: free text, truncated but KEPT. It is
    // exactly where a stack frame or a command line drags a path onto the wire,
    // and no field-name rule would ever catch it.
    const filtered = filterEventForTier(
      sg4Envelope('iteration.completed', {
        outcome: 'halted',
        halt_reason: `build failed: cannot open ${WIN_ROOT}\\.pipeline\\p\\steps\\01.md (ENOENT)`,
      }),
      'metadata',
      { fingerprintSalt: SG4_SALT },
    );
    expect(sg4Findings(filtered)).toEqual([]);
    // The prose survives; only the path inside it is rewritten.
    expect((filtered.data as Record<string, unknown>).halt_reason).toBe(
      'build failed: cannot open .pipeline/p/steps/01.md (ENOENT)',
    );
  });

  test('all three absolute-path shapes are recognised, and a relative value is untouched', () => {
    expect(looksAbsolutePath(`${WIN_ROOT}\\x.md`)).toBe(true);
    expect(looksAbsolutePath(`${POSIX_ROOT}/x.md`)).toBe(true);
    expect(looksAbsolutePath(`${UNC_ROOT}\\x.md`)).toBe(true);
    expect(looksAbsolutePath('steps/01-prepare.md')).toBe(false);
    // A URL is not a path — `blocker_issue_url` is a `keep` field and must not
    // be mangled. (`https://` contains `s:/`, which is why the arbiter's
    // leading guard is load-bearing.)
    const url = 'https://github.com/IvanMurzak/pipeline/issues/1';
    expect(looksAbsolutePath(url)).toBe(false);
    expect(scrubPathString(url, { fingerprintSalt: SG4_SALT })).toBe(url);
    expect(scrubPathString('steps/01-prepare.md', { fingerprintSalt: SG4_SALT })).toBe(
      'steps/01-prepare.md',
    );

    for (const root of [WIN_ROOT, POSIX_ROOT, UNC_ROOT]) {
      const sep = root.includes('/') ? '/' : '\\';
      const event = {
        ...sg4Envelope('iteration.started', {
          iteration_path: `${root}${sep}.pipeline${sep}p${sep}steps${sep}01.md`,
        }),
        project_root: root,
      };
      const filtered = filterEventForTier(event, 'metadata', { fingerprintSalt: SG4_SALT });
      expect((filtered.data as Record<string, unknown>).iteration_path).toBe('.pipeline/p/steps/01.md');
      expect(sg4Findings(filtered)).toEqual([]);
    }
  });

  test('a path under NO known root FAILS CLOSED to a fingerprint — never passes through raw', () => {
    const orphan = 'C:\\Users\\IvanD\\Documents\\other-client\\secret.md';
    const filtered = filterEventForTier(
      sg4Envelope('iteration.completed', { iteration_path: orphan, outcome: 'completed' }),
      'metadata',
      { fingerprintSalt: SG4_SALT },
    );
    const out = (filtered.data as Record<string, unknown>).iteration_path as string;
    expect(out).toMatch(/^fp:[0-9a-f]{16}$/);
    expect(SG4_PATH_RE.test(out)).toBe(false);
    // Deterministic, so telemetry still correlates on it.
    expect(scrubPathString(orphan, { fingerprintSalt: SG4_SALT })).toBe(out);
  });

  test('a relativized remainder that would STILL carry the account name is refused', () => {
    // Root is the home directory itself, so the remainder would be
    // `IvanD/proj/steps/01.md` — root-free, but still naming the account.
    const filtered = filterEventForTier(
      {
        ...sg4Envelope('iteration.started', { iteration_path: 'C:\\Users\\IvanD\\proj\\steps\\01.md' }),
        project_root: 'C:\\Users',
      },
      'metadata',
      { fingerprintSalt: SG4_SALT, accountNames: ['ivand'] },
    );
    expect((filtered.data as Record<string, unknown>).iteration_path).toMatch(/^fp:[0-9a-f]{16}$/);
    // A bare token that merely EQUALS the account name, with no path around it,
    // is NOT a layout disclosure and is left alone — redacting it would corrupt
    // step identity for every consumer downstream.
    expect(scrubPathString('ivand', { accountNames: ['ivand'], fingerprintSalt: SG4_SALT })).toBe('ivand');
  });

  test('the salt reaches the fingerprint through the DEEP walk, not only the single-string entry point', () => {
    const orphan = 'C:\\elsewhere\\hand-off\\01.md';
    const fp = (salt: string): unknown =>
      (
        filterEventForTier(sg4Envelope('iteration.started', { iteration_path: orphan }), 'metadata', {
          fingerprintSalt: salt,
        }).data as Record<string, unknown>
      ).iteration_path;
    expect(fp('salt-a')).toMatch(/^fp:[0-9a-f]{16}$/);
    expect(fp('salt-a')).not.toBe(fp('salt-b'));
    expect(fp('salt-a')).not.toBe(fp(''));
    expect(fp('salt-a')).toBe(scrubPathString(orphan, { fingerprintSalt: 'salt-a' }));
  });

  test('the scrub is IDEMPOTENT — the wire pass is a no-op over the queue pass', () => {
    // This is what makes the CLI's two filtering seams safe: a record filtered
    // on the way to the queue file is filtered AGAIN on the way to the socket.
    const once = filterEventForTier(
      sg4Envelope('iteration.completed', {
        iteration_path: `${WIN_ROOT}\\.pipeline\\p\\steps\\01.md`,
        next_iteration_path: 'C:\\elsewhere\\x.md',
        outcome: 'completed',
      }),
      'metadata',
      { fingerprintSalt: SG4_SALT },
    );
    // By the wire pass `project_root` is already `fp:…`, so the event's own
    // roots are gone — which must not turn a relativized label into a
    // fingerprint. The caller passes what it knows instead.
    const twice = filterEventForTier(once, 'metadata', {
      fingerprintSalt: SG4_SALT,
      pathRoots: [WIN_ROOT],
    });
    expect(twice.data).toEqual(once.data);
  });

  test('the most SPECIFIC root wins, and roots come from the UNFILTERED event', () => {
    const worktree = `${WIN_ROOT}\\.worktrees\\run-1`;
    expect(collectPathRoots({ project_root: WIN_ROOT, worktree })).toEqual([worktree, WIN_ROOT]);
    // After the allowlist, `project_root` is a fingerprint and names nothing —
    // which is why the filter collects roots BEFORE it runs.
    expect(collectPathRoots({ project_root: 'fp:d00eb2c5706c9640' })).toEqual([]);
    const filtered = filterEventForTier(
      { ...sg4Envelope('iteration.started', { iteration_path: `${worktree}\\steps\\01.md` }), worktree },
      'metadata',
      { fingerprintSalt: SG4_SALT },
    );
    expect((filtered.data as Record<string, unknown>).iteration_path).toBe('steps/01.md');
  });

  test('the OS account name of the machine running this test does not ship', () => {
    const account = userInfo().username;
    expect(account.length).toBeGreaterThan(0);
    expect(defaultAccountNames().includes(account.toLowerCase())).toBe(true);

    const root = `C:\\Users\\${account}\\AppData\\Local\\Temp\\claude\\proj`;
    const planted = `${root}\\.pipeline\\probe\\steps\\01-prepare.md`;
    const filtered = filterEventForTier(
      { ...sg4Envelope('iteration.started', { iteration_path: planted }), project_root: root },
      'metadata',
      { fingerprintSalt: SG4_SALT },
    );
    expect((filtered.data as Record<string, unknown>).iteration_path).toBe(
      '.pipeline/probe/steps/01-prepare.md',
    );
    expect(JSON.stringify(filtered).toLowerCase()).not.toContain(account.toLowerCase());

    // …and with no root to relativize against, it is still gone.
    const orphaned = filterEventForTier(
      sg4Envelope('iteration.started', { iteration_path: planted }),
      'metadata',
      { fingerprintSalt: SG4_SALT },
    );
    expect((orphaned.data as Record<string, unknown>).iteration_path).toMatch(/^fp:[0-9a-f]{16}$/);
    expect(JSON.stringify(orphaned).toLowerCase()).not.toContain(account.toLowerCase());
  });

  test('`events` and `full` still pass VERBATIM — at those tiers the TIER is the control', () => {
    const event = sg4Envelope('iteration.started', {
      iteration_path: `${WIN_ROOT}\\.pipeline\\p\\steps\\01.md`,
    });
    for (const tier of ['events', 'full'] as const) {
      expect(filterEventForTier(event, tier)).toBe(event);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE STEP-IDENTITY RULE (ux-v2 `b24`; `02` D15, migration 049)
// ─────────────────────────────────────────────────────────────────────────────
//
// D15 gives a step ONE identity so its TWO reporters — the `iteration.*` event
// stream and the `stats.run_record` fold — name ONE `step_executions` row. The
// CLI mints it (`b4`) and writes it to both local paths correctly; this filter
// stripped it off both, because deny-by-default plus an allowlist that never
// mentioned `step_uuid` is a silent delete. `grep -c step_uuid` over the
// shipped filter returned 0, the server derived a row identity per path over
// two different keys, and production held four `step_executions` rows for two
// steps — which is what refused gate G6.
//
// The section above is where this SHOULD have been caught: it asserted the two
// NAME fields survive and never asked about the identity.

describe('vendored privacy filter — the step-identity rule (b24)', () => {
  test('THE SWEEP: no step-shaped allowlist is missing step identity', () => {
    // Computed over the LIVE tables, so a new step-shaped allowlist that
    // forgets the identity fails here instead of stripping it in production.
    expect(stepShapedAllowlistViolations()).toEqual([]);
  });

  test.each([...STEP_SCOPED_EVENT_TYPES])(
    '%s carries step_uuid through the metadata tier',
    (type) => {
      const event = journalEvent(type, 'r1', { iteration_path: 'steps/01.md', step_uuid: STEP_UUID });
      const data = (filterEventForTier(event, 'metadata') as { data: Record<string, unknown> }).data;
      expect(data[STEP_IDENTITY_FIELD]).toBe(STEP_UUID);
    },
  );

  test('the stats fold carries step_uuid on every StepStat', () => {
    const filtered = filterStatsRecordMetadata({
      run_id: 'r1',
      steps: [
        { id: '01-prepare', seconds: 12, outcome: 'pass', step_uuid: STEP_UUID },
        { id: '02-finish', seconds: 5, outcome: 'pass' }, // pre-`b4`: absent, not invented
      ],
    });
    const steps = filtered.steps as Array<Record<string, unknown>>;
    expect(steps[0]?.[STEP_IDENTITY_FIELD]).toBe(STEP_UUID);
    expect(steps[1]).not.toHaveProperty(STEP_IDENTITY_FIELD);
  });

  test('D15: both reporters ship the SAME uuid, so the cloud sees ONE row', () => {
    const fromEvent = (
      filterEventForTier(
        journalEvent('iteration.completed', 'r1', {
          iteration_path: 'steps/01-prepare.md',
          outcome: 'completed',
          step_name: '01-prepare',
          step_uuid: STEP_UUID,
        }),
        'metadata',
      ) as { data: Record<string, unknown> }
    ).data[STEP_IDENTITY_FIELD];
    const fromStats = (
      filterStatsRecordMetadata({
        run_id: 'r1',
        steps: [{ id: '01-prepare', outcome: 'pass', step_uuid: STEP_UUID }],
      }).steps as Array<Record<string, unknown>>
    )[0]?.[STEP_IDENTITY_FIELD];
    expect(fromEvent).toBe(STEP_UUID);
    expect(fromStats).toBe(STEP_UUID);
    expect(fromEvent).toBe(fromStats);
  });

  test('a step uuid is not path-shaped, so the SG4 scrub leaves it alone', () => {
    // The privacy decision, asserted: a locally-minted UUIDv7 is a timestamp
    // plus random bits — not a path, not an account name, not content. `keep`,
    // not `fingerprint`: fingerprinting an already-opaque identifier buys no
    // privacy and would BREAK the row identity, since the two reporters'
    // values must stay byte-equal to name one row.
    expect(looksAbsolutePath(STEP_UUID)).toBe(false);
    expect(SG4_PATH_RE.test(STEP_UUID)).toBe(false);
    expect(scrubPathString(STEP_UUID)).toBe(STEP_UUID);
    expect(fingerprintString(STEP_UUID)).not.toBe(STEP_UUID);
  });
});
