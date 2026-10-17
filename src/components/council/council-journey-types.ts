/**
 * council-journey-types.ts (CWE-033, Skill 77)
 *
 * The client-side intake journey model. It mirrors CWE-023's accepted
 * intake semantics (the ONB intake service is consumed through the
 * API shapes, never imported): the canonical eleven questions in
 * order with their materiality and explicit-unknown rules, the resume
 * rule (the current step is computed from the saved draft, so an
 * interrupted intake lands on the exact unanswered question and never
 * re-issues an answered one, T016), the deterministic critical-domain
 * classifier over structured signals with the fixed Section 12.7
 * reviewer table, the pre-start panel assessment, and brief
 * composition into the CWE-029 create shape.
 *
 * The client's private preference is NOT part of this model: it lives
 * in its own storage slot and its own step, and never enters the
 * composed brief (Section 11.1).
 */

import { canonicalHash } from '@/lib/council/contracts/canonical-json';
import type {
  CriticalDomain,
  CriticalDomainRequirement,
  DecisionBrief,
  SessionMode,
} from '@/lib/council/contracts/types';
import type { SessionDraftInput } from '@/lib/council/journey-client';
import { COUNCIL_SEAT_ROSTER, type CouncilSeatId } from './council-room-types';

// ---------------------------------------------------------------- questions

export type IntakeQuestionId =
  | 'decision'
  | 'options'
  | 'success'
  | 'constraints'
  | 'facts'
  | 'unknowns'
  | 'assumptions'
  | 'stakeholders'
  | 'mode_panel'
  | 'route'
  | 'preference';

export interface IntakeQuestion {
  id: IntakeQuestionId;
  /** Material questions block freeze until answered. */
  material: boolean;
  /** Whether an explicit "I don't know yet" counts as an answer. */
  allowsExplicitUnknown: boolean;
  title: string;
  guidance: string;
}

/** The canonical question order (CWE-023). Resume walks this list. */
export const INTAKE_QUESTIONS: readonly IntakeQuestion[] = [
  {
    id: 'decision',
    material: true,
    allowsExplicitUnknown: false,
    title: 'What decision are you making?',
    guidance:
      'One understandable choice or question, not an entire business plan. Structured flags record whether money, an offer, a pivot, stakeholders, communication, or a professional domain are involved.',
  },
  {
    id: 'options',
    material: true,
    allowsExplicitUnknown: false,
    title: 'What are the alternatives?',
    guidance:
      'Two to five explicit options for scored modes; include the status quo and a smaller test when relevant.',
  },
  {
    id: 'success',
    material: true,
    allowsExplicitUnknown: true,
    title: 'What would success look like?',
    guidance:
      'The outcome and its horizon. No invented target: an explicit unknown is recorded as an unknown.',
  },
  {
    id: 'constraints',
    material: true,
    allowsExplicitUnknown: true,
    title: 'What limits apply?',
    guidance:
      'Budget and cash, time, capacity, obligations, reversibility, and prohibited actions. Ranges are acceptable; exact figures are never forced.',
  },
  {
    id: 'facts',
    material: true,
    allowsExplicitUnknown: true,
    title: 'What is already known?',
    guidance:
      'Facts the client states now. Confirmed facts retrieved with authorization are already here and are never asked for again.',
  },
  {
    id: 'unknowns',
    material: true,
    allowsExplicitUnknown: true,
    title: 'What is not known yet?',
    guidance:
      'Unknowns that could change the choice, and how each could be resolved. An empty list is an answer: the client states nothing material is unknown.',
  },
  {
    id: 'assumptions',
    material: false,
    allowsExplicitUnknown: false,
    title: 'What is being assumed?',
    guidance:
      'Assumptions are labeled as assumptions; they are never silently converted to facts.',
  },
  {
    id: 'stakeholders',
    material: false,
    allowsExplicitUnknown: false,
    title: 'Who is affected?',
    guidance: 'People or groups affected by the decision, for stakeholder-aware review.',
  },
  {
    id: 'mode_panel',
    material: true,
    allowsExplicitUnknown: false,
    title: 'Which council mode and panel?',
    guidance:
      'Full, quick, selected seats, or one-seat consult. Required critical responsibilities for the panel are computed and shown before start; the panel is never changed silently.',
  },
  {
    id: 'route',
    material: true,
    allowsExplicitUnknown: false,
    title: 'Which model route?',
    guidance:
      'The explicitly selected route, or the configured default inherited and displayed. The route snapshot is pinned on the brief revision and never silently replaced.',
  },
  {
    id: 'preference',
    material: false,
    allowsExplicitUnknown: false,
    title: 'Which way are you leaning?',
    guidance:
      'Stored separately as your private preference. It is never merged into the brief and never reaches the council.',
  },
];

export const DECISION_FLAG_LABELS = {
  involves_money_commitment: 'It commits money or depends on cash.',
  involves_offer_or_pricing: 'It changes an offer, pricing, or how clients buy.',
  involves_rebrand_or_pivot: 'It is a rebrand, a pivot, or changes existing commitments.',
  involves_stakeholder_trust: 'Other people’s trust in us is at stake.',
  decision_is_communication: 'The decision itself is mainly about communication.',
  involves_professional_domain:
    'It touches a regulated or professional domain (legal, tax, medical, compliance).',
} as const;

export type DecisionFlag = keyof typeof DECISION_FLAG_LABELS;

export type DecisionFlags = Record<DecisionFlag, boolean>;

export const CONSTRAINT_KINDS = [
  { id: 'budget_cash', label: 'Budget or cash limit' },
  { id: 'capacity', label: 'Capacity or delivery limit' },
  { id: 'obligation', label: 'Existing obligation or commitment' },
  { id: 'prohibition', label: 'Prohibited action (hard limit)' },
  { id: 'other', label: 'Other limit' },
] as const;

export type ConstraintKind = (typeof CONSTRAINT_KINDS)[number]['id'];

export interface IntakeConstraint {
  id: string;
  text: string;
  kind: ConstraintKind;
}

/** A fact in the draft. Prefilled facts carry their source, always. */
export interface IntakeFact {
  id: string;
  statement: string;
  /** Where this fact came from, shown wherever the fact appears. */
  source: string | null;
  origin: 'client' | 'prefilled';
}

export interface JourneyAnswers {
  decision: { text: string; flags: DecisionFlags } | null;
  options: string[] | null;
  success: { text: string } | { explicitUnknown: true } | null;
  constraints: IntakeConstraint[] | null;
  constraintsExplicitUnknown: boolean;
  facts: { clientFacts: IntakeFact[] } | null;
  factsExplicitUnknown: boolean;
  unknowns: string[] | null;
  assumptions: string[] | null;
  stakeholders: string[] | null;
}

export type RouteChoice = { kind: 'explicit'; routeId: string } | { kind: 'default' };

export interface JourneyDraft {
  version: 1;
  answers: JourneyAnswers;
  /** Authorized facts supplied before questions; never re-asked. */
  knownFacts: IntakeFact[];
  skippedQuestionIds: IntakeQuestionId[];
  mode: SessionMode | null;
  panelSeatIds: CouncilSeatId[] | null;
  professionalReviewArranged: boolean | null;
  routeChoice: RouteChoice | null;
}

export function emptyDecisionFlags(): DecisionFlags {
  return {
    involves_money_commitment: false,
    involves_offer_or_pricing: false,
    involves_rebrand_or_pivot: false,
    involves_stakeholder_trust: false,
    decision_is_communication: false,
    involves_professional_domain: false,
  };
}

export function emptyJourneyDraft(knownFacts: IntakeFact[] = []): JourneyDraft {
  return {
    version: 1,
    answers: {
      decision: null,
      options: null,
      success: null,
      constraints: null,
      constraintsExplicitUnknown: false,
      facts: null,
      factsExplicitUnknown: false,
      unknowns: null,
      assumptions: null,
      stakeholders: null,
    },
    knownFacts,
    skippedQuestionIds: [],
    mode: null,
    panelSeatIds: null,
    professionalReviewArranged: null,
    routeChoice: null,
  };
}

// ---------------------------------------------------------------- resume (T016)

/**
 * Whether a question counts as answered. Facts are answered when the
 * client stated facts OR authorized retrieval already supplied
 * confirmed facts (Section 9.2: never re-ask). The preference step is
 * handled outside the draft; it is answered when the separate
 * preference step has been visited (see DecisionComposer).
 */
export function isQuestionAnswered(draft: JourneyDraft, id: IntakeQuestionId): boolean {
  const a = draft.answers;
  switch (id) {
    case 'decision':
      return a.decision !== null;
    case 'options':
      return a.options !== null;
    case 'success':
      return a.success !== null;
    case 'constraints':
      return a.constraints !== null || a.constraintsExplicitUnknown;
    case 'facts':
      return a.facts !== null || a.factsExplicitUnknown || draft.knownFacts.length > 0;
    case 'unknowns':
      return a.unknowns !== null;
    case 'assumptions':
      return a.assumptions !== null;
    case 'stakeholders':
      return a.stakeholders !== null;
    case 'mode_panel':
      return draft.mode !== null && draft.panelSeatIds !== null;
    case 'route':
      return draft.routeChoice !== null;
    case 'preference':
      return false;
  }
}

/**
 * The exact step an interrupted intake resumes at: the index of the
 * first question in canonical order that is neither answered nor
 * explicitly skipped. INTAKE_QUESTIONS.length when the flow is
 * complete (the review step). Answered questions are never re-issued.
 */
export function resumeQuestionIndex(draft: JourneyDraft, preferenceVisited: boolean): number {
  for (let i = 0; i < INTAKE_QUESTIONS.length; i += 1) {
    const question = INTAKE_QUESTIONS[i];
    if (question.id === 'preference') {
      if (preferenceVisited) continue;
      return i;
    }
    if (isQuestionAnswered(draft, question.id)) continue;
    if (draft.skippedQuestionIds.includes(question.id)) continue;
    return i;
  }
  return INTAKE_QUESTIONS.length;
}

/** Material questions still blocking freeze, in canonical order. */
export function missingMaterialQuestions(draft: JourneyDraft): IntakeQuestionId[] {
  return INTAKE_QUESTIONS.filter(
    (q) => q.material && !isQuestionAnswered(draft, q.id),
  ).map((q) => q.id);
}

// ------------------------------------------------- critical domains (12.7)

/** Fixed reviewer table from Section 12.7. Never a model choice. */
export const CRITICAL_DOMAIN_REVIEWERS: Readonly<
  Record<
    CriticalDomain,
    {
      requiredSeatId: CouncilSeatId | null;
      requiredChecker: 'seat' | 'qualified_professional';
      reviewerNote: string;
    }
  >
> = {
  financial_feasibility: {
    requiredSeatId: 'tiffany-aliche',
    requiredChecker: 'seat',
    reviewerNote:
      'Tiffany Aliche reviews affordability; missing affordability evidence or a financial-review abstention prevents a GO-style endorsement of the exposed option.',
  },
  demand_and_delivery: {
    requiredSeatId: 'russell-brunson',
    requiredChecker: 'seat',
    reviewerNote:
      'Russell Brunson reviews whether demand evidence and delivery capacity support the option.',
  },
  purpose_and_commitments: {
    requiredSeatId: 'simon-sinek',
    requiredChecker: 'seat',
    reviewerNote:
      'Simon Sinek reviews purpose and commitments; a real violated commitment disqualifies its option unless a legitimately approved revision resolves it.',
  },
  trust_and_stakeholders: {
    requiredSeatId: 'brene-brown',
    requiredChecker: 'seat',
    reviewerNote:
      'Brené Brown reviews trust and stakeholders, with Michelle Obama and Oprah Winfrey when relevant; privacy and consent failures are hard constraints.',
  },
  communication: {
    requiredSeatId: 'td-jakes',
    requiredChecker: 'seat',
    reviewerNote:
      'T. D. Jakes reviews communication through the communication lens of his single seat.',
  },
  qualified_professional_review: {
    requiredSeatId: null,
    requiredChecker: 'qualified_professional',
    reviewerNote:
      'A qualified professional reviews; no celebrity seat substitutes, and no professional conclusion is certified by model vote.',
  },
};

export const CRITICAL_DOMAIN_LABELS: Readonly<Record<CriticalDomain, string>> = {
  financial_feasibility: 'Financial feasibility',
  demand_and_delivery: 'Demand and delivery',
  purpose_and_commitments: 'Purpose and commitments',
  trust_and_stakeholders: 'Trust and stakeholders',
  communication: 'Communication',
  qualified_professional_review: 'Qualified professional review',
};

/** The open question each triggered domain carries into the brief. */
const DOMAIN_OPEN_QUESTIONS: Readonly<Record<CriticalDomain, string>> = {
  financial_feasibility:
    'Can the client make this commitment without destabilizing the foundation that supports their life and business?',
  demand_and_delivery:
    'Who wants this, how will they find it, and can the client deliver what the option promises?',
  purpose_and_commitments:
    'Does this decision express why the business exists, and is it consistent with the commitments already made?',
  trust_and_stakeholders:
    'What difficult conversation or vulnerable action is being avoided, and what would trustworthy leadership require?',
  communication:
    'How must this decision be communicated to the people affected, and will they understand it?',
  qualified_professional_review:
    'Which qualified professional review is required before this decision can be acted on?',
};

const CRITICAL_DOMAIN_POLICY_VERSION = 'critical-domains/v1';

const DOMAIN_ORDER: readonly CriticalDomain[] = [
  'financial_feasibility',
  'demand_and_delivery',
  'purpose_and_commitments',
  'trust_and_stakeholders',
  'communication',
  'qualified_professional_review',
];

/**
 * Deterministic classification from structured intake signals only
 * (decision flags and constraint kinds), mirroring CWE-023. The panel
 * overlay then applies: a triggered domain whose responsible seat is
 * not on the panel stays not_assessed; unarranged professional review
 * is not_assessed; a covered domain is unresolved until the run's
 * assessment exists.
 */
export function classifyJourneyDomains(draft: JourneyDraft): CriticalDomainRequirement[] {
  const signals = new Map<CriticalDomain, { factIds: Set<string>; fieldPaths: Set<string> }>();
  const add = (domain: CriticalDomain, fieldPath: string, factId?: string): void => {
    let signal = signals.get(domain);
    if (!signal) {
      signal = { factIds: new Set(), fieldPaths: new Set() };
      signals.set(domain, signal);
    }
    signal.fieldPaths.add(fieldPath);
    if (factId) signal.factIds.add(factId);
  };

  const flags = draft.answers.decision?.flags;
  if (flags) {
    if (flags.involves_money_commitment)
      add('financial_feasibility', 'answers.decision.flags.involves_money_commitment');
    if (flags.involves_offer_or_pricing)
      add('demand_and_delivery', 'answers.decision.flags.involves_offer_or_pricing');
    if (flags.involves_rebrand_or_pivot)
      add('purpose_and_commitments', 'answers.decision.flags.involves_rebrand_or_pivot');
    if (flags.involves_stakeholder_trust)
      add('trust_and_stakeholders', 'answers.decision.flags.involves_stakeholder_trust');
    if (flags.decision_is_communication)
      add('communication', 'answers.decision.flags.decision_is_communication');
    if (flags.involves_professional_domain)
      add('qualified_professional_review', 'answers.decision.flags.involves_professional_domain');
  }
  for (const constraint of draft.answers.constraints ?? []) {
    const path = `answers.constraints.${constraint.id}`;
    if (constraint.kind === 'budget_cash') add('financial_feasibility', path, constraint.id);
    if (constraint.kind === 'capacity') add('demand_and_delivery', path, constraint.id);
    if (constraint.kind === 'obligation') add('purpose_and_commitments', path, constraint.id);
    if (constraint.kind === 'prohibition') add('trust_and_stakeholders', path, constraint.id);
  }

  const requirements: CriticalDomainRequirement[] = [];
  for (const domain of DOMAIN_ORDER) {
    const signal = signals.get(domain);
    if (!signal) continue;
    const reviewer = CRITICAL_DOMAIN_REVIEWERS[domain];
    let status: CriticalDomainRequirement['status'] = 'unresolved';
    if (reviewer.requiredChecker === 'qualified_professional') {
      if (draft.professionalReviewArranged !== true) status = 'not_assessed';
    } else if (
      draft.panelSeatIds !== null &&
      reviewer.requiredSeatId !== null &&
      !draft.panelSeatIds.includes(reviewer.requiredSeatId)
    ) {
      status = 'not_assessed';
    }
    requirements.push({
      schema_version: 'wise-elders.critical-domain-requirement/v1',
      domain,
      status,
      trigger_evidence_ids: [...signal.factIds],
      trigger_field_paths: [...signal.fieldPaths],
      required_seat_id: reviewer.requiredSeatId,
      required_checker: reviewer.requiredChecker,
      unresolved_questions: [DOMAIN_OPEN_QUESTIONS[domain]],
      policy_version: CRITICAL_DOMAIN_POLICY_VERSION,
    });
  }
  return requirements;
}

// ---------------------------------------------------------------- panel

export interface RequiredResponsibility {
  domain: CriticalDomain;
  requiredSeatId: CouncilSeatId | null;
  requiredChecker: 'seat' | 'qualified_professional';
  reviewerNote: string;
  onPanel: boolean;
  status: 'not_assessed' | 'unresolved';
}

export interface PanelAssessmentView {
  responsibilities: RequiredResponsibility[];
  missingDomains: CriticalDomain[];
  recommendations: { domain: CriticalDomain; seatId: CouncilSeatId; message: string }[];
  /** In scored modes a missing critical domain caps the endorsement. */
  blocksGoStyleEndorsement: boolean;
}

/** Panel size law (CWE-023): full 9, selected 2..8, quick exactly 4, consult exactly 1. */
export function panelSizeProblem(mode: SessionMode, seatCount: number): string | null {
  switch (mode) {
    case 'full':
      return seatCount === 9 ? null : 'Full mode keeps all nine seats.';
    case 'selected':
      return seatCount >= 2 && seatCount <= 8
        ? null
        : 'Selected mode requires 2 to 8 seats.';
    case 'quick':
      return seatCount === 4 ? null : 'Quick mode requires exactly four named seats.';
    case 'consult':
      return seatCount === 1 ? null : 'Consult mode requires exactly one seat.';
  }
}

export function seatDisplayName(seatId: string): string {
  return COUNCIL_SEAT_ROSTER.find((s) => s.seatId === seatId)?.displayName ?? seatId;
}

/**
 * The pre-start panel assessment, computed before start and shown to
 * the client (CWE-023 assessPanel). Recommendations are offered; the
 * panel is the client's and is never changed by this function.
 */
export function assessJourneyPanel(
  draft: JourneyDraft,
  requirements: readonly CriticalDomainRequirement[],
): PanelAssessmentView {
  const seatIds = draft.panelSeatIds ?? [];
  const responsibilities: RequiredResponsibility[] = [];
  const recommendations: PanelAssessmentView['recommendations'] = [];
  const missingDomains: CriticalDomain[] = [];
  for (const requirement of requirements) {
    const reviewer = CRITICAL_DOMAIN_REVIEWERS[requirement.domain];
    const onPanel =
      reviewer.requiredChecker === 'qualified_professional'
        ? draft.professionalReviewArranged === true
        : reviewer.requiredSeatId !== null && seatIds.includes(reviewer.requiredSeatId);
    if (!onPanel) missingDomains.push(requirement.domain);
    responsibilities.push({
      domain: requirement.domain,
      requiredSeatId: reviewer.requiredSeatId,
      requiredChecker: reviewer.requiredChecker,
      reviewerNote: reviewer.reviewerNote,
      onPanel,
      status: onPanel ? 'unresolved' : 'not_assessed',
    });
    if (!onPanel && reviewer.requiredSeatId !== null) {
      recommendations.push({
        domain: requirement.domain,
        seatId: reviewer.requiredSeatId,
        message: `Consider including ${seatDisplayName(reviewer.requiredSeatId)}: the ${CRITICAL_DOMAIN_LABELS[requirement.domain]} assessment is required for this decision and stays not_assessed without that seat. The panel is unchanged unless you change it.`,
      });
    }
  }
  return {
    responsibilities,
    missingDomains,
    recommendations,
    blocksGoStyleEndorsement: draft.mode !== 'consult' && missingDomains.length > 0,
  };
}

/**
 * Quick-panel recommendation by decision relevance (Section 10):
 * seats responsible for triggered domains first, then roster order.
 * A recommendation only; the client selects or accepts the panel.
 */
export function recommendQuickPanel(draft: JourneyDraft): CouncilSeatId[] {
  const chosen: CouncilSeatId[] = [];
  const flags = draft.answers.decision?.flags;
  const push = (seat: CouncilSeatId): void => {
    if (!chosen.includes(seat) && chosen.length < 4) chosen.push(seat);
  };
  if (flags?.involves_money_commitment) push('tiffany-aliche');
  if (flags?.involves_offer_or_pricing) push('russell-brunson');
  if (flags?.involves_rebrand_or_pivot) push('simon-sinek');
  if (flags?.involves_stakeholder_trust) push('brene-brown');
  if (flags?.decision_is_communication) push('td-jakes');
  for (const seat of COUNCIL_SEAT_ROSTER) push(seat.seatId);
  return chosen;
}

/** The five Section 10 quick-mode prerequisites, verbatim (CWE-023). */
export const QUICK_MODE_PREREQUISITES: readonly {
  id: string;
  text: string;
  status: 'pending_run';
}[] = [
  { id: 'all_cards_valid', text: 'All four opening and challenge cards are valid.', status: 'pending_run' },
  {
    id: 'same_highest_ranked_option',
    text: 'All four seats have the same highest-ranked eligible option.',
    status: 'pending_run',
  },
  {
    id: 'spread_at_most_3',
    text: 'The Round 2 score spread on that option is at most 3.',
    status: 'pending_run',
  },
  {
    id: 'no_unresolved_critical_fact_or_constraint',
    text: 'No critical fact or constraint remains unresolved.',
    status: 'pending_run',
  },
  {
    id: 'no_unassessed_material_condition',
    text: 'The final plan introduces no material condition or amendment the seats have not assessed.',
    status: 'pending_run',
  },
];

export const QUICK_MODE_RATIFICATION_WHEN_SKIPPED = 'not_run_by_quick_mode_policy';

// ---------------------------------------------------------------- compose

/**
 * The source-pack label this UI composes against. The advisors
 * endpoint reports provenance 'canonical_contract'; no pack registry
 * endpoint is wired in the foundation, so the brief names the
 * canonical CWE-003 contract bundle. CWE-050 owns the pack binding
 * when the run path wires. (Disclosed in the CWE-033 build report.)
 */
export const JOURNEY_SOURCE_PACK_VERSION = 'wise-elders.canonical-contracts/v1';

function optionKindFor(label: string): 'status_quo' | 'bounded_test' | 'change' {
  if (/\b(keep|current|stay|status quo|do nothing)\b/i.test(label)) return 'status_quo';
  if (/\b(pilot|test|trial|try)\b/i.test(label)) return 'bounded_test';
  return 'change';
}

export interface ComposedBriefParts {
  question: string;
  facts: DecisionBrief['facts'];
  assumptions: DecisionBrief['assumptions'];
  unknowns: DecisionBrief['unknowns'];
  constraints: DecisionBrief['constraints'];
  options: DecisionBrief['options'];
  relevance_weights: DecisionBrief['relevance_weights'];
  critical_domains: DecisionBrief['critical_domains'];
  evidence_manifest: DecisionBrief['evidence_manifest'];
}

/** The brief content the draft composes to (shared by create + preview). */
export function composeBriefParts(draft: JourneyDraft): ComposedBriefParts {
  const answers = draft.answers;
  const optionLabels = answers.options ?? [];
  const options = optionLabels.map((label, index) => ({
    id: String.fromCharCode(65 + index),
    label,
    kind: optionKindFor(label),
  }));

  const allFacts: IntakeFact[] = [...draft.knownFacts, ...(answers.facts?.clientFacts ?? [])];
  const facts: DecisionBrief['facts'] = allFacts.map((fact, index) => ({
    id: `fact-${index + 1}`,
    statement: fact.statement,
    evidence_ids: [],
  }));

  const assumptions: DecisionBrief['assumptions'] = (answers.assumptions ?? []).map(
    (statement, index) => ({
      id: `asm-${index + 1}`,
      statement,
      evidence_ids: [],
    }),
  );

  const unknowns: DecisionBrief['unknowns'] = [];
  let unknownCount = 0;
  const pushUnknown = (statement: string): void => {
    unknownCount += 1;
    unknowns.push({ id: `unk-${unknownCount}`, statement, evidence_ids: [] });
  };
  for (const statement of answers.unknowns ?? []) pushUnknown(statement);
  if (answers.success && 'explicitUnknown' in answers.success) {
    pushUnknown('What success looks like is not yet known.');
  }
  if (answers.constraintsExplicitUnknown) {
    pushUnknown('The limits that apply are not yet known.');
  }
  if (answers.factsExplicitUnknown) {
    pushUnknown('No facts are confirmed yet.');
  }

  const constraints: DecisionBrief['constraints'] = (answers.constraints ?? []).map(
    (constraint) => ({
      id: constraint.id,
      description: constraint.text,
      hard: constraint.kind === 'prohibition',
      applies_to_option_ids: [],
    }),
  );

  const critical_domains = classifyJourneyDomains(draft);
  const relevance_weights: Record<string, number> = {};
  for (const seatId of draft.panelSeatIds ?? []) relevance_weights[seatId] = 2;
  for (const requirement of critical_domains) {
    const seatId = CRITICAL_DOMAIN_REVIEWERS[requirement.domain].requiredSeatId;
    if (seatId && seatId in relevance_weights) relevance_weights[seatId] = 3;
  }

  return {
    question: answers.decision?.text ?? '',
    facts,
    assumptions,
    unknowns,
    constraints,
    options,
    relevance_weights: relevance_weights as DecisionBrief['relevance_weights'],
    critical_domains,
    evidence_manifest: [],
  };
}

/**
 * The brief as the review step shows it before freeze: the draft's own
 * composed content, labeled as a preview. Freezing assigns the real
 * brief id and revision through the foundation.
 */
export function previewBriefFromDraft(draft: JourneyDraft): DecisionBrief {
  const parts = composeBriefParts(draft);
  return {
    schema_version: 'wise-elders.brief/v1',
    brief_id: 'draft-preview',
    session_id: 'draft-preview',
    revision: 1,
    question: parts.question,
    facts: parts.facts,
    assumptions: parts.assumptions,
    unknowns: parts.unknowns,
    constraints: parts.constraints,
    options: parts.options,
    relevance_weights: parts.relevance_weights,
    critical_domains: parts.critical_domains,
    evidence_manifest: parts.evidence_manifest,
    private_preference_ref: null,
    created_at: new Date().toISOString(),
    display_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  };
}

export type ComposeResult =
  | { ok: true; input: SessionDraftInput; evidenceManifestHash: string }
  | { ok: false; reason: string };

/**
 * Compose the CWE-029 create input from the journey draft. Facts are
 * confirmed statements only; assumptions stay assumptions; explicit
 * unknowns compose into brief unknowns (CWE-023). The private
 * preference is never read here and never enters the brief. The
 * evidence manifest hash is the canonical hash of the manifest the
 * brief carries, shown at freeze.
 */
export function composeSessionInput(
  draft: JourneyDraft,
  route: { routeId: string; modelId: string | null } | null,
): ComposeResult {
  const missing = missingMaterialQuestions(draft);
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `These questions still need an answer: ${missing.join(', ')}.`,
    };
  }
  if (draft.routeChoice?.kind === 'default') {
    return {
      ok: false,
      reason:
        'You chose to inherit your configured default route. The wired route catalog does not mark which route is the configured default, so a default snapshot cannot be pinned honestly yet; that binding belongs to CWE-050. Pick a route from the catalog to freeze this brief now, or keep working on the draft.',
    };
  }
  if (!route) {
    return { ok: false, reason: 'Choose a model route before freezing the brief.' };
  }
  const parts = composeBriefParts(draft);
  const input: SessionDraftInput = {
    mode: draft.mode ?? 'full',
    visibility: 'private',
    seat_ids: (draft.panelSeatIds ?? []) as SessionDraftInput['seat_ids'],
    source_pack_version: JOURNEY_SOURCE_PACK_VERSION,
    model_policy: {
      selection: 'explicit',
      route_id: route.routeId,
      requested_model_id: route.modelId,
      reasoning_preference: null,
      fallback_policy: 'none',
    },
    brief: {
      question: parts.question,
      facts: parts.facts,
      assumptions: parts.assumptions,
      unknowns: parts.unknowns,
      constraints: parts.constraints,
      options: parts.options,
      relevance_weights: parts.relevance_weights,
      critical_domains: parts.critical_domains,
      evidence_manifest: parts.evidence_manifest,
      private_preference_ref: null,
    },
  };
  return { ok: true, input, evidenceManifestHash: canonicalHash(parts.evidence_manifest) };
}

/** The pinned route snapshot view for the route step and review. */
export interface RouteSnapshotView {
  source: 'explicit' | 'inherited_default';
  routeLabel: string | null;
  identityLevel: string;
  readinessLabel: string | null;
}

// ---------------------------------------------------------------- storage

export const JOURNEY_DRAFT_STORAGE_KEY = 'council-intake-journey/v1';
export const JOURNEY_PREFERENCE_STORAGE_KEY = 'council-intake-preference/v1';

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Persist intake progress (Section 9: progress is persisted). */
export function saveJourneyDraft(draft: JourneyDraft): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(JOURNEY_DRAFT_STORAGE_KEY, JSON.stringify(draft));
  } catch {
    // Storage full or blocked: the in-memory draft still works.
  }
}

export function loadJourneyDraft(): JourneyDraft | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(JOURNEY_DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as JourneyDraft;
    if (parsed.version !== 1 || typeof parsed.answers !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearJourneyDraft(): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(JOURNEY_DRAFT_STORAGE_KEY);
  } catch {
    // Nothing to clear.
  }
}

/**
 * The private preference lives in its OWN storage slot, separate from
 * the draft, mirroring its separate server record. It is never part
 * of the draft JSON and never part of the brief.
 */
export function saveJourneyPreference(text: string): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(JOURNEY_PREFERENCE_STORAGE_KEY, text);
  } catch {
    // See saveJourneyDraft.
  }
}

export function loadJourneyPreference(): string {
  const store = storage();
  if (!store) return '';
  try {
    return store.getItem(JOURNEY_PREFERENCE_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function clearJourneyPreference(): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(JOURNEY_PREFERENCE_STORAGE_KEY);
  } catch {
    // Nothing to clear.
  }
}
