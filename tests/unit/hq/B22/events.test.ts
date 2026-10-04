/**
 * B22 — scoped content-free `hq_changed` invalidation and its fail-closed
 * resolver (SPEC S7: "`hq_changed` is a content-free company-scoped
 * invalidation with company and high-water cursor only … if scope cannot be
 * proved, DROP it. Never let new HQ events fall through existing `null` legacy
 * fan-out. Private chat content/turn IDs are never emitted on the company-wide
 * bus.").
 *
 * Proves, against the REAL src/lib/events.ts broadcast path and an isolated
 * temp DB (real migration chain):
 *   1. Q04 two-company delivery/control — Company A's connection receives A's
 *      invalidation, never B's; the operator (unscoped) connection sees both.
 *   2. Missing-scope drop — an hq_changed whose company/cursor cannot be proved
 *      is dropped for EVERYONE, including the operator, and is never journaled
 *      to the cross-process bus (no null legacy fan-out).
 *   3. Content-free — the delivered bytes carry type/companyId/highSeq and
 *      nothing else; no activity text, message, session or turn ID.
 *   4. Existing task event regression — task_created/task_updated/task_deleted
 *      still resolve scope through the workspace and deliver exactly as before.
 *
 * Run:
 *   /opt/homebrew/opt/node@26/bin/node --import <cc>/node_modules/tsx/dist/loader.mjs \
 *     --import ./tests/setup/no-owner-telegram.ts --import ./tests/setup/tmp-sandbox.ts \
 *     --test tests/unit/hq/B22/events.test.ts
 */
import '../../_isolated-db'; // MUST be first DB import: throwaway DATABASE_PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb, run, queryOne, closeDb } from '../../../../src/lib/db';

const HOST_A = 'a-b22.example.com';
const HOST_B = 'b-b22.example.com';
const COMPANY_A = 'company-b22-a';
const COMPANY_B = 'company-b22-b';

function seedCompany(id: string): void {
  const now = new Date().toISOString();
  run(
    `INSERT OR IGNORE INTO companies (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    [id, `Company ${id}`, id, now, now],
  );
}

function seedWorkspace(id: string, companyId: string, slug: string): void {
  const now = new Date().toISOString();
  seedCompany(companyId);
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, company_id, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1000, ?, ?)`,
    [id, slug, slug, companyId, now, now],
  );
}

function seedTask(id: string, workspaceId: string, status = 'in_progress'): void {
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, status, workspace_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, `B22 task ${id}`, status, workspaceId, now, now],
  );
}

function fakeController(sink: string[]): ReadableStreamDefaultController {
  return {
    get desiredSize() {
      return 1024;
    },
    enqueue(chunk: Uint8Array) {
      sink.push(new TextDecoder().decode(chunk));
    },
    close() {
      /* test double */
    },
  } as unknown as ReadableStreamDefaultController;
}

function journalCount(): number {
  const row = queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM sse_event_log`);
  return row?.n ?? 0;
}

test('B22 hq_changed: two-company delivery/control, and content-free bytes', async () => {
  const events = await import('../../../../src/lib/events');
  const receivedA: string[] = [];
  const receivedB: string[] = [];
  const receivedOp: string[] = [];

  const ctrlA = fakeController(receivedA);
  const ctrlB = fakeController(receivedB);
  const ctrlOp = fakeController(receivedOp);
  events.registerClient(ctrlA, COMPANY_A);
  events.registerClient(ctrlB, COMPANY_B);
  events.registerClient(ctrlOp, null); // operator session: unscoped

  try {
    events.broadcast({ type: 'hq_changed', payload: { companyId: COMPANY_A, highSeq: 42 } });

    assert.equal(receivedA.length, 1, 'A receives its own invalidation');
    assert.equal(receivedB.length, 0, 'B never receives A bytes');
    assert.equal(receivedOp.length, 1, 'operator (control) still sees it');

    const wire = JSON.parse(receivedA[0].replace(/^data: /, '').trim()) as Record<string, unknown>;
    assert.equal(wire.type, 'hq_changed');
    // Scope travels the same way every other broadcast scopes: on the envelope
    // the fan-out and the journal both read.
    assert.equal(wire.companyId, COMPANY_A);
    const parsed = wire.payload as Record<string, unknown>;
    assert.equal(parsed.companyId, COMPANY_A);
    assert.equal(parsed.highSeq, 42);
    // Content-free: exactly the frozen HqChangedEvent shape, nothing else.
    assert.deepEqual(Object.keys(parsed).sort(), ['companyId', 'highSeq']);

    // Mirror image: B's own invalidation reaches B and never A.
    events.broadcast({ type: 'hq_changed', payload: { companyId: COMPANY_B, highSeq: 7 } });
    assert.equal(receivedB.length, 1);
    assert.equal(receivedA.length, 1, 'A gains nothing from B');
    assert.ok(receivedB[0].includes(COMPANY_B));
    assert.ok(!receivedB[0].includes(COMPANY_A));

    // The cross-process journal row carries the proved scope, so a Company B
    // connection polling the journal drops A's row via the route's predicate.
    const journaled = queryOne<{ payload: string }>(
      `SELECT payload FROM sse_event_log WHERE event_type = 'hq_changed' ORDER BY id DESC LIMIT 1`,
    );
    assert.ok(journaled, 'proved hq_changed IS journaled for cross-process fan-out');
    const journalPayload = JSON.parse(journaled.payload) as { companyId?: string };
    assert.equal(journalPayload.companyId, COMPANY_B);
    assert.equal(events.connectionMayReceive(COMPANY_B, journalPayload.companyId ?? null), true);
    assert.equal(events.connectionMayReceive(COMPANY_A, journalPayload.companyId ?? null), false);
  } finally {
    events.unregisterClient(ctrlA);
    events.unregisterClient(ctrlB);
    events.unregisterClient(ctrlOp);
  }
});

test('B22 hq_changed: unprovable scope is DROPPED for everyone and never journaled', async () => {
  const events = await import('../../../../src/lib/events');
  const receivedA: string[] = [];
  const receivedOp: string[] = [];
  const ctrlA = fakeController(receivedA);
  const ctrlOp = fakeController(receivedOp);
  events.registerClient(ctrlA, COMPANY_A);
  events.registerClient(ctrlOp, null);

  const journalBefore = journalCount();
  try {
    const unprovable: Array<{ name: string; payload: unknown }> = [
      { name: 'missing companyId', payload: { highSeq: 1 } },
      { name: 'empty companyId', payload: { companyId: '', highSeq: 1 } },
      { name: 'blank companyId', payload: { companyId: '   ', highSeq: 1 } },
      { name: 'missing highSeq', payload: { companyId: COMPANY_A } },
      { name: 'non-integer highSeq', payload: { companyId: COMPANY_A, highSeq: 1.5 } },
      { name: 'NaN highSeq', payload: { companyId: COMPANY_A, highSeq: Number.NaN } },
      { name: 'negative highSeq', payload: { companyId: COMPANY_A, highSeq: -1 } },
      { name: 'string highSeq', payload: { companyId: COMPANY_A, highSeq: '42' } },
      { name: 'null payload', payload: null },
    ];
    for (const row of unprovable) {
      events.broadcast({ type: 'hq_changed', payload: row.payload as never });
      assert.equal(
        receivedA.length + receivedOp.length,
        0,
        `dropped, not fanned out: ${row.name}`,
      );
    }
    assert.equal(journalCount(), journalBefore, 'nothing dropped ever reaches the bus');

    // The HQ invalidation's scope is payload-authoritative: a caller-supplied
    // option can neither force operator-level nor re-attribute it, because
    // either would widen the fan-out past the proved company.
    events.broadcast(
      { type: 'hq_changed', payload: { companyId: COMPANY_A, highSeq: 3 } },
      { companyId: null },
    );
    assert.equal(receivedA.length, 1, 'null option did not demote it to operator-level');
    events.broadcast(
      { type: 'hq_changed', payload: { companyId: COMPANY_A, highSeq: 3 } },
      { companyId: COMPANY_B },
    );
    assert.equal(receivedA.length, 2, 'foreign option did not re-attribute it');
    assert.ok(!receivedA.some((raw) => raw.includes(COMPANY_B)));
    assert.equal(receivedOp.length, 2, 'operator control still receives company-scoped events');

    // Control: the SAME payload with a provable company DOES land, proving the
    // drops above are the fail-closed rule and not a dead code path.
    const beforeControl = receivedA.length;
    events.broadcast({ type: 'hq_changed', payload: { companyId: COMPANY_A, highSeq: 4 } });
    assert.equal(receivedA.length, beforeControl + 1);
    assert.equal(journalCount(), journalBefore + 3, 'only proved events reach the bus');
  } finally {
    events.unregisterClient(ctrlA);
    events.unregisterClient(ctrlOp);
  }
});

test('B22 regression: existing task events still scope through the workspace', async () => {
  const events = await import('../../../../src/lib/events');
  seedWorkspace('ws-b22-a', COMPANY_A, 'b22-a');
  seedWorkspace('ws-b22-b', COMPANY_B, 'b22-b');
  seedTask('task-b22-a', 'ws-b22-a');
  seedTask('task-b22-b', 'ws-b22-b');

  const receivedA: string[] = [];
  const receivedB: string[] = [];
  const receivedOp: string[] = [];
  const ctrlA = fakeController(receivedA);
  const ctrlB = fakeController(receivedB);
  const ctrlOp = fakeController(receivedOp);
  events.registerClient(ctrlA, COMPANY_A);
  events.registerClient(ctrlB, COMPANY_B);
  events.registerClient(ctrlOp, null);

  try {
    const rowA = queryOne<Record<string, unknown>>('SELECT * FROM tasks WHERE id = ?', ['task-b22-a']);
    const rowB = queryOne<Record<string, unknown>>('SELECT * FROM tasks WHERE id = ?', ['task-b22-b']);
    assert.ok(rowA && rowB);

    events.broadcast({ type: 'task_updated', payload: rowA as never });
    events.broadcast({ type: 'task_created', payload: rowB as never });
    events.broadcast({ type: 'task_deleted', payload: { id: 'task-b22-a' } });

    assert.equal(receivedA.length, 2, 'A sees its own update + delete');
    assert.ok(receivedA.some((raw) => raw.includes('task-b22-a') && raw.includes('task_updated')));
    assert.ok(receivedA.some((raw) => raw.includes('task_deleted')));
    assert.ok(!receivedA.some((raw) => raw.includes('task-b22-b')), 'A never sees B bytes');

    assert.equal(receivedB.length, 1);
    assert.ok(receivedB[0].includes('task-b22-b'));
    assert.equal(receivedOp.length, 3, 'operator control still sees every task event');

    // Legacy unscoped operator-level events keep their old fan-out.
    const beforeA = receivedA.length;
    const beforeB = receivedB.length;
    events.broadcast({ type: 'bug_created', payload: { title: 'operator note' } as never });
    assert.equal(receivedA.length, beforeA + 1);
    assert.equal(receivedB.length, beforeB + 1);
  } finally {
    events.unregisterClient(ctrlA);
    events.unregisterClient(ctrlB);
    events.unregisterClient(ctrlOp);
  }
});

test.after(() => {
  try {
    closeDb();
  } catch {
    /* already closed */
  }
});
