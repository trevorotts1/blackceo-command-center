/**
 * FIX — POST /api/tasks must not create a task already in `done`.
 *
 * Reproduced 2026-10-19: POST /api/tasks accepted status="done" with no
 * registered deliverable, while PATCH in_progress→done and review→done
 * correctly refused with the completion-evidence error. A card could be
 * CREATED already-done with no proof.
 *
 * Same invariant as FIX 25 (review) and T0-01/T0-42 (PATCH done), but the
 * create path never reaches transition() — it INSERTs the raw status — so it
 * must enforce the invariant itself.
 *
 * RED before fix: the unevidenced creates return 201 and rows persist as
 * 'done'/'review'. GREEN after: 403 with the shared noEvidenceMessage hint,
 * no row created.
 *
 * Driven through the REAL POST handler against an isolated temp DB. No network.
 */
import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

const RUN_ID = Math.random().toString(36).slice(2, 10);
const WS_ID = `ws-create-done-${RUN_ID}`;
const TITLE_PREFIX = `Create-done gate ${RUN_ID}`;
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-create-done-'));
process.env.OPENCLAW_ROOT = '/nonexistent/openclaw-root-for-tests';
delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.GEMINI_API_KEY;

type DbModule = typeof import('../../src/lib/db');
type RouteModule = typeof import('../../src/app/api/tasks/route');
let db: DbModule;
let POST: RouteModule['POST'];

function callCreate(overrides: Record<string, unknown> = {}): Promise<Response> {
  const payload = {
    title: `${TITLE_PREFIX} ${Math.random().toString(36).slice(2, 8)}`,
    workspace_id: WS_ID,
    ...overrides,
  };
  const req = new NextRequest('http://localhost/api/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return POST(req) as unknown as Promise<Response>;
}

function countCreated(): number {
  const r = db.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM tasks WHERE title LIKE ?', [`${TITLE_PREFIX}%`]);
  return r?.n ?? 0;
}

test.before(async () => {
  db = (await import('../../src/lib/db')) as DbModule;
  db.getDb(); // full migration chain against the isolated temp DB
  const now = new Date().toISOString();
  db.run(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES ('default', 'Default', 'default', '{}', ?, ?)`,
    [now, now],
  );
  db.run(
    `INSERT OR IGNORE INTO workspaces (id, slug, name, icon, company_id, sort_order, created_at, updated_at)
     VALUES (?, ?, 'Gate WS', 'G', 'default', 1, ?, ?)`,
    [WS_ID, WS_ID, now, now],
  );
  POST = ((await import('../../src/app/api/tasks/route')) as RouteModule).POST;
});

test.after(() => {
  try {
    db.run('DELETE FROM events WHERE task_id IN (SELECT id FROM tasks WHERE title LIKE ?)', [`${TITLE_PREFIX}%`]);
    db.run('DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE title LIKE ?)', [`${TITLE_PREFIX}%`]);
    db.run('DELETE FROM tasks WHERE title LIKE ?', [`${TITLE_PREFIX}%`]);
    db.run('DELETE FROM workspaces WHERE id = ?', [WS_ID]);
  } catch {
    /* best-effort */
  }
  try {
    if (typeof db.closeDb === 'function') db.closeDb();
  } catch {
    /* best-effort */
  }
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

test('POST /api/tasks REFUSES status=done with no registered deliverable (no row created)', async () => {
  const before = countCreated();
  const res = await callCreate({ status: 'done' });
  const body = (await res.json()) as { error?: string; hint?: string };
  assert.equal(res.status, 403, `expected 403, got ${res.status}: ${JSON.stringify(body)}`);
  assert.match(String(body.error), /completion evidence/i);
  assert.ok(String(body.hint).includes(`/api/tasks/`), 'refusal hint must name the deliverables endpoint');
  assert.equal(countCreated(), before, 'a refused create must not persist a task row');
});

test('POST /api/tasks REFUSES status=review with no registered deliverable (same invariant as PATCH review)', async () => {
  const before = countCreated();
  const res = await callCreate({ status: 'review' });
  assert.equal(res.status, 403);
  assert.equal(countCreated(), before);
});

test('POST /api/tasks still allows a normal non-terminal create (control)', async () => {
  const res = await callCreate({ status: 'backlog' });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { id: string; status: string };
  assert.equal(body.status, 'backlog');
});
