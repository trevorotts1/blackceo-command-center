/**
 * stale-task-sweep-department-override.test.ts — U101, stale-task-sweep.ts
 * half of the per-department SLA table (board-hygiene.ts's half is covered
 * by tests/unit/board-slas-department-override.test.ts).
 *
 * Proves the same precedence contract (env var > department override >
 * global default) applies to the stale-sweep's blocked re-ping/return
 * threshold, and that an absent department entry is byte-identical to the
 * pre-U101 global-default behavior.
 *
 *   node --import tsx --test tests/unit/stale-task-sweep-department-override.test.ts
 */

process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
delete process.env.STALE_BLOCKED_REPINGED_HOURS; // no global env override in this suite
delete process.env.DISABLE_STALE_TASK_SWEEP;

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point BOARD_SLAS_CONFIG_PATH at a throwaway file with ONE department
// tightened to an 8-hour blocked re-ping/return window (default is 144h),
// BEFORE any module that reads it is imported.
const slaConfigPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-board-slas-sweep-')), 'board-slas.json');
fs.writeFileSync(
  slaConfigPath,
  JSON.stringify({ 'finance-accounting': { staleBlockedRepingedHours: 8 } }),
  'utf-8',
);
process.env.BOARD_SLAS_CONFIG_PATH = slaConfigPath;

import './_isolated-db'; // MUST be first DB import: throwaway DATABASE_PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { getDb, run, queryOne } from '../../src/lib/db';
import { runStaleTaskSweep } from '../../src/lib/jobs/stale-task-sweep';
import { invalidateBoardSlaConfigCache } from '../../src/lib/board-slas';

getDb(); // apply full migration chain (includes migration 071's last_progress_at)
invalidateBoardSlaConfigCache();

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
}

function seedBlockedTask(title: string, department: string | null, ageHours: number): string {
  const id = uuidv4();
  run(
    `INSERT INTO tasks
       (id, title, status, workspace_id, business_id, department, updated_at, last_progress_at,
        blocked_on_human, ask)
     VALUES (?, ?, 'blocked', NULL, NULL, ?, ?, ?, 'operator', ?)`,
    [id, title, department, hoursAgo(ageHours), hoursAgo(ageHours), 'A decision'],
  );
  return id;
}

function taskStatus(id: string): string | undefined {
  return queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [id])?.status;
}

test('U101: a department with a tightened staleBlockedRepingedHours returns to orchestrator at ITS (halved) window; a default department does not', async () => {
  // Tightened dept: override=8h → return threshold IS 8h (this sweep returns
  // directly once ageHours >= returnThreshold; no separate re-ping-only zone
  // when the age already clears the full window on the very first tick).
  const tightened = seedBlockedTask('Tightened stale-blocked task', 'finance-accounting', 9);
  // Default dept: global default is 144h — 9h old must not even re-ping yet
  // (re-ping threshold is half of 144h = 72h).
  const defaultDept = seedBlockedTask('Default-dept stale-blocked task', 'client-success', 9);

  const result = await runStaleTaskSweep();

  assert.equal(taskStatus(tightened), 'backlog', 'tightened-dept task (override=8h, age=9h) must be RETURNED to orchestrator');
  assert.equal(taskStatus(defaultDept), 'blocked', 'default-dept task (global=144h, age=9h) must remain blocked, untouched');
  assert.ok(result.returned >= 1);
});

test('U101: env-var explicit global override wins over the department override, for every department', async () => {
  process.env.STALE_BLOCKED_REPINGED_HOURS = '1000';
  try {
    // Aged well past every OTHER default threshold (so the superset query —
    // widened by minPossibleSlaThreshold, which now reflects the env-pinned
    // 1000h for THIS key — still fetches it as a candidate), but far under
    // both the env override's return (1000h) and re-ping (500h) windows.
    const wouldReturnOnOverrideAlone = seedBlockedTask('Would return on the 8h dept override alone', 'finance-accounting', 50);
    await runStaleTaskSweep();
    assert.equal(
      taskStatus(wouldReturnOnOverrideAlone),
      'blocked',
      'an explicit global env override (1000h) must suppress the return even for a department with a tighter local override (8h)',
    );
  } finally {
    delete process.env.STALE_BLOCKED_REPINGED_HOURS;
  }
});

test('U101 (b): a department absent from board-slas.json behaves byte-identically to the pre-U101 global default', async () => {
  const noOverride = seedBlockedTask('No override on file for this department', 'unmapped-department-xyz', 9);
  await runStaleTaskSweep();
  assert.equal(
    taskStatus(noOverride),
    'blocked',
    'a department with NO board-slas.json entry must use the global default (144h), unchanged from pre-U101 behavior',
  );
});
