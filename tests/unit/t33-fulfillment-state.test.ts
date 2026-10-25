/**
 * T-33 — canonical sequence and per-step proof, tenant-scoped.
 *
 * The defect this pins: a read model that returns every workspace's threads no
 * matter which tenant asked. CONTROL A seeds two tenants and proves the rows
 * are readable; CONTROL B asks for ONE tenant and proves the other tenant's row
 * is not returned. The rest of the suite proves each step's proof rule and that
 * a malformed value is shown WHOLE, never silently accepted or truncated.
 */
import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../../src/lib/db';
import {
  buildFulfillmentThreads,
  FulfillmentScopeError,
  FULFILLMENT_SEQUENCE,
} from '../../src/lib/fulfillment/thread-state';

const NOW = new Date('2026-10-24T12:00:00Z');
const SHA = 'a'.repeat(64);

function seed(): void {
  const db = getDb();
  db.prepare(`INSERT OR IGNORE INTO companies (id, name, slug) VALUES ('default', 'Default', 'default')`).run();
  db.prepare(`INSERT OR IGNORE INTO companies (id, name, slug) VALUES ('other-co', 'Other', 'other-co')`).run();
  for (const [id, company] of [
    ['tenant-a', 'default'],
    ['tenant-b', 'other-co'],
    ['tenant-a2', 'default'],
  ]) {
    db.prepare(
      `INSERT OR IGNORE INTO workspaces (id, name, slug, icon, company_id, sort_order) VALUES (?,?,?,?,?,?)`,
    ).run(id, id, id, 'x', company, 950);
  }
}

function task(id: string, workspaceId: string, overrides: Record<string, unknown> = {}): void {
  const row = {
    id,
    title: overrides.title ?? `Task ${id}`,
    description: overrides.description ?? null,
    status: overrides.status ?? 'in_progress',
    priority: 'medium',
    workspace_id: workspaceId,
    department: 'personal-assistant',
    due_date: overrides.due_date ?? null,
    completed_at: overrides.completed_at ?? null,
    created_at: overrides.created_at ?? '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
  };
  getDb()
    .prepare(
      `INSERT INTO tasks (id, title, description, status, priority, workspace_id, department, due_date, completed_at, created_at, updated_at)
       VALUES (@id, @title, @description, @status, @priority, @workspace_id, @department, @due_date, @completed_at, @created_at, @updated_at)`,
    )
    .run(row);
}

function activity(taskId: string, type: string, message: unknown, at = '2026-10-02T00:00:00Z'): void {
  getDb()
    .prepare(
      `INSERT INTO task_activities (id, task_id, activity_type, message, created_at) VALUES (?,?,?,?,?)`,
    )
    .run(`act-${Math.random().toString(36).slice(2)}`, taskId, type, message as string, at);
}

function deliverable(taskId: string, fields: { sha256?: string | null; path?: string | null; superseded_at?: string | null }): void {
  getDb()
    .prepare(
      `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path, sha256, superseded_at, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(
      `del-${Math.random().toString(36).slice(2)}`,
      taskId,
      'file',
      'proof',
      fields.path ?? null,
      fields.sha256 ?? null,
      fields.superseded_at ?? null,
      '2026-10-02T00:00:00Z',
    );
}

function event(taskId: string, to: string, reason: string | null = null): void {
  getDb()
    .prepare(
      `INSERT INTO task_events (id, task_id, from_status, to_status, actor, reason, created_at) VALUES (?,?,?,?,?,?,?)`,
    )
    .run(`evt-${Math.random().toString(36).slice(2)}`, taskId, 'in_progress', to, 'owner', reason, '2026-10-02T00:00:00Z');
}

seed();

test('CONTROL A: both tenants seed and are readable — the instrument works', () => {
  task('ctl-a', 'tenant-a');
  task('ctl-b', 'tenant-b');
  const row = getDb()
    .prepare(`SELECT count(*) AS n FROM tasks WHERE id IN ('ctl-a','ctl-b')`)
    .get() as { n: number };
  assert.equal(row.n, 2);
});

test('CONTROL B: a tenant-scoped read returns ONLY that workspace', () => {
  task('scope-a', 'tenant-a');
  task('scope-b', 'tenant-b');
  const threads = buildFulfillmentThreads({ now: NOW, workspaceId: 'tenant-a' });
  const ids = threads.map((t) => t.taskId);
  assert.ok(ids.includes('scope-a'));
  assert.ok(!ids.includes('scope-b'), `tenant-b leaked into tenant-a read: ${JSON.stringify(ids)}`);
});

test('an UNSCOPED read is refused, never silently widened', () => {
  assert.throws(() => buildFulfillmentThreads({ now: NOW }), (err: unknown) => {
    assert.ok(err instanceof FulfillmentScopeError);
    assert.equal((err as FulfillmentScopeError).code, 'SCOPE_REQUIRED');
    return true;
  });
});

test('the same workspace under a different company is not visible', () => {
  task('co-a', 'tenant-a');
  const threads = buildFulfillmentThreads({ now: NOW, tenant: { workspaceId: 'tenant-a', companyId: 'other-co' } });
  assert.equal(threads.length, 0);
});

test('the canonical sequence is fixed and every thread carries all seven steps', () => {
  task('seq-a', 'tenant-a2');
  const [thread] = buildFulfillmentThreads({ now: NOW, workspaceId: 'tenant-a2' });
  assert.deepEqual(Object.keys(thread.states), [...FULFILLMENT_SEQUENCE]);
  for (const step of FULFILLMENT_SEQUENCE) {
    assert.equal(thread.states[step].step, step);
    assert.ok(['recorded', 'no_record', 'unknown'].includes(thread.states[step].verdict));
  }
});

test('contacted: an agent_message is proof; a blank one is UNKNOWN with the value whole', () => {
  task('c-1', 'tenant-a2');
  activity('c-1', 'agent_message', 'Hello there');
  task('c-2', 'tenant-a2');
  activity('c-2', 'agent_message', '   ');
  task('c-3', 'tenant-a2');
  const threads = buildFulfillmentThreads({ now: NOW, workspaceId: 'tenant-a2' });
  const byId = Object.fromEntries(threads.map((t) => [t.taskId, t]));
  assert.equal(byId['c-1'].states.contacted.verdict, 'recorded');
  assert.equal(byId['c-1'].states.contacted.proof, 'Hello there');
  assert.equal(byId['c-2'].states.contacted.verdict, 'unknown');
  assert.equal(byId['c-2'].states.contacted.proof, '   ');
  assert.match(byId['c-2'].states.contacted.detail ?? '', /malformed/);
  assert.equal(byId['c-3'].states.contacted.verdict, 'no_record');
});

test('replied: owner_message is proof; a later real reply beats an earlier empty one', () => {
  task('r-1', 'tenant-a2');
  activity('r-1', 'owner_message', 'On it', '2026-10-02T00:00:00Z');
  task('r-2', 'tenant-a2');
  activity('r-2', 'owner_message', '', '2026-10-02T00:00:00Z');
  activity('r-2', 'owner_message', 'Real answer', '2026-10-03T00:00:00Z');
  const byId = Object.fromEntries(buildFulfillmentThreads({ now: NOW, workspaceId: 'tenant-a2' }).map((t) => [t.taskId, t]));
  assert.equal(byId['r-1'].states.replied.proof, 'On it');
  assert.equal(byId['r-2'].states.replied.verdict, 'recorded');
  assert.equal(byId['r-2'].states.replied.proof, 'Real answer');
});

test('gift_promised: title proves it, description is the fallback, non-gift is NO RECORD', () => {
  task('g-1', 'tenant-a2', { title: 'Send the gift box' });
  task('g-2', 'tenant-a2', { title: '', description: 'A surprise for you' });
  task('g-3', 'tenant-a2', { title: '', description: 'gift' }); // description proves it
  task('g-4', 'tenant-a2', { title: '' });
  const byId = Object.fromEntries(buildFulfillmentThreads({ now: NOW, workspaceId: 'tenant-a2' }).map((t) => [t.taskId, t]));
  assert.equal(byId['g-1'].states.gift_promised.proof, 'Send the gift box');
  assert.equal(byId['g-2'].states.gift_promised.proof, 'A surprise for you');
  assert.equal(byId['g-3'].states.gift_promised.verdict, 'recorded');
  assert.equal(byId['g-4'].states.gift_promised.verdict, 'no_record');
  assert.equal(byId['g-4'].states.gift_promised.proof, null);
});

test('gift_delivered: a 64-hex sha256 or an on-disk artifact proves it; junk is UNKNOWN whole', () => {
  const dir = path.dirname(process.env.DATABASE_PATH ?? process.cwd());
  const artifact = path.join(dir, 't33-artifact.txt');
  fs.writeFileSync(artifact, 'proof');
  task('d-1', 'tenant-a2', { title: 'gift one' });
  deliverable('d-1', { sha256: SHA });
  task('d-2', 'tenant-a2', { title: 'gift two' });
  deliverable('d-2', { sha256: 'a'.repeat(63) });
  task('d-3', 'tenant-a2', { title: 'gift three' });
  deliverable('d-3', { path: artifact });
  task('d-4', 'tenant-a2', { title: 'gift four' });
  deliverable('d-4', { sha256: SHA, superseded_at: '2026-10-03T00:00:00Z' });
  const byId = Object.fromEntries(buildFulfillmentThreads({ now: NOW, workspaceId: 'tenant-a2' }).map((t) => [t.taskId, t]));
  assert.equal(byId['d-1'].states.gift_delivered.verdict, 'recorded');
  assert.equal(byId['d-1'].states.gift_delivered.proof, SHA);
  assert.equal(byId['d-2'].states.gift_delivered.verdict, 'unknown');
  assert.equal(byId['d-2'].states.gift_delivered.proof, 'a'.repeat(63), 'the refused value must be shown WHOLE');
  assert.equal(byId['d-3'].states.gift_delivered.verdict, 'recorded');
  assert.equal(byId['d-4'].states.gift_delivered.verdict, 'no_record', 'a superseded row never proves delivery');
});

test('a failed gift can never render delivered even with a valid sha256', () => {
  task('f-1', 'tenant-a2', { title: 'gift failed', status: 'blocked' });
  deliverable('f-1', { sha256: SHA });
  const byId = Object.fromEntries(buildFulfillmentThreads({ now: NOW, workspaceId: 'tenant-a2' }).map((t) => [t.taskId, t]));
  assert.equal(byId['f-1'].states.gift_failed.verdict, 'recorded');
  assert.equal(byId['f-1'].states.gift_delivered.verdict, 'no_record');
});

test('gift_failed: blocked event and error activity both prove it; blank error is UNKNOWN', () => {
  task('e-1', 'tenant-a2');
  event('e-1', 'blocked', 'card declined');
  task('e-2', 'tenant-a2');
  activity('e-2', 'error', 'gateway down');
  task('e-3', 'tenant-a2');
  activity('e-3', 'error', '  ');
  const byId = Object.fromEntries(buildFulfillmentThreads({ now: NOW, workspaceId: 'tenant-a2' }).map((t) => [t.taskId, t]));
  assert.equal(byId['e-1'].states.gift_failed.proof, 'card declined');
  assert.equal(byId['e-2'].states.gift_failed.proof, 'gateway down');
  assert.equal(byId['e-3'].states.gift_failed.verdict, 'unknown');
  assert.equal(byId['e-3'].states.gift_failed.proof, '  ');
});

test('follow_up_due: a past due date on an open task proves it; a malformed date is UNKNOWN', () => {
  task('u-1', 'tenant-a2', { due_date: '2026-10-01' });
  task('u-2', 'tenant-a2', { due_date: 'not-a-date' });
  task('u-3', 'tenant-a2', { due_date: '2026-11-01' });
  task('u-4', 'tenant-a2', { due_date: '2026-10-01', status: 'done', completed_at: '2026-10-02T00:00:00Z' });
  const byId = Object.fromEntries(buildFulfillmentThreads({ now: NOW, workspaceId: 'tenant-a2' }).map((t) => [t.taskId, t]));
  assert.equal(byId['u-1'].states.follow_up_due.verdict, 'recorded');
  assert.equal(byId['u-2'].states.follow_up_due.verdict, 'unknown');
  assert.equal(byId['u-2'].states.follow_up_due.proof, 'not-a-date');
  assert.equal(byId['u-3'].states.follow_up_due.verdict, 'no_record');
  assert.equal(byId['u-4'].states.follow_up_due.verdict, 'no_record');
});

test('follow_up_done: completed_at or status done proves it', () => {
  task('n-1', 'tenant-a2', { status: 'done' });
  task('n-2', 'tenant-a2', { completed_at: '2026-10-03T00:00:00Z' });
  const byId = Object.fromEntries(buildFulfillmentThreads({ now: NOW, workspaceId: 'tenant-a2' }).map((t) => [t.taskId, t]));
  assert.equal(byId['n-1'].states.follow_up_done.proof, 'tasks.status=done');
  assert.equal(byId['n-2'].states.follow_up_done.proof, '2026-10-03T00:00:00Z');
});
