/**
 * tests/unit/pbb285-t32-dead-state-class.test.ts
 *
 * PBB-285 / T-32 repair round — the dead-state class the qc5-t-32 verdict
 * named as N1 and N2 ("same class as repaired D5 — dead member in the public
 * type"). This file is purely additive: no existing assertion was edited,
 * weakened, skipped or removed.
 *
 *   node --import tsx --import ./tests/setup/no-owner-telegram.ts \
 *        --import ./tests/setup/tmp-sandbox.ts \
 *        --test tests/unit/pbb285-t32-dead-state-class.test.ts
 *
 * PROOF RUN LINES
 *   base 767d33101dcd3db2ab1c52d2aac25a4ba51393a3: N1 and N2 FAIL
 *     (N1: PlacementApprovalState declares 'REVOKED', nothing produces it;
 *      N2: PublicationState declares 'UNREACHABLE', classifyPublication never
 *          emits it, and the board ships a style row for that impossible state)
 *   head (this branch): all tests PASS.
 *
 * THE CLASS, NOT THE INSTANCE
 * Every closed state vocabulary in the T-32 contract is checked the same way:
 * the union declared in the public type must EXACTLY equal the set of values
 * the code can actually produce (crafted producers + a fixed-seed fuzz that
 * hunts for anything undeclared). A member with no producer is a permanently
 * false promise in a public type; a produced value outside the union is an
 * undeclared state. Both directions are asserted, so a later dead member fails
 * here too.
 */
import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildCampaignApprovalView,
  cellStateOf,
  classifyPublication,
  placementFingerprint,
  type CampaignApprovalInput,
  type CampaignSource,
  type CampaignTaskSource,
  type CommandReceipt,
  type PlacementView,
  type PublishQueueSource,
} from '../../src/lib/campaigns/approval-contract';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '../..');
const CONTRACT_PATH = path.join(REPO_ROOT, 'src/lib/campaigns/approval-contract.ts');
const BOARD_PATH = path.join(REPO_ROOT, 'src/components/campaign-approval/CampaignApprovalBoard.tsx');

const COMPANY = 'pbb285-co';
const CAMPAIGN: CampaignSource = {
  id: 'camp-285',
  name: 'Dead state campaign',
  company_id: COMPANY,
  start_date: '2026-10-01',
  target_date: '2026-10-30',
};
const NOW = '2026-10-24T12:00:00.000Z';

// ─── Declared vocabulary, read from the public type itself ─────────────────

const CONTRACT_SOURCE = readFileSync(CONTRACT_PATH, 'utf8');
const BOARD_SOURCE = readFileSync(BOARD_PATH, 'utf8');

function blockOf(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  assert.notEqual(start, -1, `declaration not found: ${declaration}`);
  const rest = source.slice(start + declaration.length);
  const end = rest.search(/\n\}/);
  assert.notEqual(end, -1, `block never closes: ${declaration}`);
  return rest.slice(0, end);
}

function quoted(block: string): string[] {
  return [...block.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

/** `export type X = 'A' | 'B' | …;` → ['A','B',…] in declaration order. */
function unionMembers(typeName: string): string[] {
  const pattern = new RegExp(`export type ${typeName}\\s*=`);
  const start = CONTRACT_SOURCE.search(pattern);
  assert.notEqual(start, -1, `type ${typeName} not found in approval-contract.ts`);
  const rest = CONTRACT_SOURCE.slice(start);
  const end = rest.indexOf(';');
  assert.notEqual(end, -1, `type ${typeName} has no terminator`);
  return quoted(rest.slice(0, end));
}

/** `export interface I { … field: 'A' | 'B'; … }` → the field's union. */
function fieldUnion(interfaceName: string, field: string): string[] {
  const block = blockOf(CONTRACT_SOURCE, `export interface ${interfaceName} {`);
  const match = block.match(new RegExp(`\\b${field}:\\s*([^;]+);`));
  assert.ok(match, `field ${field} not found in ${interfaceName}`);
  return quoted(match[1]);
}

/** The board's style-row keys for a vocabulary, e.g. PUBLICATION_STYLE. */
function styleKeys(constName: string): string[] {
  const match = BOARD_SOURCE.match(new RegExp(`const ${constName}[^=]*=\\s*\\{([\\s\\S]*?)\\n\\};`));
  assert.ok(match, `${constName} not found in the board`);
  return [...match[1].matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((m) => m[1]);
}

// ─── Factories ─────────────────────────────────────────────────────────────

function task(overrides: Partial<CampaignTaskSource> = {}): CampaignTaskSource {
  return {
    id: 'task-a',
    title: 'Post A',
    description: 'A',
    status: 'in_progress',
    due_date: '2026-10-05',
    updated_at: '2026-10-01T00:00:00.000Z',
    campaign_id: 'camp-285',
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

function receipt(overrides: Partial<CommandReceipt> = {}): CommandReceipt {
  return {
    command_id: 'cmd-285',
    company_id: COMPANY,
    campaign_id: 'camp-285',
    action: 'approve_campaign',
    target_type: 'campaign',
    target_id: 'camp-285',
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

function approveReceipt(
  placements: { placement_id: string; fingerprint: string }[],
  overrides: Partial<CommandReceipt> = {},
): CommandReceipt {
  return receipt({
    payload_json: JSON.stringify({
      scope: 'calendar_placement',
      approved_by: 'owner',
      approved_at: '2026-10-20T00:00:00.000Z',
      campaign_cycle_id: 'camp-285',
      placements,
      unknown_fields: [],
    }),
    ...overrides,
  });
}

function view(input: Partial<CampaignApprovalInput> = {}) {
  return buildCampaignApprovalView({
    campaign: CAMPAIGN,
    tasks: [],
    publishRows: [],
    events: [],
    receipts: [],
    now: NOW,
    ...input,
  });
}

function placementOf(overrides: Partial<PlacementView> = {}): PlacementView {
  return {
    placement_id: 'task-a',
    task_id: 'task-a',
    title: 'Post A',
    task_status: 'in_progress',
    scheduled_at: '2026-10-05',
    date: '2026-10-05',
    fingerprint: 'f',
    approval_state: 'DRAFT',
    approval_reason: 'no_approval_receipt',
    publication_state: 'UNKNOWN',
    publication_reason: 'no_publication_receipt',
    publication_evidence: null,
    freshness: 'live',
    freshness_reason: null,
    last_event_at: '2026-10-24T11:00:00.000Z',
    last_event_id: 'ev-1',
    unknown_fields: [],
    approval_blockers: [],
    approvable: true,
    ...overrides,
  };
}

function event(taskId: string, at: string, to = 'in_progress') {
  return { id: `ev-${taskId}-${at}`, task_id: taskId, from_status: 'assigned', to_status: to, created_at: at };
}

/** Fixed-seed PRNG — the fuzz is deterministic, so a failure always reproduces. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, values: readonly T[]): T {
  return values[Math.floor(rand() * values.length) % values.length];
}

// ─── Producers: one crafted input per state the code CAN reach ─────────────

const APPROVAL_PRODUCERS: Record<string, (tasks: CampaignTaskSource[], pubs: PublishQueueSource[]) => CommandReceipt[]> = {
  HELD: () => [
    receipt({
      command_id: 'cmd-hold',
      action: 'hold_placement',
      target_type: 'placement',
      target_id: 'task-a',
      applied_revision: 1,
      payload_json: null,
    }),
  ],
  UNKNOWN: () => [],
  DRAFT: () => [],
  INVALIDATED: (_tasks, _pubs) => [approveReceipt([{ placement_id: 'task-a', fingerprint: 'not-the-current-fingerprint' }])],
  APPROVED: (tasks, pubs) => [
    approveReceipt(
      tasks.map((t) => ({
        placement_id: t.id,
        fingerprint: placementFingerprint(t, pubs.find((row) => row.task_id === t.id)?.platforms ?? null),
      })),
    ),
  ],
};

function approvalProducible(): Set<string> {
  const produced = new Set<string>();
  // HELD / INVALIDATED / APPROVED share the approvable shape (real date + channel).
  for (const state of ['HELD', 'INVALIDATED', 'APPROVED'] as const) {
    const tasks = [task()];
    const pubs = [pub()];
    produced.add(view({ tasks, publishRows: pubs, receipts: APPROVAL_PRODUCERS[state](tasks, pubs) }).placements[0].approval_state);
  }
  // DRAFT: approvable placement, no approval receipt at all.
  produced.add(view({ tasks: [task()], publishRows: [pub()], receipts: [] }).placements[0].approval_state);
  // UNKNOWN: a placement whose calendar identity cannot be proven (no date).
  produced.add(
    view({
      tasks: [task({ id: 'task-b', due_date: null })],
      publishRows: [pub({ id: 'pq-b', task_id: 'task-b' })],
      receipts: [],
    }).placements[0].approval_state,
  );
  return produced;
}

const PUBLICATION_PRODUCERS: PublishQueueSource[] = [
  pub({ id: 'p1', status: 'published', completed_at: '2026-10-05T10:00:00.000Z' }),
  pub({ id: 'p2', status: 'completed', completed_at: '2026-10-05T10:00:00.000Z' }),
  pub({ id: 'p3', status: 'verification_required' }),
  pub({ id: 'p4', status: 'failed', error: 'nope' }),
  pub({ id: 'p5', status: 'queued' }),
  pub({ id: 'p6', status: 'retrying' }),
  pub({ id: 'p7', status: 'overdue' }),
  pub({ id: 'p8', status: 'running' }),
  pub({ id: 'p9', status: 'published', completed_at: 'not-a-date' }),
  pub({ id: 'p10', status: '' }),
  pub({ id: 'p11', status: '???what???' }),
];

function publicationProducible(): Set<string> {
  const produced = new Set<string>();
  produced.add(classifyPublication(null).state);
  produced.add(classifyPublication(undefined).state);
  for (const row of PUBLICATION_PRODUCERS) produced.add(classifyPublication(row).state);
  return produced;
}

// ─── The fuzz: hunt for a value the public type does not declare ───────────

function fuzzProducible(): { approval: Set<string>; publication: Set<string>; freshness: Set<string>; summary: Set<string> } {
  const rand = mulberry32(0x5eed285);
  const statuses = ['in_progress', 'done', 'blocked', 'queued'] as const;
  const dueDates = ['2026-10-05', '2026-10-06', null, '2026-99-99', 'not-a-date'] as const;
  const pubStatuses = ['published', 'completed', 'failed', 'queued', 'running', 'verification_required', 'retrying', 'overdue', ''] as const;
  const stamps = ['2026-10-05T10:00:00.000Z', 'yesterday', '0', null, '2026-02-31'] as const;
  const approval = new Set<string>();
  const publication = new Set<string>();
  const freshness = new Set<string>();
  const summary = new Set<string>();

  for (let i = 0; i < 2000; i += 1) {
    const tasks: CampaignTaskSource[] = [];
    const pubs: PublishQueueSource[] = [];
    const taskCount = 1 + Math.floor(rand() * 3);
    for (let n = 0; n < taskCount; n += 1) {
      const id = `t${i}-${n}`;
      tasks.push(
        task({
          id,
          title: pick(rand, ['Post', 'Video', 'Email', '']),
          status: pick(rand, statuses),
          due_date: pick(rand, dueDates),
          updated_at: pick(rand, stamps),
        }),
      );
      if (rand() < 0.85) {
        pubs.push(
          pub({
            id: `pq${i}-${n}`,
            task_id: id,
            platforms: pick(rand, ['facebook', 'instagram', null, '  ']),
            status: pick(rand, pubStatuses),
            completed_at: pick(rand, stamps),
            updated_at: pick(rand, stamps),
          }),
        );
      }
    }

    const receipts: CommandReceipt[] = [];
    if (rand() < 0.4) {
      receipts.push(
        receipt({
          command_id: `cmd-h-${i}`,
          action: 'hold_placement',
          target_type: 'placement',
          target_id: pick(rand, tasks).id,
          applied_revision: 1,
          payload_json: null,
        }),
      );
    }
    if (rand() < 0.7) {
      const lock = rand() < 0.5
        ? tasks.map((t) => ({
            placement_id: t.id,
            fingerprint: placementFingerprint(t, pubs.find((row) => row.task_id === t.id)?.platforms ?? null),
          }))
        : tasks.map((t) => ({ placement_id: t.id, fingerprint: `x${i}${t.id}` }));
      receipts.push(
        approveReceipt(lock, {
          command_id: `cmd-a-${i}`,
          applied_revision: 1 + receipts.length,
          payload_json: rand() < 0.1 ? '{not json' : undefined,
        }),
      );
    }

    const built = view({ tasks, publishRows: pubs, receipts, now: NOW, staleAfterMs: 24 * 60 * 60 * 1000 });
    for (const placement of built.placements) {
      approval.add(placement.approval_state);
      publication.add(placement.publication_state);
      freshness.add(placement.freshness);
    }
    summary.add(built.approval_summary.state);
    for (const row of pubs) publication.add(classifyPublication(row).state);
  }
  return { approval, publication, freshness, summary };
}

function assertExactVocabulary(declared: string[], produced: Set<string>, label: string) {
  const dead = declared.filter((member) => !produced.has(member));
  const undeclared = [...produced].filter((value) => !declared.includes(value));
  assert.deepEqual(
    dead,
    [],
    `${label}: dead member(s) in the public type — declared but nothing can produce them: ${dead.join(', ')}`,
  );
  assert.deepEqual(
    undeclared,
    [],
    `${label}: value(s) produced that the public type does not declare: ${undeclared.join(', ')}`,
  );
}

// ─── N1 — PlacementApprovalState: no dead member, no undeclared state ──────

test('N1 class: PlacementApprovalState exactly equals the states the projection can produce', () => {
  const declared = unionMembers('PlacementApprovalState');
  const produced = approvalProducible();
  for (const value of fuzzProducible().approval) produced.add(value);

  assertExactVocabulary(declared, produced, 'PlacementApprovalState');
  // The reachable set the verdict proved by 4000 randomized views, stated
  // outright so the fix cannot satisfy this by widening the type instead.
  assert.deepEqual(
    [...produced].sort(),
    ['APPROVED', 'DRAFT', 'HELD', 'INVALIDATED', 'UNKNOWN'],
    'the reachable approval states are exactly these five',
  );
});

// ─── N2 — PublicationState: no dead member, no style row for one ───────────

test('N2 class: PublicationState exactly equals the states classifyPublication can emit', () => {
  const declared = unionMembers('PublicationState');
  const produced = publicationProducible();
  for (const value of fuzzProducible().publication) produced.add(value);

  assertExactVocabulary(declared, produced, 'PublicationState');
  assert.deepEqual([...produced].sort(), ['BEHIND', 'CURRENT', 'UNKNOWN'], 'the reachable publication states are exactly these three');
});

test('N2 class: the board ships a style row for every publication state and none for an impossible one', () => {
  const declared = unionMembers('PublicationState');
  const produced = publicationProducible();
  const rows = styleKeys('PUBLICATION_STYLE');

  const deadRows = rows.filter((key) => !produced.has(key));
  assert.deepEqual(deadRows, [], `the board styles impossible state(s): ${deadRows.join(', ')}`);
  assert.deepEqual([...rows].sort(), [...declared].sort(), 'PUBLICATION_STYLE keys must equal the declared vocabulary');
  for (const member of declared) {
    assert.ok(produced.has(member), `PUBLICATION_STYLE has a row for ${member} which classifyPublication never emits`);
  }
});

// ─── Class sweep — every other closed vocabulary in the same contract ──────

test('class sweep: FreshnessState, CalendarCellState and the receipt/summary vocabularies have no dead member', () => {
  // FreshnessState — from the projection itself.
  const freshness = new Set<string>(fuzzProducible().freshness);
  freshness.add(view({ tasks: [task()], publishRows: [pub()], events: [event('task-a', '2026-10-24T11:30:00.000Z')] }).placements[0].freshness);
  freshness.add(
    view({ tasks: [task()], publishRows: [pub()], events: [event('task-a', '2026-10-01T00:00:00.000Z')] }).placements[0].freshness,
  );
  freshness.add(view({ tasks: [task()], publishRows: [pub()], events: [] }).placements[0].freshness);
  assertExactVocabulary(unionMembers('FreshnessState'), freshness, 'FreshnessState');

  // CalendarCellState — from the ONE rule, cellStateOf().
  const cells = new Set<string>();
  cells.add(cellStateOf(placementOf({ publication_state: 'CURRENT', freshness: 'live' })));
  cells.add(cellStateOf(placementOf({ publication_state: 'BEHIND', freshness: 'stale' })));
  cells.add(cellStateOf(placementOf({ publication_state: 'BEHIND', freshness: 'unknown' })));
  cells.add(cellStateOf(placementOf({ publication_state: 'BEHIND', freshness: 'live', approval_state: 'HELD' })));
  cells.add(cellStateOf(placementOf({ publication_state: 'BEHIND', freshness: 'live', approval_state: 'APPROVED' })));
  cells.add(cellStateOf(placementOf({ publication_state: 'BEHIND', freshness: 'live', approval_state: 'UNKNOWN' })));
  cells.add(cellStateOf(placementOf({ publication_state: 'BEHIND', freshness: 'live', approval_state: 'DRAFT' })));
  cells.add(cellStateOf(placementOf({ publication_state: 'BEHIND', freshness: 'live', approval_state: 'INVALIDATED' })));
  assertExactVocabulary(unionMembers('CalendarCellState'), cells, 'CalendarCellState');
  assert.deepEqual([...styleKeys('CELL_STYLE')].sort(), [...cells].sort(), 'CELL_STYLE rows must equal the reachable cells');
  assert.deepEqual([...styleKeys('CELL_LABEL')].sort(), [...cells].sort(), 'CELL_LABEL rows must equal the reachable cells');

  // ReceiptView.state and ReceiptView.freshness — from the receipt mapping.
  const built = view({
    tasks: [task()],
    publishRows: [pub()],
    receipts: [
      receipt({ command_id: 'c1', applied_revision: 1 }),
      receipt({ command_id: 'c2', applied_revision: 1 }),
      receipt({ command_id: 'c3', state: 'refused', applied_revision: null, refusal_code: 'revision_conflict' }),
    ],
  });
  const receiptStates = new Set<string>();
  const receiptFreshness = new Set<string>();
  for (const row of built.receipts) {
    receiptStates.add(row.state);
    receiptFreshness.add(row.freshness);
  }
  assertExactVocabulary(fieldUnion('ReceiptView', 'state'), receiptStates, 'ReceiptView.state');
  assertExactVocabulary(fieldUnion('ReceiptView', 'freshness'), receiptFreshness, 'ReceiptView.freshness');

  // approval_summary.state — from the roll-up.
  const summary = new Set<string>(fuzzProducible().summary);
  summary.add(view({ tasks: [task()], publishRows: [pub()], receipts: [] }).approval_summary.state);
  summary.add(
    view({
      tasks: [task()],
      publishRows: [pub()],
      receipts: [approveReceipt([{ placement_id: 'task-a', fingerprint: placementFingerprint(task(), 'facebook') }])],
    }).approval_summary.state,
  );
  summary.add(
    view({ tasks: [], publishRows: [], receipts: [receipt({ payload_json: '{not json' })] }).approval_summary.state,
  );
  assertExactVocabulary(fieldUnion('CampaignApprovalView', 'state'), summary, 'approval_summary.state');
});
