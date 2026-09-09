/**
 * social-f20-duplicate-dispatch.test.ts — F20 (CC half, seam-level).
 *
 * The real one-card dedupe happens at createTaskCore Layer-1: the dispatcher
 * derives the SAME idempotency key for both queue rows and passes it, so the
 * ingest path creates exactly ONE canonical task — never two. This test drives
 * the REAL dispatcher sweep over TWO enqueued rows whose logical request is
 * the same but whose stored topic-case / platform-order differ (a webhook
 * retry), and asserts the ONE-CANONICAL-CARD consequence:
 *
 *   1. Two deliveries (different body bytes) -> two publish_queue rows.
 *   2. One dispatcher sweep -> both rows dispatched, createTaskCore dedupes
 *      on the stable key -> exactly ONE canonical task.
 *   3. The canonical task count is 1 (the consequence the route-level test
 *      cannot reach: route.ts inserts rows WITHOUT idempotency_key).
 *   4. A second sweep re-derives the same key and never creates a second task.
 *
 * Regression control (same shape as the QC repro): if publishIdempotencyKey
 * normalization is gutted (case-sensitive topic / unsorted platforms), the two
 * rows derive DIFFERENT keys and TWO canonical tasks are created — this test
 * turns RED, proving it is load-bearing against the old one-row-per-request
 * behavior.
 *
 * Run:
 *   node --import tsx --import ./tests/setup/no-owner-telegram.ts \
 *     --test tests/unit/social-f20-duplicate-dispatch.test.ts
 */
import './_isolated-db'; // MUST be first DB import: throwaway DATABASE_PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb, queryOne, queryAll, run, closeDb } from '../../src/lib/db';
import {
  runSocialPublishDispatcherSweep,
  publishIdempotencyKey,
} from '../../src/lib/jobs/social-publish-dispatcher';

// Gateway unreachable — dispatch attempts fail cheaply without a live socket;
// the canonical task creation (createTaskCore Layer-1) is the unit under test.
process.env.OPENCLAW_GATEWAY_URL = 'not-a-valid-url';
process.env.OPENCLAW_GATEWAY_TOKEN = '';
// Fast test knobs.
process.env.SOCIAL_PUBLISH_BACKOFF_BASE_SECONDS = '30';
process.env.SOCIAL_PUBLISH_LEASE_SECONDS = '300';

const db = getDb(); // full migration chain (incl. 136) against the isolated temp DB

const COMPANY = 'company-f20';
const TOPIC_NORM = 'duplicate delivery';
const TOPICS = ['Duplicate Delivery', 'duplicate delivery']; // same logical, different case
const PLATFORM_SETS = [['linkedin', 'x'], ['x', 'linkedin']]; // same set, different order

function seedWorkspaceAndAgent(): string {
  if (!db.prepare('SELECT 1 FROM companies WHERE id = ?').get(COMPANY)) {
    run(`INSERT INTO companies (id, name, slug) VALUES (?, 'F20 Test Co', 'f20-test-co')`, [COMPANY]);
  }
  const ws = 'ws-f20-marketing';
  if (!db.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(ws)) {
    run(`INSERT INTO workspaces (id, slug, name, company_id) VALUES (?, 'marketing', 'Marketing', ?)`, [ws, COMPANY]);
  }
  if (!db.prepare('SELECT 1 FROM agents WHERE id = ?').get('agent-f20-specialist')) {
    run(
      `INSERT INTO agents (id, name, role, is_master, workspace_id, status)
       VALUES ('agent-f20-specialist', 'F20 Specialist', 'specialist', 0, ?, 'standby')`,
      [ws],
    );
  }
  return ws;
}

let seq = 0;
function enqueueRow(opts: { topic: string; platforms: string[]; status?: string }): string {
  seq++;
  const id = `pq-f20-${seq}`;
  const now = new Date().toISOString();
  run(
    `INSERT INTO publish_queue
      (id, task_id, company_id, sheet_id, topic, platforms, schedule, status, created_at, updated_at)
     VALUES (?, NULL, ?, NULL, ?, ?, 'auto', ?, ?, ?)`,
    [id, COMPANY, opts.topic, JSON.stringify(opts.platforms), opts.status ?? 'queued', now, now],
  );
  return id;
}

function canonicalTaskCount(): number {
  // The canonical task title preserves the FIRST row's topic case, so count
  // by the case-insensitive normalized topic (SQLite LIKE is ASCII-CI).
  return queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM tasks WHERE title LIKE 'Social publish: ${TOPIC_NORM}'`,
  )!.n;
}

test.after(async () => {
  try {
    const { getOpenClawClient } = await import('../../src/lib/openclaw/client');
    getOpenClawClient().disconnect();
  } catch { /* ignore */ }
  try {
    const g = globalThis as Record<string, NodeJS.Timeout | undefined>;
    if (g['__openclaw_cache_cleanup_timer__']) clearInterval(g['__openclaw_cache_cleanup_timer__']);
  } catch { /* ignore */ }
  try { closeDb(); } catch { /* ignore */ }
});

test('[F20.1] duplicate webhook delivery: one sweep -> ONE canonical task, never two', async () => {
  seedWorkspaceAndAgent();
  // Two deliveries of the same logical request, byte-different bodies.
  const id1 = enqueueRow({ topic: TOPICS[0], platforms: PLATFORM_SETS[0] });
  const id2 = enqueueRow({ topic: TOPICS[1], platforms: PLATFORM_SETS[1] });

  // Precondition: differing stored topic case / platform order — key equality
  // is not trivially true, only correct normalization produces one key.
  const row1 = queryOne<{ topic: string; platforms: string }>('SELECT topic, platforms FROM publish_queue WHERE id = ?', [id1])!;
  const row2 = queryOne<{ topic: string; platforms: string }>('SELECT topic, platforms FROM publish_queue WHERE id = ?', [id2])!;
  assert.notEqual(row1.topic, row2.topic, 'precondition: topics differ in case');
  assert.notEqual(
    JSON.stringify(JSON.parse(row1.platforms)), JSON.stringify(JSON.parse(row2.platforms)),
    'precondition: platform order differs',
  );

  const result = await runSocialPublishDispatcherSweep();
  assert.ok(result.scanned >= 2, `sweep must scan both rows (scanned=${result.scanned})`);

  // THE one-card consequence: both rows link to shared canonical task.
  const linked = queryAll<{ id: string; cc_task_id: string | null }>(
    'SELECT id, cc_task_id FROM publish_queue WHERE id IN (?, ?)', [id1, id2],
  );
  assert.ok(linked.length === 2, 'both rows must be processed');
  assert.ok(linked[0]!.cc_task_id, 'row 1 holds a canonical task');
  assert.ok(linked[1]!.cc_task_id, 'row 2 holds a canonical task');
  assert.equal(linked[0]!.cc_task_id, linked[1]!.cc_task_id,
    'duplicate deliveries share ONE canonical task (createTaskCore deduped on the key)');
  assert.equal(canonicalTaskCount(), 1, 'exactly one canonical task from two deliveries');

  // The two rows derive the same key — the seam that guarantees the above.
  const k1 = publishIdempotencyKey({ companyId: COMPANY, taskId: null, topic: row1.topic, platforms: JSON.parse(row1.platforms) });
  const k2 = publishIdempotencyKey({ companyId: COMPANY, taskId: null, topic: row2.topic, platforms: JSON.parse(row2.platforms) });
  assert.equal(k1, k2, 'stable key: case-insensitive topic + sorted platforms');

  // A second sweep must not duplicate the canonical task.
  await runSocialPublishDispatcherSweep();
  assert.equal(canonicalTaskCount(), 1, 're-sweep never creates a second canonical task');
});
