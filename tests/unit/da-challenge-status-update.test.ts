import './_isolated-db'; // MUST be first — throwaway DB, never the live board.

import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';

import { POST } from '../../src/app/api/da-challenges/route';
import { PATCH } from '../../src/app/api/da-challenges/[id]/route';
import { getDb } from '../../src/lib/db';
import { requiresBearerForWrite } from '../../src/lib/bearer-required-routes';

/**
 * Devil's Advocate escalation tracking: POST always inserts 'pending', so
 * without PATCH /api/da-challenges/{id} nothing could ever set 'escalated'.
 *
 * node --import tsx --test tests/unit/da-challenge-status-update.test.ts
 */

async function seed(): Promise<string> {
  const res = await POST(
    new NextRequest('http://localhost/api/da-challenges', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        trigger_type: 'critical_task',
        department: 'marketing',
        challenge: 'Is the spend justified?',
        task_id: 't-1',
      }),
    }),
  );
  assert.equal(res.status, 201);
  return (await res.json()).challenge.id;
}

function patch(id: string, body: unknown) {
  return PATCH(
    new NextRequest(`http://localhost/api/da-challenges/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

test('a new challenge starts pending and PATCH can escalate it', async () => {
  const id = await seed();
  const res = await patch(id, { status: 'escalated' });
  assert.equal(res.status, 200);
  const { challenge } = await res.json();
  assert.equal(challenge.status, 'escalated');
  assert.equal(challenge.resolved_at, null, 'escalated is still open');
  const row = getDb().prepare('SELECT status FROM da_challenges WHERE id = ?').get(id) as { status: string };
  assert.equal(row.status, 'escalated', 'persisted, not just echoed');
});

test('approved/rejected stamp resolved_at; returning to an open state clears it', async () => {
  const id = await seed();
  for (const s of ['approved', 'rejected']) {
    const { challenge } = await (await patch(id, { status: s })).json();
    assert.equal(challenge.status, s);
    assert.ok(challenge.resolved_at, `${s} must stamp resolved_at`);
  }
  const { challenge } = await (await patch(id, { status: 'escalated' })).json();
  assert.equal(challenge.resolved_at, null);
});

test('rejects a status outside the four-state lifecycle, and an unknown id', async () => {
  const id = await seed();
  assert.equal((await patch(id, { status: 'open' })).status, 400);
  assert.equal((await patch(id, {})).status, 400);
  assert.equal((await patch('no-such-id', { status: 'escalated' })).status, 404);
  const row = getDb().prepare('SELECT status FROM da_challenges WHERE id = ?').get(id) as { status: string };
  assert.equal(row.status, 'pending', 'a rejected update must not change the row');
});

test('the item path is browser-callable (not bearer-gated) while the collection stays bearer-only', () => {
  assert.equal(requiresBearerForWrite('/api/da-challenges/abc', 'PATCH'), false);
  assert.equal(requiresBearerForWrite('/api/da-challenges', 'POST'), true);
});
