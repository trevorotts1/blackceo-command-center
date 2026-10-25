/**
 * tests/unit/pbb129-t34-exceptions-outcomes-repair.test.ts
 *
 * PBB-129 / T-34 — repair proof for the QC FAIL verdict on commit 0f4dc6e9ca.
 *
 * Four genuine defects, each pinned by a case that FAILS against 0f4dc6e9ca and
 * PASSES after the repair:
 *
 *   D1 an adapter `load()` returning `undefined` put `state:'live'` on screen
 *      and then threw `TypeError: records is not iterable` out of
 *      `buildExceptionsOutcomesView` — contradicting the module's own hard rule
 *      "Nothing here ever throws at a route".
 *   D2 an adapter `load()` returning a non-array (a string, a number, an
 *      object) rendered an EMPTY SUCCESS — `state:'live'`, 0 rows — which is
 *      the exact failure mode the module forbids.
 *   D3 `lastClosingEvent` compared `created_at` as RAW STRINGS, so a mixed pair
 *      (sqlite `datetime('now')` writes 'YYYY-MM-DD HH:MM:SS', the app writers
 *      pass `new Date().toISOString()`) resolved the WRONG closing actor:
 *      '2026-10-24T08:00:00Z' sorts above '2026-10-24 09:00:00' as text even
 *      though it is an hour EARLIER as a time.
 *   D4 malformed records (missing/empty/non-string id, or a null record) were
 *      dropped with NO counter, so the view hid volume it had been handed.
 *
 * The 30 accepted assertions in pbb129-t34-exceptions-outcomes.test.ts are
 * untouched by this commit (that file is byte-identical to 0f4dc6e9ca).
 *
 *   node --import tsx --import ./tests/setup/no-owner-telegram.ts \
 *        --import ./tests/setup/tmp-sandbox.ts --test \
 *        tests/unit/pbb129-t34-exceptions-outcomes-repair.test.ts
 *
 * No live database: these cases are pure view-model + one throwaway in-memory
 * mapping, so nothing here opens a DB at all.
 */

import './_isolated-db'; // MUST be first DB import: throwaway DATABASE_PATH (C8 guard).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import * as ReactNamespace from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  buildExceptionsOutcomesView,
  loadSurface,
  projectAlerts,
  projectBookings,
  projectOutcomes,
  type AlertInput,
  type BookingInput,
  type OutcomeRecord,
  type SourceAdapter,
} from '../../src/lib/cc/exceptions-outcomes';
import {
  bugTicketsToAlerts,
  type BugTicketEventRow,
  type BugTicketViewRow,
} from '../../src/lib/cc/exceptions-outcomes-db';
import ClientExceptionsOutcomes from '../../src/components/ClientExceptionsOutcomes';

/* tsx compiles JSX to the classic factory; the component tree still renders
 * through react-dom/server, so the React namespace is installed as B25 does. */
(globalThis as Record<string, unknown>).React = ReactNamespace;

/** An adapter whose `load()` returns whatever the probe needs, valid or not. */
function brokenAdapter<T>(value: unknown, name = 'ghl'): SourceAdapter<T> {
  return { name, load: () => value as readonly T[] };
}

function alert(overrides: Partial<AlertInput> = {}): AlertInput {
  return {
    id: 'BUG-1',
    surface: 'failures',
    severity: 'P1 degraded',
    title: 'Webhook retries stalled',
    owner: { assigned_agent_id: 'agent-healer-1' },
    first_seen_at: '2026-10-24T08:00:00.000Z',
    last_seen_at: '2026-10-24T10:00:00.000Z',
    revision: 3,
    ...overrides,
  };
}

function ticket(overrides: Partial<BugTicketViewRow> = {}): BugTicketViewRow {
  return {
    id: 'BUG-T',
    symptom: 'Opt-out webhook was ignored',
    severity: 'P1 degraded',
    client_slug: 'client-acorn',
    status: 'CLOSED',
    assigned_healer_agent_id: null,
    dedup_of: null,
    recurrence_count: 0,
    evidence_paths: null,
    healing_report_path: 'evidence/healing/BUG-T.json',
    fix_summary: null,
    closed_at: '2026-10-24 09:30:00',
    reported_at: '2026-10-24 07:00:00',
    updated_at: '2026-10-24 10:00:00',
    ...overrides,
  };
}

function closing(actor: string, created_at: string): BugTicketEventRow {
  return { bug_id: 'BUG-T', to_status: 'CLOSED', actor, reason: null, created_at };
}

/* ─────────────────────────────────── D1: an undefined return never crashes */

test('D1: an adapter returning undefined is UNKNOWN, and the view never throws', () => {
  const surface = loadSurface<BookingInput>(brokenAdapter<BookingInput>(undefined), 'bookings');
  assert.equal(surface.state, 'unknown', 'undefined is not a working empty snapshot');
  assert.equal(surface.reason, 'bookings_adapter_invalid_return:undefined');
  assert.deepEqual(surface.items, []);

  // The exact route path that used to throw `TypeError: records is not iterable`.
  const view = buildExceptionsOutcomesView({
    tenantSlug: 'client-acorn',
    failures: brokenAdapter<AlertInput>(undefined, 'bug_tickets'),
    bookings: brokenAdapter<BookingInput>(undefined),
    outcomes: brokenAdapter<OutcomeRecord>(undefined),
  });

  assert.equal(view.failures.state, 'unknown');
  assert.equal(view.failures.reason, 'failures_adapter_invalid_return:undefined');
  assert.equal(view.bookings.state, 'unknown');
  assert.equal(view.bookings.reason, 'bookings_adapter_invalid_return:undefined');
  assert.equal(view.outcomes.state, 'unknown');
  assert.equal(view.outcomes.reason, 'outcomes_adapter_invalid_return:undefined');

  // And the render path, which is what a route actually serves.
  const html = renderToStaticMarkup(h(ClientExceptionsOutcomes, { view }));
  assert.match(html, /data-reason="bookings_adapter_invalid_return:undefined"/);
  assert.doesNotMatch(html, /No bookings in this period/);
});

/* ─────────────────────────── D2: a non-array return is UNKNOWN, never 0 rows */

test('D2: a non-array adapter return is UNKNOWN with a named reason, never an empty success', () => {
  for (const value of ['oops', 42, {}, true, Symbol.iterator]) {
    const surface = loadSurface<BookingInput>(brokenAdapter<BookingInput>(value), 'bookings');
    assert.equal(surface.state, 'unknown', `${String(value)} must not render live`);
    assert.match(
      surface.reason ?? '',
      /^bookings_adapter_invalid_return:/,
      'the reason names what came back',
    );
    assert.deepEqual(surface.items, []);
  }

  // A string is iterable, so it used to render as a LIVE 0-row success.
  const view = buildExceptionsOutcomesView({
    tenantSlug: 'client-acorn',
    failures: null,
    bookings: brokenAdapter<BookingInput>('oops'),
    outcomes: null,
  });
  assert.equal(view.bookings.state, 'unknown');
  assert.deepEqual(view.bookings.rows, []);
  assert.equal(view.bookings.reason, 'bookings_adapter_invalid_return:string');

  const html = renderToStaticMarkup(h(ClientExceptionsOutcomes, { view }));
  assert.doesNotMatch(html, /No bookings in this period/, 'never an empty success');
  assert.match(html, /data-unknown="true"/);

  // Inverse still holds: a real EMPTY array is a proven zero and stays live.
  const proven = loadSurface<BookingInput>({ name: 'ghl', load: () => [] }, 'bookings');
  assert.equal(proven.state, 'live');
  assert.equal(proven.reason, null);
});

/* ────────────── D3: the closing actor is the latest by TIME, not by string */

test('D3: mixed timestamp formats resolve to the genuinely latest closing actor', () => {
  // sqlite `datetime('now')` writes 'YYYY-MM-DD HH:MM:SS'; src/lib/bug-lifecycle.ts
  // and src/app/api/bugs/route.ts both pass new Date().toISOString(). Both
  // formats exist in bug_ticket_events.
  const sqliteClose = closing('RIGHT-ACTOR', '2026-10-24 09:00:00'); // 09:00Z
  const isoClose = closing('WRONG-ACTOR', '2026-10-24T08:00:00Z'); // 08:00Z

  for (const order of [[sqliteClose, isoClose], [isoClose, sqliteClose]]) {
    const rows = bugTicketsToAlerts([ticket()], order);
    assert.equal(
      rows[0].clearance?.by,
      'RIGHT-ACTOR',
      '09:00 is later than 08:00 however the two rows are ordered',
    );
  }

  // Inverse: a genuinely later ISO close still wins over an earlier sqlite one.
  const laterIso = bugTicketsToAlerts(
    [ticket()],
    [closing('EARLIER-SQLITE', '2026-10-24 08:00:00'), closing('LATER-ISO', '2026-10-24T09:00:00Z')],
  );
  assert.equal(laterIso[0].clearance?.by, 'LATER-ISO');

  // Inverse: a same-format pair is still ordered by time.
  const sameFormat = bugTicketsToAlerts(
    [ticket()],
    [closing('OLD', '2026-10-24T07:00:00Z'), closing('NEW', '2026-10-24T10:00:00Z')],
  );
  assert.equal(sameFormat[0].clearance?.by, 'NEW');

  // An unproven timestamp never outranks a proven one.
  const unproven = bugTicketsToAlerts(
    [ticket()],
    [closing('RIGHT-ACTOR', '2026-10-24 09:00:00'), closing('WRONG-ACTOR', 'not-a-time')],
  );
  assert.equal(unproven[0].clearance?.by, 'RIGHT-ACTOR');
});

/* ───────────────────────── D4: malformed records are counted, never dropped */

test('D4: malformed booking records are counted, not silently dropped', () => {
  const projection = projectBookings([
    { id: 'B-1', status: 'requested' },
    { id: '', status: 'requested' },
    null,
    { id: 42, status: 'requested' },
  ] as unknown as BookingInput[]);

  assert.equal(projection.rows.length, 1, 'one usable record');
  assert.equal(projection.excluded_malformed, 3, 'the other three are reported, not hidden');
  assert.equal(projection.unknown, 0);
});

test('D4: malformed outcome records are counted separately from unrecognised kinds', () => {
  const view = projectOutcomes([
    { id: 'o1', kind: 'sale', verified: true, evidence: 'invoice-1', attribution: 'observed_keyword' },
    { id: '', kind: 'sale', verified: true, evidence: 'invoice-2', attribution: 'observed_keyword' },
    { id: null, kind: 'gift', verified: true, evidence: 'd-1', attribution: 'unknown' },
    null,
  ] as unknown as OutcomeRecord[]);

  assert.equal(view.counts.sale.count, 1, 'the usable sale is still one sale');
  assert.equal(view.excluded_unrecognised_kind, 0, 'malformed is not the same as unrecognised');
  assert.equal(view.excluded_malformed, 3);
});

test('D4: malformed alert records are counted, and the fold never loses them silently', () => {
  const projection = projectAlerts([
    alert({ id: 'A-1' }),
    alert({ id: '' }),
    null,
    alert({ id: 7 as unknown as string }),
  ] as unknown as AlertInput[]);

  assert.equal(projection.rows.length, 1);
  assert.equal(projection.folded, 0, 'malformed is not a duplicate fold');
  assert.equal(projection.excluded_malformed, 3);
});

test('D4: the whole view carries the counter and the client is shown it', () => {
  const view = buildExceptionsOutcomesView({
    tenantSlug: 'client-acorn',
    failures: {
      state: 'live',
      reason: null,
      adapter: 'bug_tickets',
      items: [alert({ id: 'A-1' }), alert({ id: '' })] as unknown as AlertInput[],
    },
    bookings: brokenAdapter<BookingInput>([{ id: 'B-1', status: 'requested' }, null]),
    outcomes: [
      { id: 'o1', kind: 'sale', verified: true, evidence: 'e1', attribution: 'observed_keyword' },
      { id: '', kind: 'sale', verified: true, evidence: 'e2', attribution: 'observed_keyword' },
    ] as unknown as OutcomeRecord[],
  });

  assert.equal(view.failures.excluded_malformed, 1);
  assert.equal(view.bookings.excluded_malformed, 1);
  assert.equal(view.outcomes.excluded_malformed, 1);

  const html = renderToStaticMarkup(h(ClientExceptionsOutcomes, { view }));
  const rendered = html.match(/data-excluded-malformed="1"/g) ?? [];
  assert.equal(rendered.length, 3, 'every surface that lost a record says so on screen');
});

test('D4: an unknown surface reports the counter as UNKNOWN, never as a zero', () => {
  const view = buildExceptionsOutcomesView({
    tenantSlug: null,
    failures: null,
    bookings: null,
    outcomes: null,
  });
  assert.equal(view.failures.excluded_malformed, null);
  assert.equal(view.bookings.excluded_malformed, null);
  assert.equal(view.outcomes.excluded_malformed, null);
});

/* ─────────────────────────── total functions: junk input cannot throw here */

test('the projections are total: a non-array input is UNKNOWN, never a crash and never 0', () => {
  const alerts = projectAlerts(undefined as unknown as AlertInput[]);
  assert.deepEqual(alerts.rows, []);
  assert.equal(alerts.excluded_malformed, null, 'null means UNKNOWN');

  const bookings = projectBookings('oops' as unknown as BookingInput[]);
  assert.deepEqual(bookings.rows, []);
  assert.equal(bookings.excluded_malformed, null);

  const outcomes = projectOutcomes(undefined as unknown as OutcomeRecord[]);
  assert.equal(outcomes.state, 'unknown');
  assert.equal(outcomes.counts.sale.count, null);
  assert.equal(outcomes.excluded_malformed, null);

  // Inverse: the documented `null` input is still the absent-adapter verdict.
  assert.equal(projectOutcomes(null).reason, 'no_outcome_adapter');
});
