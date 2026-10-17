/**
 * council-session-fixtures.ts (CWE-034, Skill 77)
 *
 * SYNTHETIC FIXTURES for component tests and rendered evidence only.
 *
 * Provenance: invented by the CWE-034 builder on 2026-10-14 for
 * component construction and testing, following the directive's
 * fixture rule (Sections 17.5, 34.3: contract_tested artifacts carry
 * synthetic fixture identity). The decision, brief, cards, and
 * verdict are fictional, continuing CWE-032's fictional coaching
 * offer scenario. No real client, session, or model output appears
 * here. Verification level for anything rendered from these
 * fixtures: contract_tested. No test may present them as live
 * product evidence.
 */

import { SCHEMA_VERSIONS } from '@/lib/council/contracts';
import type {
  AdvisorCard,
  CouncilCard,
  DecisionBrief,
  ScoredVerdict,
} from '@/lib/council/contracts';
import type { CouncilEventScope, CouncilWireEvent } from '@/lib/council/events/types';
import type { CouncilSessionSummaryView } from './council-session-types';

export const FIXTURE_PROVENANCE =
  'Synthetic fixture invented by CWE-034 (2026-10-14) for component tests and render evidence. Fictional decision, brief, cards, and verdict; not a real session, client, or model output. Verification level: contract_tested.';

export const FIXTURE_SESSION_ID = 'sess-cwe034-fixture';
export const FIXTURE_CHILD_SESSION_ID = 'sess-cwe034-fixture-rerun';
export const FIXTURE_SHA_A =
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
export const FIXTURE_SHA_B =
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
export const FIXTURE_SHA_C =
  'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

export const FIXTURE_SCOPE: CouncilEventScope = {
  tenant_id: 'tenant-fixture',
  company_id: 'company-fixture',
  installation_id: 'install-fixture',
  session_id: FIXTURE_SESSION_ID,
  visibility: 'company',
  owner_subject: null,
};

export const FIXTURE_OPTIONS = [
  { id: 'opt-stay', label: 'A. Keep the current offer unchanged', kind: 'status_quo' as const },
  { id: 'opt-pilot', label: 'B. Pilot the revised offer with new clients', kind: 'bounded_test' as const },
  { id: 'opt-launch', label: 'C. Launch the revised offer to everyone now', kind: 'change' as const },
];

export const FIXTURE_OPTION_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  FIXTURE_OPTIONS.map((o) => [o.id, o.label]),
);

export const FIXTURE_BRIEF: DecisionBrief = {
  schema_version: SCHEMA_VERSIONS.brief,
  brief_id: 'brief-fixture-1',
  session_id: FIXTURE_SESSION_ID,
  revision: 1,
  question: 'Pilot the revised coaching offer with new clients next month?',
  facts: [
    {
      id: 'fact-reserve',
      statement: 'The cash reserve covers two months of operating costs.',
      evidence_ids: ['ev-budget'],
    },
    {
      id: 'fact-capacity',
      statement: 'The team delivers 30 client hours per week today.',
      evidence_ids: ['ev-ops'],
    },
  ],
  assumptions: [
    {
      id: 'assumption-demand',
      statement: 'Demand for the revised offer resembles demand for the current one.',
      evidence_ids: [],
    },
  ],
  unknowns: [
    {
      id: 'unknown-conversion',
      statement: 'The conversion rate of the revised price page is unknown.',
      evidence_ids: [],
    },
  ],
  constraints: [
    {
      id: 'constraint-reserve',
      description: 'The pilot must not spend below one month of cash reserve.',
      hard: true,
      applies_to_option_ids: ['opt-pilot', 'opt-launch'],
    },
  ],
  options: FIXTURE_OPTIONS,
  relevance_weights: { 'tiffany-aliche': 3, 'russell-brunson': 3, 'simon-sinek': 2 },
  critical_domains: [],
  evidence_manifest: [
    {
      evidence_id: 'ev-budget',
      sha256: FIXTURE_SHA_A,
      source_kind: 'client_document',
      locator: 'Client budget workbook, reserves tab, October snapshot',
    },
    {
      evidence_id: 'ev-ops',
      sha256: FIXTURE_SHA_B,
      source_kind: 'client_document',
      locator: 'Operations roster, delivery hours, week of October 5',
    },
    {
      evidence_id: 'ev-sinek-book',
      sha256: FIXTURE_SHA_C,
      source_kind: 'book',
      locator: 'Publisher bibliography record for Start with Why (Simon & Schuster)',
    },
  ],
  private_preference_ref: null,
  created_at: '2026-10-14T12:00:00.000Z',
  display_timezone: 'America/New_York',
};

/** The rerun child's brief: one fact changed, one fact added. */
export const FIXTURE_CHILD_BRIEF: DecisionBrief = {
  ...FIXTURE_BRIEF,
  brief_id: 'brief-fixture-2',
  session_id: FIXTURE_CHILD_SESSION_ID,
  revision: 2,
  facts: [
    {
      id: 'fact-reserve',
      statement: 'The cash reserve covers three months of operating costs.',
      evidence_ids: ['ev-budget'],
    },
    FIXTURE_BRIEF.facts[1],
    {
      id: 'fact-waitlist',
      statement: 'A waitlist of 40 prospective clients has formed.',
      evidence_ids: ['ev-ops'],
    },
  ],
};

function fixtureHost(seatId: string, operationId: string) {
  return {
    scope: {
      tenant_id: FIXTURE_SCOPE.tenant_id,
      company_id: FIXTURE_SCOPE.company_id,
      installation_id: FIXTURE_SCOPE.installation_id,
      owner_subject: null,
    },
    operation_id: operationId,
    route_id: 'route-fixture',
    session_id: FIXTURE_SESSION_ID,
    stamped_at: '2026-10-14T12:05:00.000Z',
    source_status: 'unverified' as const,
  };
}

export const FIXTURE_CARD_SINEK: AdvisorCard = {
  schema_version: SCHEMA_VERSIONS.card,
  session_id: FIXTURE_SESSION_ID,
  brief_revision: 1,
  seat_id: 'simon-sinek',
  input_manifest_sha256: FIXTURE_SHA_A,
  pack_version: 'pack-sinek-fixture-1',
  card_kind: 'advisor',
  round: 1,
  stance: 'support',
  preferred_option_id: 'opt-pilot',
  option_scores: [
    { option_id: 'opt-stay', score: 5, rationale: 'Safe but tests nothing.', evidence_ids: [] },
    { option_id: 'opt-pilot', score: 8, rationale: 'Tests the WHY with new clients first.', evidence_ids: ['ev-sinek-book'] },
    { option_id: 'opt-launch', score: 4, rationale: 'Commits before the test.', evidence_ids: [] },
  ],
  framework_applications: [
    {
      framework_id: 'golden-circle',
      source_evidence_ids: ['ev-sinek-book'],
      case_evidence_ids: ['ev-budget'],
      application: 'Start from why the offer changes before deciding how widely to launch it.',
      attribution_kind: 'source_principle',
    },
  ],
  decisive_arguments: [
    'The pilot tests the revised offer without breaking the promise the current offer makes.',
  ],
  strongest_objection: 'If the pilot is framed as a discount, it dilutes the WHY.',
  conditions: [],
  critical_unknowns: [],
  change_my_mind: 'Evidence that the revised offer contradicts the stated purpose.',
  challenges_answered: [],
  quotes: [
    {
      quote_id: 'quote-candidate-1',
      text: 'People do not buy what you do; they buy why you do it.',
      evidence_id: 'ev-sinek-book',
      locator: 'Publisher description page for Start with Why',
      verification_status: 'candidate',
    },
  ],
  evidence_strength: 'medium',
  minority_position: null,
  host: fixtureHost('simon-sinek', 'op-fixture-sinek-1'),
};

export const FIXTURE_CARD_ALICHE: AdvisorCard = {
  ...FIXTURE_CARD_SINEK,
  seat_id: 'tiffany-aliche',
  pack_version: 'pack-aliche-fixture-1',
  stance: 'oppose',
  preferred_option_id: 'opt-pilot',
  decisive_arguments: [
    'A broad launch commits cash before delivery capacity is proven; the bounded pilot prices that risk in advance.',
  ],
  strongest_objection:
    'Delivery capacity is unproven at twice the volume, and the reserve does not cover a failed broad launch.',
  conditions: [
    {
      id: 'cond-reserve',
      description: 'Confirm the cash reserve covers the full pilot cost before launch.',
      kind: 'prerequisite',
      blocking: true,
      verification_method: 'Check the reserves tab against the pilot budget.',
      required_evidence: ['ev-budget'],
      responsible_role: 'owner',
      due_at: null,
      status: 'open',
      depends_on: [],
    },
  ],
  critical_unknowns: ['Actual delivery hours available per week.'],
  change_my_mind: 'A measured pilot showing delivery hours per client at the revised price.',
  framework_applications: [
    {
      framework_id: 'budget-basics',
      source_evidence_ids: ['ev-budget'],
      case_evidence_ids: ['ev-ops'],
      application: 'Test the commitment against the recorded reserve before scaling it.',
      attribution_kind: 'source_principle',
    },
  ],
  quotes: [],
  host: fixtureHost('tiffany-aliche', 'op-fixture-aliche-1'),
};

export const FIXTURE_CARDS: readonly CouncilCard[] = [
  FIXTURE_CARD_SINEK,
  FIXTURE_CARD_ALICHE,
];

export const FIXTURE_VERDICT: ScoredVerdict = {
  schema_version: SCHEMA_VERSIONS.verdict,
  result_kind: 'scored',
  session_id: FIXTURE_SESSION_ID,
  verdict_revision: 1,
  recommended_option_id: 'opt-pilot',
  label: 'GO_WITH_CONDITIONS',
  option_scores: [
    {
      option_id: 'opt-stay',
      score: 132 / 22,
      display_score: 6.0,
      weighted_sum: 132,
      denominator: 22,
      coverage: 1,
      spread: 4,
    },
    {
      option_id: 'opt-pilot',
      score: 168 / 22,
      display_score: 7.6,
      weighted_sum: 168,
      denominator: 22,
      coverage: 1,
      spread: 3,
    },
    {
      option_id: 'opt-launch',
      score: 145 / 22,
      display_score: 6.6,
      weighted_sum: 145,
      denominator: 22,
      coverage: 0.86,
      spread: 5,
    },
  ],
  active_weights: { 'simon-sinek': 2, 'tiffany-aliche': 3, 'russell-brunson': 3 },
  evidence_strength: 'medium',
  hard_constraint_findings: [
    {
      constraint_id: 'constraint-reserve',
      option_id: 'opt-launch',
      result: 'fail',
      checker: 'seat',
      evidence_ids: ['ev-budget'],
    },
  ],
  main_reasons: [
    'The pilot produces real conversion evidence instead of another forecast.',
    'New clients experience the revised offer first, so the people affected chose it.',
    'The bounded pilot keeps the cash reserve above the recorded floor.',
  ],
  strongest_dissent:
    'Delivery capacity is unproven at twice the volume, and a failed broad launch is not covered by the reserve (Tiffany Aliche).',
  accepted_amendments: [],
  rejected_amendments: [],
  critical_unknowns: ['Conversion rate of the revised price page.'],
  prerequisites: ['Confirm the cash reserve covers the full pilot cost before launch.'],
  action_proposals: [
    {
      action_id: 'action-cap',
      session_id: FIXTURE_SESSION_ID,
      verdict_revision: 1,
      title: 'Cap pilot seats at deliverable volume',
      description: 'Set the pilot enrollment cap to the hours the team can actually deliver.',
      rationale: 'Prevents overselling seats the team cannot serve.',
      source_condition_ids: ['cond-reserve'],
      department_id: null,
      assigned_agent_id: null,
      sop_id: null,
      persona_id: null,
      acceptance_criteria: ['The cap is written into the pilot offer page.'],
      budget_limit: null,
      due_at: null,
      depends_on_action_ids: [],
      risk_class: 'medium',
      execution_authorization_required: true,
    },
  ],
  cheapest_informative_test: 'Offer the pilot to the existing waitlist for one week.',
  stop_criteria: ['Reserve would fall below one month of operating costs.'],
  review_criteria: ['Pilot conversion meets or beats the current offer.'],
  resolution_support: {
    resolution_sha256: FIXTURE_SHA_B,
    support: 5,
    conditional_support: 3,
    opposition: 1,
    abstention: 0,
  },
  validation_status: 'valid',
  ratification_status: 'ratified',
  brief_sha256: FIXTURE_SHA_A,
  content_sha256: FIXTURE_SHA_C,
};

export const FIXTURE_VERDICT_READ = {
  session_id: FIXTURE_SESSION_ID,
  verdict_state: 'validated',
  verdict: FIXTURE_VERDICT,
};

export const FIXTURE_VERDICT_READ_NOT_READY = {
  session_id: FIXTURE_SESSION_ID,
  verdict_state: 'not_ready',
  verdict: null,
};

export const FIXTURE_VERDICT_READ_INVALID = {
  session_id: FIXTURE_SESSION_ID,
  verdict_state: 'validated',
  verdict: { ...FIXTURE_VERDICT, validation_status: 'invalid' },
};

/** The child's preserved verdict: same shape, a different recorded answer. */
export const FIXTURE_CHILD_VERDICT: ScoredVerdict = {
  ...FIXTURE_VERDICT,
  session_id: FIXTURE_CHILD_SESSION_ID,
  verdict_revision: 1,
  label: 'GO',
  prerequisites: [],
  content_sha256: FIXTURE_SHA_B,
};

export const FIXTURE_HISTORY: readonly CouncilSessionSummaryView[] = [
  {
    session_id: FIXTURE_SESSION_ID,
    mode: 'full',
    visibility: 'company',
    state: 'COMPLETED',
    state_version: 12,
    brief_revision: 1,
    archived: false,
    owner_subject: null,
    created_at: '2026-10-14T12:00:00.000Z',
    updated_at: '2026-10-14T13:00:00.000Z',
  },
  {
    session_id: FIXTURE_CHILD_SESSION_ID,
    mode: 'full',
    visibility: 'company',
    state: 'COMPLETED',
    state_version: 9,
    brief_revision: 2,
    archived: false,
    owner_subject: null,
    created_at: '2026-10-14T14:00:00.000Z',
    updated_at: '2026-10-14T15:00:00.000Z',
  },
];

/* ── Wire events for the live-session tests ─────────────────────────── */

const SEAT_IDS = [
  'simon-sinek',
  'td-jakes',
  'oprah-winfrey',
  'tiffany-aliche',
  'russell-brunson',
  'michelle-obama',
  'brene-brown',
  'dennis-kimbro',
  'les-brown',
];

function wireEvent(
  sequence: number,
  type: CouncilWireEvent['type'],
  payload: Record<string, unknown>,
  extra: Partial<CouncilWireEvent> = {},
): CouncilWireEvent {
  return {
    event_id: `evt-fixture-${sequence}`,
    session_id: FIXTURE_SESSION_ID,
    scope: FIXTURE_SCOPE,
    sequence,
    state_version: sequence,
    type,
    from_state: null,
    to_state: null,
    actor_subject: 'system',
    payload,
    occurred_at: `2026-10-14T12:0${sequence}:00.000Z`,
    origin: 'journal',
    ...extra,
  };
}

export const FIXTURE_EVENT_CREATED: CouncilWireEvent = wireEvent(1, 'session_created', {
  spec: { mode: 'full', seat_ids: SEAT_IDS },
  sample: false,
  state_record: {
    state: 'ROUND_1',
    state_version: 1,
    brief_revision: 1,
    updated_at: '2026-10-14T12:01:00.000Z',
  },
});

export const FIXTURE_EVENT_CARD_SINEK: CouncilWireEvent = wireEvent(2, 'card_accepted', {
  seat_id: 'simon-sinek',
  round: 1,
  card_hash: FIXTURE_SHA_A,
});

export const FIXTURE_EVENT_CARD_ALICHE: CouncilWireEvent = wireEvent(3, 'card_accepted', {
  seat_id: 'tiffany-aliche',
  round: 1,
  card_hash: FIXTURE_SHA_B,
});

/** Sequence 5 with nothing at 4: presenting it must trigger resync, not application. */
export const FIXTURE_EVENT_GAP: CouncilWireEvent = wireEvent(5, 'card_accepted', {
  seat_id: 'oprah-winfrey',
  round: 1,
  card_hash: FIXTURE_SHA_C,
});

export const FIXTURE_EVENT_CARD_OPRAH_SEQ4: CouncilWireEvent = wireEvent(4, 'card_accepted', {
  seat_id: 'oprah-winfrey',
  round: 1,
  card_hash: FIXTURE_SHA_C,
});
