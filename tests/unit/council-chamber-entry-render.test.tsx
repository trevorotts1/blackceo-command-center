/**
 * CTR-104 — visual-first Council entry: REAL render proof.
 *
 * The bug: clicking the Council nav item landed on a landing panel whose
 * only primary action opened the guided intake questionnaire, so the
 * nine-seat chamber was never visible without first building a brief.
 *
 * These tests render the ACTUAL components (MobileNav entry target,
 * CouncilHome chamber, DecisionComposer intake) against stubbed
 * authorized CWE-029 envelopes shaped exactly like the deployed
 * foundation. Fixture provenance: synthetic envelopes invented for these
 * tests from the same shapes the existing CWE-033 journey suite uses. No
 * real client, session, or model output appears here.
 *
 * Proven here:
 *   • The Council entry's click target is /council (one registration,
 *     src/lib/nav-gating.ts) — the chamber route, not /council/new.
 *   • /council renders the chamber (nine seats, room mode badge) BEFORE
 *     any intake UI; DecisionComposer is not mounted on the entry.
 *   • The question box is a native GET form to /council/new
 *     (?question=…): no client router, required + length-capped input.
 *   • Opening the chamber issues only the two authorized GET reads — no
 *     session create, no model catalog, no run start, no POST at all.
 *   • Existing sessions and the history link stay reachable below the
 *     chamber; a denied read shows a typed error, never an empty list
 *     and never invented session content.
 *   • The intake keeps its T016 resume rule, and a chamber question
 *     prefills the decision answer (fresh intake) instead of re-asking it.
 *
 * npx vitest run --config vitest.component.config.ts
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: vi.fn() }),
}));

import MobileNav from '../../src/components/MobileNav';
import { CouncilHome, IDLE_CHAMBER_ROOM } from '../../src/components/council/CouncilHome';
import { DecisionComposer } from '../../src/components/council/DecisionComposer';
import {
  COUNCIL_SEAT_IDS,
  roomModeBadge,
} from '../../src/components/council/council-room-types';
import {
  CHAMBER_QUESTION_MAX,
  JOURNEY_DRAFT_STORAGE_KEY,
  emptyDecisionFlags,
  emptyJourneyDraft,
  normalizeChamberQuestion,
  type JourneyDraft,
} from '../../src/components/council/council-journey-types';

// ------------------------------------------------------------ fetch stub

type FetchCall = { url: string; method: string };

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
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

const SESSION_ROW = {
  session_id: 'sess-ctr104-fixture',
  mode: 'full',
  visibility: 'private',
  state: 'DRAFT',
  state_version: 1,
  brief_revision: 1,
  archived: false,
  owner_subject: 'owner:fixture',
  created_at: '2026-10-29T00:00:00.000Z',
  updated_at: '2026-10-29T00:00:00.000Z',
};

const SESSIONS_OK = okEnvelope({
  sessions: [SESSION_ROW],
  count: 1,
  total_in_scope: 1,
});

const SESSIONS_EMPTY = okEnvelope({ sessions: [], count: 0, total_in_scope: 0 });

const MODELS_OK = okEnvelope({ routes: [], summary: { total: 0, by_readiness: {}, runtime_verified: false } });

/** Install a fetch that records every call and answers the council reads. */
function installFetch(options: {
  capabilities?: unknown;
  capabilitiesStatus?: number;
  sessions?: unknown;
  sessionsStatus?: number;
} = {}): FetchCall[] {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url, method });
    if (url.startsWith('/api/council/capabilities')) {
      return jsonResponse(options.capabilitiesStatus ?? 200, options.capabilities ?? CAPABILITIES_OK);
    }
    if (url.startsWith('/api/council/sessions?')) {
      return jsonResponse(options.sessionsStatus ?? 200, options.sessions ?? SESSIONS_OK);
    }
    if (url.startsWith('/api/council/models')) return jsonResponse(200, MODELS_OK);
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
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.localStorage.clear();
});

// ---------------------------------------------------------------- helpers

const ROOT = path.resolve(__dirname, '../..');

function readCss(): string {
  return fs.readFileSync(
    path.join(ROOT, 'src/components/council/council-journey.css'),
    'utf8',
  );
}

/** True when `a` comes before `b` in document order. */
function precedes(a: Node, b: Node): boolean {
  return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
}

// -------------------------------------------------------- the click target

describe('CTR-104 nav click target', () => {
  it('the Council nav item points at /council (the chamber route), never at /council/new', async () => {
    installFetch();
    render(<MobileNav />);
    const link = await screen.findByRole('link', { name: /Council/ });
    expect(link.getAttribute('href')).toBe('/council');
    expect(link.getAttribute('href')).not.toBe('/council/new');
  });

  it('the nav entry stays fail-closed when the capabilities probe is denied', async () => {
    installFetch({ capabilities: CAPABILITIES_DENIED, capabilitiesStatus: 403 });
    render(<MobileNav />);
    await Promise.resolve();
    expect(screen.queryByRole('link', { name: /Council/ })).toBeNull();
  });
});

// ------------------------------------------------------- chamber comes first

describe('CTR-104 /council renders the visual chamber first', () => {
  it('renders the nine-seat room and no intake form on entry', async () => {
    installFetch();
    render(<CouncilHome />);

    const chamber = await screen.findByTestId('council-chamber');
    const room = within(chamber).getByTestId('council-room');
    expect(room).toBeTruthy();

    // All nine roster seats are on the stage.
    expect(within(room).getAllByTestId(/^council-seat-/)).toHaveLength(9);

    // The guided intake is NOT mounted on the entry route.
    expect(screen.queryByTestId('decision-composer')).toBeNull();
    expect(screen.queryByTestId('intake-step-decision')).toBeNull();

    // The honest pre-sitting room: idle mode, all seats queued.
    expect(IDLE_CHAMBER_ROOM.mode).toBe('idle');
    expect(roomModeBadge(IDLE_CHAMBER_ROOM.mode)).toBe('Chamber open');
    expect(IDLE_CHAMBER_ROOM.seats.map((s) => s.seatId)).toEqual([...COUNCIL_SEAT_IDS]);
    expect(IDLE_CHAMBER_ROOM.seats.every((s) => s.status === 'queued' && s.card === null)).toBe(true);
  });

  it('the question box lives inside the chamber and is a native GET form to /council/new', async () => {
    installFetch();
    render(<CouncilHome />);

    const chamber = await screen.findByTestId('council-chamber');
    const form = within(chamber).getByTestId('council-chamber-ask');
    expect(form.getAttribute('action')).toBe('/council/new');
    expect(form.getAttribute('method')).toBe('get');

    const input = within(form).getByTestId('council-chamber-question') as HTMLInputElement;
    expect(input.name).toBe('question');
    expect(input.required).toBe(true);
    expect(input.maxLength).toBe(CHAMBER_QUESTION_MAX);
    expect(input.getAttribute('aria-describedby')).toBe('council-chamber-hint');
    expect(within(form).getByTestId('council-chamber-submit').tagName).toBe('BUTTON');

    // The room precedes the optional guided-intake link and the sessions list.
    const guided = screen.getByTestId('council-chamber-guided-intake');
    const room = within(chamber).getByTestId('council-room');
    expect(precedes(room, guided)).toBe(true);
  });

  it('opening the chamber performs only the two authorized reads and starts nothing', async () => {
    const calls = installFetch();
    render(<CouncilHome />);
    await screen.findByTestId('council-sessions-list');

    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
    expect(calls.map((c) => c.url.split('?')[0]).sort()).toEqual([
      '/api/council/capabilities',
      '/api/council/sessions',
    ]);
    // No session create, no model catalog, no run start, no mutation of any kind.
    expect(calls.some((c) => c.method !== 'GET')).toBe(false);
    expect(calls.some((c) => c.url.includes('/models'))).toBe(false);
    expect(calls.some((c) => c.url.includes('/start'))).toBe(false);
  });

  it('keeps existing sessions and history reachable below the chamber', async () => {
    installFetch();
    render(<CouncilHome />);

    const list = await screen.findByTestId('council-sessions-list');
    const sessionLink = within(list).getByRole('link', { name: /sess-ctr/ });
    expect(sessionLink.getAttribute('href')).toBe('/council/sess-ctr104-fixture');
    expect(within(list).getByText(/Draft brief/)).toBeTruthy();

    const history = screen.getByTestId('council-history-link');
    expect(history.getAttribute('href')).toBe('/council/history');

    // Chamber still precedes the sessions section.
    const chamber = screen.getByTestId('council-chamber');
    expect(precedes(chamber, list)).toBe(true);
  });

  it('a denied read shows a typed error, never an empty list or invented sessions', async () => {
    installFetch({ capabilities: CAPABILITIES_DENIED, capabilitiesStatus: 403, sessionsStatus: 403, sessions: CAPABILITIES_DENIED });
    render(<CouncilHome />);

    // The visual entry itself is never gated by the read probe.
    expect(await screen.findByTestId('council-chamber')).toBeTruthy();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('COUNCIL_FORBIDDEN');
    expect(screen.queryByTestId('council-sessions-list')).toBeNull();
    expect(screen.queryByText(/Loading your sessions/)).toBeNull();
    expect(screen.queryByText(/No council sessions yet/)).toBeNull();
  });

  it('the chamber form is responsive by class contract (stacking below 40rem)', () => {
    const css = readCss();
    expect(css).toContain('.council-theme .council-chamber-ask');
    expect(css).toMatch(/@media \(max-width: 40rem\) \{[^}]*\.council-chamber-ask \{\s*flex-direction: column;/s);
    expect(css).toMatch(/\.council-chamber-ask button \{\s*min-height: var\(--council-touch-target\);/s);
  });
});

// ------------------------------------------------- chamber question prefill

describe('CTR-104 chamber question reaches the intake without re-asking', () => {
  it('normalizes, trims and caps the chamber question', () => {
    expect(normalizeChamberQuestion('  Should   we   launch?  ')).toBe('Should we launch?');
    expect(normalizeChamberQuestion('   ')).toBeNull();
    expect(normalizeChamberQuestion(null)).toBeNull();
    expect(normalizeChamberQuestion(['first', 'second'])).toBe('first');
    expect(normalizeChamberQuestion('x'.repeat(CHAMBER_QUESTION_MAX + 50))).toHaveLength(
      CHAMBER_QUESTION_MAX,
    );
  });

  it('seeds the decision text so the conversation starts at the question just asked', () => {
    installFetch();
    render(<DecisionComposer initialQuestion="Should we launch the revised offer?" />);

    const echo = screen.getByTestId('chamber-question-echo');
    expect(echo.textContent).toBe('Should we launch the revised offer?');

    // The decision step is still the current step, filled in: the client
    // confirms the structured flags instead of the answer being skipped.
    expect(screen.getByTestId('intake-step-decision')).toBeTruthy();
    const field = screen.getByLabelText('Your decision') as HTMLTextAreaElement;
    expect(field.value).toBe('Should we launch the revised offer?');
    expect(
      within(screen.getByTestId('intake-step-decision')).getAllByRole('checkbox').length,
    ).toBeGreaterThan(0);

    // The seeded text IS the decision answer (so Continue is never blocked
    // by an answer the client can see), and the flags stay editable.
    const stored = JSON.parse(
      window.localStorage.getItem(JOURNEY_DRAFT_STORAGE_KEY) ?? 'null',
    ) as JourneyDraft;
    expect(stored.answers.decision?.text).toBe('Should we launch the revised offer?');
    expect(stored.answers.decision?.flags).toEqual(emptyDecisionFlags());

    fireEvent.click(screen.getByTestId('intake-continue'));
    expect(screen.getByTestId('intake-step-options')).toBeTruthy();
  });

  it('never silently drops a saved draft: a different chamber question offers an explicit restart', () => {
    installFetch();
    const stale: JourneyDraft = {
      ...emptyJourneyDraft(),
      answers: {
        ...emptyJourneyDraft().answers,
        decision: { text: 'Old decision', flags: emptyDecisionFlags() },
        options: ['old a', 'old b'],
        success: 'old success',
      },
    };
    window.localStorage.setItem(JOURNEY_DRAFT_STORAGE_KEY, JSON.stringify(stale));

    render(<DecisionComposer initialQuestion="A different decision" />);
    expect(screen.getByTestId('chamber-question-echo').textContent).toBe('A different decision');
    // The saved draft is resumed untouched, and the notice says so.
    expect(screen.getByTestId('intake-step-constraints')).toBeTruthy();
    expect(screen.getByTestId('chamber-question-notice').textContent).toMatch(
      /saved draft answers a different decision/,
    );

    fireEvent.click(screen.getByTestId('chamber-question-restart'));

    // Explicit restart: fresh intake, decision step, chamber text seeded.
    expect(screen.getByTestId('intake-step-decision')).toBeTruthy();
    const field = screen.getByLabelText('Your decision') as HTMLTextAreaElement;
    expect(field.value).toBe('A different decision');
    const saved = JSON.parse(
      window.localStorage.getItem(JOURNEY_DRAFT_STORAGE_KEY) ?? 'null',
    ) as JourneyDraft;
    expect(saved.answers.decision?.text).toBe('A different decision');
    expect(saved.answers.options).toBeNull();
  });

  it('without a chamber question the saved draft still resumes exactly as before', () => {
    installFetch();
    const answered: JourneyDraft = {
      ...emptyJourneyDraft(),
      answers: { ...emptyJourneyDraft().answers, decision: 'Saved decision', options: ['a', 'b'] },
    };
    window.localStorage.setItem(JOURNEY_DRAFT_STORAGE_KEY, JSON.stringify(answered));

    render(<DecisionComposer />);
    expect(screen.getByTestId('intake-step-success')).toBeTruthy();
    expect(screen.queryByTestId('chamber-question-notice')).toBeNull();
  });
});
