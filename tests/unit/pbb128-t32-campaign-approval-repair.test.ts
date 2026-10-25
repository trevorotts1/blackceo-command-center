/**
 * tests/unit/pbb128-t32-campaign-approval-repair.test.ts
 *
 * PBB-128 / T-32 repair round — the genuine defects the QC verdict named on
 * commit a2b348e1. Every test below FAILED against a2b348e1 and PASSES against
 * the repair; the proof run lines are at the bottom of this header.
 *
 * Nothing in tests/unit/pbb128-t32-campaign-approval.test.ts was edited. Every
 * previously proven clause keeps its original assertion, byte for byte — this
 * file is purely additive.
 *
 *   node --import tsx --import ./tests/setup/no-owner-telegram.ts \
 *        --import ./tests/setup/tmp-sandbox.ts \
 *        --test tests/unit/pbb128-t32-campaign-approval-repair.test.ts
 *
 * DEFECTS PINNED HERE
 *   D1  a campaign hold parked a card in `blocked` with a bare transition(),
 *       bypassing the stopCardPermanently() chokepoint, so the owner got no
 *       block_reason and no notice. Proven by the repo's own static guard.
 *   D2  calendarDate() accepted a YYYY-MM-DD-SHAPED string that is not a real
 *       calendar day ('2026-99-99', '2026-02-31', '2026-13-45junk'), so a
 *       fabricated day was rendered on the calendar and was approvable.
 *   D3  classifyPublication() treated ANY non-empty completed_at as a dated
 *       completion, so a garbage stamp earned CURRENT / provider_completion_receipt.
 *   D4  newestPublishRow() was input-order dependent and let an unparseable
 *       updated_at outrank a parseable one, so the projection was non-deterministic
 *       over the same data set.
 *   D5  approval_summary.state 'APPROVED' was unreachable dead code — a
 *       permanently false promise in the public type. It is gone; the roll-up
 *       is NONE | UNKNOWN | PARTIAL and PARTIAL names the unproven fields.
 *   D6  an undated placement with a genuinely stalled stream rendered
 *       freshness 'unknown' while its own reason said 'event_stream_stalled' —
 *       the state contradicted its reason and masked the STALE signal (C-F13).
 *   D7  CampaignApprovalBoard::cellOf() duplicated cellStateOf() with a
 *       different precedence, so the board and the contract disagreed on a
 *       published-but-stale row. The board now delegates.
 */
import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  approvalBlockers,
  buildCampaignApprovalView,
  calendarDate,
  cellStateOf,
  classifyPublication,
  decideCommand,
  newestPublishRow,
  placementFingerprint,
  type CampaignCommand,
  type CampaignSource,
  type CampaignTaskSource,
  type CommandReceipt,
  type PublishQueueSource,
} from '../../src/lib/campaigns/approval-contract';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '../..');

const COMPANY = 'pbb128-r-co';
const CAMPAIGN: CampaignSource = {
  id: 'camp-r',
  name: 'Repair campaign',
  company_id: COMPANY,
  start_date: '2026-10-01',
  target_date: '2026-10-30',
};
const NOW = '2026-10-24T12:00:00.000Z';
const SIX_HOURS = 6 * 60 * 60 * 1000;

function task(overrides: Partial<CampaignTaskSource> = {}): CampaignTaskSource {
  return {
    id: 'task-a',
    title: 'Post A',
    description: 'A',
    status: 'in_progress',
    due_date: '2026-10-05',
    updated_at: '2026-10-01T00:00:00.000Z',
    campaign_id: 'camp-r',
    ...overrides,
  };
}

function pub(overrides: Partial<PublishQueueSource> = {}): PublishQueueSource {
  return {
    id: 'pq-a',
    task_id: 'task-a',
    company_id: COMPANY,
    platforms: 'facebook',
    status: 'queued',
    updated_at: '2026-10-02T00:00:00.000Z',
    ...overrides,
  };
}

function event(taskId: string, at: string, to = 'in_progress') {
  return { id: `ev-${taskId}-${at}`, task_id: taskId, from_status: 'assigned', to_status: to, created_at: at };
}

function command(overrides: Partial<CampaignCommand> = {}): CampaignCommand {
  return {
    schema_version: 1,
    command_id: 'cmd-repair',
    tenant_id: COMPANY,
    actor_id: 'owner',
    action: 'approve_campaign',
    target_type: 'campaign',
    target_id: 'camp-r',
    expected_revision: 0,
    purpose: 'approve',
    submitted_at: NOW,
    ...overrides,
  };
}

function approvalFor(tasks: CampaignTaskSource[], pubs: PublishQueueSource[]): CommandReceipt {
  return {
    command_id: 'cmd-1',
    company_id: COMPANY,
    campaign_id: 'camp-r',
    action: 'approve_campaign',
    target_type: 'campaign',
    target_id: 'camp-r',
    expected_revision: 0,
    applied_revision: 1,
    state: 'applied',
    refusal_code: null,
    reason: 'owner approved',
    payload_json: JSON.stringify({
      scope: 'calendar_placement',
      approved_by: 'owner',
      approved_at: '2026-10-20T00:00:00.000Z',
      campaign_cycle_id: 'camp-r',
      placements: tasks.map((t) => ({
        placement_id: t.id,
        fingerprint: placementFingerprint(t, pubs.find((row) => row.task_id === t.id)?.platforms ?? null),
      })),
      unknown_fields: [],
    }),
    submitted_at: NOW,
    recorded_at: '2026-10-20T00:00:00.000Z',
  };
}

// ─── D1  the hold must notify, not stop silently ────────────────────────────

test('D1 repair: the repo-wide silent-terminal-stop guard passes (the hold routes through stopCardPermanently)', () => {
  // Run the guard through `node --import tsx`, not the `tsx` shim: the shim
  // spawns an IPC child whose unix socket must fit 104 bytes of TMPDIR, so a
  // long TMPDIR makes it fail before the guard reads a single file. Same
  // script, same measurement, no transport failure masquerading as a verdict.
  const guard = path.join(REPO_ROOT, 'scripts', 'guard-silent-terminal-stops.ts');
  const res = spawnSync(process.execPath, ['--import', 'tsx', guard, '--root', REPO_ROOT], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
  });
  assert.equal(res.status, 0, `guard must exit 0\n${res.stdout}\n${res.stderr}`);
});

test('D1 repair: the hold site calls the chokepoint, never a bare transition to blocked', () => {
  const source = readFileSync(path.join(REPO_ROOT, 'src/lib/campaigns/approval-store.ts'), 'utf8');
  assert.match(source, /stopCardPermanently\(/, 'approval-store must route the hold through stopCardPermanently');
  // Every `transition(<id>, 'blocked', …)` in this module must sit inside that
  // chokepoint call — a bare one is exactly the silent stop the guard rejects.
  // Comments are stripped first: the header explains the defect in prose.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const bare = [...code.matchAll(/transition\([^)]*'blocked'/g)].map((m) => m[0]);
  assert.deepEqual(bare, [], `no bare transition-to-blocked in approval-store, found: ${bare.join(' | ')}`);
});

// ─── D2  a calendar day must be a real calendar day ─────────────────────────

test('D2 repair: calendarDate() rejects impossible and junk-suffixed dates', () => {
  for (const junk of [
    '2026-99-99',
    '2026-02-31',
    '2026-13-45junk',
    '2026-00-10',
    '2026-10-00',
    '2026-10-32',
    '2026-02-29', // 2026 is not a leap year
    '2026-10-05junk',
    '2026-10-05junkT00:00:00.000Z',
  ]) {
    assert.equal(calendarDate(junk), null, `calendarDate(${JSON.stringify(junk)}) must be null`);
  }
  // The real ones still work — the inverse must not become a blanket refusal.
  assert.equal(calendarDate('2026-10-05'), '2026-10-05');
  assert.equal(calendarDate('  2026-10-05  '), '2026-10-05');
  assert.equal(calendarDate('2026-10-05T00:00:00.000Z'), '2026-10-05');
  assert.equal(calendarDate('2026-10-05 00:00:00'), '2026-10-05');
  assert.equal(calendarDate('2028-02-29'), '2028-02-29'); // leap year
  assert.equal(calendarDate('2000-02-29'), '2000-02-29'); // century leap year
  assert.equal(calendarDate(null), null);
  assert.equal(calendarDate(undefined), null);
  assert.equal(calendarDate(''), null);
});

test('D2 repair: a fabricated calendar day is UNKNOWN, not approvable, and never rendered', () => {
  const junk = task({ id: 'task-j', due_date: '2026-99-99' });
  const good = task({ id: 'task-g', due_date: '2026-10-05' });

  assert.deepEqual(approvalBlockers(junk, 'facebook'), ['scheduled_at']);
  assert.deepEqual(approvalBlockers(good, 'facebook'), []);

  const decision = decideCommand({
    command: command({ action: 'approve_campaign' }),
    companyId: COMPANY,
    campaign: CAMPAIGN,
    tasks: [junk],
    publishRows: [pub({ id: 'pq-j', task_id: 'task-j' })],
    receipts: [],
  });
  assert.equal(decision.ok, false);
  if (!decision.ok) {
    assert.equal(decision.code, 'manifest_incomplete');
    assert.match(decision.reason, /scheduled_at/);
  }

  const view = buildCampaignApprovalView({
    campaign: CAMPAIGN,
    tasks: [junk],
    publishRows: [pub({ id: 'pq-j', task_id: 'task-j' })],
    events: [event('task-j', '2026-10-24T06:00:00.000Z')],
    receipts: [approvalFor([junk], [pub({ id: 'pq-j', task_id: 'task-j' })])],
    now: NOW,
  });
  const placement = view.placements[0];
  assert.equal(placement.date, null);
  assert.deepEqual(view.calendar, [], 'a fabricated day must never become a calendar day');
  assert.equal(placement.approval_state, 'UNKNOWN');
  assert.equal(placement.approvable, false);
  assert.notEqual(placement.approval_state, 'APPROVED');
  assert.notEqual(cellStateOf(placement), 'scheduled');
});

// ─── D3  a completion receipt must carry a real timestamp ───────────────────

test('D3 repair: a completion whose timestamp does not parse is never CURRENT', () => {
  for (const completed_at of ['not-a-date', 'yesterday', '   x   ', '2026-13-45', '2026-02-31', '0', '->']) {
    for (const status of ['published', 'completed']) {
      const verdict = classifyPublication(pub({ status, completed_at }));
      assert.equal(verdict.state, 'UNKNOWN', `${status}@${JSON.stringify(completed_at)} must be UNKNOWN`);
      assert.notEqual(verdict.reason, 'provider_completion_receipt');
      assert.notEqual(verdict.state, 'CURRENT');
    }
  }
  // The inverse: a real dated completion is still CURRENT with its pointer.
  const real = classifyPublication(pub({ status: 'published', completed_at: '2026-10-07T09:00:00.000Z' }));
  assert.equal(real.state, 'CURRENT');
  assert.equal(real.reason, 'provider_completion_receipt');
  assert.equal(real.evidence, 'publish_queue:pq-a@2026-10-07T09:00:00.000Z');
});

// ─── D4  the projection must be order-independent ───────────────────────────

test('D4 repair: newestPublishRow is order-independent and never lets an unparseable stamp win', () => {
  const good: PublishQueueSource = {
    id: 'aaa-published',
    task_id: 'task-x',
    company_id: COMPANY,
    platforms: 'facebook',
    status: 'published',
    completed_at: '2026-10-20T00:00:00.000Z',
    updated_at: '2026-10-20T00:00:00.000Z',
  };
  const bad: PublishQueueSource = {
    id: 'zzz-failed',
    task_id: 'task-x',
    company_id: COMPANY,
    platforms: 'facebook',
    status: 'failed',
    updated_at: 'not-a-timestamp',
  };

  assert.equal(newestPublishRow([good, bad], 'task-x')?.id, 'aaa-published');
  assert.equal(newestPublishRow([bad, good], 'task-x')?.id, 'aaa-published');
  assert.equal(
    classifyPublication(newestPublishRow([good, bad], 'task-x')).state,
    classifyPublication(newestPublishRow([bad, good], 'task-x')).state,
    'same data set, same answer, whatever the input order',
  );

  // A genuinely newer real row still wins over an older one.
  const older: PublishQueueSource = { ...good, id: 'bbb-older', updated_at: '2026-10-19T00:00:00.000Z' };
  assert.equal(newestPublishRow([older, good], 'task-x')?.id, 'aaa-published');
  assert.equal(newestPublishRow([good, older], 'task-x')?.id, 'aaa-published');

  // Two unparseable rows still tie-break deterministically on id.
  const p = { ...bad, id: 'p-unparsed' };
  const q = { ...bad, id: 'q-unparsed' };
  assert.equal(newestPublishRow([p, q], 'task-x')?.id, 'q-unparsed');
  assert.equal(newestPublishRow([q, p], 'task-x')?.id, 'q-unparsed');
});

// ─── D5  no unreachable promise in the roll-up type ─────────────────────────

test('D5 repair: approval_summary advertises no dead APPROVED state', () => {
  const source = readFileSync(path.join(REPO_ROOT, 'src/lib/campaigns/approval-contract.ts'), 'utf8');
  assert.equal(
    /approval_summary:\s*\{\s*state:/.test(source),
    true,
    'the roll-up type is still declared',
  );
  assert.equal(
    /state:\s*'APPROVED'\s*\|\s*'PARTIAL'/.test(source),
    false,
    "the roll-up union must not promise an 'APPROVED' state nothing can reach",
  );
  assert.equal(/summaryState = 'APPROVED'/.test(source), false, 'the dead APPROVED branch is gone');

  // Behavioural pin: the fully-approved case is PARTIAL and NAMES the unproven
  // manifest fields, so the truth is reported rather than dropped.
  const a = task({ id: 'task-a' });
  const b = task({ id: 'task-b', due_date: '2026-10-06' });
  const pubs = [pub({ id: 'pq-a', task_id: 'task-a' }), pub({ id: 'pq-b', task_id: 'task-b' })];
  const view = buildCampaignApprovalView({
    campaign: CAMPAIGN,
    tasks: [a, b],
    publishRows: pubs,
    events: [event('task-a', '2026-10-24T06:00:00.000Z'), event('task-b', '2026-10-24T06:00:00.000Z')],
    receipts: [approvalFor([a, b], pubs)],
    now: NOW,
  });
  assert.deepEqual(view.placements.map((p) => p.approval_state), ['APPROVED', 'APPROVED']);
  assert.equal(view.approval_summary.state, 'PARTIAL');
  assert.match(view.approval_summary.reason, /manifest_fields_unproven/);
});

// ─── D6  a state must never contradict its own reason (C-F13) ───────────────

test('D6 repair: an undated placement with a stalled stream renders STALE, not a masked unknown', () => {
  const undated = task({ id: 'task-u', due_date: null });
  const row = pub({ id: 'pq-u', task_id: 'task-u' });
  const view = buildCampaignApprovalView({
    campaign: CAMPAIGN,
    tasks: [undated],
    publishRows: [row],
    events: [event('task-u', '2026-10-20T00:00:00.000Z')],
    receipts: [],
    now: NOW,
    staleAfterMs: SIX_HOURS,
  });
  const placement = view.placements[0];
  assert.equal(placement.date, null, 'the placement really is undated');
  assert.equal(placement.freshness, 'stale');
  assert.equal(placement.freshness_reason, 'event_stream_stalled');
  assert.equal(cellStateOf(placement), 'stale', 'the STALE signal must not be masked');
  assert.deepEqual(placement.approval_blockers, ['scheduled_at']);
});

test('D6 repair: freshness and freshness_reason always agree, across every shape', () => {
  const shapes: Array<{ name: string; due_date: string | null; status: string; at: string | null; to: string }> = [
    { name: 'dated + stalled', due_date: '2026-10-05', status: 'in_progress', at: '2026-10-20T00:00:00.000Z', to: 'in_progress' },
    { name: 'undated + stalled', due_date: null, status: 'in_progress', at: '2026-10-20T00:00:00.000Z', to: 'in_progress' },
    { name: 'dated + live', due_date: '2026-10-05', status: 'in_progress', at: '2026-10-24T11:00:00.000Z', to: 'in_progress' },
    { name: 'undated + live', due_date: null, status: 'in_progress', at: '2026-10-24T11:00:00.000Z', to: 'in_progress' },
    { name: 'dated + no event', due_date: '2026-10-05', status: 'in_progress', at: null, to: 'in_progress' },
    { name: 'undated + no event', due_date: null, status: 'in_progress', at: null, to: 'in_progress' },
    { name: 'dated + terminal', due_date: '2026-10-05', status: 'done', at: '2026-09-01T00:00:00.000Z', to: 'done' },
  ];
  for (const shape of shapes) {
    const t = task({ id: 'task-s', due_date: shape.due_date, status: shape.status });
    const view = buildCampaignApprovalView({
      campaign: CAMPAIGN,
      tasks: [t],
      publishRows: [pub({ id: 'pq-s', task_id: 'task-s' })],
      events: shape.at ? [event('task-s', shape.at, shape.to)] : [],
      receipts: [],
      now: NOW,
      staleAfterMs: SIX_HOURS,
    });
    const placement = view.placements[0];
    if (placement.freshness === 'stale') {
      assert.equal(placement.freshness_reason, 'event_stream_stalled', shape.name);
    } else {
      assert.notEqual(placement.freshness_reason, 'event_stream_stalled', `${shape.name}: state and reason disagree`);
    }
    if (placement.freshness === 'unknown') {
      assert.ok(placement.freshness_reason, `${shape.name}: an unknown must say why`);
    }
  }
});

// ─── D7  one renderer, one precedence ───────────────────────────────────────

test('D7 repair: the board renders the cell from the contract, not a second opinion', () => {
  const board = readFileSync(
    path.join(REPO_ROOT, 'src/components/campaign-approval/CampaignApprovalBoard.tsx'),
    'utf8',
  );
  assert.match(board, /cellStateOf\(/, 'the board must render cells via cellStateOf');
  assert.equal(/function cellOf\(/.test(board), false, 'the duplicated cellOf() with its own precedence is gone');

  // The divergence it caused: a dated provider completion whose stream then
  // stalled. The contract says a real completion receipt wins.
  const publishedButStalled = {
    placement_id: 'task-a',
    task_id: 'task-a',
    title: 'Post A',
    task_status: 'in_progress',
    scheduled_at: '2026-10-05',
    date: '2026-10-05',
    fingerprint: 'f',
    approval_state: 'APPROVED' as const,
    approval_reason: 'approved_by:cmd-1',
    publication_state: 'CURRENT' as const,
    publication_reason: 'provider_completion_receipt',
    publication_evidence: 'publish_queue:pq-a@2026-10-07T09:00:00.000Z',
    freshness: 'stale' as const,
    freshness_reason: 'event_stream_stalled',
    last_event_at: '2026-10-20T00:00:00.000Z',
    last_event_id: 'ev',
    unknown_fields: [],
    approval_blockers: [],
    approvable: true,
  };
  assert.equal(cellStateOf(publishedButStalled), 'published');
});
