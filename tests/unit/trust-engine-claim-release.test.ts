/**
 * U043 Part A — claim-release-on-provable-non-send.
 *
 * Tests exercise executeSends / runTrustEngineSweep through the PUBLIC surface.
 * releaseUnsentClaims is module-private and never imported directly.
 *
 * Single shared database. Aggregate counts (r.claimed, r.sent, r.released)
 * may include tasks from prior test runs — each test only asserts on its own
 * task's state (guard column value, captured chat, anti-duplicate property).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-trust-release-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;
process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';

type DbModule = typeof import('../../src/lib/db');
type EngineModule = typeof import('../../src/lib/jobs/trust-engine');

let db: DbModule;
let engine: EngineModule;

const DAYTIME = new Date(2026, 6, 11, 15, 0, 0);

test.before(async () => {
  db = await import('../../src/lib/db');
  engine = await import('../../src/lib/jobs/trust-engine');
  db.getDb();
  const now = new Date().toISOString();
  db.run(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES ('default', 'Default', 'default', '{}', ?, ?)`,
    [now, now],
  );
  db.run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, description, icon, company_id, sort_order, created_at, updated_at)
     VALUES ('default', 'Default', 'default', 'Default ws', 'folder', 'default', 0, ?, ?)`,
    [now, now],
  );
});

test.after(() => {
  try { db.closeDb(); } catch { /* ignore */ }
});

let seq = 0;
function nextIds(n: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) { seq += 1; ids.push(`t043-${seq}`); }
  return ids;
}

function insertTask(id: string, chat: string): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO tasks (id, title, status, priority, requester_channel, requester_chat_id,
        created_at, updated_at, workspace_id)
     VALUES (?, ?, 'assigned', 'medium', 'telegram', ?, ?, ?, 'default')`,
    [id, `Task ${id}`, chat, now, now],
  );
}

function insertDoneTask(id: string, chat: string): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO tasks (id, title, status, priority, requester_channel, requester_chat_id,
        created_at, updated_at, workspace_id)
     VALUES (?, ?, 'done', 'medium', 'telegram', ?, ?, ?, 'default')`,
    [id, `Done ${id}`, chat, now, now],
  );
  db.run(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path, created_at, updated_at)
     VALUES (?, ?, 'artifact', ?, ?, ?, ?)`,
    [`${id}-delv`, id, `Deliverable for ${id}`, `/tmp/${id}.pdf`, now, now],
  );
}

function taskGuard(id: string): { ack: string | null; done: string | null; rsum: string | null; rloc: string | null } {
  const row = db.queryOne<{
    ack_sent_at: string | null; completion_sent_at: string | null;
    result_summary: string | null; result_location: string | null;
  }>('SELECT ack_sent_at, completion_sent_at, result_summary, result_location FROM tasks WHERE id = ?', [id]);
  return { ack: row?.ack_sent_at ?? null, done: row?.completion_sent_at ?? null, rsum: row?.result_summary ?? null, rloc: row?.result_location ?? null };
}

// ── Case 1: ctx.send returns false → guard column back to NULL ──
test('false return: guard column released to NULL', () => {
  const [id] = nextIds(1);
  insertTask(id, '7001');
  const r = engine.runTrustEngineSweep({ now: DAYTIME, send: () => false });
  const g = taskGuard(id);
  assert.equal(g.ack, null, 'guard column must be back to NULL after release');
  assert.ok(r.released >= 1, 'at least our task was released');
  assert.equal(r.sent, 0, 'nothing was sent');
});

// ── Case 2: ctx.send throws → released, swallow-and-continue survives ──
test('throw: guard column released to NULL, swallow-and-continue survives', () => {
  const [idThrow, idNext] = nextIds(2);
  insertTask(idThrow, '8001');
  insertTask(idNext, '8002');

  const thrownChats: string[] = [];
  const okChats: string[] = [];
  const sender = (chat: string, msg: string) => {
    if (chat === '8001') { thrownChats.push(chat); throw new Error('sync throw'); }
    okChats.push(chat);
    return true;
  };

  const r = engine.runTrustEngineSweep({ now: DAYTIME, send: sender });
  const gThrow = taskGuard(idThrow);
  const gNext = taskGuard(idNext);

  assert.equal(gThrow.ack, null, 'thrown task guard column released back to NULL');
  assert.ok(gNext.ack, 'second task guard column is stamped (successful send)');
  assert.ok(okChats.includes('8002'), 'second task was dispatched');
  assert.ok(r.released >= 1, 'at least the thrown plan was released');
});

// ── Case 3: ctx.send returns true → anti-regression (nothing released from success) ──
test('true return: guard column stays stamped, our successful task not released', () => {
  const [id] = nextIds(1);
  insertTask(id, '9001');
  const captured: string[] = [];
  const r = engine.runTrustEngineSweep({
    now: DAYTIME,
    send: (chat: string, msg: string) => { captured.push(chat); return true; },
  });
  const g = taskGuard(id);
  assert.ok(g.ack, 'our task guard column is stamped (successful send)');
  assert.ok(captured.includes('9001'), 'our task was dispatched');
  // Verify no release happened on our successful row on a second sweep
  const r2 = engine.runTrustEngineSweep({
    now: DAYTIME,
    send: () => { throw new Error('must not be called — already stamped'); },
  });
  const g2 = taskGuard(id);
  assert.ok(g2.ack, 'stamp survives the second sweep — no regression');
});

// ── Case 4: DONE plan with extraSets → all columns back to NULL on release ──
test('DONE plan false return: completion_sent_at, result_summary, result_location all NULL', () => {
  const [id] = nextIds(1);
  insertDoneTask(id, '9101');
  const r = engine.runTrustEngineSweep({ now: DAYTIME, send: () => false });
  const g = taskGuard(id);
  assert.equal(g.done, null, 'completion_sent_at back to NULL');
  assert.equal(g.rsum, null, 'result_summary back to NULL');
  assert.equal(g.rloc, null, 'result_location back to NULL');
  assert.ok(r.released >= 1, 'at least our done plan was released');
});

// ── Case 5: concurrency — a fresher claim survives the release ──
test('concurrency: a fresher claim survives the release', () => {
  const [id] = nextIds(1);
  insertDoneTask(id, '9201');
  const OTHER = new Date(2026, 6, 11, 16, 30, 0).toISOString();

  const r = engine.runTrustEngineSweep({
    now: DAYTIME,
    send: ((): boolean => {
      db.run('UPDATE tasks SET completion_sent_at = ? WHERE id = ?', [OTHER, id]);
      return false;
    }) as never,
  });
  const g = taskGuard(id);
  assert.equal(g.done, OTHER, 'the fresher claim from the second sweep must survive untouched');
  assert.equal(g.rsum, null, 'extraSets should NOT have been applied (no claim succeeded)');
});

// ── Case 6: after a release, the row is re-planned on the next sweep ──
test('after release: the row is re-planned on the next sweep', () => {
  const [id] = nextIds(1);
  insertTask(id, '9301');

  // First sweep: send returns false → claim released
  engine.runTrustEngineSweep({ now: DAYTIME, send: () => false });
  const g1 = taskGuard(id);
  assert.equal(g1.ack, null, 'row is un-stamped after release');

  // Second sweep: the row is unstamped → candidate again
  const captured: string[] = [];
  const r = engine.runTrustEngineSweep({
    now: DAYTIME,
    send: (chat: string, msg: string) => { captured.push(chat); return true; },
  });
  const g = taskGuard(id);
  assert.ok(g.ack, 'guard column is now stamped after the successful re-send');
  assert.ok(captured.includes('9301'), 'our task was re-sent');
  assert.ok(r.sent >= 1, 'at least our re-planned row was sent');
});
