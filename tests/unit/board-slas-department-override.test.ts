/**
 * board-slas-department-override.test.ts — U101 BINARY acceptance (a) + (b).
 *
 * (a) A fixture department with a TIGHTENED blocked-escalation threshold
 *     escalates at ITS hour while a default department escalates at the
 *     global hour — one run, both asserted.
 * (b) Absent file/entry ⇒ byte-identical current behavior is proven
 *     separately by tests/unit/board-hygiene.test.ts continuing to pass
 *     UNCHANGED against config/board-slas.json's shipped empty-object
 *     default (no department entries exist there, so every task in that
 *     suite already exercises the "absent entry" fallback path end-to-end).
 *
 *   node --import tsx --test tests/unit/board-slas-department-override.test.ts
 */

process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
delete process.env.CC_OPERATOR_CHAT_ID;
delete process.env.OPENCLAW_OPERATOR_CHAT_ID;
delete process.env.OPENCLAW_OWNER_CHAT_ID;
delete process.env.QC_JUDGE_MODEL;
delete process.env.OLLAMA_CLOUD_API_KEY;
delete process.env.OLLAMA_API_KEY;
delete process.env.DISABLE_BOARD_HYGIENE;
delete process.env.BOARD_HYGIENE_BLOCKED_ESCALATE_HOURS; // no global env override in this suite

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.OPENCLAW_WORKSPACE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-hygiene-sla-workspace-'));

// Point BOARD_SLAS_CONFIG_PATH at a throwaway file with ONE department
// tightened to a 6-hour blocked-escalation threshold, BEFORE any module
// that reads it is imported.
const slaConfigPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-board-slas-')), 'board-slas.json');
fs.writeFileSync(
  slaConfigPath,
  JSON.stringify({ 'finance-accounting': { blockedOperatorEscalateHours: 6 } }),
  'utf-8',
);
process.env.BOARD_SLAS_CONFIG_PATH = slaConfigPath;

import './_isolated-db'; // MUST be first DB import: throwaway DATABASE_PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { getDb, run, queryOne } from '../../src/lib/db';
import { runBoardHygiene } from '../../src/lib/jobs/board-hygiene';
import { invalidateBoardSlaConfigCache } from '../../src/lib/board-slas';

getDb(); // apply full migration chain
invalidateBoardSlaConfigCache();

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
}

function seedBlockedTask(title: string, department: string | null, ageHours: number): string {
  const id = uuidv4();
  run(
    `INSERT INTO tasks
       (id, title, status, workspace_id, business_id, department, updated_at, last_progress_at,
        block_audience, block_reason, block_needs)
     VALUES (?, ?, 'blocked', NULL, NULL, ?, ?, ?, 'OWNER', ?, ?)`,
    [id, title, department, hoursAgo(ageHours), hoursAgo(ageHours), 'Waiting on a decision', 'A yes/no answer'],
  );
  return id;
}

let tightenedDeptTask8h: string; // finance-accounting, 8h old — override threshold is 6h → MUST escalate
let defaultDeptTask8h: string; // client-success (no override), 8h old — global default is 168h → must NOT escalate yet
let tightenedDeptTask4h: string; // finance-accounting, 4h old — under EVEN the tightened 6h → must NOT escalate

test.before(async () => {
  tightenedDeptTask8h = seedBlockedTask('Tightened-dept task past ITS 6h threshold', 'finance-accounting', 8);
  defaultDeptTask8h = seedBlockedTask('Default-dept task under the global 168h threshold', 'client-success', 8);
  tightenedDeptTask4h = seedBlockedTask('Tightened-dept task under even ITS 6h threshold', 'finance-accounting', 4);
});

test('U101 (a): a department with a tightened threshold escalates at ITS hour; a default department does not, in the SAME run', async () => {
  const result = await runBoardHygiene();

  assert.ok(
    result.operatorEscalatedIds.includes(tightenedDeptTask8h),
    'finance-accounting (override=6h) at 8h old MUST escalate',
  );
  assert.ok(
    !result.operatorEscalatedIds.includes(defaultDeptTask8h),
    'client-success (no override, global default=168h) at 8h old must NOT escalate yet',
  );
  assert.ok(
    !result.operatorEscalatedIds.includes(tightenedDeptTask4h),
    'finance-accounting task younger than ITS OWN 6h override must NOT escalate',
  );

  // Escalation never archives — the structural invariant is untouched by U101.
  const t = queryOne<{ status: string; archived_at: string | null }>(
    'SELECT status, archived_at FROM tasks WHERE id = ?',
    [tightenedDeptTask8h],
  );
  assert.equal(t?.status, 'blocked');
  assert.equal(t?.archived_at, null);
});

test('U101: an env-var explicit global override wins over the department override, for every department', async () => {
  process.env.BOARD_HYGIENE_BLOCKED_ESCALATE_HOURS = '1000';
  try {
    const soonBlocked = seedBlockedTask('Freshly re-blocked, would trip the 6h dept override alone', 'finance-accounting', 8);
    const result = await runBoardHygiene();
    assert.ok(
      !result.operatorEscalatedIds.includes(soonBlocked),
      'an explicit global env override (1000h) must suppress escalation even for a department with a tighter local override (6h)',
    );
  } finally {
    delete process.env.BOARD_HYGIENE_BLOCKED_ESCALATE_HOURS;
  }
});

test('U101 (b): a department absent from board-slas.json behaves byte-identically to the pre-U101 global default', async () => {
  const noOverrideTask = seedBlockedTask('No override on file for this department', 'unmapped-department-xyz', 8);
  const result = await runBoardHygiene();
  assert.ok(
    !result.operatorEscalatedIds.includes(noOverrideTask),
    'a department with NO board-slas.json entry must use the global default (168h), unchanged from pre-U101 behavior',
  );
});
