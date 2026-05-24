/**
 * Smoke test for SOP Layer 3.
 *
 * Drops/recreates a throwaway DB, seeds it with enough completed tasks to
 * trip the pattern detector, runs the job, and prints what it produced.
 *
 * Usage:
 *   DATABASE_PATH=/tmp/sop-smoke.db npx tsx scripts/smoke-test-sop-learning.ts
 */
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import Database from 'better-sqlite3';
import { getDb, run } from '@/lib/db';
import { detectPatternsAndPropose, recordFeedback, computePerformance } from '@/lib/sop-learning';

const DB_PATH = process.env.DATABASE_PATH || '/tmp/sop-smoke.db';

function reset() {
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  const wal = DB_PATH + '-wal';
  const shm = DB_PATH + '-shm';
  if (fs.existsSync(wal)) fs.unlinkSync(wal);
  if (fs.existsSync(shm)) fs.unlinkSync(shm);
}

// Workaround for a pre-existing bug in migration 020 (da_challenges) that's
// unrelated to Layer 3 — schema.ts already creates da_challenges with a
// different column set than migration 020 expects, so the index creation
// blows up on fresh DBs. Pre-mark it as applied BEFORE getDb() so the smoke
// test can exercise migration 023.
function preMarkBuggyMigration() {
  const tmp = new Database(DB_PATH);
  tmp.exec(`CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT DEFAULT (datetime('now')))`);
  tmp.prepare('INSERT OR IGNORE INTO _migrations (id, name) VALUES (?, ?)').run('020', 'skipped-by-smoke-test');
  tmp.close();
}

function seed() {
  const db = getDb();
  // Make sure FK targets exist: companies -> workspaces -> tasks.
  db.prepare(`INSERT OR IGNORE INTO companies (id, name, slug) VALUES ('default', 'Default', 'default')`).run();
  db.prepare(`INSERT OR IGNORE INTO workspaces (id, name, slug, company_id) VALUES ('default', 'Default', 'default', 'default')`).run();
  db.prepare(`INSERT OR IGNORE INTO workspaces (id, name, slug, company_id) VALUES ('marketing', 'Marketing', 'marketing', 'default')`).run();

  // Cluster 1: 6 marketing tasks about "landing page conversion testing", no sop_id
  for (let i = 0; i < 6; i++) {
    run(
      `INSERT INTO tasks (id, title, description, status, workspace_id, created_at, updated_at)
       VALUES (?, ?, ?, 'done', 'marketing', datetime('now'), datetime('now'))`,
      [
        uuidv4(),
        `Landing page conversion optimization test ${i + 1}`,
        `1. Pull current conversion baseline from analytics\n2. Identify hypothesis for landing page improvement\n3. Build variant in figma\n4. Launch A/B test with conversion tracking\n5. Analyze conversion delta`,
      ]
    );
  }

  // Cluster 2: 5 marketing tasks about "email newsletter campaign send", no sop_id
  for (let i = 0; i < 5; i++) {
    run(
      `INSERT INTO tasks (id, title, description, status, workspace_id, created_at, updated_at)
       VALUES (?, ?, ?, 'done', 'marketing', datetime('now'), datetime('now'))`,
      [
        uuidv4(),
        `Email newsletter campaign send ${i + 1}`,
        `- Draft newsletter copy\n- Get copy approved\n- Schedule send in Mailchimp\n- Monitor delivery and engagement`,
      ]
    );
  }

  // Cluster 3 (noise): 2 tasks that share no pattern
  run(
    `INSERT INTO tasks (id, title, description, status, workspace_id, created_at, updated_at)
     VALUES (?, ?, ?, 'done', 'default', datetime('now'), datetime('now'))`,
    [uuidv4(), 'Fix flaky CI test', 'one-off']
  );
  run(
    `INSERT INTO tasks (id, title, description, status, workspace_id, created_at, updated_at)
     VALUES (?, ?, ?, 'done', 'default', datetime('now'), datetime('now'))`,
    [uuidv4(), 'Renew domain ssl', 'one-off']
  );

  // Seed one existing SOP to test the feedback / performance loop
  const existingSopId = uuidv4();
  run(
    `INSERT INTO sops (id, name, slug, version, department, task_keywords, steps, created_at, updated_at)
     VALUES (?, 'Existing test SOP', 'existing-test-sop', 1, 'marketing', 'test', '[{"name":"Do the thing"}]', datetime('now'), datetime('now'))`,
    [existingSopId]
  );

  // Create one task linked to existing SOP so feedback has a target
  const taskWithSopId = uuidv4();
  run(
    `INSERT INTO tasks (id, title, description, status, workspace_id, sop_id, created_at, updated_at)
     VALUES (?, 'Task using existing SOP', 'desc', 'done', 'marketing', ?, datetime('now'), datetime('now'))`,
    [taskWithSopId, existingSopId]
  );

  // Two thumbs-up, one thumbs-down
  recordFeedback({ sop_id: existingSopId, task_id: taskWithSopId, rating: 1, notes: 'worked great' });
  recordFeedback({ sop_id: existingSopId, task_id: taskWithSopId, rating: 1, notes: null });
  recordFeedback({ sop_id: existingSopId, task_id: taskWithSopId, rating: -1, notes: 'step 1 unclear' });

  return existingSopId;
}

async function main() {
  console.log(`[smoke] using DB: ${DB_PATH}`);
  reset();
  preMarkBuggyMigration();
  const existingSopId = seed();
  console.log('[smoke] seeded 13 completed tasks + 1 existing SOP + 3 feedback rows');

  console.log('\n[smoke] running detectPatternsAndPropose...');
  const result = detectPatternsAndPropose();
  console.log(JSON.stringify(result, null, 2));

  const db = getDb();
  const proposals = db.prepare('SELECT id, proposed_name, proposed_department, evidence_summary FROM sop_proposals').all();
  console.log('\n[smoke] proposals in db:');
  for (const p of proposals) console.log(`  - ${JSON.stringify(p)}`);

  console.log('\n[smoke] computing performance for the existing SOP...');
  const perf = computePerformance(existingSopId, 30);
  console.log(JSON.stringify(perf, null, 2));

  // Acceptance assertions
  const pass = result.proposals_created >= 1 && perf.feedback_count === 3 && perf.score > 0;
  console.log(pass ? '\n[smoke] PASS' : '\n[smoke] FAIL');
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error('[smoke] failed:', err);
  process.exit(1);
});
