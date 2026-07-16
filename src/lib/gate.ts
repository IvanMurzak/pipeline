// Approval gates (`type: gate` steps) — the runner-side half of T3-14.
//
// A gate is a DETERMINISTIC pause: when the engine dispatches it, the runtime
// emits a needs_input question whose object additionally carries an
// `approval: { required_role }` marker (an ADDITIVE field — the wire schema is
// passthrough on both sides, so the control plane recognizes the question as
// an APPROVAL GATE answerable only by a sufficiently-privileged role), then
// blocks. The decision comes back through the ordinary needs-input ANSWER
// channel as a JSON string:
//
//   { "decision": "approve" | "reject", "comment": string | null }
//
// approve ⇒ the gate step COMPLETES and routing proceeds normally (sequential
// `## Next` parsed mechanically — the script-step rule — or graph edges);
// reject ⇒ the run HALTS with the comment in the halt_reason. A missing /
// non-JSON / unknown-decision answer HALTS too — an unparseable answer is
// NEVER treated as approval. Unknown sibling keys on the answer object are
// ignored (additive-forward).
//
// This module holds the gate CONTRACTS (roles, spec, question shape, decision
// parsing). Plan parsing lives in lib/plan.ts; the dispatch/park/answer
// integration in commands/next.ts (the gate-answer record transform) and
// commands/drive.ts (the exit-4 awaiting-input park + --answer delivery).

import type { FrontmatterValue } from './frontmatter';

/** The protocol's approver-role set (mirrors the control plane's role
 *  vocabulary — owner ⊇ admin ⊇ member ⊇ viewer; privilege ORDERING is the
 *  cloud side's business, the runner only names the required role). */
export const APPROVAL_ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type ApprovalRole = (typeof APPROVAL_ROLES)[number];

/** Parsed `type: gate` declaration attached to a PlanStep. `required_role` is
 *  non-null on an error-free plan (a missing/invalid role is a plan ERROR —
 *  mirrors the script-step "exactly one of script/command" invariant). */
export interface GateStepSpec {
  required_role: ApprovalRole | null;
  /** The gate's prompt: the `## Message` section of the step body (trimmed),
   *  or null when absent (the runtime then uses a default prompt). */
  message: string | null;
}

/** The needs_input question a gate emits. Shape-compatible with the ordinary
 *  step question ({text, context, options} — lib/step-schema.ts StepQuestion)
 *  plus the ADDITIVE `approval` marker the cloud side keys on. */
export interface GateQuestion {
  text: string;
  context: string | null;
  options: string[];
  approval: { required_role: ApprovalRole };
}

/** A successfully parsed gate answer. */
export interface GateDecision {
  decision: 'approve' | 'reject';
  comment: string | null;
}

/** Normalize a frontmatter `required_role:` value to an ApprovalRole, or null
 *  when it is not one (list values, unknown roles). Case-insensitive, trimmed
 *  — the normalizeModel/normalizeEffort tolerance. */
export function normalizeApprovalRole(value: FrontmatterValue | unknown): ApprovalRole | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  return (APPROVAL_ROLES as readonly string[]).includes(v) ? (v as ApprovalRole) : null;
}

/** Build the gate's needs_input question — the SINGLE construction point, so
 *  the wire shape (text + context + options + the additive approval marker)
 *  cannot drift between `pipeline next` (manager mode) and `pipeline drive`. */
export function buildGateQuestion(
  stepId: string,
  requiredRole: ApprovalRole,
  message: string | null,
): GateQuestion {
  return {
    text: message ?? `Approval required to proceed past gate '${stepId}'.`,
    context: `approval gate '${stepId}' — requires role '${requiredRole}' to answer`,
    options: ['approve', 'reject'],
    approval: { required_role: requiredRole },
  };
}

export type GateDecisionParse =
  | { ok: true; decision: GateDecision }
  | { ok: false; detail: string };

/** Parse the needs-input ANSWER delivered for a gate: a JSON string
 *  `{"decision":"approve"|"reject","comment":string|null}` (a pre-parsed
 *  object of the same shape is tolerated — a manager-mode `--record` may
 *  embed it directly). Unknown sibling keys are IGNORED (additive-forward); a
 *  non-string comment reads as null. Everything else — missing/empty answer,
 *  invalid JSON, a non-object, a missing/unknown decision — fails CLOSED: the
 *  caller halts the run, never treating an unparseable answer as approval. */
export function parseGateDecision(answer: unknown): GateDecisionParse {
  let parsed: unknown;
  if (typeof answer === 'string') {
    if (answer.trim() === '') return { ok: false, detail: 'no answer text was delivered' };
    try {
      parsed = JSON.parse(answer);
    } catch {
      return { ok: false, detail: `answer is not valid JSON: ${truncate(answer)}` };
    }
  } else if (answer !== null && typeof answer === 'object' && !Array.isArray(answer)) {
    parsed = answer;
  } else {
    return { ok: false, detail: 'no answer text was delivered' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      detail: `answer is not a JSON object: ${truncate(typeof answer === 'string' ? answer : JSON.stringify(answer))}`,
    };
  }
  const obj = parsed as Record<string, unknown>;
  const decisionRaw = obj.decision;
  const decision =
    typeof decisionRaw === 'string' ? decisionRaw.trim().toLowerCase() : null;
  if (decision !== 'approve' && decision !== 'reject') {
    return {
      ok: false,
      detail: `unknown decision ${JSON.stringify(decisionRaw ?? null)} (expected "approve" or "reject")`,
    };
  }
  return {
    ok: true,
    decision: { decision, comment: typeof obj.comment === 'string' ? obj.comment : null },
  };
}

function truncate(s: string): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length > 200 ? t.slice(0, 200) + '…' : t;
}
