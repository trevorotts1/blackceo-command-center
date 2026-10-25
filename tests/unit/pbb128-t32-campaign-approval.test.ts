/**
 * tests/unit/pbb128-t32-campaign-approval.test.ts
 *
 * PBB-128 / T-32 — Command Center campaign, approval and publication views.
 *
 * ACCEPTANCE PINNED HERE (build.json T-32 / C-32 / C-F13):
 *   (a) REAL manifest/calendar/receipts — the calendar comes from real
 *       `tasks.due_date`, approval from real applied command receipts bound to
 *       a content fingerprint, and publication from real `publish_queue` rows.
 *       HTTP admission is never "published" (D-13); a completed task without
 *       provider readback is BEHIND.
 *   (b) TARGETED approval/hold — `approve_campaign` is revision-CAS'd and
 *       tenant-scoped, `hold_placement` is applied through the canonical
 *       lifecycle transition and hits exactly ONE placement. Changing one
 *       placement afterwards invalidates THAT placement only.
 *   (c) NO DIRECT-BYPASS SENDS — every other cc-command action is refused from
 *       this view, no dispatcher/sender is imported, and approving/holding
 *       writes no publish_queue row.
 *   (d) UNKNOWN/STALE NEVER SUCCESS — missing manifest, unproven manifest
 *       fields, missing schedule/channel, absent publication receipt, an
 *       admission-only publish row and a superseded/stalled command all render
 *       as UNKNOWN or STALE with a reason.
 *
 * Throwaway DB only: `_isolated-db` (first import) points DATABASE_PATH at a
 * temp file. No live database, no provider, no dispatcher.
 */
import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { getDb } from '../../src/lib/db';
import {
  approvalBlockers,
  buildCampaignApprovalView,
  calendarDate,
  cellStateOf,
  classifyPublication,
  contentRevision,
  currentRevision,
  decideCommand,
  latestApprovalReceipt,
  placementFingerprint,
  resolveCalendarStaleAfterMs,
  unprovenManifestFields,
  validateCommand,
  DEFAULT_CALENDAR_STALE_AFTER_MS,
  type CampaignCommand,
  type CampaignSource,
  type CampaignTaskSource,
  type CommandReceipt,
  type PublishQueueSource,
} from '../../src/lib/campaigns/approval-contract';
import {
  applyCampaignCommand,
  ensureCampaignCommandTables,
  loadCampaignApprovalSnapshot,
  loadReceipts,
  RECEIPT_TABLE,
} from '../../src/lib/campaigns/approval-store';

const COMPANY = 'pbb128-co';
const CAMPAIGN: CampaignSource = { id: 'camp-1', name: 'October campaign', company_id: COMPANY, start_date: '2026-10-01', target_date: '2026-10-30' };
const NOW = '2026-10-24T12:00:00.000Z';

const TASK_A: CampaignTaskSource = {
  id: 'task-a',
  title: 'Post A',
  description: 'A',
  status: 'in_progress',
  due_date: '2026-10-05',
  updated_at: '2026-10-01T00:00:00.000Z',
  campaign_id: 'camp-1',
};
const TASK_B: CampaignTaskSource = {
  id: 'task-b',
  title: 'Post B',
  description: 'B',
  status: 'in_progress',
  due_date: '2026-10-06',
  updated_at: '2026-10-01T00:00:00.000Z',
  campaign_id: 'camp-1',
};

const PUB_A: PublishQueueSource = {
  id: 'pq-a',
  task_id: 'task-a',
  company_id: COMPANY,
  platforms: 'facebook',
  status: 'queued',
  updated_at: '2026-10-02T00:00:00.000Z',
};
const PUB_B: PublishQueueSource = { ...PUB_A, id: 'pq-b', task_id: 'task-b' };

function event(taskId: string, at: string, to = 'in_progress') {
  return { id: `ev-${taskId}-${at}`, task_id: taskId, from_status: 'assigned', to_status: to, created_at: at };
}

function receipt(overrides: Partial<CommandReceipt> = {}): CommandReceipt {
  return {
    command_id: 'cmd-1',
    company_id: COMPANY,
    campaign_id: 'camp-1',
    action: 'approve_campaign',
    target_type: 'campaign',
    target_id: 'camp-1',
    expected_revision: 0,
    applied_revision: 1,
    state: 'applied',
    refusal_code: null,
    reason: 'owner approved',
    payload_json: null,
    submitted_at: NOW,
    recorded_at: '2026-10-20T00:00:00.000Z',
    ...overrides,
  };
}

function command(overrides: Partial<CampaignCommand> = {}): CampaignCommand {
  return {
    schema_version: 1,
    command_id: 'cmd-new',
    tenant_id: COMPANY,
    actor_id: 'owner',
    action: 'approve_campaign',
    target_type: 'campaign',
    target_id: 'camp-1',
    expected_revision: 0,
    purpose: 'approve',
    submitted_at: NOW,
    ...overrides,
  };
}

/** One applied approve receipt covering both placements at their fingerprints. */
function approvalFor(tasks: CampaignTaskSource[], pubs: PublishQueueSource[], extra: Partial<CommandReceipt> = {}): CommandReceipt {
  return receipt({
    payload_json: JSON.stringify({
      scope: 'calendar_placement',
      approved_by: 'owner',
      approved_at: '2026-10-20T00:00:00.000Z',
      campaign_cycle_id: 'camp-1',
      placements: tasks.map((task) => ({
        placement_id: task.id,
        fingerprint: placementFingerprint(task, pubs.find((row) => row.task_id === task.id)?.platforms ?? null),
      })),
      unknown_fields: [],
    }),
    ...extra,
  });
}

// ─── (a) publication receipts are real and fail-closed ──────────────────────

test('receipts: absent publish row is UNKNOWN, never published', () => {
  assert.deepEqual(classifyPublication(null), {
    state: 'UNKNOWN',
    reason: 'no_publication_receipt',
    evidence: null,
  });
});

test('receipts: an admitted/running publish request is NOT a completed reply (D-13)', () => {
  const verdict = classifyPublication({ ...PUB_A, status: 'running' });
  assert.equal(verdict.state, 'UNKNOWN');
  assert.equal(verdict.reason, 'admission_only_not_completion');
});

test('receipts: task done without provider readback is BEHIND, not CURRENT', () => {
  const verdict = classifyPublication({ ...PUB_A, status: 'verification_required' });
  assert.equal(verdict.state, 'BEHIND');
  assert.equal(verdict.reason, 'task_complete_without_provider_readback');
});

test('receipts: a completion status with no completed_at is UNKNOWN', () => {
  const verdict = classifyPublication({ ...PUB_A, status: 'completed', completed_at: null });
  assert.equal(verdict.state, 'UNKNOWN');
  assert.equal(verdict.reason, 'completion_status_without_completed_at');
});

test('receipts: only a dated completion receipt is CURRENT, with its evidence pointer', () => {
  const verdict = classifyPublication({ ...PUB_A, status: 'published', completed_at: '2026-10-07T09:00:00.000Z' });
  assert.equal(verdict.state, 'CURRENT');
  assert.equal(verdict.evidence, 'publish_queue:pq-a@2026-10-07T09:00:00.000Z');
});

test('receipts: an unrecognised status is UNKNOWN with the status named', () => {
  const verdict = classifyPublication({ ...PUB_A, status: 'weird' });
  assert.equal(verdict.state, 'UNKNOWN');
  assert.match(verdict.reason, /unrecognized_publish_status:weird/);
});

// ─── (b) command validation (cc-command contract) ───────────────────────────

test('command: every required field, the enums and the integer revision are enforced', () => {
  assert.equal(validateCommand(null).ok, false);
  assert.equal(validateCommand({ ...command(), command_id: '' }).ok, false);
  assert.equal(validateCommand({ ...command(), action: 'send_now' }).ok, false);
  assert.equal(validateCommand({ ...command(), target_type: 'provider' }).ok, false);
  assert.equal(validateCommand({ ...command(), expected_revision: 1.5 }).ok, false);
  assert.equal(validateCommand({ ...command(), expected_revision: -1 }).ok, false);
  assert.equal(validateCommand({ ...command(), extra_field: 'x' }).ok, false);
  assert.equal(validateCommand({ ...command(), schema_version: 2 }).ok, false);
  assert.equal(validateCommand(command()).ok, true);
});

// ─── (c) targeted decisions ─────────────────────────────────────────────────

test('decision: a send-shaped action is refused from this view (no direct bypass)', () => {
  for (const action of ['retry_failed_step', 'handoff', 'pause_surface', 'resume_surface', 'release_handoff'] as const) {
    const decision = decideCommand({
      command: command({ action, target_type: action === 'retry_failed_step' ? 'action' : 'tenant_surface' }),
      companyId: COMPANY,
      campaign: CAMPAIGN,
      tasks: [TASK_A],
      publishRows: [PUB_A],
      receipts: [],
    });
    assert.equal(decision.ok, false);
    if (!decision.ok) assert.equal(decision.code, 'action_not_available_in_view');
  }
});

test('decision: cross-tenant command is refused before anything else', () => {
  const decision = decideCommand({
    command: command({ tenant_id: 'other-co' }),
    companyId: COMPANY,
    campaign: CAMPAIGN,
    tasks: [TASK_A],
    publishRows: [PUB_A],
    receipts: [],
  });
  assert.equal(decision.ok, false);
  if (!decision.ok) assert.equal(decision.code, 'tenant_mismatch');
});

test('decision: stale expected_revision is a conflict carrying the current revision', () => {
  const decision = decideCommand({
    command: command({ expected_revision: 0 }),
    companyId: COMPANY,
    campaign: CAMPAIGN,
    tasks: [TASK_A],
    publishRows: [PUB_A],
    receipts: [receipt({ applied_revision: 1 }), receipt({ command_id: 'cmd-2', applied_revision: 2 })],
  });
  assert.equal(decision.ok, false);
  if (!decision.ok) {
    assert.equal(decision.code, 'revision_conflict');
    assert.equal(decision.current_revision, 2);
  }
});

test('decision: a placement with no real date is UNKNOWN — approval is refused and the field named', () => {
  const undated: CampaignTaskSource = { ...TASK_A, due_date: null };
  assert.deepEqual(approvalBlockers(undated, 'facebook'), ['scheduled_at']);
  const decision = decideCommand({
    command: command(),
    companyId: COMPANY,
    campaign: CAMPAIGN,
    tasks: [undated],
    publishRows: [PUB_A],
    receipts: [],
  });
  assert.equal(decision.ok, false);
  if (!decision.ok) {
    assert.equal(decision.code, 'manifest_incomplete');
    assert.match(decision.reason, /scheduled_at/);
  }
});

test('decision: a placement with no real channel is UNKNOWN — approval refused', () => {
  const decision = decideCommand({
    command: command(),
    companyId: COMPANY,
    campaign: CAMPAIGN,
    tasks: [TASK_A],
    publishRows: [],
    receipts: [],
  });
  assert.equal(decision.ok, false);
  if (!decision.ok) {
    assert.equal(decision.code, 'manifest_incomplete');
    assert.match(decision.reason, /channel/);
  }
});

test('decision: a complete manifest approves exactly the current fingerprints', () => {
  const decision = decideCommand({
    command: command(),
    companyId: COMPANY,
    campaign: CAMPAIGN,
    tasks: [TASK_A, TASK_B],
    publishRows: [PUB_A, PUB_B],
    receipts: [],
  });
  assert.equal(decision.ok, true);
  if (decision.ok && decision.effect.kind === 'approve') {
    assert.equal(decision.applied_revision, 1);
    assert.deepEqual(
      decision.effect.payload.placements.map((entry) => entry.placement_id),
      ['task-a', 'task-b'],
    );
    // Fields this box cannot prove are RECORDED, never claimed as approved.
    assert.ok(decision.effect.payload.unknown_fields.includes('account_id'));
    assert.ok(decision.effect.payload.unknown_fields.includes('cta_text'));
  } else {
    assert.fail('expected an approve effect');
  }
});

test('decision: hold only targets a placement in this campaign, never a terminal one', () => {
  const missing = decideCommand({
    command: command({ action: 'hold_placement', target_type: 'placement', target_id: 'nope' }),
    companyId: COMPANY,
    campaign: CAMPAIGN,
    tasks: [TASK_A],
    publishRows: [PUB_A],
    receipts: [],
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, 'target_not_found');

  const done = decideCommand({
    command: command({ action: 'hold_placement', target_type: 'placement', target_id: 'task-a' }),
    companyId: COMPANY,
    campaign: CAMPAIGN,
    tasks: [{ ...TASK_A, status: 'done' }],
    publishRows: [PUB_A],
    receipts: [],
  });
  assert.equal(done.ok, false);
  if (!done.ok) assert.equal(done.code, 'terminal_placement');
});

// ─── (d) view: real calendar, invalidation, hold, unknown, stale ────────────

test('view: no approval receipt is NONE/DRAFT, and the calendar is still real', () => {
  const view = buildCampaignApprovalView({
    campaign: CAMPAIGN,
    tasks: [TASK_A, TASK_B],
    publishRows: [PUB_A, PUB_B],
    events: [event('task-a', '2026-10-24T06:00:00.000Z'), event('task-b', '2026-10-24T06:00:00.000Z')],
    receipts: [],
    now: NOW,
  });
  assert.equal(view.revision, 0);
  assert.equal(view.approval_summary.state, 'NONE');
  assert.ok(view.unknowns.includes('no_applied_approval_receipt'));
  assert.deepEqual(
    view.placements.map((placement) => placement.approval_state),
    ['DRAFT', 'DRAFT'],
  );
  assert.deepEqual(
    view.calendar.map((day) => day.date),
    ['2026-10-05', '2026-10-06'],
  );
  assert.equal(view.placements[0].publication_state, 'BEHIND'); // queued ≠ published
  assert.equal(cellStateOf(view.placements[0]), 'unapproved');
});

test('view: a matching approval is APPROVED but the campaign stays PARTIAL while manifest fields are unproven', () => {
  const approved = approvalFor([TASK_A, TASK_B], [PUB_A, PUB_B]);
  const view = buildCampaignApprovalView({
    campaign: CAMPAIGN,
    tasks: [TASK_A, TASK_B],
    publishRows: [PUB_A, PUB_B],
    events: [event('task-a', '2026-10-24T06:00:00.000Z'), event('task-b', '2026-10-24T06:00:00.000Z')],
    receipts: [approved],
    now: NOW,
  });
  assert.deepEqual(
    view.placements.map((placement) => placement.approval_state),
    ['APPROVED', 'APPROVED'],
  );
  assert.equal(view.approval_summary.state, 'PARTIAL');
  assert.match(view.approval_summary.reason, /manifest_fields_unproven/);
  assert.ok(view.placements[0].unknown_fields.includes('account_id'));
  assert.equal(cellStateOf(view.placements[0]), 'scheduled');
});

test('view: changing ONE placement invalidates THAT placement only (targeted mutation)', () => {
  const approved = approvalFor([TASK_A, TASK_B], [PUB_A, PUB_B]);
  const changedB: CampaignTaskSource = { ...TASK_B, description: 'B edited after approval' };
  const view = buildCampaignApprovalView({
    campaign: CAMPAIGN,
    tasks: [TASK_A, changedB],
    publishRows: [PUB_A, PUB_B],
    events: [event('task-a', '2026-10-23T00:00:00.000Z'), event('task-b', '2026-10-23T00:00:00.000Z')],
    receipts: [approved],
    now: NOW,
  });
  const byId = new Map(view.placements.map((placement) => [placement.placement_id, placement]));
  assert.equal(byId.get('task-a')?.approval_state, 'APPROVED');
  assert.equal(byId.get('task-b')?.approval_state, 'INVALIDATED');
  assert.equal(byId.get('task-b')?.approval_reason, 'placement_changed_since_approval');
});

test('view: a targeted hold lands on one placement and leaves its sibling alone', () => {
  const approved = approvalFor([TASK_A, TASK_B], [PUB_A, PUB_B]);
  const hold = receipt({
    command_id: 'cmd-hold',
    action: 'hold_placement',
    target_type: 'placement',
    target_id: 'task-a',
    applied_revision: 2,
    recorded_at: '2026-10-21T00:00:00.000Z',
  });
  const view = buildCampaignApprovalView({
    campaign: CAMPAIGN,
    tasks: [TASK_A, TASK_B],
    publishRows: [PUB_A, PUB_B],
    events: [event('task-a', '2026-10-23T00:00:00.000Z'), event('task-b', '2026-10-23T00:00:00.000Z')],
    receipts: [approved, hold],
    now: NOW,
  });
  const byId = new Map(view.placements.map((placement) => [placement.placement_id, placement]));
  assert.equal(byId.get('task-a')?.approval_state, 'HELD');
  assert.equal(byId.get('task-b')?.approval_state, 'APPROVED');
});

test('view: no lifecycle event is UNKNOWN, a stalled stream is STALE, a finished card is exempt', () => {
  const view = buildCampaignApprovalView({
    campaign: CAMPAIGN,
    tasks: [TASK_A, { ...TASK_B, status: 'done' }],
    publishRows: [PUB_A, PUB_B],
    events: [event('task-b', '2026-09-01T00:00:00.000Z', 'done')],
    receipts: [],
    now: NOW,
  });
  const byId = new Map(view.placements.map((placement) => [placement.placement_id, placement]));
  assert.equal(byId.get('task-a')?.freshness, 'unknown');
  assert.equal(byId.get('task-a')?.freshness_reason, 'no_lifecycle_event');
  assert.equal(byId.get('task-b')?.freshness, 'live'); // done = terminal, exempt
});

test('view: a stalled in-flight event stream is STALE with its last event time', () => {
  const view = buildCampaignApprovalView({
    campaign: CAMPAIGN,
    tasks: [TASK_A],
    publishRows: [PUB_A],
    events: [event('task-a', '2026-10-20T00:00:00.000Z')],
    receipts: [],
    now: NOW,
    staleAfterMs: 6 * 60 * 60 * 1000,
  });
  assert.equal(view.placements[0].freshness, 'stale');
  assert.equal(view.placements[0].freshness_reason, 'event_stream_stalled');
  assert.equal(view.placements[0].last_event_at, '2026-10-20T00:00:00.000Z');
  assert.equal(cellStateOf(view.placements[0]), 'stale');
});

test('view: a superseded command receipt is STALE, never read as the current approval', () => {
  const approved = approvalFor([TASK_A], [PUB_A]);
  const latest = receipt({ command_id: 'cmd-2', applied_revision: 2, recorded_at: '2026-10-22T00:00:00.000Z' });
  const view = buildCampaignApprovalView({
    campaign: CAMPAIGN,
    tasks: [TASK_A],
    publishRows: [PUB_A],
    events: [event('task-a', '2026-10-23T00:00:00.000Z')],
    receipts: [approved, latest],
    now: NOW,
  });
  const stale = view.receipts.find((entry) => entry.command_id === 'cmd-1');
  assert.equal(stale?.freshness, 'stale');
  assert.equal(stale?.freshness_reason, 'superseded_revision');
  assert.equal(latestApprovalReceipt([approved, latest])?.applied_revision, 2);
});

test('view: env override for the stall window is validated, never zero/NaN', () => {
  assert.equal(resolveCalendarStaleAfterMs({} as NodeJS.ProcessEnv), DEFAULT_CALENDAR_STALE_AFTER_MS);
  assert.equal(resolveCalendarStaleAfterMs({ CAMPAIGN_STALE_AFTER_HOURS: 'nope' } as NodeJS.ProcessEnv), DEFAULT_CALENDAR_STALE_AFTER_MS);
  assert.equal(resolveCalendarStaleAfterMs({ CAMPAIGN_STALE_AFTER_HOURS: '0' } as NodeJS.ProcessEnv), DEFAULT_CALENDAR_STALE_AFTER_MS);
  assert.equal(resolveCalendarStaleAfterMs({ CAMPAIGN_STALE_AFTER_HOURS: '2' } as NodeJS.ProcessEnv), 2 * 60 * 60 * 1000);
});

// ─── store: real rows, revision CAS, real hold, no send ─────────────────────

function seedCampaign(): void {
  const db = getDb();
  ensureCampaignCommandTables();
  // Each store test starts from a clean campaign state (the throwaway DB is
  // shared by every test in this file).
  db.prepare(`DELETE FROM ${RECEIPT_TABLE} WHERE company_id = ? AND campaign_id = ?`).run(COMPANY, 'camp-1');
  db.prepare(`DELETE FROM task_events WHERE task_id IN ('task-a','task-b')`).run();
  db.prepare(`DELETE FROM publish_queue WHERE id IN ('pq-a','pq-b')`).run();
  db.prepare(
    `INSERT OR REPLACE INTO campaigns (id, name, description, status, department_ids, start_date, target_date, workspace_id, company_id, created_at, updated_at)
     VALUES (?, ?, '', 'planning', '[]', ?, ?, NULL, ?, datetime('now'), datetime('now'))`,
  ).run('camp-1', 'October campaign', '2026-10-01', '2026-10-30', COMPANY);
  for (const task of [TASK_A, TASK_B]) {
    db.prepare(
      `INSERT OR REPLACE INTO tasks (id, title, description, status, due_date, campaign_id, workspace_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'camp-1', NULL, ?, ?)`,
    ).run(task.id, task.title, task.description, 'in_progress', task.due_date, task.updated_at, task.updated_at);
    db.prepare(
      `INSERT INTO task_events (id, task_id, from_status, to_status, created_at)
       VALUES (?, ?, 'assigned', 'in_progress', ?)`,
    ).run(`ev-${task.id}`, task.id, '2026-10-23T00:00:00.000Z');
  }
  for (const row of [PUB_A, PUB_B]) {
    db.prepare(
      `INSERT INTO publish_queue (id, task_id, company_id, topic, platforms, status, created_at, updated_at)
       VALUES (?, ?, ?, 'topic', ?, 'queued', datetime('now'), ?)`,
    ).run(row.id, row.task_id, COMPANY, row.platforms, row.updated_at);
  }
}

test('store: a first approve applies at revision 1, persists its receipt, and writes NO publish row', () => {
  seedCampaign();
  const db = getDb();
  const publishBefore = (db.prepare('SELECT COUNT(*) AS n FROM publish_queue').get() as { n: number }).n;

  const result = applyCampaignCommand(command({ command_id: 'store-approve-1' }), COMPANY);
  return result.then((applied) => {
    assert.equal(applied.ok, true);
    assert.equal(applied.receipt?.state, 'applied');
    assert.equal(applied.receipt?.applied_revision, 1);

    const snapshot = loadCampaignApprovalSnapshot('camp-1', COMPANY, { now: NOW });
    assert.ok(snapshot);
    assert.equal(snapshot.view.revision, 1);
    assert.equal(snapshot.view.placements.find((p) => p.placement_id === 'task-a')?.approval_state, 'APPROVED');

    const receipts = loadReceipts(COMPANY, 'camp-1');
    assert.equal(receipts.length, 1);
    assert.equal(currentRevision(receipts), 1);

    const publishAfter = (db.prepare('SELECT COUNT(*) AS n FROM publish_queue').get() as { n: number }).n;
    assert.equal(publishAfter, publishBefore, 'approval must never enqueue a send');

    // Replaying the SAME command_id does not create a second receipt.
    return applyCampaignCommand(command({ command_id: 'store-approve-1' }), COMPANY).then(() => {
      assert.equal(loadReceipts(COMPANY, 'camp-1').length, 1);
    });
  });
});

test('store: a stale expected_revision is a durable refusal and applies nothing', () => {
  seedCampaign();
  return applyCampaignCommand(command({ command_id: 'store-approve-2', expected_revision: 0 }), COMPANY).then((first) => {
    assert.equal(first.ok, true);
    return applyCampaignCommand(command({ command_id: 'store-approve-3', expected_revision: 0 }), COMPANY);
  }).then((second) => {
    assert.equal(second.ok, false);
    assert.equal(second.code, 'revision_conflict');
    assert.equal(second.status, 409);
    assert.equal(second.receipt?.state, 'refused');
    assert.equal(second.receipt?.refusal_code, 'revision_conflict');
    assert.equal(currentRevision(loadReceipts(COMPANY, 'camp-1')), 1);
  });
});

test('store: a foreign-tenant command is refused, audited under the verified company, and changes no state', () => {
  seedCampaign();
  return applyCampaignCommand(command({ command_id: 'store-foreign', tenant_id: 'other-co' }), COMPANY).then((result) => {
    assert.equal(result.ok, false);
    assert.equal(result.code, 'tenant_mismatch');
    // The refusal is recorded where the campaign OWNER can see it — never
    // under the tenant the command claimed.
    const receipts = loadReceipts(COMPANY, 'camp-1');
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].state, 'refused');
    assert.equal(receipts[0].refusal_code, 'tenant_mismatch');
    assert.equal(receipts[0].company_id, COMPANY);
    assert.equal(currentRevision(receipts), 0);
    const db = getDb();
    const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get('task-a') as { status: string };
    assert.equal(task.status, 'in_progress');
  });
});

test('store: a targeted hold moves exactly one placement to blocked and records a receipt', () => {
  seedCampaign();
  return applyCampaignCommand(command({ command_id: 'store-approve-4' }), COMPANY).then(() => {
    return applyCampaignCommand(
      command({
        command_id: 'store-hold',
        action: 'hold_placement',
        target_type: 'placement',
        target_id: 'task-a',
        expected_revision: 1,
        purpose: 'hold placement A',
      }),
      COMPANY,
    );
  }).then((held) => {
    assert.equal(held.ok, true);
    const db = getDb();
    const rows = db.prepare('SELECT id, status FROM tasks WHERE campaign_id = ? ORDER BY id').all('camp-1') as {
      id: string;
      status: string;
    }[];
    assert.deepEqual(rows, [
      { id: 'task-a', status: 'blocked' },
      { id: 'task-b', status: 'in_progress' },
    ]);
    const snapshot = loadCampaignApprovalSnapshot('camp-1', COMPANY, { now: NOW });
    assert.ok(snapshot);
    const byId = new Map(snapshot.view.placements.map((placement) => [placement.placement_id, placement]));
    assert.equal(byId.get('task-a')?.approval_state, 'HELD');
    assert.equal(byId.get('task-b')?.approval_state, 'APPROVED');
    assert.equal(snapshot.view.revision, 2);
  });
});

test('store: the view is tenant-scoped — another company cannot read the campaign', () => {
  seedCampaign();
  assert.equal(loadCampaignApprovalSnapshot('camp-1', 'other-co'), null);
  assert.ok(loadCampaignApprovalSnapshot('camp-1', COMPANY));
});

// ─── (c) structural proof: no send path exists in this unit ─────────────────

test('no-bypass: neither module imports a dispatcher/sender or writes publish_queue', () => {
  const files = [
    path.join(process.cwd(), 'src/lib/campaigns/approval-contract.ts'),
    path.join(process.cwd(), 'src/lib/campaigns/approval-store.ts'),
    path.join(process.cwd(), 'src/app/campaigns/[id]/approval/actions.ts'),
  ];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const forbidden of [
      'social-publish-dispatcher',
      'task-dispatcher',
      'autoDispatchTask',
      'runSocialPublishDispatcherSweep',
      '/api/skill-35/publish',
    ]) {
      assert.equal(source.includes(forbidden), false, `${path.basename(file)} must not reference ${forbidden}`);
    }
    assert.equal(/INSERT\s+(OR\s+\w+\s+)?INTO\s+publish_queue/i.test(source), false, `${path.basename(file)} must not enqueue sends`);
    assert.equal(/UPDATE\s+publish_queue/i.test(source), false, `${path.basename(file)} must not mutate the publish queue`);
  }
  // The only table this unit creates for itself:
  assert.equal(RECEIPT_TABLE, 'campaign_command_receipts');
});
