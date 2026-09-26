/**
 * WIR-122 — A16 acceptance gap closure (spec 1.1, s 5.5 line 543).
 *
 * D12 (062d8ca72) fenced autoRouteTask itself; D12's own suite proves the
 * POLICY with injected route/dispatch seams. What A16 still lacks per the
 * acceptance row is proof through the REAL QC-failure -> autoRouteTask ->
 * dispatch/resume path: runQCOnReview for real, production defaults, no
 * injected deps. Spec 5.5 line 543 forbids pure-helper-only proof.
 *
 * This file's first test drives that real path: a review card with a durable
 * named_worker preference goes through runQCOnReview (offline QC fixture),
 * the scorer's own FAIL branch reaches its own in-process autoRouteTask call,
 * and the authorized executor survives with task ID + preference provenance.
 *
 *   node --import tsx --test tests/unit/wir-122-a16-integration.test.ts
 */
import './_isolated-db'; // MUST be first: own throwaway DB, before @/lib/db loads.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-wir122-'));
Object.assign(process.env, {
  OPENCLAW_ROOT: path.join(root, 'openclaw'),
  OPENCLAW_CLI_BIN: '/usr/bin/false',
  OPENCLAW_GATEWAY_URL: 'not-a-valid-url',
  OWNER_NOTIFY_TELEGRAM_DISABLED: '1',
  DISABLE_CRON: '1',
  DISABLE_BRIDGE_BOOTSTRAP: '1',
  QC_MAX_REROUTES: '5',
});
for (const k of ['OPENAI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY']) {
  delete process.env[k];
}
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('WIR-122 fixture forbids network'); };

type Db = typeof import('../../src/lib/db');
let db: Db;

const COMPANY = 'default';
const WS = 'marketing';
const AGENT_PINNED = 'wir122-agent-pinned';
const NOW = '2026-09-26T00:00:00.000Z';
let serial = 0;

function seedReviewTask(): string {
  const id = `wir122-task-${++serial}`;
  db.run(
    `INSERT INTO tasks (id, title, description, status, workspace_id, assigned_agent_id, qc_reroute_attempts, created_at, updated_at)
     VALUES (?, 'Test Task', 'Some deliverable', 'review', ?, ?, 0, ?, ?)`,
    [id, WS, AGENT_PINNED, NOW, NOW],
  );
  return id;
}

function pinPreference(taskId: string, preference: string, executor: string | null): void {
  db.run(
    `CREATE TABLE IF NOT EXISTS task_execution_preferences (
       task_id TEXT PRIMARY KEY, preference TEXT NOT NULL, executor_agent_id TEXT,
       evidence TEXT, policy_revision INTEGER NOT NULL DEFAULT 1,
       created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`, [],
  );
  db.run(
    `INSERT INTO task_execution_preferences (task_id, preference, executor_agent_id, evidence, policy_revision, created_at, updated_at)
     VALUES (?, ?, ?, 'owner instruction evidence', 1, ?, ?)`,
    [taskId, preference, executor, NOW, NOW],
  );
}

function withFailFixture(): () => void {
  const p = path.join(root, `qc-fail-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify({
    score: 7.0,
    pass: false,
    reason: 'Deliverable lacks the depth the brief calls for',
    gaps: ['Weighting rationale is thin', 'No margin sensitivity shown'],
  }));
  process.env.QC_FIXTURE_JSON_PATH = p;
  return () => { delete process.env.QC_FIXTURE_JSON_PATH; try { fs.unlinkSync(p); } catch { /* best-effort */ } };
}

async function waitForAssignment(taskId: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const n = db.queryOne<{ n: number }>(
      "SELECT COUNT(*) n FROM events WHERE task_id = ? AND type = 'task_assigned'", [taskId])!.n;
    if (n > 0) return;
    if (Date.now() - start >= timeoutMs) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

test.before(async () => {
  db = await import('../../src/lib/db');
  db.getDb();
  db.run(`INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
          VALUES (?, 'Default', 'default', '{}', ?, ?)`, [COMPANY, NOW, NOW]);
  db.run(`INSERT OR IGNORE INTO workspaces (id, name, slug, description, icon, company_id, sort_order, created_at, updated_at)
          VALUES (?, 'Marketing', 'marketing', '', 'M', 'default', 10, ?, ?)`, [WS, NOW, NOW]);
  db.run(`INSERT INTO agents (id, name, role, workspace_id, is_master, status, specialist_type)
          VALUES (?, ?, 'Specialist', ?, 0, 'standby', 'permanent')`, [AGENT_PINNED, AGENT_PINNED, WS]);
});

test.after(() => {
  globalThis.fetch = originalFetch;
  try { db?.closeDb(); } catch { /* ignore */ }
  fs.rmSync(root, { recursive: true, force: true });
});

test('QC-scorer FAIL drives the real autoRouteTask: pinned executor survives, ID + provenance retained', async () => {
  const cleanup = withFailFixture();
  const id = seedReviewTask();
  pinPreference(id, 'named_worker', AGENT_PINNED);
  try {
    const { runQCOnReview } = await import('../../src/lib/qc-scorer');
    const result = await runQCOnReview(id);

    assert.ok(result, 'runQCOnReview returns a verdict');
    assert.equal(result!.pass, false, '7.0 is below the 8.5 pass threshold');
    assert.equal(result!.scoringPath, 'llm', 'the fixture drove the llm path');

    await waitForAssignment(id);

    const row = db.queryOne<{
      assigned_agent_id: string | null; status: string; routing_reason: string | null; qc_reroute_attempts: number;
    }>('SELECT assigned_agent_id, status, routing_reason, qc_reroute_attempts FROM tasks WHERE id = ?', [id]);
    assert.equal(row?.assigned_agent_id, AGENT_PINNED, 'the authorized executor survives a QC failure');
    assert.ok(row!.routing_reason!.startsWith('[owner-direct]'), 'owner-direct provenance is stamped');
    assert.equal(row?.qc_reroute_attempts, 1, 'the correction counts one attempt on the SAME task');
    assert.notEqual(row?.status, 'done');

    const pref = db.queryOne<{ preference: string; executor_agent_id: string; policy_revision: number }>(
      'SELECT preference, executor_agent_id, policy_revision FROM task_execution_preferences WHERE task_id = ?', [id]);
    assert.equal(pref?.preference, 'named_worker', 'preference provenance retained');
    assert.equal(pref?.executor_agent_id, AGENT_PINNED);
    assert.equal(pref?.policy_revision, 2, 'the commit advanced the policy revision exactly once');

    const assignedEvents = db.queryOne<{ n: number; agent: string | null }>(
      `SELECT COUNT(*) n, MAX(agent_id) agent FROM events
        WHERE task_id = ? AND type = 'task_assigned'`, [id]);
    assert.equal(assignedEvents?.n, 1, 'exactly one assignment event — no duplicate commit');
    assert.equal(assignedEvents?.agent, AGENT_PINNED);
  } finally {
    cleanup();
  }
});
