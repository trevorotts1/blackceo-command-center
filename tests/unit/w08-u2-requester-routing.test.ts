/**
 * S75-W08-U2 (D14) — requester-origin routing for status/report-back.
 *
 * "Resolve status and report-back to the recorded requester
 * conversation/channel/thread from the canonical origin record instead of a
 * global owner Telegram destination, preserving tenant/account boundaries."
 *
 * Proves:
 *   - createAdCampaign stamps the run's canonical origin record (channel +
 *     chat id, or an OpenClaw-app gateway session key) onto every campaign card
 *   - report-back resolves THE TASK'S OWN origin (Telegram chat / OpenClaw-app
 *     session / HQ bound session) — never a global owner destination, never
 *     another task's conversation
 *   - a route that exists but names no addressable destination REFUSES rather
 *     than downgrading to the owner Telegram
 *   - a task with NO origin record keeps the exact pre-D14 owner fallback
 *   - the Telegram lane really dispatches to the requester's chat id (a stub
 *     `openclaw` on PATH records the invocation; PATH is restricted to the
 *     stub so this file cannot reach a real gateway even if a guard regresses)
 *   - a done report never double-sends after the trust engine's completion stamp
 *
 * Runs against a THROWAWAY DB (./_isolated-db must stay the FIRST import).
 */

import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { queryOne, run } from '../../src/lib/db';
import { createAdCampaign, AdCampaignError } from '../../src/lib/ad-campaigns';
import {
  resolveReportDestination,
  deliverTaskReport,
} from '../../src/lib/owner-reports';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-w08u2-route-'));
const SENTINEL = path.join(TMP_DIR, 'openclaw-was-invoked.log');
const SHIM_DIR = path.join(TMP_DIR, 'bin');

// Stub `openclaw` that records every invocation (same safety pattern as
// tests/unit/notify-no-send-in-tests.test.ts). Absolute shebang so it runs with
// PATH restricted to SHIM_DIR alone.
fs.mkdirSync(SHIM_DIR, { recursive: true });
fs.writeFileSync(
  path.join(SHIM_DIR, 'openclaw'),
  `#!/bin/sh\necho "invoked: $@" >> ${JSON.stringify(SENTINEL)}\n`,
  { mode: 0o755 },
);
process.env.OPENCLAW_WORKSPACE_PATH = path.join(TMP_DIR, 'workspace');
fs.mkdirSync(process.env.OPENCLAW_WORKSPACE_PATH, { recursive: true });
const REAL_PATH = process.env.PATH ?? '';

async function sentinelAppeared(timeoutMs = 4_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(SENTINEL)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

function newJobId(): string {
  return `test-route-${uuidv4()}`;
}

function originRow(jobId: string, stageSlug = 'epic') {
  return queryOne<{
    requester_channel: string | null;
    requester_chat_id: string | null;
    requester_session_key: string | null;
  }>(
    'SELECT requester_channel, requester_chat_id, requester_session_key FROM tasks WHERE campaign_id = ? AND stage_slug = ?',
    [jobId, stageSlug],
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The origin record is stamped at create, on every card
// ─────────────────────────────────────────────────────────────────────────────

test('createAdCampaign stamps the canonical origin record onto every campaign card', () => {
  const jobId = newJobId();
  createAdCampaign({
    job_id: jobId,
    show_name: 'Origin Stamped Show',
    requester_channel: 'telegram',
    requester_chat_id: '7771234567',
  });
  for (const slug of ['epic', 's1-overlays', 's7-deliver']) {
    const row = originRow(jobId, slug);
    assert.equal(row?.requester_channel, 'telegram', `${slug} carries the channel`);
    assert.equal(row?.requester_chat_id, '7771234567', `${slug} carries the chat id`);
    assert.equal(row?.requester_session_key, null);
  }
});

test('an OpenClaw-app origin (gateway session key) is stamped; an unaddressable key is refused at the boundary', () => {
  const appJob = newJobId();
  createAdCampaign({
    job_id: appJob,
    show_name: 'OpenClaw App Origin Show',
    requester_session_key: 'agent:main:telegram:direct:7771234567',
  });
  const row = originRow(appJob);
  assert.equal(row?.requester_session_key, 'agent:main:telegram:direct:7771234567');

  // A producer run id is provenance, not an address — never stored as one.
  const badJob = newJobId();
  assert.throws(
    () =>
      createAdCampaign({
        job_id: badJob,
        show_name: 'Bad Session Key Show',
        requester_session_key: 'pres-mta0y199-qj40j3',
      }),
    (err: unknown) => {
      assert.ok(err instanceof AdCampaignError);
      assert.equal(err.code, 'REQUESTER_SESSION_KEY_INVALID');
      assert.equal(err.status, 400);
      return true;
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Destination resolution — the task's own origin, never a global target
// ─────────────────────────────────────────────────────────────────────────────

test('resolveReportDestination: chat id wins, then the OpenClaw-app session, else owner', () => {
  assert.deepEqual(resolveReportDestination({
    requester_channel: 'telegram',
    requester_chat_id: '7771234567',
    requester_session_key: 'agent:main:telegram:direct:7771234567',
  }), { lane: 'chat', address: '7771234567', channel: 'telegram' });

  assert.deepEqual(resolveReportDestination({
    requester_channel: null,
    requester_chat_id: null,
    requester_session_key: 'agent:main:web:abc123',
  }), { lane: 'session', address: 'agent:main:web:abc123', channel: 'session' });

  assert.deepEqual(resolveReportDestination({
    requester_channel: null,
    requester_chat_id: null,
    requester_session_key: null,
  }), { lane: 'owner', address: null, channel: 'owner' });
});

test('report-back returns to each task\'s OWN conversation (tenant boundary: no cross-task resolution)', async () => {
  const a = newJobId();
  const b = newJobId();
  createAdCampaign({
    job_id: a, show_name: 'Tenant A', requester_channel: 'telegram', requester_chat_id: '1111111111',
  });
  createAdCampaign({
    job_id: b, show_name: 'Tenant B', requester_session_key: 'agent:main:web:tenant-b',
  });

  const da = deliverTaskReport(cardIdFor(a), 'report for A');
  const db = deliverTaskReport(cardIdFor(b), 'report for B');
  assert.equal(da.destination.lane, 'chat');
  assert.equal(da.destination.address, '1111111111', 'task A reports to A\'s chat');
  assert.equal(db.destination.lane, 'session');
  assert.equal(db.destination.address, 'agent:main:web:tenant-b', 'task B reports to B\'s OpenClaw-app session');
});

function cardIdFor(jobId: string, stageSlug = 'epic'): string {
  const row = queryOne<{ id: string }>(
    'SELECT id FROM tasks WHERE campaign_id = ? AND stage_slug = ?',
    [jobId, stageSlug],
  );
  assert.ok(row, 'card exists');
  return row.id;
}

test('an hq-chat origin with no bound session REFUSES — it never downgrades to the owner Telegram', async () => {
  const jobId = newJobId();
  createAdCampaign({
    job_id: jobId,
    show_name: 'HQ No Session Show',
    requester_channel: 'hq-chat',
    requester_chat_id: '2222222222',
  });
  // The recorded channel is hq-chat: the route is the hq lane, bound-session
  // addressed; with no session key it names no addressable destination.
  const d = deliverTaskReport(cardIdFor(jobId), 'hq report');
  assert.equal(d.destination.lane, 'hq-chat');
  assert.notEqual(d.destination.lane, 'owner', 'never a global owner substitution');
  assert.equal(d.delivered, false);
});

test('a task with NO origin record keeps the pre-D14 owner-fallback behavior', async () => {
  const jobId = newJobId();
  createAdCampaign({ job_id: jobId, show_name: 'Operator Created Show' });
  const d = deliverTaskReport(cardIdFor(jobId), 'owner report');
  assert.equal(d.destination.lane, 'owner', 'no origin → owner funnel, unchanged');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Transport proof: the Telegram lane really targets the requester's chat
// ─────────────────────────────────────────────────────────────────────────────

test('telegram-origin report dispatches `openclaw message send` to the REQUESTER chat id', async () => {
  const jobId = newJobId();
  createAdCampaign({
    job_id: jobId,
    show_name: 'Transport Proof Show',
    requester_channel: 'telegram',
    requester_chat_id: '7771234567',
  });

  const savedDisabled = process.env.OWNER_NOTIFY_TELEGRAM_DISABLED;
  const savedAllow = process.env.OWNER_NOTIFY_ALLOW_SEND_IN_TEST;
  delete process.env.OWNER_NOTIFY_TELEGRAM_DISABLED;
  process.env.OWNER_NOTIFY_ALLOW_SEND_IN_TEST = '1';
  // SAFETY: only the stub is reachable while the send path is opted in.
  process.env.PATH = SHIM_DIR;
  try {
    const d = deliverTaskReport(cardIdFor(jobId), 'your task is complete');
    assert.equal(d.delivered, true, 'send dispatched (fire-and-forget contract)');
    assert.equal(d.destination.lane, 'chat');
    assert.equal(await sentinelAppeared(), true, 'the gateway CLI was invoked');
    const inv = fs.readFileSync(SENTINEL, 'utf8');
    assert.ok(inv.includes('message send'), `expected message send, got: ${inv}`);
    assert.ok(inv.includes('--target 7771234567'), `must target the requester chat id: ${inv}`);
  } finally {
    process.env.PATH = REAL_PATH;
    if (savedDisabled === undefined) delete process.env.OWNER_NOTIFY_TELEGRAM_DISABLED;
    else process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = savedDisabled;
    if (savedAllow === undefined) delete process.env.OWNER_NOTIFY_ALLOW_SEND_IN_TEST;
    else process.env.OWNER_NOTIFY_ALLOW_SEND_IN_TEST = savedAllow;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. No duplicate done: the trust engine's completion stamp is honored read-only
// ─────────────────────────────────────────────────────────────────────────────

test('a done report is skipped when the requester already got the canonical completion report', async () => {
  const jobId = newJobId();
  createAdCampaign({
    job_id: jobId,
    show_name: 'Done Dedupe Show',
    requester_channel: 'telegram',
    requester_chat_id: '7771234567',
  });
  const taskId = cardIdFor(jobId);

  const before = deliverTaskReport(taskId, 'done report', { kind: 'done' });
  assert.equal(before.skipped, undefined, 'first done report is not skipped');

  run('UPDATE tasks SET completion_sent_at = ? WHERE id = ?', [new Date().toISOString(), taskId]);
  const after = deliverTaskReport(taskId, 'done report again', { kind: 'done' });
  assert.equal(after.delivered, false);
  assert.ok(after.skipped && after.skipped.includes('completion_sent_at'), 'skipped, with the reason named');

  // Other report kinds are unaffected by the completion stamp.
  const held = deliverTaskReport(taskId, 'held report', { kind: 'held' });
  assert.equal(held.skipped, undefined, 'held/progress reports are not gated by the done stamp');
});
