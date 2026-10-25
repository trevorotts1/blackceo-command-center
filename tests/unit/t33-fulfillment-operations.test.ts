/**
 * T-33 — pause / retry / handoff through the owner, tenant-scoped and
 * expected-versioned.
 *
 * Attack matrix, per the PBB-174 defect class: the expected version is
 * ABSENT, STALE, WRONG-TYPED, from ANOTHER TENANT, or arrives OUT OF ORDER.
 * Every one must be refused with no state change and no receipt. The legitimate
 * inverse is proven too: the right owner at the right version moves the state,
 * and the handoff records the accepted owner, backup, due action and context.
 */
import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../../src/lib/db';
import {
  handoffFulfillment,
  pauseFulfillment,
  retryFulfillment,
  type FulfillmentControlEnvelope,
} from '../../src/lib/fulfillment/operations';

const OWNER: FulfillmentControlEnvelope = {
  tenantId: 'tenant-1',
  companyId: 'co-1',
  workspaceId: 'ws-1',
  actor: 'owner',
  ownerId: 'owner-1',
};

function seed(): void {
  const db = getDb();
  db.prepare(`INSERT OR IGNORE INTO companies (id, name, slug) VALUES ('co-1', 'Co One', 'co-1')`).run();
  db.prepare(`INSERT OR IGNORE INTO companies (id, name, slug) VALUES ('co-2', 'Co Two', 'co-2')`).run();
  db.prepare(`INSERT OR IGNORE INTO workspaces (id, name, slug, icon, company_id, sort_order) VALUES ('ws-1','ws-1','ws-1','x','co-1',950)`).run();
  db.prepare(`INSERT OR IGNORE INTO workspaces (id, name, slug, icon, company_id, sort_order) VALUES ('ws-2','ws-2','ws-2','x','co-2',950)`).run();
  for (const [id, ws] of [
    ['op-1', 'ws-1'],
    ['op-2', 'ws-1'],
    ['op-3', 'ws-1'],
    ['foreign', 'ws-2'],
  ]) {
    db.prepare(
      `INSERT OR IGNORE INTO tasks (id, title, status, priority, workspace_id, department, created_at, updated_at)
       VALUES (?,?, 'in_progress', 'medium', ?, 'personal-assistant', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`,
    ).run(id, `Task ${id}`, ws);
  }
}
seed();

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (err: unknown) => {
    const e = err as { code?: string; message?: string };
    assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    return true;
  });
}

function opRow(taskId: string): { state: string; state_version: number; retry_count: number } | undefined {
  return getDb()
    .prepare(`SELECT state, state_version, retry_count FROM fulfillment_operations WHERE task_id = ?`)
    .get(taskId) as { state: string; state_version: number; retry_count: number } | undefined;
}

function receiptCount(taskId: string): number {
  return (
    getDb()
      .prepare(`SELECT count(*) AS n FROM fulfillment_operation_receipts WHERE task_id = ?`)
      .get(taskId) as { n: number }
  ).n;
}

test('CONTROL: the task is visible in its own tenant (the instrument works)', () => {
  assert.equal(opRow('op-1'), undefined);
  const t = getDb().prepare(`SELECT id FROM tasks WHERE id = 'op-1' AND workspace_id = 'ws-1'`).get();
  assert.ok(t);
});

test('ABSENT expected version is refused: it is not "any version"', () => {
  expectCode(() => pauseFulfillment(OWNER, 'op-1', {}), 'VERSION_REQUIRED');
  assert.equal(opRow('op-1'), undefined);
  assert.equal(receiptCount('op-1'), 0);
});

test('WRONG-TYPED expected versions are refused, never coerced', () => {
  for (const bad of ['1', 1.5, Number.NaN, true, null, {}, []]) {
    expectCode(
      () => pauseFulfillment(OWNER, 'op-1', { expectedVersion: bad as never }),
      'VERSION_INVALID',
    );
  }
  expectCode(
    () => pauseFulfillment(OWNER, 'op-1', { expectedVersion: 0 }),
    'VERSION_INVALID',
  );
  assert.equal(opRow('op-1'), undefined);
});

test('STALE expected version is refused at the initial version boundary', () => {
  expectCode(() => pauseFulfillment(OWNER, 'op-1', { expectedVersion: 2 }), 'VERSION_MISMATCH');
  assert.equal(opRow('op-1'), undefined);
});

test('ANOTHER TENANT is indistinguishable from absence and changes nothing', () => {
  expectCode(
    () => pauseFulfillment({ ...OWNER, workspaceId: 'ws-2' }, 'op-1', { expectedVersion: 1 }),
    'NOT_FOUND',
  );
  expectCode(
    () => pauseFulfillment({ ...OWNER, companyId: 'co-2' }, 'op-1', { expectedVersion: 1 }),
    'NOT_FOUND',
  );
  assert.equal(opRow('op-1'), undefined);
  assert.equal(receiptCount('op-1'), 0);
});

test('NON-OWNER principals are refused even with the right version', () => {
  expectCode(
    () => pauseFulfillment({ ...OWNER, actor: 'agent' }, 'op-1', { expectedVersion: 1 }),
    'OWNER_REQUIRED',
  );
  expectCode(
    () => pauseFulfillment({ ...OWNER, ownerId: '   ' }, 'op-1', { expectedVersion: 1 }),
    'OWNER_REQUIRED',
  );
  assert.equal(opRow('op-1'), undefined);
});

test('LEGITIMATE: the owner pauses at version 1 and the step is proven', () => {
  const receipt = pauseFulfillment(OWNER, 'op-1', { expectedVersion: 1 });
  assert.equal(receipt.step, 'pause');
  assert.equal(receipt.fromState, 'active');
  assert.equal(receipt.toState, 'paused');
  assert.equal(receipt.stateVersion, 2);
  assert.equal(receipt.ownerId, 'owner-1');
  assert.match(receipt.proof, /^[0-9a-f]{64}$/);
  assert.deepEqual(opRow('op-1'), { state: 'paused', state_version: 2, retry_count: 0 });
  assert.equal(receiptCount('op-1'), 1);
});

test('REPLAY at the same paused version is idempotent and writes no second receipt', () => {
  const replay = pauseFulfillment(OWNER, 'op-1', { expectedVersion: 2 });
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.stateVersion, 2);
  assert.equal(receiptCount('op-1'), 1);
});

test('OUT OF ORDER: a retry carrying the OLD version is refused', () => {
  expectCode(() => retryFulfillment(OWNER, 'op-1', { expectedVersion: 1 }), 'VERSION_MISMATCH');
  assert.deepEqual(opRow('op-1'), { state: 'paused', state_version: 2, retry_count: 0 });
  assert.equal(receiptCount('op-1'), 1);
});

test('LEGITIMATE: retry from paused at the current version resumes and counts the attempt', () => {
  const receipt = retryFulfillment(OWNER, 'op-1', { expectedVersion: 2 });
  assert.equal(receipt.fromState, 'paused');
  assert.equal(receipt.toState, 'active');
  assert.equal(receipt.stateVersion, 3);
  assert.deepEqual(opRow('op-1'), { state: 'active', state_version: 3, retry_count: 1 });
  assert.equal(receiptCount('op-1'), 2);
});

test('retry from an ACTIVE thread is an illegal transition, not a silent no-op', () => {
  expectCode(() => retryFulfillment(OWNER, 'op-1', { expectedVersion: 3 }), 'ILLEGAL_TRANSITION');
  assert.deepEqual(opRow('op-1'), { state: 'active', state_version: 3, retry_count: 1 });
});

test('HANDOFF must carry accepted owner, backup owner, due action and context', () => {
  for (const missing of ['targetOwnerId', 'backupOwnerId', 'dueAction', 'context'] as const) {
    const input = {
      expectedVersion: 3,
      targetOwnerId: 'owner-2',
      backupOwnerId: 'owner-3',
      dueAction: 'send the gift',
      context: 'client asked twice',
    };
    delete (input as Record<string, unknown>)[missing];
    expectCode(() => handoffFulfillment(OWNER, 'op-1', input as never), 'HANDOFF_INCOMPLETE');
  }
  expectCode(
    () =>
      handoffFulfillment(OWNER, 'op-1', {
        expectedVersion: 3,
        targetOwnerId: 'owner-1',
        backupOwnerId: 'owner-3',
        dueAction: 'send the gift',
        context: 'self-handoff',
      }),
    'HANDOFF_INCOMPLETE',
  );
  assert.deepEqual(opRow('op-1'), { state: 'active', state_version: 3, retry_count: 1 });
});

test('LEGITIMATE: the owner hands off; the bot is fenced and the row carries the handoff', () => {
  const receipt = handoffFulfillment(OWNER, 'op-1', {
    expectedVersion: 3,
    targetOwnerId: 'owner-2',
    backupOwnerId: 'owner-3',
    dueAction: 'send the gift',
    context: 'client asked twice',
  });
  assert.equal(receipt.toState, 'handed_off');
  assert.equal(receipt.stateVersion, 4);
  const row = getDb()
    .prepare(
      `SELECT state, state_version, handoff_owner_id, handoff_backup_owner_id, handoff_due_action, handoff_context
         FROM fulfillment_operations WHERE task_id = 'op-1'`,
    )
    .get() as Record<string, unknown>;
  assert.deepEqual(row, {
    state: 'handed_off',
    state_version: 4,
    handoff_owner_id: 'owner-2',
    handoff_backup_owner_id: 'owner-3',
    handoff_due_action: 'send the gift',
    handoff_context: 'client asked twice',
  });
  assert.equal(receiptCount('op-1'), 3);
});

test('a handed-off thread cannot be paused or retried by the bot', () => {
  expectCode(() => pauseFulfillment(OWNER, 'op-1', { expectedVersion: 4 }), 'ILLEGAL_TRANSITION');
  expectCode(() => retryFulfillment(OWNER, 'op-1', { expectedVersion: 4 }), 'ILLEGAL_TRANSITION');
  expectCode(
    () =>
      handoffFulfillment(OWNER, 'op-1', {
        expectedVersion: 4,
        targetOwnerId: 'owner-4',
        backupOwnerId: 'owner-5',
        dueAction: 'again',
        context: 'again',
      }),
    'ILLEGAL_TRANSITION',
  );
  assert.equal(receiptCount('op-1'), 3);
});

test('the receipt ledger proves every step in order with distinct versions', () => {
  const rows = getDb()
    .prepare(
      `SELECT step, from_state, to_state, state_version, proof FROM fulfillment_operation_receipts
        WHERE task_id = 'op-1' ORDER BY state_version ASC`,
    )
    .all() as { step: string; from_state: string; to_state: string; state_version: number; proof: string }[];
  assert.deepEqual(rows.map((r) => [r.step, r.from_state, r.to_state, r.state_version]), [
    ['pause', 'active', 'paused', 2],
    ['retry', 'paused', 'active', 3],
    ['handoff', 'active', 'handed_off', 4],
  ]);
  for (const row of rows) assert.match(row.proof, /^[0-9a-f]{64}$/);
});

test('an unrelated tenant thread stays untouched by the whole sequence', () => {
  assert.equal(opRow('foreign'), undefined);
  assert.equal(receiptCount('foreign'), 0);
});
