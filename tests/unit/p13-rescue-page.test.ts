/**
 * P13 — "No ticket UI in the Command Center" (RESCUE-RANGERS-DIAGNOSIS
 * 2026-08-01, Batch F).
 *
 * Proves the pure decision logic behind the /rescue page: severity ordering,
 * the decision-mode -> daily-bucket mapping, SLA breach detection, the UTC
 * day key that must agree with the durable store's own day counters, and the
 * fail-closed gate on the home-grid entry.
 *
 * These are the rules a reader would otherwise re-derive per component, and
 * getting any of them wrong produces a page that LOOKS right and reports the
 * wrong numbers — the exact failure class this suite exists to prevent.
 *
 * Pure logic only: no DB, no network, no React/DOM (this repo carries no
 * jsdom harness for the node:test suites — same convention as
 * tests/unit/u77-podcast-nav-gating.test.ts). Node built-in test runner under
 * tsx (`npm run test:unit`).
 *
 * FAIL-FIRST PROOF: every test below fails against the pre-Batch-F tree,
 * because src/lib/rescue/* did not exist before this change (the imports
 * throw MODULE_NOT_FOUND).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SEVERITY_ORDER,
  bucketForTicket,
  isOpenStatus,
  isSlaBreached,
  normalizeSeverity,
  orderSeverityCounts,
  shouldShowRescueEntry,
  sortOpenTickets,
  tallyDaily,
  utcDayKey,
} from '../../src/lib/rescue/severity';
import { parseStandingSnapshot } from '../../src/lib/rescue/standing';
import type { RescueTicket } from '../../src/lib/rescue/types';

// ── severity ordering ───────────────────────────────────────────────────────

test('[P13] orderSeverityCounts: always emits all four tiers, most severe first, zero-filled', () => {
  const out = orderSeverityCounts([{ severity: 'SEV3', open: 2 }]);
  assert.deepEqual(
    out.map((r) => r.severity),
    SEVERITY_ORDER,
  );
  assert.deepEqual(
    out.map((r) => r.open),
    [0, 0, 2, 0],
  );
});

test('[P13] orderSeverityCounts: an unrecognised severity is bucketed as UNKNOWN, never dropped (a store emitting SEV0 must be visible, not silently lost)', () => {
  const out = orderSeverityCounts([
    { severity: 'SEV1', open: 1 },
    { severity: 'SEV0', open: 3 },
    { severity: null, open: 2 },
  ]);
  const unknown = out.find((r) => r.severity === 'UNKNOWN');
  assert.ok(unknown, 'UNKNOWN bucket must exist');
  assert.equal(unknown.open, 5);
  assert.equal(out.find((r) => r.severity === 'SEV1')?.open, 1);
});

test('[P13] orderSeverityCounts: no UNKNOWN row when every severity is recognised', () => {
  const out = orderSeverityCounts([{ severity: 'SEV2', open: 4 }]);
  assert.equal(out.some((r) => r.severity === 'UNKNOWN'), false);
});

test('[P13] normalizeSeverity: case-insensitive, rejects anything outside the tier set', () => {
  assert.equal(normalizeSeverity('sev1'), 'SEV1');
  assert.equal(normalizeSeverity('SEV9'), null);
  assert.equal(normalizeSeverity(null), null);
});

// ── open-status contract (must match the store's OPEN_STATUSES) ─────────────

test('[P13] isOpenStatus: the six operationally-open states are open; the two terminal ones are not', () => {
  for (const s of ['OPEN', 'ACK', 'IN_PROGRESS', 'ESCALATED', 'NEEDS_HUMAN', 'REOPENED']) {
    assert.equal(isOpenStatus(s), true, `${s} must count as open`);
  }
  assert.equal(isOpenStatus('RESOLVED'), false);
  assert.equal(isOpenStatus('CLOSED'), false);
});

// ── decision mode -> daily bucket ───────────────────────────────────────────

test('[P13] bucketForTicket: both spellings of "we fixed it" land in fixedByUs (the receiver writes WE_FIXED_IT, the store hook writes WE_SOLVED_IT — one outcome, two tokens)', () => {
  assert.equal(bucketForTicket({ status: 'RESOLVED', decisionMode: 'WE_FIXED_IT' }), 'fixedByUs');
  assert.equal(bucketForTicket({ status: 'RESOLVED', decisionMode: 'WE_SOLVED_IT' }), 'fixedByUs');
});

test('[P13] bucketForTicket: TOLD_YOUR_AGENT and JUST_AN_ANSWER map to their own buckets', () => {
  assert.equal(bucketForTicket({ status: 'RESOLVED', decisionMode: 'TOLD_YOUR_AGENT' }), 'toldAgent');
  assert.equal(bucketForTicket({ status: 'RESOLVED', decisionMode: 'JUST_AN_ANSWER' }), 'answered');
});

test('[P13] bucketForTicket: an ESCALATED/NEEDS_HUMAN ticket is human-pending whatever decision mode it carries (status wins — that is what "still waiting on a human" means)', () => {
  assert.equal(bucketForTicket({ status: 'ESCALATED', decisionMode: 'WE_FIXED_IT' }), 'humanPending');
  assert.equal(bucketForTicket({ status: 'NEEDS_HUMAN', decisionMode: 'JUST_AN_ANSWER' }), 'humanPending');
});

test('[P13] bucketForTicket: HUMAN_NEEDED that a human has since RESOLVED is NOT still pending', () => {
  assert.equal(bucketForTicket({ status: 'RESOLVED', decisionMode: 'HUMAN_NEEDED' }), 'fixedByUs');
  assert.equal(bucketForTicket({ status: 'OPEN', decisionMode: 'HUMAN_NEEDED' }), 'humanPending');
});

test('[P13] bucketForTicket: WE_ARE_FIXING is in-flight while open, and counts as fixed once terminal', () => {
  assert.equal(bucketForTicket({ status: 'IN_PROGRESS', decisionMode: 'WE_ARE_FIXING' }), 'inProgress');
  assert.equal(bucketForTicket({ status: 'CLOSED', decisionMode: 'WE_ARE_FIXING' }), 'fixedByUs');
});

test('[P13] bucketForTicket: an absent or unrecognised decision mode is unclassified, never silently folded into a real outcome', () => {
  assert.equal(bucketForTicket({ status: 'OPEN', decisionMode: null }), 'unclassified');
  assert.equal(bucketForTicket({ status: 'OPEN', decisionMode: 'SOMETHING_NEW' }), 'unclassified');
});

test('[P13] tallyDaily: the buckets always reconcile to the intake total (no ticket can be counted twice or lost)', () => {
  const tickets = [
    { status: 'RESOLVED', decisionMode: 'WE_FIXED_IT' },
    { status: 'RESOLVED', decisionMode: 'TOLD_YOUR_AGENT' },
    { status: 'RESOLVED', decisionMode: 'JUST_AN_ANSWER' },
    { status: 'NEEDS_HUMAN', decisionMode: 'HUMAN_NEEDED' },
    { status: 'IN_PROGRESS', decisionMode: 'WE_ARE_FIXING' },
    { status: 'OPEN', decisionMode: null },
  ];
  const d = tallyDaily('2026-08-01', tickets);
  assert.equal(d.in, 6);
  assert.equal(d.fixedByUs, 1);
  assert.equal(d.toldAgent, 1);
  assert.equal(d.answered, 1);
  assert.equal(d.humanPending, 1);
  assert.equal(d.inProgress, 1);
  assert.equal(d.unclassified, 1);
  const sum =
    d.fixedByUs + d.toldAgent + d.answered + d.humanPending + d.inProgress + d.unclassified;
  assert.equal(sum, d.in, 'buckets must sum to the intake total');
});

test('[P13] tallyDaily: an empty day is all zeros, not a missing shape', () => {
  const d = tallyDaily('2026-08-01', []);
  assert.equal(d.in, 0);
  assert.equal(d.humanPending, 0);
  assert.equal(d.day, '2026-08-01');
});

// ── day key: must match the store's own counter key ─────────────────────────

test('[P13] utcDayKey: slices the UTC ISO prefix exactly as the store keys its per-client day counters (client|YYYY-MM-DD off created_at)', () => {
  assert.equal(utcDayKey('2026-08-01T12:10:18.180Z'), '2026-08-01');
  assert.equal(utcDayKey(new Date(Date.UTC(2026, 7, 1, 23, 59, 59))), '2026-08-01');
  // A local-midnight-crossing instant still resolves to its UTC day.
  assert.equal(utcDayKey(new Date(Date.UTC(2026, 7, 2, 0, 0, 1))), '2026-08-02');
});

// ── SLA ─────────────────────────────────────────────────────────────────────

test('[P13] isSlaBreached: an OPEN ticket past its due time is breached', () => {
  const now = Date.parse('2026-08-01T12:00:00Z');
  assert.equal(
    isSlaBreached({ status: 'OPEN', slaDueAt: '2026-08-01T11:00:00Z' }, now),
    true,
  );
});

test('[P13] isSlaBreached: a RESOLVED ticket is never breached, however old (a closed ticket cannot be late)', () => {
  const now = Date.parse('2026-08-01T12:00:00Z');
  assert.equal(
    isSlaBreached({ status: 'RESOLVED', slaDueAt: '2026-08-01T01:00:00Z' }, now),
    false,
  );
});

test('[P13] isSlaBreached: no due time, or an unparseable one, is not a breach', () => {
  const now = Date.parse('2026-08-01T12:00:00Z');
  assert.equal(isSlaBreached({ status: 'OPEN', slaDueAt: null }, now), false);
  assert.equal(isSlaBreached({ status: 'OPEN', slaDueAt: 'not-a-date' }, now), false);
});

test('[P13] isSlaBreached: reads the snake_case column name too, so a raw store row works unchanged', () => {
  const now = Date.parse('2026-08-01T12:00:00Z');
  assert.equal(isSlaBreached({ status: 'OPEN', sla_due_at: '2026-08-01T11:00:00Z' }, now), true);
});

// ── open-queue ordering ─────────────────────────────────────────────────────

function ticket(over: Partial<RescueTicket>): RescueTicket {
  return {
    ticketId: 't',
    rr: null,
    client: null,
    box: null,
    agent: null,
    person: null,
    failureClass: null,
    severity: 'SEV3',
    status: 'OPEN',
    decisionMode: null,
    source: null,
    problem: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    resolvedAt: null,
    slaDueAt: null,
    slaBreached: false,
    ...over,
  };
}

test('[P13] sortOpenTickets: SLA breaches lead, regardless of severity', () => {
  const out = sortOpenTickets([
    ticket({ ticketId: 'sev1-ok', severity: 'SEV1' }),
    ticket({ ticketId: 'sev4-late', severity: 'SEV4', slaBreached: true }),
  ]);
  assert.equal(out[0].ticketId, 'sev4-late');
});

test('[P13] sortOpenTickets: then severity, then oldest first', () => {
  const out = sortOpenTickets([
    ticket({ ticketId: 'sev2-new', severity: 'SEV2', createdAt: '2026-08-01T09:00:00.000Z' }),
    ticket({ ticketId: 'sev1-new', severity: 'SEV1', createdAt: '2026-08-01T09:00:00.000Z' }),
    ticket({ ticketId: 'sev1-old', severity: 'SEV1', createdAt: '2026-08-01T01:00:00.000Z' }),
  ]);
  assert.deepEqual(
    out.map((t) => t.ticketId),
    ['sev1-old', 'sev1-new', 'sev2-new'],
  );
});

test('[P13] sortOpenTickets: does not mutate its input', () => {
  const input = [ticket({ ticketId: 'a', severity: 'SEV4' }), ticket({ ticketId: 'b', severity: 'SEV1' })];
  sortOpenTickets(input);
  assert.equal(input[0].ticketId, 'a');
});

// ── the gated home-grid entry (fail closed) ─────────────────────────────────

test('[P13] shouldShowRescueEntry: shown only once the probe resolved ok AND the store is present', () => {
  assert.equal(shouldShowRescueEntry('ok', true), true);
});

test('[P13] shouldShowRescueEntry: a box with no rescue store shows no card', () => {
  assert.equal(shouldShowRescueEntry('ok', false), false);
});

test('[P13] shouldShowRescueEntry: fails CLOSED while loading and on error — never flashes in, never leaves a stale card on a failed read', () => {
  assert.equal(shouldShowRescueEntry('loading', true), false);
  assert.equal(shouldShowRescueEntry('error', true), false);
});

// ── standing-blocks snapshot parsing ────────────────────────────────────────

test('[P13] parseStandingSnapshot: no payload => unavailable, NOT "zero blocks" ("we cannot see the gate" and "the gate blocks nobody" are different facts)', () => {
  const v = parseStandingSnapshot(null);
  assert.equal(v.available, false);
  assert.deepEqual(v.blocks, []);
});

test('[P13] parseStandingSnapshot: normalised { takenAt, blocks } shape', () => {
  const v = parseStandingSnapshot({
    takenAt: '2026-08-01T11:39:18Z',
    source: 'fleet_standing',
    blocks: [{ client: 'Example Co', boxSlug: 'example-co', reason: 'past due', since: '2026-07-30T00:00:00Z' }],
  });
  assert.equal(v.available, true);
  assert.equal(v.takenAt, '2026-08-01T11:39:18Z');
  assert.equal(v.blocks.length, 1);
  assert.equal(v.blocks[0].boxSlug, 'example-co');
});

test('[P13] parseStandingSnapshot: a raw fleet_standing dump keeps ONLY the rows explicitly not in good standing (an absent flag is not a block — the gate itself fails open)', () => {
  const v = parseStandingSnapshot({
    rows: [
      { box_slug: 'a-co', client_label: 'A Co', good_standing: true },
      { box_slug: 'b-co', client_label: 'B Co', good_standing: false, standing_reason: 'invoice unpaid', updated_at: '2026-07-31T10:00:00Z' },
      { box_slug: 'c-co', client_label: 'C Co' },
    ],
  });
  assert.equal(v.available, true);
  assert.equal(v.blocks.length, 1);
  assert.equal(v.blocks[0].client, 'B Co');
  assert.equal(v.blocks[0].reason, 'invoice unpaid');
});

test('[P13] parseStandingSnapshot: string "false" counts as not-in-good-standing (JSON exports stringify booleans)', () => {
  const v = parseStandingSnapshot([{ box_slug: 'd-co', good_standing: 'false' }]);
  assert.equal(v.blocks.length, 1);
  assert.equal(v.blocks[0].boxSlug, 'd-co');
});

test('[P13] parseStandingSnapshot: an empty blocks list is AVAILABLE with zero blocks (a real "nobody is held" answer, distinct from having no snapshot)', () => {
  const v = parseStandingSnapshot({ takenAt: '2026-08-01T00:00:00Z', blocks: [] });
  assert.equal(v.available, true);
  assert.deepEqual(v.blocks, []);
});

test('[P13] parseStandingSnapshot: entries with no identifying field at all are dropped rather than rendered as blank rows', () => {
  const v = parseStandingSnapshot({ blocks: [{ reason: 'orphan' }, { client: 'Real Co' }] });
  assert.equal(v.blocks.length, 1);
  assert.equal(v.blocks[0].client, 'Real Co');
});
