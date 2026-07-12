/**
 * P2-01 — BACKLOG vs. TO-DO: the determination (renamed column vocabulary +
 * the Backlog card's "why is this here?" triad-missing pill).
 *
 * FAIL-FIRST: against the pre-P2-01 tree `src/lib/board-labels.ts` does not
 * exist, so this import fails and every test below errors. With the fix they
 * pass. These assertions are the P2-01 QC break-it probes rendered as real,
 * failable tests:
 *   - the renamed labels are exactly what the determination specifies
 *     ("Being Prepared" / "Ready to Start") — not the old "Backlog"/"To-Do";
 *   - the hover subtitle is the operator's verbatim copy;
 *   - `triadMissingFields` mirrors the field-presence half of `checkTriad`
 *     (src/lib/sops.ts) exactly: missing description / sop_id / a real
 *     persona_id (including the sentinel-persona-id edge case), and reports
 *     nothing missing once all three are genuinely present;
 *   - `triadMissingPillText` renders the exact "Missing: X, Y" copy the
 *     Backlog card pill shows.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKLOG_COLUMN_LABEL,
  TODO_COLUMN_LABEL,
  BACKLOG_COLUMN_SUBTITLE,
  triadMissingFields,
  triadMissingPillText,
} from '../../src/lib/board-labels';

// ── Renamed vocabulary ───────────────────────────────────────────────────────

test('P2-01: Backlog is client-facing-renamed to exactly "Being Prepared"', () => {
  assert.equal(BACKLOG_COLUMN_LABEL, 'Being Prepared');
  assert.notEqual(BACKLOG_COLUMN_LABEL, 'Backlog');
});

test('P2-01: To-Do is client-facing-renamed to exactly "Ready to Start"', () => {
  assert.equal(TODO_COLUMN_LABEL, 'Ready to Start');
  assert.notEqual(TODO_COLUMN_LABEL, 'To-Do');
});

test('P2-01: the Backlog hover subtitle is the operator-specified copy', () => {
  assert.equal(
    BACKLOG_COLUMN_SUBTITLE,
    "We're gathering what this task needs — a description, a playbook, and the right persona",
  );
});

// ── triadMissingFields (client-safe presence mirror of checkTriad) ──────────

test('triadMissingFields: all three missing on a bare-landed task', () => {
  const missing = triadMissingFields({ description: null, sop_id: null, persona_id: null });
  assert.deepEqual(missing, ['description', 'sop_id', 'persona_id']);
});

test('triadMissingFields: nothing missing once description + sop_id + a real persona_id are set', () => {
  const missing = triadMissingFields({
    description: 'Write the Q3 investor update',
    sop_id: 'sop-123',
    persona_id: 'persona-russell-brunson',
  });
  assert.deepEqual(missing, []);
});

test('triadMissingFields: whitespace-only description still counts as missing', () => {
  const missing = triadMissingFields({ description: '   ', sop_id: 'sop-1', persona_id: 'persona-1' });
  assert.deepEqual(missing, ['description']);
});

test('triadMissingFields: a sentinel persona_id ("null" string) is treated as missing, not present', () => {
  const missing = triadMissingFields({ description: 'x', sop_id: 'sop-1', persona_id: 'null' });
  assert.deepEqual(missing, ['persona_id']);
});

test('triadMissingFields: only the actually-absent legs are reported', () => {
  const missing = triadMissingFields({ description: 'x', sop_id: null, persona_id: 'persona-1' });
  assert.deepEqual(missing, ['sop_id']);
});

// ── triadMissingPillText ─────────────────────────────────────────────────────

test('triadMissingPillText: renders human labels in Triad order', () => {
  assert.equal(
    triadMissingPillText(['description', 'sop_id', 'persona_id']),
    'Missing: description, SOP, persona',
  );
});

test('triadMissingPillText: renders a single missing leg without a trailing comma', () => {
  assert.equal(triadMissingPillText(['sop_id']), 'Missing: SOP');
});
