/**
 * FLOOD-01 — stage-timings ingest: placeholder run ids + per-run flood breaker.
 *
 * THE INCIDENT (operator box, measured 2026-09-16): a crash-looping
 * presentation runner POSTed a `phase_exit` event ~50 times per second for two
 * days. `presentation_stage_timings` went from ~3,400 rows to 1,481,914 and the
 * database to 875 MB. 1,394,621 of those rows carried `run_id = 'run'` — a
 * literal placeholder — and every one took the LEGACY insert path (event_id
 * NULL), which had no dedupe key and no ceiling.
 *
 * Drives the REAL POST /api/presentations/stage-timings handler against an
 * isolated DB, signed exactly as the engine signs (HMAC-SHA256 over the raw
 * body, same helper shape as fix5-stage-timings-ingest.test.ts). No network.
 *
 * Proves:
 *   1. run_id 'run' is refused 400 and lands ZERO rows (the incident's own id),
 *      along with the rest of the denylist, case/whitespace variants, and the
 *      4-character floor — while a real run id is still accepted,
 *   2. 599 rows in the last 10 minutes still accept the next batch; the row
 *      that reaches the limit flips the breaker to 429 + Retry-After: 600,
 *   3. three refused batches in a row raise EXACTLY ONE
 *      `stage_timings_flood_refused` event (one alert, not a thousand),
 *   4. the lifetime ceiling trips on a run whose 10-minute window is quiet,
 *   5. STAGE_TIMINGS_MAX_ROWS_PER_10MIN / STAGE_TIMINGS_MAX_ROWS_PER_RUN are
 *      honored, both tighter and looser than the defaults.
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`).
 */

import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { getDb } from '../../src/lib/db';
import {
  DEFAULT_MAX_ROWS_PER_10MIN,
  isPlaceholderRunId,
  PLACEHOLDER_RUN_IDS,
} from '../../src/lib/presentations/stage-timings-guard';

const WEBHOOK_SECRET = 'flood-breaker-itest-secret-not-a-real-one';
process.env.WEBHOOK_SECRET = WEBHOOK_SECRET;
// The breaker reads its ceilings per request; start every file run from the
// documented defaults so an inherited env cannot silently change a limit.
delete process.env.STAGE_TIMINGS_MAX_ROWS_PER_10MIN;
delete process.env.STAGE_TIMINGS_MAX_ROWS_PER_RUN;

const SUITE = randomUUID().slice(0, 8);
const runId = (label: string) => `flood-${label}-${SUITE}`;

function phaseExitRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: runId('unset'),
    phase_id: 'C',
    wave: 1,
    model_used: null,
    event: 'phase_exit',
    started_at: '2026-09-16T23:27:00-04:00',
    ended_at: '2026-09-16T23:27:01-04:00',
    duration_s: 0.4,
    status: 'nonzero_rc_3',
    return_code: 3,
    ...overrides,
  };
}

function sign(rawBody: string): string {
  return createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
}

async function postRows(rows: unknown[]): Promise<Response> {
  const { POST } = await import('../../src/app/api/presentations/stage-timings/route');
  const rawBody = JSON.stringify({ rows });
  const req = new NextRequest('http://localhost/api/presentations/stage-timings', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-webhook-signature': sign(rawBody),
    },
    body: rawBody,
  });
  return POST(req);
}

/**
 * Seed N rows for a run directly, `minutesAgo` in the past.
 *
 * `created_at` is written in SQLite's own `datetime('now')` shape
 * ('YYYY-MM-DD HH:MM:SS', UTC) — the exact format the route's INSERT DEFAULT
 * produces — so the breaker's sargable string comparison sees seeded and real
 * rows identically.
 */
function seedRows(run: string, count: number, minutesAgo: number): void {
  const db = getDb();
  const stamp = db
    .prepare(`SELECT datetime('now', ?) AS t`)
    .get(`-${minutesAgo} minutes`) as { t: string };
  const insert = db.prepare(
    `INSERT INTO presentation_stage_timings
       (run_id, event, phase_id, status, payload, created_at)
     VALUES (?, 'phase_exit', 'C', 'nonzero_rc_3', '{}', ?)`,
  );
  const many = db.transaction(() => {
    for (let i = 0; i < count; i += 1) insert.run(run, stamp.t);
  });
  many();
}

function rowCount(run: string): number {
  return (
    getDb()
      .prepare('SELECT COUNT(*) AS n FROM presentation_stage_timings WHERE run_id = ?')
      .get(run) as { n: number }
  ).n;
}

function floodEventCount(run: string): number {
  return (
    getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM events WHERE type = 'stage_timings_flood_refused' AND message LIKE ?`,
      )
      .get(`%${run}%`) as { n: number }
  ).n;
}

// ── 1. Placeholder run ids ───────────────────────────────────────────────────

test('placeholder run_id "run" is refused 400 and inserts zero rows', async () => {
  const before = (
    getDb().prepare('SELECT COUNT(*) AS n FROM presentation_stage_timings').get() as { n: number }
  ).n;

  const res = await postRows([phaseExitRow({ run_id: 'run' })]);

  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string; run_id: string };
  assert.equal(body.run_id, 'run');
  assert.match(body.error, /placeholder, not a run id/);
  assert.equal(rowCount('run'), 0, 'the refused batch must not land a single row');

  const after = (
    getDb().prepare('SELECT COUNT(*) AS n FROM presentation_stage_timings').get() as { n: number }
  ).n;
  assert.equal(after, before, 'no row anywhere in the table may change');
});

test('every denylisted placeholder, its case/space variants, and sub-4-char ids are refused', async () => {
  for (const placeholder of PLACEHOLDER_RUN_IDS) {
    const res = await postRows([phaseExitRow({ run_id: placeholder })]);
    assert.equal(res.status, 400, `${placeholder} must be refused`);
  }
  for (const variant of ['RUN', ' run ', 'Test', 'NULL', 'abc', 'x']) {
    const res = await postRows([phaseExitRow({ run_id: variant })]);
    assert.equal(res.status, 400, `${JSON.stringify(variant)} must be refused`);
  }
  // The helper is the single definition both route and test read.
  assert.equal(isPlaceholderRunId('run'), true);
  assert.equal(isPlaceholderRunId(' RUN '), true);
  assert.equal(isPlaceholderRunId('abc'), true);
  assert.equal(isPlaceholderRunId('deck-2026-09-16-a41f'), false);
});

test('a real run id is still accepted and lands its row', async () => {
  const run = runId('accept');
  const res = await postRows([phaseExitRow({ run_id: run })]);
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { ok: true, accepted: 1 });
  assert.equal(rowCount(run), 1);
});

test('one placeholder row refuses the WHOLE batch — no partial accept', async () => {
  const run = runId('mixed');
  const res = await postRows([
    phaseExitRow({ run_id: run }),
    phaseExitRow({ run_id: 'run' }),
  ]);
  assert.equal(res.status, 400);
  assert.equal(rowCount(run), 0, 'the well-formed row in the batch must not land either');
});

// ── 2/3. Per-run rate window + single alert ──────────────────────────────────

test('599 rows in 10 minutes still accepts; the 600th trips 429 with Retry-After 600', async () => {
  const run = runId('window');
  seedRows(run, DEFAULT_MAX_ROWS_PER_10MIN - 1, 2);
  assert.equal(rowCount(run), 599);

  const accepted = await postRows([phaseExitRow({ run_id: run })]);
  assert.equal(accepted.status, 201, 'at 599 rows the run is still under the limit');
  assert.deepEqual(await accepted.json(), { ok: true, accepted: 1 });
  assert.equal(rowCount(run), 600);

  const refused = await postRows([phaseExitRow({ run_id: run })]);
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get('Retry-After'), '600');
  const body = (await refused.json()) as {
    error: string;
    run_id: string;
    rows_last_10_min: number;
    limit: number;
  };
  assert.equal(body.run_id, run);
  assert.equal(body.rows_last_10_min, 600);
  assert.equal(body.limit, DEFAULT_MAX_ROWS_PER_10MIN);
  assert.match(body.error, /flood breaker/);
  assert.match(body.error, /the runner is looping/);
  assert.equal(rowCount(run), 600, 'a refused batch adds nothing');
});

test('three refused batches in a row raise exactly one flood event', async () => {
  const run = runId('alert');
  seedRows(run, DEFAULT_MAX_ROWS_PER_10MIN, 1);
  assert.equal(floodEventCount(run), 0);

  for (let i = 0; i < 3; i += 1) {
    const res = await postRows([phaseExitRow({ run_id: run })]);
    assert.equal(res.status, 429, `batch ${i + 1} must be refused`);
  }

  assert.equal(
    floodEventCount(run),
    1,
    'the alert is once per run per 60 minutes — a looping runner must not flood the events table too',
  );
  const event = getDb()
    .prepare(
      `SELECT task_id, message FROM events WHERE type = 'stage_timings_flood_refused' AND message LIKE ?`,
    )
    .get(`%${run}%`) as { task_id: string | null; message: string };
  assert.equal(event.task_id, null, 'the flood alert belongs to no task');
  assert.match(event.message, new RegExp(run));
  assert.match(event.message, /600 events in the last 10 minutes/);
});

// ── 4. Lifetime ceiling ──────────────────────────────────────────────────────

test('lifetime ceiling refuses a run whose 10-minute window is quiet', async () => {
  const run = runId('lifetime');
  process.env.STAGE_TIMINGS_MAX_ROWS_PER_RUN = '50';
  try {
    // Every row is 3 hours old: the rate window sees ZERO, so only the
    // lifetime ceiling can refuse this batch.
    seedRows(run, 50, 180);
    const res = await postRows([phaseExitRow({ run_id: run })]);

    assert.equal(res.status, 429);
    assert.equal(res.headers.get('Retry-After'), '600');
    const body = (await res.json()) as {
      error: string;
      rows_last_10_min: number;
      rows_total: number;
      limit: number;
    };
    assert.equal(body.rows_last_10_min, 0, 'the rate window really is quiet');
    assert.equal(body.rows_total, 50);
    assert.equal(body.limit, 50);
    assert.match(body.error, /lifetime ceiling/);
    assert.equal(rowCount(run), 50);
  } finally {
    delete process.env.STAGE_TIMINGS_MAX_ROWS_PER_RUN;
  }
});

test('under the lifetime ceiling the same run still writes', async () => {
  const run = runId('under-lifetime');
  process.env.STAGE_TIMINGS_MAX_ROWS_PER_RUN = '50';
  try {
    seedRows(run, 49, 180);
    const res = await postRows([phaseExitRow({ run_id: run })]);
    assert.equal(res.status, 201);
    assert.equal(rowCount(run), 50);
  } finally {
    delete process.env.STAGE_TIMINGS_MAX_ROWS_PER_RUN;
  }
});

// ── 5. Env overrides ─────────────────────────────────────────────────────────

test('STAGE_TIMINGS_MAX_ROWS_PER_10MIN tightens and loosens the window limit', async () => {
  const run = runId('env-window');
  seedRows(run, 5, 1);

  process.env.STAGE_TIMINGS_MAX_ROWS_PER_10MIN = '5';
  try {
    const refused = await postRows([phaseExitRow({ run_id: run })]);
    assert.equal(refused.status, 429, 'a limit of 5 must refuse a run that already has 5');
    const body = (await refused.json()) as { limit: number; rows_last_10_min: number };
    assert.equal(body.limit, 5);
    assert.equal(body.rows_last_10_min, 5);
  } finally {
    delete process.env.STAGE_TIMINGS_MAX_ROWS_PER_10MIN;
  }

  process.env.STAGE_TIMINGS_MAX_ROWS_PER_10MIN = '10000';
  try {
    const accepted = await postRows([phaseExitRow({ run_id: run })]);
    assert.equal(accepted.status, 201, 'a loosened limit accepts the same run');
    assert.equal(rowCount(run), 6);
  } finally {
    delete process.env.STAGE_TIMINGS_MAX_ROWS_PER_10MIN;
  }
});

test('a garbage or non-positive env value falls back to the default limit', async () => {
  const run = runId('env-garbage');
  seedRows(run, DEFAULT_MAX_ROWS_PER_10MIN, 1);

  for (const bad of ['not-a-number', '0', '-5', '']) {
    process.env.STAGE_TIMINGS_MAX_ROWS_PER_10MIN = bad;
    try {
      const res = await postRows([phaseExitRow({ run_id: run })]);
      assert.equal(res.status, 429, `env "${bad}" must fall back to the default, not disable the breaker`);
      const body = (await res.json()) as { limit: number };
      assert.equal(body.limit, DEFAULT_MAX_ROWS_PER_10MIN);
    } finally {
      delete process.env.STAGE_TIMINGS_MAX_ROWS_PER_10MIN;
    }
  }
});

// ── Regression guard: the breaker is per-run, not global ─────────────────────

test('a flooding run never blocks a different, healthy run', async () => {
  const noisy = runId('noisy');
  const healthy = runId('healthy');
  seedRows(noisy, DEFAULT_MAX_ROWS_PER_10MIN, 1);

  const blocked = await postRows([phaseExitRow({ run_id: noisy })]);
  assert.equal(blocked.status, 429);

  const ok = await postRows([phaseExitRow({ run_id: healthy })]);
  assert.equal(ok.status, 201);
  assert.equal(rowCount(healthy), 1);
});

// ── Regression guard: migration 148's indexes exist ──────────────────────────

test('migration 148 created the indexes the breaker counts on', () => {
  const names = (
    getDb()
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='presentation_stage_timings'`)
      .all() as { name: string }[]
  ).map((r) => r.name);
  assert.ok(
    names.includes('idx_presentation_stage_timings_run_created'),
    `expected idx_presentation_stage_timings_run_created, got ${names.join(', ')}`,
  );
  assert.ok(
    names.includes('idx_presentation_stage_timings_created'),
    `expected idx_presentation_stage_timings_created, got ${names.join(', ')}`,
  );
});
