/**
 * FIX 52 + FIX 57 (MASTER Part 8) — /api/tasks/ingest presentation identity.
 *
 * FIX 52 ([R5A §H5]): a child ingested with `phase_id: 'P4-COPY'` (or its
 * cc_board.py canonical alias `stage`) persists it into `tasks.stage_slug`
 * and shows the client-facing label Script via /api/presentations/children
 * REGARDLESS of the child's title. `slide_count` rides the same door
 * (migration 130).
 *
 * FIX 57 ([R5B §E.4, §F10]): a per-phase child card whose Session (run
 * identity) disagrees with its parent deck's Ref line is HELD at the door —
 * 409, detail 'deck_run_identity_mismatch', the card NOT created, ONE deduped
 * event stamped on the parent. Legacy pairings and absent identities pass:
 * the hold fires only on a fact the request itself carries.
 *
 * Strategy mirrors wi15b-parent-task-id-ingest.test.ts: isolated temp DB,
 * signed WEBHOOK_SECRET set BEFORE any project import, full migration chain,
 * COMPANY_SLUG pins the active company, and the REAL route handlers are
 * driven end-to-end (ingest POST + children GET). No network.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';

// ── Isolated DB + auth secret + pinned active company (BEFORE any project import) ──
const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-fix52-57-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;

const WEBHOOK_SECRET = 'test-webhook-secret-fix52-57';
process.env.WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
process.env.OPENCLAW_ROOT = '/nonexistent/openclaw-root-for-tests';
process.env.COMPANY_SLUG = 'company-a';

const RUN_ID = Math.random().toString(36).slice(2, 10);
const COMPANY_A_ID = `company-a-${RUN_ID}`;
const WS_A_SLUG = `pres-a-${RUN_ID}`;
const WS_A_ID = `ws-${WS_A_SLUG}`;

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let closeDb: DbModule['closeDb'];

type RouteModule = typeof import('../../src/app/api/tasks/ingest/route');
let POST: RouteModule['POST'];

type ChildrenRouteModule = typeof import('../../src/app/api/presentations/children/route');
let childrenGET: ChildrenRouteModule['GET'];

// ── Helpers ──────────────────────────────────────────────────────────────────

function sign(rawBody: string): string {
  return createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
}

function callIngest(payload: Record<string, unknown>): Promise<Response> {
  const rawBody = JSON.stringify(payload);
  const req = new NextRequest('http://localhost/api/tasks/ingest', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-webhook-signature': sign(rawBody),
    },
    body: rawBody,
  });
  return POST(req) as unknown as Promise<Response>;
}

function callChildren(parentId: string): Promise<Response> {
  const req = new NextRequest(
    `http://localhost/api/presentations/children?parent_id=${encodeURIComponent(parentId)}`,
  );
  return childrenGET(req) as unknown as Promise<Response>;
}

/** Seed a deck parent whose `Ref:` provenance line names `runRef` (or omits it). */
function insertParentTask(id: string, runRef: string | null): void {
  const now = new Date().toISOString();
  const provenance = ['Source: build_deck', runRef ? `Ref: ${runRef}` : null]
    .filter(Boolean)
    .join('\n');
  run(
    `INSERT INTO tasks (id, title, description, status, priority, workspace_id, business_id, department, source, created_at, updated_at)
     VALUES (?, ?, ?, 'in_progress', 'medium', ?, 'default', 'presentations', 'build_deck', ?, ?)`,
    [
      id,
      `Deck run [${RUN_ID}] ${id}`,
      `Deck build.\n\n— Captured via task-ingest —\n${provenance}`,
      WS_A_ID,
      now,
      now,
    ],
  );
}

function mismatchEventsFor(parentId: string): Array<{ message: string }> {
  return (
    queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM events', [parentId]) && []
  ) as unknown as Array<{ message: string }>;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

test.before(async () => {
  const db = (await import('../../src/lib/db')) as DbModule;
  run = db.run;
  queryOne = db.queryOne;
  closeDb = db.closeDb;
  db.getDb(); // full migration chain (incl. 074 stage_slug, 130 slide_count, 124 parent_task_id)

  const now = new Date().toISOString();
  run(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES (?, 'Company A', 'company-a', '{}', ?, ?)`,
    [COMPANY_A_ID, now, now],
  );
  run(
    `INSERT OR IGNORE INTO workspaces (id, slug, name, icon, company_id, sort_order, created_at, updated_at)
     VALUES (?, ?, 'Presentations A', '🖼️', ?, 1, ?, ?)`,
    [WS_A_ID, WS_A_SLUG, COMPANY_A_ID, now, now],
  );

  const route = (await import('../../src/app/api/tasks/ingest/route')) as RouteModule;
  POST = route.POST;
  const childrenRoute = (await import(
    '../../src/app/api/presentations/children/route'
  )) as ChildrenRouteModule;
  childrenGET = childrenRoute.GET;
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

// ── FIX 52 A: phase_id → stage_slug → label Script regardless of title ──────
test('FIX 52: child ingested with phase_id P4-COPY and an arbitrary title stores stage_slug and labels Script via the children route', async () => {
  const parentId = `p52a-${RUN_ID}`;
  insertParentTask(parentId, `run-A-${RUN_ID}`);

  const res = await callIngest({
    title: `TOTALLY UNRELATED TITLE [${RUN_ID}]`,
    department_slug: WS_A_SLUG,
    source: 'build_deck_phase',
    source_ref: `${parentId}:P4-COPY`,
    external_session_id: `run-A-${RUN_ID}`, // matches parent Ref → passes FIX 57
    parent_task_id: parentId,
    stage: 'P4-COPY',
    slide_count: 22,
    idempotency_key: `fix52a-${RUN_ID}`,
  });
  const bodyText = await res.text();
  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${bodyText}`);
  const body = JSON.parse(bodyText) as { task_id: string };

  const row = queryOne<{ stage_slug: string | null; slide_count: number | null }>(
    'SELECT stage_slug, slide_count FROM tasks WHERE id = ?',
    [body.task_id],
  );
  assert.ok(row, 'child card must exist');
  assert.equal(row!.stage_slug, 'P4-COPY', 'phase_id (stage key) must persist into tasks.stage_slug');
  assert.equal(row!.slide_count, 22, 'slide_count must persist onto the card');

  // End-to-end: the real children route must label the child Script.
  const childrenRes = await callChildren(parentId);
  assert.equal(childrenRes.status, 200);
  const childrenBody = (await childrenRes.json()) as {
    children: Array<{ id: string; stage_slug: string | null; phase_label: string | null }>;
    aggregate: { current_phase: string };
  };
  const child = childrenBody.children.find((c) => c.id === body.task_id);
  assert.ok(child, 'children route must return the phase_id child');
  assert.equal(child!.stage_slug, 'P4-COPY');
  assert.equal(child!.phase_label, 'Script', 'P4-COPY must resolve to Script from stage_slug, never the title');
  assert.equal(childrenBody.aggregate.current_phase, 'Script');
});

// ── FIX 52 B: phase_id alias accepted too ─────────────────────────────────────
test('FIX 52: phase_id is accepted as the alias key and persists identically', async () => {
  const parentId = `p52b-${RUN_ID}`;
  insertParentTask(parentId, `run-A-${RUN_ID}`);

  const res = await callIngest({
    title: `Alias child [${RUN_ID}]`,
    department_slug: WS_A_SLUG,
    source: 'build_deck_phase',
    external_session_id: `run-A-${RUN_ID}`,
    parent_task_id: parentId,
    phase_id: 'P4-RENDER',
    idempotency_key: `fix52b-${RUN_ID}`,
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { task_id: string };
  const row = queryOne<{ stage_slug: string | null }>(
    'SELECT stage_slug FROM tasks WHERE id = ?',
    [body.task_id],
  );
  assert.equal(row!.stage_slug, 'P4-RENDER');
});

// ── FIX 52 C: malformed phase_id / slide_count are dropped, never a 400 ──────
test('FIX 52: malformed phase_id and slide_count are dropped without rejecting the capture', async () => {
  const parentId = `p52c-${RUN_ID}`;
  insertParentTask(parentId, `run-A-${RUN_ID}`);

  const res = await callIngest({
    title: `Malformed decorations [${RUN_ID}]`,
    department_slug: WS_A_SLUG,
    source: 'build_deck_phase',
    external_session_id: `run-A-${RUN_ID}`,
    parent_task_id: parentId,
    phase_id: 42,
    slide_count: 'twelve-and-a-half',
    idempotency_key: `fix52c-${RUN_ID}`,
  });
  assert.equal(res.status, 201, 'a malformed decoration must never block capture');
  const body = (await res.json()) as { task_id: string };
  const row = queryOne<{ stage_slug: string | null; slide_count: number | null }>(
    'SELECT stage_slug, slide_count FROM tasks WHERE id = ?',
    [body.task_id],
  );
  assert.equal(row!.stage_slug, null);
  assert.equal(row!.slide_count, null);
});

// ── FIX 57 A: mismatched child Session vs parent Ref → HELD 409 ──────────────
test('FIX 57: child whose Session names another run is held (409 deck_run_identity_mismatch), card NOT created, parent gets one deduped event', async () => {
  const parentId = `p57a-${RUN_ID}`;
  const parentRef = `run-ONE-${RUN_ID}`;
  insertParentTask(parentId, parentRef);

  const res = await callIngest({
    title: `Foreign-run phase [${RUN_ID}]`,
    department_slug: WS_A_SLUG,
    source: 'build_deck_phase',
    source_ref: `${parentId}:P4-COPY`,
    external_session_id: `run-TWO-${RUN_ID}`, // the second job's run id
    parent_task_id: parentId,
    stage: 'P4-COPY',
    idempotency_key: `fix57a-${RUN_ID}`,
  });
  const bodyText = await res.text();
  assert.equal(res.status, 409, `expected 409 hold, got ${res.status}: ${bodyText}`);
  // A Response body is single-consumption: parse the text we already read
  // instead of calling res.json() after res.text() (Body already read).
  const body = JSON.parse(bodyText) as { detail?: string; ok?: boolean };
  assert.equal(body.detail, 'deck_run_identity_mismatch');
  assert.equal(body.ok, false);

  // The card was NOT created under the wrong parent — that attachment IS the defect.
  const attached = queryOne<{ n: number }>(
    'SELECT COUNT(*) AS n FROM tasks WHERE parent_task_id = ?',
    [parentId],
  );
  assert.equal(attached!.n, 0, 'a mismatched child must never be attached');

  // Exactly ONE deduped event on the parent. queryOne, not run: run() returns
  // a better-sqlite3 RunResult (changes/lastInsertRowid), never the row —
  // reading .n off it is undefined.
  const evs = queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'deck_run_identity_mismatch'`,
    [parentId],
  );
  assert.equal(evs.n, 1, 'the hold must write exactly one deduped mismatch event on the parent');

  // A second identical attempt must NOT mint a second event (NOT EXISTS dedupe).
  const res2 = await callIngest({
    title: `Foreign-run phase retry [${RUN_ID}]`,
    department_slug: WS_A_SLUG,
    source: 'build_deck_phase',
    source_ref: `${parentId}:P4-COPY`,
    external_session_id: `run-TWO-${RUN_ID}`,
    parent_task_id: parentId,
    stage: 'P4-COPY',
    idempotency_key: `fix57a-retry-${RUN_ID}`,
  });
  assert.equal(res2.status, 409);
  const evs2 = queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'deck_run_identity_mismatch'`,
    [parentId],
  );
  assert.equal(evs2.n, 1, 'the mismatch event is deduped per parent');
});

// ── FIX 57 B: matching Session vs Ref passes ─────────────────────────────────
test('FIX 57: child whose Session equals the parent Ref passes and attaches', async () => {
  const parentId = `p57b-${RUN_ID}`;
  insertParentTask(parentId, `run-SAME-${RUN_ID}`);

  const res = await callIngest({
    title: `Own-run phase [${RUN_ID}]`,
    department_slug: WS_A_SLUG,
    source: 'build_deck_phase',
    external_session_id: `run-SAME-${RUN_ID}`,
    parent_task_id: parentId,
    stage: 'P2-OUTLINE',
    idempotency_key: `fix57b-${RUN_ID}`,
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { task_id: string };
  const row = queryOne<{ parent_task_id: string | null; status: string }>(
    'SELECT parent_task_id, status FROM tasks WHERE id = ?',
    [body.task_id],
  );
  assert.equal(row!.parent_task_id, parentId);
  assert.equal(row!.status, 'backlog', 'a matching child attaches and stays dispatchable');
});

// ── FIX 57 C: legacy <parent_task_id>:<phase> Session passes ─────────────────
test('FIX 57: legacy child Session of form <parent_task_id>:<phase_id> passes even though it differs from the parent Ref', async () => {
  const parentId = `p57c-${RUN_ID}`;
  insertParentTask(parentId, `run-LEGACY-${RUN_ID}`);

  const res = await callIngest({
    title: `Legacy pairing phase [${RUN_ID}]`,
    department_slug: WS_A_SLUG,
    source: 'build_deck_phase',
    external_session_id: `${parentId}:P4-COPY`,
    parent_task_id: parentId,
    stage: 'P4-COPY',
    idempotency_key: `fix57c-${RUN_ID}`,
  });
  const bodyText = await res.text();
  assert.equal(res.status, 201, `legacy pairing must pass, got ${res.status}: ${bodyText}`);
  // Single-consumption body: parse the already-read text (res.json() after
  // res.text() throws "Body already read").
  const body = JSON.parse(bodyText) as { task_id: string };
  const row = queryOne<{ parent_task_id: string | null }>(
    'SELECT parent_task_id FROM tasks WHERE id = ?',
    [body.task_id],
  );
  assert.equal(row!.parent_task_id, parentId);
});

// ── FIX 57 D: absent identities never hold ───────────────────────────────────
test('FIX 57: no child Session, or a parent with no Ref line, is undeterminable — the child passes', async () => {
  // (a) Parent HAS a Ref, child sends NO session.
  const parentIdA = `p57d-a-${RUN_ID}`;
  insertParentTask(parentIdA, `run-X-${RUN_ID}`);
  const resA = await callIngest({
    title: `No-session phase [${RUN_ID}]`,
    department_slug: WS_A_SLUG,
    source: 'build_deck_phase',
    parent_task_id: parentIdA,
    stage: 'P3-DRAFT',
    idempotency_key: `fix57d-a-${RUN_ID}`,
  });
  assert.equal(resA.status, 201, 'an absent child session is not a mismatch');

  // (b) Parent has NO Ref line; child names some session.
  const parentIdB = `p57d-b-${RUN_ID}`;
  insertParentTask(parentIdB, null);
  const resB = await callIngest({
    title: `Ref-less parent phase [${RUN_ID}]`,
    department_slug: WS_A_SLUG,
    source: 'build_deck_phase',
    external_session_id: `run-Y-${RUN_ID}`,
    parent_task_id: parentIdB,
    stage: 'P3-DRAFT',
    idempotency_key: `fix57d-b-${RUN_ID}`,
  });
  assert.equal(resB.status, 201, 'an absent parent Ref is not a mismatch (GUARD 4c owns that case at dispatch)');
});

// ── FIX 57 E: the hold only guards build_deck_phase children ────────────────
test('FIX 57: a non-build_deck_phase ingest with a mismatching session is not held', async () => {
  const parentId = `p57e-${RUN_ID}`;
  insertParentTask(parentId, `run-ONE-${RUN_ID}`);

  const res = await callIngest({
    title: `Generic subtask [${RUN_ID}]`,
    department_slug: WS_A_SLUG,
    source: 'telegram',
    external_session_id: `totally-different-session-${RUN_ID}`,
    parent_task_id: parentId,
    idempotency_key: `fix57e-${RUN_ID}`,
  });
  assert.equal(res.status, 201, 'the hold scopes to the engine per-phase child source only');
});
