import './_isolated-db'; // MUST be first: own throwaway DB, before @/lib/db loads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isOwnerQuestion, needsAudienceAnswer } from '../../src/lib/board/audience-chip';
import { selectionHolds } from '../../src/lib/board/board-truth';

const pending = { blend_confirm_state: 'pending', audience_source: null };

test('isOwnerQuestion: a genuine pending audience question is true', () => {
  assert.equal(isOwnerQuestion(pending), true);
  assert.equal(isOwnerQuestion({ ...pending, blocked_on_human: null, block_audience: 'OWNER', archived_at: null }), true);
});

test('isOwnerQuestion: operator-blocked is false', () => {
  assert.equal(isOwnerQuestion({ ...pending, blocked_on_human: 'operator' }), false);
});

test('isOwnerQuestion: SYSTEM audience is false', () => {
  assert.equal(isOwnerQuestion({ ...pending, block_audience: 'SYSTEM' }), false);
});

test('isOwnerQuestion: archived is false', () => {
  assert.equal(isOwnerQuestion({ ...pending, archived_at: '2026-11-01T00:00:00.000Z' }), false);
});

test('isOwnerQuestion: answered or not pending is false', () => {
  assert.equal(isOwnerQuestion({ blend_confirm_state: 'pending', audience_source: 'operator_confirmed' }), false);
  assert.equal(isOwnerQuestion({ blend_confirm_state: 'confirmed', audience_source: null }), false);
  assert.equal(isOwnerQuestion({}), false);
  // control: the unfiltered predicate still says true for an operator-blocked card
  assert.equal(needsAudienceAnswer({ ...pending, blocked_on_human: 'operator' } as never), true);
});

test('selectionHolds hides the owner-answer hold for operator/archived/system cards', () => {
  assert.equal(selectionHolds(pending).some((h) => h.title === 'Waiting for your answer'), true);
  for (const extra of [{ blocked_on_human: 'operator' }, { block_audience: 'SYSTEM' }, { archived_at: '2026-11-01' }]) {
    assert.equal(selectionHolds({ ...pending, ...extra }).some((h) => h.title === 'Waiting for your answer'), false);
  }
});

test('POST /api/tasks/[id]/audience on an archived task returns 409, not 500', async () => {
  const db = await import('../../src/lib/db');
  db.getDb();
  const NOW = '2026-11-17T00:00:00.000Z';
  db.run(`INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at) VALUES ('default','Default','default','{}',?,?)`, [NOW, NOW]);
  db.run(`INSERT OR IGNORE INTO workspaces (id, name, slug, description, icon, company_id, sort_order, created_at, updated_at) VALUES ('marketing','Marketing','marketing','','M','default',10,?,?)`, [NOW, NOW]);
  const { POST } = await import('../../src/app/api/tasks/[id]/audience/route');
  const { NextRequest } = await import('next/server');
  const call = (id: string) =>
    POST(
      new NextRequest(`http://localhost/api/tasks/${id}/audience`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ audienceLabel: 'Clients' }),
      }),
      { params: Promise.resolve({ id }) },
    );
  const expected = 'This task is archived or no longer active, so there is nothing to answer.';
  db.run(`INSERT INTO tasks (id, title, description, department, status, workspace_id, archived_at, created_at, updated_at) VALUES ('oq-arch','t','d','Marketing','backlog','marketing',?,?,?)`, [NOW, NOW, NOW]);
  const r1 = await call('oq-arch');
  assert.equal(r1.status, 409);
  assert.deepEqual(await r1.json(), { error: expected });
  const r404 = await call('oq-missing');
  assert.equal(r404.status, 404, 'control: a missing task is still 404');
  db.closeDb();
});
