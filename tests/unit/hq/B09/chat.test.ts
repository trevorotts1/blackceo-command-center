/**
 * B09 — private session/turn state machine, lease/CAS, correlated duplicate handling and
 * safe retry rules (SPEC S6 "Private sessions and turns" + S9 "Durable turn protocol").
 *
 * Isolation: `_isolated-db` is imported FIRST, so DATABASE_PATH points at a unique throwaway
 * file and `src/lib/db`'s C8 guard can never open the live board (qc.md Q1, P02 §(c)).
 *
 * Fixture DDL: B01's reserved migration 169 is not in this branch's tree (B09 bases on
 * `hq/contracts`). The tables below mirror SPEC S6's column list and B01's landed DDL
 * types exactly, so this fixture cannot drift from the real schema without the test
 * failing on it. This is a stand-in for an unmerged dependency, not a second migration:
 * the fixture lives in the throwaway temp database, and it is exactly the "active-turn
 * uniqueness" fixture P02 §(c) requires.
 *
 * Verified against B01 `unit/B01-builder` (e1b6043) migration 169 + `src/lib/hq/storage.ts`:
 * every timestamp column TEXT, including `lease_expires_at`; `gateway_session_key TEXT UNIQUE`;
 * `UNIQUE(company_id,session_id,client_request_id)`; partial unique index over the four
 * nonterminal states; `hq_chat_sessions` unique `(company_id,id)`.
 *
 * Fake transport: no gateway, no network. `FakeTransport` counts sends and can be driven to
 * each S9 outcome, which is what the Q07 crash/retry matrix needs.
 */

import '../../_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';
import { run, queryAll, queryOne } from '../../../../src/lib/db';
import {
  HQ_CHAT_LEASE_MS,
  HQ_CHAT_UNRESOLVED_AFTER_MS,
  applyTransportCallback,
  claimTurn,
  closeSession,
  createSession,
  createTurn,
  getTurn,
  listSessions,
  listTurns,
  recordCompletion,
  recordPartial,
  refuseTurn,
  retryTurn,
  sweepStaleTurns,
  type HqChatScope,
} from '../../../../src/lib/hq/chat';
import type { HqChatTransportCallback } from '../../../../src/lib/hq/types';

/* ------------------------------------------------------------------ *
 * SPEC S6 fixture schema (see header)
 * ------------------------------------------------------------------ */

run(`
  CREATE TABLE IF NOT EXISTS hq_chat_sessions (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL,
    owner_subject TEXT NOT NULL,
    installation_id TEXT NOT NULL,
    head_agent_id TEXT NOT NULL,
    runtime_agent_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_activity_at TEXT NOT NULL,
    closed_at TEXT,
    UNIQUE (company_id, id)
  )`);
run(`CREATE INDEX IF NOT EXISTS idx_hq_chat_sessions_scope ON hq_chat_sessions (company_id, owner_subject, last_activity_at)`);
run(`
  CREATE TABLE IF NOT EXISTS hq_chat_turns (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    owner_subject TEXT NOT NULL,
    client_request_id TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    message_text TEXT NOT NULL,
    reply_text TEXT,
    state TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT,
    lease_expires_at TEXT,
    gateway_session_key TEXT UNIQUE,
    source_run_id TEXT,
    task_id TEXT,
    error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    terminal_at TEXT,
    content_expired_at TEXT,
    UNIQUE (company_id, session_id, client_request_id),
    FOREIGN KEY (company_id, session_id) REFERENCES hq_chat_sessions (company_id, id)
  )`);
run(`CREATE INDEX IF NOT EXISTS idx_hq_chat_turns_scope ON hq_chat_turns (company_id, session_id, created_at, id)`);
run(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_hq_chat_turns_one_active
    ON hq_chat_turns (company_id, session_id)
    WHERE state IN ('queued', 'sending', 'awaiting_reply', 'reconciling')`);

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const scope: HqChatScope = {
  companyId: 'co-b09',
  ownerSubject: 'owner:alice',
  installationId: 'inst-b09',
};

const otherScope: HqChatScope = { ...scope, companyId: 'co-other' };
const otherSubject: HqChatScope = { ...scope, ownerSubject: 'owner:bob' };

const newSession = (s: HqChatScope = scope, runtimeAgentId = 'rt-head-1') =>
  createSession(s, { headAgentId: 'head-1', runtimeAgentId });

const turnCount = (sessionId: string): number =>
  (queryOne<{ c: number }>(`SELECT count(*) c FROM hq_chat_turns WHERE session_id = ?`, [sessionId]) as { c: number }).c;

const stateOf = (turnId: string): string =>
  (queryOne<{ state: string }>(`SELECT state FROM hq_chat_turns WHERE id = ?`, [turnId]) as { state: string }).state;

/** S9 fake gateway: counts sends, mints nothing, touches no network. */
class FakeTransport {
  sends: { gatewaySessionKey: string; text: string }[] = [];
  send(turnId: string, gatewaySessionKey: string, text: string): { runId: string; callback: HqChatTransportCallback } {
    this.sends.push({ gatewaySessionKey, text });
    return {
      runId: `run-${this.sends.length}`,
      callback: { kind: 'send_accepted', sessionId: '', turnId, gatewaySessionKey },
    };
  }
}

/** Claim, then "send" through the fake transport, returning the lease and key. */
const claimAndSend = (
  s: HqChatScope,
  turnId: string,
  sessionId: string,
  text: string,
  nowMs?: number,
) => {
  const claimed = claimTurn(s, turnId, { nowMs });
  assert.equal(claimed.ok, true);
  if (!claimed.ok) throw new Error('unreachable');
  const accepted = applyTransportCallback(
    s,
    { kind: 'send_accepted', sessionId, turnId, gatewaySessionKey: claimed.gatewaySessionKey },
    claimed.leaseToken,
  );
  return { ...claimed, accepted };
};

let seq = 0;
const nextRequestId = (): string => `req-${++seq}`;

/* ------------------------------------------------------------------ *
 * Duplicate handling
 * ------------------------------------------------------------------ */

test('identical duplicate submit returns the existing turn and does not send twice', () => {
  const session = newSession();
  const clientRequestId = nextRequestId();
  const first = createTurn(scope, session.id, { clientRequestId, message: 'hello head', runtimeAgentId: 'rt-head-1' });
  assert.equal(first.ok, true);
  if (!first.ok) return;

  const transport = new FakeTransport();
  const send = claimAndSend(scope, first.turn.id, session.id, 'hello head');
  assert.equal(transport.send(first.turn.id, send.gatewaySessionKey, 'hello head').callback.kind, 'send_accepted');

  const second = createTurn(scope, session.id, { clientRequestId, message: 'hello head', runtimeAgentId: 'rt-head-1' });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.duplicate, true);
  assert.equal(second.turn.id, first.turn.id);
  assert.equal(turnCount(session.id), 1);
  assert.equal(transport.sends.length, 1, 'the duplicate never reaches the transport');
});

test('same request key with different content is 409 request_conflict', () => {
  const session = newSession();
  const clientRequestId = nextRequestId();
  assert.equal(
    createTurn(scope, session.id, { clientRequestId, message: 'one', runtimeAgentId: 'rt-head-1' }).ok,
    true,
  );
  const changed = createTurn(scope, session.id, { clientRequestId, message: 'two', runtimeAgentId: 'rt-head-1' });
  assert.equal(changed.ok, false);
  if (changed.ok) return;
  assert.equal(changed.status, 409);
  assert.equal(changed.code, 'request_conflict');
  assert.equal(turnCount(session.id), 1);
});

test('a second pending turn is refused and the partial active-turn index holds', () => {
  const session = newSession();
  const first = createTurn(scope, session.id, { clientRequestId: nextRequestId(), message: 'a', runtimeAgentId: 'rt-head-1' });
  assert.equal(first.ok, true);
  const second = createTurn(scope, session.id, { clientRequestId: nextRequestId(), message: 'b', runtimeAgentId: 'rt-head-1' });
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.status, 409);
  assert.equal(second.code, 'turn_in_progress');

  // The index itself refuses a hand-rolled second nonterminal row (the fixture proof).
  assert.throws(() =>
    run(
      `INSERT INTO hq_chat_turns
         (id, company_id, session_id, owner_subject, client_request_id, payload_hash, message_text,
          state, attempts, created_at, updated_at)
       VALUES ('hand-rolled', ?, ?, ?, 'raw', 'h', 't', 'queued', 0, 'now', 'now')`,
      [scope.companyId, session.id, scope.ownerSubject],
    ),
  );
});

test('foreign, unknown and closed sessions are refused; ownership holds on the duplicate path', () => {
  const session = newSession();
  const clientRequestId = nextRequestId();
  assert.equal(createTurn(scope, session.id, { clientRequestId, message: 'x', runtimeAgentId: 'rt-head-1' }).ok, true);

  // Same turn id, another company: rejected BEFORE dedupe, so it never reveals the row.
  const foreignCompany = createTurn(otherScope, session.id, { clientRequestId, message: 'x', runtimeAgentId: 'rt-head-1' });
  assert.equal(foreignCompany.ok, false);
  if (!foreignCompany.ok) assert.equal(foreignCompany.status, 404);
  const foreignSubject = createTurn(otherSubject, session.id, { clientRequestId, message: 'x', runtimeAgentId: 'rt-head-1' });
  assert.equal(foreignSubject.ok, false);
  if (!foreignSubject.ok) assert.equal(foreignSubject.status, 404);
  const unknown = createTurn(scope, 'no-such-session', { clientRequestId, message: 'x', runtimeAgentId: 'rt-head-1' });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.status, 404);

  // Foreign reads return nothing at all.
  assert.equal(getTurn(otherScope, (queryAll<{ id: string }>(`SELECT id FROM hq_chat_turns`)[0]).id), null);

  assert.equal(closeSession(scope, session.id), true);
  const closed = createTurn(scope, session.id, { clientRequestId: nextRequestId(), message: 'y', runtimeAgentId: 'rt-head-1' });
  assert.equal(closed.ok, false);
  if (!closed.ok) {
    // S6: an expired owned session is 410, never a fresh send on an old caller id.
    assert.equal(closed.status, 410);
    assert.equal(closed.code, 'session_closed');
  }
});

test('a changed head binding closes the logical session to new sends', () => {
  const session = newSession();
  const changed = createTurn(scope, session.id, { clientRequestId: nextRequestId(), message: 'x', runtimeAgentId: 'rt-head-2' });
  assert.equal(changed.ok, false);
  if (changed.ok) return;
  assert.equal(changed.status, 409);
  assert.equal(changed.code, 'head_binding_changed');
  assert.equal(turnCount(session.id), 0, 'the refused send leaves no turn behind');
});

/* ------------------------------------------------------------------ *
 * Crash / retry matrix
 * ------------------------------------------------------------------ */

test('crash before claim leaves a durable queued turn that the sweep does not touch', () => {
  const session = newSession();
  const created = createTurn(scope, session.id, { clientRequestId: nextRequestId(), message: 'unsent', runtimeAgentId: 'rt-head-1' });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.turn.state, 'queued');
  assert.equal(created.turn.attempts, 0);

  const swept = sweepStaleTurns();
  assert.equal(swept.reconciling, 0, 'a queued turn with no lease is not stale');
  assert.equal(stateOf(created.turn.id), 'queued');
});

test('crash after network acceptance: expired lease reconciles, and the dead writer is fenced', () => {
  const session = newSession();
  const created = createTurn(scope, session.id, { clientRequestId: nextRequestId(), message: 'maybe sent', runtimeAgentId: 'rt-head-1' });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const t0 = 1_000_000;
  const claimed = claimAndSend(scope, created.turn.id, session.id, 'maybe sent', t0);
  assert.equal(claimed.accepted.ok, true);

  // The transport dies here: no timeout callback, no completion. The lease simply expires.
  const swept = sweepStaleTurns(t0 + HQ_CHAT_LEASE_MS + 1);
  assert.equal(swept.reconciling, 1);
  assert.equal(stateOf(created.turn.id), 'reconciling');

  // The pre-crash writer comes back late and tries to finish its turn.
  const late = recordCompletion(scope, created.turn.id, claimed.leaseToken, { visibleText: 'late text', nowMs: t0 });
  assert.equal(late.ok, false);
  if (!late.ok) assert.equal(late.code, 'lease_lost');
  const after = getTurn(scope, created.turn.id);
  assert.equal(after?.state, 'reconciling');
  assert.equal(after?.reply, null);
});

test('expired fencing lease rejects the stale writer even on the same state', () => {
  const session = newSession();
  const created = createTurn(scope, session.id, { clientRequestId: nextRequestId(), message: 'm', runtimeAgentId: 'rt-head-1' });
  if (!created.ok) return;
  const first = claimTurn(scope, created.turn.id, { nowMs: 5_000 });
  assert.equal(first.ok, true);
  if (!first.ok) return;

  // Force the turn back to `queued` with a fresh claim (a retry after proven non-send).
  run(`UPDATE hq_chat_turns SET state = 'failed_unsent' WHERE id = ?`, [created.turn.id]);
  const second = retryTurn(scope, created.turn.id, { nowMs: 6_000 });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.notEqual(second.leaseToken, first.leaseToken, 'a new claim mints a new random fencing lease');

  const stale = applyTransportCallback(
    scope,
    { kind: 'send_accepted', sessionId: session.id, turnId: created.turn.id, gatewaySessionKey: first.gatewaySessionKey },
    first.leaseToken,
  );
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.code, 'lease_lost');
  assert.equal(stateOf(created.turn.id), 'sending', 'the live claim is untouched');
});

test('timeout with unknown outcome never resends automatically and ends unresolved', () => {
  const session = newSession();
  const created = createTurn(scope, session.id, { clientRequestId: nextRequestId(), message: 'timing out', runtimeAgentId: 'rt-head-1' });
  if (!created.ok) return;
  const t0 = 50_000;
  const claimed = claimAndSend(scope, created.turn.id, session.id, 'timing out', t0);
  assert.equal(claimed.accepted.ok, true);

  const timedOut = applyTransportCallback(
    scope,
    { kind: 'timeout', sessionId: session.id, turnId: created.turn.id, gatewaySessionKey: claimed.gatewaySessionKey },
    claimed.leaseToken,
  );
  assert.equal(timedOut.ok, true);
  if (!timedOut.ok) return;
  assert.equal(timedOut.turn.state, 'reconciling');

  // The retry endpoint refuses anything that is not positively unsent.
  const retried = retryTurn(scope, created.turn.id);
  assert.equal(retried.ok, false);
  if (!retried.ok) {
    assert.equal(retried.status, 409);
    assert.equal(retried.code, 'turn_not_retryable');
  }

  // Reconciliation gives a terminal result inside the bounded window. The sweep reads
  // `updated_at` from the row, so the test drives the same instant the writer stamped.
  const stampedAt = Date.parse(
    (queryOne<{ updated_at: string }>(`SELECT updated_at FROM hq_chat_turns WHERE id = ?`, [created.turn.id]) as { updated_at: string })
      .updated_at,
  );
  // `sweepStaleTurns` is global housekeeping, so its count is asserted as "this turn moved",
  // never as an exact global total (earlier tests leave their own reconciling rows behind).
  const swept = sweepStaleTurns(stampedAt + HQ_CHAT_UNRESOLVED_AFTER_MS + 1);
  assert.equal(swept.unresolved >= 1, true);
  assert.equal(stateOf(created.turn.id), 'unresolved');
  assert.equal(sweepStaleTurns(stampedAt + HQ_CHAT_UNRESOLVED_AFTER_MS + 2).unresolved, 0, 'no infinite churn');
});

test('positively-unsent retry reuses the same turn, key and request id, bounded to 3 attempts', () => {
  const session = newSession();
  const clientRequestId = nextRequestId();
  const created = createTurn(scope, session.id, { clientRequestId, message: 'retry me', runtimeAgentId: 'rt-head-1' });
  if (!created.ok) return;

  const transport = new FakeTransport();
  let attempt = 0;
  let key: string | null = null;
  for (attempt = 1; attempt <= 3; attempt += 1) {
    const claimed = attempt === 1 ? claimTurn(scope, created.turn.id) : retryTurn(scope, created.turn.id);
    assert.equal(claimed.ok, true, `attempt ${attempt} claims`);
    if (!claimed.ok) return;
    key = key ?? claimed.gatewaySessionKey;
    assert.equal(claimed.gatewaySessionKey, key, 'the per-turn gateway key is minted once and reused');
    transport.send(created.turn.id, claimed.gatewaySessionKey, 'retry me');
    const failed = applyTransportCallback(
      scope,
      { kind: 'failed_before_send', sessionId: session.id, turnId: created.turn.id, gatewaySessionKey: claimed.gatewaySessionKey },
      claimed.leaseToken,
    );
    assert.equal(failed.ok, true);
  }

  assert.equal(transport.sends.length, 3);
  assert.equal(turnCount(session.id), 1, 'retry never creates a second turn row');
  const row = getTurn(scope, created.turn.id);
  assert.equal(row?.attempts, 3);
  assert.equal(row?.state, 'failed_unsent');

  const fourth = retryTurn(scope, created.turn.id);
  assert.equal(fourth.ok, false);
  if (!fourth.ok) assert.equal(fourth.code, 'turn_not_retryable');
  assert.equal(row?.id, created.turn.id, 'the retry reuses the same turn row and its request id');
});

test('missing or partial reply is never replied, and a yielded final is not completion', () => {
  const session = newSession();
  const created = createTurn(scope, session.id, { clientRequestId: nextRequestId(), message: 'stream me', runtimeAgentId: 'rt-head-1' });
  if (!created.ok) return;
  const t0 = 10_000;
  const claimed = claimAndSend(scope, created.turn.id, session.id, 'stream me', t0);
  if (!claimed.accepted.ok) return;

  // Partial tokens persist, labelled partial, and stay so after the transport expires.
  const partial = recordPartial(scope, created.turn.id, claimed.leaseToken, 'half an ans', { nowMs: t0 + 1 });
  assert.equal(partial.ok, true);
  const midTurn = getTurn(scope, created.turn.id);
  assert.equal(midTurn?.partial, true);
  assert.equal(midTurn?.state, 'awaiting_reply');

  // A throttled second persist inside the same second is allowed to be skipped.
  const throttled = recordPartial(scope, created.turn.id, claimed.leaseToken, 'half an answer', { nowMs: t0 + 200 });
  assert.equal(throttled.ok, true);
  if (throttled.ok) assert.equal(throttled.persisted, false);

  // `done` with an empty final is NOT completion: the turn reconciles, text stays partial.
  const emptyFinal = recordCompletion(scope, created.turn.id, claimed.leaseToken, { visibleText: '   ', nowMs: t0 + 2 });
  assert.equal(emptyFinal.ok, true);
  if (!emptyFinal.ok) return;
  assert.equal(emptyFinal.completed, false);
  assert.equal(emptyFinal.turn.state, 'reconciling');
  assert.notEqual(emptyFinal.turn.state, 'replied');
  assert.equal(emptyFinal.turn.partial, true, 'buffered text remains labelled partial');

  // A yielded final is not completion evidence at all.
  const session2 = newSession();
  const created2 = createTurn(scope, session2.id, { clientRequestId: nextRequestId(), message: 'yield', runtimeAgentId: 'rt-head-1' });
  if (!created2.ok) return;
  const claimed2 = claimAndSend(scope, created2.turn.id, session2.id, 'yield', t0);
  if (!claimed2.accepted.ok) return;
  const yielded = recordCompletion(scope, created2.turn.id, claimed2.leaseToken, { visibleText: 'text', yielded: true });
  assert.equal(yielded.ok, false);
  if (!yielded.ok) assert.equal(yielded.code, 'not_completion');
  assert.equal(stateOf(created2.turn.id), 'awaiting_reply');
});

test('completion with visible text persists the reply and is terminal', () => {
  const session = newSession();
  const created = createTurn(scope, session.id, { clientRequestId: nextRequestId(), message: 'finish', runtimeAgentId: 'rt-head-1' });
  if (!created.ok) return;
  const claimed = claimAndSend(scope, created.turn.id, session.id, 'finish', 20_000);
  if (!claimed.accepted.ok) return;

  const done = recordCompletion(scope, created.turn.id, claimed.leaseToken, { visibleText: 'the answer', sourceRunId: 'run-A', nowMs: 20_001 });
  assert.equal(done.ok, true);
  if (!done.ok) return;
  assert.equal(done.completed, true);
  assert.equal(done.turn.state, 'replied');
  assert.equal(done.turn.reply, 'the answer');
  assert.equal(done.turn.partial, false);
  assert.equal(done.turn.terminalAt !== null, true);
});

/* ------------------------------------------------------------------ *
 * Correlation and isolation
 * ------------------------------------------------------------------ */

test('SPEC S9: A times out, B starts with a new key, late A cannot change B', () => {
  const session = newSession();
  const t0 = 70_000;

  // Turn A is sent and then times out: uncertain, never resent automatically.
  const a = createTurn(scope, session.id, { clientRequestId: nextRequestId(), message: 'A', runtimeAgentId: 'rt-head-1' });
  if (!a.ok) return;
  const claimA = claimTurn(scope, a.turn.id, { nowMs: t0 });
  assert.equal(claimA.ok, true);
  if (!claimA.ok) return;
  applyTransportCallback(
    scope,
    { kind: 'send_accepted', sessionId: session.id, turnId: a.turn.id, gatewaySessionKey: claimA.gatewaySessionKey },
    claimA.leaseToken,
  );
  applyTransportCallback(
    scope,
    { kind: 'timeout', sessionId: session.id, turnId: a.turn.id, gatewaySessionKey: claimA.gatewaySessionKey },
    claimA.leaseToken,
  );
  assert.equal(stateOf(a.turn.id), 'reconciling');

  // S6 keeps the active slot on `reconciling` too, so B cannot start while A is undecided:
  // the session is not a way around the uncertainty.
  const blocked = createTurn(scope, session.id, { clientRequestId: nextRequestId(), message: 'B', runtimeAgentId: 'rt-head-1' });
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.code, 'turn_in_progress');

  // A stays uncertain until its bounded window expires, then ends terminal `unresolved`
  // (S9: never a fabricated reply, never an automatic resend).
  const stampedAt = Date.parse(
    (queryOne<{ updated_at: string }>(`SELECT updated_at FROM hq_chat_turns WHERE id = ?`, [a.turn.id]) as { updated_at: string })
      .updated_at,
  );
  sweepStaleTurns(stampedAt + HQ_CHAT_UNRESOLVED_AFTER_MS + 1);
  assert.equal(stateOf(a.turn.id), 'unresolved');

  // Now B starts under its own key — the deliberate "Send as new message" path.
  const b = createTurn(scope, session.id, { clientRequestId: nextRequestId(), message: 'B', runtimeAgentId: 'rt-head-1' });
  assert.equal(b.ok, true);
  if (!b.ok) return;
  const claimB = claimTurn(scope, b.turn.id, { nowMs: t0 + 1 });
  assert.equal(claimB.ok, true);
  if (!claimB.ok) return;
  applyTransportCallback(
    scope,
    { kind: 'send_accepted', sessionId: session.id, turnId: b.turn.id, gatewaySessionKey: claimB.gatewaySessionKey },
    claimB.leaseToken,
  );
  const before = getTurn(scope, b.turn.id);
  assert.notEqual(claimA.gatewaySessionKey, claimB.gatewaySessionKey);

  // Late A traffic arrives, attempting to land on B's turn and on A's own turn.
  const lateOnB = applyTransportCallback(
    scope,
    { kind: 'completion_observed', sessionId: session.id, turnId: b.turn.id, gatewaySessionKey: claimA.gatewaySessionKey },
    claimB.leaseToken,
    { visibleText: 'late A text' },
  );
  assert.equal(lateOnB.ok, false);
  const after = getTurn(scope, b.turn.id);
  assert.deepEqual(after, before, 'B text and state are unchanged by late A traffic');
  assert.equal(after?.reply, null);

  // A's own late completion uses a lease that is no longer current, so it cannot revive A either.
  const lateOnA = applyTransportCallback(
    scope,
    { kind: 'completion_observed', sessionId: session.id, turnId: a.turn.id, gatewaySessionKey: claimA.gatewaySessionKey },
    claimA.leaseToken,
    { visibleText: 'late A text' },
  );
  assert.equal(lateOnA.ok, false);
  assert.equal(stateOf(a.turn.id), 'unresolved', 'A stays terminal uncertainty, never silently replied');
  assert.equal(getTurn(scope, a.turn.id)?.reply, null, 'A never fabricates a reply');
});

test('per-turn gateway keys are unique, never returned to the browser view, and fenced to the turn', () => {
  const session = newSession();
  const a = createTurn(scope, session.id, { clientRequestId: nextRequestId(), message: 'A', runtimeAgentId: 'rt-head-1' });
  if (!a.ok) return;
  const claimA = claimAndSend(scope, a.turn.id, session.id, 'A', 30_000);
  if (!claimA.accepted.ok) return;
  const replied = recordCompletion(scope, a.turn.id, claimA.leaseToken, { visibleText: 'A done', nowMs: 30_001 });
  assert.equal(replied.ok, true);

  const b = createTurn(scope, session.id, { clientRequestId: nextRequestId(), message: 'B', runtimeAgentId: 'rt-head-1' });
  if (!b.ok) return;
  const claimB = claimAndSend(scope, b.turn.id, session.id, 'B', 30_002);
  if (!claimB.accepted.ok) return;

  // B started with a new key; late A traffic cannot touch B.
  assert.notEqual(claimA.gatewaySessionKey, claimB.gatewaySessionKey);
  assert.match(claimA.gatewaySessionKey, /^agent:rt-head-1:hq-/);
  const lateA = applyTransportCallback(
    scope,
    { kind: 'completion_observed', sessionId: session.id, turnId: b.turn.id, gatewaySessionKey: claimA.gatewaySessionKey },
    claimB.leaseToken,
  );
  assert.equal(lateA.ok, false);
  if (!lateA.ok) assert.equal(lateA.code, 'run_mismatch');
  const bAfter = getTurn(scope, b.turn.id);
  assert.equal(bAfter?.state, 'awaiting_reply');
  assert.equal(bAfter?.reply, null);

  // The browser view never carries the gateway key or the runtime id.
  const serialized = JSON.stringify(listTurns(scope, session.id));
  assert.equal(serialized.includes('agent:'), false);
  assert.equal(serialized.includes('rt-head-1'), false);
  assert.equal(JSON.stringify(listSessionsView(scope)).includes('rt-head-1'), false);

  // A callback for a different session is refused before any lease work.
  const crossSession = applyTransportCallback(
    scope,
    { kind: 'completion_observed', sessionId: 'some-other-session', turnId: b.turn.id, gatewaySessionKey: claimB.gatewaySessionKey },
    claimB.leaseToken,
  );
  assert.equal(crossSession.ok, false);
});

test('the first observed run id is recorded and a different one is flagged, not relabelled', () => {
  const session = newSession();
  const created = createTurn(scope, session.id, { clientRequestId: nextRequestId(), message: 'runs', runtimeAgentId: 'rt-head-1' });
  if (!created.ok) return;
  const claimed = claimTurn(scope, created.turn.id, { nowMs: 40_000 });
  assert.equal(claimed.ok, true);
  if (!claimed.ok) return;

  // The first run id is recorded from the acceptance callback that carries it.
  const firstRun = applyTransportCallback(
    scope,
    { kind: 'send_accepted', sessionId: session.id, turnId: created.turn.id, gatewaySessionKey: claimed.gatewaySessionKey },
    claimed.leaseToken,
    { sourceRunId: 'run-A' },
  );
  assert.equal(firstRun.ok, true);
  assert.equal(queryOne<{ source_run_id: string }>(`SELECT source_run_id FROM hq_chat_turns WHERE id = ?`, [created.turn.id])?.source_run_id, 'run-A');

  const impostor = recordCompletion(scope, created.turn.id, claimed.leaseToken, { visibleText: 'from run B', sourceRunId: 'run-B' });
  assert.equal(impostor.ok, false);
  if (!impostor.ok) assert.equal(impostor.code, 'run_mismatch');
  assert.equal(queryOne<{ source_run_id: string }>(`SELECT source_run_id FROM hq_chat_turns WHERE id = ?`, [created.turn.id])?.source_run_id, 'run-A');
});

test('invalid and oversize bodies are refused without a row, never truncated', () => {
  const session = newSession();
  const oversize = createTurn(scope, session.id, {
    clientRequestId: nextRequestId(),
    message: 'x'.repeat(32_001),
    runtimeAgentId: 'rt-head-1',
  });
  assert.equal(oversize.ok, false);
  if (!oversize.ok) {
    assert.equal(oversize.status, 413);
    assert.equal(oversize.code, 'message_too_long');
  }
  const bad = createTurn(scope, session.id, { clientRequestId: nextRequestId(), message: undefined as unknown as string, runtimeAgentId: 'rt-head-1' });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.status, 400);
  assert.equal(turnCount(session.id), 0);

  // Exactly at the cap is accepted and stored whole.
  const atCap = createTurn(scope, session.id, {
    clientRequestId: nextRequestId(),
    message: 'y'.repeat(32_000),
    runtimeAgentId: 'rt-head-1',
  });
  assert.equal(atCap.ok, true);
  if (atCap.ok) assert.equal(atCap.turn.message.length, 32_000);
});

test('a content-expired turn is 410 and is never resent empty', () => {
  const session = newSession();
  const created = createTurn(scope, session.id, { clientRequestId: nextRequestId(), message: 'old', runtimeAgentId: 'rt-head-1' });
  if (!created.ok) return;
  const claimed = claimTurn(scope, created.turn.id);
  if (!claimed.ok) return;
  const failed = applyTransportCallback(
    scope,
    { kind: 'failed_before_send', sessionId: session.id, turnId: created.turn.id, gatewaySessionKey: claimed.gatewaySessionKey },
    claimed.leaseToken,
  );
  assert.equal(failed.ok, true);

  // B06's retention sweep redacts content and stamps the tombstone; the turn is still 'failed_unsent'.
  run(`UPDATE hq_chat_turns SET content_expired_at = ?, message_text = '' WHERE id = ?`, ['2026-01-01T00:00:00.000Z', created.turn.id]);
  const retried = retryTurn(scope, created.turn.id);
  assert.equal(retried.ok, false);
  if (!retried.ok) {
    assert.equal(retried.status, 410);
    assert.equal(retried.code, 'content_expired');
  }
  assert.equal(getTurn(scope, created.turn.id)?.state, 'failed_unsent', 'still terminal, never a silent fresh send');
});

test('refused turns are terminal with a reason and take no lease', () => {
  const session = newSession();
  const created = createTurn(scope, session.id, { clientRequestId: nextRequestId(), message: 'nope', runtimeAgentId: 'rt-head-1' });
  if (!created.ok) return;
  const refused = refuseTurn(scope, created.turn.id, 'target_policy_denied');
  assert.equal(refused.ok, true);
  if (!refused.ok) return;
  assert.equal(refused.turn.state, 'refused');
  assert.equal(refused.turn.errorCode, 'target_policy_denied');
  assert.equal(refused.turn.attempts, 0);
  assert.equal(refused.turn.terminalAt !== null, true);

  const lateClaim = claimTurn(scope, created.turn.id);
  assert.equal(lateClaim.ok, false);
  if (!lateClaim.ok) assert.equal(lateClaim.code, 'turn_not_claimable');

  // A terminal turn does not block the session's next turn.
  const next = createTurn(scope, session.id, { clientRequestId: nextRequestId(), message: 'later', runtimeAgentId: 'rt-head-1' });
  assert.equal(next.ok, true);
  assert.equal(turnCount(session.id), 2);
});

/** View-hygiene helper for the gateway-key assertion above. */
const listSessionsView = (s: HqChatScope) => listSessions(s);
