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

import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_PRIVACY_TIER,
  fingerprintString,
  filterEventForTier,
  filterStatsRecordMetadata,
  MESSAGE_PARTS_PLACEHOLDER,
  PRIVACY_TIER_ENV,
  QUESTION_PLACEHOLDER,
  resolvePrivacyTier,
  stripStatsFailureExcerpts,
  SUMMARY_MAX_CHARS,
} from '../src/lib/vendor/privacy';

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
      journalEvent('iteration.completed', 'r1', {
        iteration_path: 'steps/03-review.md',
        outcome: 'completed',
        next_iteration_path: null,
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
    expect((completed.data as Record<string, unknown>).iteration_path).toBe('steps/03-review.md');
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
    const event = journalEvent('run.started', 'r1', { pipeline_name: 'release', pipeline_root: SECRETS.worktreePath });
    const a = filterEventForTier(event, 'metadata') as Record<string, unknown>;
    const b = filterEventForTier(event, 'metadata') as Record<string, unknown>;
    expect(a.project_root).not.toBe(SECRETS.projectRoot);
    expect(a.project_root).toMatch(/^fp:[0-9a-f]{16}$/);
    expect(a.project_root).toBe(b.project_root); // deterministic — correlates across events
    const pipelineRoot = (a.data as Record<string, unknown>).pipeline_root as string;
    expect(pipelineRoot).not.toBe(SECRETS.worktreePath);
    expect(pipelineRoot).toMatch(/^fp:[0-9a-f]{16}$/);
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
  // identity. Both must survive the metadata tier: the tier's own doc calls
  // pipeline-RELATIVE step identity metadata, and the product's per-step
  // dashboards are built on it. Allowlisting only the new name would silently
  // strip the identity out of every journal written before the rename.
  test.each(['iteration.started', 'iteration.resumed', 'iteration.completed'])(
    '%s keeps BOTH step_name (v5) and step_id (v4) at metadata tier',
    (type) => {
      const event = journalEvent(type, 'r1', {
        iteration_path: 'steps/03-review.md',
        outcome: 'completed',
        step_name: 'review',
        step_id: 'review',
      });
      const data = (filterEventForTier(event, 'metadata') as { data: Record<string, unknown> }).data;
      expect(data.step_name).toBe('review');
      expect(data.step_id).toBe('review');
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
