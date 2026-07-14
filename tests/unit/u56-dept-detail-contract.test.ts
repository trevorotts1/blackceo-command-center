/**
 * U56 (E.2 / JM-U52) — Department detail page: fix the two hard-wired-empty
 * pairs, purge demo seeds, contract tests.
 *
 * `/ceo-board/[dept]` drives four page/route pairs. Two were broken:
 *
 *   1. Department Agents — the page fetched `/api/agents?department=<slug>`
 *      and read `agentData.agents`; the route only read `workspace_id`
 *      (exact-id match) and returned a BARE array, so `.agents` was always
 *      `undefined` and real agents could never render.
 *   2. Department Recommendations — the page fetched
 *      `/api/recommendations?department=<slug>` and read
 *      `recData.recommendations`; the route read `department_id` (a
 *      DIFFERENT param name) and returned a BARE array — a double mismatch —
 *      AND auto-seeded 5 hardcoded demo rows into the live table on the
 *      first empty GET.
 *
 * Two were already correct (kpi-history, benchmarks) — contract tests here
 * pin that working behavior too, per the U56 "four contract tests" spec line,
 * so a future param-name or envelope regression on ANY of the four pairs is
 * caught here first.
 *
 * FAIL-FIRST PROOF: every "Department Agents" and "Department Recommendations"
 * test in this file fails against the pre-fix tree — confirmed during
 * development via `git stash` (route returns a bare array / wrong param name)
 * and re-run. The demo-seed tests fail against the pre-fix tree because
 * `seedRecommendationsIfEmpty()` still existed and unconditionally inserted 5
 * rows on the first empty GET.
 *
 * Isolation: `_isolated-db` (imported FIRST) points DATABASE_PATH at a unique
 * temp file per process, so this suite never touches the shared
 * mission-control.db other test files (or a live box) use.
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`).
 */

import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import Database from 'better-sqlite3';
import { run, queryOne } from '../../src/lib/db';
import { schema } from '../../src/lib/db/schema';
import { runMigrations } from '../../src/lib/db/migrations';

import { GET as agentsGET } from '../../src/app/api/agents/route';
import { GET as recommendationsGET } from '../../src/app/api/recommendations/route';
import { GET as kpiHistoryGET } from '../../src/app/api/kpi-history/route';
import { GET as benchmarksGET } from '../../src/app/api/benchmarks/route';

function req(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`, { method: 'GET' });
}

function seedWorkspace(opts: { id: string; slug: string; name: string }): void {
  run(
    `INSERT INTO workspaces (id, name, slug, description, icon) VALUES (?, ?, ?, ?, ?)`,
    [opts.id, opts.name, opts.slug, `${opts.name} department`, '🏢'],
  );
}

function seedAgent(opts: { id: string; name: string; workspaceId: string }): void {
  run(
    `INSERT INTO agents (id, name, role, workspace_id) VALUES (?, ?, ?, ?)`,
    [opts.id, opts.name, 'Specialist', opts.workspaceId],
  );
}

function seedRecommendation(opts: {
  id: string;
  departmentId: string;
  title: string;
  category?: string;
}): void {
  run(
    `INSERT INTO recommendations (id, department_id, category, title, description, confidence, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [opts.id, opts.departmentId, opts.category ?? 'watch', opts.title, 'test fixture row', 0.8, 'pending'],
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Pair 1 — Department Agents: GET /api/agents?department=<slug>
// BINARY (1): fixture with 2 real agents assigned to a department →
// "Department Agents" renders exactly those 2.
// ─────────────────────────────────────────────────────────────────────────

test('[U56] GET /api/agents?department=<slug> returns { agents: [...] } with exactly the department-scoped agents (defect closed)', async () => {
  const deptId = `ws-marketing-${uuidv4()}`;
  const otherId = `ws-sales-${uuidv4()}`;
  const slug = `marketing-${uuidv4().slice(0, 8)}`;
  seedWorkspace({ id: deptId, slug, name: 'Marketing' });
  seedWorkspace({ id: otherId, slug: `sales-${uuidv4().slice(0, 8)}`, name: 'Sales' });

  const a1 = uuidv4();
  const a2 = uuidv4();
  const outsider = uuidv4();
  seedAgent({ id: a1, name: 'Nova', workspaceId: deptId });
  seedAgent({ id: a2, name: 'Orion', workspaceId: deptId });
  // Agent in a DIFFERENT department — must never leak into this department's list.
  seedAgent({ id: outsider, name: 'Vega', workspaceId: otherId });

  // Resolve by slug — exactly how the page's deptId route param arrives.
  const res = await agentsGET(req(`/api/agents?department=${slug}`));
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(Array.isArray(json.agents), 'response envelope must carry an `agents` array key');
  const ids = json.agents.map((a: { id: string }) => a.id).sort();
  assert.deepEqual(ids, [a1, a2].sort(), 'exactly the 2 department-scoped agents, no more, no fewer');
  assert.ok(!ids.includes(outsider), 'an agent from a different department must never leak in');
});

test('[U56] GET /api/agents?department=<id> resolves by workspace id too (same resolveDepartment() the page uses)', async () => {
  const deptId = `ws-ops-${uuidv4()}`;
  seedWorkspace({ id: deptId, slug: `ops-${uuidv4().slice(0, 8)}`, name: 'Operations' });
  const a1 = uuidv4();
  seedAgent({ id: a1, name: 'Atlas', workspaceId: deptId });

  const res = await agentsGET(req(`/api/agents?department=${deptId}`));
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.deepEqual(json.agents.map((a: { id: string }) => a.id), [a1]);
});

test('[U56] GET /api/agents?department=<unknown> resolves to an empty envelope, never a 500', async () => {
  const res = await agentsGET(req(`/api/agents?department=no-such-department-${uuidv4()}`));
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.deepEqual(json.agents, []);
});

test('[U56] GET /api/agents (no params) still returns the enveloped shape (all consumers were updated to unwrap .agents)', async () => {
  const res = await agentsGET(req('/api/agents'));
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(Array.isArray(json.agents), 'bare-array regression check: response must be { agents: [...] }, not a bare array');
  assert.ok(!Array.isArray(json), 'GET /api/agents must never again return a bare top-level array');
});

test('[U56] GET /api/agents?workspace_id=<id> (existing exact-id callers: /workspace/[slug], AgentsSidebar) keeps exact-id scoping', async () => {
  const deptId = `ws-legal-${uuidv4()}`;
  seedWorkspace({ id: deptId, slug: `legal-${uuidv4().slice(0, 8)}`, name: 'Legal' });
  const a1 = uuidv4();
  seedAgent({ id: a1, name: 'Themis', workspaceId: deptId });

  const res = await agentsGET(req(`/api/agents?workspace_id=${deptId}`));
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.deepEqual(json.agents.map((a: { id: string }) => a.id), [a1]);
});

// ─────────────────────────────────────────────────────────────────────────
// BINARY (3) — fresh DB: no seed-on-read, empty envelope, count stays 0.
//
// ORDERING NOTE: this MUST run before any other test in this file inserts a
// `recommendations` row — it is the only test in the suite proving the
// literal "fresh DB has zero rows" half of BINARY (3), and this file's
// tests share one isolated DB (`_isolated-db`) that persists across the
// whole `node:test` run for this file. Pair 1 (agents) above never touches
// the `recommendations` table, so placing this immediately before Pair 2
// (which does) keeps the table genuinely empty at this point.
// ─────────────────────────────────────────────────────────────────────────

test('[U56] GET /api/recommendations on a fresh DB returns an empty envelope AND leaves SELECT COUNT(*) at 0 (no seed-on-read)', async () => {
  const before = queryOne<{ count: number }>('SELECT COUNT(*) as count FROM recommendations');
  assert.equal(before!.count, 0, 'sanity: the recommendations table must be genuinely empty at this point in the suite');
  const res = await recommendationsGET(req('/api/recommendations'));
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(Array.isArray(json.recommendations));
  assert.deepEqual(json.recommendations, [], 'a fresh DB must return an empty envelope, never seeded demo rows');
  const after = queryOne<{ count: number }>('SELECT COUNT(*) as count FROM recommendations');
  assert.equal(after!.count, 0, 'a GET must never insert rows — no seed-on-read, ever');
});

// ─────────────────────────────────────────────────────────────────────────
// Pair 2 — Department Recommendations: GET /api/recommendations?department_id=<id>
// BINARY (2): fixture with 3 real recommendation rows for the department →
// section renders exactly those 3.
// ─────────────────────────────────────────────────────────────────────────

test('[U56] GET /api/recommendations?department_id=<id> returns { recommendations: [...] } with exactly the department-scoped rows (defect closed)', async () => {
  const dept = `product-dept-${uuidv4()}`;
  const otherDept = `finance-dept-${uuidv4()}`;
  const r1 = uuidv4();
  const r2 = uuidv4();
  const r3 = uuidv4();
  const outsider = uuidv4();
  seedRecommendation({ id: r1, departmentId: dept, title: 'Row A' });
  seedRecommendation({ id: r2, departmentId: dept, title: 'Row B' });
  seedRecommendation({ id: r3, departmentId: dept, title: 'Row C' });
  seedRecommendation({ id: outsider, departmentId: otherDept, title: 'Row D (other dept)' });

  const res = await recommendationsGET(req(`/api/recommendations?department_id=${dept}`));
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(Array.isArray(json.recommendations), 'response envelope must carry a `recommendations` array key');
  const ids = json.recommendations.map((r: { id: string }) => r.id).sort();
  assert.deepEqual(ids, [r1, r2, r3].sort(), 'exactly the 3 department-scoped rows, no more, no fewer');
  assert.ok(!ids.includes(outsider), 'a recommendation from a different department must never leak in');
});

test('[U56] the /ceo-board/[dept] page param name (`department_id`) is what the route reads — a `department` param mismatch would silently return everything unscoped', async () => {
  const dept = `hr-dept-${uuidv4()}`;
  const other = `it-dept-${uuidv4()}`;
  seedRecommendation({ id: uuidv4(), departmentId: dept, title: 'Scoped row' });
  seedRecommendation({ id: uuidv4(), departmentId: other, title: 'Unscoped row' });

  // The WRONG param name (the pre-fix page's `department=`) must NOT scope —
  // proving the route only recognizes `department_id`, matching the (fixed)
  // page fetch exactly.
  const wrongParam = await recommendationsGET(req(`/api/recommendations?department=${dept}`));
  const wrongJson = await wrongParam.json();
  assert.ok(
    wrongJson.recommendations.length >= 2,
    'an unrecognized `department` param must not accidentally scope — this pins the exact param name the page must use',
  );

  const rightParam = await recommendationsGET(req(`/api/recommendations?department_id=${dept}`));
  const rightJson = await rightParam.json();
  assert.equal(rightJson.recommendations.length, 1);
});

// ─────────────────────────────────────────────────────────────────────────
// BINARY (3, migration half) — cleanup migration purges the 5 legacy seeded
// rows by exact (department_id, title) fingerprint, and ONLY those rows.
// ─────────────────────────────────────────────────────────────────────────

const LEGACY_DEMO_FINGERPRINTS: Array<{ department_id: string; title: string }> = [
  { department_id: 'marketing-dept', title: 'Double Down on Email Campaigns' },
  { department_id: 'sales-dept', title: 'Pause Cold Calling Campaign' },
  { department_id: 'operations-dept', title: 'Monitor Task Completion Times' },
  { department_id: 'finance-dept', title: 'Automate Invoice Reminders' },
  { department_id: 'product-dept', title: 'Expand User Testing Program' },
];

/**
 * Open a BRAND NEW, throwaway SQLite file, apply the base schema (mirroring
 * `getDb()`'s own boot order), and insert the given rows BEFORE any
 * migration has run — simulating a legacy box that seeded these rows before
 * migration 102 existed. Returns the raw handle; caller closes it.
 */
function openLegacyDbWithDemoRowsPreSeeded(): Database.Database {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-u56-migration-')), 'legacy.db');
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  const insert = db.prepare(
    `INSERT INTO recommendations (id, department_id, category, title, description, confidence, status)
     VALUES (?, ?, 'watch', ?, 'legacy fixture', 0.8, 'pending')`,
  );
  for (const fp of LEGACY_DEMO_FINGERPRINTS) {
    insert.run(uuidv4(), fp.department_id, fp.title);
  }
  return db;
}

test('[U56] a legacy DB with the 5 pre-existing demo rows is purged by a normal boot (runMigrations reaches migration 102) — operator rows untouched', () => {
  const db = openLegacyDbWithDemoRowsPreSeeded();
  try {
    // An operator-authored row sharing a department_id but NOT the exact
    // seeded title — must survive the purge untouched.
    const operatorRowId = uuidv4();
    db.prepare(
      `INSERT INTO recommendations (id, department_id, category, title, description, confidence, status)
       VALUES (?, 'marketing-dept', 'watch', ?, 'operator fixture', 0.8, 'pending')`,
    ).run(operatorRowId, 'Real operator recommendation about Q3 spend');

    const before = db.prepare('SELECT COUNT(*) as count FROM recommendations').get() as { count: number };
    assert.equal(before.count, LEGACY_DEMO_FINGERPRINTS.length + 1, 'sanity: all 6 fixture rows present pre-migration');

    // Drive the REAL production boot path — every migration in numeric
    // order, including 102 — exactly what getDb() does on a real box.
    runMigrations(db);

    for (const fp of LEGACY_DEMO_FINGERPRINTS) {
      const row = db
        .prepare('SELECT id FROM recommendations WHERE department_id = ? AND title = ?')
        .get(fp.department_id, fp.title);
      assert.equal(row, undefined, `seeded fingerprint (${fp.department_id}, "${fp.title}") must be deleted`);
    }

    const survivor = db.prepare('SELECT id FROM recommendations WHERE id = ?').get(operatorRowId);
    assert.ok(survivor, 'an operator-authored row sharing a department_id but NOT the exact seeded title must survive');

    // Idempotent: running migrations again (a normal second boot) is a no-op
    // on row count — migration 102 is already recorded applied.
    const before2 = db.prepare('SELECT COUNT(*) as count FROM recommendations').get() as { count: number };
    runMigrations(db);
    const after2 = db.prepare('SELECT COUNT(*) as count FROM recommendations').get() as { count: number };
    assert.equal(after2.count, before2.count, 're-running the migration boot path must be a no-op');
  } finally {
    db.close();
  }
});

test('[U56] migration 102 is DEFERRED under OPENCLAW_MIGRATE_SELF_HEAL_ADDITIVE_ONLY=1 (destructive DELETE, INGEST-07 convention) and applies on the next controlled boot', () => {
  const db = openLegacyDbWithDemoRowsPreSeeded();
  const prevFlag = process.env.OPENCLAW_MIGRATE_SELF_HEAL_ADDITIVE_ONLY;
  try {
    process.env.OPENCLAW_MIGRATE_SELF_HEAL_ADDITIVE_ONLY = '1';
    runMigrations(db);

    // Deferred: the demo rows must still be present (migration 102 was
    // skipped, not recorded as applied) — request-time self-heal must never
    // race a destructive DELETE against live ingest.
    const stillPresent = db
      .prepare('SELECT COUNT(*) as count FROM recommendations WHERE department_id = ? AND title = ?')
      .get(LEGACY_DEMO_FINGERPRINTS[0].department_id, LEGACY_DEMO_FINGERPRINTS[0].title) as { count: number };
    assert.equal(stillPresent.count, 1, 'migration 102 must be DEFERRED (not applied) while additive-only self-heal is set');

    // Next controlled boot (flag unset) — migration 102 now runs and purges.
    delete process.env.OPENCLAW_MIGRATE_SELF_HEAL_ADDITIVE_ONLY;
    runMigrations(db);
    const afterControlledBoot = db
      .prepare('SELECT COUNT(*) as count FROM recommendations WHERE department_id = ? AND title = ?')
      .get(LEGACY_DEMO_FINGERPRINTS[0].department_id, LEGACY_DEMO_FINGERPRINTS[0].title) as { count: number };
    assert.equal(afterControlledBoot.count, 0, 'the deferred migration must apply on the next controlled (non-self-heal) boot');
  } finally {
    if (prevFlag === undefined) delete process.env.OPENCLAW_MIGRATE_SELF_HEAL_ADDITIVE_ONLY;
    else process.env.OPENCLAW_MIGRATE_SELF_HEAL_ADDITIVE_ONLY = prevFlag;
    db.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────
// BINARY (5) — no reference to DEMO_RECOMMENDATIONS outside the cleanup
// migration and tests.
// ─────────────────────────────────────────────────────────────────────────

test('[U56] repository-wide: no reference to DEMO_RECOMMENDATIONS outside src/lib/db/migrations.ts and tests', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const repoRoot = process.cwd();
  const skipDirs = new Set(['node_modules', '.next', '.git', 'tests']);
  const hits: string[] = [];

  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skipDirs.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
        const rel = path.relative(repoRoot, full);
        if (rel === path.join('src', 'lib', 'db', 'migrations.ts')) continue;
        const content = fs.readFileSync(full, 'utf-8');
        if (content.includes('DEMO_RECOMMENDATIONS')) hits.push(rel);
      }
    }
  }
  walk(path.join(repoRoot, 'src'));

  assert.deepEqual(hits, [], `DEMO_RECOMMENDATIONS must only appear in the cleanup migration and tests, found in: ${hits.join(', ')}`);
});

// ─────────────────────────────────────────────────────────────────────────
// Pair 3 — kpi-history (ALREADY correct; pinned so a future regression on
// ANY of the four /ceo-board/[dept] pairs is caught, per the U56 "four
// contract tests" spec line).
// ─────────────────────────────────────────────────────────────────────────

test('[U56] GET /api/kpi-history?department_id=<id> returns { data: [...] } scoped to the department (page/route pair already correct)', async () => {
  const dept = `creative-dept-${uuidv4()}`;
  run(
    `INSERT INTO kpi_snapshots (id, department_id, kpi_id, kpi_name, value, target, unit, snapshot_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, date('now'))`,
    [uuidv4(), dept, 'output', 'Content Output', 12, 15, 'count'],
  );
  const res = await kpiHistoryGET(req(`/api/kpi-history?department_id=${dept}&days=30`));
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(Array.isArray(json.data), 'response envelope must carry a `data` array key');
  assert.equal(json.data.length, 1);
  assert.equal(json.data[0].department_id, dept);
});

// ─────────────────────────────────────────────────────────────────────────
// Pair 4 — benchmarks (ALREADY correct; pinned for the same reason).
// ─────────────────────────────────────────────────────────────────────────

test('[U56] GET /api/benchmarks?department=<key> returns { benchmarks: [...] } (page/route pair already correct)', async () => {
  const res = await benchmarksGET(req('/api/benchmarks?department=marketing'));
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(Array.isArray(json.benchmarks), 'response envelope must carry a `benchmarks` array key');
  assert.ok(json.benchmarks.length > 0);
});
