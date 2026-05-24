/**
 * Track S — End-to-end smoke test.
 *
 * Per Trevor's safety rules (MEMORY.md), live Tavily + Gemini calls are
 * forbidden during smoke. This test:
 *   1. Spins up a throwaway SQLite db (MISSION_CONTROL_DB env override)
 *   2. Seeds 1 SOP + 3 tasks pointing at it
 *   3. Soft-deletes the SOP via the same code path the API uses
 *   4. Runs `enqueueAutoReplace` with fixture-backed Tavily + Gemini
 *   5. Asserts: proposal row created, status='auto-generated-pending-review',
 *      replaces_sop_id set, confidence captured, research_sources captured
 *   6. Approves the proposal and asserts: v2 SOP inserted, all 3 tasks
 *      now point at v2 (atomic swap verified), proposal status='approved'
 *
 * Run:  npx tsx scripts/smoke-test-sop-auto-replace.ts
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { v4 as uuidv4 } from 'uuid';

// Force a fresh SQLite path BEFORE importing anything that opens the db.
const tmpDb = path.join(os.tmpdir(), `sop-auto-replace-smoke-${Date.now()}.db`);
process.env.DATABASE_PATH = tmpDb;
process.env.MISSION_CONTROL_DB_PATH = tmpDb;

// Force fixtures so Tavily + Gemini are never live-called.
process.env.TAVILY_FIXTURE_JSON_PATH = path.resolve(__dirname, 'fixtures/tavily-sample.json');
process.env.GEMINI_FIXTURE_JSON_PATH = path.resolve(__dirname, 'fixtures/gemini-sample.json');
process.env.SOP_AUTO_REPLACE_TELEGRAM_DISABLED = '1';
process.env.OPENCLAW_WORKSPACE_PATH = path.join(os.tmpdir(), `sop-smoke-ws-${Date.now()}`);

// Seed a fake workspace so SOUL.md/USER.md reads succeed.
fs.mkdirSync(process.env.OPENCLAW_WORKSPACE_PATH, { recursive: true });
fs.writeFileSync(
  path.join(process.env.OPENCLAW_WORKSPACE_PATH, 'SOUL.md'),
  '# Soul\nProfessional, direct, no fluff. Reads like a senior operator briefing.'
);
fs.writeFileSync(
  path.join(process.env.OPENCLAW_WORKSPACE_PATH, 'USER.md'),
  '# User\nFounder values speed and clarity. Hates platitudes.'
);

// Dynamically import everything that opens the db AFTER env is set.
async function run() {
  // Pre-initialize the DB to work around a pre-existing migration 020 bug on
  // the base branch (fix is in flight as PR #11). Pre-register migration 020
  // as already-applied so runMigrations skips it. The Track S smoke test
  // doesn't exercise da_challenges, so this is safe.
  {
    const Database = (await import('better-sqlite3')).default;
    const seed = new Database(tmpDb);
    seed.pragma('journal_mode = WAL');
    seed.exec(`CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT DEFAULT (datetime('now')))`);
    seed.prepare(`INSERT OR IGNORE INTO _migrations (id, name) VALUES ('020', 'add_da_challenges_SKIPPED_FOR_SMOKE')`).run();
    seed.close();
  }

  const { getDb, run: dbRun, queryOne, queryAll } = await import('../src/lib/db');
  const { enqueueAutoReplace, approveAutoResearchProposal } = await import('../src/lib/sop-auto-replace');

  console.log(`[smoke] using db ${tmpDb}`);
  const db = getDb();

  // ---------- Seed phase ----------
  const sopId = uuidv4();
  const now = new Date().toISOString();
  dbRun(
    `INSERT INTO sops (id, name, slug, description, version, department, task_keywords, steps, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    [
      sopId,
      'Marketing — Cold Outreach Email',
      'marketing-cold-outreach-email',
      'v1 — the soon-to-be-deleted one',
      'marketing',
      'cold,email,outreach,outbound',
      JSON.stringify([
        { name: 'Write a subject line', checklist: ['Be punchy'] },
        { name: 'Write the body', checklist: ['Be brief'] },
      ]),
      now,
      now,
    ]
  );

  const taskIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const tid = uuidv4();
    taskIds.push(tid);
    dbRun(
      `INSERT INTO tasks (id, title, status, priority, sop_id, workspace_id, created_at, updated_at)
       VALUES (?, ?, 'backlog', 'medium', ?, ?, ?, ?)`,
      [tid, `Outreach task ${i + 1}`, sopId, 'dept-marketing', now, now]
    );
  }
  console.log(`[smoke] seeded SOP ${sopId} + ${taskIds.length} tasks`);

  // ---------- Simulate DELETE (soft-delete + auto-research) ----------
  dbRun('UPDATE sops SET deleted_at = ?, updated_at = ? WHERE id = ?', [now, now, sopId]);

  const result = await enqueueAutoReplace(sopId, { notify: false });
  console.log('[smoke] enqueueAutoReplace ->', result);

  if (result.status !== 'auto-generated-pending-review') {
    throw new Error(`Expected status auto-generated-pending-review, got ${result.status}`);
  }
  if (result.escalated) throw new Error('Should not have escalated on attempt 1');

  // ---------- Assert proposal row shape ----------
  const proposal = queryOne<Record<string, unknown>>(
    'SELECT * FROM sop_proposals WHERE id = ?',
    [result.proposal_id]
  );
  if (!proposal) throw new Error('Proposal row missing');
  console.log('[smoke] proposal:', {
    id: proposal.id,
    status: proposal.status,
    replaces_sop_id: proposal.replaces_sop_id,
    confidence: proposal.confidence,
    auto_research_attempts: proposal.auto_research_attempts,
    has_sources: !!proposal.research_sources,
  });
  if (proposal.replaces_sop_id !== sopId) throw new Error('replaces_sop_id wrong');
  if (typeof proposal.confidence !== 'number') throw new Error('confidence missing');
  if (proposal.auto_research_attempts !== 1) throw new Error('attempts wrong');
  if (!proposal.research_sources) throw new Error('research_sources missing');
  const sources = JSON.parse(String(proposal.research_sources));
  if (!Array.isArray(sources) || sources.length === 0) throw new Error('sources empty');

  // ---------- Approval (atomic swap) ----------
  const approveResult = approveAutoResearchProposal({
    proposalId: result.proposal_id,
    reviewer: 'smoke-test',
  });
  console.log('[smoke] approveAutoResearchProposal ->', approveResult);
  if (approveResult.retargeted_tasks !== 3) {
    throw new Error(`Expected 3 retargeted tasks, got ${approveResult.retargeted_tasks}`);
  }

  // ---------- Assert tasks now point at v2 ----------
  const repointed = queryAll<{ id: string; sop_id: string }>(
    'SELECT id, sop_id FROM tasks WHERE id IN (?, ?, ?)',
    taskIds
  );
  for (const t of repointed) {
    if (t.sop_id !== approveResult.sop_id) {
      throw new Error(`Task ${t.id} still points at ${t.sop_id}, expected ${approveResult.sop_id}`);
    }
  }
  console.log('[smoke] verified all 3 tasks now point at v2');

  // ---------- Recursive safety cap ----------
  // Insert 3 rejected attempts so the next call hits the safety cap.
  for (let i = 0; i < 3; i++) {
    dbRun(
      `INSERT INTO sop_proposals (id, proposed_name, proposed_department, draft_steps, based_on_task_ids,
         evidence_summary, status, created_at, replaces_sop_id, auto_research_attempts)
       VALUES (?, ?, 'marketing', '[]', '[]', NULL, 'rejected', datetime('now'), ?, ?)`,
      [uuidv4(), 'Marketing — Cold Outreach Email rejected attempt', sopId, i + 2]
    );
  }
  // Restore deleted flag for re-test
  dbRun('UPDATE sops SET deleted_at = NULL WHERE id = ?', [sopId]);
  const escalation = await enqueueAutoReplace(sopId, { notify: false });
  console.log('[smoke] escalation attempt ->', escalation);
  if (!escalation.escalated || escalation.status !== 'escalated') {
    throw new Error('Safety cap should have escalated');
  }

  // ---------- Cleanup ----------
  db.close();
  fs.unlinkSync(tmpDb);
  console.log('\n[smoke] ALL PASSED');
}

run().catch((err) => {
  console.error('[smoke] FAILED:', err);
  process.exit(1);
});
