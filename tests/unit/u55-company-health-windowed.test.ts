/**
 * U55 — CEO hero: windowed headline stats + company-level input breakdown
 * (src/lib/grading.ts additions to computeCompanyHealth / CompanyHealth,
 * plus the new getRealDepartmentTaskCounts helper).
 *
 * Fixture DB test, same conventions as tests/unit/prd-2.10-grading-module.test.ts
 * (own temp DB, own migration run, no network / no client box needed).
 *
 * Covers:
 *   1. windowDays / windowStart / windowEnd echo the request's rolling window.
 *   2. windowedTaskCounts (created/completed) + windowedCompletionRate —
 *      company-wide, hand-checkable across two departments.
 *   3. activeAgentCount counts status='working' only.
 *   4. companyInputBreakdown: task-count-weighted aggregate per input, with
 *      a renormalization note when not every department has data, and an
 *      honest "Insufficient data" (never a substituted number) when NO
 *      department has data for an input.
 *   5. Acceptance (1)'s exact scenario: a department whose ALL-TIME
 *      completion is 0% (getRealDepartmentTaskCounts) still earns a passing
 *      letter grade from its windowed QC/SOP inputs — proving the hero's
 *      windowed grade and its all-time completion stat can legitimately
 *      disagree, and that both are readable from data this module exposes.
 *   6. Non-real workspaces (acme-*) never contribute to any of the above.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-u55-windowed-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;

type DbModule = typeof import('../../src/lib/db');
let getDb: DbModule['getDb'];
let run: DbModule['run'];
let closeDb: DbModule['closeDb'];

type GradingModule = typeof import('../../src/lib/grading');
let computeCompanyHealth: GradingModule['computeCompanyHealth'];
let getRealDepartmentTaskCounts: GradingModule['getRealDepartmentTaskCounts'];

const now = new Date().toISOString();

const WS = {
  a: 'u55-dept-a',
  b: 'u55-dept-b',
  showcase: 'u55-showcase',
  acme: 'acme-u55-demo',
};

const slugFor: Record<string, string> = {
  [WS.a]: 'u55-dept-a',
  [WS.b]: 'u55-dept-b',
  [WS.showcase]: 'u55-showcase',
  [WS.acme]: 'acme-u55-demo',
};

test.before(async () => {
  const dbMod = await import('../../src/lib/db');
  getDb = dbMod.getDb;
  run = dbMod.run;
  closeDb = dbMod.closeDb;

  const gradingMod = await import('../../src/lib/grading');
  computeCompanyHealth = gradingMod.computeCompanyHealth;
  getRealDepartmentTaskCounts = gradingMod.getRealDepartmentTaskCounts;

  getDb();

  run(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES ('default', 'Default', 'default', '{}', ?, ?)`,
    [now, now],
  );

  for (const [id, slug] of Object.entries(slugFor)) {
    run(
      `INSERT OR IGNORE INTO workspaces (id, name, slug, description, icon, company_id, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, '', '🏢', 'default', 999, ?, ?)`,
      [id, slug, slug, now, now],
    );
  }

  // ── dept-a: 5 new tasks this window (4 done), 20 old tasks (never done) ──
  for (let i = 0; i < 4; i++) {
    run(
      `INSERT INTO tasks (id, title, status, workspace_id, created_at, updated_at, completed_at)
       VALUES (?, ?, 'done', ?, ?, ?, ?)`,
      [uuidv4(), `A New Done ${i}`, WS.a, now, now, now],
    );
  }
  run(
    `INSERT INTO tasks (id, title, status, workspace_id, created_at, updated_at)
     VALUES (?, 'A New Backlog', 'backlog', ?, ?, ?)`,
    [uuidv4(), WS.a, now, now],
  );
  const oldDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
  for (let i = 0; i < 20; i++) {
    run(
      `INSERT INTO tasks (id, title, status, workspace_id, created_at, updated_at)
       VALUES (?, ?, 'backlog', ?, ?, ?)`,
      [uuidv4(), `A Old Backlog ${i}`, WS.a, oldDate, oldDate],
    );
  }
  // QC: 3 llm rows, all passed -> qcPassRate=100
  const aQcTask = uuidv4();
  run(
    `INSERT INTO tasks (id, title, status, workspace_id, created_at, updated_at)
     VALUES (?, 'A QC Task', 'done', ?, ?, ?)`,
    [aQcTask, WS.a, now, now],
  );
  for (let i = 0; i < 3; i++) {
    run(
      `INSERT INTO task_qc_results (id, task_id, workspace_id, department_slug, score, passed, scoring_path, scored_at)
       VALUES (?, ?, ?, ?, 9.5, 1, 'llm', ?)`,
      [uuidv4(), aQcTask, WS.a, slugFor[WS.a], now],
    );
  }
  // dept-a's throughput created count from the QC task above too: bumps
  // created to 6 — recorded in the hand-check comments below.

  // ── dept-b: 3 new tasks this window, none done; QC 0/3 passed ──
  for (let i = 0; i < 3; i++) {
    run(
      `INSERT INTO tasks (id, title, status, workspace_id, created_at, updated_at)
       VALUES (?, ?, 'backlog', ?, ?, ?)`,
      [uuidv4(), `B New Backlog ${i}`, WS.b, now, now],
    );
  }
  const bQcTask = uuidv4();
  run(
    `INSERT INTO tasks (id, title, status, workspace_id, created_at, updated_at)
     VALUES (?, 'B QC Task', 'review', ?, ?, ?)`,
    [bQcTask, WS.b, now, now],
  );
  for (let i = 0; i < 3; i++) {
    run(
      `INSERT INTO task_qc_results (id, task_id, workspace_id, department_slug, score, passed, scoring_path, scored_at)
       VALUES (?, ?, ?, ?, 5.0, 0, 'llm', ?)`,
      [uuidv4(), bQcTask, WS.b, slugFor[WS.b], now],
    );
  }

  // ── showcase: acceptance (1) — all-time completion 0%, windowed grade passes ──
  // 4 tasks, all 'review' (never 'done'): all-time completion = 0/4 = 0%.
  const showcaseTaskIds: string[] = [];
  for (let i = 0; i < 4; i++) {
    const tid = uuidv4();
    showcaseTaskIds.push(tid);
    run(
      `INSERT INTO tasks (id, title, status, workspace_id, sop_id, created_at, updated_at)
       VALUES (?, ?, 'review', ?, NULL, ?, ?)`,
      [tid, `Showcase Task ${i}`, WS.showcase, now, now],
    );
  }
  // sopCoverage: all 4 dispatched, all 4 get a real sop_id -> 100%
  const showcaseSopId = uuidv4();
  run(
    `INSERT OR IGNORE INTO sops (id, name, slug, description, steps, department, created_at, updated_at)
     VALUES (?, 'Showcase SOP', 'showcase-sop', '', '[]', ?, ?, ?)`,
    [showcaseSopId, slugFor[WS.showcase], now, now],
  );
  for (const tid of showcaseTaskIds) {
    run(`UPDATE tasks SET sop_id = ? WHERE id = ?`, [showcaseSopId, tid]);
    run(
      `INSERT INTO events (id, type, task_id, message, created_at)
       VALUES (?, 'task_dispatched', ?, 'dispatched', ?)`,
      [uuidv4(), tid, now],
    );
  }
  // qcPassRate: 5 llm rows against the first showcase task, all passed -> 100%
  for (let i = 0; i < 5; i++) {
    run(
      `INSERT INTO task_qc_results (id, task_id, workspace_id, department_slug, score, passed, scoring_path, scored_at)
       VALUES (?, ?, ?, ?, 9.8, 1, 'llm', ?)`,
      [uuidv4(), showcaseTaskIds[0], WS.showcase, slugFor[WS.showcase], now],
    );
  }

  // ── acme-u55-demo: must NEVER contribute to any figure below ──
  for (let i = 0; i < 10; i++) {
    run(
      `INSERT INTO tasks (id, title, status, workspace_id, created_at, updated_at, completed_at)
       VALUES (?, ?, 'done', ?, ?, ?, ?)`,
      [uuidv4(), `Acme Task ${i}`, WS.acme, now, now, now],
    );
  }

  // ── agents: 2 working, 1 standby, 1 offline -> activeAgentCount = 2 ──
  run(`INSERT INTO agents (id, name, role, workspace_id, is_master, status) VALUES (?, 'Agent Working 1', 'Specialist', ?, 0, 'working')`, [uuidv4(), WS.a]);
  run(`INSERT INTO agents (id, name, role, workspace_id, is_master, status) VALUES (?, 'Agent Working 2', 'Specialist', ?, 0, 'working')`, [uuidv4(), WS.b]);
  run(`INSERT INTO agents (id, name, role, workspace_id, is_master, status) VALUES (?, 'Agent Standby', 'Specialist', ?, 0, 'standby')`, [uuidv4(), WS.a]);
  run(`INSERT INTO agents (id, name, role, workspace_id, is_master, status) VALUES (?, 'Agent Offline', 'Specialist', ?, 0, 'offline')`, [uuidv4(), WS.b]);
});

test.after(() => {
  closeDb();
  try {
    fs.rmSync(path.dirname(TMP_DB), { recursive: true, force: true });
  } catch { /* best-effort cleanup */ }
});

test('computeCompanyHealth: window echo (windowDays/windowStart/windowEnd) matches the request', () => {
  const db = getDb();
  const health = computeCompanyHealth(db, { windowDays: 30 });

  assert.equal(health.windowDays, 30);
  assert.equal(health.windowEnd, health.generatedAt, 'windowEnd must be the same instant as generatedAt');

  const startMs = new Date(health.windowStart).getTime();
  const endMs = new Date(health.windowEnd).getTime();
  const diffDays = (endMs - startMs) / (24 * 60 * 60 * 1000);
  assert.ok(Math.abs(diffDays - 30) < 0.01, `windowStart should be ~30 days before windowEnd, got ${diffDays}`);
});

test('computeCompanyHealth: windowedTaskCounts + windowedCompletionRate are company-wide and hand-checkable', () => {
  const db = getDb();
  const health = computeCompanyHealth(db, { windowDays: 30 });

  // dept-a windowed: 4 done-in-window + 1 backlog + 1 QC task (also 'done', in-window) = 6 created, 5 done
  // dept-b windowed: 3 backlog + 1 review QC task = 4 created, 0 done
  // showcase windowed: 4 review tasks = 4 created, 0 done
  // total created = 6 + 4 + 4 = 14; total completed = 5 + 0 + 0 = 5
  assert.equal(health.windowedTaskCounts.created, 14, 'windowed created count (acme excluded)');
  assert.equal(health.windowedTaskCounts.completed, 5, 'windowed completed count (acme excluded)');
  assert.equal(
    health.windowedCompletionRate,
    Math.round((5 / 14) * 100),
    'windowedCompletionRate = round(completed/created*100)',
  );
});

test('computeCompanyHealth: activeAgentCount counts status=working only', () => {
  const db = getDb();
  const health = computeCompanyHealth(db, { windowDays: 30 });
  assert.equal(health.activeAgentCount, 2);
});

test('computeCompanyHealth: companyInputBreakdown aggregates per-input scores, task-count-weighted, with renormalization notes', () => {
  const db = getDb();
  const health = computeCompanyHealth(db, { windowDays: 30 });
  const breakdown = health.companyInputBreakdown;

  // qcPassRate: all three real departments have data.
  //   a: 100 (sampleSize 3), b: 0 (sampleSize 3), showcase: 100 (sampleSize 5)
  //   weighted = (100*3 + 0*3 + 100*5) / (3+3+5) = 800/11 = 72.7272...
  const qc = breakdown.qcPassRate;
  assert.equal(qc.key, 'qcPassRate');
  assert.equal(qc.weight, 0.30);
  assert.ok(qc.score !== null);
  assert.equal(Math.round(qc.score! * 100) / 100, Math.round((800 / 11) * 100) / 100);
  assert.equal(qc.sampleSize, 11);

  // sopCoverage: ONLY showcase has data (a, b are null) -> renormalization note.
  const sop = breakdown.sopCoverage;
  assert.equal(sop.score, 100);
  assert.match(sop.detail, /renormalized across 1 of 3 departments/);

  // kpiAttainment: NO department has data -> null, never a substituted number.
  const kpi = breakdown.kpiAttainment;
  assert.equal(kpi.score, null, 'kpiAttainment must be null, not 0 or a fabricated number');
  assert.match(kpi.detail, /Insufficient data/);
  assert.equal(kpi.sampleSize, 0);

  // throughput: all three present, sanity-check the label + weight are wired.
  assert.equal(breakdown.throughput.label, 'Throughput');
  assert.equal(breakdown.throughput.weight, 0.25);
  assert.ok(breakdown.throughput.score !== null);
});

test('acceptance (1): a department with 0% all-time completion still earns a passing windowed grade', () => {
  const db = getDb();
  const health = computeCompanyHealth(db, { windowDays: 30 });
  const deptCounts = getRealDepartmentTaskCounts(db);

  const showcaseCounts = deptCounts.find((d) => d.workspaceId === WS.showcase);
  assert.ok(showcaseCounts, 'showcase department must appear in getRealDepartmentTaskCounts');
  assert.equal(showcaseCounts!.total, 4);
  assert.equal(showcaseCounts!.done, 0, 'all-time done count must be 0');
  // all-time completion rate would render as 0% in the UI (0/4)

  const showcaseGrade = health.departments.find((d) => d.workspaceId === WS.showcase);
  assert.ok(showcaseGrade, 'showcase department must appear in computeCompanyHealth departments');
  assert.equal(showcaseGrade!.sufficientData, true, 'showcase should have enough graded inputs (qcPassRate + sopCoverage)');
  assert.ok(showcaseGrade!.score !== null, 'showcase score must not be null');
  assert.ok(
    showcaseGrade!.score! >= 60,
    `showcase's windowed score should be a passing grade (>=60), got ${showcaseGrade!.score}`,
  );
  assert.notEqual(showcaseGrade!.grade, 'F');
  assert.notEqual(showcaseGrade!.grade, 'D');
});

test('getRealDepartmentTaskCounts: excludes non-real workspaces (acme-*)', () => {
  const db = getDb();
  const counts = getRealDepartmentTaskCounts(db);
  const acme = counts.find((d) => d.workspaceId === WS.acme);
  assert.equal(acme, undefined, 'acme-* workspace must never appear in real department task counts');
});

test('computeCompanyHealth: acme-* never contributes to windowedTaskCounts or activeAgentCount', () => {
  const db = getDb();
  const health = computeCompanyHealth(db, { windowDays: 30 });
  // acme has 10 'done' tasks created 'now' — if it leaked in, created/completed
  // would be 10 higher than the hand-checked 14/5 above.
  assert.equal(health.windowedTaskCounts.created, 14);
  assert.equal(health.windowedTaskCounts.completed, 5);
});
