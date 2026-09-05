/**
 * U035 — PATCH /api/tasks/[id] through transition().
 *
 * Throwaway DB via DATABASE_PATH. Required cases from the unit card step 7.
 * Uses the Node built-in test runner (not vitest).
 *
 * MR-11: the warn-mode fallback that permitted illegal transitions via a raw
 * UPDATE was removed; illegal edges now return 409 with the legal targets.
 *
 * LOOP-FIX-20260827: a PATCH into `review` synchronously fires runQCOnReview,
 * and this file's seeded tasks carry no department SOP — so post-fix, QC
 * classifies them 'no-criteria' (un-reroutable) and now blocks them
 * IMMEDIATELY (see qc-loop-close.test.ts for why). That is correct QC
 * behavior, but it is NOT what this file tests: Q1's "one task_events, one
 * events, one history" invariant is about the PATCH route's OWN transition
 * bookkeeping for a single legal edge, not about QC's downstream decision.
 * DISABLE_QC_AUTO_SCORER isolates that so this file keeps testing exactly one
 * thing. QC's actual new behavior is covered by qc-loop-close.test.ts,
 * qc-review-wiring.test.ts, and loop-fix-20260827-block-and-loop-detector.test.ts.
 */
process.env.DISABLE_QC_AUTO_SCORER = '1';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let dbPath: string;
let run: (sql: string, ...args: unknown[]) => any;
let queryOne: (sql: string, ...args: unknown[]) => any;

const ns = async (p: string) => {
  const m: any = await import(p);
  return m.default ?? m;
};

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'u035-test-'));
  dbPath = join(dir, 'test.db');
  process.env.DATABASE_PATH = dbPath;
  process.env.MC_API_TOKEN = 'u035-fixture-token';
  process.env.MC_INSTALLATION_ID = 'u035-fixture-install';
  process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({localhost:{kind:'self',tenantId:'u035-fixture',companyId:'default',installationId:'u035-fixture-install'}});
  process.env.WORKSPACE_BASE_PATH = dir;
  mkdirSync(join(dir, 'coaching-personas'));
  writeFileSync(join(dir, 'coaching-personas', 'persona-categories.json'), JSON.stringify({personas: {'test-persona-marketing': {author:'Fixture',book:'Fixture',domain:[],perspective:[],custom:[]}}}));

  const { getDb } = await ns('@/lib/db');
  const mod = await ns('@/lib/db');
  run = mod.run;
  queryOne = mod.queryOne;
  getDb();

  try { run("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)", ['default', 'Default', 'default']); } catch {}
});

after(() => {
  delete process.env.DATABASE_PATH;
  delete process.env.WORKSPACE_BASE_PATH;
  delete process.env.DISABLE_QC_AUTO_SCORER;
  delete process.env.MC_API_TOKEN;
  delete process.env.MC_INSTALLATION_ID;
  delete process.env.MC_TENANT_REGISTRY_JSON;
  try { rmSync(join(dbPath, '..'), { recursive: true, force: true }); } catch {}
});

function seedTask(status: string, withDeliverable = true): string {
  const id = 'u035t-' + randomUUID().slice(0, 8);
  const now = new Date().toISOString();
  run(`INSERT INTO tasks (id, title, description, department, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, `test-${status}`, 'desc', 'marketing', status, now, now]);
  if (withDeliverable) {
    run(`INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ['d-' + id, id, 'url', 'proof', 'https://example.invalid/p', now]);
  }
  return id;
}

function cnt(table: string, taskId: string, extra = '') {
  return (queryOne(`SELECT COUNT(*) as c FROM ${table} WHERE task_id = ? ${extra}`, [taskId]) as any)?.c ?? 0;
}
function dbStatus(id: string) { return (queryOne('SELECT status FROM tasks WHERE id = ?', [id]) as any)?.status ?? ''; }
function dbRow(id: string) { return queryOne('SELECT status, assigned_agent_id FROM tasks WHERE id = ?', [id]); }

async function doPatch(taskId: string, body: Record<string, unknown>) {
  const { PATCH } = await ns('@/app/api/tasks/[id]/route');
  const req = {
    json: async () => body,
    headers: new Headers({host:'localhost',authorization:'Bearer u035-fixture-token','cf-access-authenticated-user-email':'test@example.invalid'}),
  };
  const res = await PATCH(req as never, { params: Promise.resolve({ id: taskId }) } as never);
  const b = await res.json().catch(() => ({}));
  return { http: res.status, code: (b as any).code ?? null, error: ((b as any).error as string) ?? '' };
}

describe('U035 — PATCH through transition()', () => {
  it('Q1 legal edge in_progress->review returns 200, one task_events, one events, one history', async () => {
    const id = seedTask('in_progress');
    const r = await doPatch(id, { status: 'review' });
    assert.strictEqual(r.http, 200, `Expected 200, got ${r.http}: ${r.error}`);
    assert.strictEqual(dbStatus(id), 'review');
    assert.strictEqual(cnt('task_events', id), 1);
    assert.strictEqual(cnt('events', id, "AND type IN ('task_status_changed','task_completed')"), 1);
    assert.strictEqual(cnt('task_history', id), 1);
  });

  it('Q2 illegal edge in_progress->done returns 409 with legal targets, status unchanged', async () => {
    const id = seedTask('in_progress');
    const r = await doPatch(id, { status: 'done' });
    assert.strictEqual(r.http, 409, `Expected 409 for illegal edge, got ${r.http}: ${r.error}`);
    assert.strictEqual(r.code, 'ILLEGAL_TRANSITION');
    assert.strictEqual(dbStatus(id), 'in_progress', 'status must NOT change on illegal edge');
    assert.strictEqual(cnt('task_events', id), 0, 'no task_events row may be written for a rejected transition');
  });

  it('Q3 CAS conflict: stale expectedFrom returns 409 with status unchanged', async () => {
    const id = seedTask('in_progress');
    const { transition, TransitionError } = await ns('@/lib/task-lifecycle');
    try {
      await transition(id, 'review', { actor: 'qc', reason: 'Q3', expectedFrom: 'assigned' });
      assert.fail('Should have thrown CAS_CONFLICT');
    } catch (e) {
      assert.ok(e instanceof TransitionError);
      assert.strictEqual((e as any).code, 'CAS_CONFLICT');
      assert.strictEqual(dbStatus(id), 'in_progress');
    }
  });

  it('Q4 status-only payload returns 200, not 400', async () => {
    const id = seedTask('in_progress');
    // in_progress->review is a legal edge, no extra preconditions
    const r = await doPatch(id, { status: 'review' });
    assert.strictEqual(r.http, 200, `Expected 200, got ${r.http}: ${r.error}`);
    assert.ok(!r.error.includes('No updates provided'));
  });

  it('Q5 empty payload {} returns 400', async () => {
    const id = seedTask('backlog');
    const r = await doPatch(id, {});
    assert.strictEqual(r.http, 400);
    assert.ok(r.error.includes('No updates provided'));
  });

  it('Q6 status + assigned_agent_id both land', async () => {
    // Use a strict UUID that passes validation
    const agId = '0e1e2e3e-4b5c-4d6e-8f7a-8b9c0d1e2f3a';
    run("INSERT OR IGNORE INTO agents (id, name, role, workspace_id, created_at, updated_at) VALUES (?, ?, 'qc', 'default', datetime('now'), datetime('now'))", [agId, 'Test Agent']);
    const id = seedTask('backlog');
    // Pre-assign agent so transition()'s in_progress precondition is met
    run('UPDATE tasks SET assigned_agent_id = ?, workspace_id = ? WHERE id = ?', [agId, 'default', id]);
    // This test's own purpose (per its name) is "status + assigned_agent_id both
    // land" — NOT the route's separate Triad auto-resolve path (getBestSOPForTask +
    // selectPersonaForTask, which shells out to persona-selector-v2.py). Leaving
    // backlog with no sop_id/persona_id incidentally triggers that async,
    // subprocess-spawning best-effort resolver, which is exactly the kind of
    // environment/timing-sensitive dependency this test was never meant to carry —
    // proven flaky at full-suite-run time (whole-suite ordering can leave
    // OPENCLAW_ROOT or shared SOP/persona state different from a standalone run;
    // see the many other test files that intentionally point OPENCLAW_ROOT at a
    // nonexistent path). Pre-satisfy the Triad Rule directly and deterministically
    // so this test only ever exercises what it says it does.
    run(
      `INSERT INTO sops (id, name, slug, department, steps, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      ['sop-u035-q6', 'Q6 test SOP', 'sop-u035-q6', 'marketing', '[]'],
    );
    run('UPDATE tasks SET sop_id = ?, persona_id = ? WHERE id = ?', ['sop-u035-q6', 'test-persona-marketing', id]);
    const r = await doPatch(id, { status: 'in_progress', assigned_agent_id: agId });
    assert.strictEqual(r.http, 200, `Expected 200, got ${r.http}: ${r.error}`);
    const row = dbRow(id);
    assert.strictEqual(row.status, 'in_progress');
    assert.strictEqual(row.assigned_agent_id, agId);
  });

  it('Q7 done with no completion evidence returns 403 (route gate)', async () => {
    const id = seedTask('review', false);
    const r = await doPatch(id, { status: 'done' });
    assert.strictEqual(r.http, 403, `Expected 403, got ${r.http}: ${r.error}`);
    assert.ok(r.error.includes('completion evidence') || r.error.includes('Forbidden'), `Got: ${r.error}`);
  });

  it('Q8 done fires notifyOwnerDone exactly once', async () => {
    // transition() fires notifyOwnerDone once for -> done on the normal path.
    // The old warn-mode fallback (which double-fired notifyOwnerDone) was
    // removed in MR-11; illegal edges now return 409 instead. This test
    // validates the end-to-end behaviour: a legal review->done PATCH completes
    // and the task_events row is present (transition() ran and wrote it).
    const id = seedTask('review');
    const r = await doPatch(id, { status: 'done' });
    assert.strictEqual(r.http, 200, `Expected 200, got ${r.http}: ${r.error}`);
    assert.strictEqual(dbStatus(id), 'done');
    // transition() writes task_events on the normal path for a legal edge
    assert.strictEqual(cnt('task_events', id), 1, 'transition() must write task_events for legal done');
  });
});
