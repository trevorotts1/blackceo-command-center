/**
 * fix45-io-deferred-path.test.ts — FIX 45 "UNREADABLE ≠ FAILED": the ioDeferred
 * deferral branch must hold a card in review (NOT fail it) when every registered
 * file deliverable EXISTS with bytes but cannot be READ (chmod-000 / permission
 * gate / EBUSY — the same transient I/O class as the TCC gate).
 *
 * The council (R-MERGE council.json, adversarial judge, 2026-09-04) proved this
 * branch had ZERO test coverage: ioDeferred declared at qc-scorer.ts:1385, set
 * at 1460, consumed at 4942-4967 (FIX 7 deck lane) and 5592-5628 (generic lane),
 * with no reference in any test file. This suite exercises BOTH consumers
 * in-process — no mocks of the branch under test; the fixture provokes a real
 * EACCES with chmod 000 so probeTextFile's safeReadFileBuffer genuinely returns
 * null and ioDeferred genuinely rides through the manifest.
 *
 * Assertions per lane (the deferral contract):
 *   - the returned verdict is pass:false with reason "Deliverable I/O deferred"
 *     (NOT the all-invalid instant-fail "missing or invalid", score 2.0)
 *   - score stays 0 (deferred, not scored)
 *   - ONE [QC-DEFERRED-IO] event is written naming the unreadable path
 *   - the card's status is UNCHANGED (still 'review') — no reroute, no
 *     transition, qc_reroute_attempts untouched
 *   - NO task_qc_results row is written (a deferral is not a verdict)
 *
 * Runs via the Node built-in test runner under tsx, DB-backed on a throwaway
 * DATABASE_PATH (same pattern as fix7-engine-deck-done-path.test.ts):
 *
 *   npx tsx --test tests/unit/fix45-io-deferred-path.test.ts
 */

// ── env: no notify, no live judge, no fixture vars leaking in ────────────────
process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
delete process.env.CC_OPERATOR_CHAT_ID;
delete process.env.OPENCLAW_OPERATOR_CHAT_ID;
delete process.env.OPENCLAW_OWNER_CHAT_ID;
delete process.env.QC_JUDGE_MODEL;
delete process.env.OLLAMA_CLOUD_API_KEY;
delete process.env.OLLAMA_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.DISABLE_QC_AUTO_SCORER;
delete process.env.QC_FIXTURE_JSON_PATH;
delete process.env.QC_SIMULATE_PROVIDER_DOWN;
delete process.env.MC_API_TOKEN;
delete process.env.WEBHOOK_SECRET;
delete process.env.PRESENTATION_RUNS_DIRS;
delete process.env.PRESENTATION_REVIEW_EVIDENCE_GATE;
delete process.env.PRESENTATION_BUNDLE_REVERIFY;
if (process.env.NODE_ENV === 'production') process.env.NODE_ENV = 'test';

import './_isolated-db'; // MUST be first DB-touching import: throwaway DATABASE_PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { run, queryOne, queryAll, getDb } from '../../src/lib/db';
import { runQCOnReview } from '../../src/lib/qc-scorer';

const db = getDb(); // applies the full migration chain on the throwaway DB

function taskStatus(taskId: string): string | null {
  const row = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId]);
  return row?.status ?? null;
}

function reroutes(taskId: string): number {
  const row = queryOne<{ qc_reroute_attempts: number | null }>(
    'SELECT qc_reroute_attempts FROM tasks WHERE id = ?',
    [taskId],
  );
  return row?.qc_reroute_attempts ?? 0;
}

function deferredEvents(taskId: string): { message: string }[] {
  return queryAll<{ message: string }>(
    'SELECT message FROM events WHERE task_id = ? AND type = ? ORDER BY created_at',
    [taskId, 'qc_review'],
  ).filter((e) => e.message.includes('[QC-DEFERRED-IO]'));
}

function qcRows(taskId: string): number {
  return queryAll<{ id: string }>(
    'SELECT id FROM task_qc_results WHERE task_id = ?',
    [taskId],
  ).length;
}

function seedWorkspace(): string {
  const id = `pres-fix45-${uuidv4().slice(0, 8)}`;
  run('INSERT INTO workspaces (id, name, slug, sort_order) VALUES (?, ?, ?, 1000)', [id, id, id]);
  return id;
}

/**
 * Create a real file on disk that probeTextFile can STAT (exists, size > 0) but
 * cannot READ: chmod 000 forces readFileSync to throw EACCES on this user, so
 * safeReadFileBuffer returns null and the probe reports ioDeferred=true.
 * Restores 0o644 in the returned cleanup so mkdtemp removal works everywhere.
 */
function seedUnreadableDeliverable(taskId: string, dir: string, name: string): () => void {
  const p = path.join(dir, name);
  fs.writeFileSync(p, 'content that will become unreadable'.repeat(8)); // > 0 bytes
  fs.chmodSync(p, 0o000);
  run(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path, created_at)
     VALUES (?, ?, 'file', ?, ?, ?)`,
    [uuidv4(), taskId, name, p, new Date().toISOString()],
  );
  return () => fs.chmodSync(p, 0o644);
}

// ============================================================================
// (1) GENERIC LANE — a NON-engine-owned review card whose only deliverable is
//     a chmod-000 .md. runQCOnReview reaches the generic path's allIoDeferred
//     branch (qc-scorer.ts ~5592-5628) and MUST defer, not fail.
// ============================================================================
test('FIX 45 generic lane: unreadable-but-present deliverable DEFERS in review (no fail, no counter, no verdict row)', async () => {
  const wsId = seedWorkspace();
  const id = uuidv4();
  run(
    `INSERT INTO tasks (id, title, description, status, department, source, workspace_id,
                        qc_reroute_attempts, updated_at, last_progress_at)
     VALUES (?, ?, ?, 'review', 'engineering', 'auto', ?, 0, ?, ?)`,
    [
      id,
      'FIX 45 fixture: card with a TCC-style unreadable deliverable',
      'Regular artifact task (not engine-owned) — exercises the generic allIoDeferred branch.',
      wsId,
      new Date().toISOString(),
      new Date().toISOString(),
    ],
  );

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-fix45-generic-'));
  const restore = seedUnreadableDeliverable(id, tmp, 'report.md');
  try {
    const result = await runQCOnReview(id);

    // A deferral IS returned (not null — null would mean some other lane swallowed it).
    assert.ok(result, 'runQCOnReview must return a verdict for the deferred card');
    assert.equal(result?.pass, false, 'the QC run does not pass while unreadable');
    assert.equal(result?.score, 0, 'a deferral scores 0 — NOT the 2.0 instant-fail');
    assert.match(
      result?.reason ?? '',
      /Deliverable I\/O deferred/,
      `reason must name the deferral, got: ${result?.reason}`,
    );
    assert.doesNotMatch(
      result?.reason ?? '',
      /missing or invalid/,
      'must NOT take the all-invalid instant-fail wording',
    );

    // The deferral event is written and names the path.
    const evs = deferredEvents(id);
    assert.equal(evs.length, 1, `exactly one [QC-DEFERRED-IO] event, got ${evs.length}`);
    assert.match(evs[0]?.message ?? '', /report\.md/, 'event names the unreadable path');
    assert.match(evs[0]?.message ?? '', /qc_reroute_attempts unchanged/, 'event states the no-counter contract');

    // The card did NOT move: still in review, counter untouched.
    assert.equal(taskStatus(id), 'review', 'deferral holds the card in review (no transition)');
    assert.equal(reroutes(id), 0, 'qc_reroute_attempts must be unchanged by a deferral');

    // No verdict row: a deferral is not a scored verdict.
    assert.equal(qcRows(id), 0, 'no task_qc_results row may be written for a deferral');
  } finally {
    restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ============================================================================
// (2) CONTROL — the SAME card with a READABLE deliverable must NOT defer:
//     proves the fixture defers because of the unreadability, not because of
//     some unrelated branch (the deferral branch requires ioDeferred=true).
// ============================================================================
test('FIX 45 control: readable deliverable does NOT take the deferred branch', async () => {
  const wsId = seedWorkspace();
  const id = uuidv4();
  run(
    `INSERT INTO tasks (id, title, description, status, department, source, workspace_id,
                        qc_reroute_attempts, updated_at, last_progress_at)
     VALUES (?, ?, ?, 'review', 'engineering', 'auto', ?, 0, ?, ?)`,
    [
      id,
      'FIX 45 control: readable deliverable',
      'Same shape as (1) but the file is readable — no [QC-DEFERRED-IO] may appear.',
      wsId,
      new Date().toISOString(),
      new Date().toISOString(),
    ],
  );

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-fix45-control-'));
  const p = path.join(tmp, 'report.md');
  fs.writeFileSync(p, 'a perfectly readable deliverable body\n'.repeat(40));
  run(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path, created_at)
     VALUES (?, ?, 'file', ?, ?, ?)`,
    [uuidv4(), id, 'report.md', p, new Date().toISOString()],
  );
  try {
    const result = await runQCOnReview(id);
    assert.ok(result, 'runQCOnReview returns a verdict for the readable card');
    assert.doesNotMatch(
      (result?.reason ?? '') + JSON.stringify(deferredEvents(id).map((e) => e.message)),
      /QC-DEFERRED-IO/,
      'a readable deliverable must not hit the deferred branch',
    );
    assert.equal(
      deferredEvents(id).length,
      0,
      'control writes no [QC-DEFERRED-IO] event — the deferral branch requires ioDeferred=true',
    );
    assert.notEqual(
      taskStatus(id),
      'review',
      'control card LEAVES review through its normal lane (no-criteria → blocked), proving the deferral branch is what held card (1) in review',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
