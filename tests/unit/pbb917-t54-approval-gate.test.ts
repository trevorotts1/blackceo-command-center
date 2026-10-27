/**
 * tests/unit/pbb917-t54-approval-gate.test.ts
 *
 * PBB-917 / T-54 — review finding C3 ("owner approval does not control
 * publication"), Command Center half.
 *
 * Pinned here, one test per clause of the C3 Exactly-how:
 *   1  a campaign placement is enqueued as `awaiting_approval` and its
 *      campaign_id / placement_id are recorded;
 *   2  the dispatcher claim query never claims `awaiting_approval`;
 *   3  approving the campaign flips the approved placement to `queued` inside
 *      the receipt transaction;
 *   4  defense in depth — an unapproved campaign row that still reaches the
 *      dispatcher fails with `unapproved_placement:<id>@rev<n>` and creates no
 *      task;
 *   5  INVALIDATED rollback — a changed placement goes back to
 *      `awaiting_approval` before the next sweep;
 *   6  the owner-facing vocabulary is "Waiting for your approval".
 *
 * Throwaway DB only: `_isolated-db` (first import) points DATABASE_PATH at a
 * temp file. No live database, no provider, no dispatcher network.
 */
import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';

import { getDb, queryOne, run, closeDb } from '../../src/lib/db';
import {
  AWAITING_APPROVAL,
  AWAITING_APPROVAL_LABEL,
  ensurePublishQueueApprovalColumns,
  placementGateFromSnapshot,
  taskCampaignContext,
} from '../../src/lib/social/publish-approval';
import {
  applyCampaignCommand,
  ensureCampaignCommandTables,
  loadCampaignApprovalSnapshot,
} from '../../src/lib/campaigns/approval-store';
import {
  deriveQueueItemState,
  requeueInvalidatedCampaignRows,
  runSocialPublishDispatcherSweep,
  AWAITING_APPROVAL_STATE_LABEL,
} from '../../src/lib/jobs/social-publish-dispatcher';
import { buildPublishMessage } from '../../src/lib/social/summary';

getDb();
test.after(() => closeDb());

const COMPANY = 'pbb917-co';
const CAMPAIGN = 'pbb917-camp';
const PLACEMENT = 'pbb917-task';
const UNPLACED = 'pbb917-task-2';
const NOW = new Date().toISOString();

function seed(): void {
  ensureCampaignCommandTables();
  ensurePublishQueueApprovalColumns();
  run('INSERT OR IGNORE INTO companies (id,name,slug) VALUES (?,?,?)', [COMPANY, COMPANY, COMPANY]);
  run(`INSERT OR IGNORE INTO workspaces (id,name,slug,company_id) VALUES (?,?,?,?)`, [
    'pbb917-ws', 'PBB917', 'pbb917-ws', COMPANY,
  ]);
  run(`INSERT OR IGNORE INTO campaigns (id,name,company_id,workspace_id,start_date,target_date)
       VALUES (?,?,?,?,?,?)`, [CAMPAIGN, 'C3 campaign', COMPANY, 'pbb917-ws', '2026-10-01', '2026-10-30']);
  run(`INSERT OR REPLACE INTO tasks (id,title,description,status,due_date,workspace_id,campaign_id,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`, [
    PLACEMENT, 'Post A', 'copy A', 'in_progress', '2026-10-05', 'pbb917-ws', CAMPAIGN, NOW, NOW,
  ]);
}

function enqueue(
  id: string,
  status: string,
  opts: { campaign?: string | null; retryAt?: string | null; placement?: string } = {},
): void {
  const placement = opts.placement ?? PLACEMENT;
  run(`INSERT INTO publish_queue
        (id, task_id, company_id, topic, platforms, status, campaign_id, placement_id,
         attempt_count, retry_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
    id, placement, COMPANY, 'Post A', '["facebook"]', status,
    opts.campaign === undefined ? CAMPAIGN : opts.campaign, placement,
    0, opts.retryAt ?? null, NOW, NOW,
  ]);
}

function approve(revision = 0) {
  return applyCampaignCommand(
    {
      schema_version: 1,
      command_id: `cmd-${revision}-approve`,
      tenant_id: COMPANY,
      actor_id: 'owner',
      action: 'approve_campaign',
      target_type: 'campaign',
      target_id: CAMPAIGN,
      expected_revision: revision,
      purpose: 'approve the October campaign',
      submitted_at: NOW,
    },
    COMPANY,
  );
}

test('1-2: a campaign placement is enqueued awaiting_approval and is never claimed', async () => {
  seed();
  const context = taskCampaignContext(PLACEMENT);
  assert.deepEqual(context, { campaignId: CAMPAIGN, placementId: PLACEMENT });
  assert.deepEqual(taskCampaignContext(null), { campaignId: null, placementId: null });

  enqueue('pq-awaiting', AWAITING_APPROVAL);
  assert.equal(deriveQueueItemState({ status: AWAITING_APPROVAL, created_at: NOW }), AWAITING_APPROVAL);

  await runSocialPublishDispatcherSweep();
  const row = queryOne<{ status: string; cc_task_id: string | null; attempt_count: number | null }>(
    `SELECT status, cc_task_id, attempt_count FROM publish_queue WHERE id='pq-awaiting'`,
  )!;
  assert.equal(row.status, AWAITING_APPROVAL, 'claim query must not select awaiting_approval');
  assert.equal(row.cc_task_id, null, 'no canonical task may be created before approval');
  assert.equal(row.attempt_count, 0);
});

test('3: approving the campaign releases the approved placement to queued in the same transaction', async () => {
  enqueue('pq-release', AWAITING_APPROVAL);
  const result = await approve(0);
  assert.equal(result.ok, true, result.ok ? '' : result.reason);
  const row = queryOne<{ status: string }>(`SELECT status FROM publish_queue WHERE id='pq-release'`)!;
  assert.equal(row.status, 'queued');
  const receipt = queryOne<{ state: string; applied_revision: number }>(
    `SELECT state, applied_revision FROM campaign_command_receipts WHERE command_id='cmd-0-approve'`,
  )!;
  assert.equal(receipt.state, 'applied');
  assert.equal(receipt.applied_revision, 1);
  const gate = placementGateFromSnapshot(loadCampaignApprovalSnapshot(CAMPAIGN, COMPANY), PLACEMENT);
  assert.equal(gate.approved, true, gate.reason);
});

test('4: defense in depth — an unapproved row that reaches dispatch fails with the named token', async () => {
  seed();
  // Created AFTER the approval, so it is not in the approved manifest.
  run(`INSERT OR REPLACE INTO tasks (id,title,description,status,due_date,workspace_id,campaign_id,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`, [
    UNPLACED, 'Never approved', 'copy B', 'in_progress', '2026-10-06', 'pbb917-ws', CAMPAIGN, NOW, NOW,
  ]);
  enqueue('pq-unapproved', 'retrying', {
    campaign: CAMPAIGN, retryAt: '2026-01-01T00:00:00.000Z', placement: UNPLACED,
  });
  await runSocialPublishDispatcherSweep();
  const row = queryOne<{ status: string; error: string | null; cc_task_id: string | null }>(
    `SELECT status, error, cc_task_id FROM publish_queue WHERE id='pq-unapproved'`,
  )!;
  assert.equal(row.status, 'failed');
  assert.match(row.error ?? '', /^unapproved_placement:pbb917-task-2@rev\d+$/);
  assert.equal(row.cc_task_id, null, 'an unapproved placement must not create a task');
});

test('5: INVALIDATED rollback — a changed placement returns to awaiting_approval', async () => {
  enqueue('pq-invalidated', 'queued');
  run(`UPDATE tasks SET title='Post A edited after approval', updated_at=? WHERE id=?`, [
    new Date(Date.now() + 1000).toISOString(), PLACEMENT,
  ]);
  const parked = requeueInvalidatedCampaignRows();
  assert.ok(parked >= 1, `expected at least one parked row, got ${parked}`);
  const row = queryOne<{ status: string; error: string | null }>(
    `SELECT status, error FROM publish_queue WHERE id='pq-invalidated'`,
  )!;
  assert.equal(row.status, AWAITING_APPROVAL);
  assert.match(row.error ?? '', /approval_invalidated:INVALIDATED:placement_changed_since_approval/);
  const gate = placementGateFromSnapshot(loadCampaignApprovalSnapshot(CAMPAIGN, COMPANY), PLACEMENT);
  assert.equal(gate.approved, false);
  assert.equal(gate.state, 'INVALIDATED');
});

test('6: the owner-facing vocabulary is "Waiting for your approval"', () => {
  assert.equal(AWAITING_APPROVAL_LABEL, 'Waiting for your approval');
  assert.equal(AWAITING_APPROVAL_STATE_LABEL, 'Waiting for your approval');
  const message = buildPublishMessage(
    {
      id: 'pq-awaiting', company_id: COMPANY, task_id: PLACEMENT, topic: 'Post A',
      platforms: '["facebook"]', status: AWAITING_APPROVAL, error: null, retry_at: null,
      created_at: NOW, updated_at: NOW,
    },
    null,
  );
  assert.equal(message.stage, 'Waiting for your approval');
  assert.equal(message.owner, 'client');
});
