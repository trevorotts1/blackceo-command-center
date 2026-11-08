/**
 * F23.10 / F23.14 — durable launch event outbox.
 *
 * Proves:
 *   - enqueue is idempotent on event_id (at-least-once producers re-send safely);
 *   - a rewrite of an undelivered event is atomic; an accepted event is immutable;
 *   - claim → deliver → complete uses a claim-token CAS, so two concurrent
 *     consumers cannot deliver the same event twice;
 *   - ordering is (plan_version, sequence);
 *   - retry vs permanent rejection are distinct, and an exhausted/rejected event
 *     is NEVER counted as sent merely because no retry remains;
 *   - a CC outage reports synchronization unavailable/stale and never claims a
 *     remote acceptance that did not happen.
 *
 * Isolated DB (import _isolated-db FIRST). No network.
 */
import './_isolated-db';

import { describe, it, expect, beforeEach } from 'vitest';

import { run, queryAll } from '@/lib/db';
import {
  claimDueEvents,
  completeEvent,
  drainLaunchOutbox,
  enqueueLaunchEvent,
  outboxSyncState,
  readOutboxEvent,
  retryEvent,
} from '@/lib/launch-outbox';
import { ensureLaunchDomainSchema } from '@/lib/launch-domain';

const NOW = Date.parse('2026-11-08T12:00:00.000Z');
const HOUR = 3_600_000;

function event(n: number, overrides: Partial<{ planVersion: number; sequence: number; payload: unknown; runId: string }> = {}) {
  return {
    eventId: `event-${String(n).padStart(4, '0')}`,
    runId: overrides.runId ?? 'run-f23-outbox',
    skill: 83,
    launchId: 'f23-outbox-2026-11',
    planVersion: overrides.planVersion ?? 1,
    sequence: overrides.sequence,
    payload: overrides.payload ?? { n },
  };
}

beforeEach(() => {
  ensureLaunchDomainSchema();
  run('DELETE FROM launch_event_outbox');
});

describe('F23.14 — idempotent enqueue and atomic rewrite', () => {
  it('queues once and reports an identical re-send as a duplicate', () => {
    const first = enqueueLaunchEvent(event(1), NOW);
    expect(first.status).toBe('queued');
    const second = enqueueLaunchEvent(event(1), NOW + 1_000);
    expect(second.status).toBe('duplicate');
    const rows = queryAll<{ n: number }>('SELECT COUNT(*) AS n FROM launch_event_outbox');
    expect(rows[0].n).toBe(1);
  });

  it('rewrites an undelivered event atomically, but never an accepted one', () => {
    enqueueLaunchEvent(event(2, { payload: { v: 1 } }), NOW);
    expect(enqueueLaunchEvent(event(2, { payload: { v: 2 } }), NOW + 1).status).toBe('queued');
    expect(readOutboxEvent('event-0002')?.payload_json).toBe(JSON.stringify({ v: 2 }));

    const [claimed] = claimDueEvents({ now: NOW + 2 });
    expect(completeEvent(claimed.event_id, claimed.claim_token!, NOW + 3)).toBe(true);
    const accepted = enqueueLaunchEvent(event(2, { payload: { v: 3 } }), NOW + 4);
    expect(accepted.status).toBe('rejected');
    expect(readOutboxEvent('event-0002')?.payload_json).toBe(JSON.stringify({ v: 2 }));
  });
});

describe('F23.14 — ordered, atomic delivery under concurrent consumers', () => {
  it('delivers in (plan_version, sequence) order exactly once', () => {
    enqueueLaunchEvent(event(10, { planVersion: 2, sequence: 1 }), NOW);
    enqueueLaunchEvent(event(11, { planVersion: 1, sequence: 2 }), NOW);
    enqueueLaunchEvent(event(12, { planVersion: 1, sequence: 1 }), NOW);
    const order: string[] = [];
    const result = drainLaunchOutbox({
      now: NOW,
      deliver: (row) => {
        order.push(row.event_id);
        return { ok: true };
      },
    });
    expect(result.delivered).toBe(3);
    expect(order).toEqual(['event-0012', 'event-0011', 'event-0010']);
  });

  it('a second consumer cannot claim an event the first already claimed', () => {
    enqueueLaunchEvent(event(20), NOW);
    const first = claimDueEvents({ now: NOW });
    const second = claimDueEvents({ now: NOW });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    // The first consumer still owns the claim and can complete it.
    expect(completeEvent(first[0].event_id, first[0].claim_token!, NOW + 1)).toBe(true);
  });

  it('a stale claim is reclaimed after its lease expires', () => {
    enqueueLaunchEvent(event(21), NOW);
    const first = claimDueEvents({ now: NOW, leaseMs: 1_000 });
    expect(first).toHaveLength(1);
    const later = claimDueEvents({ now: NOW + 60_000, leaseMs: 1_000 });
    expect(later).toHaveLength(1);
    expect(later[0].event_id).toBe(first[0].event_id);
    expect(later[0].attempts).toBe(2);
  });
});

describe('F23.14 — retry vs permanently rejected (dead letter)', () => {
  it('retries with a later attempt time, then dead-letters after maxAttempts', () => {
    enqueueLaunchEvent(event(30), NOW);
    const [first] = claimDueEvents({ now: NOW });
    const retried = retryEvent(first.event_id, first.claim_token!, 'CC unreachable', {
      now: NOW,
      maxAttempts: 2,
      backoffMs: 1_000,
    });
    expect(retried?.status).toBe('retrying');
    expect(readOutboxEvent('event-0030')?.status).toBe('retrying');
    expect(readOutboxEvent('event-0030')?.next_attempt_at).not.toBeNull();

    const [second] = claimDueEvents({ now: NOW + 2_000 });
    const dead = retryEvent(second.event_id, second.claim_token!, 'still unreachable', {
      now: NOW + 2_000,
      maxAttempts: 2,
    });
    expect(dead?.status).toBe('permanently_rejected');
    const row = readOutboxEvent('event-0030');
    expect(row?.status).toBe('permanently_rejected');
    expect(row?.claim_token).toBeNull();
  });

  it('an exhausted event is not counted as sent and is reported dead-lettered', () => {
    enqueueLaunchEvent(event(31), NOW);
    const result = drainLaunchOutbox({
      now: NOW,
      maxAttempts: 1,
      deliver: () => ({ ok: false, error: 'CC unreachable' }),
    });
    expect(result.permanentlyRejected).toBe(1);
    expect(result.delivered).toBe(0);
    const state = outboxSyncState({ now: NOW });
    expect(state.sent).toBe(0);
    expect(state.dead_lettered).toBe(1);
    expect(state.permanently_rejected).toBe(1);
  });
});

describe('F23.10 — honest synchronization report', () => {
  it('counts only accepted events as sent', () => {
    enqueueLaunchEvent(event(40), NOW);
    enqueueLaunchEvent(event(41), NOW);
    drainLaunchOutbox({
      now: NOW,
      deliver: (row) => (row.event_id === 'event-0040' ? { ok: true } : { ok: false, error: 'CC down' }),
    });
    const state = outboxSyncState({ now: NOW });
    expect(state.available).toBe(true);
    expect(state.accepted).toBe(1);
    expect(state.sent).toBe(1);
    expect(state.retrying).toBe(1);
    expect(state.remote_acceptance_claimed).toBe(false);
  });

  it('reports stale when undelivered work is older than the window', () => {
    enqueueLaunchEvent(event(42), NOW - 2 * HOUR);
    const state = outboxSyncState({ now: NOW, staleAfterMs: HOUR });
    expect(state.queued).toBe(1);
    expect(state.stale).toBe(true);
    expect(state.sent).toBe(0);
  });

  it('a broken outbox reports unavailable and stale, never an acceptance claim', () => {
    const original = ensureLaunchDomainSchema;
    // Simulate a CC outage: the store cannot be read at this moment.
    run('ALTER TABLE launch_event_outbox RENAME TO launch_event_outbox_hidden');
    try {
      const state = outboxSyncState({ now: NOW });
      expect(state.available).toBe(false);
      expect(state.stale).toBe(true);
      expect(state.sent).toBe(0);
      expect(state.remote_acceptance_claimed).toBe(false);
      expect(state.error).toBeTruthy();
    } finally {
      run('ALTER TABLE launch_event_outbox_hidden RENAME TO launch_event_outbox');
    }
    expect(original).toBeTruthy();
  });
});
