/**
 * U94 (X.2.3) — Requester-stamping completeness, Command-Center UI create
 * door (POST /api/tasks).
 *
 * Before this unit, CreateTaskSchema/CreateTaskRequest carried NO
 * requester_channel/requester_chat_id fields at all, so a UI create that
 * knows which human a task is for silently dropped that identity — the
 * exact gap the spec names ("Requester stamping is partial... UI-created
 * tasks may lack it"). This drives the REAL POST handler (a NextRequest,
 * never a mock) against an isolated temp DB, mirroring
 * tests/unit/ingest-requester-stamp.test.ts and
 * tests/unit/ceo-chat-task-endpoint.test.ts so all three doors are proven
 * with the same rigor:
 *
 *   A. requester_channel + requester_chat_id supplied -> both stamped verbatim
 *   B. chat id, NO channel named -> channel DEFAULTS to 'telegram'
 *   C. no chat id at all -> both NULL (operator-created; never client-facing)
 *   D. whitespace-only chat id -> trimmed to empty -> both NULL
 *
 * Acceptance (b) — "a task created through EACH enumerated door lands with
 * both requester fields non-null" — case A is this door's assertion.
 * Acceptance (c) — "a producer-created task still routes to the operator
 * digest, never to a client" — case C proves the null-requester task is
 * invisible to the trust engine's own candidate query (CANDIDATE_SQL
 * requires requester_chat_id IS NOT NULL), so it can never be planned for a
 * client-facing send.
 *
 * FAIL-FIRST: against the pre-U94 schema/route, cases A/B/D 400 (Zod strips
 * unknown keys silently rather than rejecting, so in fact status stays 201
 * but requester_chat_id persists NULL regardless of what was sent) — the
 * assertions on the persisted columns fail. With the fix they pass.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

// ── Isolated DB (set BEFORE @/lib/db / the route module are imported) ───────
const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-create-task-requester-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;
process.env.OPENCLAW_ROOT = '/nonexistent/openclaw-root-for-tests';
delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.GEMINI_API_KEY;

const RUN_ID = Math.random().toString(36).slice(2, 10);
const SALES_WS_ID = `ws-sales-${RUN_ID}`;

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let closeDb: DbModule['closeDb'];

type RouteModule = typeof import('../../src/app/api/tasks/route');
let POST: RouteModule['POST'];

function callCreate(overrides: Record<string, unknown> = {}): Promise<Response> {
  const payload = {
    title: `Requester UI task ${RUN_ID} ${Math.random().toString(36).slice(2, 8)}`,
    workspace_id: SALES_WS_ID,
    ...overrides,
  };
  const req = new NextRequest('http://localhost/api/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return POST(req) as unknown as Promise<Response>;
}

function requesterCols(taskId: string): { requester_chat_id: string | null; requester_channel: string | null } {
  const row = queryOne<{ requester_chat_id: string | null; requester_channel: string | null }>(
    'SELECT requester_chat_id, requester_channel FROM tasks WHERE id = ?',
    [taskId],
  );
  assert.ok(row, `created task ${taskId} must exist`);
  return row!;
}

test.before(async () => {
  const db = (await import('../../src/lib/db')) as DbModule;
  run = db.run;
  queryOne = db.queryOne;
  closeDb = db.closeDb;
  db.getDb(); // runs the full migration chain against the temp DB

  const now = new Date().toISOString();
  run(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES ('default', 'Default', 'default', '{}', ?, ?)`,
    [now, now],
  );
  run(
    `INSERT OR IGNORE INTO workspaces (id, slug, name, icon, company_id, sort_order, created_at, updated_at)
     VALUES (?, 'sales', 'Sales', '💰', 'default', 1, ?, ?)`,
    [SALES_WS_ID, now, now],
  );

  const route = (await import('../../src/app/api/tasks/route')) as RouteModule;
  POST = route.POST;
});

test.after(() => {
  try {
    if (typeof closeDb === 'function') closeDb();
  } catch {
    /* best-effort */
  }
  try {
    fs.rmSync(path.dirname(TMP_DB), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// ── A. chat id + explicit channel → both stamped verbatim ────────────────────
test('UI create with requester_chat_id + requester_channel stamps BOTH on the task', async () => {
  const res = await callCreate({ requester_chat_id: '111222333', requester_channel: 'telegram' });
  const bodyText = await res.clone().text();
  assert.equal(res.status, 201, `expected 201, got ${res.status}. Body: ${bodyText}`);
  const body = (await res.json()) as { id: string };
  const cols = requesterCols(body.id);
  assert.equal(cols.requester_chat_id, '111222333', 'requester_chat_id must persist verbatim');
  assert.equal(cols.requester_channel, 'telegram', 'requester_channel must persist verbatim');
});

// ── B. chat id, NO channel → channel DEFAULTS to 'telegram' ──────────────────
test('UI create with requester_chat_id and NO channel defaults requester_channel to telegram', async () => {
  const res = await callCreate({ requester_chat_id: '444555666' });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { id: string };
  const cols = requesterCols(body.id);
  assert.equal(cols.requester_chat_id, '444555666');
  assert.equal(cols.requester_channel, 'telegram', 'a chat id with no explicit channel must default to telegram');
});

// ── C. no chat id → both NULL (operator-created, never client-facing) ───────
test('UI create with NO requester_chat_id leaves both columns NULL, and the row is invisible to the trust-engine candidate query', async () => {
  const res = await callCreate();
  assert.equal(res.status, 201);
  const body = (await res.json()) as { id: string };
  const cols = requesterCols(body.id);
  assert.equal(cols.requester_chat_id, null, 'no chat id => requester_chat_id NULL');
  assert.equal(cols.requester_channel, null, 'no chat id => requester_channel NULL');

  // Acceptance (c): a producer/operator-created task must never be planned
  // for a client-facing send. The trust engine's own loadCandidateTasks()
  // WHERE clause requires requester_chat_id IS NOT NULL — assert this row
  // structurally cannot be selected by it.
  const { loadCandidateTasks } = (await import('../../src/lib/jobs/trust-engine')) as typeof import('../../src/lib/jobs/trust-engine');
  const candidates = loadCandidateTasks(body.id);
  assert.equal(candidates.length, 0, 'a null-requester task must never be a trust-engine send candidate');
});

// ── D. whitespace-only chat id → trimmed to empty → both NULL ────────────────
test('UI create with a whitespace-only requester_chat_id is trimmed away to NULL', async () => {
  const res = await callCreate({ requester_chat_id: '   ', requester_channel: 'telegram' });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { id: string };
  const cols = requesterCols(body.id);
  assert.equal(cols.requester_chat_id, null, 'a whitespace-only chat id must trim to NULL');
  assert.equal(cols.requester_channel, null, 'with no real chat id the channel must NOT be stamped');
});
