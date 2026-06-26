/**
 * ad-campaigns.test.ts — Skill 48 → board lib (createAdCampaign / moveAdStage).
 *
 * Runs against a THROWAWAY DB. The harness MUST set DATABASE_PATH to a scratch
 * file BEFORE this process imports @/lib/db (getDb() is a lazy singleton keyed
 * on DATABASE_PATH at first call). Never point this at mission-control.db.
 *
 *   DATABASE_PATH=/tmp/scratch-cc.db node --import tsx --test tests/unit/ad-campaigns.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne } from '../../src/lib/db';
import {
  createAdCampaign,
  moveAdStage,
  getAdCampaign,
  AdCampaignError,
  TransitionError,
} from '../../src/lib/ad-campaigns';

function newJobId(): string {
  return `test-fbad-${uuidv4()}`;
}

test('createAdCampaign creates 8 backlog cards and is idempotent on job_id', () => {
  const jobId = newJobId();

  const first = createAdCampaign({ job_id: jobId, show_name: 'Acme Demo Show' });
  assert.equal(first.created, true);
  assert.equal(first.campaign_id, jobId);
  assert.ok(first.parent_id, 'epic parent id present');
  assert.equal(first.stages.length, 7, '7 non-epic stage cards');

  const rows = queryAll<{ status: string }>('SELECT status FROM tasks WHERE campaign_id = ?', [jobId]);
  assert.equal(rows.length, 8, 'epic + 7 stages = 8 cards');
  assert.ok(rows.every((r) => r.status === 'backlog'), 'all cards start in backlog');

  // Idempotent re-create: no new rows, identical ids.
  const second = createAdCampaign({ job_id: jobId, show_name: 'Acme Demo Show' });
  assert.equal(second.created, false);
  assert.equal(second.parent_id, first.parent_id, 'same epic id');
  assert.deepEqual(
    second.stages.map((s) => s.id).sort(),
    first.stages.map((s) => s.id).sort(),
    'same stage card ids',
  );
  const after = queryAll('SELECT id FROM tasks WHERE campaign_id = ?', [jobId]);
  assert.equal(after.length, 8, 're-create did not duplicate cards');
});

test('moveAdStage backlog -> in_progress -> review stays at review (no QC auto-done)', async () => {
  const jobId = newJobId();
  createAdCampaign({ job_id: jobId, show_name: 'Review Pause Show' });

  await moveAdStage(jobId, { stage_slug: 's1-overlays', status: 'in_progress' });
  const mid = await moveAdStage(jobId, { stage_slug: 's1-overlays', status: 'review' });
  assert.equal(mid.status, 'review', 'human pause: card sits at review, not auto-advanced to done');

  // task_events audit rows were written by transition().
  const card = queryOne<{ id: string }>(
    'SELECT id FROM tasks WHERE campaign_id = ? AND stage_slug = ?',
    [jobId, 's1-overlays'],
  );
  const events = queryAll('SELECT id FROM task_events WHERE task_id = ?', [card!.id]);
  assert.ok(events.length >= 2, 'task_events recorded for each transition');
});

test('blocked path sets blocked columns; leaving blocked nulls them', async () => {
  const jobId = newJobId();
  createAdCampaign({ job_id: jobId, show_name: 'Blocked Show' });

  await moveAdStage(jobId, { stage_slug: 's7-deliver', status: 'in_progress' });
  const blocked = await moveAdStage(jobId, {
    stage_slug: 's7-deliver',
    status: 'blocked',
    blocked_reason: 'payment',
    blocked_on_human: 'operator',
    ask: 'Top up the ad account balance.',
  });
  assert.equal(blocked.status, 'blocked');
  const blockedRow = queryOne<{ blocked_reason: string | null; ask: string | null }>(
    'SELECT blocked_reason, ask FROM tasks WHERE campaign_id = ? AND stage_slug = ?',
    [jobId, 's7-deliver'],
  );
  assert.equal(blockedRow!.blocked_reason, 'payment');
  assert.ok(blockedRow!.ask && blockedRow!.ask.length > 0);

  // blocked -> in_progress is legal and clears the blocked columns.
  const resumed = await moveAdStage(jobId, { stage_slug: 's7-deliver', status: 'in_progress' });
  assert.equal(resumed.status, 'in_progress');
  const clearedRow = queryOne<{ blocked_reason: string | null; ask: string | null }>(
    'SELECT blocked_reason, ask FROM tasks WHERE campaign_id = ? AND stage_slug = ?',
    [jobId, 's7-deliver'],
  );
  assert.equal(clearedRow!.blocked_reason, null);
  assert.equal(clearedRow!.ask, null);
});

test('blocked without blocked_reason is rejected (400-class)', async () => {
  const jobId = newJobId();
  createAdCampaign({ job_id: jobId, show_name: 'Gate Show' });
  await moveAdStage(jobId, { stage_slug: 's2-bodies', status: 'in_progress' });
  await assert.rejects(
    () => moveAdStage(jobId, { stage_slug: 's2-bodies', status: 'blocked', ask: 'do thing' }),
    (err: unknown) => err instanceof AdCampaignError && err.status === 400,
  );
});

test('illegal epic backlog -> done throws ILLEGAL_TRANSITION', async () => {
  const jobId = newJobId();
  createAdCampaign({ job_id: jobId, show_name: 'Illegal Show' });
  await assert.rejects(
    () => moveAdStage(jobId, { stage_slug: 'epic', status: 'done' }),
    (err: unknown) => err instanceof TransitionError && err.code === 'ILLEGAL_TRANSITION',
  );
});

test('review -> done sets completed_at via DB trigger; epic done completes campaign', async () => {
  const jobId = newJobId();
  createAdCampaign({ job_id: jobId, show_name: 'Done Show' });

  await moveAdStage(jobId, { stage_slug: 's7-deliver', status: 'in_progress' });
  await moveAdStage(jobId, { stage_slug: 's7-deliver', status: 'review' });
  const done = await moveAdStage(jobId, { stage_slug: 's7-deliver', status: 'done' });
  assert.equal(done.status, 'done');
  const doneRow = queryOne<{ completed_at: string | null }>(
    'SELECT completed_at FROM tasks WHERE campaign_id = ? AND stage_slug = ?',
    [jobId, 's7-deliver'],
  );
  assert.ok(doneRow!.completed_at, 'trg_tasks_completed_at populated completed_at');

  // Drive the epic to done and confirm the campaign row flips to complete.
  await moveAdStage(jobId, { stage_slug: 'epic', status: 'in_progress' });
  await moveAdStage(jobId, { stage_slug: 'epic', status: 'review' });
  await moveAdStage(jobId, { stage_slug: 'epic', status: 'done' });
  const { campaign } = getAdCampaign(jobId);
  assert.equal((campaign as { status: string }).status, 'complete');
});

test('card not found returns 404-class AdCampaignError', async () => {
  const jobId = newJobId();
  createAdCampaign({ job_id: jobId, show_name: 'Missing Show' });
  await assert.rejects(
    () => moveAdStage(jobId, { stage_slug: 'does-not-exist', status: 'in_progress' }),
    (err: unknown) => err instanceof AdCampaignError && err.status === 404,
  );
});
