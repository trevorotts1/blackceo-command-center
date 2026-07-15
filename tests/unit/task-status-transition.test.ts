/**
 * Unit tests for the Skill-6 status-transition CONSUMER route:
 *   POST /api/tasks/[id]/status   (src/app/api/tasks/[id]/status/route.ts)
 *
 * Exercises the exact matrix the task requires:
 *   1. valid signed request                      → 200 (+ task mutated, audit rows written)
 *   2. bad signature (valid bearer, wrong HMAC)  → 401 (no mutation)
 *   3. bad token (wrong bearer, valid HMAC)      → 401 (no mutation)
 *   4. unknown id (valid auth, valid status)     → 404
 *   5. invalid status value (valid auth)         → 400
 *   6. status=done (valid auth, Skill-6 card)     → 403, always forbidden
 *   7. status=blocked, Skill-6-marked card        → 200 (human-escalation, P2-3 follow-up)
 *   8. unmarked card (no Skill-6 source marker)   → 403, non-Skill-6 scope rejection
 *   9. status=blocked on an unmarked card         → 403, scope gates blocked too
 *
 * The fixture card's description carries the Skill-6 source marker
 * ("Source: funnel") so it exercises the intended in-scope transitions;
 * cases 8-9 seed a second, unmarked card to prove the scope check still
 * 403s cards the Skill-6 producer didn't create — including for 'blocked'.
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`).
 *
 * Strategy mirrors task-ingest-dedup.test.ts: point DATABASE_PATH at a throwaway
 * temp file and configure MC_API_TOKEN + WEBHOOK_SECRET BEFORE `@/lib/db` and the
 * route module are loaded (dynamic import in test.before), run the full migration
 * chain against the isolated DB, seed one task, then drive the real POST handler.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';

// ── Isolated DB + auth secrets (set BEFORE @/lib/db / route are imported) ─────
const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-status-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;

const MC_API_TOKEN = 'test-mc-token-abc123';
const WEBHOOK_SECRET = 'test-webhook-secret-xyz789';
process.env.MC_API_TOKEN = MC_API_TOKEN;
process.env.WEBHOOK_SECRET = WEBHOOK_SECRET;

const RUN_ID = Math.random().toString(36).slice(2, 10);
const TASK_ID = `task-status-${RUN_ID}`;
const UNMARKED_TASK_ID = `task-status-unmarked-${RUN_ID}`;
const WS_ID = `ws-status-${RUN_ID}`;

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let closeDb: DbModule['closeDb'];

type RouteModule = typeof import('../../src/app/api/tasks/[id]/status/route');
let POST: RouteModule['POST'];

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Correct HMAC-SHA256 hex signature over the exact raw body bytes. */
function sign(rawBody: string): string {
  return createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
}

function buildRequest(
  id: string,
  rawBody: string,
  opts: { authorization?: string; signature?: string },
): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.authorization !== undefined) headers['authorization'] = opts.authorization;
  if (opts.signature !== undefined) headers['x-webhook-signature'] = opts.signature;
  return new NextRequest(`http://localhost/api/tasks/${id}/status`, {
    method: 'POST',
    headers,
    body: rawBody,
  });
}

/** Invoke the real POST handler with the App-Router `params` promise shape. */
function callRoute(
  id: string,
  rawBody: string,
  opts: { authorization?: string; signature?: string },
): Promise<Response> {
  return POST(buildRequest(id, rawBody, opts), {
    params: Promise.resolve({ id }),
  }) as unknown as Promise<Response>;
}

function currentStatus(id: string): string | undefined {
  return queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [id])?.status;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

test.before(async () => {
  const db = (await import('../../src/lib/db')) as DbModule;
  run = db.run;
  queryOne = db.queryOne;
  closeDb = db.closeDb;
  db.getDb(); // runs the full migration chain against the temp DB

  const now = new Date().toISOString();

  // FK parents: company → workspace.
  run(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES ('default', 'Default', 'default', '{}', ?, ?)`,
    [now, now],
  );
  run(
    `INSERT OR IGNORE INTO workspaces (id, slug, name, icon, company_id, sort_order, created_at, updated_at)
     VALUES (?, ?, 'Status Test', '🧪', 'default', 1, ?, ?)`,
    [WS_ID, `status-test-${RUN_ID}`, now, now],
  );

  // The one card under test, starting in backlog. Description carries the
  // Skill-6 source marker ("Source: funnel") that /api/tasks/ingest writes
  // for cc_board.py ingest_task() cards — this route only acts on cards
  // that carry it, so the fixture must too.
  run(
    `INSERT INTO tasks (id, title, description, status, priority, workspace_id, business_id, created_at, updated_at)
     VALUES (?, 'Skill6 funnel build card', 'Initial brief.\n\nSource: funnel', 'backlog', 'high', ?, 'default', ?, ?)`,
    [TASK_ID, WS_ID, now, now],
  );

  // A second card with NO Skill-6 source marker, to prove the scope check
  // still 403s cards the Skill-6 producer didn't create.
  run(
    `INSERT INTO tasks (id, title, description, status, priority, workspace_id, business_id, created_at, updated_at)
     VALUES (?, 'Unmarked board card', 'Initial brief.', 'backlog', 'high', ?, 'default', ?, ?)`,
    [UNMARKED_TASK_ID, WS_ID, now, now],
  );

  const route = (await import('../../src/app/api/tasks/[id]/status/route')) as RouteModule;
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

// ── 1. valid signed request → 200 (+ mutation + audit rows) ──────────────────
test('valid signed request → 200, task moved + note appended + audit rows written', async () => {
  const rawBody = JSON.stringify({ status: 'in_progress', note: 'Kicking off the funnel build.' });
  const res = await callRoute(TASK_ID, rawBody, {
    authorization: `Bearer ${MC_API_TOKEN}`,
    signature: sign(rawBody),
  });

  assert.equal(res.status, 200, 'valid signed request must return 200');
  const body = (await res.json()) as { id: string; status: string; description: string };
  assert.equal(body.id, TASK_ID, 'response must be the updated task');
  assert.equal(body.status, 'in_progress', 'status must be updated to in_progress');
  assert.match(body.description, /Kicking off the funnel build\./, 'note must be appended to description');

  // DB side effects.
  assert.equal(currentStatus(TASK_ID), 'in_progress', 'DB row status must be persisted');

  const evt = queryOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'task_status_changed'",
    [TASK_ID],
  );
  assert.ok((evt?.n ?? 0) >= 1, 'a task_status_changed event must be written');

  const hist = queryOne<{ status_from: string; status_to: string }>(
    'SELECT status_from, status_to FROM task_history WHERE task_id = ? ORDER BY changed_at DESC LIMIT 1',
    [TASK_ID],
  );
  assert.equal(hist?.status_from, 'backlog', 'task_history must record the previous status');
  assert.equal(hist?.status_to, 'in_progress', 'task_history must record the new status');
});

// ── 2. bad signature → 401 (no mutation) ─────────────────────────────────────
test('bad signature (valid bearer, wrong HMAC) → 401 and no mutation', async () => {
  const before = currentStatus(TASK_ID); // 'in_progress' from test 1
  const rawBody = JSON.stringify({ status: 'review' });
  const res = await callRoute(TASK_ID, rawBody, {
    authorization: `Bearer ${MC_API_TOKEN}`,
    signature: 'deadbeef'.repeat(8), // 64 hex chars, wrong value
  });

  assert.equal(res.status, 401, 'bad signature must return 401');
  assert.equal(currentStatus(TASK_ID), before, 'status must NOT change on a bad signature');
});

// ── 3. bad token → 401 (no mutation) ─────────────────────────────────────────
test('bad token (wrong bearer, valid HMAC) → 401 and no mutation', async () => {
  const before = currentStatus(TASK_ID);
  const rawBody = JSON.stringify({ status: 'review' });
  const res = await callRoute(TASK_ID, rawBody, {
    authorization: 'Bearer not-the-real-token',
    signature: sign(rawBody), // signature is CORRECT — proves the token is what's rejected
  });

  assert.equal(res.status, 401, 'bad bearer token must return 401');
  assert.equal(currentStatus(TASK_ID), before, 'status must NOT change on a bad token');
});

// ── 4. unknown id → 404 ──────────────────────────────────────────────────────
test('unknown id (valid auth + valid status) → 404', async () => {
  const rawBody = JSON.stringify({ status: 'in_progress' });
  const res = await callRoute(`missing-${RUN_ID}`, rawBody, {
    authorization: `Bearer ${MC_API_TOKEN}`,
    signature: sign(rawBody),
  });

  assert.equal(res.status, 404, 'unknown task id must return 404');
});

// ── 5. invalid status value → 400 ────────────────────────────────────────────
test('invalid status value (valid auth) → 400', async () => {
  const rawBody = JSON.stringify({ status: 'not_a_real_status' });
  const res = await callRoute(TASK_ID, rawBody, {
    authorization: `Bearer ${MC_API_TOKEN}`,
    signature: sign(rawBody),
  });

  assert.equal(res.status, 400, 'an out-of-enum status must return 400');
  // The card must remain untouched by the rejected request.
  assert.equal(currentStatus(TASK_ID), 'in_progress', 'status must NOT change on a 400');
});

// ── 6. status=done → 403, always forbidden (P2-3 follow-up) ─────────────────
test('status=done (valid auth, Skill-6-marked card) → 403 and no mutation', async () => {
  const before = currentStatus(TASK_ID); // 'in_progress' from test 1
  const rawBody = JSON.stringify({ status: 'done' });
  const res = await callRoute(TASK_ID, rawBody, {
    authorization: `Bearer ${MC_API_TOKEN}`,
    signature: sign(rawBody),
  });

  assert.equal(res.status, 403, "status='done' must always return 403");
  const body = (await res.json()) as { error: string; hint: string };
  assert.match(body.hint, /QC auto-scorer/, 'hint must explain done is QC/master-agent gated');
  assert.doesNotMatch(
    body.hint,
    /blocked_reason/,
    "the done hint must not reference blocked's old human-context fields",
  );
  assert.equal(currentStatus(TASK_ID), before, 'status must NOT change when done is rejected');
});

// ── 7. status=blocked on a Skill-6-marked card → 200 (P2-3 follow-up) ───────
// The Skill-6 producer (cc_board.py BuildPhaseDriver.fail(human_required=True))
// legitimately escalates its own cards to 'blocked' for human sign-off; this
// is allowed for marked cards only, gated by the same hasSkill6Marker check
// as every other status.
test('status=blocked on a Skill-6-marked card → 200, task moved + audit rows written', async () => {
  const rawBody = JSON.stringify({ status: 'blocked', note: 'Build failed — needs human sign-off.' });
  const res = await callRoute(TASK_ID, rawBody, {
    authorization: `Bearer ${MC_API_TOKEN}`,
    signature: sign(rawBody),
  });

  assert.equal(res.status, 200, 'blocked on a Skill-6-marked card must return 200');
  const body = (await res.json()) as { id: string; status: string; description: string };
  assert.equal(body.id, TASK_ID, 'response must be the updated task');
  assert.equal(body.status, 'blocked', 'status must be updated to blocked');
  assert.match(body.description, /needs human sign-off/, 'note must be appended to description');

  assert.equal(currentStatus(TASK_ID), 'blocked', 'DB row status must be persisted as blocked');

  const evt = queryOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'task_status_changed'",
    [TASK_ID],
  );
  assert.ok((evt?.n ?? 0) >= 1, 'a task_status_changed event must be written for the blocked transition');

  const hist = queryOne<{ status_from: string; status_to: string }>(
    'SELECT status_from, status_to FROM task_history WHERE task_id = ? ORDER BY changed_at DESC LIMIT 1',
    [TASK_ID],
  );
  assert.equal(hist?.status_from, 'in_progress', 'task_history must record the previous status');
  assert.equal(hist?.status_to, 'blocked', 'task_history must record the new status');
});

// ── 8. non-Skill-6 (unmarked) card → 403, regardless of status ──────────────
test('unmarked card (no Skill-6 source marker) → 403 and no mutation', async () => {
  const before = currentStatus(UNMARKED_TASK_ID);
  const rawBody = JSON.stringify({ status: 'in_progress' });
  const res = await callRoute(UNMARKED_TASK_ID, rawBody, {
    authorization: `Bearer ${MC_API_TOKEN}`,
    signature: sign(rawBody),
  });

  assert.equal(res.status, 403, 'a card without the Skill-6 source marker must return 403');
  const body = (await res.json()) as { error: string; hint: string };
  assert.match(body.error, /not a signed board-producer card/, 'error must explain the scope rejection');
  assert.equal(currentStatus(UNMARKED_TASK_ID), before, 'status must NOT change on a non-Skill-6 card');
});

// ── 9. status=blocked on an unmarked card → 403 (scope gates blocked too) ───
test('status=blocked on an unmarked card → 403 and no mutation', async () => {
  const before = currentStatus(UNMARKED_TASK_ID);
  const rawBody = JSON.stringify({ status: 'blocked' });
  const res = await callRoute(UNMARKED_TASK_ID, rawBody, {
    authorization: `Bearer ${MC_API_TOKEN}`,
    signature: sign(rawBody),
  });

  assert.equal(res.status, 403, 'blocked on an unmarked card must still 403 — scope gates it');
  assert.equal(currentStatus(UNMARKED_TASK_ID), before, 'status must NOT change on a non-Skill-6 card');
});
