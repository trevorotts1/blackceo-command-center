/**
 * CC-fixture-003 — the last two fixture residuals: persona pins and QC results.
 *
 * v6.0.61 (CC-resear-001) and v6.0.62 (CC-fixture-002) closed the research, media,
 * web-agent and SOP fixture paths. Two write sites were deliberately left open
 * because both are the input seam for a REAL test — closing them naively would
 * have meant weakening `p2-02-persona-reason-persistence` or
 * `prd-2.10-qc-results-persistence`, which is out of bounds:
 *
 *   1. PERSONA_FIXTURE_JSON / PERSONA_PLAN_FIXTURE_JSON → a canned persona is
 *      pinned durably onto `tasks.persona_id / persona_name / persona_mode /
 *      persona_score / persona_reason` by resolvePersonaAndPin /
 *      resolvePersonaPlanAndPin. No column marks the pin fixture-derived, so a
 *      canned pin is indistinguishable from a real scored one.
 *   2. QC_FIXTURE_JSON_PATH / QC_SIMULATE_PROVIDER_DOWN → a canned verdict is
 *      persisted as a `task_qc_results` row (the grading module's evidence for
 *      qcPassRate) plus `events` rows the board renders as QC history, and it
 *      flips `tasks.status`.
 *
 * Both were guarded ONLY by assertNoFixtureEnvInProduction(), which is a
 * deliberate no-op outside NODE_ENV=production. That is not containment: a
 * `next dev` box writes to the SAME mission-control.db as a live one.
 *
 * The remedy reuses the ALREADY-MERGED src/lib/fixture-guard.ts
 * `assertNoFixtureDerivedServerWrite()` — never a second guard. It is keyed on
 * `globalThis.__CC_SERVER_ENTRYPOINT__`, set only by src/instrumentation.ts, so
 * it refuses fixture-derived durable writes from the real server process at
 * EVERY NODE_ENV while leaving offline tests and smoke scripts fully working.
 * That is precisely why the two named tests keep passing unmodified: neither
 * sets the marker.
 *
 * DATABASE_PATH is set before any import of @/lib/db so the module-load-time
 * path constant captures the temp DB.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-fixture-003-'));
process.env.DATABASE_PATH = path.join(TMP_DIR, 'mission-control.db');

// A fixture var inherited from a sibling suite would make every assertion below
// meaningless, so start from a known-clean environment.
for (const v of [
  'PERSONA_FIXTURE_JSON',
  'PERSONA_PLAN_FIXTURE_JSON',
  'QC_FIXTURE_JSON_PATH',
  'QC_SIMULATE_PROVIDER_DOWN',
]) {
  delete process.env[v];
}
delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.GEMINI_API_KEY;

const now = new Date().toISOString();

type DbModule = typeof import('../../src/lib/db');
let getDb: DbModule['getDb'];
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];

type TasksModule = typeof import('../../src/lib/tasks');
let resolvePersonaAndPin: TasksModule['resolvePersonaAndPin'];
let resolvePersonaPlanAndPin: TasksModule['resolvePersonaPlanAndPin'];

type QcModule = typeof import('../../src/lib/qc-scorer');
let runQCOnReview: QcModule['runQCOnReview'];

type GuardModule = typeof import('../../src/lib/fixture-guard');
let activeFixtureEnvVars: GuardModule['activeFixtureEnvVars'];

/** Run `fn` with the real-server marker set, always restoring it afterwards. */
async function asServerProcess<T>(fn: () => Promise<T> | T): Promise<T> {
  const prev = globalThis.__CC_SERVER_ENTRYPOINT__;
  globalThis.__CC_SERVER_ENTRYPOINT__ = true;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete globalThis.__CC_SERVER_ENTRYPOINT__;
    else globalThis.__CC_SERVER_ENTRYPOINT__ = prev;
  }
}

/** Seed a task row. `status` drives whether runQCOnReview will engage. */
function seedTask(id: string, status: string): string {
  run(
    `INSERT INTO tasks (id, title, description, status, priority, workspace_id, department, created_at, updated_at)
     VALUES (?, 'Landing page', 'Build a direct-response landing page', ?, 'medium', 'marketing', 'marketing', ?, ?)`,
    [id, status, now, now],
  );
  return id;
}

function personaFixture(): string {
  return JSON.stringify({
    persona_id: 'russell-brunson',
    persona_name: 'Russell Brunson',
    score: 0.82,
    interaction_mode: 'leadership',
  });
}

function writeQcFixture(score: number): string {
  const p = path.join(TMP_DIR, `qc-fixture-${uuidv4()}.json`);
  fs.writeFileSync(p, JSON.stringify({ score, pass: score >= 8.5, reason: 'Canned verdict', gaps: [] }));
  return p;
}

test.before(async () => {
  const dbMod = await import('../../src/lib/db');
  getDb = dbMod.getDb;
  run = dbMod.run;
  queryOne = dbMod.queryOne;
  getDb();

  run(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES ('default', 'Default', 'default', '{}', ?, ?)`,
    [now, now],
  );
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, description, icon, company_id, sort_order, created_at, updated_at)
     VALUES ('marketing', 'Marketing', 'marketing', '', '📣', 'default', 10, ?, ?)`,
    [now, now],
  );

  const tasksMod = await import('../../src/lib/tasks');
  resolvePersonaAndPin = tasksMod.resolvePersonaAndPin;
  resolvePersonaPlanAndPin = tasksMod.resolvePersonaPlanAndPin;

  const qcMod = await import('../../src/lib/qc-scorer');
  runQCOnReview = qcMod.runQCOnReview;

  const guardMod = await import('../../src/lib/fixture-guard');
  activeFixtureEnvVars = guardMod.activeFixtureEnvVars;
});

test.after(() => {
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// ───────────────────────────────────────────────────────────────────────────
// RESIDUAL 1 — persona pins
// ───────────────────────────────────────────────────────────────────────────

test('PERSONA_FIXTURE_JSON + server entrypoint → the tasks.persona_* pin is REFUSED', async () => {
  const taskId = seedTask('cc-f003-persona-refused', 'backlog');
  process.env.PERSONA_FIXTURE_JSON = personaFixture();
  try {
    await asServerProcess(async () => {
      await assert.rejects(
        () => resolvePersonaAndPin(taskId, 'Build a direct-response landing page', 'marketing'),
        /Refusing to write .*PERSONA_FIXTURE_JSON/s,
        'a canned persona must not be pinned durably from the live server process at ANY NODE_ENV — ' +
          'a `next dev` box writes to the same mission-control.db as production',
      );
    });
  } finally {
    delete process.env.PERSONA_FIXTURE_JSON;
  }

  const row = queryOne<{ persona_id: string | null; persona_reason: string | null }>(
    'SELECT persona_id, persona_reason FROM tasks WHERE id = ?',
    [taskId],
  );
  assert.equal(row!.persona_id, null, 'no fixture-derived persona_id may reach the tasks table');
  assert.equal(row!.persona_reason, null, 'no fixture-derived persona_reason may reach the tasks table');
});

test('the refusal fires BEFORE the exhaustion fallback — no dept-default pin is written either', async () => {
  // resolvePersonaAndPin wraps every attempt in a try/catch that logs and
  // retries, then pins a deterministic department-default persona once the
  // attempts are exhausted. A guard placed INSIDE that loop would be swallowed
  // and the fallback would still write a durable row. This asserts the guard
  // sits outside the loop.
  const taskId = seedTask('cc-f003-persona-no-fallback', 'backlog');
  process.env.PERSONA_FIXTURE_JSON = personaFixture();
  try {
    await asServerProcess(async () => {
      await assert.rejects(() =>
        resolvePersonaAndPin(taskId, 'Build a direct-response landing page', 'marketing'),
      );
    });
  } finally {
    delete process.env.PERSONA_FIXTURE_JSON;
  }

  const row = queryOne<{ persona_id: string | null }>('SELECT persona_id FROM tasks WHERE id = ?', [taskId]);
  assert.equal(
    row!.persona_id,
    null,
    'the exhaustion fallback must not convert a refused fixture pin into a dept-default pin',
  );
});

test('PERSONA_PLAN_FIXTURE_JSON + server entrypoint → the plan pin is REFUSED', async () => {
  const taskId = seedTask('cc-f003-persona-plan-refused', 'backlog');
  process.env.PERSONA_PLAN_FIXTURE_JSON = JSON.stringify({
    subtask_personas: [
      { seq: 1, persona_id: 'russell-brunson', persona_name: 'Russell Brunson', score: 0.8 },
      { seq: 2, persona_id: 'dan-kennedy', persona_name: 'Dan Kennedy', score: 0.7 },
    ],
  });
  try {
    await asServerProcess(async () => {
      await assert.rejects(
        () => resolvePersonaPlanAndPin(taskId, 'Build a direct-response landing page', 'marketing', []),
        /Refusing to write .*PERSONA_PLAN_FIXTURE_JSON/s,
        'a canned multi-persona plan must not be pinned durably from the live server process',
      );
    });
  } finally {
    delete process.env.PERSONA_PLAN_FIXTURE_JSON;
  }

  const row = queryOne<{ persona_id: string | null }>('SELECT persona_id FROM tasks WHERE id = ?', [taskId]);
  assert.equal(row!.persona_id, null, 'no fixture-derived plan persona may reach the tasks table');
});

test('NO server marker → the persona fixture still works (offline tests/scripts unaffected)', async () => {
  // This is the control that makes the fix safe: p2-02-persona-reason-persistence
  // drives this exact path with PERSONA_FIXTURE_JSON set and NEVER sets the
  // marker, so it must keep passing completely unmodified.
  const taskId = seedTask('cc-f003-persona-offline-ok', 'backlog');
  const prev = globalThis.__CC_SERVER_ENTRYPOINT__;
  delete globalThis.__CC_SERVER_ENTRYPOINT__;
  process.env.PERSONA_FIXTURE_JSON = personaFixture();
  try {
    const pinned = await resolvePersonaAndPin(taskId, 'Build a direct-response landing page', 'marketing');
    assert.equal(pinned, 'russell-brunson', 'fixture mode must stay usable outside the server process');
  } finally {
    delete process.env.PERSONA_FIXTURE_JSON;
    if (prev !== undefined) globalThis.__CC_SERVER_ENTRYPOINT__ = prev;
  }

  const row = queryOne<{ persona_id: string | null; persona_reason: string | null }>(
    'SELECT persona_id, persona_reason FROM tasks WHERE id = ?',
    [taskId],
  );
  assert.equal(row!.persona_id, 'russell-brunson', 'the offline pin must still land');
  assert.ok(row!.persona_reason, 'p2-02 persona_reason persistence must be untouched');
});

// ───────────────────────────────────────────────────────────────────────────
// RESIDUAL 2 — QC results
// ───────────────────────────────────────────────────────────────────────────

test('QC_FIXTURE_JSON_PATH + server entrypoint → task_qc_results / events writes are REFUSED', async () => {
  const taskId = seedTask('cc-f003-qc-refused', 'review');
  process.env.QC_FIXTURE_JSON_PATH = writeQcFixture(9.2);
  try {
    await asServerProcess(async () => {
      await assert.rejects(
        () => runQCOnReview(taskId),
        /Refusing to write .*QC_FIXTURE_JSON_PATH/s,
        'a canned QC verdict must not be persisted as grading evidence from the live server process',
      );
    });
  } finally {
    delete process.env.QC_FIXTURE_JSON_PATH;
  }

  const qcRow = queryOne<{ cnt: number }>(
    'SELECT COUNT(*) AS cnt FROM task_qc_results WHERE task_id = ?',
    [taskId],
  );
  assert.equal(qcRow!.cnt, 0, 'no fixture-derived task_qc_results row may reach the grading module');

  const evtRow = queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM events WHERE task_id = ?', [taskId]);
  assert.equal(evtRow!.cnt, 0, 'no fixture-derived QC events row may reach the board history');

  const task = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId]);
  assert.equal(task!.status, 'review', 'a refused QC run must not flip tasks.status');
});

test('QC_SIMULATE_PROVIDER_DOWN + server entrypoint → the durable QC write is REFUSED', async () => {
  const taskId = seedTask('cc-f003-qc-simulate-refused', 'review');
  process.env.QC_SIMULATE_PROVIDER_DOWN = '1';
  try {
    await asServerProcess(async () => {
      await assert.rejects(
        () => runQCOnReview(taskId),
        /Refusing to write .*QC_SIMULATE_PROVIDER_DOWN/s,
        'a forged provider outage must not be persisted as real QC history',
      );
    });
  } finally {
    delete process.env.QC_SIMULATE_PROVIDER_DOWN;
  }

  const qcRow = queryOne<{ cnt: number }>(
    'SELECT COUNT(*) AS cnt FROM task_qc_results WHERE task_id = ?',
    [taskId],
  );
  assert.equal(qcRow!.cnt, 0, 'a simulated outage must not produce a durable QC row');
});

test('NO server marker → the QC fixture still works (prd-2.10 path unaffected)', async () => {
  // prd-2.10-qc-results-persistence drives exactly this with QC_FIXTURE_JSON_PATH
  // set and no marker, so it must keep passing completely unmodified.
  const taskId = seedTask('cc-f003-qc-offline-ok', 'review');
  const prev = globalThis.__CC_SERVER_ENTRYPOINT__;
  delete globalThis.__CC_SERVER_ENTRYPOINT__;
  process.env.QC_FIXTURE_JSON_PATH = writeQcFixture(9.2);
  try {
    const result = await runQCOnReview(taskId);
    assert.ok(result, 'fixture mode must stay usable outside the server process');
    assert.equal(result!.scoringPath, 'llm', 'the fixture must still drive the llm scoring path');
  } finally {
    delete process.env.QC_FIXTURE_JSON_PATH;
    if (prev !== undefined) globalThis.__CC_SERVER_ENTRYPOINT__ = prev;
  }

  const qcRow = queryOne<{ score: number; scoring_path: string }>(
    `SELECT score, scoring_path FROM task_qc_results WHERE task_id = ? AND scoring_path = 'llm'`,
    [taskId],
  );
  assert.ok(qcRow, 'the offline task_qc_results row must still be written');
  assert.equal(qcRow!.score, 9.2, 'prd-2.10 score persistence must be untouched');
});

// ───────────────────────────────────────────────────────────────────────────
// NO-REGRESSION + DETECTION CONTROLS
// ───────────────────────────────────────────────────────────────────────────

test('no fixture var set → the live server path is completely unchanged', async () => {
  const taskId = seedTask('cc-f003-live-unchanged', 'review');
  await asServerProcess(async () => {
    // No fixture var is set, so neither guard may fire. The QC run reaches the
    // real scorer and fails closed to the heuristic (no client judge configured),
    // exactly as on an untouched box.
    const result = await runQCOnReview(taskId);
    assert.ok(result, 'the live path must still run when no fixture is active');
    assert.notEqual(result!.scoringPath, 'llm', 'no key configured → heuristic/no-criteria, never a canned llm score');
  });

  const qcRow = queryOne<{ cnt: number }>(
    'SELECT COUNT(*) AS cnt FROM task_qc_results WHERE task_id = ?',
    [taskId],
  );
  assert.equal(qcRow!.cnt, 1, 'the genuine QC row must still be persisted — zero regression');
});

test('diagnostics name all four residual vars when they are set', () => {
  const saved = { ...process.env };
  process.env.PERSONA_FIXTURE_JSON = personaFixture();
  process.env.PERSONA_PLAN_FIXTURE_JSON = '{}';
  process.env.QC_FIXTURE_JSON_PATH = '/tmp/nonexistent-qc.json';
  process.env.QC_SIMULATE_PROVIDER_DOWN = '1';
  try {
    const active = activeFixtureEnvVars();
    for (const name of [
      'PERSONA_FIXTURE_JSON',
      'PERSONA_PLAN_FIXTURE_JSON',
      'QC_FIXTURE_JSON_PATH',
      'QC_SIMULATE_PROVIDER_DOWN',
    ]) {
      assert.ok(active.includes(name), `a diagnostic sweep must never call a box clean while ${name} is set`);
    }
  } finally {
    for (const v of [
      'PERSONA_FIXTURE_JSON',
      'PERSONA_PLAN_FIXTURE_JSON',
      'QC_FIXTURE_JSON_PATH',
      'QC_SIMULATE_PROVIDER_DOWN',
    ]) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
  }
});
