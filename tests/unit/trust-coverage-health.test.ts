/**
 * U94 (X.2.3) — trust-coverage health metric: checkTrustCoverage()
 * (src/lib/health/deep-checks.ts), exposed non-gating at
 * GET /api/health/deep -> advisory.trust_coverage.
 *
 * coverage = tasks-with-requester / total client-initiated, where
 * "client-initiated" is identified by a `requester_stamp_check` event
 * written ONLY by the three enumerated human-facing creation doors
 * (createTaskCore's humanDoorId param — see src/lib/tasks.ts), independent
 * of whether the requester fields actually landed on that call. This makes
 * the metric non-circular: a task with no requester_chat_id is either (a) a
 * genuine coverage gap (a human door fired the event with hasRequester:false)
 * or (b) a producer/operator create that never fired the event at all and is
 * correctly excluded from the denominator — this suite proves both.
 *
 * Drives createTaskCore directly (the real production code path every door
 * calls through) against an isolated temp DB — no HTTP layer needed since
 * the door-specific HTTP wiring is already covered by
 * create-task-requester-stamp.test.ts / ingest-requester-stamp.test.ts /
 * ceo-chat-task-endpoint.test.ts / departments-requester-stamp.test.ts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Isolated DB (set BEFORE @/lib/db / the module under test are imported) ──
const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-trust-coverage-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;
process.env.OPENCLAW_ROOT = '/nonexistent/openclaw-root-for-tests';
delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.GEMINI_API_KEY;

const RUN_ID = Math.random().toString(36).slice(2, 10);
const WS_ID = `ws-coverage-${RUN_ID}`;

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let closeDb: DbModule['closeDb'];

type TasksModule = typeof import('../../src/lib/tasks');
let createTaskCore: TasksModule['createTaskCore'];

type HealthModule = typeof import('../../src/lib/health/deep-checks');
let checkTrustCoverage: HealthModule['checkTrustCoverage'];

let seq = 0;
function nextTitle(): string {
  seq += 1;
  return `Coverage fixture ${RUN_ID} #${seq}`;
}

test.before(async () => {
  const db = (await import('../../src/lib/db')) as DbModule;
  run = db.run;
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
     VALUES (?, 'coverage-ws', 'Coverage WS', '📋', 'default', 1, ?, ?)`,
    [WS_ID, now, now],
  );

  const tasksMod = (await import('../../src/lib/tasks')) as TasksModule;
  createTaskCore = tasksMod.createTaskCore;

  const healthMod = (await import('../../src/lib/health/deep-checks')) as HealthModule;
  checkTrustCoverage = healthMod.checkTrustCoverage;
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

// ── Fresh box: no human-door creations at all → PASS, not a false DRIFT ─────
test('on a box with zero human-door task creations, checkTrustCoverage() passes with 100% (nothing to measure)', async () => {
  const result = checkTrustCoverage();
  assert.equal(result.pass, true);
  assert.equal(result.human_door_total, 0);
  assert.equal(result.coverage_pct, 100);
});

// ── Producer-created tasks never move the denominator ────────────────────────
test('producer-created tasks (no humanDoorId) do NOT count toward the coverage denominator', async () => {
  const before = checkTrustCoverage();
  const beforeTotal = before.human_door_total ?? 0;

  // Five producer/system creates — NO humanDoorId passed, matching every
  // caller in this codebase except the three enumerated door routes.
  for (let i = 0; i < 5; i += 1) {
    await createTaskCore(
      { title: nextTitle(), workspace_id: WS_ID, skipWindowDedup: true },
      { notifyGateway: false },
    );
  }

  const after = checkTrustCoverage();
  assert.equal(
    after.human_door_total ?? 0,
    beforeTotal,
    'producer-created tasks (no humanDoorId) must never appear in the trust-coverage denominator',
  );
});

// ── A human door with a requester on every call → 100% coverage, PASS ───────
test('a human door that stamps a requester on every call reports 100% coverage', async () => {
  const before = checkTrustCoverage();
  const beforeTotal = before.human_door_total ?? 0;
  const beforeStamped = before.human_door_stamped ?? 0;

  for (let i = 0; i < 10; i += 1) {
    await createTaskCore(
      {
        title: nextTitle(),
        workspace_id: WS_ID,
        skipWindowDedup: true,
        requester_channel: 'telegram',
        requester_chat_id: `chat-${RUN_ID}-${i}`,
        humanDoorId: 'command-center-ui',
      },
      { notifyGateway: false },
    );
  }

  const after = checkTrustCoverage();
  assert.equal(after.human_door_total, beforeTotal + 10);
  assert.equal(after.human_door_stamped, beforeStamped + 10);
});

// ── MUTATION PROOF: dropping below the 95% floor flips pass to false ────────
test('coverage below the 95% floor is reported as DRIFT (pass:false), and restoring it passes again', async () => {
  // Coming into this test the box already has (at least) the prior test's
  // 10/10 = 100% batch. Adding just 3 unstamped human-door rows on top of
  // that 10-stamped baseline pulls the OVERALL ratio to 10/13 ≈ 77%, well
  // under the 95% floor — a small, fast, deterministic mutation proof
  // (mirrors U95's "FAILS when a rogue call site is added" pattern).
  const UNSTAMPED_BATCH = 3;
  for (let i = 0; i < UNSTAMPED_BATCH; i += 1) {
    await createTaskCore(
      {
        title: nextTitle(),
        workspace_id: WS_ID,
        skipWindowDedup: true,
        // humanDoorId set (this IS a human-facing door call) but the caller
        // never actually knew a chat id — e.g. a UI create with no requester
        // info supplied. hasRequester computes to false.
        humanDoorId: 'command-center-ui',
      },
      { notifyGateway: false },
    );
  }

  const drifted = checkTrustCoverage();
  assert.equal(drifted.pass, false, `expected DRIFT (pass:false) after a small unstamped batch; got ${drifted.coverage_pct}%`);
  assert.match(drifted.detail, /DRIFT/);

  // Restore: enough fully-stamped rows to pull the aggregate back to/above
  // 95% given the 3 permanently-unstamped rows just added to the
  // denominator. 60 is comfortably above the algebraic minimum (47) needed
  // from this test's starting point, leaving margin against float rounding.
  const RESTORE_BATCH = 60;
  for (let i = 0; i < RESTORE_BATCH; i += 1) {
    await createTaskCore(
      {
        title: nextTitle(),
        workspace_id: WS_ID,
        skipWindowDedup: true,
        requester_channel: 'telegram',
        requester_chat_id: `restore-${RUN_ID}-${i}`,
        humanDoorId: 'command-center-ui',
      },
      { notifyGateway: false },
    );
  }

  const restored = checkTrustCoverage();
  assert.equal(restored.pass, true, `expected coverage restored to PASS; got ${restored.coverage_pct}%`);
});
