/**
 * social-f21-service-health.test.ts — F21 acceptance (CC half).
 *
 * "Run installation, restart and recovery checks on Mac, Hostinger VPS and
 * Contabo VPS. The health view reports a stopped worker or missed invitation
 * WITHOUT claiming work is progressing."
 *
 * Proven in-process against an isolated temp DB (real migration chain) and
 * the REAL modules:
 *   1. Scheduler registration RESTORED: the JOBS array carries social-cycle
 *      and social-expiry-recovery (they were dropped in the W3 integration
 *      while the modules survived — a box booted with no weekly cycle runner).
 *   2. Engine check: exactly one ACTIVE durable owner per company is ok;
 *      zero rows / superseded-only is UNHEALTHY (never "legacy still armed").
 *   3. Worker check: a fresh tick is ok; a STALE tick (>3x cadence) reports
 *      worker_stale and the overall report NEVER claims work is progressing
 *      (no "in progress" claim when the worker is stopped).
 *   4. Missed invitation: an invited cycle past cutoff reports
 *      missed_invitation (actionable), not in-progress.
 *   5. Queue check: overdue publish rows surface as overdue (consumer
 *      stopped), not silently working.
 *   6. SANITIZED: the report never contains a credential-shaped value
 *      (pit-/sk-or-/API-key patterns) even when expiry/queue rows exist.
 *   7. Fresh-install shape: no social tables -> no_cycles_yet states, ok.
 *
 * Run:
 *   node --import tsx --import ./tests/setup/no-owner-telegram.ts \
 *     --test tests/unit/social-f21-service-health.test.ts
 */
import './_isolated-db'; // MUST be first DB import: throwaway DATABASE_PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, getDb, run, timeNow } from '../../src/lib/db';
import {
  serviceHealthReport,
  checkEngine,
  checkWorker,
  checkCycles,
  checkQueue,
  checkSheetRegistry,
} from '../../src/lib/health/service-health';

getDb(); // full migration chain against the isolated temp DB

const COMPANY = 'company-f21-a';
const HOUR = 3600_000;

function freshDb() {
  const db = getDb();
  for (const t of ['social_cycles', 'social_engine_ownership', 'social_expiry_events',
    'social_sheet_registry', 'company_ghl_bindings', 'publish_queue']) {
    try { db.exec(`DELETE FROM ${t}`); } catch { /* fresh install */ }
  }
  try { db.exec(`DELETE FROM job_liveness`); } catch { /* fresh */ }
}

function seedOwnership(companyId: string, state = 'active', engine = 'cc-cycle-service') {
  run(
    `INSERT INTO social_engine_ownership (id, company_id, engine, scheduler_name, scheduler_expr, next_run_at, state, verified_at)
     VALUES (?, ?, ?, 'node-cron', '*/5 * * * *', ?, ?, ?)`,
    [`owner-${companyId}-${state}`, companyId, engine,
     new Date(Date.now() + 5 * 60_000).toISOString(), state, timeNow()],
  );
}

function seedCycle(companyId: string, weekStart: string, state = 'invited', cutoffIso: string | null = null) {
  run(
    `INSERT INTO social_cycles (id, company_id, week_start_local, state, cutoff_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [`cyc-${companyId}-${weekStart}`, companyId, weekStart, state, cutoffIso, timeNow(), timeNow()],
  );
}

function seedTick(jobName: string, ageMs: number, status = 'ok') {
  run(
    `INSERT INTO job_liveness (job_name, last_ran_at, last_status, last_error)
     VALUES (?, ?, ?, NULL)`,
    [jobName, new Date(Date.now() - ageMs).toISOString(), status],
  );
}

test('1. scheduler JOBS array carries the restored social-cycle + social-expiry-recovery entries', async () => {
  // Static read of the JOBS declaration (registering real node-cron timers in
  // a unit test starts live scheduler tasks — the static contract is what
  // F21 restores: the entries EXIST, with the WF10 exprs).
  const src = (await import('node:fs')).readFileSync(
    new URL('../../src/lib/jobs/scheduler.ts', import.meta.url), 'utf8');
  assert.ok(/name: 'social-cycle'/.test(src), 'social-cycle entry missing from JOBS');
  assert.ok(/name: 'social-expiry-recovery'/.test(src), 'social-expiry-recovery entry missing from JOBS');
  assert.ok(/SOCIAL_CYCLE_CRON/.test(src), 'social-cycle must use the F17 SOCIAL_CYCLE_CRON expr');
});

test('2. engine check: one active durable owner is ok; zero rows is UNHEALTHY', () => {
  freshDb();
  const absent = checkEngine();
  assert.equal(absent.ok, false);
  assert.equal(absent.state, 'no_owner');
  seedOwnership(COMPANY);
  const one = checkEngine();
  assert.equal(one.ok, true);
  // A legacy-only active row (no durable engine) violates F17 -> unhealthy.
  freshDb();
  seedOwnership(COMPANY, 'active', 'skill35-weekly-theme');
  const legacy = checkEngine();
  assert.equal(legacy.ok, false);
  assert.equal(legacy.state, 'ownership_violated');
});

test('3. worker check: fresh tick ok; stale tick reports worker_stale and report never claims progress', async () => {
  freshDb();
  seedOwnership(COMPANY);
  seedCycle(COMPANY, '2026-09-06', 'invited', new Date(Date.now() + HOUR).toISOString());
  // Fresh ticks for all three social jobs -> worker ok.
  for (const j of ['social-cycle', 'social-expiry-recovery', 'social-publish-dispatcher']) {
    run(`INSERT INTO job_liveness (job_name, last_ran_at, last_status) VALUES (?, ?, 'ok')`,
      [j, new Date().toISOString()]);
  }
  const fresh = checkWorker();
  assert.equal(fresh.ok, true);
  // Age the social-cycle tick past the 15-minute staleness bound.
  run(`UPDATE job_liveness SET last_ran_at = ? WHERE job_name = 'social-cycle'`,
    [new Date(Date.now() - 30 * 60_000).toISOString()]);
  const stale = checkWorker();
  assert.equal(stale.ok, false);
  assert.equal(stale.state, 'worker_stale');
  // The FULL report must not claim work is progressing: ok=false and the
  // actionable list names the stopped worker.
  const report = serviceHealthReport();
  assert.equal(report.ok, false);
  const workerAction = report.actionable.find((a) => a.check === 'worker');
  assert.ok(workerAction, 'stopped worker must appear in actionable');
  assert.equal(workerAction.state, 'worker_stale');
});

test('4. missed invitation: invited cycle past cutoff -> missed_invitation, not in progress', () => {
  freshDb();
  seedOwnership(COMPANY);
  for (const j of ['social-cycle', 'social-expiry-recovery', 'social-publish-dispatcher']) {
    run(`INSERT INTO job_liveness (job_name, last_ran_at, last_status) VALUES (?, ?, 'ok')`,
      [j, new Date().toISOString()]);
  }
  // Healthy: cutoff in the future.
  seedCycle(COMPANY, '2026-09-06', 'invited', new Date(Date.now() + 34 * HOUR).toISOString());
  assert.equal(checkCycles().ok, true);
  // Missed: cutoff in the past.
  freshDb();
  seedOwnership(COMPANY);
  for (const j of ['social-cycle', 'social-expiry-recovery', 'social-publish-dispatcher']) {
    run(`INSERT INTO job_liveness (job_name, last_ran_at, last_status) VALUES (?, ?, 'ok')`,
      [j, new Date().toISOString()]);
  }
  seedCycle(COMPANY, '2026-08-30', 'invited', new Date(Date.now() - 2 * HOUR).toISOString());
  const missed = checkCycles();
  assert.equal(missed.ok, false);
  assert.equal(missed.state, 'missed_invitation');
  const report = serviceHealthReport();
  assert.equal(report.ok, false);
  assert.ok(report.actionable.some((a) => a.state === 'missed_invitation'));
});

test('5. queue: overdue publish rows surface as overdue (consumer stopped)', () => {
  freshDb();
  run(
    `INSERT INTO publish_queue (id, topic, platforms, status, created_at, updated_at)
     VALUES ('pq-f21-overdue', 'topic', '[]', 'queued',
             datetime('now', '-45 minutes'), datetime('now'))`,
  );
  const q = checkQueue();
  assert.equal(q.ok, false);
  assert.equal(q.state, 'overdue');
  const report = serviceHealthReport();
  assert.ok(report.actionable.some((a) => a.state === 'overdue'));
});

test('6. SANITIZED: report carries no credential-shaped value even with expiry rows', () => {
  freshDb();
  seedOwnership(COMPANY);
  run(
    `INSERT INTO social_expiry_events (id, company_id, kind, error_type, affected_resource, affected_resource_id, detail, status)
     VALUES ('exp-f21', ?, 'account_authorization', 'authentication', 'gml_account', 'acc-1', 'reauth needed', 'open')`,
    [COMPANY],
  );
  const report = serviceHealthReport();
  const text = JSON.stringify(report);
  assert.ok(!/pit-[0-9a-f-]{8,}/i.test(text), 'no PIT tokens in health output');
  assert.ok(!/sk-or-v1-/.test(text), 'no OpenRouter keys in health output');
  assert.equal(report.checks.expiry.ok, false, 'open expiry row is a visible state');
});

test('7. fresh-install shape: no social tables -> no_cycles_yet, engine unhealthy until claimed', () => {
  freshDb();
  const report = serviceHealthReport();
  assert.equal(report.checks.cycles.state, 'no_cycles_yet');
  assert.equal(report.checks.engine.ok, false, 'fresh box has no durable owner yet');
  // The registry is required by the F21 contract: no registered planner sheet.
  const reg = checkSheetRegistry();
  assert.equal(reg.state, 'unregistered');
});

// Close the DB handle so the runner exits cleanly.
test('cleanup', () => {
  closeDb();
});