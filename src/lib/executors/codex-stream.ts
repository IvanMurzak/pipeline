// codex-stream.ts — c6: recover a `ClaudeEnvelope`-shaped result from
// `codex exec --json`'s event stream.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// `envelopeOf` (commands/drive.ts) is the ONE place the drive's belt-and-braces
// record-recovery ladder reads a "did the executor finish, and what did it
// say" fact from. Every rung above the record-file channels — rung 1
// (structured_output) and rung 4 (final-response text parsed as JSON) — is
// built from a `ClaudeEnvelope`, and a `ClaudeEnvelope` is built from a
// claude-shaped `type:"result"` frame (lib/envelope.ts). `codex exec --json`
// never emits that frame — verified live (c6 probe, codex-cli 0.147.0): a
// completed turn's LAST frames are `item.completed` (an `agent_message` item
// carrying the final text) and `turn.completed` (usage), never `type:"result"`.
//
// Without this module, `envelopeOf` returns null for every codex-cli spawn,
// which collapses the retained ladder to rung 2/3 only (the record file —
// which DOES work for codex, verified live: an instructed write under
// `--sandbox workspace-write` lands exactly where asked). That already
// satisfies "record-file recovery must work". This module additionally keeps
// rung 4 (final-response text) alive for codex, which is what the task's
// "the four-rung ladder's retained fallback still applies" asks for — not
// merely "some fallback exists", but the SAME rungs claude leans on for its
// own `-p --agent` gap (claude-code#20625).
//
// ── WHAT WAS MEASURED (c6 probes, codex-cli 0.147.0, Windows) ───────────────
//
//   $ printf '<prompt>' | codex exec --json --sandbox workspace-write \
//       --skip-git-repo-check -c model_reasoning_effort=low
//
// produced, in order:
//   {"type":"thread.started","thread_id":"019ff441-…"}
//   {"type":"turn.started"}
//   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"…"}}
//   {"type":"item.started","item":{"id":"item_1","type":"file_change",…}}
//   {"type":"item.completed","item":{"id":"item_1","type":"file_change",…}}
//   {"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"DONE"}}
//   {"type":"turn.completed","usage":{"input_tokens":…,"output_tokens":…,
//       "cached_input_tokens":…,"cache_write_input_tokens":…,"reasoning_output_tokens":…}}
//
// A turn can carry MORE THAN ONE `agent_message` item (the model narrates,
// then answers) — the LAST one is the turn's actual final response, exactly
// like claude's terminal `result.result`. A schema-validation failure (the
// reason rung 1/`--output-schema` is not used at all — see
// DEFAULT_CODEX_EXECUTOR_TEMPLATE's own comment) surfaces as a top-level
// `{"type":"error","message":…}` frame followed by `{"type":"turn.failed",…}`,
// verified live by intentionally passing a non-strict schema.
//
// ── WHY THIS CANNOT MISFIRE ON A CLAUDE STREAM ──────────────────────────────
//
// `envelopeOf` tries the claude-shaped extraction FIRST and only falls back to
// this module when that yields null. Even so, there is no shape collision to
// guard against: claude's stream-json top-level `type` values are documented
// bare words (`system`, `assistant`, `user`, `stream_event`, `result`, the
// `hook_*` trio, `rate_limit_event` — lib/stream-json.ts `STREAM_TYPES`); every
// type this module recognises is a DOTTED name (`thread.started`, `turn.*`,
// `item.*`, `error`). The one bare word here, `"error"`, is not a claude
// stream-json top-level type either. A text blob that is neither shape simply
// fails to match anything below and this module returns null, same as it does
// for a template swapped out entirely (a fake executor, a wrapper script).

import type { ClaudeEnvelope, EnvelopeUsage } from '../envelope';

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Recover a `ClaudeEnvelope`-shaped result from `codex exec --json`'s
 * newline-delimited stdout. Defensive and total, exactly like
 * `lib/envelope.ts`'s readers: malformed/partial lines are skipped, never
 * thrown, and text that is not a codex event stream at all — including a
 * claude stream-json capture, or a custom `--executor-cmd` template's own
 * output — yields `null` rather than a wrong guess.
 *
 * `structured_output`, `total_cost_usd`, `num_turns`, `permission_denials` and
 * `models_used` are always the ClaudeEnvelope defaults (null/[]) — codex's
 * `--json` stream carries no equivalent of any of them (see
 * DEFAULT_CODEX_EXECUTOR_TEMPLATE's placeholder-mapping comment for
 * `{schema}`). Only `result`, `session_id`, `is_error`, `subtype` and `usage`
 * are ever populated from a real codex run.
 */
export function parseCodexJsonl(stdout: string): ClaudeEnvelope | null {
  if (typeof stdout !== 'string' || stdout.trim() === '') return null;

  let threadId: string | null = null;
  let lastAgentMessage: string | null = null;
  let isError = false;
  let errorMessage: string | null = null;
  let usage: EnvelopeUsage | null = null;
  let sawKnownEvent = false;

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line[0] !== '{') continue;
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(frame)) continue;
    const type = typeof frame.type === 'string' ? frame.type : '';

    if (type === 'thread.started') {
      sawKnownEvent = true;
      threadId = str(frame.thread_id);
      continue;
    }
    if (type === 'item.completed' || type === 'item.started') {
      const item = frame.item;
      if (isRecord(item) && item.type === 'agent_message') {
        sawKnownEvent = true;
        const text = str(item.text);
        if (type === 'item.completed' && text !== null) lastAgentMessage = text;
      } else if (type === 'item.completed' || type === 'item.started') {
        sawKnownEvent = true; // file_change, command_execution, … — recognised, nothing to fold
      }
      continue;
    }
    if (type === 'turn.completed') {
      sawKnownEvent = true;
      const u = frame.usage;
      if (isRecord(u)) {
        usage = {
          input: num(u.input_tokens) ?? 0,
          output: num(u.output_tokens) ?? 0,
          cache_read: num(u.cached_input_tokens) ?? 0,
          cache_creation: num(u.cache_write_input_tokens) ?? 0,
        };
      }
      continue;
    }
    if (type === 'turn.started') {
      sawKnownEvent = true;
      continue;
    }
    if (type === 'turn.failed' || type === 'error') {
      sawKnownEvent = true;
      isError = true;
      const msg = str(frame.message);
      const nested = isRecord(frame.error) ? frame.error : null;
      errorMessage = msg ?? (nested ? str(nested.message) : null) ?? errorMessage;
      continue;
    }
    // Any other/unrecognised dotted-name event (`item.*` variants not yet
    // seen, a future codex release) — ignored, never thrown, matching
    // lib/stream-json.ts's "unknown ⇒ ignored" rule for the claude parser.
  }

  if (!sawKnownEvent) return null; // not a codex event stream at all

  return {
    is_error: isError,
    subtype: isError ? (errorMessage ?? 'codex_error') : 'success',
    result: lastAgentMessage,
    session_id: threadId,
    structured_output: null,
    total_cost_usd: null,
    usage,
    num_turns: null,
    permission_denials: [],
    models_used: [],
  };
}
