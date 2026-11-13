/**
 * remote-protocol.test.ts — the remote delivery ORDER GUARD and the parked
 * retry budget (WF-123).
 *
 * Four behaviours, each proven against a real in-memory database carrying
 * `INTERVIEW_REMOTE_SCHEMA_SQL` and a stubbed `fetch` (no network, no box):
 *
 *   1. A transport failure is PARKED, not fatal: eight failed attempts leave
 *      the answer `pending` with its attempt count retained.
 *   2. A dead-lettered operation blocks the operation behind it with the
 *      explicit reason `prior_operation_undelivered`, and nothing is sent.
 *   3. A 503 receipt is a parked failure: the answer stays `pending`.
 *   4. A 422 receipt rejects the answer, and a rejected answer blocks a later
 *      `complete` (which stays `pending`).
 *
 * Run: node --import tsx --test src/lib/interview/__tests__/remote-protocol.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolated throwaway DB + a local encryption key (never the box key salt), all
// set BEFORE any '@/lib/db' module is loaded by the dynamic imports below.
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-remote-protocol-'));
process.env.DATABASE_PATH = path.join(fixtureRoot, 'remote-protocol.db');
process.env.MC_INTERVIEW_SECRET = 'remote-protocol-fixture-secret';
process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({
  'remote.example': {
    tenantId: 'tenant-remote',
    companyId: 'company-remote',
    clientId: 'client-remote',
    installationId: 'install-remote',
    kind: 'client',
    remoteUrl: 'https://receiver.example',
    remoteSecret: 'remote-protocol-fixture-remote-secret',
  },
});
process.on('exit', () => {
  try {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; never masks the suite's result.
  }
});

const ctx = {
  tenantId: 'tenant-remote',
  companyId: 'company-remote',
  clientId: 'client-remote',
  kind: 'client' as const,
  subject: 'owner:remote',
  host: 'remote.example',
  installationId: 'install-remote',
};

type Operation = {
  operation_id: string;
  state: string;
  attempts: number;
  next_eligible_at: string | null;
  last_error: string | null;
  operation_type: string;
};

let loaded: Promise<any> | null = null;
function mods() {
  if (!loaded) {
    loaded = (async () => {
      const db = await import('../../../../src/lib/db');
      const schema = await import('../remote-schema');
      const store = await import('../remote-store');
      const protocol = await import('../remote-protocol');
      // The in-memory database carries the interview remote schema itself.
      db.getDb().exec(schema.INTERVIEW_REMOTE_SCHEMA_SQL);
      return { db, store, protocol };
    })();
  }
  return loaded;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function resetTenant(db: any) {
  db.run('DELETE FROM interview_remote_operations WHERE tenant_id=?', [ctx.tenantId]);
}

function readOperation(db: any, operationId: string): Operation {
  const row = db.queryOne('SELECT * FROM interview_remote_operations WHERE operation_id=?', [operationId]);
  assert.ok(row, `operation ${operationId} must exist`);
  return row as Operation;
}

test('a transport failure is parked: eight attempts leave the answer pending', async () => {
  const { db, store, protocol } = await mods();
  resetTenant(db);
  const answer = store.queueInterviewOperation(ctx, 'answer', { questionId: 'q1', prompt: 'P1?', answer: 'A1' }, 'bu105-op-answer-a');
  store.queueInterviewOperation(ctx, 'answer', { questionId: 'q2', prompt: 'P2?', answer: 'A2' }, 'bu105-op-answer-b');
  store.queueInterviewOperation(ctx, 'complete', {}, 'bu105-op-complete');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('transport down');
  };
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      db.run('UPDATE interview_remote_operations SET next_eligible_at=NULL WHERE operation_id=?', [answer.operation_id]);
      const result = await protocol.deliverInterviewOperation(ctx, readOperation(db, answer.operation_id));
      assert.equal(result.state, 'pending');
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  const row = readOperation(db, answer.operation_id);
  assert.equal(row.state, 'pending');
  assert.equal(row.attempts, 8);
  assert.equal(row.last_error, 'remote_transport_unresolved');
});

test('a dead-lettered operation blocks the one behind it and nothing is sent', async () => {
  const { db, store, protocol } = await mods();
  resetTenant(db);
  const first = store.queueInterviewOperation(ctx, 'answer', { questionId: 'q1', prompt: 'P1?', answer: 'A1' }, 'bu105-dead-answer-a');
  const second = store.queueInterviewOperation(ctx, 'answer', { questionId: 'q2', prompt: 'P2?', answer: 'A2' }, 'bu105-dead-answer-b');

  db.run("UPDATE interview_remote_operations SET state='dead_letter',attempts=5,last_error='remote_retry_exhausted' WHERE operation_id=?", [
    first.operation_id,
  ]);

  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    throw new Error('must not be called');
  };
  try {
    const result = await protocol.deliverInterviewOperation(ctx, readOperation(db, second.operation_id));
    assert.equal(result.state, 'pending');
    assert.equal(result.reason, 'prior_operation_undelivered');
    assert.equal(calls, 0);
    assert.equal(readOperation(db, second.operation_id).state, 'pending');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a 503 receipt is a parked failure: the answer stays pending', async () => {
  const { db, store, protocol } = await mods();
  resetTenant(db);
  const answer = store.queueInterviewOperation(ctx, 'answer', { questionId: 'q1', prompt: 'P1?', answer: 'A1' }, 'bu105-503-answer-a');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url: any, init: any) => {
    const body = JSON.parse(String(init.body));
    if (body.type === 'capabilities') {
      return json({ protocol: protocol.INTERVIEW_PROTOCOL, installationId: ctx.installationId, operations: ['answer', 'complete'] });
    }
    return json({
      operationId: body.operationId,
      tenantId: ctx.tenantId,
      installationId: ctx.installationId,
      state: 'acknowledged',
      httpStatus: 503,
    });
  };
  try {
    const result = await protocol.deliverInterviewOperation(ctx, readOperation(db, answer.operation_id));
    assert.equal(result.state, 'pending');
    assert.equal(result.reason, 'remote_http_503');
  } finally {
    globalThis.fetch = originalFetch;
  }

  const row = readOperation(db, answer.operation_id);
  assert.equal(row.state, 'pending');
  assert.equal(row.last_error, 'remote_http_503');
});

test('a 422 receipt rejects the answer, and that rejection blocks a later complete', async () => {
  const { db, store, protocol } = await mods();
  resetTenant(db);
  const answer = store.queueInterviewOperation(ctx, 'answer', { questionId: 'q1', prompt: 'P1?', answer: 'A1' }, 'bu105-422-answer-a');
  const complete = store.queueInterviewOperation(ctx, 'complete', {}, 'bu105-422-complete');

  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url: any, init: any) => {
    calls++;
    const body = JSON.parse(String(init.body));
    if (body.type === 'capabilities') {
      return json({ protocol: protocol.INTERVIEW_PROTOCOL, installationId: ctx.installationId, operations: ['answer', 'complete'] });
    }
    return json({
      operationId: body.operationId,
      tenantId: ctx.tenantId,
      installationId: ctx.installationId,
      state: 'acknowledged',
      httpStatus: 422,
    });
  };
  try {
    const rejected = await protocol.deliverInterviewOperation(ctx, readOperation(db, answer.operation_id));
    assert.equal(rejected.state, 'rejected');
    assert.equal(readOperation(db, answer.operation_id).state, 'rejected');

    const callsBefore = calls;
    db.run('UPDATE interview_remote_operations SET next_eligible_at=NULL WHERE operation_id=?', [complete.operation_id]);
    const blocked = await protocol.deliverInterviewOperation(ctx, readOperation(db, complete.operation_id));
    assert.equal(blocked.state, 'pending');
    assert.equal(blocked.reason, 'prior_operation_undelivered');
    assert.equal(calls, callsBefore, 'the blocked complete must not be sent');
    assert.equal(readOperation(db, complete.operation_id).state, 'pending');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
