/**
 * tests/unit/pbb129-t34-exceptions-outcomes.test.ts
 *
 * PBB-129 / T-34 — Command Center booking, failure and outcome views.
 *
 * Acceptance (build.json): "P0–P3 ownership/coalescing/clearance; real adapter
 * data and useful client workload." Every clause below is pinned, including
 * the unknown and refusal cases. Assertions are exact — nothing is weakened.
 *
 *   npm test:unit -- tests/unit/pbb129-t34-exceptions-outcomes.test.ts
 *   node --import tsx --test tests/unit/pbb129-t34-exceptions-outcomes.test.ts
 *
 * The DB-backed cases run against a THROWAWAY sqlite file created per suite in
 * os.tmpdir() (honours TMPDIR): the real `bug_tickets` + `bug_ticket_events`
 * DDL and the real loader SQL. No live database is opened.
 */

import './_isolated-db'; // MUST be first DB import: throwaway DATABASE_PATH (C8 guard).
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import * as ReactNamespace from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  applySurfaceSnapshot,
  authorizeClearanceCommand,
  buildClientWorkload,
  buildExceptionsOutcomesView,
  loadSurface,
  nextActionFor,
  priorityFromSeverity,
  projectAlerts,
  projectBookings,
  projectOutcomes,
  resolveClearance,
  resolveOwner,
  unknownOutcomeView,
  type AlertInput,
  type AlertRow,
  type BookingInput,
  type OutcomeRecord,
} from '../../src/lib/cc/exceptions-outcomes';
import {
  bugTicketsToAlerts,
  loadFailureAlerts,
  type BugTicketEventRow,
  type BugTicketViewRow,
} from '../../src/lib/cc/exceptions-outcomes-db';
import ClientExceptionsOutcomes from '../../src/components/ClientExceptionsOutcomes';

/* tsx compiles JSX to the classic factory; the component tree still renders
 * through react-dom/server, so the React namespace is installed as B25 does. */
(globalThis as Record<string, unknown>).React = ReactNamespace;

const NOW = '2026-10-24T12:00:00.000Z';

function alert(overrides: Partial<AlertInput> = {}): AlertInput {
  const base: AlertInput = {
    id: 'BUG-1',
    surface: 'failures',
    severity: 'P1 degraded',
    title: 'Webhook retries stalled',
    owner: { assigned_agent_id: 'agent-healer-1' },
    first_seen_at: '2026-10-24T08:00:00.000Z',
    last_seen_at: '2026-10-24T10:00:00.000Z',
    revision: 3,
  };
  return { ...base, ...overrides };
}

/* ────────────────────────────────────────────── 1. P0–P3 classification */

test('priority: the four REAL BugSeverity values classify; anything else is UNKNOWN (never a default)', () => {
  assert.deepEqual(priorityFromSeverity('P0 run-dead'), { priority: 'P0', reason: null });
  assert.deepEqual(priorityFromSeverity('P1 degraded'), { priority: 'P1', reason: null });
  assert.deepEqual(priorityFromSeverity('P2 cosmetic or latent'), { priority: 'P2', reason: null });
  assert.deepEqual(priorityFromSeverity('P3 improvement'), { priority: 'P3', reason: null });
  assert.deepEqual(priorityFromSeverity('P1'), { priority: 'P1', reason: null });

  assert.deepEqual(priorityFromSeverity('urgent-ish'), {
    priority: null,
    reason: 'unrecognised_severity:urgent-ish',
  });
  assert.deepEqual(priorityFromSeverity(''), { priority: null, reason: 'severity_missing' });
  assert.deepEqual(priorityFromSeverity(null), { priority: null, reason: 'severity_missing' });
  assert.deepEqual(priorityFromSeverity('P9 catastrophic'), {
    priority: null,
    reason: 'unrecognised_severity:P9 catastrophic',
  });
});

test('ownership: exactly one named owner, or an explicit unowned with a reason', () => {
  assert.deepEqual(resolveOwner({ assigned_agent_id: 'agent-7', assigned_agent_name: 'Healer' }), {
    owner: { kind: 'agent', id: 'agent-7', name: 'Healer' },
    reason: null,
  });
  assert.deepEqual(resolveOwner({ assigned_agent_name: 'Healer' }), {
    owner: { kind: 'agent', id: null, name: 'Healer' },
    reason: null,
  });
  assert.deepEqual(resolveOwner({ owner_name: 'Trevor' }), {
    owner: { kind: 'human', id: null, name: 'Trevor' },
    reason: null,
  });
  assert.deepEqual(resolveOwner({ assigned_agent_id: '   ' }), {
    owner: { kind: 'unowned', id: null, name: null },
    reason: 'owner_not_assigned',
  });
  assert.deepEqual(resolveOwner(null), {
    owner: { kind: 'unowned', id: null, name: null },
    reason: 'owner_not_assigned',
  });

  assert.equal(nextActionFor('P0', 'unowned'), 'Name one owner now, then halt and repair the affected scope.');
  assert.equal(nextActionFor('P3', 'agent'), 'Queue for the monthly review.');
  assert.equal(nextActionFor(null, 'agent'), 'Classify the severity before acting on this item.');
});

/* ─────────────────────────────────────────────── 2. Coalescing */

test('coalescing: a dedup_of child folds into its parent, and the folded volume stays visible', () => {
  const projection = projectAlerts([
    alert({ id: 'BUG-PARENT', severity: 'P1 degraded' }),
    alert({ id: 'BUG-CHILD-1', dedup_of: 'BUG-PARENT', severity: 'P1 degraded' }),
    alert({ id: 'BUG-CHILD-2', dedup_of: 'BUG-PARENT', severity: 'P1 degraded' }),
  ]);

  assert.equal(projection.rows.length, 1);
  const row = projection.rows[0];
  assert.equal(row.id, 'BUG-PARENT');
  assert.equal(row.coalesced_count, 3, 'three records, one client row');
  assert.deepEqual(row.coalesced_ids, ['BUG-CHILD-1', 'BUG-CHILD-2', 'BUG-PARENT']);
  assert.equal(projection.folded, 2);
  assert.equal(row.state, 'open');
  assert.equal(row.priority, 'P1');
});

test('coalescing: deterministic regardless of input order, and a chained dedup folds to the canonical root', () => {
  const records = [
    alert({ id: 'C', dedup_of: 'B', last_seen_at: '2026-10-24T09:00:00.000Z' }),
    alert({ id: 'A', last_seen_at: '2026-10-24T11:00:00.000Z' }),
    alert({ id: 'B', dedup_of: 'A', last_seen_at: '2026-10-24T10:00:00.000Z' }),
  ];
  const forward = projectAlerts(records);
  const reversed = projectAlerts([...records].reverse());

  assert.equal(forward.rows.length, 1);
  assert.equal(reversed.rows.length, 1);
  assert.equal(forward.rows[0].id, 'A', 'the chain resolves to the canonical root');
  assert.deepEqual(forward.rows[0].coalesced_ids, reversed.rows[0].coalesced_ids);
  assert.equal(forward.folded, 2);
  assert.equal(reversed.folded, 2);
  assert.equal(forward.rows[0].last_seen_at, '2026-10-24T11:00:00.000Z');
});

test('coalescing: unlinked duplicates collapse on the explicit fingerprint, never on the title alone', () => {
  const projection = projectAlerts([
    alert({ id: 'B-1', fingerprint: 'smtp-auth', severity: 'P2 cosmetic or latent' }),
    alert({ id: 'B-2', fingerprint: 'smtp-auth', severity: 'P2 cosmetic or latent' }),
    alert({ id: 'B-3', severity: 'P2 cosmetic or latent' }), // same title, NO fingerprint
  ]);

  assert.equal(projection.rows.length, 2, 'only the fingerprinted pair coalesces');
  const grouped = projection.rows.find((row) => row.coalesced_count === 2)!;
  assert.deepEqual(grouped.coalesced_ids, ['B-1', 'B-2']);
  assert.equal(projection.folded, 1, 'exactly one record was folded, not two');
  assert.ok(projection.rows.some((row) => row.id === 'B-3'), 'an unlinked twin keeps its own row');
});

test('coalescing: an orphan dedup parent and a dedup cycle are UNKNOWN, never dropped and never "fine"', () => {
  const projection = projectAlerts([
    alert({ id: 'ORPHAN', dedup_of: 'NOT-IN-SNAPSHOT' }),
    alert({ id: 'CYCLE-A', dedup_of: 'CYCLE-B' }),
    alert({ id: 'CYCLE-B', dedup_of: 'CYCLE-A' }),
  ]);

  assert.deepEqual(projection.orphans, ['ORPHAN']);
  assert.deepEqual(projection.cycles, ['CYCLE-A', 'CYCLE-B']);

  const orphan = projection.rows.find((row) => row.id === 'ORPHAN')!;
  assert.equal(orphan.state, 'unknown');
  assert.equal(orphan.unknown_reason, 'dedup_parent_missing:NOT-IN-SNAPSHOT');

  const cycleA = projection.rows.find((row) => row.id === 'CYCLE-A')!;
  assert.equal(cycleA.state, 'unknown');
  assert.equal(cycleA.unknown_reason, 'dedup_cycle');
  assert.equal(projection.rows.length, 3, 'nothing vanished');
});

test('coalescing: a repeated id keeps the newest revision so a replay cannot resurrect an older state', () => {
  const projection = projectAlerts([
    alert({ id: 'BUG-1', revision: 2, title: 'old' }),
    alert({ id: 'BUG-1', revision: 9, title: 'new' }),
  ]);
  assert.equal(projection.rows.length, 1);
  assert.equal(projection.rows[0].title, 'new');
  assert.equal(projection.rows[0].revision, 9);
  assert.equal(projection.folded, 1);
});

test('coalescing: a P0 member can never be downgraded by a less severe sibling', () => {
  const projection = projectAlerts([
    alert({ id: 'ROOT', severity: 'P3 improvement' }),
    alert({ id: 'CHILD', dedup_of: 'ROOT', severity: 'P0 run-dead' }),
  ]);
  const row = projection.rows[0];
  assert.equal(row.priority, 'P0');
  assert.equal(row.priority_conflict, true);
});

test('coalescing: an unclassifiable member is named on the row instead of being averaged away', () => {
  const projection = projectAlerts([
    alert({ id: 'ROOT', severity: 'P2 cosmetic or latent' }),
    alert({ id: 'CHILD', dedup_of: 'ROOT', severity: 'very bad' }),
  ]);
  const row = projection.rows[0];
  assert.equal(row.priority, 'P2');
  assert.deepEqual(row.unknown_member_ids, ['CHILD']);
  assert.equal(row.unknown_reason, 'member_severity_unknown:CHILD');
});

/* ─────────────────────────────────────────────── 3. Clearance */

test('clearance: cleared requires time + actor + evidence; a partial proof is clearance_unknown', () => {
  assert.deepEqual(resolveClearance(null), {
    state: 'open',
    reason: null,
    missing: [],
    by: null,
    at: null,
    evidence: null,
  });

  const partial = resolveClearance({ at: NOW, by: 'agent-healer-1' });
  assert.equal(partial.state, 'clearance_unknown');
  assert.deepEqual(partial.missing, ['evidence']);
  assert.equal(partial.reason, 'clearance_missing:evidence');

  const full = resolveClearance({ at: NOW, by: 'agent-healer-1', evidence: 'report.json' });
  assert.equal(full.state, 'cleared');
  assert.equal(full.reason, null);
});

test('clearance: a CLOSED record with no closing actor cannot claim cleared', () => {
  const projection = projectAlerts([
    alert({
      id: 'CLEARED-1',
      clearance: { at: NOW, by: 'agent-healer-1', evidence: 'report.json' },
    }),
    alert({ id: 'NO-ACTOR', clearance: { at: NOW, by: null, evidence: 'report.json' } }),
  ]);

  assert.equal(projection.rows.find((row) => row.id === 'CLEARED-1')!.state, 'cleared');
  const noActor = projection.rows.find((row) => row.id === 'NO-ACTOR')!;
  assert.equal(noActor.state, 'clearance_unknown');
  assert.equal(noActor.unknown_reason, 'clearance_missing:by');
});

test('clearance: a coalesced group is open while one member is open, and flags the partial clearance', () => {
  const projection = projectAlerts([
    alert({ id: 'ROOT', dedup_of: null }),
    alert({
      id: 'CHILD',
      dedup_of: 'ROOT',
      clearance: { at: NOW, by: 'agent-healer-1', evidence: 'report.json' },
    }),
  ]);
  const row = projection.rows[0];
  assert.equal(row.state, 'open');
  assert.equal(row.cleared_partially, true);
});

test('clearance command: stale revision, missing actor/evidence and repeat clearing are refused', () => {
  const projection = projectAlerts([alert({ id: 'BUG-1', revision: 5 })]);
  const row = projection.rows[0];

  assert.deepEqual(authorizeClearanceCommand(row, {
    item_id: 'BUG-1',
    actor: 'agent-healer-1',
    expected_revision: 5,
    evidence: 'report.json',
  }), { accepted: true, reason: null });

  assert.deepEqual(authorizeClearanceCommand(row, {
    item_id: 'BUG-1',
    actor: 'agent-healer-1',
    expected_revision: 4,
    evidence: 'report.json',
  }), { accepted: false, reason: 'revision_conflict:4_!=_5' });

  assert.deepEqual(authorizeClearanceCommand(row, {
    item_id: 'BUG-1',
    actor: '',
    expected_revision: 5,
    evidence: 'report.json',
  }), { accepted: false, reason: 'actor_required' });

  assert.deepEqual(authorizeClearanceCommand(row, {
    item_id: 'BUG-1',
    actor: 'agent-healer-1',
    expected_revision: 5,
    evidence: null,
  }), { accepted: false, reason: 'evidence_required' });

  assert.deepEqual(authorizeClearanceCommand(row, {
    item_id: 'BUG-1',
    actor: 'agent-healer-1',
    expected_revision: null,
    evidence: 'report.json',
  }), { accepted: false, reason: 'expected_revision_required' });

  assert.deepEqual(authorizeClearanceCommand(null, {
    item_id: 'BUG-1',
    actor: 'agent-healer-1',
    expected_revision: 5,
    evidence: 'report.json',
  }), { accepted: false, reason: 'item_not_found' });

  const cleared = projectAlerts([
    alert({ id: 'BUG-1', revision: 5, clearance: { at: NOW, by: 'a', evidence: 'e' } }),
  ]).rows[0];
  assert.deepEqual(authorizeClearanceCommand(cleared, {
    item_id: 'BUG-1',
    actor: 'agent-healer-1',
    expected_revision: 5,
    evidence: 'report.json',
  }), { accepted: false, reason: 'already_cleared' });
});

/* ─────────────────────────────────────────── 4. Useful client workload */

test('workload: P0/P1 are individual items, P2 is one digest line, P3 one monthly line, cleared excluded', () => {
  const projection = projectAlerts([
    alert({ id: 'P0', severity: 'P0 run-dead' }),
    alert({ id: 'P1', severity: 'P1 degraded' }),
    alert({ id: 'P2-A', severity: 'P2 cosmetic or latent', surface: 'failures' }),
    alert({ id: 'P2-B', severity: 'P2 cosmetic or latent', surface: 'bookings' }),
    alert({ id: 'P3', severity: 'P3 improvement' }),
    alert({ id: 'GONE', severity: 'P3 improvement', clearance: { at: NOW, by: 'a', evidence: 'e' } }),
  ]);

  const workload = buildClientWorkload(projection.rows, projection.folded);

  assert.deepEqual(workload.immediate.items.map((item) => item.id), ['P0', 'P1']);
  assert.equal(workload.digest.items.length, 0, 'P2 is a digest, not a firehose');
  assert.equal(workload.digest.rollup!.count, 2);
  assert.deepEqual(workload.digest.rollup!.by_surface, { bookings: 1, failures: 1 });
  assert.equal(workload.monthly.items.length, 0);
  assert.equal(workload.monthly.rollup!.count, 1, 'the cleared P3 is excluded from the monthly queue');

  assert.equal(workload.totals.open, 5);
  assert.equal(workload.totals.cleared, 1);
  assert.equal(workload.totals.unclassified, 0);
  assert.equal(workload.immediate.items[0].next_action, 'Halt the affected scope, then reconcile the unsafe action.');
});

test('workload: an unclassifiable severity gets its own visible section, never a roll-up bucket', () => {
  const projection = projectAlerts([alert({ id: 'MYSTERY', severity: 'weird' })]);
  const workload = buildClientWorkload(projection.rows, projection.folded);

  assert.equal(workload.immediate.items.length, 0);
  assert.equal(workload.digest.rollup!.count, 0);
  assert.equal(workload.unknown.items.length, 1);
  assert.equal(workload.unknown.items[0].unknown_reason, 'unrecognised_severity:weird');
  assert.equal(workload.totals.unclassified, 1);
});

/* ───────────────────────────────────────────── 5. C-F13 stale snapshot */

test('snapshot: only the exact next revision applies; equal, lower, gapped and missing revisions are refused', () => {
  const v1 = applySurfaceSnapshot<AlertInput>(null, { revision: 1, items: [alert()] });
  assert.equal(v1.outcome, 'applied');
  assert.equal(v1.state, 'live');
  assert.equal(v1.snapshot!.revision, 1);

  const replay = applySurfaceSnapshot<AlertInput>(v1.snapshot, { revision: 1, items: [alert()] });
  assert.equal(replay.outcome, 'stale_ignored');
  assert.equal(replay.state, 'live');
  assert.equal(replay.reason, 'stale_revision_replayed:1');
  assert.equal(replay.snapshot!.revision, 1);

  const conflict = applySurfaceSnapshot<AlertInput>(v1.snapshot, {
    revision: 1,
    items: [alert({ title: 'a different writer at the same revision' })],
  });
  assert.equal(conflict.outcome, 'revision_conflict');
  assert.equal(conflict.state, 'unknown');
  assert.equal(conflict.reason, 'revision_conflict:1');

  const behind = applySurfaceSnapshot(
    { revision: 5, items: [alert()] },
    { revision: 4, items: [alert()] },
  );
  assert.equal(behind.outcome, 'stale_ignored');
  assert.equal(behind.reason, 'stale_revision:4_behind_5');
  assert.equal(behind.snapshot!.revision, 5, 'the newer held snapshot is kept');

  const gap = applySurfaceSnapshot<AlertInput>(v1.snapshot, { revision: 4, items: [alert()] });
  assert.equal(gap.outcome, 'revision_gap');
  assert.equal(gap.state, 'unknown');
  assert.equal(gap.reason, 'revision_gap:1_to_4_reload_required');
  assert.equal(gap.snapshot!.revision, 1, 'a gapped delta is never rendered as complete');

  const missing = applySurfaceSnapshot<AlertInput>(v1.snapshot, {
    revision: Number.NaN,
    items: [alert()],
  });
  assert.equal(missing.outcome, 'unproven');
  assert.equal(missing.state, 'unknown');
  assert.equal(missing.reason, 'revision_missing');
});

/* ───────────────────────────────────────────── 6. Bookings (R-18) */

test('bookings: the receipt proves the stage; the adapter label alone does not', () => {
  const records: BookingInput[] = [
    { id: 'B-REQ', status: 'requested', requested_at: NOW },
    { id: 'B-CLAIMED', status: 'confirmed' },
    { id: 'B-CONFIRMED', status: 'confirmed', confirmation_receipt: 'cal-evt-1' },
    { id: 'B-COMPLETE-NO-RECEIPT', status: 'completed', confirmation_receipt: 'cal-evt-1' },
    { id: 'B-SERVICED', status: 'completed', confirmation_receipt: 'cal-evt-1', service_receipt: 'service-1' },
    { id: 'B-OUTCOME', status: 'completed', confirmation_receipt: 'cal-evt-1', service_receipt: 'service-1', outcome: { kind: 'sale', verified: true, evidence: 'invoice-1' } },
    { id: 'B-OUTCOME-UNPROVEN', status: 'completed', confirmation_receipt: 'cal-evt-1', service_receipt: 'service-1', outcome: { kind: 'sale', verified: true } },
    { id: 'B-WEIRD', status: 'teleported' },
  ];

  const { rows, unknown } = projectBookings(records);
  const byId = new Map(rows.map((row) => [row.id, row]));

  assert.deepEqual(
    { stage: byId.get('B-REQ')!.stage, state: byId.get('B-REQ')!.state },
    { stage: 'requested', state: 'live' },
  );
  assert.equal(byId.get('B-CLAIMED')!.stage, 'unknown');
  assert.equal(byId.get('B-CLAIMED')!.reason, 'confirmation_unproven');
  assert.equal(byId.get('B-CONFIRMED')!.stage, 'confirmed');
  assert.equal(byId.get('B-COMPLETE-NO-RECEIPT')!.reason, 'service_unproven');
  assert.equal(byId.get('B-COMPLETE-NO-RECEIPT')!.state, 'unknown');
  assert.equal(byId.get('B-SERVICED')!.stage, 'serviced');
  assert.equal(byId.get('B-OUTCOME')!.stage, 'outcome_recorded');
  assert.equal(byId.get('B-OUTCOME-UNPROVEN')!.reason, 'outcome_unproven');
  assert.equal(byId.get('B-WEIRD')!.stage, 'unknown');
  assert.equal(byId.get('B-WEIRD')!.reason, 'unrecognised_booking_status:teleported');

  assert.equal(unknown, 4);
  assert.deepEqual(
    rows.filter((row) => row.state === 'unknown').map((row) => row.id),
    ['B-CLAIMED', 'B-COMPLETE-NO-RECEIPT', 'B-OUTCOME-UNPROVEN', 'B-WEIRD'],
    'exactly the four unproven records, each for its own named reason',
  );
  for (const row of rows) assert.equal(row.counts_as_sale, false, 'a booking is never revenue');
});

/* ─────────────────────────────────────────── 7. Outcomes (R-20 / T-30) */

test('outcomes: no adapter renders UNKNOWN counts, never zero', () => {
  for (const value of [null, undefined]) {
    const view = value === undefined ? unknownOutcomeView() : projectOutcomes(null);
    assert.equal(view.state, 'unknown');
    assert.equal(view.reason, 'no_outcome_adapter');
    for (const kind of ['gift', 'contact', 'booking', 'sale'] as const) {
      assert.equal(view.counts[kind].state, 'unknown');
      assert.equal(view.counts[kind].count, null, `${kind} is UNKNOWN, not 0`);
      assert.equal(view.counts[kind].reason, 'no_outcome_adapter');
    }
    assert.equal(view.attribution.buckets.observed_keyword, null);
    assert.equal(view.excluded_unrecognised_kind, null, 'even the excluded counter is UNKNOWN');
  }
});

test('outcomes: an empty REAL snapshot is a proven zero', () => {
  const view = projectOutcomes([]);
  assert.equal(view.state, 'live');
  assert.equal(view.reason, null);
  for (const kind of ['gift', 'contact', 'booking', 'sale'] as const) {
    assert.equal(view.counts[kind].state, 'live');
    assert.equal(view.counts[kind].count, 0);
  }
  assert.deepEqual(view.attribution.buckets, { observed_keyword: 0, unknown: 0, multitouch: 0 });
  assert.equal(view.excluded_unrecognised_kind, 0);
});

test('outcomes: gift/contact/booking/sale are counted independently — a booking is not a sale', () => {
  const records: OutcomeRecord[] = [
    { id: 'o1', kind: 'gift', verified: true, evidence: 'delivery-1', attribution: 'observed_keyword' },
    { id: 'o2', kind: 'contact', verified: true, evidence: 'contact-1', attribution: 'observed_keyword' },
    { id: 'o3', kind: 'booking', verified: true, evidence: 'booking-1', attribution: 'multitouch' },
    { id: 'o4', kind: 'sale', verified: true, evidence: 'invoice-1', attribution: 'observed_keyword' },
  ];
  const view = projectOutcomes(records);

  assert.deepEqual(
    {
      gift: view.counts.gift.count,
      contact: view.counts.contact.count,
      booking: view.counts.booking.count,
      sale: view.counts.sale.count,
    },
    { gift: 1, contact: 1, booking: 1, sale: 1 },
    'one booking stays one booking; the sale count is its own fact',
  );
  assert.deepEqual(view.attribution.buckets, { observed_keyword: 3, unknown: 0, multitouch: 1 });
});

test('outcomes: unproven and unrecognised records are excluded from counts but never hidden', () => {
  const view = projectOutcomes([
    { id: 'u1', kind: 'sale', verified: false, evidence: 'x', attribution: 'observed_keyword' },
    { id: 'u2', kind: 'sale', verified: true, evidence: null, attribution: 'observed_keyword' },
    { id: 'u3', kind: 'refund', verified: true, evidence: 'r1', attribution: 'weird-channel' },
  ]);

  assert.equal(view.counts.sale.count, 0, 'unproven sales are not counted as sales');
  assert.equal(view.counts.sale.excluded_unproven, 2);
  assert.equal(view.excluded_unrecognised_kind, 1, 'the unknown kind is reported, never folded in');
  for (const kind of ['gift', 'contact', 'booking', 'sale'] as const) {
    assert.equal(view.counts[kind].count, 0, `${kind} is not inflated by an unrecognised kind`);
  }
  assert.deepEqual(view.attribution.buckets, { observed_keyword: 2, unknown: 1, multitouch: 0 });
});

/* ─────────────────────────────────── 8. Real adapter data (bug_tickets) */

let root: string;
let db: Database.Database;

function createSchema(handle: Database.Database): void {
  handle.exec(`
    CREATE TABLE bug_tickets (
      id TEXT PRIMARY KEY,
      workspace_id TEXT DEFAULT 'bugs',
      reporter_department TEXT NOT NULL,
      reporter_specialist TEXT,
      reporter_run_id TEXT,
      symptom TEXT NOT NULL,
      severity TEXT DEFAULT 'P1 degraded'
        CHECK (severity IN ('P0 run-dead','P1 degraded','P2 cosmetic or latent','P3 improvement')),
      suspected_layer TEXT,
      client_slug TEXT,
      status TEXT DEFAULT 'REPORTED'
        CHECK (status IN ('REPORTED','TRIAGED','HEALING','VERIFYING','HEALED','REGRESSION WATCH','CLOSED')),
      assigned_healer_agent_id TEXT,
      dedup_of TEXT,
      recurrence_count INTEGER DEFAULT 0,
      evidence_paths TEXT,
      regression_watch_until TEXT,
      root_cause TEXT,
      fix_summary TEXT,
      healing_report_path TEXT,
      reported_at TEXT DEFAULT (datetime('now')),
      closed_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE bug_ticket_events (
      id TEXT PRIMARY KEY,
      bug_id TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      actor TEXT,
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

type TicketSeed = Partial<BugTicketViewRow> & { id: string };

function seedTicket(ticket: TicketSeed): void {
  db.prepare(
    `INSERT INTO bug_tickets (
       id, reporter_department, symptom, severity, client_slug, status,
       assigned_healer_agent_id, dedup_of, recurrence_count, evidence_paths,
       fix_summary, healing_report_path, reported_at, closed_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ticket.id,
    'bugs',
    ticket.symptom ?? `Symptom ${ticket.id}`,
    ticket.severity ?? 'P1 degraded',
    ticket.client_slug ?? null,
    ticket.status ?? 'REPORTED',
    ticket.assigned_healer_agent_id ?? null,
    ticket.dedup_of ?? null,
    ticket.recurrence_count ?? 0,
    ticket.evidence_paths ?? null,
    ticket.fix_summary ?? null,
    ticket.healing_report_path ?? null,
    ticket.reported_at ?? '2026-10-24 08:00:00',
    ticket.closed_at ?? null,
    ticket.updated_at ?? '2026-10-24 10:00:00',
  );
}

function seedEvent(id: string, bugId: string, toStatus: string, actor: string | null, at: string): void {
  db.prepare(
    'INSERT INTO bug_ticket_events (id, bug_id, from_status, to_status, actor, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, bugId, null, toStatus, actor, null, at);
}

function readRows<T>(sql: string, params: unknown[] = []): T[] {
  return db.prepare(sql).all(...params) as T[];
}

test.before(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'pbb129-t34-exceptions-'));
  db = new Database(path.join(root, 'throwaway.db'));
  createSchema(db);
});

test.after(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('adapter: one tenant\'s real rows become alerts with priority, owner and audit-event revision', () => {
  seedTicket({
    id: 'BUG-TENANT-A-1',
    client_slug: 'client-acorn',
    severity: 'P0 run-dead',
    symptom: 'Opt-out webhook was ignored',
    assigned_healer_agent_id: 'agent-healer-1',
    reported_at: '2026-10-24 07:00:00',
    updated_at: '2026-10-24 11:00:00',
  });
  seedEvent('ev-a1', 'BUG-TENANT-A-1', 'REPORTED', 'intake-clerk', '2026-10-24 07:00:00');
  seedEvent('ev-a2', 'BUG-TENANT-A-1', 'TRIAGED', 'triage', '2026-10-24 08:00:00');

  seedTicket({
    id: 'BUG-TENANT-B-1',
    client_slug: 'client-other',
    severity: 'P0 run-dead',
    symptom: 'Another tenant fault',
  });
  seedEvent('ev-b1', 'BUG-TENANT-B-1', 'REPORTED', 'intake-clerk', '2026-10-24 07:00:00');

  const result = loadFailureAlerts('client-acorn', readRows);
  assert.equal(result.state, 'live');
  assert.equal(result.adapter, 'bug_tickets');
  assert.equal(result.items.length, 1, 'tenant isolation: the other client never leaks in');

  const projection = projectAlerts(result.items);
  const row = projection.rows[0];
  assert.equal(row.id, 'BUG-TENANT-A-1');
  assert.equal(row.priority, 'P0');
  assert.deepEqual(row.owner, { kind: 'agent', id: 'agent-healer-1', name: null });
  assert.equal(row.revision, 2, 'the append-only audit events are the revision');
  assert.equal(row.first_seen_at, '2026-10-24 07:00:00');
  assert.equal(row.last_seen_at, '2026-10-24 11:00:00');
  assert.equal(row.next_action, 'Halt the affected scope, then reconcile the unsafe action.');
});

test('adapter: CLOSED is cleared only with a closing EVENT actor and a healing report', () => {
  seedTicket({
    id: 'BUG-CLOSED-PROVEN',
    client_slug: 'client-acorn',
    status: 'CLOSED',
    closed_at: '2026-10-24 09:30:00',
    healing_report_path: 'evidence/healing/BUG-CLOSED-PROVEN.json',
  });
  seedEvent('ev-c1', 'BUG-CLOSED-PROVEN', 'REPORTED', 'intake-clerk', '2026-10-24 07:00:00');
  seedEvent('ev-c2', 'BUG-CLOSED-PROVEN', 'CLOSED', 'bug-librarian', '2026-10-24 09:30:00');

  seedTicket({
    id: 'BUG-CLOSED-NO-ACTOR',
    client_slug: 'client-acorn',
    status: 'CLOSED',
    closed_at: '2026-10-24 09:30:00',
    healing_report_path: 'evidence/healing/BUG-CLOSED-NO-ACTOR.json',
  });
  // No CLOSED event row: the status mirror alone cannot prove who cleared it.

  const alerts = bugTicketsToAlerts(
    readRows<BugTicketViewRow>(
      'SELECT id, symptom, severity, client_slug, status, assigned_healer_agent_id, dedup_of, recurrence_count, evidence_paths, healing_report_path, fix_summary, closed_at, reported_at, updated_at FROM bug_tickets WHERE id IN (?, ?) ORDER BY id',
      ['BUG-CLOSED-NO-ACTOR', 'BUG-CLOSED-PROVEN'],
    ),
    readRows<BugTicketEventRow>(
      'SELECT bug_id, to_status, actor, reason, created_at FROM bug_ticket_events WHERE bug_id IN (?, ?)',
      ['BUG-CLOSED-NO-ACTOR', 'BUG-CLOSED-PROVEN'],
    ),
  );
  const projection = projectAlerts(alerts);
  const proven = projection.rows.find((row) => row.id === 'BUG-CLOSED-PROVEN')!;
  const unproven = projection.rows.find((row) => row.id === 'BUG-CLOSED-NO-ACTOR')!;

  assert.equal(proven.state, 'cleared');
  assert.equal(proven.clearance.by, 'bug-librarian');
  assert.equal(proven.clearance.at, '2026-10-24 09:30:00');
  assert.equal(proven.clearance.evidence, 'evidence/healing/BUG-CLOSED-PROVEN.json');

  assert.equal(unproven.state, 'clearance_unknown');
  assert.equal(unproven.unknown_reason, 'clearance_missing:by');
});

test('adapter: a missing tenant, an empty tenant and an unreadable table are each honest', () => {
  const noTenant = loadFailureAlerts(null, readRows);
  assert.equal(noTenant.state, 'unknown');
  assert.equal(noTenant.reason, 'tenant_required');
  assert.deepEqual(noTenant.items, []);

  const empty = loadFailureAlerts('client-with-no-faults', readRows);
  assert.equal(empty.state, 'live');
  assert.equal(empty.reason, null);
  assert.deepEqual(empty.items, [], 'a working tenant-scoped read with no rows is a proven zero');

  const brokenTickets = loadFailureAlerts('client-acorn', () => {
    throw new Error('no such table: bug_tickets');
  });
  assert.equal(brokenTickets.state, 'unknown');
  assert.equal(brokenTickets.reason, 'failure_adapter_failed:no such table: bug_tickets');
  assert.deepEqual(brokenTickets.items, []);

  const brokenEvents = loadFailureAlerts('client-acorn', <T,>(sql: string, params: unknown[] = []): T[] => {
    if (sql.includes('bug_ticket_events')) throw new Error('database is locked');
    return db.prepare(sql).all(...params) as T[];
  });
  assert.equal(brokenEvents.state, 'unknown');
  assert.equal(brokenEvents.reason, 'failure_events_unreadable:database is locked');
  assert.deepEqual(brokenEvents.items, [], 'no alert is rendered without its audit trail');
});

/* ───────────────────────────── 9. Adapter contract + whole view */

test('adapters: absent, null and throwing adapters are UNKNOWN; an empty array is a proven zero', () => {
  const absent = loadSurface(null, 'bookings');
  assert.deepEqual(absent, {
    state: 'unknown',
    reason: 'no_bookings_adapter',
    adapter: null,
    items: [],
  });

  const unavailable = loadSurface({ name: 'ghl', load: () => null }, 'bookings');
  assert.equal(unavailable.state, 'unknown');
  assert.equal(unavailable.reason, 'bookings_adapter_unavailable');
  assert.equal(unavailable.adapter, 'ghl');

  const failing = loadSurface<BookingInput>({
    name: 'ghl',
    load: () => {
      throw new Error('token expired');
    },
  }, 'bookings');
  assert.equal(failing.state, 'unknown');
  assert.equal(failing.reason, 'bookings_adapter_failed:token expired');

  const empty = loadSurface<BookingInput>({ name: 'ghl', load: () => [] }, 'bookings');
  assert.equal(empty.state, 'live');
  assert.deepEqual(empty.items, []);
});

test('view: unregistered booking/outcome adapters render UNKNOWN with reasons; failures render real rows', () => {
  const view = buildExceptionsOutcomesView({
    tenantSlug: 'client-acorn',
    failures: {
      state: 'live',
      reason: null,
      adapter: 'bug_tickets',
      items: [alert({ id: 'BUG-1', severity: 'P1 degraded' })],
    },
    bookings: null,
    outcomes: null,
  });

  assert.deepEqual(view.tenant, { slug: 'client-acorn', state: 'live', reason: null });
  assert.equal(view.failures.state, 'live');
  assert.equal(view.failures.rows.length, 1);
  assert.equal(view.bookings.state, 'unknown');
  assert.equal(view.bookings.reason, 'no_bookings_adapter');
  assert.equal(view.outcomes.state, 'unknown');
  assert.equal(view.outcomes.reason, 'no_outcome_adapter');
});

test('view: an unknown failure surface poisons its workload sections instead of showing an empty list', () => {
  const view = buildExceptionsOutcomesView({
    tenantSlug: null,
    failures: loadFailureAlerts(null, readRows),
    bookings: null,
    outcomes: null,
  });

  assert.equal(view.tenant.state, 'unknown');
  assert.equal(view.tenant.reason, 'tenant_required');
  assert.equal(view.failures.state, 'unknown');
  assert.equal(view.failures.reason, 'tenant_required');
  assert.equal(view.failures.workload.immediate.state, 'unknown');
  assert.equal(view.failures.workload.immediate.reason, 'tenant_required');
  assert.equal(view.failures.workload.digest.state, 'unknown');
  assert.equal(view.failures.workload.digest.rollup, null);
  assert.equal(view.failures.workload.monthly.state, 'unknown');
});

/* ───────────────────────────── 10. Rendered view (no fake success) */

test('render: unknown surfaces say UNKNOWN with the reason and never render an empty-success line', () => {
  const view = buildExceptionsOutcomesView({
    tenantSlug: 'client-acorn',
    failures: {
      state: 'live',
      reason: null,
      adapter: 'bug_tickets',
      items: [
        alert({ id: 'BUG-P0', severity: 'P0 run-dead', title: 'Opt-out ignored', owner: { owner_name: 'Trevor' } }),
        alert({ id: 'BUG-P2', severity: 'P2 cosmetic or latent', title: 'Typo in receipt' }),
      ],
    },
    bookings: null,
    outcomes: null,
  });

  const html = renderToStaticMarkup(h(ClientExceptionsOutcomes, { view }));

  assert.match(html, /data-surface="failures"/);
  assert.match(html, /data-item-id="BUG-P0"/);
  assert.match(html, /data-priority="P0"/);
  assert.match(html, /data-owner="Trevor"/);
  assert.match(html, /Halt the affected scope, then reconcile the unsafe action\./);
  assert.match(html, /data-section="digest"[^>]*data-count="1"/, 'P2 is a roll-up line');
  assert.doesNotMatch(html, /data-item-id="BUG-P2"/, 'P2 is not an individual action row');

  assert.match(html, /data-surface="bookings"/);
  assert.match(html, /data-unknown="true"/);
  assert.match(html, /data-reason="no_bookings_adapter"/);
  assert.doesNotMatch(html, /No bookings in this period/, 'unknown never renders as an empty success');

  assert.match(html, /data-surface="outcomes"/);
  assert.match(html, /data-reason="no_outcome_adapter"/);
  assert.doesNotMatch(html, /data-outcome-kind="sale"/, 'no zero tiles are fabricated for an unknown count');
});

test('render: proven rows and proven zeros render normally', () => {
  const view = buildExceptionsOutcomesView({
    tenantSlug: 'client-acorn',
    failures: {
      state: 'live',
      reason: null,
      adapter: 'bug_tickets',
      items: [alert({ id: 'BUG-P1', severity: 'P1 degraded' })],
    },
    bookings: { state: 'live', reason: null, adapter: 'ghl', items: [] },
    outcomes: [],
  });

  const html = renderToStaticMarkup(h(ClientExceptionsOutcomes, { view }));

  assert.match(html, /data-bookings-empty="true"/, 'a working adapter with no rows says so plainly');
  assert.match(html, /data-outcomes="live"/);
  assert.match(html, /data-outcome-kind="booking"/);
  assert.match(html, /data-count="0"/, 'a proven zero is a real 0');
  assert.doesNotMatch(html, /data-unknown="true"/);
});

/* ───────────────────────────── 11. Type-level guard on the row shape */

test('row shape: every rendered alert carries exactly one owner and a named next action', () => {
  const rows: AlertRow[] = projectAlerts([
    alert({ id: 'A', owner: null }),
    alert({ id: 'B', owner: { assigned_agent_id: 'agent-2' }, severity: 'P3 improvement' }),
  ]).rows;

  for (const row of rows) {
    assert.ok(row.owner.kind === 'agent' || row.owner.kind === 'human' || row.owner.kind === 'unowned');
    assert.equal(typeof row.next_action, 'string');
    assert.ok(row.next_action.length > 0);
    assert.ok(Array.isArray(row.coalesced_ids) && row.coalesced_ids.length >= 1);
  }
  assert.equal(rows.find((row) => row.id === 'A')!.owner.kind, 'unowned');
  assert.equal(rows.find((row) => row.id === 'A')!.next_action, 'Name one owner now, then halt and repair the affected scope.');
});
