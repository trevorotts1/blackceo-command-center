/**
 * ghl-hybrid-board.test.ts — WF18 · board source ownership and engine guards.
 *
 * Acceptance: A22 (engine ownership) and IG-PROJECT-07 hook side (the shared
 * migration registration + dispatcher/ingest hooks WF33 depends on).
 *
 * Proves, against an isolated DB and the REAL route handlers:
 *   • `ghl-hybrid` is ONE recognized producer and an ENGINE-OWNED source in the
 *     canonical vocabulary every advancer imports;
 *   • the manual dispatch route refuses an engine-owned card (409) — a second
 *     executor would repeat a real GoHighLevel mutation;
 *   • migration 179 registers the receipt store (the shared migration surface
 *     WF33 adds its Projects mapping through);
 *   • old producers still ingest, and a ghl-hybrid child attaches to its signed
 *     parent.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';

const DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wf18-board-')), 'db');
process.env.DATABASE_PATH = DB;
process.env.MC_COMPANY_ID = 'default';
process.env.MC_API_TOKEN = 'wf18-board-token';
process.env.WEBHOOK_SECRET = 'wf18-board-secret';
process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
delete process.env.CC_OPERATOR_CHAT_ID;
delete process.env.OPENCLAW_OPERATOR_CHAT_ID;

import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';

let dbMod: typeof import('../../src/lib/db');
let board: typeof import('../../src/lib/board-sources');
let migrations: typeof import('../../src/lib/db/migrations');
let backlogSweep: typeof import('../../src/lib/jobs/backlog-redispatch-sweep');
let intakeSweep: typeof import('../../src/lib/jobs/intake-advance-sweep');
let ceoSweep: typeof import('../../src/lib/jobs/ceo-delegation-sweep');
let dispatchPost: (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let ingestPost: (req: NextRequest) => Promise<Response>;

const WS = 'ws-wf18-board';

function hmac(body: string): string {
  return createHmac('sha256', 'wf18-board-secret').update(body).digest('hex');
}

function signedIngest(body: Record<string, unknown>): NextRequest {
  const raw = JSON.stringify(body);
  return new NextRequest('http://localhost/api/tasks/ingest', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer wf18-board-token',
      'x-webhook-signature': hmac(raw),
    },
    body: raw,
  });
}

test.before(async () => {
  dbMod = await import('../../src/lib/db');
  board = await import('../../src/lib/board-sources');
  migrations = await import('../../src/lib/db/migrations');
  backlogSweep = await import('../../src/lib/jobs/backlog-redispatch-sweep');
  intakeSweep = await import('../../src/lib/jobs/intake-advance-sweep');
  ceoSweep = await import('../../src/lib/jobs/ceo-delegation-sweep');
  dispatchPost = (await import('../../src/app/api/tasks/[id]/dispatch/route')).POST as never;
  ingestPost = (await import('../../src/app/api/tasks/ingest/route')).POST as never;

  dbMod.getDb();
  const now = new Date().toISOString();
  dbMod.run(
    "INSERT OR IGNORE INTO companies (id,name,slug,config,created_at,updated_at) VALUES ('default','D','d','{}',?,?)",
    [now, now],
  );
  dbMod.run(
    "INSERT OR IGNORE INTO workspaces (id,slug,name,icon,company_id,sort_order,created_at,updated_at) VALUES (?,'general-task','General Task','G','default',1,?,?)",
    [WS, now, now],
  );
});

test.after(() => {
  try { dbMod?.closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(path.dirname(DB), { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── Vocabulary ──────────────────────────────────────────────────────────────

test('[A22] ghl-hybrid is ONE recognized producer AND an engine-owned source', () => {
  assert.ok(board.RECOGNIZED_BOARD_SOURCES.has('ghl-hybrid'));
  assert.equal(board.normalizeBoardSource('  GHL-Hybrid '), 'ghl-hybrid');
  assert.ok(board.ENGINE_OWNED_SOURCES.includes('ghl-hybrid'));
  assert.equal(board.isEngineOwnedBoardSource('ghl-hybrid'), true);
  assert.ok(board.boardSourceLabel('ghl-hybrid'), 'an engine source must have a human name');
  assert.match(
    String(board.engineOwnedWaitingLabel('ghl-hybrid', 'backlog')),
    /^Waiting on .+ — the board does not dispatch this card$/,
  );
  // A board card is untouched by the engine vocabulary.
  assert.equal(board.isEngineOwnedBoardSource('telegram'), false);
  assert.equal(board.engineOwnedWaitingLabel('funnel', 'backlog'), null);
});

test('[A22] every board advancer carries the SAME engine-owned vocabulary', () => {
  const canonical = [...board.ENGINE_OWNED_SOURCES].sort();
  assert.deepEqual([...backlogSweep.ENGINE_OWNED_SOURCES].sort(), canonical);
  assert.deepEqual([...intakeSweep.ENGINE_OWNED_SOURCES].sort(), canonical);
  assert.deepEqual([...ceoSweep.ENGINE_OWNED_SOURCES].sort(), canonical);
});

test('[A22] the intake-advance SQL filters include every engine-owned source', () => {
  // The four inline SQL literals cannot be imported; this drift guard fails the
  // moment the const list gains a source the SQL still omits.
  const source = fs.readFileSync('src/lib/jobs/intake-advance-sweep.ts', 'utf8');
  const lists = [...source.matchAll(/NOT IN \(([^)]*)\)/g)]
    .map((m) => m[1])
    .filter((list) => list.includes("'build_deck'"));
  assert.ok(lists.length >= 4, `expected the four engine-owned SQL filters, saw ${lists.length}`);
  for (const list of lists) {
    assert.ok(list.includes("'ghl-hybrid'"), `engine-owned SQL filter omits ghl-hybrid: ${list}`);
  }
});

// ── Migration surface (WF33 adds its Projects mapping through WF18) ─────────

test('[IG-PROJECT-07] migration 179 registers the receipt store and its immutability trigger', () => {
  const ids = migrations.migrationIds();
  assert.ok(ids.includes('179'), 'migration 179 must be registered');
  assert.equal(ids.filter((id) => id === '179').length, 1, 'migration ids must be unique');

  const table = dbMod.queryOne<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='ghl_operation_receipts'",
  );
  assert.ok(table, 'the receipt store table must exist after migrations');

  const trigger = dbMod.queryOne<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND name='ghl_operation_receipts_immutable'",
  );
  assert.ok(trigger, 'receipt events must be update-immutable at the DB level');

  const indexes = dbMod.queryAll<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='ghl_operation_receipts'",
  ).map((r) => r.name);
  assert.ok(indexes.includes('idx_ghl_receipts_task'));
  assert.ok(indexes.includes('idx_ghl_receipts_operation'));
});

// ── Dispatch refusal ────────────────────────────────────────────────────────

test('[A22] the board refuses to dispatch an engine-owned ghl-hybrid card', async () => {
  const now = new Date().toISOString();
  dbMod.run(
    `INSERT INTO tasks (id,title,description,status,priority,workspace_id,business_id,source,created_at,updated_at)
     VALUES ('task-wf18-engine','GHL phase card','phase','backlog','medium',?,NULL,'ghl-hybrid',?,?)`,
    [WS, now, now],
  );
  const req = new NextRequest('http://localhost/api/tasks/task-wf18-engine/dispatch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const res = await dispatchPost(req, { params: Promise.resolve({ id: 'task-wf18-engine' }) });
  const json = (await res.json()) as Record<string, unknown>;
  assert.equal(res.status, 409);
  assert.equal(json.reason, 'engine_owned');
  assert.equal(json.held, true);
  assert.match(String(json.message), /does not\s+dispatch this card|does not dispatch this card/);
});

// ── Ingest compatibility ────────────────────────────────────────────────────

test('[A22] old producers still ingest unchanged', async () => {
  const res = await ingestPost(signedIngest({ title: 'Skill 6 funnel card', source: 'funnel' }));
  const json = (await res.json()) as { task_id?: string; id?: string };
  // The ingest door answers 201 Created for a new card (and 200 for a dedupe).
  assert.equal(res.status, 201);
  const id = String(json.task_id ?? json.id ?? '');
  const row = dbMod.queryOne<{ source: string }>('SELECT source FROM tasks WHERE id = ?', [id]);
  assert.equal(row?.source, 'funnel');
});

test('[A22] a ghl-hybrid parent and its signed child ingest with the engine stamp', async () => {
  const parentRes = await ingestPost(signedIngest({
    title: 'GHL course build — launch101',
    source: 'ghl-hybrid',
    source_ref: 'run:ghl:launch101',
  }));
  const parentJson = (await parentRes.json()) as { task_id?: string; id?: string };
  assert.equal(parentRes.status, 201);
  const parentId = String(parentJson.task_id ?? parentJson.id ?? '');
  assert.ok(parentId);
  assert.equal(
    dbMod.queryOne<{ source: string }>('SELECT source FROM tasks WHERE id = ?', [parentId])?.source,
    'ghl-hybrid',
  );

  const childRes = await ingestPost(signedIngest({
    title: 'Course outline phase',
    source: 'ghl-hybrid',
    parent_task_id: parentId,
    // Each phase child carries its OWN idempotency ref; reusing the parent's
    // run ref would be read as the same operation with different instructions.
    source_ref: 'run:ghl:launch101:phase:outline',
    external_session_id: 'run:ghl:launch101',
  }));
  const childJson = (await childRes.json()) as { task_id?: string; id?: string };
  assert.equal(childRes.status, 201);
  const childId = String(childJson.task_id ?? childJson.id ?? '');
  const child = dbMod.queryOne<{ source: string; parent_task_id: string }>(
    'SELECT source, parent_task_id FROM tasks WHERE id = ?',
    [childId],
  );
  assert.equal(child?.source, 'ghl-hybrid');
  assert.equal(child?.parent_task_id, parentId);
});
