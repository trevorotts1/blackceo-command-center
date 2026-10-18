/**
 * CWE-033 - council journey UI: REAL render tests.
 *
 * Renders the actual journey components (MobileNav entry, DecisionComposer
 * intake, BriefReview, VerdictView, SessionDetail, ConsultPanel) against
 * stubbed fetch responses shaped exactly like the CWE-029 foundation's
 * envelopes. Fixture provenance: synthetic, invented for these tests from
 * the canonical CWE-003 contract fixtures (validBrief / validSessionSpec)
 * and the golden scoring shape (A 132/22 = 6.0, B 168/22 displayed 7.6).
 * No real client, session, or model output appears here.
 *
 * Acceptance covered (CWE-033 brief; Directive Sections 9, 17, 20, 21, 28):
 * - B10: the ONE council entry renders in the live nav for an authorized
 *   fixture principal and is absent for an unauthorized one.
 * - T016: resume lands on the exact unanswered question; answered
 *   questions are not re-issued.
 * - Prefilled facts render with their source marks and are not re-asked.
 * - The panel step shows the not_assessed consequence BEFORE start.
 * - Brief review distinguishes the five content kinds (T017 client half).
 * - The verdict page renders Section 21's fixed section order.
 * - Not-ready endpoints render their typed state: start answers
 *   FEATURE_NOT_READY naming CWE-027; consult creation names CWE-050.
 *   No fake progress anywhere.
 * - The private preference step is separate and never enters the brief.
 *
 * npx vitest run --config vitest.component.config.ts
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: vi.fn() }),
}));

import MobileNav from '../../src/components/MobileNav';
import { DecisionComposer } from '../../src/components/council/DecisionComposer';
import { BriefReview } from '../../src/components/council/BriefReview';
import { VerdictView } from '../../src/components/council/VerdictView';
import { SessionDetail } from '../../src/components/council/SessionDetail';
import { ConsultPanel } from '../../src/components/council/ConsultPanel';
import {
  FIXTURE_HASH_A,
  FIXTURE_HASH_B,
  validBrief,
  validSessionSpec,
} from '../../src/lib/council/contracts/fixtures/examples';
import type {
  DecisionBrief,
  ScoredVerdict,
} from '../../src/lib/council/contracts/types';
import type { CouncilStoredSession } from '../../src/lib/council/journey-client';
import type { RouteCatalogEntry } from '../../src/lib/council/providers';
import {
  JOURNEY_DRAFT_STORAGE_KEY,
  JOURNEY_PREFERENCE_STORAGE_KEY,
  emptyDecisionFlags,
  emptyJourneyDraft,
  type JourneyDraft,
} from '../../src/components/council/council-journey-types';
import { COUNCIL_SEAT_ROSTER } from '../../src/components/council/council-room-types';

// ------------------------------------------------------------ fetch stub

interface StubRoute {
  match: string;
  method?: string;
  status?: number;
  body: unknown;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function stubFetch(routes: StubRoute[]) {
  const fn = vi.fn(async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const route = routes.find(
      (r) => url.includes(r.match) && (r.method ?? 'GET') === method,
    );
    if (!route) {
      return jsonResponse(404, {
        ok: false,
        error: {
          code: 'NOT_FOUND',
          message: `No stub for ${method} ${url}`,
          retryable: false,
          action: 'fix_request',
          request_id: 'req-stub',
        },
      });
    }
    return jsonResponse(route.status ?? 200, route.body);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const okEnvelope = (data: unknown) => ({ ok: true, data, request_id: 'req-test' });

const CAPABILITIES_OK = okEnvelope({
  foundation: {
    unit: 'CWE-029',
    scope: 'foundation_contracts_and_real_safe_reads_only',
    registry_contract: 'wise-elders.endpoint-contract/v1',
    route_ownership_after_acceptance: 'CWE-050',
  },
  endpoints: { total: 31, ready: 8, not_ready: 23, by_owning_unit: {} },
  routes: { total: 1, by_readiness: { UNTESTED: 1 }, runtime_verified: false },
  principal: { subject: 'fixture-principal' },
});

const CAPABILITIES_DENIED = {
  ok: false,
  error: {
    code: 'COUNCIL_FORBIDDEN',
    message: 'The principal is not authorized for the council.',
    retryable: false,
    action: 'contact_administrator',
    request_id: 'req-test',
  },
};

const ROUTE_UNTESTED: RouteCatalogEntry = {
  routeId: 'route-fixture-untested',
  providerSlug: 'fixture-provider',
  displayLabel: 'Fixture route',
  kind: 'fixed_model',
  modelId: 'model-selected-by-client',
  combinationMembers: [],
  providerAccountRef: null,
  capability: {
    contextWindowTokens: null,
    maxOutputTokens: null,
    capabilities: [],
    supportedReasoningLevels: null,
  },
  credential: { state: 'present', envVar: 'FIXTURE_KEY', source: null, checked: [] },
  identityLevel: 'configured',
  readiness: 'UNTESTED',
  qualityQualified: false,
};

const MODELS_OK = okEnvelope({
  routes: [ROUTE_UNTESTED],
  summary: { total: 1, by_readiness: { UNTESTED: 1 }, runtime_verified: false },
});

const FEATURE_NOT_READY_START = {
  ok: false,
  error: {
    code: 'FEATURE_NOT_READY',
    message:
      'Council session run start is registered but its production service is not wired in the API foundation. Owning unit: CWE-027. No operation was performed.',
    retryable: false,
    action: 'wait_for_owning_unit',
    request_id: 'req-test',
  },
};

const FEATURE_NOT_READY_FOLLOW_UP = {
  ok: false,
  error: {
    code: 'FEATURE_NOT_READY',
    message:
      'Council session follow-up is registered but its production service is not wired in the API foundation. Owning unit: CWE-050. No operation was performed.',
    retryable: false,
    action: 'wait_for_owning_unit',
    request_id: 'req-test',
  },
};

// ------------------------------------------------------------ fixtures

const ALL_SEATS = COUNCIL_SEAT_ROSTER.map((s) => s.seatId);

function answeredDraft(patch: Partial<JourneyDraft> = {}): JourneyDraft {
  const base = emptyJourneyDraft();
  return {
    ...base,
    ...patch,
    answers: {
      ...base.answers,
      decision: {
        text: 'Should we pilot the revised offer before a broad launch?',
        flags: { ...emptyDecisionFlags(), involves_money_commitment: true },
      },
      options: ['Keep the current offer', 'Pilot the revised offer'],
      success: { text: 'The pilot proves demand without breaking delivery.' },
      constraints: [{ id: 'con-1', text: 'Pilot spend stays within the approved budget.', kind: 'budget_cash' }],
      facts: {
        clientFacts: [
          {
            id: 'client-fact-1',
            statement: 'The team can deliver one cohort per month.',
            source: 'Stated by you in this intake',
            origin: 'client',
          },
        ],
      },
      unknowns: [],
      ...(patch.answers ?? {}),
    },
  };
}

function seedDraft(draft: JourneyDraft) {
  window.localStorage.setItem(JOURNEY_DRAFT_STORAGE_KEY, JSON.stringify(draft));
}

const BRIEF = validBrief as unknown as DecisionBrief;

const STORED_SESSION = {
  spec: { ...validSessionSpec },
  brief: { ...validBrief },
  scope: {
    tenant_id: 'tenant-fixture',
    company_id: 'company-fixture',
    installation_id: 'install-fixture',
    owner_subject: 'fixture-principal',
  },
  state: {
    schema_version: 'wise-elders.session-state/v1',
    session_id: 'sess-fixture-1',
    mode: 'full',
    state: 'DRAFT',
    state_version: 0,
    brief_revision: 1,
    resume_phase: null,
    cancel_generation: 0,
    revocation_generation: 0,
    attempt: 1,
    lease_epoch: 0,
    archived: false,
    updated_at: '2026-10-14T02:00:00Z',
  },
  sample: false,
} as unknown as CouncilStoredSession;

const SCORED_VERDICT = {
  schema_version: 'wise-elders.verdict/v1',
  result_kind: 'scored',
  session_id: 'sess-fixture-1',
  verdict_revision: 1,
  recommended_option_id: 'B',
  label: 'GO_WITH_CONDITIONS',
  option_scores: [
    { option_id: 'A', score: 6.0, display_score: 6.0, weighted_sum: 132, denominator: 22, coverage: 1, spread: 4 },
    { option_id: 'B', score: 7.636363636363637, display_score: 7.6, weighted_sum: 168, denominator: 22, coverage: 1, spread: 3 },
    { option_id: 'C', score: null, display_score: null, weighted_sum: 0, denominator: 22, coverage: 0, spread: null },
  ],
  active_weights: { ...validBrief.relevance_weights },
  evidence_strength: 'medium',
  hard_constraint_findings: [
    { constraint_id: 'con-1', option_id: 'B', result: 'pass', checker: 'deterministic_code', evidence_ids: ['ev-1'] },
  ],
  main_reasons: ['The pilot bounds the downside.', 'Demand evidence is measurable.', 'Capacity exists for one cohort.'],
  strongest_dissent: 'Delivery capacity is unproven at twice the volume.',
  accepted_amendments: [],
  rejected_amendments: [],
  critical_unknowns: ['Pilot cohort retention'],
  prerequisites: ['Confirm the cash reserve covers the full pilot cost.'],
  action_proposals: [
    {
      action_id: 'act-1',
      session_id: 'sess-fixture-1',
      verdict_revision: 1,
      title: 'Cap pilot seats',
      description: 'Cap the pilot at what the team can actually deliver.',
      rationale: 'Bounds the downside while producing evidence.',
      source_condition_ids: [],
      department_id: null,
      assigned_agent_id: null,
      sop_id: null,
      persona_id: null,
      acceptance_criteria: ['Pilot seats capped before launch.'],
      budget_limit: null,
      due_at: null,
      depends_on_action_ids: [],
      risk_class: 'low',
      execution_authorization_required: true,
    },
  ],
  cheapest_informative_test: 'Run the pilot with one cohort.',
  stop_criteria: ['Stop if the reserve falls below the floor.'],
  review_criteria: ['Review after the first cohort completes.'],
  resolution_support: {
    resolution_sha256: FIXTURE_HASH_A,
    support: 15,
    conditional_support: 5,
    opposition: 2,
    abstention: 0,
  },
  validation_status: 'valid',
  ratification_status: 'not_required',
  brief_sha256: FIXTURE_HASH_A,
  content_sha256: FIXTURE_HASH_B,
} as unknown as ScoredVerdict;

beforeEach(() => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ------------------------------------------------------------ nav entry (B10)

describe('council nav entry (B10)', () => {
  it('renders the Council entry in the live nav for an authorized principal', async () => {
    stubFetch([{ match: '/api/council/capabilities', body: CAPABILITIES_OK }]);
    render(<MobileNav />);
    const link = await screen.findByRole('link', { name: /council/i });
    expect(link.getAttribute('href')).toBe('/council');
    // It sits in the strategy neighborhood, right after the Board item.
    const links = screen.getAllByRole('link').map((l) => l.getAttribute('href'));
    expect(links).toEqual(['/', '/hq', '/tasks/all', '/ceo-board', '/council', '/operator', '/settings']);
  });

  it('is absent for an unauthorized principal, base nav intact', async () => {
    stubFetch([{ match: '/api/council/capabilities', status: 403, body: CAPABILITIES_DENIED }]);
    render(<MobileNav />);
    // The base nav renders immediately; the entry never appears.
    expect(await screen.findByRole('link', { name: /board/i })).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('link', { name: /council/i })).toBeNull();
    const links = screen.getAllByRole('link').map((l) => l.getAttribute('href'));
    expect(links).toEqual(['/', '/hq', '/tasks/all', '/ceo-board', '/operator', '/settings']);
  });
});

// ------------------------------------------------------------ intake resume (T016)

describe('intake journey', () => {
  it('resumes at the exact unanswered question without reissuing answered ones (T016)', async () => {
    // decision, options, success answered; constraints is next.
    const draft = answeredDraft();
    draft.answers.constraints = null;
    seedDraft(draft);
    stubFetch([{ match: '/api/council/models', body: MODELS_OK }]);
    render(<DecisionComposer />);
    const step = await screen.findByTestId('intake-step-constraints');
    expect(within(step).getByText('What limits apply?')).toBeTruthy();
    // The answered questions are not re-issued as the current question.
    expect(screen.queryByTestId('intake-step-decision')).toBeNull();
    expect(screen.queryByTestId('intake-step-options')).toBeNull();
    expect(screen.getByTestId('intake-progress-decision').dataset.state).toBe('done');
    expect(screen.getByTestId('intake-progress-constraints').dataset.state).toBe('current');
  });

  it('renders prefilled facts with source marks and never re-asks them', async () => {
    const draft = answeredDraft();
    draft.skippedQuestionIds = ['assumptions', 'stakeholders'];
    draft.knownFacts = [
      {
        id: 'known-1',
        statement: 'Current offer converts at a measured baseline.',
        source: 'Client document: baseline metrics (authorized retrieval)',
        origin: 'prefilled',
      },
    ];
    // Everything before facts is answered in answeredDraft except facts
    // itself; facts counts as answered through the prefilled record, so
    // resume passes it. Step back to facts from unknowns to inspect it.
    seedDraft(draft);
    stubFetch([{ match: '/api/council/models', body: MODELS_OK }]);
    render(<DecisionComposer />);
    // Resume lands past facts (on mode_panel): facts was NOT re-issued.
    expect(await screen.findByTestId('intake-step-mode_panel')).toBeTruthy();
    expect(screen.getByTestId('intake-progress-facts').dataset.state).toBe('done');
    // Navigate back to the facts step: the fact renders with its source.
    const user = userEvent.setup();
    for (let i = 0; i < 6 && !screen.queryByTestId('intake-step-facts'); i += 1) {
      await user.click(screen.getByRole('button', { name: 'Back' }));
    }
    const factsStep = await screen.findByTestId('intake-step-facts');
    const prefilled = within(factsStep).getByTestId('prefilled-facts');
    expect(prefilled.textContent).toContain('Current offer converts at a measured baseline.');
    expect(prefilled.textContent).toContain(
      'Source: Client document: baseline metrics (authorized retrieval)',
    );
    expect(prefilled.textContent).toContain('not asked again');
  });

  it('shows the not_assessed consequence on the panel step before start', async () => {
    const draft = answeredDraft();
    draft.skippedQuestionIds = ['assumptions', 'stakeholders'];
    seedDraft(draft);
    stubFetch([{ match: '/api/council/models', body: MODELS_OK }]);
    const user = userEvent.setup();
    render(<DecisionComposer />);
    expect(await screen.findByTestId('intake-step-mode_panel')).toBeTruthy();
    await user.click(screen.getByRole('radio', { name: /selected seats/i }));
    // Choose two seats that do NOT cover financial feasibility.
    await user.click(screen.getByRole('checkbox', { name: /simon sinek/i }));
    await user.click(screen.getByRole('checkbox', { name: /brené brown/i }));
    const status = await screen.findByTestId('responsibility-status-financial_feasibility');
    expect(status.textContent).toBe('not_assessed');
    const consequence = screen.getByTestId('not-assessed-consequence');
    expect(consequence.textContent).toContain('not_assessed');
    expect(consequence.textContent).toContain('GO-style endorsement');
    // The responsible seat is recommended, never added silently.
    const recommendation = screen.getByTestId('panel-recommendation-financial_feasibility');
    expect(recommendation.textContent).toContain('Tiffany Aliche');
    expect(recommendation.textContent).toContain('unchanged unless you change it');
  });

  it('displays the route snapshot with UNTESTED routes labeled', async () => {
    const draft = answeredDraft({ mode: 'full', panelSeatIds: [...ALL_SEATS] });
    draft.skippedQuestionIds = ['assumptions', 'stakeholders'];
    seedDraft(draft);
    stubFetch([{ match: '/api/council/models', body: MODELS_OK }]);
    const user = userEvent.setup();
    render(<DecisionComposer />);
    expect(await screen.findByTestId('intake-step-route')).toBeTruthy();
    // The route step mounts before the async model catalog resolves; wait for the real fixture response.
    const readiness = await screen.findByTestId('route-readiness-route-fixture-untested');
    expect(readiness.dataset.readiness).toBe('UNTESTED');
    expect(readiness.textContent).toContain('UNTESTED');
    await user.click(screen.getByRole('radio', { name: /fixture route/i }));
    const snapshot = screen.getByTestId('route-snapshot');
    expect(snapshot.textContent).toContain('your selection');
    expect(snapshot.textContent).toContain('Configured only');
    expect(snapshot.textContent).toContain('UNTESTED');
  });

  it('keeps the private preference in its own step and out of the brief', async () => {
    const draft = answeredDraft({
      mode: 'full',
      panelSeatIds: [...ALL_SEATS],
      routeChoice: { kind: 'explicit', routeId: 'route-fixture-untested' },
    });
    draft.skippedQuestionIds = ['assumptions', 'stakeholders'];
    seedDraft(draft);
    stubFetch([{ match: '/api/council/models', body: MODELS_OK }]);
    const user = userEvent.setup();
    render(<DecisionComposer />);
    // All material questions are answered; resume lands on preference.
    expect(await screen.findByTestId('intake-step-preference')).toBeTruthy();
    const marker = 'ZZ-PRIVATE-PREFERENCE-MARKER';
    await user.type(screen.getByLabelText(/your private preference/i), marker);
    // The preference is stored under its own key, never inside the draft.
    expect(window.localStorage.getItem(JOURNEY_PREFERENCE_STORAGE_KEY)).toBe(marker);
    expect(window.localStorage.getItem(JOURNEY_DRAFT_STORAGE_KEY) ?? '').not.toContain(marker);
    await user.click(screen.getByTestId('intake-continue'));
    const review = await screen.findByTestId('intake-review');
    expect(within(review).getByTestId('brief-review')).toBeTruthy();
    expect(review.textContent).not.toContain(marker);
    expect(within(review).getByTestId('brief-preference-note').textContent).toContain(
      'never appears inside this brief',
    );
    // Freezing is explained in plain language before it happens.
    const freeze = within(review).getByTestId('freeze-explanation');
    expect(freeze.textContent).toContain('locks this brief as revision 1');
    expect(freeze.textContent).toContain('amendments');
    expect(within(review).getByTestId('evidence-manifest-hash').textContent).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ------------------------------------------------------------ brief review (T017)

describe('brief review', () => {
  it('distinguishes statements, facts, assumptions, ranges, and unknowns', () => {
    render(<BriefReview brief={BRIEF} />);
    const kinds = ['statement', 'fact', 'assumption', 'range', 'unknown'] as const;
    for (const kind of kinds) {
      const section = screen.getByTestId(`brief-kind-${kind}`);
      expect(section.dataset.kind).toBe(kind);
    }
    expect(screen.getByTestId('brief-kind-statement').textContent).toContain(
      'Should we pilot the revised offer before a broad launch?',
    );
    const fact = screen.getByTestId('brief-kind-fact');
    expect(fact.textContent).toContain('Current offer converts at a measured baseline.');
    expect(fact.textContent).toContain('Source: doc:baseline-metrics (client_document)');
    expect(screen.getByTestId('brief-kind-assumption').textContent).toContain(
      'Pilot capacity exists for one cohort.',
    );
    expect(screen.getByTestId('brief-kind-range').textContent).toContain(
      'Pilot spend must stay within the approved budget.',
    );
    expect(screen.getByTestId('brief-kind-unknown').textContent).toContain(
      'Pilot cohort retention is not yet measured.',
    );
  });
});

// ------------------------------------------------------------ verdict order (21.4)

describe('verdict page', () => {
  it('renders the seven sections in Section 21 fixed order', () => {
    const { container } = render(<VerdictView verdict={SCORED_VERDICT} brief={BRIEF} />);
    const sections = Array.from(container.querySelectorAll('[data-section]')).map((el) =>
      el.getAttribute('data-section'),
    );
    expect(sections).toEqual([
      'recommendation',
      'conditions',
      'main-reasons',
      'strongest-concern',
      'next-actions',
      'scorecard',
      'rounds-and-sources',
    ]);
    expect(screen.getByTestId('verdict-section-recommendation').textContent).toContain(
      'Pilot the revised offer',
    );
    expect(screen.getByTestId('verdict-section-strongest-concern').textContent).toContain(
      'Delivery capacity is unproven at twice the volume.',
    );
    const scorecard = screen.getByTestId('verdict-scorecard');
    expect(scorecard.textContent).toContain('7.6');
    // An unscored option renders "Not scored", never a fabricated zero.
    expect(scorecard.textContent).toContain('Not scored');
  });
});

// ------------------------------------------------------------ not-ready honesty

describe('typed readiness states', () => {
  it('a start attempt shows FEATURE_NOT_READY naming CWE-027, with no fake progress', async () => {
    stubFetch([
      { match: '/verdict', body: okEnvelope({ session_id: 'sess-fixture-1', verdict_state: 'not_ready', verdict: null }) },
      { match: '/api/council/sessions/sess-fixture-1', method: 'GET', body: okEnvelope(STORED_SESSION) },
      { match: '/api/council/models', body: MODELS_OK },
      { match: '/api/council/sessions/sess-fixture-1/start', method: 'POST', status: 501, body: FEATURE_NOT_READY_START },
    ]);
    const user = userEvent.setup();
    render(<SessionDetail sessionId="sess-fixture-1" />);
    const startButton = await screen.findByTestId('session-start');
    // The room is embedded and honest: seats wait in queue.
    expect(screen.getByTestId('session-room')).toBeTruthy();
    expect(screen.getAllByText(/Waiting in queue/).length).toBeGreaterThan(0);
    await user.click(startButton);
    const notice = await screen.findByTestId('session-start-not-ready');
    expect(notice.textContent).toContain('Start is not ready yet');
    expect(notice.textContent).toContain('Owning unit: CWE-027');
    expect(notice.textContent).toContain('No operation was performed');
    expect(notice.textContent).toContain('nothing is simulating one');
    // No fabricated progress language anywhere on the page.
    expect(document.body.textContent ?? '').not.toMatch(/thinking/i);
  });

  it('creating a consult shows FEATURE_NOT_READY naming CWE-050 and creates nothing', async () => {
    stubFetch([
      { match: '/api/council/sessions/sess-fixture-1/follow-up', method: 'POST', status: 501, body: FEATURE_NOT_READY_FOLLOW_UP },
    ]);
    const user = userEvent.setup();
    render(<ConsultPanel sessionId="sess-fixture-1" />);
    await user.type(
      screen.getByLabelText(/your bounded question/i),
      'What would change your mind about the pilot size?',
    );
    await user.click(screen.getByTestId('consult-submit'));
    const notice = await screen.findByTestId('consult-not-ready');
    expect(notice.textContent).toContain('CWE-050');
    expect(notice.textContent).toContain('No consult was created');
    // Creating a consult is distinguished from reading an objection.
    expect(screen.getByTestId('consult-panel').textContent).toContain('Strongest concern');
  });
});

/* ── WER-016: the real wired Start route must be reflected honestly ── */
describe('WER-016 typed Start receipt and non-mutation controls', () => {
  const startReceipt = {
    session_id: 'sess-fixture-1',
    state: 'QUEUED',
    state_version: 2,
    idempotent_replay: false,
    job_id: 'job-council-1',
    grant_id: 'grant-active-1',
    attempt: 1,
  };

  it('shows an actual 202 durable admission and does not offer a second Start', async () => {
    const fetchSpy = stubFetch([
      { match: '/verdict', body: okEnvelope({ session_id: 'sess-fixture-1', verdict_state: 'not_ready', verdict: null }) },
      { match: '/api/council/sessions/sess-fixture-1', method: 'GET', body: okEnvelope(STORED_SESSION) },
      { match: '/api/council/models', body: MODELS_OK },
      { match: '/api/council/sessions/sess-fixture-1/start', method: 'POST', status: 202, body: okEnvelope(startReceipt) },
    ]);
    const user = userEvent.setup();
    render(<SessionDetail sessionId="sess-fixture-1" />);
    await user.click(await screen.findByTestId('session-start'));
    const receipt = await screen.findByTestId('session-start-queued');
    expect(receipt.textContent).toContain('job-council-1');
    expect(receipt.textContent).toContain('not a completed Council verdict');
    expect(screen.queryByTestId('session-start')).toBeNull();
    expect(screen.queryByTestId('session-start-not-ready')).toBeNull();
    const writes = fetchSpy.mock.calls.filter(([url, init]) =>
      String(url).endsWith('/start') && init?.method === 'POST',
    );
    expect(writes).toHaveLength(1);
    const headers = writes[0]?.[1]?.headers as Record<string, string>;
    expect(headers?.['Idempotency-Key']).toBeTruthy();
    const body = JSON.parse(String(writes[0]?.[1]?.body));
    expect(body).toEqual({ expected_version: 0 });
  });

  it('refuses a malformed success response rather than fabricating a queued job', async () => {
    stubFetch([
      { match: '/verdict', body: okEnvelope({ session_id: 'sess-fixture-1', verdict_state: 'not_ready', verdict: null }) },
      { match: '/api/council/sessions/sess-fixture-1', method: 'GET', body: okEnvelope(STORED_SESSION) },
      { match: '/api/council/models', body: MODELS_OK },
      { match: '/api/council/sessions/sess-fixture-1/start', method: 'POST', status: 202, body: okEnvelope({ status: 'ok' }) },
    ]);
    render(<SessionDetail sessionId="sess-fixture-1" />);
    fireEvent.click(await screen.findByTestId('session-start'));
    const error = await screen.findByRole('alert');
    expect(error.textContent).toContain('UNEXPECTED_RESPONSE');
    expect(screen.queryByTestId('session-start-queued')).toBeNull();
  });

  it('never renders a mutation button for a support-only read or completed session', async () => {
    stubFetch([
      { match: '/verdict', body: okEnvelope({ session_id: 'sess-fixture-1', verdict_state: 'not_ready', verdict: null }) },
      { match: '/api/council/sessions/sess-fixture-1', method: 'GET', body: {
        ...okEnvelope(STORED_SESSION), meta: { access_via: 'support' },
      } },
      { match: '/api/council/models', body: MODELS_OK },
    ]);
    const first = render(<SessionDetail sessionId="sess-fixture-1" />);
    await screen.findByTestId('session-start-unavailable');
    expect(screen.queryByTestId('session-start')).toBeNull();
    expect(screen.getByTestId('session-start-unavailable').textContent).toContain('read-only');
    first.unmount();

    stubFetch([
      { match: '/verdict', body: okEnvelope({ session_id: 'sess-fixture-1', verdict_state: 'not_ready', verdict: null }) },
      { match: '/api/council/sessions/sess-fixture-1', method: 'GET', body: okEnvelope({
        ...STORED_SESSION,
        state: { ...STORED_SESSION.state, state: 'COMPLETED' },
      }) },
      { match: '/api/council/models', body: MODELS_OK },
    ]);
    render(<SessionDetail sessionId="sess-fixture-1" />);
    await screen.findByTestId('session-start-unavailable');
    expect(screen.queryByTestId('session-start')).toBeNull();
  });
});
