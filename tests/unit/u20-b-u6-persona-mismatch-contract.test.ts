/**
 * U20 / B-U6 — Producer reports USED personas back to the card
 * (declared-vs-used, never silent).
 *
 * Verifies the unit's BINARY acceptance criteria (master spec §B-U6):
 *   (a) a fixture build posts per-page voice/topic/task ids in activity
 *       metadata, read back via the REAL POST + GET /api/tasks/:id/activities
 *       HTTP route pair (not a direct-DB shortcut) — this also proves the
 *       CreateActivitySchema fix (metadata was `z.string()`, silently
 *       rejecting every real caller's object payload with a 400; both
 *       cc_board.py and src/lib/orchestration.ts send an object).
 *   (b) a forced divergence renders exactly ONE `persona_mismatch` event +
 *       chip (task.persona_mismatch on the tasks GET).
 *   (c) agreement renders zero mismatch events across 3 repeat runs
 *       (idempotent) — and so does an IDENTICAL divergence repeated 3x.
 *
 * Uses an isolated temp DB, exactly like the U26/B-U12 producer-scorecard
 * contract test this unit sits beside.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-u20-persona-mismatch-'));
const TMP_DB = path.join(TMP_DIR, 'mission-control.test.db');
process.env.DATABASE_PATH = TMP_DB;

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let closeDb: DbModule['closeDb'];
let getDb: DbModule['getDb'];

type ActivitiesRouteModule = typeof import('../../src/app/api/tasks/[id]/activities/route');
let activitiesPOST: ActivitiesRouteModule['POST'];
let activitiesGET: ActivitiesRouteModule['GET'];

type TasksRouteModule = typeof import('../../src/app/api/tasks/route');
let tasksGET: TasksRouteModule['GET'];

type PersonaMismatchModule = typeof import('../../src/lib/persona-mismatch');
let recordPersonaUsedAndCompare: PersonaMismatchModule['recordPersonaUsedAndCompare'];
let getOpenPersonaMismatch: PersonaMismatchModule['getOpenPersonaMismatch'];
let isPersonaUsedReport: PersonaMismatchModule['isPersonaUsedReport'];

let taskCounter = 0;
function nextId(prefix: string) {
  return `${prefix}-${++taskCounter}-${Date.now()}`;
}

/** A task that already resolved a blend VOICE decision (migration 090 mirror
 * column) — the DECLARED side of the comparator. */
function insertBlendedTask(id: string, voicePersonaId: string) {
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, voice_persona_id, created_at, updated_at)
     VALUES (?, ?, 'in_progress', 'medium', NULL, NULL, ?, ?, ?)`,
    [id, `Blended Task ${id}`, voicePersonaId, now, now],
  );
}

/** A task with NO resolved voice (never blended) — must never produce a
 * fabricated mismatch. */
function insertUnblendedTask(id: string) {
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, created_at, updated_at)
     VALUES (?, ?, 'in_progress', 'medium', NULL, NULL, ?, ?)`,
    [id, `Unblended Task ${id}`, now, now],
  );
}

function countMismatchEvents(taskId: string): number {
  const row = queryOne<{ c: number }>(
    `SELECT COUNT(*) AS c FROM events WHERE type = 'persona_mismatch' AND task_id = ?`,
    [taskId],
  );
  return row?.c ?? 0;
}

test.before(async () => {
  const db = await import('../../src/lib/db');
  run = db.run;
  queryOne = db.queryOne;
  closeDb = db.closeDb;
  getDb = db.getDb;
  getDb(); // trigger full migration chain against the temp DB

  const activitiesRoute = await import('../../src/app/api/tasks/[id]/activities/route');
  activitiesPOST = activitiesRoute.POST;
  activitiesGET = activitiesRoute.GET;

  const tasksRoute = await import('../../src/app/api/tasks/route');
  tasksGET = tasksRoute.GET;

  const pm = await import('../../src/lib/persona-mismatch');
  recordPersonaUsedAndCompare = pm.recordPersonaUsedAndCompare;
  getOpenPersonaMismatch = pm.getOpenPersonaMismatch;
  isPersonaUsedReport = pm.isPersonaUsedReport;
});

test.after(() => {
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

function postActivity(taskId: string, body: Record<string, unknown>) {
  const req = new NextRequest(`http://localhost/api/tasks/${taskId}/activities`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return activitiesPOST(req, { params: { id: taskId } }) as unknown as Promise<Response>;
}

function getActivities(taskId: string) {
  const req = new NextRequest(`http://localhost/api/tasks/${taskId}/activities`);
  return activitiesGET(req, { params: { id: taskId } }) as unknown as Promise<Response>;
}

// ─── Schema fix: object metadata must be ACCEPTED, not 400'd ───────────────

test('[U20-schema] POST /activities with OBJECT metadata (the real shape every caller sends) is accepted, not 400', async () => {
  const taskId = nextId('schema-ok');
  insertBlendedTask(taskId, 'hormozi-100m-offers');

  const res = await postActivity(taskId, {
    activity_type: 'updated',
    message: 'Step 3/12: copy authored',
    metadata: { kind: 'persona_used', page: 'main', voice_persona_id: 'hormozi-100m-offers' },
  });
  assert.equal(res.status, 201, 'object metadata must be ACCEPTED (previously 400 "expected string, received object")');
  const body = await res.json();
  assert.ok(body.metadata, 'the created activity must carry the metadata back');
});

// ─── (a) fixture build posts per-page ids, read back via activities GET ────

test('[U20-a] fixture build posts per-page voice/topic/task ids in activity metadata, read back via GET /activities', async () => {
  const taskId = nextId('readback');
  insertBlendedTask(taskId, 'hormozi-100m-offers');

  const postRes = await postActivity(taskId, {
    activity_type: 'updated',
    message: 'Step 5/12: copy authored for page main',
    metadata: {
      kind: 'persona_used',
      page: 'main',
      voice_persona_id: 'hormozi-100m-offers',
      topic_persona_id: 'miller-building-storybrand',
      task_persona_id: 'hormozi-100m-offers',
      blend_directive_sha: 'abc123def456',
      goal: 'book-a-call',
    },
  });
  assert.equal(postRes.status, 201);

  const getRes = await getActivities(taskId);
  assert.equal(getRes.status, 200);
  const activities = await getRes.json();
  assert.equal(activities.length, 1);
  const md = JSON.parse(activities[0].metadata);
  assert.equal(md.voice_persona_id, 'hormozi-100m-offers');
  assert.equal(md.topic_persona_id, 'miller-building-storybrand');
  assert.equal(md.task_persona_id, 'hormozi-100m-offers');
  assert.equal(md.blend_directive_sha, 'abc123def456');
  assert.equal(md.page, 'main');
  assert.equal(md.goal, 'book-a-call');
});

// ─── isPersonaUsedReport discriminator ──────────────────────────────────────

test('[U20-discriminator] isPersonaUsedReport only matches the explicit kind marker', () => {
  assert.equal(isPersonaUsedReport({ kind: 'persona_used', voice_persona_id: 'x' }), true);
  assert.equal(isPersonaUsedReport({ qc_gate: 'qc-built-form', qc_score: 9.0 }), false);
  assert.equal(isPersonaUsedReport({ voice_persona_id: 'x' }), false); // no kind -> not sniffed
  assert.equal(isPersonaUsedReport(null), false);
  assert.equal(isPersonaUsedReport('not-an-object'), false);
});

// ─── Agreement renders nothing ──────────────────────────────────────────────

test('[U20-agreement] declared === used -> no event, no chip, across 3 repeat runs (idempotent)', () => {
  const taskId = nextId('agree');
  insertBlendedTask(taskId, 'hormozi-100m-offers');

  for (let i = 0; i < 3; i++) {
    const result = recordPersonaUsedAndCompare(taskId, {
      kind: 'persona_used',
      page: 'main',
      voice_persona_id: 'hormozi-100m-offers',
    });
    assert.equal(result, null, 'agreement must return null (no mismatch)');
  }
  assert.equal(countMismatchEvents(taskId), 0, 'agreement must render ZERO mismatch events across 3 repeat runs');
  assert.equal(getOpenPersonaMismatch(taskId), null, 'no chip on agreement');
});

// ─── (b) forced divergence -> exactly ONE event + chip ─────────────────────

test('[U20-b] forced divergence -> exactly ONE persona_mismatch event + chip renders on the card', () => {
  const taskId = nextId('diverge');
  insertBlendedTask(taskId, 'hormozi-100m-offers');

  const result = recordPersonaUsedAndCompare(taskId, {
    kind: 'persona_used',
    page: 'upsell',
    voice_persona_id: 'wiebe-copy-hackers',
  });
  assert.ok(result, 'divergence must return the mismatch info');
  assert.equal(result?.declared_voice_persona_id, 'hormozi-100m-offers');
  assert.equal(result?.used_voice_persona_id, 'wiebe-copy-hackers');
  assert.equal(countMismatchEvents(taskId), 1, 'exactly ONE persona_mismatch event');

  const chip = getOpenPersonaMismatch(taskId);
  assert.ok(chip, 'chip must be present');
  assert.equal(chip?.declared_voice_persona_id, 'hormozi-100m-offers');
  assert.equal(chip?.used_voice_persona_id, 'wiebe-copy-hackers');
  assert.equal(chip?.page, 'upsell');
});

// ─── (c) SAME divergence repeated 3x -> still exactly ONE event (dedup) ────

test('[U20-c] the SAME divergence reported 3 times -> still exactly ONE event (idempotent dedup)', () => {
  const taskId = nextId('dedup');
  insertBlendedTask(taskId, 'hormozi-100m-offers');

  for (let i = 0; i < 3; i++) {
    recordPersonaUsedAndCompare(taskId, {
      kind: 'persona_used',
      page: 'downsell',
      voice_persona_id: 'wiebe-copy-hackers',
    });
  }
  assert.equal(countMismatchEvents(taskId), 1, 'repeat reports of the SAME divergence must dedupe to ONE event');
});

// ─── Fail-soft: unblended task never fabricates a mismatch ─────────────────

test('[U20-failsoft] a task with NO declared voice (never blended) never fabricates a mismatch', () => {
  const taskId = nextId('unblended');
  insertUnblendedTask(taskId);

  const result = recordPersonaUsedAndCompare(taskId, {
    kind: 'persona_used',
    page: 'main',
    voice_persona_id: 'hormozi-100m-offers',
  });
  assert.equal(result, null);
  assert.equal(countMismatchEvents(taskId), 0);
});

// ─── End-to-end via the real activities POST route + tasks GET board row ───

test('[U20-e2e] a real POST /activities carrying a divergent persona_used report renders the chip on the tasks GET board row', async () => {
  const taskId = nextId('e2e-mismatch');
  insertBlendedTask(taskId, 'hormozi-100m-offers');

  const res = await postActivity(taskId, {
    activity_type: 'updated',
    message: 'Step 5/12: copy authored for page main',
    metadata: { kind: 'persona_used', page: 'main', voice_persona_id: 'wiebe-copy-hackers' },
  });
  assert.equal(res.status, 201);

  const boardReq = new NextRequest('http://localhost/api/tasks');
  const boardRes = await tasksGET(boardReq);
  assert.equal(boardRes.status, 200);
  const board = await boardRes.json();
  const row = board.find((t: { id: string }) => t.id === taskId);
  assert.ok(row, 'task must be on the board');
  assert.ok(row.persona_mismatch, 'the board row must carry persona_mismatch (the chip source)');
  assert.equal(row.persona_mismatch.declared_voice_persona_id, 'hormozi-100m-offers');
  assert.equal(row.persona_mismatch.used_voice_persona_id, 'wiebe-copy-hackers');
});

test('[U20-e2e-agree] a real POST /activities carrying an AGREEING persona_used report renders no chip on the board', async () => {
  const taskId = nextId('e2e-agree');
  insertBlendedTask(taskId, 'hormozi-100m-offers');

  const res = await postActivity(taskId, {
    activity_type: 'updated',
    message: 'Step 5/12: copy authored for page main',
    metadata: { kind: 'persona_used', page: 'main', voice_persona_id: 'hormozi-100m-offers' },
  });
  assert.equal(res.status, 201);

  const boardReq = new NextRequest('http://localhost/api/tasks');
  const boardRes = await tasksGET(boardReq);
  const board = await boardRes.json();
  const row = board.find((t: { id: string }) => t.id === taskId);
  assert.ok(row, 'task must be on the board');
  assert.equal(row.persona_mismatch, null, 'agreement -> no chip');
});
