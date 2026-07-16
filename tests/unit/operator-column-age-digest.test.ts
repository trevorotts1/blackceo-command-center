/**
 * operator-column-age-digest.test.ts — U102 / C12.3 item 10a.
 *
 * FAIL-FIRST: against the pre-fix tree, `src/lib/jobs/operator-column-age-
 * digest.ts` does not exist (NOT-FOUND per the master spec — the MSG-07
 * ladder had no daily "how old is everything on the board" read), so every
 * test here fails to even import.
 *
 * Coverage:
 *   1. computeColumnAgeEntries(): groups by (department, status), counts
 *      correctly, and tracks the SINGLE oldest card per group by age.
 *   2. buildColumnAgeDigestMessage(): renders ONE batched message covering
 *      every group — never a per-task line.
 *   3. runOperatorColumnAgeDigest() on a fixture board: correct totals,
 *      'done' + archived tasks EXCLUDED, exactly ONE notifySystem() dispatch
 *      (batched, never per-task), exactly ONE cooldown marker event recorded.
 *   4. A second run inside the cooldown window is suppressed (fires once
 *      "daily") — no duplicate marker, no second send.
 *   5. An empty board (zero eligible tasks) sends nothing.
 *   6. DISABLE_OPERATOR_COLUMN_AGE_DIGEST=1 short-circuits the whole run.
 *
 * Run: node --import tsx --test tests/unit/operator-column-age-digest.test.ts
 */

process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
delete process.env.CC_OPERATOR_CHAT_ID;
delete process.env.OPENCLAW_OPERATOR_CHAT_ID;
delete process.env.OPENCLAW_OWNER_CHAT_ID;
delete process.env.DISABLE_OPERATOR_COLUMN_AGE_DIGEST;
delete process.env.OPERATOR_COLUMN_AGE_DIGEST_COOLDOWN_HOURS;

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.OPENCLAW_WORKSPACE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-col-age-digest-workspace-'));

import './_isolated-db'; // MUST be first DB import: throwaway DATABASE_PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { getDb, run, queryOne } from '../../src/lib/db';
import {
  runOperatorColumnAgeDigest,
  computeColumnAgeEntries,
  buildColumnAgeDigestMessage,
  DIGEST_STATUSES,
  type DigestTaskRow,
} from '../../src/lib/jobs/operator-column-age-digest';

getDb(); // apply full migration chain

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
}
function daysAgo(d: number): string {
  return hoursAgo(d * 24);
}

function clearFixtures(): void {
  run(`DELETE FROM tasks`);
  run(`DELETE FROM events WHERE type = 'operator_column_age_digest_sent'`);
}

function digestEventCount(): number {
  return (
    queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM events WHERE type = 'operator_column_age_digest_sent'`,
      [],
    )?.n ?? 0
  );
}

interface SeedTaskOpts {
  title: string;
  status: string;
  department?: string | null;
  updatedAt: string;
  lastProgressAt?: string | null;
  archivedAt?: string | null;
}

function seedTask(opts: SeedTaskOpts): string {
  const id = uuidv4();
  run(
    `INSERT INTO tasks
       (id, title, status, workspace_id, business_id, department, updated_at, last_progress_at, archived_at)
     VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
    [
      id,
      opts.title,
      opts.status,
      opts.department ?? null,
      opts.updatedAt,
      opts.lastProgressAt ?? null,
      opts.archivedAt ?? null,
    ],
  );
  return id;
}

// ── 1. computeColumnAgeEntries() — pure grouping logic ──────────────────────

test('computeColumnAgeEntries: groups by (department, status), counts, and tracks the SINGLE oldest card', () => {
  const now = Date.now();
  const rows: DigestTaskRow[] = [
    { id: 'a', title: 'Landing page copy', department: 'web-development', status: 'backlog', last_progress_at: null, updated_at: new Date(now - 12 * 3600_000).toISOString() },
    { id: 'b', title: 'Older backlog item', department: 'web-development', status: 'backlog', last_progress_at: null, updated_at: new Date(now - 288 * 3600_000).toISOString() }, // 12d — oldest
    { id: 'c', title: 'Review pass', department: 'web-development', status: 'review', last_progress_at: null, updated_at: new Date(now - 2 * 3600_000).toISOString() },
    { id: 'd', title: 'Waiting on client asset', department: 'marketing', status: 'blocked', last_progress_at: null, updated_at: new Date(now - 216 * 3600_000).toISOString() }, // 9d
  ];

  const entries = computeColumnAgeEntries(rows, now);

  assert.equal(entries.length, 3, 'three distinct (department, status) groups');

  const webBacklog = entries.find((e) => e.department === 'web-development' && e.status === 'backlog');
  assert.ok(webBacklog);
  assert.equal(webBacklog!.count, 2);
  assert.equal(webBacklog!.oldestTaskId, 'b', 'the OLDER of the two backlog cards wins, not insertion order');
  assert.equal(webBacklog!.oldestTaskTitle, 'Older backlog item');
  assert.ok(webBacklog!.oldestAgeHours > 287 && webBacklog!.oldestAgeHours < 289);

  const webReview = entries.find((e) => e.department === 'web-development' && e.status === 'review');
  assert.equal(webReview!.count, 1);
  assert.equal(webReview!.oldestTaskId, 'c');

  const marketingBlocked = entries.find((e) => e.department === 'marketing' && e.status === 'blocked');
  assert.equal(marketingBlocked!.count, 1);
  assert.equal(marketingBlocked!.oldestTaskId, 'd');
});

test('computeColumnAgeEntries: a NULL/blank department groups under the unassigned label, never crashes', () => {
  const now = Date.now();
  const rows: DigestTaskRow[] = [
    { id: 'x', title: 'Unclassified task', department: null, status: 'inbox', last_progress_at: null, updated_at: new Date(now - 3600_000).toISOString() },
    { id: 'y', title: 'Blank department', department: '   ', status: 'inbox', last_progress_at: null, updated_at: new Date(now - 3600_000).toISOString() },
  ];
  const entries = computeColumnAgeEntries(rows, now);
  assert.equal(entries.length, 1, 'null and blank department collapse into ONE unassigned group');
  assert.equal(entries[0].count, 2);
  assert.match(entries[0].department, /unassigned/i);
});

test('computeColumnAgeEntries: an unparseable timestamp is skipped, never crashes the digest', () => {
  const rows: DigestTaskRow[] = [
    { id: 'z', title: 'Bad timestamp', department: 'general-task', status: 'backlog', last_progress_at: null, updated_at: 'not-a-date' },
  ];
  const entries = computeColumnAgeEntries(rows);
  assert.equal(entries.length, 0);
});

// ── 2. buildColumnAgeDigestMessage() — ONE batched message ──────────────────

test('buildColumnAgeDigestMessage: renders exactly one message, department headers, no per-task lines', () => {
  const now = Date.now();
  const rows: DigestTaskRow[] = [
    { id: 'a', title: 'Card A', department: 'web-development', status: 'backlog', last_progress_at: null, updated_at: new Date(now - 12 * 3600_000).toISOString() },
    { id: 'b', title: 'Card B', department: 'marketing', status: 'blocked', last_progress_at: null, updated_at: new Date(now - 216 * 3600_000).toISOString() },
  ];
  const entries = computeColumnAgeEntries(rows, now);
  const message = buildColumnAgeDigestMessage(entries, 2, 2);

  assert.match(message, /\[DAILY DIGEST\]/);
  assert.match(message, /2 department\(s\), 2 active task\(s\)/);
  assert.match(message, /web-development:/);
  assert.match(message, /marketing:/);
  assert.match(message, /backlog: 1 \(oldest 12h — "Card A"\)/);
  assert.match(message, /blocked: 1 \(oldest 9d — "Card B"\)/);
  // Exactly one occurrence of the header line — batched into ONE message.
  assert.equal((message.match(/\[DAILY DIGEST\]/g) ?? []).length, 1);
});

// ── 3/4/5/6. runOperatorColumnAgeDigest() — DB-backed, end to end ───────────

test('runOperatorColumnAgeDigest: correct totals, excludes done + archived, sends exactly one digest', async () => {
  clearFixtures();

  seedTask({ title: 'Stale funnel copy', status: 'backlog', department: 'web-development', updatedAt: daysAgo(12) });
  seedTask({ title: 'Fresh funnel copy', status: 'backlog', department: 'web-development', updatedAt: hoursAgo(1) });
  seedTask({ title: 'Waiting on client', status: 'blocked', department: 'marketing', updatedAt: daysAgo(9) });
  // Excluded: terminal 'done'.
  seedTask({ title: 'Finished work', status: 'done', department: 'marketing', updatedAt: daysAgo(40) });
  // Excluded: archived (soft-deleted), regardless of status.
  seedTask({ title: 'Archived backlog item', status: 'backlog', department: 'web-development', updatedAt: daysAgo(60), archivedAt: new Date().toISOString() });

  const result = await runOperatorColumnAgeDigest();

  assert.equal(result.digestSent, true);
  assert.equal(result.skippedReason, undefined);
  assert.equal(result.totalTasks, 3, 'done + archived rows excluded from the count');
  assert.equal(result.departmentCount, 2);
  assert.ok(result.message);
  assert.doesNotMatch(result.message!, /Finished work/);
  assert.doesNotMatch(result.message!, /Archived backlog item/);
  assert.match(result.message!, /Stale funnel copy/, 'the OLDER backlog card is the one surfaced');
  assert.doesNotMatch(result.message!, /Fresh funnel copy/);
  assert.match(result.message!, /Waiting on client/);

  assert.equal(digestEventCount(), 1, 'exactly one cooldown marker recorded');
});

test('runOperatorColumnAgeDigest: a second run within the cooldown window fires once "daily" (suppressed, no duplicate)', async () => {
  clearFixtures();
  process.env.OPERATOR_COLUMN_AGE_DIGEST_COOLDOWN_HOURS = '20';
  try {
    seedTask({ title: 'Task one', status: 'review', department: 'sales', updatedAt: hoursAgo(5) });

    const first = await runOperatorColumnAgeDigest();
    assert.equal(first.digestSent, true);
    assert.equal(digestEventCount(), 1);

    const second = await runOperatorColumnAgeDigest();
    assert.equal(second.digestSent, false);
    assert.match(second.skippedReason ?? '', /already sent/);
    assert.equal(digestEventCount(), 1, 'still exactly one marker after the cooldown-suppressed re-run');
  } finally {
    delete process.env.OPERATOR_COLUMN_AGE_DIGEST_COOLDOWN_HOURS;
  }
});

test('runOperatorColumnAgeDigest: an empty board sends nothing (no daily noise on an idle board)', async () => {
  clearFixtures();
  const result = await runOperatorColumnAgeDigest();
  assert.equal(result.digestSent, false);
  assert.match(result.skippedReason ?? '', /nothing to digest/);
  assert.equal(result.totalTasks, 0);
  assert.equal(digestEventCount(), 0);
});

test('DISABLE_OPERATOR_COLUMN_AGE_DIGEST=1: short-circuits the whole run', async () => {
  clearFixtures();
  seedTask({ title: 'Should be ignored', status: 'backlog', department: 'sales', updatedAt: daysAgo(3) });

  process.env.DISABLE_OPERATOR_COLUMN_AGE_DIGEST = '1';
  try {
    const result = await runOperatorColumnAgeDigest();
    assert.equal(result.digestSent, false);
    assert.match(result.skippedReason ?? '', /DISABLE_OPERATOR_COLUMN_AGE_DIGEST/);
    assert.equal(digestEventCount(), 0);
  } finally {
    delete process.env.DISABLE_OPERATOR_COLUMN_AGE_DIGEST;
  }
});

// ── Sanity: DIGEST_STATUSES never includes the terminal 'done' status ───────

test('DIGEST_STATUSES excludes the terminal done status', () => {
  assert.ok(!DIGEST_STATUSES.includes('done' as (typeof DIGEST_STATUSES)[number]));
  assert.equal(DIGEST_STATUSES.length, 9);
});
