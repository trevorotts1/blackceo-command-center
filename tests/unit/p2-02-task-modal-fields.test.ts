/**
 * P2-02 — Task-detail window: fill in and ACTUALLY use its fields.
 *
 * FAIL-FIRST: against the pre-P2-02 tree neither `buildPersonaReason`
 * (src/lib/persona-selector.ts) nor src/lib/trust-activity.ts exists, so the
 * imports fail and every test errors. With the P2-02 build they pass.
 *
 * These are the P2-02 QC break-it probes rendered as real, failable tests:
 *   • persona-selection produces a stored one-sentence WHY (persona_reason) —
 *     REUSING the scorer's own message when it wrote one, and synthesizing an
 *     honest sentence (persona + mode + score) when it did not;
 *   • the WHY is exactly ONE sentence (no newlines, ends with a period) so the
 *     modal panel never renders a raw multi-line dump;
 *   • a persona with no id yields NO reason (empty-state, never a fabricated one);
 *   • the trust-engine events (trust_ack / trust_progress / trust_done) the P1-04
 *     engine writes to the `events` table map into the Activity feed as first-class
 *     activities with the client-facing message extracted (never the raw
 *     "trust_x -> chatId:" telemetry prefix), so the client sees the ack/progress/
 *     done trail in the task's Activity tab.
 */

// C8 isolation — FIRST import: points DATABASE_PATH at a throwaway temp DB before
// any project module (persona-selector → @/lib/db) is evaluated, so this suite can
// never open the live mission-control.db (c8-db-isolation-guard enforces this).
import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPersonaReason, type PersonaSelectionResult } from '../../src/lib/persona-selector';
import {
  TRUST_EVENT_TYPES,
  isTrustEventType,
  trustEventToActivity,
  extractClientMessage,
} from '../../src/lib/trust-activity';

function baseResult(over: Partial<PersonaSelectionResult>): PersonaSelectionResult {
  return {
    persona_id: 'russell-brunson',
    persona_name: 'Russell Brunson',
    score: 0.82,
    interaction_mode: 'leadership',
    ...over,
  };
}

// ── buildPersonaReason ───────────────────────────────────────────────────────

test('buildPersonaReason REUSES the scorer message when the scorer wrote one', () => {
  const reason = buildPersonaReason(
    baseResult({ message: 'Chosen for direct-response funnel expertise on this landing-page task' }),
  );
  assert.ok(reason, 'a message-bearing result must yield a reason');
  assert.match(reason!, /direct-response funnel expertise/);
});

test('buildPersonaReason SYNTHESIZES an honest sentence when the scorer gave no message', () => {
  const reason = buildPersonaReason(baseResult({ message: undefined, task_category: 'sales-copy' }));
  assert.ok(reason, 'a scored match must always produce a WHY');
  // Must name the persona and reflect the match strength / mode — not a stub.
  assert.match(reason!, /Russell Brunson/);
  assert.match(reason!, /leadership/i);
});

test('buildPersonaReason returns a SINGLE clean sentence (no newlines, ends with a period)', () => {
  const noisy = buildPersonaReason(
    baseResult({ message: 'line one\nline two\n\nline three   ' }),
  );
  assert.ok(noisy);
  assert.ok(!noisy!.includes('\n'), 'reason must be a single line, never a multi-line dump');
  assert.ok(noisy!.endsWith('.'), 'reason must read as a sentence');
});

test('buildPersonaReason yields NO reason for a no-match result (honest empty-state, never fabricated)', () => {
  const reason = buildPersonaReason(baseResult({ persona_id: null, persona_name: 'N/A', score: 0 }));
  assert.equal(reason, null);
});

// ── trust-engine events → Activity feed ──────────────────────────────────────

test('TRUST_EVENT_TYPES are exactly the three P1-04 report-back event types', () => {
  assert.deepEqual([...TRUST_EVENT_TYPES].sort(), ['trust_ack', 'trust_done', 'trust_progress']);
  assert.equal(isTrustEventType('trust_ack'), true);
  assert.equal(isTrustEventType('trust_progress'), true);
  assert.equal(isTrustEventType('trust_done'), true);
  assert.equal(isTrustEventType('task_created'), false);
});

test('trustEventToActivity extracts the CLIENT-FACING message, dropping the telemetry prefix', () => {
  const activity = trustEventToActivity({
    id: 'evt-1',
    type: 'trust_ack',
    task_id: 'task-9',
    message: "trust_ack -> 55512345: Got it — 'Landing page' was assigned to the Marketing department.",
    created_at: '2026-07-12T10:00:00.000Z',
  });
  assert.equal(activity.task_id, 'task-9');
  assert.equal(activity.activity_type, 'trust_ack');
  // The client sees the actual message, never the "trust_ack -> <chatId>:" prefix.
  assert.ok(!activity.message.includes('trust_ack ->'), 'the raw telemetry prefix must be stripped');
  assert.ok(!activity.message.includes('55512345'), 'the raw chat id must not leak into the feed');
  assert.match(activity.message, /was assigned to the Marketing department/);
  assert.equal(activity.created_at, '2026-07-12T10:00:00.000Z');
});

test('trustEventToActivity is resilient to a message with no prefix (uses it verbatim)', () => {
  const activity = trustEventToActivity({
    id: 'evt-2',
    type: 'trust_done',
    task_id: 'task-9',
    message: 'Done — the deck is in Drive.',
    created_at: '2026-07-12T11:00:00.000Z',
  });
  assert.equal(activity.activity_type, 'trust_done');
  assert.equal(activity.message, 'Done — the deck is in Drive.');
});

// ── FAIL-FIRST: prefix-only / empty-body telemetry rows must not leak the chat id ──
// A trust event whose client body is EMPTY ("trust_ack -> <id>:" — a bare ack the
// engine still records) previously failed the `([\s\S]+)$` match and the whole raw
// string, chat id and all, was returned verbatim into the Activity UI. The body is
// now `[\s\S]*` so the prefix still strips and the empty body extracts to ''.

test('extractClientMessage strips a prefix-only telemetry row (empty body → no chat id leak)', () => {
  assert.equal(extractClientMessage('trust_ack -> 55512345:'), '');
});

test('extractClientMessage strips a prefix-only telemetry row with a trailing space', () => {
  assert.equal(extractClientMessage('trust_ack -> 55512345: '), '');
});

test('trustEventToActivity never leaks the chat id for a prefix-only (empty-body) event', () => {
  for (const message of ['trust_progress -> 987654321:', 'trust_done -> 987654321: ']) {
    const activity = trustEventToActivity({
      id: 'evt-empty',
      type: message.slice(0, message.indexOf(' ')),
      task_id: 'task-9',
      message,
      created_at: '2026-07-12T12:00:00.000Z',
    });
    assert.equal(activity.message, '', 'an empty-body telemetry row must render as an empty message');
    assert.ok(!activity.message.includes('987654321'), 'the raw chat id must never leak into the feed');
    assert.ok(!activity.message.includes('->'), 'the raw telemetry prefix must never leak into the feed');
  }
});
