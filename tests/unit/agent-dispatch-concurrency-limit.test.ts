/**
 * FLEET-01 — global agent-dispatch concurrency ceiling: probe-level coverage.
 *
 * THE GAP: some model providers cap concurrency at the ACCOUNT level, not
 * per-model (a $20/mo Ollama Cloud plan allows at most 3 agents running AT
 * ONCE, account-wide) — proven on a live client box: 234 consecutive
 * rejections over 10 weeks, 100% one provider, zero successful failover.
 * Nothing in this codebase previously counted concurrently in-flight agent
 * sessions against any ceiling. `WIP_LIMITS`/`checkWipLimit` (same file) is a
 * PER-WORKSPACE board-column display limit and explicitly NOT this — on a box
 * with 5 departments/workspaces it allows up to 5 × in_progress=5 = 25
 * board-wide in_progress cards, which is exactly the failure mode this exists
 * to prevent.
 *
 * This suite covers the three exported primitives in
 * src/lib/task-lifecycle.ts in isolation, BEFORE any autoDispatchTask/route
 * wiring is involved:
 *   getAgentDispatchConcurrencyCeiling() — env parse, fail-open on garbage
 *   countInFlightDispatches()            — GLOBAL count, ignores workspace_id
 *   checkDispatchConcurrencyLimit()      — the read-only probe both dispatch
 *                                          paths (auto sweep + manual route)
 *                                          share
 *
 * Case (1) below — "unset → always null, regardless of in-flight count" — is
 * the MANDATORY fleet-safety test: every one of the ~39 fleet boxes that has
 * not explicitly set AGENT_DISPATCH_MAX_CONCURRENT must see NO behavioural
 * change, ever, under any load.
 *
 * Strategy mirrors mr-12-wip-limit-server.test.ts: isolated temp DB (DATABASE_PATH
 * set BEFORE @/lib/db is imported), full migration chain, raw task fixtures.
 *
 *   node --import tsx --test tests/unit/agent-dispatch-concurrency-limit.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Isolated DB (set BEFORE @/lib/db is imported) ────────────────────────────
const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-fleet01-probe-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;

const RUN_ID = Math.random().toString(36).slice(2, 10);
const WS_A = `ws-fleet01-a-${RUN_ID}`;
const WS_B = `ws-fleet01-b-${RUN_ID}`;

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let closeDb: DbModule['closeDb'];

type LifecycleModule = typeof import('../../src/lib/task-lifecycle');
let getAgentDispatchConcurrencyCeiling: LifecycleModule['getAgentDispatchConcurrencyCeiling'];
let countInFlightDispatches: LifecycleModule['countInFlightDispatches'];
let checkDispatchConcurrencyLimit: LifecycleModule['checkDispatchConcurrencyLimit'];

const now = new Date().toISOString();
let seedCounter = 0;

/** Insert a bare task row at a given status/workspace — no lifecycle preconditions. */
function seedTask(status: string, workspaceId: string | null): string {
  const id = `fleet01-${RUN_ID}-${seedCounter++}`;
  run(
    `INSERT INTO tasks (id, title, description, status, priority, workspace_id, business_id, created_at, updated_at)
     VALUES (?, ?, 'seed', ?, 'high', ?, 'default', ?, ?)`,
    [id, `FLEET-01 ${id}`, status, workspaceId, now, now],
  );
  return id;
}

/** Clear every task this file (or an earlier run) may have left behind, so
 * counts in each test are deterministic on the shared temp DB. */
function clearAllTasks(): void {
  run(`DELETE FROM tasks`);
}

test.before(async () => {
  const db = (await import('../../src/lib/db')) as DbModule;
  run = db.run;
  queryOne = db.queryOne;
  closeDb = db.closeDb;
  db.getDb(); // full migration chain against the temp DB

  run(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES ('default', 'Default', 'default', '{}', ?, ?)`,
    [now, now],
  );
  for (const ws of [WS_A, WS_B]) {
    run(
      `INSERT OR IGNORE INTO workspaces (id, slug, name, icon, company_id, sort_order, created_at, updated_at)
       VALUES (?, ?, 'FLEET-01', '🧪', 'default', 1, ?, ?)`,
      [ws, `fleet01-${ws}`, now, now],
    );
  }

  const lc = (await import('../../src/lib/task-lifecycle')) as LifecycleModule;
  getAgentDispatchConcurrencyCeiling = lc.getAgentDispatchConcurrencyCeiling;
  countInFlightDispatches = lc.countInFlightDispatches;
  checkDispatchConcurrencyLimit = lc.checkDispatchConcurrencyLimit;
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

test.beforeEach(() => {
  delete process.env.AGENT_DISPATCH_MAX_CONCURRENT;
  clearAllTasks();
});

// ── (1) MANDATORY FLEET-SAFETY TEST: unset → always null, any load ──────────
test('[FLEET-01 mandatory] AGENT_DISPATCH_MAX_CONCURRENT unset → no ceiling, no hold, regardless of in-flight count', () => {
  delete process.env.AGENT_DISPATCH_MAX_CONCURRENT;
  assert.equal(getAgentDispatchConcurrencyCeiling(), null, 'unset env var must parse to null (no limit)');
  assert.equal(checkDispatchConcurrencyLimit(), null, 'no ceiling → probe is a no-op with ZERO tasks in flight');

  // Seed a large number of in_progress tasks — far beyond any plausible
  // provider ceiling — and prove the probe STILL returns null. This is the
  // literal fleet-safety guarantee: an unconfigured box must behave
  // identically today no matter how much load it carries.
  for (let i = 0; i < 50; i++) seedTask('in_progress', WS_A);
  assert.equal(countInFlightDispatches(), 50, 'precondition: 50 tasks genuinely in flight');
  assert.equal(
    checkDispatchConcurrencyLimit(),
    null,
    'with the env var unset, 50 in-flight tasks must STILL never trigger a hold — unlimited means unlimited',
  );
});

// ── (2) invalid values fail OPEN (never invent a cap from garbage) ──────────
test('invalid/garbage AGENT_DISPATCH_MAX_CONCURRENT values fail open to no limit', () => {
  for (let i = 0; i < 10; i++) seedTask('in_progress', WS_A);

  for (const bad of ['0', '-1', '-5', 'not-a-number', '', '   ', 'NaN']) {
    process.env.AGENT_DISPATCH_MAX_CONCURRENT = bad;
    assert.equal(
      getAgentDispatchConcurrencyCeiling(),
      null,
      `"${bad}" must parse to null (fail open), not a numeric ceiling`,
    );
    assert.equal(checkDispatchConcurrencyLimit(), null, `"${bad}" must never trigger a hold`);
  }
  delete process.env.AGENT_DISPATCH_MAX_CONCURRENT;
});

// ── (3) under the ceiling → null (allowed) ───────────────────────────────────
test('under the configured ceiling, the probe clears (null)', () => {
  process.env.AGENT_DISPATCH_MAX_CONCURRENT = '3';
  for (let i = 0; i < 2; i++) seedTask('in_progress', WS_A);
  assert.equal(countInFlightDispatches(), 2);
  assert.equal(checkDispatchConcurrencyLimit(), null, '2 in flight, ceiling 3 → not held');
});

// ── (4) at/over the ceiling → a DispatchConcurrencyHold naming the ceiling ──
test('at/over the configured ceiling, the probe returns a hold naming inFlight/ceiling', () => {
  process.env.AGENT_DISPATCH_MAX_CONCURRENT = '3';
  for (let i = 0; i < 3; i++) seedTask('in_progress', WS_A);
  assert.equal(countInFlightDispatches(), 3, 'precondition: exactly at the ceiling');

  const atCeiling = checkDispatchConcurrencyLimit();
  assert.notEqual(atCeiling, null, 'AT the ceiling must already hold (>=, not >)');
  assert.equal(atCeiling?.inFlight, 3);
  assert.equal(atCeiling?.ceiling, 3);
  assert.match(atCeiling!.message, /3\/3/, 'the message names the exact in-flight/ceiling counts');
  assert.match(atCeiling!.message, /AGENT_DISPATCH_MAX_CONCURRENT/, 'the message names the env var that set it');

  // One more pushes it OVER — still held, count reflected accurately.
  seedTask('in_progress', WS_A);
  const overCeiling = checkDispatchConcurrencyLimit();
  assert.equal(overCeiling?.inFlight, 4);
  assert.equal(overCeiling?.ceiling, 3);
});

// ── (5) GLOBAL across workspaces — not per-workspace like checkWipLimit ─────
test('[FLEET-01] the count is GLOBAL across every workspace, not scoped per-workspace', () => {
  process.env.AGENT_DISPATCH_MAX_CONCURRENT = '3';
  // Spread 3 in-flight tasks across TWO different workspaces — none of them
  // alone would trip a per-workspace limit of 3, but the account-level
  // ceiling does not know or care about workspace boundaries.
  seedTask('in_progress', WS_A);
  seedTask('in_progress', WS_A);
  seedTask('in_progress', WS_B);
  assert.equal(countInFlightDispatches(), 3, 'the global count sums across both workspaces');

  const hold = checkDispatchConcurrencyLimit();
  assert.notEqual(hold, null, 'a global ceiling must trip even though NEITHER individual workspace hit 3 alone');
  assert.equal(hold?.inFlight, 3);

  // A NULL-workspace task also counts toward the same global total (unlike
  // checkWipLimit, which buckets NULL-workspace tasks against each other only).
  clearAllTasks();
  process.env.AGENT_DISPATCH_MAX_CONCURRENT = '2';
  seedTask('in_progress', null);
  seedTask('in_progress', WS_A);
  assert.equal(countInFlightDispatches(), 2, 'a NULL-workspace in_progress task counts toward the same global total');
  assert.notEqual(checkDispatchConcurrencyLimit(), null);
});

// ── (6) only status='in_progress' counts — other lanes are not "in flight" ──
test('only in_progress tasks count as in-flight — backlog/review/blocked/done never do', () => {
  process.env.AGENT_DISPATCH_MAX_CONCURRENT = '3';
  seedTask('backlog', WS_A);
  seedTask('review', WS_A);
  seedTask('blocked', WS_A);
  seedTask('done', WS_A);
  seedTask('testing', WS_A);
  assert.equal(countInFlightDispatches(), 0, 'none of these statuses are "in flight"');
  assert.equal(checkDispatchConcurrencyLimit(), null);
});

// ── (7) a freed slot immediately clears the hold ─────────────────────────────
test('a slot freed by a completed task immediately clears a prior hold', () => {
  process.env.AGENT_DISPATCH_MAX_CONCURRENT = '3';
  const ids = [seedTask('in_progress', WS_A), seedTask('in_progress', WS_A), seedTask('in_progress', WS_A)];
  assert.notEqual(checkDispatchConcurrencyLimit(), null, 'precondition: at ceiling, held');

  // One task completes (moves out of in_progress) — mirrors what the
  // agent-completion webhook does in production.
  run(`UPDATE tasks SET status = 'done' WHERE id = ?`, [ids[0]]);
  assert.equal(countInFlightDispatches(), 2);
  assert.equal(checkDispatchConcurrencyLimit(), null, 'freeing one slot must immediately clear the hold');
});
