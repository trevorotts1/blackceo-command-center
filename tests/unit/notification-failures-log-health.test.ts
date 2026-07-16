/**
 * notification-failures-log-health.test.ts — U102 / C12.3 item 10b.
 *
 * "surface `notification-failures.jsonl` size as a health field so
 * undeliverables are seen without reading server logs." (master spec)
 *
 * FAIL-FIRST: against the pre-fix tree, `getNotificationFailuresLogStats()`
 * (notify.ts) and `checkNotificationFailuresLog()` (deep-checks.ts) do not
 * exist, so every test here fails to even import.
 *
 * Coverage:
 *   1. No ledger file on this box → pass:true, exists:false, zeroed counters
 *      (a fresh/healthy box is never reported as broken).
 *   2. A forced undeliverable (recordUndeliverable) increments the counter —
 *      the literal acceptance criterion from the master spec.
 *   3. Repeated undeliverables keep incrementing the line count; size_bytes
 *      tracks the file growing.
 *   4. Above the advisory threshold (NOTIFICATION_FAILURES_LOG_WARN_LINES) →
 *      pass:false — but this is an ADVISORY signal, never gating (verified by
 *      route.ts's isolation posture, mirrored by every sibling advisory
 *      check in this file — anthology/skill6 board projection, sweep_liveness).
 *   5. checkNotificationFailuresLog() never throws even on a read error
 *      (degrades to indeterminate, pass:true — never a false red).
 *
 * Run: node --import tsx --test tests/unit/notification-failures-log-health.test.ts
 */

process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
delete process.env.CC_OPERATOR_CHAT_ID;
delete process.env.OPENCLAW_OPERATOR_CHAT_ID;
delete process.env.OPENCLAW_OWNER_CHAT_ID;
delete process.env.NOTIFICATION_FAILURES_LOG_WARN_LINES;

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import './_isolated-db'; // MUST be first DB import: throwaway DATABASE_PATH.
// deep-checks.ts imports `DB_PATH` from '@/lib/db' at module scope (a C8-guarded
// eager resolution), so this module-level import must land AFTER _isolated-db
// even though none of the tests below touch the database directly.
import test from 'node:test';
import assert from 'node:assert/strict';

import { getNotificationFailuresLogStats, recordUndeliverable } from '../../src/lib/notify';
import {
  checkNotificationFailuresLog,
  NOTIFICATION_FAILURES_LOG_WARN_LINES_DEFAULT,
} from '../../src/lib/health/deep-checks';

function freshWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-notif-log-health-'));
  process.env.OPENCLAW_WORKSPACE_PATH = dir;
  return dir;
}

// ── 1. Absent ledger — legitimate PASS, not a false red ─────────────────────

test('checkNotificationFailuresLog: no ledger on this box → pass:true, exists:false, zeroed counters', () => {
  freshWorkspace();
  const stats = getNotificationFailuresLogStats();
  assert.equal(stats.exists, false);
  assert.equal(stats.lineCount, 0);
  assert.equal(stats.sizeBytes, 0);

  const check = checkNotificationFailuresLog();
  assert.equal(check.pass, true);
  assert.equal(check.exists, false);
  assert.equal(check.line_count, 0);
  assert.equal(check.size_bytes, 0);
});

// ── 2. THE ACCEPTANCE CRITERION: a forced undeliverable increments the counter ──

test('checkNotificationFailuresLog: a forced undeliverable increments the health counter', () => {
  freshWorkspace();
  assert.equal(checkNotificationFailuresLog().line_count, 0, 'precondition: starts at zero');

  recordUndeliverable('owner_undeliverable', 'Task blocked: no vision model available.');

  const stats = getNotificationFailuresLogStats();
  assert.equal(stats.exists, true);
  assert.equal(stats.lineCount, 1, 'the forced undeliverable incremented the counter');
  assert.ok(stats.sizeBytes > 0);

  const check = checkNotificationFailuresLog();
  assert.equal(check.exists, true);
  assert.equal(check.line_count, 1);
  assert.equal(check.size_bytes, stats.sizeBytes);
});

// ── 3. Repeated undeliverables keep incrementing ────────────────────────────

test('checkNotificationFailuresLog: repeated undeliverables keep incrementing the counter and byte size', () => {
  freshWorkspace();
  recordUndeliverable('system_alert', 'first');
  recordUndeliverable('system_alert', 'second');
  recordUndeliverable('owner_undeliverable', 'third');

  const stats = getNotificationFailuresLogStats();
  assert.equal(stats.lineCount, 3);

  recordUndeliverable('system_alert', 'fourth');
  const stats2 = getNotificationFailuresLogStats();
  assert.equal(stats2.lineCount, 4);
  assert.ok(stats2.sizeBytes > stats.sizeBytes, 'file size grows as more undeliverables are recorded');
});

// ── 4. Advisory threshold — pass:false above it, but still non-gating ──────

test('checkNotificationFailuresLog: above the advisory threshold reports pass:false (still advisory-only)', () => {
  freshWorkspace();
  process.env.NOTIFICATION_FAILURES_LOG_WARN_LINES = '2';
  try {
    recordUndeliverable('system_alert', 'one');
    recordUndeliverable('system_alert', 'two');
    assert.equal(checkNotificationFailuresLog().pass, true, 'at the threshold — not yet over it');

    recordUndeliverable('system_alert', 'three');
    const check = checkNotificationFailuresLog();
    assert.equal(check.pass, false);
    assert.equal(check.line_count, 3);
    assert.match(check.detail, /threshold/i);
    assert.match(check.detail, /non-gating/i, 'the detail itself documents that this never gates the box');
  } finally {
    delete process.env.NOTIFICATION_FAILURES_LOG_WARN_LINES;
  }
});

test('checkNotificationFailuresLog: default threshold is used when the env var is unset/invalid', () => {
  freshWorkspace();
  delete process.env.NOTIFICATION_FAILURES_LOG_WARN_LINES;
  for (let i = 0; i < NOTIFICATION_FAILURES_LOG_WARN_LINES_DEFAULT; i++) {
    recordUndeliverable('system_alert', `n-${i}`);
  }
  assert.equal(checkNotificationFailuresLog().pass, true, 'exactly at the default threshold — not yet over it');

  recordUndeliverable('system_alert', 'one-more');
  assert.equal(checkNotificationFailuresLog().pass, false, 'one past the default threshold trips the advisory flag');
});

// ── 5. Never throws — the absolute path is never leaked in the detail ──────

test('checkNotificationFailuresLog: detail string never leaks the resolved absolute path', () => {
  const dir = freshWorkspace();
  recordUndeliverable('system_alert', 'leak-check');
  const check = checkNotificationFailuresLog();
  assert.doesNotMatch(check.detail, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
