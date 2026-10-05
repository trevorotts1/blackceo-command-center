/**
 * B13 — SPEC S9 durable-turn reconciliation, proven with an INJECTED clock.
 *
 * Every case below advances a controlled clock; no test reads the wall clock,
 * no test waits, and no test touches a gateway. The `hq_chat_turns` table is
 * created here in the SPEC S6 shape (storage-auth.md §(b.3) — B01 owns the real
 * DDL in migration 169) on the disposable database the isolated fixture points
 * DATABASE_PATH at.
 *
 * Run (from the worktree root):
 *   node --import tsx --import ./tests/setup/no-owner-telegram.ts --import ./tests/setup/tmp-sandbox.ts \
 *     --test tests/unit/hq/B13/reconcile.test.ts
 */
import './../../_isolated-db'; // MUST be first DB import: throwaway DATABASE_PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getDb, getDbPath, queryOne, run } from '../../../../src/lib/db';

const db = getDb(); // applies the full migration chain to the disposable file
console.log(`[B13] resolved DATABASE_PATH = ${getDbPath()}`);

run(`CREATE TABLE IF NOT EXISTS hq_chat_turns (
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
  UNIQUE(company_id, session_id, client_request_id)
)`);
run(`CREATE INDEX IF NOT EXISTS ix_b13_turns ON hq_chat_turns (company_id, session_id, created_at, id)`);

const T0 = Date.parse('2026-10-04T00:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

function clear(): void {
  run('DELETE FROM hq_chat_turns');
}

type Seed = {
  id: string;
  companyId?: string;
  sessionId?: string;
  state: string;
  attempts?: number;
  leaseToken?: string | null;
  leaseExpiresAt?: string | null;
  gatewaySessionKey?: string | null;
  sourceRunId?: string | null;
  replyText?: string | null;
};

function seed(row: Seed): void {
  run(
    `INSERT INTO hq_chat_turns
       (id, company_id, session_id, owner_subject, client_request_id, payload_hash, message_text,
        reply_text, state, attempts, lease_token, lease_expires_at, gateway_session_key, source_run_id,
        created_at, updated_at)
     VALUES (?, ?, ?, 'owner-1', ?, 'hash', 'hello', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.companyId ?? 'co-a',
      row.sessionId ?? 'sess-1',
      `req-${row.id}`,
      row.replyText ?? null,
      row.state,
      row.attempts ?? 0,
      row.leaseToken ?? null,
      row.leaseExpiresAt ?? null,
      row.gatewaySessionKey ?? `agent:rt-1:hq-${row.id}`,
      row.sourceRunId ?? null,
      iso(T0),
      iso(T0),
    ],
  );
}

function turnOf(id: string) {
  return queryOne<{ state: string; reply_text: string | null; error_code: string | null; terminal_at: string | null; source_run_id: string | null }>(
    'SELECT state, reply_text, error_code, terminal_at, source_run_id FROM hq_chat_turns WHERE id = ?',
    [id],
  )!;
}

async function reconcile(nowMs: number, probe?: Parameters<typeof import('../../../../src/lib/jobs/hq-chat-reconcile').runHqChatReconcile>[0]['probe']) {
  const mod = await import('../../../../src/lib/jobs/hq-chat-reconcile');
  return mod.runHqChatReconcile({ now: () => nowMs, probe });
}

test('expired lease: sending -> reconciling; live lease untouched; queued reported not mutated', async () => {
  clear();
  seed({ id: 'expired-sending', state: 'sending', leaseToken: 'L1', leaseExpiresAt: iso(T0 - 60_000) });
  seed({ id: 'live-sending', state: 'sending', leaseToken: 'L2', leaseExpiresAt: iso(T0 + 60_000) });
  seed({ id: 'fresh-queued', state: 'queued', attempts: 0 });
  seed({ id: 'retried-queued', state: 'queued', attempts: 2 });

  const result = await reconcile(T0);
  assert.deepEqual(result.expiredToReconciling, ['expired-sending']);
  assert.equal(turnOf('expired-sending').state, 'reconciling');
  assert.equal(turnOf('live-sending').state, 'sending', 'a live lease belongs to another sender');
  assert.deepEqual(result.staleQueuedClaimable, ['fresh-queued'], 'claims are the send path’s, this job only reports them');
  assert.equal(turnOf('fresh-queued').state, 'queued');
  assert.equal(result.correlationCapability, 'unavailable');
  assert.equal(result.unresolved.length, 0, 'inside the window: uncertainty is not yet terminal');
});

test('10-minute unresolved case (controlled clock): no capability, boundary at exactly 10 minutes', async () => {
  clear();
  seed({ id: 'uncertain', state: 'awaiting_reply', leaseToken: 'L3', leaseExpiresAt: iso(T0) });

  const at9m59s = await reconcile(T0 + 9 * 60_000 + 59_000);
  assert.deepEqual(at9m59s.expiredToReconciling, ['uncertain']);
  assert.deepEqual(at9m59s.unresolved, [], 'must not resolve before the bounded window elapses');
  assert.deepEqual(at9m59s.inconclusive, [], 'a just-expired turn is moved, not probed, in the same pass');
  assert.equal(turnOf('uncertain').state, 'reconciling');

  // Already reconciling and still inside the window: no capability means it is
  // reported inconclusive, not guessed.
  const stillInside = await reconcile(T0 + 9 * 60_000 + 59_500);
  assert.deepEqual(stillInside.inconclusive, [{ turnId: 'uncertain', reason: 'capability_unavailable' }]);
  assert.deepEqual(stillInside.unresolved, []);
  assert.equal(turnOf('uncertain').state, 'reconciling');

  const at10m = await reconcile(T0 + 10 * 60_000);
  assert.deepEqual(at10m.unresolved, ['uncertain'], 'at the boundary the honest outcome is terminal uncertainty');
  const row = turnOf('uncertain');
  assert.equal(row.state, 'unresolved');
  assert.equal(row.error_code, 'delivery_uncertain');
  assert.equal(row.reply_text, null, 'no fabricated reply');
  assert.ok(row.terminal_at, 'unresolved is terminal');

  // Bounded and idempotent: the same clock again changes nothing.
  const again = await reconcile(T0 + 10 * 60_000);
  assert.deepEqual(again.unresolved, []);
  assert.deepEqual(again.expiredToReconciling, []);

  const mod = await import('../../../../src/lib/jobs/hq-chat-reconcile');
  assert.equal(mod.HQ_CHAT_RECONCILE_UNRESOLVED_MS, 10 * 60 * 1000);
  assert.equal(mod.HQ_CHAT_DELIVERY_UNCERTAIN_MESSAGE, 'Delivery uncertain; inspect conversation before sending again');
});

test('known completion: matching correlation observation marks replied and persists authoritative text', async () => {
  clear();
  seed({ id: 'proven', state: 'reconciling', leaseToken: 'L4', leaseExpiresAt: iso(T0 - 60_000), gatewaySessionKey: 'agent:rt-1:hq-proven' });

  const seen: string[] = [];
  const result = await reconcile(T0, async (turn) => {
    seen.push(`${turn.id}:${turn.gateway_session_key}`);
    return { outcome: 'completed', gatewaySessionKey: 'agent:rt-1:hq-proven', runId: 'run-9', replyText: '  the head’s answer  ', completedAt: iso(T0 - 30_000) };
  });

  assert.deepEqual(seen, ['proven:agent:rt-1:hq-proven'], 'one query per reconciling turn, correlated by the per-turn key');
  assert.deepEqual(result.provenReplied, ['proven']);
  const row = turnOf('proven');
  assert.equal(row.state, 'replied');
  assert.equal(row.reply_text, 'the head’s answer');
  assert.equal(row.source_run_id, 'run-9');
  assert.ok(row.terminal_at);

  // An unknown send is never retried: nothing here can enter a sending/queued state.
  assert.equal(queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM hq_chat_turns WHERE state IN ('sending','queued')`, [])!.n, 0);
});

test('honest unresolved: partial reply text, foreign key, non-completion and probe error never become success', async () => {
  clear();
  seed({ id: 'partial', state: 'reconciling', replyText: 'half a sen', leaseToken: 'L5', leaseExpiresAt: iso(T0 - 60_000) });
  seed({ id: 'foreign-key', state: 'reconciling', leaseToken: 'L6', leaseExpiresAt: iso(T0 - 60_000), gatewaySessionKey: 'agent:rt-1:hq-foreign' });
  seed({ id: 'empty-final', state: 'reconciling', leaseToken: 'L7', leaseExpiresAt: iso(T0 - 60_000) });
  seed({ id: 'probe-throws', state: 'reconciling', leaseToken: 'L8', leaseExpiresAt: iso(T0 - 60_000) });

  const result = await reconcile(T0, async (turn) => {
    if (turn.id === 'foreign-key') {
      return { outcome: 'completed', gatewaySessionKey: 'agent:rt-1:hq-SOMEONE-ELSE', runId: 'run-x', replyText: 'different turn', completedAt: iso(T0) };
    }
    if (turn.id === 'empty-final') {
      return { outcome: 'completed', gatewaySessionKey: turn.gateway_session_key!, runId: null, replyText: '   ', completedAt: iso(T0) };
    }
    if (turn.id === 'probe-throws') throw new Error('gateway read failed');
    return { outcome: 'unsupported' };
  });

  assert.deepEqual(result.provenReplied, []);
  assert.deepEqual(
    result.inconclusive.map((entry) => [entry.turnId, entry.reason]).sort(),
    [
      ['empty-final', 'no_matching_evidence'],
      ['foreign-key', 'no_matching_evidence'],
      ['partial', 'no_matching_evidence'],
      ['probe-throws', 'probe_error'],
    ].sort(),
  );
  for (const id of ['partial', 'foreign-key', 'empty-final', 'probe-throws']) {
    assert.equal(turnOf(id).state, 'reconciling', `${id} stays nonterminal inside the window`);
    assert.equal(turnOf(id).terminal_at, null);
  }
  assert.equal(turnOf('partial').reply_text, 'half a sen', 'buffered partial text stays labeled partial, not a reply');

  // Past the window the same inconclusive evidence ends unresolved — never replied.
  const later = await reconcile(T0 + 10 * 60_000, async () => ({ outcome: 'unsupported' }));
  assert.deepEqual(later.unresolved.sort(), ['empty-final', 'foreign-key', 'partial', 'probe-throws']);
  for (const id of ['empty-final', 'foreign-key', 'partial', 'probe-throws']) {
    assert.equal(turnOf(id).state, 'unresolved');
    assert.equal(turnOf(id).error_code, 'delivery_uncertain');
  }
});

test('capability absent is not invented: no gateway history method is referenced anywhere in the job', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/jobs/hq-chat-reconcile.ts'), 'utf8');
  for (const forbidden of ['openclaw', 'sessions.history', 'gateway.ts', 'sessions.send', 'forwardToAgent']) {
    assert.equal(source.toLowerCase().includes(forbidden.toLowerCase()), false, `job must not reference ${forbidden}`);
  }
});
