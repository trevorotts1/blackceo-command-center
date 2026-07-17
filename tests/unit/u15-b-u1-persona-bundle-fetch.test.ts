/**
 * Unit tests for the persona-bundle READ endpoint:
 *   GET /api/tasks/[id]/persona-bundle   (src/app/api/tasks/[id]/persona-bundle/route.ts)
 *
 * Master id U15, crosswalk B/B-U1 ("Bundle-acquisition ladder in
 * v2_dispatcher — threaded -> CC fetch -> local --blend -> absent; receipt
 * always"). This is the "CC endpoint" half named in the E.2 table row for
 * U15 (`ONB (+CC endpoint)`): rung 2 (fetch) of the acquisition ladder, so a
 * standalone/offline-dispatched build fetches the SAME blend bundle the
 * Command Center already resolved for a task, instead of never consuming a
 * blend or re-selecting a second time.
 *
 * Exercises:
 *   1. task with a persisted bundle, valid bearer -> 200, bundle/confirm_state/
 *      catalog_version match the DB row exactly.
 *   2. task with NO bundle row, valid bearer      -> 200, bundle: null (not
 *      an error — a real, expected pre-resolution state).
 *   3. missing Authorization header (token set)    -> 401, no data leaked.
 *   4. wrong bearer token                          -> 401, no data leaked.
 *   5. unknown task id (valid auth)                -> 404.
 *   6. corrupt bundle_json in the DB               -> 500 (fail loud, never
 *      hand back a bundle the caller can't trust).
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`).
 * Strategy mirrors task-status-transition.test.ts: isolated temp DB,
 * MC_API_TOKEN configured BEFORE `@/lib/db` and the route module are
 * imported, full migration chain (incl. 090 task_persona_bundle) run against
 * the temp DB, fixtures seeded, then the real GET handler driven directly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

// ── Isolated DB + auth secret (set BEFORE @/lib/db / route are imported) ────
const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-persona-bundle-fetch-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;

const MC_API_TOKEN = 'test-mc-token-persona-bundle-9f2c';
process.env.MC_API_TOKEN = MC_API_TOKEN;
// Deliberately WEBHOOK_SECRET-configured too, to prove this route does NOT
// require an x-webhook-signature header the way /status does — the real
// caller (cc_board.py fetch_persona_bundle) never sends one.
process.env.WEBHOOK_SECRET = 'test-webhook-secret-should-be-irrelevant-here';

const RUN_ID = Math.random().toString(36).slice(2, 10);
const TASK_WITH_BUNDLE = `task-pb-${RUN_ID}`;
const TASK_NO_BUNDLE = `task-pb-nobundle-${RUN_ID}`;
const TASK_CORRUPT_BUNDLE = `task-pb-corrupt-${RUN_ID}`;
const WS_ID = `ws-pb-${RUN_ID}`;

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let closeDb: DbModule['closeDb'];

type RouteModule = typeof import('../../src/app/api/tasks/[id]/persona-bundle/route');
let GET: RouteModule['GET'];

const SAMPLE_BUNDLE = {
  topic: 'landing page for a coaching offer',
  confirm_required: false,
  voice: {
    collapsed: true,
    collapsed_persona_id: 'hormozi-100m-offers',
    audience_persona: { id: 'hormozi-100m-offers', name: 'Alex Hormozi' },
    topic_persona: { id: 'hormozi-100m-offers', name: 'Alex Hormozi' },
  },
  blend_directive:
    'Write in the voice of Alex Hormozi... (style-inspired, not impersonation).',
  task_personas: [{ persona_id: 'hormozi-100m-offers', role: 'voice' }],
  rationale: { matched_on: 'icp+topic' },
  catalog_version: '1.4',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildRequest(id: string, authorization?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (authorization !== undefined) headers['authorization'] = authorization;
  return new NextRequest(`http://localhost/api/tasks/${id}/persona-bundle`, {
    method: 'GET',
    headers,
  });
}

function callRoute(id: string, authorization?: string): Promise<Response> {
  return GET(buildRequest(id, authorization), {
    params: Promise.resolve({ id }),
  }) as unknown as Promise<Response>;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

test.before(async () => {
  const db = (await import('../../src/lib/db')) as DbModule;
  run = db.run;
  queryOne = db.queryOne;
  closeDb = db.closeDb;
  db.getDb(); // runs the full migration chain against the temp DB (incl. 090)

  const now = new Date().toISOString();

  run(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES ('default', 'Default', 'default', '{}', ?, ?)`,
    [now, now],
  );
  run(
    `INSERT OR IGNORE INTO workspaces (id, slug, name, icon, company_id, sort_order, created_at, updated_at)
     VALUES (?, ?, 'Persona Bundle Test', '🧪', 'default', 1, ?, ?)`,
    [WS_ID, `pb-test-${RUN_ID}`, now, now],
  );

  // Task WITH a persisted bundle row.
  run(
    `INSERT INTO tasks (id, title, description, status, priority, workspace_id, business_id, created_at, updated_at)
     VALUES (?, 'Funnel build with resolved blend', 'Initial brief.', 'backlog', 'high', ?, 'default', ?, ?)`,
    [TASK_WITH_BUNDLE, WS_ID, now, now],
  );
  run(
    `INSERT INTO task_persona_bundle (task_id, bundle_json, catalog_version, confirm_state, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [TASK_WITH_BUNDLE, JSON.stringify(SAMPLE_BUNDLE), '1.4', 'not_required', now],
  );

  // Task with NO bundle row (never went through resolvePersonaAndPin).
  run(
    `INSERT INTO tasks (id, title, description, status, priority, workspace_id, business_id, created_at, updated_at)
     VALUES (?, 'Non-content task, no persona blend', 'Restart the app server.', 'backlog', 'medium', ?, 'default', ?, ?)`,
    [TASK_NO_BUNDLE, WS_ID, now, now],
  );

  // Task with a CORRUPT bundle_json (proves fail-loud, never hands back
  // untrustworthy data).
  run(
    `INSERT INTO tasks (id, title, description, status, priority, workspace_id, business_id, created_at, updated_at)
     VALUES (?, 'Corrupt bundle fixture', 'n/a', 'backlog', 'low', ?, 'default', ?, ?)`,
    [TASK_CORRUPT_BUNDLE, WS_ID, now, now],
  );
  run(
    `INSERT INTO task_persona_bundle (task_id, bundle_json, catalog_version, confirm_state, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [TASK_CORRUPT_BUNDLE, '{not valid json', null, 'pending', now],
  );

  const route = (await import('../../src/app/api/tasks/[id]/persona-bundle/route')) as RouteModule;
  GET = route.GET;
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

// ── 1. task with a bundle, valid bearer -> 200, exact bundle/state/version ──
test('[U15/B-U1] task with a persisted bundle + valid bearer -> 200 with the exact bundle, confirm_state, catalog_version', async () => {
  const res = await callRoute(TASK_WITH_BUNDLE, `Bearer ${MC_API_TOKEN}`);
  assert.equal(res.status, 200, 'a task carrying a bundle row must return 200');

  const body = (await res.json()) as {
    task_id: string;
    bundle: typeof SAMPLE_BUNDLE;
    confirm_state: string;
    catalog_version: string;
  };
  assert.equal(body.task_id, TASK_WITH_BUNDLE);
  assert.deepEqual(body.bundle, SAMPLE_BUNDLE, 'bundle must round-trip byte-identical to what was persisted');
  assert.equal(body.confirm_state, 'not_required');
  assert.equal(body.catalog_version, '1.4');
});

// ── 2. task with no bundle row, valid bearer -> 200, bundle: null ───────────
test('[U15/B-U1] task with NO bundle row + valid bearer -> 200 with bundle: null (not an error)', async () => {
  const res = await callRoute(TASK_NO_BUNDLE, `Bearer ${MC_API_TOKEN}`);
  assert.equal(res.status, 200, 'an unresolved task must still 200 — absence is a real state, not a failure');

  const body = (await res.json()) as { task_id: string; bundle: null; confirm_state: null };
  assert.equal(body.task_id, TASK_NO_BUNDLE);
  assert.equal(body.bundle, null);
  assert.equal(body.confirm_state, null);
});

// ── 3. missing Authorization header -> 401, no data leaked ──────────────────
test('[U15/B-U1] missing Authorization header (MC_API_TOKEN set) -> 401, no bundle data leaked', async () => {
  const res = await callRoute(TASK_WITH_BUNDLE, undefined);
  assert.equal(res.status, 401, 'a request with no Authorization header must be rejected');
  const body = (await res.json()) as { error: string; bundle?: unknown };
  assert.equal(body.error, 'Unauthorized');
  assert.equal(body.bundle, undefined, 'the 401 body must never carry bundle data');
});

// ── 4. wrong bearer token -> 401, no data leaked ─────────────────────────────
test('[U15/B-U1] wrong bearer token -> 401, no bundle data leaked', async () => {
  const res = await callRoute(TASK_WITH_BUNDLE, 'Bearer not-the-real-token');
  assert.equal(res.status, 401, 'a wrong bearer token must be rejected');
  const body = (await res.json()) as { error: string; bundle?: unknown };
  assert.equal(body.error, 'Unauthorized');
  assert.equal(body.bundle, undefined, 'the 401 body must never carry bundle data');
});

// ── 5. unknown task id (valid auth) -> 404 ───────────────────────────────────
test('[U15/B-U1] unknown task id (valid auth) -> 404', async () => {
  const res = await callRoute(`missing-${RUN_ID}`, `Bearer ${MC_API_TOKEN}`);
  assert.equal(res.status, 404, 'an unknown task id must return 404');
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, 'Task not found');
});

// ── 6. corrupt bundle_json -> 500, fail loud ─────────────────────────────────
test('[U15/B-U1] corrupt bundle_json in the DB -> 500, never hands back untrustworthy data', async () => {
  const res = await callRoute(TASK_CORRUPT_BUNDLE, `Bearer ${MC_API_TOKEN}`);
  assert.equal(res.status, 500, 'a task whose stored bundle_json fails to parse must fail loud, not silently 200');
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /malformed/i);
});
