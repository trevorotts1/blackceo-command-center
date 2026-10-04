/**
 * Company Headquarters — applied intent / route decision receipts (unit B14).
 *
 * Authority: SPEC.md rev 4 §S5 "Safe content":
 *
 *   "A JEV receipt stores selected intent, route action, selected department,
 *    confidence if actually supplied, fallback flag, mode, caller resolution
 *    and source reference. Missing fields are null with reason. Off/legacy/
 *    unavailable does not become confidence zero. Shadow is explicitly
 *    non-applied. Do not store free-form internal rationale; generate only
 *    deterministic user-facing explanation from recorded result."
 *
 * This module is the ONE builder for that receipt. It is called at the two
 * ACTUAL consuming boundaries named by §S5's capture table row "JEV/intake
 * route — Caller consuming `jevDecide`/classification/routing result":
 *   - intake classification   → `src/lib/intake/classify.ts`
 *   - department routing      → `src/lib/routing/department-router.ts`
 *
 * It OBSERVES. It never decides, never mutates its input, never throws, does
 * no I/O, spawns nothing and reads no secret. The same input produces the same
 * department and the same owner decision whether receipts are enabled or
 * disabled; the switch below can only remove the receipt object.
 *
 * Never present, never accepted here: prompts, completions, hidden reasoning,
 * rationale, model text, message bodies, credentials. The field set of
 * `HqDecisionReceipt` is closed, and the only prose is `explanation`, a
 * deterministic template rendered from the recorded fields.
 *
 * `phase` is the SPEC S7 decision phase set — `applied` (this boundary's route
 * or intent is in force), `shadow` (the decision engine ran in `shadow`; its
 * output is explicitly NON-applied), `unavailable` (the engine was consulted
 * and produced no usable decision — never represented as confidence 0). When
 * the engine was never consulted, the phase stays `applied` and the reason
 * channel carries `engine_not_consulted` explicitly.
 *
 * Gap G-10 (P01 `evidence/contracts/interfaces.md`): the SPEC's "reason"
 * channel for missing fields was left open for the first consumer. Frozen
 * here: `reason` is `null` when no reason token applies, otherwise a
 * comma-joined list (sorted, de-duplicated) of `HQ_DECISION_REASON_TOKENS`.
 *
 * Switch: `HQ_DECISION_RECEIPTS` set to `0`/`false`/`off`/`no` disables
 * receipts everywhere (they become `null`). Unset or any other value keeps
 * them on.
 *
 * Edge/toolchain note: this file sits inside the instrumentation→scheduler→
 * department-router import graph, so it deliberately imports nothing (no
 * `node:*`, no `zod`) and stays synchronous.
 */

export const HQ_DECISION_STAGES = ['intake_classification', 'department_routing'] as const;
export type HqDecisionStage = (typeof HQ_DECISION_STAGES)[number];

/** SPEC S7 decision phase set. */
export const HQ_DECISION_RECEIPT_PHASES = ['applied', 'shadow', 'unavailable'] as const;
export type HqDecisionReceiptPhase = (typeof HQ_DECISION_RECEIPT_PHASES)[number];

/**
 * Closed reason vocabulary. Every field that is null on a receipt names why,
 * using exactly these tokens; explicit non-application facts (shadow, core
 * absence, catch-all, an unresolved owner pin) use the same channel so nothing
 * is implied rather than stated.
 */
export const HQ_DECISION_REASON_TOKENS = [
  /** The General Task catch-all lane applied. */
  'catch_all',
  /** This boundary does not choose confidence (intake classification). */
  'confidence_not_decided_here',
  /** The deciding path supplied no confidence value. */
  'confidence_not_supplied',
  /** This boundary does not choose a department (intake classification). */
  'department_not_decided_here',
  /** The applied route's workspace has no resolvable department slug. */
  'department_slug_unmapped',
  /** Engine core present but failed its capability handshake. */
  'engine_core_failed',
  /** Engine core absent on this box. */
  'engine_core_missing',
  /** Engine core present but not yet probed in this process. */
  'engine_core_unprobed',
  /** Decision engine configured to `legacy` (no JEV traffic). */
  'engine_legacy',
  /** Engine was reachable but produced no valid decision for this input. */
  'engine_no_decision',
  /** The picker order never reached the decision-engine picker. */
  'engine_not_consulted',
  /** Decision engine configured to `off`. */
  'engine_off',
  /** Decision engine in `shadow`: its output is diagnostic-only, never applied. */
  'engine_shadow',
  /** A responder/engine was consulted and failed, so the lexical floor ran. */
  'engine_unavailable_fallback_lexical',
  /** Engine answered but its route was not applicable: CC's own picker decided. */
  'engine_unsure',
  /** This boundary does not choose the fallback flag (intake classification). */
  'fallback_not_decided_here',
  /** The deciding path supplied no fallback flag. */
  'fallback_not_supplied',
  /** This boundary does not choose intent (department routing). */
  'intent_not_decided_here',
  /** An owner-named target was supplied and no unique worker matched it. */
  'owner_pin_unresolved',
  /** This boundary does not choose the engine route action. */
  'route_action_not_decided_here',
  /** The deciding path supplied no engine route action. */
  'route_action_not_supplied',
  /** No source reference was supplied for this decision. */
  'source_reference_missing',
  /** Classification produced no intent (`unresolved`). */
  'unresolved_classification',
] as const;
export type HqDecisionReasonToken = (typeof HQ_DECISION_REASON_TOKENS)[number];

/** The closed, safe receipt. `confidenceBps` is the integer the S7 envelope carries. */
export type HqDecisionReceipt = {
  stage: HqDecisionStage;
  phase: HqDecisionReceiptPhase;
  intent: string | null;
  routeAction: string | null;
  departmentSlug: string | null;
  confidenceBps: number | null;
  fallback: boolean | null;
  /** The mode in force here: an engine mode (`auto`/`shadow`/`legacy`/`off`) or `not_consulted`. */
  mode: string;
  /** Caller resolution: lexical|jev|control|owner_pin|explicit|semantic|keyword|general|escalation. */
  resolvedBy: string | null;
  /** null when no reason token applies; otherwise comma-joined reason tokens. */
  reason: string | null;
  /** Deterministic template rendered from the recorded fields. No free-form rationale. */
  explanation: string;
  /** SPEC S5 source reference supplied by the caller. Never invented here. */
  sourceReference: string | null;
};

export interface HqDecisionReceiptInput {
  stage: HqDecisionStage;
  phase: HqDecisionReceiptPhase;
  mode: string;
  resolvedBy?: string | null;
  intent?: string | null;
  routeAction?: string | null;
  departmentSlug?: string | null;
  /** Confidence on the 0..1 scale actually supplied by the deciding path, else null. */
  confidence?: number | null;
  fallback?: boolean | null;
  sourceReference?: string | null;
  tokens?: readonly HqDecisionReasonToken[];
}

/** Receipts are on unless explicitly switched off; the switch can only remove them. */
export function decisionReceiptsEnabled(): boolean {
  const raw = process.env.HQ_DECISION_RECEIPTS;
  if (raw === undefined) return true;
  const value = raw.trim().toLowerCase();
  return !(value === '0' || value === 'false' || value === 'off' || value === 'no');
}

/**
 * Confidence as S7 integer basis points, or null. A value that was never
 * supplied stays null — an unavailable/off/legacy decision must never be
 * recorded as confidence 0.
 */
function toConfidenceBps(confidence: number | null | undefined): number | null {
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return null;
  const bps = Math.round(confidence * 10000);
  if (bps < 0) return 0;
  if (bps > 10000) return 10000;
  return bps;
}

/** Deterministic user-facing sentence; every branch is rendered from recorded fields only. */
function explain(
  stage: HqDecisionStage,
  phase: HqDecisionReceiptPhase,
  mode: string,
  resolvedBy: string | null,
  departmentSlug: string | null,
  fallback: boolean | null,
  intent: string | null,
): string {
  let clause: string;
  if (stage === 'intake_classification') {
    clause = `intent=${intent ?? 'none'}; resolved by ${resolvedBy ?? 'unknown'}`;
  } else if (departmentSlug !== null) {
    clause =
      fallback === null
        ? `${departmentSlug} selected (${resolvedBy ?? 'unknown'}); fallback not supplied`
        : `${departmentSlug} selected; fallback=${fallback}`;
  } else {
    clause = `no department selected (${resolvedBy ?? 'unknown'})`;
  }
  if (phase === 'shadow') return `shadow (not applied); ${clause}`;
  if (phase === 'unavailable') return `unavailable (${mode}); ${clause}`;
  return clause;
}

/**
 * Build the safe receipt for one boundary observation. Pure and total: the
 * same input always yields byte-identical output, and no code path here reads
 * the clock, randomness, the environment (beyond the on/off switch) or I/O.
 * Returns null when receipts are switched off.
 */
export function buildDecisionReceipt(input: HqDecisionReceiptInput): HqDecisionReceipt | null {
  if (!decisionReceiptsEnabled()) return null;

  const intent = input.intent ?? null;
  const routeAction = input.routeAction ?? null;
  const departmentSlug = input.departmentSlug ?? null;
  const confidenceBps = toConfidenceBps(input.confidence);
  const fallback = input.fallback ?? null;
  const resolvedBy = input.resolvedBy ?? null;
  const sourceReference = input.sourceReference ?? null;

  const tokens = new Set<string>(input.tokens ?? []);
  if (input.stage === 'department_routing' && intent === null) tokens.add('intent_not_decided_here');
  if (input.stage === 'intake_classification') {
    if (departmentSlug === null) tokens.add('department_not_decided_here');
    if (routeAction === null) tokens.add('route_action_not_decided_here');
    if (confidenceBps === null) tokens.add('confidence_not_decided_here');
    if (fallback === null) tokens.add('fallback_not_decided_here');
  } else {
    if (routeAction === null) tokens.add('route_action_not_supplied');
    if (confidenceBps === null) tokens.add('confidence_not_supplied');
    if (fallback === null) tokens.add('fallback_not_supplied');
  }
  if (intent === 'unresolved') tokens.add('unresolved_classification');
  if (sourceReference === null) tokens.add('source_reference_missing');

  return {
    stage: input.stage,
    phase: input.phase,
    intent,
    routeAction,
    departmentSlug,
    confidenceBps,
    fallback,
    mode: input.mode,
    resolvedBy,
    reason: tokens.size === 0 ? null : [...tokens].sort().join(','),
    explanation: explain(input.stage, input.phase, input.mode, resolvedBy, departmentSlug, fallback, intent),
    sourceReference,
  };
}
