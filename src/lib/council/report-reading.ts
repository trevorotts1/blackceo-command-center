/**
 * One reader projection shared by the verdict screens and the report
 * exports (CTR-163; audit rows FX-019/FX-035/FX-043/FX-053).
 *
 * The Command Center stores a validated verdict and the committed
 * cards. Everything in this module is derived from those recorded
 * values only: no score, condition, unknown, or recommendation is
 * invented, and an absent value stays explicitly absent. Both the
 * client screens and the Markdown/HTML/PDF renderers consume this
 * projection, so the reading of a verdict cannot drift between them.
 */

import type {
  AdvisorCard,
  Condition,
  ConstraintResult,
  Verdict,
  VerdictLabel,
} from './contracts';

/** Plain-language decision per recorded verdict label. */
export const VERDICT_PLAIN_LABEL: Readonly<Record<VerdictLabel, string>> = {
  GO: 'Proceed',
  GO_WITH_CONDITIONS: 'Proceed, but only with the recorded conditions',
  RESHAPE: 'Reshape the plan before deciding',
  DONT_DO_IT: 'Do not proceed',
  WAIT: 'Wait for now',
  INSUFFICIENT_EVIDENCE: 'Not enough evidence to decide',
};

/**
 * A separate reading sentence, never a repetition of the label. This is
 * what the report prints under "What this means"; it restates the
 * recorded decision boundary, not a new judgement.
 */
export const VERDICT_READING: Readonly<Record<VerdictLabel, string>> = {
  GO: 'The council judges the decision sound as briefed. The recommendation is the first step; execution still needs its own approval.',
  GO_WITH_CONDITIONS:
    'The council supports the decision only if every recorded condition is met first. The recommendation is not permission to skip them.',
  RESHAPE:
    'The council does not support the decision in its current shape. Change the plan, then convene again or ratify the revised plan.',
  DONT_DO_IT:
    'The council advises against this decision. The reasons and the strongest concern below record why.',
  WAIT: 'The council advises waiting. Something material is unresolved now; the recorded unknowns and conditions say what to watch.',
  INSUFFICIENT_EVIDENCE:
    'The council could not reach a supported recommendation. The recorded unknowns and evidence gaps say what is missing.',
};

export type ReadinessStatus =
  | 'ready_to_act'
  | 'actionable_with_conditions'
  | 'blocked'
  | 'needs_reshape'
  | 'not_advisable'
  | 'waiting'
  | 'blocked_on_information'
  | 'consult_only';

export const READINESS_HEADLINE: Readonly<Record<ReadinessStatus, string>> = {
  ready_to_act:
    'Ready to act on the recorded recommendation, subject to its own execution approval.',
  actionable_with_conditions:
    'Actionable only after the recorded conditions are satisfied; execution approval is still separate.',
  blocked:
    'Blocked. A failed or unresolved hard constraint on the recommended option, or a blocking ratification state, prevents acting yet.',
  needs_reshape: 'Not ready as briefed. Reshape the plan before another decision.',
  not_advisable: 'Not advisable. Do not act on this decision.',
  waiting: 'Waiting. A material question is still open.',
  blocked_on_information:
    'Blocked on information. Record the missing facts before deciding.',
  consult_only:
    'One-seat consultation only. There is no scored plan or readiness call.',
};

/**
 * Canonical 1.0.74 readiness parity: only GO and GO_WITH_CONDITIONS may
 * ever be eligible to act. A pending, rejected, or materially-unratified
 * resolution blocks readiness, and a failed or unresolved hard constraint
 * on the RECOMMENDED option is a readiness fact rather than a footnote.
 */
const READY_ELIGIBLE_VERDICTS: ReadonlySet<VerdictLabel> = new Set([
  'GO',
  'GO_WITH_CONDITIONS',
]);

const RATIFICATION_BLOCKS_READINESS: ReadonlySet<string> = new Set([
  'pending',
  'rejected',
  'material_change_unratified',
]);

export interface RecommendedHardFinding {
  constraint_id: string;
  option_id: string;
  result: ConstraintResult;
  checker: string;
}

export interface ConditionSummaryItem {
  id: string;
  description: string;
  kind: string;
  status: string;
  blocking: boolean;
  source: 'seat_condition' | 'verdict_prerequisite' | 'hard_constraint';
}

export interface ConditionSummary {
  total: number;
  open: number;
  satisfied: number;
  waived: number;
  unresolved: number;
  blocking_open: number;
  items: ConditionSummaryItem[];
}

export interface DedupedUnknowns {
  recorded: number;
  distinct: number;
  collapsed: number;
  items: string[];
  note: string | null;
}

/** Exact duplicate collapse only: values are never rewritten or inferred. */
export function dedupeExact(values: readonly string[]): DedupedUnknowns {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const value of values) {
    const key = typeof value === 'string' ? value.trim() : String(value);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    items.push(key);
  }
  const recorded = values.length;
  const distinct = items.length;
  const collapsed = recorded - distinct;
  return {
    recorded,
    distinct,
    collapsed,
    items,
    note:
      collapsed > 0
        ? `${recorded} unknown(s) were recorded; ${distinct} distinct unknown(s) are printed here. The remaining ${collapsed} repeat exactly and are not printed twice; nothing was removed or reworded.`
        : null,
  };
}

function isOpenStatus(status: string): boolean {
  return status === 'open' || status === 'unresolved';
}

/**
 * One condition tally over every condition the verdict and final cards
 * actually record. Prerequisites are free-text strings in the contract;
 * they have no status, so they count as open and are labelled as
 * prerequisites rather than being upgraded to satisfied.
 */
export function summarizeConditions(args: {
  prerequisites?: readonly string[];
  hardFindings?: ReadonlyArray<{ constraint_id: string; option_id: string; result: ConstraintResult; checker: string }>;
  cards?: readonly AdvisorCard[];
}): ConditionSummary {
  const items: ConditionSummaryItem[] = [];
  for (const prerequisite of args.prerequisites ?? []) {
    if (prerequisite.trim().length === 0) continue;
    items.push({
      id: `prerequisite-${items.length + 1}`,
      description: prerequisite,
      kind: 'prerequisite',
      status: 'open',
      blocking: true,
      source: 'verdict_prerequisite',
    });
  }
  for (const finding of args.hardFindings ?? []) {
    if (finding.result === 'pass') continue;
    items.push({
      id: finding.constraint_id,
      description: `Hard constraint ${finding.constraint_id} on option ${finding.option_id} was recorded as ${finding.result} by ${finding.checker}.`,
      kind: 'hard_constraint',
      status: finding.result === 'unknown' ? 'unresolved' : 'open',
      blocking: true,
      source: 'hard_constraint',
    });
  }
  for (const card of args.cards ?? []) {
    for (const condition of card.conditions as readonly Condition[]) {
      items.push({
        id: condition.id,
        description: condition.description,
        kind: condition.kind,
        status: condition.status,
        blocking: condition.blocking,
        source: 'seat_condition',
      });
    }
  }
  let open = 0;
  let satisfied = 0;
  let waived = 0;
  let unresolved = 0;
  let blockingOpen = 0;
  for (const item of items) {
    if (item.status === 'satisfied') satisfied += 1;
    else if (item.status === 'waived_by_owner') waived += 1;
    else if (item.status === 'unresolved') unresolved += 1;
    else open += 1;
    if (item.blocking && isOpenStatus(item.status)) blockingOpen += 1;
  }
  return {
    total: items.length,
    open,
    satisfied,
    waived,
    unresolved,
    blocking_open: blockingOpen,
    items,
  };
}

export interface VerdictReading {
  label_plain: string;
  decision: string;
  reading: string;
  readiness_status: ReadinessStatus;
  readiness_headline: string;
  /** Recorded facts that make readiness worse than the label alone. */
  blocked_reasons: string[];
}

/**
 * The reading of a scored verdict. The headline carries the decision;
 * the reading is a separate sentence so a label such as WAIT is never
 * printed as a tautology above a firm recommendation.
 *
 * Readiness is the canonical 1.0.74 rule: the verdict must be GO or
 * GO_WITH_CONDITIONS; an open blocking condition is a condition, not a
 * blocker, but a failed/unknown hard constraint on the recommended option
 * or a blocking ratification state is a hard stop.
 */
export function readScoredVerdict(args: {
  label: VerdictLabel;
  recommended_option_label: string | null;
  conditions: ConditionSummary;
  recommended_option_id?: string | null;
  hard_findings?: readonly RecommendedHardFinding[];
  ratification_status?: string | null;
}): VerdictReading {
  const recommendedId = args.recommended_option_id ?? null;
  const recommendedHardFindings =
    recommendedId === null
      ? []
      : (args.hard_findings ?? []).filter(
          (finding) =>
            finding.option_id === recommendedId &&
            (finding.result === 'fail' || finding.result === 'unknown'),
        );
  const ratificationStatus = args.ratification_status ?? null;
  const ratificationBlocks =
    ratificationStatus !== null &&
    RATIFICATION_BLOCKS_READINESS.has(ratificationStatus);
  const eligible = READY_ELIGIBLE_VERDICTS.has(args.label);
  const blockedReasons: string[] = [];
  if (!eligible) {
    blockedReasons.push(
      `The recorded verdict was ${args.label}, which is never reported as ready to act.`,
    );
  }
  if (recommendedHardFindings.length > 0) {
    blockedReasons.push(
      `${recommendedHardFindings.filter((finding) => finding.result === 'fail').length} hard constraint check(s) failed and ${recommendedHardFindings.filter((finding) => finding.result === 'unknown').length} could not be resolved for the recommended option.`,
    );
  }
  if (ratificationBlocks) {
    blockedReasons.push(`Ratification status ${ratificationStatus} blocks readiness.`);
  }
  const status: ReadinessStatus = !eligible
    ? args.label === 'RESHAPE'
      ? 'needs_reshape'
      : args.label === 'DONT_DO_IT'
        ? 'not_advisable'
        : args.label === 'WAIT'
          ? 'waiting'
          : 'blocked_on_information'
    : recommendedHardFindings.length > 0 || ratificationBlocks
      ? 'blocked'
      : args.conditions.blocking_open > 0
        ? 'actionable_with_conditions'
        : 'ready_to_act';
  const decision =
    args.recommended_option_label === null
      ? VERDICT_PLAIN_LABEL[args.label]
      : `${VERDICT_PLAIN_LABEL[args.label]}: ${args.recommended_option_label}`;
  return {
    label_plain: VERDICT_PLAIN_LABEL[args.label],
    decision,
    reading: VERDICT_READING[args.label],
    readiness_status: status,
    readiness_headline: READINESS_HEADLINE[status],
    blocked_reasons: blockedReasons,
  };
}

export function readConsultVerdict(args: {
  seat_display_name: string;
}): VerdictReading {
  return {
    label_plain: 'Consultation',
    decision: `Consultation with ${args.seat_display_name}`,
    reading:
      'This is advice from one recorded perspective. It is not a council verdict, carries no score, and records no plan.',
    readiness_status: 'consult_only',
    readiness_headline: READINESS_HEADLINE.consult_only,
    blocked_reasons: [],
  };
}

/** Convenience: read any committed verdict without inventing a score. */
export function readVerdict(args: {
  verdict: Verdict;
  recommended_option_label: string | null;
  seat_display_name?: string;
  conditions?: ConditionSummary;
}): VerdictReading {
  if (args.verdict.result_kind === 'consult') {
    return readConsultVerdict({
      seat_display_name: args.seat_display_name ?? args.verdict.consult_card.seat_id,
    });
  }
  return readScoredVerdict({
    label: args.verdict.label,
    recommended_option_label: args.recommended_option_label,
    conditions:
      args.conditions ??
      summarizeConditions({
        prerequisites: args.verdict.prerequisites,
        hardFindings: args.verdict.hard_constraint_findings,
      }),
    recommended_option_id: args.verdict.recommended_option_id,
    hard_findings: args.verdict.hard_constraint_findings,
    ratification_status: args.verdict.ratification_status,
  });
}

/**
 * A plan step may not print an empty acceptance criterion. This returns
 * the recorded criteria, or an explicit not-ready sentence when the
 * verdict recorded none. It never supplies a criterion of its own.
 */
export function acceptanceCriteriaDisplay(criteria: readonly string[]): {
  items: string[];
  not_ready: boolean;
  note: string | null;
} {
  const items = criteria.filter((criterion) => criterion.trim().length > 0);
  if (items.length > 0) return { items, not_ready: false, note: null };
  return {
    items: [],
    not_ready: true,
    note:
      'No acceptance criterion was recorded for this step. It is not ready to execute until one is recorded and approved.',
  };
}

/** Stop conditions and review criteria share the same honest empty shape. */
export function planListDisplay(values: readonly string[], label: string): {
  items: string[];
  note: string | null;
} {
  const items = values.filter((value) => value.trim().length > 0);
  return {
    items,
    note:
      items.length > 0
        ? null
        : `No ${label} was recorded. This is an absence in the record, not a pass.`,
  };
}
