// _model-conformance.ts — shared harness for conformance runs that pin a
// model (d1, 02-standalone-executor.md K-2, resolved as E16).
//
// ── WHY A PIPELINE PINNED TO A MODEL MUST PIN A FULL MODEL ID ───────────────
//
// d2 runs one pipeline under BOTH executors (`claude-cli` and `claude-sdk`)
// and compares the two step records. If the pipeline names an ALIAS
// (`sonnet`, `opus`, `haiku`, `fable`) rather than a full model id, the
// comparison is not between "the same model, two front doors" — it can be
// between two DIFFERENT models that happen to share an alias, and the test
// would never know. The original worry behind K-2 — that the SDK resolves
// aliases differently from the CLI — was misplaced: both executors drive the
// same `claude` binary, so alias resolution is the *same code*. The real
// divergence comes from four knobs that move independently of which executor
// asked:
//
//   1. **Provider.** Bedrock and Foundry resolve `sonnet` and `opus` to
//      different generations than the Anthropic API does.
//   2. **Version skew.** Alias targets change between Claude Code releases,
//      and the Agent SDK bundles its OWN Claude Code binary — verified here
//      at 0.3.228 shipping Claude Code 2.1.228 (see
//      `../src/lib/executors/sdk.ts`'s `VERIFIED_SDK_VERSION`), which is not
//      necessarily the `claude` on the machine's PATH (2.1.227, measured on
//      the machine c3 was built on). The SAME alias can therefore resolve two
//      ways on ONE machine, with no provider or org difference in play at
//      all — this is live, not hypothetical.
//   3. **Org entitlement.** `fable` is offered only where the organisation
//      has access, so a hosted org's key and a user's own key can disagree
//      about what an alias means.
//   4. **Settings.** `availableModels`, an org default model,
//      `modelOverrides`, `ANTHROPIC_DEFAULT_*_MODEL`, and the user's own
//      `~/.claude/settings.json` `model` — which the SDK loads by default,
//      since omitting `settingSources` loads every tier including `user` —
//      can all silently redirect an alias.
//
// None of that is a defect in aliases: they remain fully supported, and
// preferable, for ordinary user pipelines — a user who writes `sonnet` WANTS
// "whatever `sonnet` currently means in my environment". It is a defect in a
// *conformance test* that trusts an alias to mean the same thing in two runs
// it is about to diff. So this harness enforces two things a conformance
// fixture must do, and this file constrains the test harness ONLY, not the
// product:
//
//   - **Pin a full model id**, never an alias — {@link assertFullModelId}.
//   - **Verify what actually ran**, never what was merely requested — a
//     request and a response are different facts, and only the response is
//     evidence. `ExecutorRequest.model` is the request;
//     `ClaudeEnvelope.models_used` (read from the terminal result frame's
//     `modelUsage` map — see `../src/lib/envelope.ts`) is the response.
//     {@link assertModelUsedMatches} fails the run when they disagree.
//
// ── THE ALIAS-VS-FULL-ID PREDICATE IS SHAPE-BASED, NOT A LOOKUP TABLE ───────
//
// A hardcoded list of today's aliases (`sonnet`, `opus`, `haiku`, `fable`)
// would silently let a NEW alias upstream ships tomorrow pass as if it were a
// full id — exactly the bug this harness exists to prevent, just moved one
// level up. Anthropic's direct-API full model ids instead have a fixed,
// checkable SHAPE: `claude-<family/version segments>-<8-digit YYYYMMDD
// snapshot date>`, optionally suffixed with a bracketed context-window tag
// (`[1m]`). An alias is a short bare word with neither the `claude-` prefix
// nor a trailing date stamp, by construction — a new one added upstream still
// won't have either, so it still fails the shape check with no update to this
// file. See {@link isFullModelId} for the exact rule.
//
// Scoping note: the shape rule below targets the direct Anthropic API's id
// space. Bedrock (`anthropic.claude-…-v1:0`) and Foundry ids are shaped
// differently (knob 1 above) and are NOT accepted by this predicate — this
// harness pins against the direct API, which is what these fixtures and CI
// exercise; a future Bedrock/Foundry conformance fixture would need its own
// predicate, not a loosening of this one.
//
// ── NO LIVE CALL WAS MADE TO BUILD OR VERIFY THIS FILE ──────────────────────
//
// Nothing here has been exercised against a real Anthropic API response.
// `tests/model-conformance.test.ts` verifies both functions below entirely
// through fixtures shaped like a `type:"result"` frame (the same fixture
// style `tests/envelope.test.ts` and `tests/sdk-executor.test.ts` use) — never
// through a live query(). Requesting and receiving are different facts, and
// for this task no receiving happened at all.

import type { ClaudeEnvelope } from '../src/lib/envelope';

/**
 * A full Anthropic-API model id: `claude-`, one or more hyphen-separated
 * segments, a trailing 8-digit YYYYMMDD snapshot date, and an optional
 * bracketed suffix (context-window tags such as `[1m]`). Case-insensitive
 * only for robustness — every real id observed is lowercase.
 *
 * Deliberately shape-based (see this file's header) rather than a list of
 * known aliases: `sonnet`, `opus`, `haiku`, `fable`, and any alias not yet
 * invented all fail this pattern the same way, because none of them carry a
 * `claude-` prefix or an 8-digit date segment.
 */
const FULL_MODEL_ID_RE = /^claude-[a-z0-9]+(?:-[a-z0-9]+)*-\d{8}(\[[^[\]]+\])?$/i;

/** True for a full Anthropic-API model id; false for an alias (or anything
 *  else that is not a snapshot-pinned id) — see {@link FULL_MODEL_ID_RE}. */
export function isFullModelId(model: string): boolean {
  return typeof model === 'string' && FULL_MODEL_ID_RE.test(model.trim());
}

/** Raised by {@link assertFullModelId} when a conformance fixture pins an
 *  alias (or anything else not shaped like a full model id). */
export class ModelPinError extends Error {
  constructor(model: string) {
    super(
      `conformance runs must pin a full model id, never an alias: "${model}" is not shaped like one ` +
        '(expected "claude-<segments>-<YYYYMMDD>", e.g. "claude-opus-4-1-20250805"). ' +
        'Aliases (sonnet/opus/haiku/fable/…) resolve differently by provider, Claude Code version, ' +
        'org entitlement and settings — see tests/_model-conformance.ts for the four knobs — so a ' +
        'conformance test comparing two alias-pinned runs could be comparing two different models ' +
        'without ever finding out. Aliases remain fully supported for ordinary user pipelines; this ' +
        'constrains the test harness, not the product.',
    );
    this.name = 'ModelPinError';
  }
}

/** Reject an alias where a conformance fixture requires a full model id.
 *  Throws {@link ModelPinError} rather than silently accepting an alias and
 *  letting the two executors' runs be compared as if they were guaranteed
 *  comparable. */
export function assertFullModelId(model: string): void {
  if (!isFullModelId(model)) throw new ModelPinError(model);
}

/** Raised by {@link assertModelUsedMatches} when the model a run's envelope
 *  reports actually running does not match the model the fixture pinned. */
export class ModelMismatchError extends Error {}

/** The model id(s) a run's envelope reports it actually used — read from the
 *  terminal result frame's `modelUsage` map, never from what was requested.
 *  `[]` when the envelope is null or carried no `modelUsage` at all. */
export function modelsUsed(envelope: ClaudeEnvelope | null): string[] {
  return envelope?.models_used ?? [];
}

/**
 * Fail loudly when the model a run's envelope says it used is not exactly
 * the pinned model — the DoD's "reads back the model from `modelUsage` and
 * fails if it differs" requirement.
 *
 * Two failure shapes, both named explicitly rather than folded into one
 * generic message:
 *   - **no evidence at all** — the envelope carried no `modelUsage`, so there
 *     is nothing to verify the pin against;
 *   - **evidence disagrees** — `modelUsage` names a different model (or an
 *     ADDITIONAL one) than the pin, which is exactly the divergence a
 *     conformance run pins a full id to catch.
 *
 * Passes silently when `modelUsage` names exactly the pinned id and nothing
 * else — a run that also touched a second model (e.g. an internal helper
 * call) is treated as a mismatch too, since the fixture asked for one model
 * and got usage attributed to more than one.
 */
export function assertModelUsedMatches(envelope: ClaudeEnvelope | null, pinnedModelId: string): void {
  const used = modelsUsed(envelope);
  if (used.length === 0) {
    throw new ModelMismatchError(
      `no modelUsage in the result envelope — cannot verify pinned model "${pinnedModelId}" was actually ` +
        'used. Requesting and receiving are different facts; only modelUsage is evidence, and this run ' +
        'produced none of it.',
    );
  }
  const matches = used.length === 1 && used[0] === pinnedModelId;
  if (!matches) {
    throw new ModelMismatchError(
      `model mismatch: pinned "${pinnedModelId}" but the result envelope's modelUsage reports ` +
        `${JSON.stringify(used)}. Requesting a model and the run actually using it are different facts; ` +
        'the pin was not honoured.',
    );
  }
}
