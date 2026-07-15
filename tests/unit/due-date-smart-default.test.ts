/**
 * U103 (E4-6, v1 U48) — Due-date smart default in `createTaskCore`.
 *
 * `createTaskCore` (src/lib/tasks.ts) now stamps a priority-based,
 * NON-BINDING `due_date` at creation ONLY when the caller supplied no
 * `due_date` key at all (`undefined`) — the shape a producer/ingest payload
 * has when it never mentions due dates (verified: `/api/tasks/ingest` never
 * sends the key). Ladder (mirrors the E4-6 spec's worked example, with the
 * real `TaskPriority` enum's `critical` standing in for the spec's
 * illustrative "urgent"):
 *
 *   critical -> +1 day
 *   high     -> +3 days
 *   medium   -> +7 days
 *   low      -> +14 days
 *
 * An EXPLICIT `due_date: null` — the operator UI's literal "New Task"
 * default-state payload (TaskModal's `form.due_date || null`, locked by
 * tests/unit/create-task-null-fields.test.ts) — is a deliberate "no due
 * date" signal and must persist as null, byte-identical to pre-U103
 * behaviour. An explicit date string is likewise never overridden.
 *
 * Covers all four E4-6 BINARY acceptance points:
 *   (a) no caller-supplied due date -> priority-mapped default, per priority
 *   (b) an explicitly-supplied date is NEVER overridden
 *   (c) an explicit null (the "cleared" shape) persists null, never re-defaulted
 *   (d) no prompt/notification rides along with the default (event-shape parity
 *       with the explicit-date path; no due-date-prompt event text)
 *
 * Strategy mirrors tests/unit/task-ingest-dedup.test.ts: isolated temp DB
 * (DATABASE_PATH set in the file body BEFORE any dynamic project import —
 * see the C8 hoisting note there), createTaskCore invoked directly with
 * `{ notifyGateway: false }` so no real webhook fetch fires.
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-due-date-default-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;
process.env.OPENCLAW_ROOT = '/nonexistent/openclaw-root-for-tests';
// No embedding keys -> SOP auto-suggest / persona selection / routing stay on
// their deterministic, network-free fallback paths (matches sibling tests).
delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.GEMINI_API_KEY;

const RUN_ID = Math.random().toString(36).slice(2, 10);
const WS_ID = `ws-due-date-${RUN_ID}`;

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let queryAll: DbModule['queryAll'];
let closeDb: DbModule['closeDb'];

type TasksModule = typeof import('../../src/lib/tasks');
let createTaskCore: TasksModule['createTaskCore'];
let computeDueDateSmartDefault: TasksModule['computeDueDateSmartDefault'];
let OFFSET_DAYS: TasksModule['DUE_DATE_SMART_DEFAULT_OFFSET_DAYS'];

const DAY_MS = 24 * 60 * 60 * 1000;
// Generous tolerance for wall-clock skew between computing the "expected"
// timestamp in the test and createTaskCore stamping `now` internally.
const TOLERANCE_MS = 15_000;

test.before(async () => {
  const db = (await import('../../src/lib/db')) as DbModule;
  run = db.run;
  queryOne = db.queryOne;
  queryAll = db.queryAll;
  closeDb = db.closeDb;
  db.getDb(); // runs the full migration chain against the temp DB

  const now = new Date().toISOString();
  run(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES ('default', 'Default', 'default', '{}', ?, ?)`,
    [now, now],
  );
  run(
    `INSERT OR IGNORE INTO workspaces (id, slug, name, icon, company_id, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, '🧪', 'default', 1, ?, ?)`,
    [WS_ID, `due-date-test-${RUN_ID}`, 'Due Date Test', now, now],
  );

  const tasks = (await import('../../src/lib/tasks')) as TasksModule;
  createTaskCore = tasks.createTaskCore;
  computeDueDateSmartDefault = tasks.computeDueDateSmartDefault;
  OFFSET_DAYS = tasks.DUE_DATE_SMART_DEFAULT_OFFSET_DAYS;
});

test.after(() => {
  try {
    closeDb();
  } catch {
    /* best-effort */
  }
  try {
    fs.rmSync(path.dirname(TMP_DB), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// ── the exact E4-6 ladder, pure helper (no DB) ───────────────────────────────

test('DUE_DATE_SMART_DEFAULT_OFFSET_DAYS is exactly the 4-priority ladder: critical=1, high=3, medium=7, low=14', () => {
  assert.deepEqual(OFFSET_DAYS, { critical: 1, high: 3, medium: 7, low: 14 });
});

for (const [priority, days] of Object.entries({ critical: 1, high: 3, medium: 7, low: 14 })) {
  test(`computeDueDateSmartDefault('${priority}') offsets exactly +${days}d from the given instant`, () => {
    const from = new Date('2026-07-15T12:00:00.000Z');
    const result = computeDueDateSmartDefault(priority as 'critical' | 'high' | 'medium' | 'low', from);
    assert.equal(result, new Date(from.getTime() + days * DAY_MS).toISOString());
  });
}

test('computeDueDateSmartDefault defaults to `medium`\'s offset for an unrecognised priority (defensive fallback)', () => {
  const from = new Date('2026-07-15T12:00:00.000Z');
  // @ts-expect-error deliberately passing an out-of-union value to exercise the ?? fallback
  const result = computeDueDateSmartDefault('not-a-real-priority', from);
  assert.equal(result, new Date(from.getTime() + 7 * DAY_MS).toISOString());
});

// ── (a) no caller-supplied due date -> priority-mapped default, per priority ─

for (const [priority, days] of Object.entries({ critical: 1, high: 3, medium: 7, low: 14 })) {
  test(`createTaskCore: priority='${priority}', due_date key omitted -> persists the +${days}d smart default`, async () => {
    const before = Date.now();
    const result = await createTaskCore(
      {
        title: `Smart default ${priority} ${RUN_ID}`,
        workspace_id: WS_ID,
        status: 'backlog',
        priority: priority as 'critical' | 'high' | 'medium' | 'low',
        skipWindowDedup: true,
        // due_date intentionally NOT set -> input.due_date is undefined
      },
      { notifyGateway: false },
    );
    assert.ok(result, `task creation must succeed for priority '${priority}'`);
    assert.equal(result!.deduped, false);

    const dueDate = result!.task.due_date as unknown as string | null;
    assert.ok(dueDate, `due_date must be stamped (never left null) when omitted, priority='${priority}'`);
    const actualMs = new Date(dueDate as string).getTime();
    const expectedMs = before + days * DAY_MS;
    assert.ok(
      Math.abs(actualMs - expectedMs) < TOLERANCE_MS,
      `priority='${priority}' expected due_date ~${new Date(expectedMs).toISOString()}, got ${dueDate}`,
    );

    // Persisted row matches the returned task (the default actually landed in the DB).
    const row = queryOne<{ due_date: string | null }>('SELECT due_date FROM tasks WHERE id = ?', [result!.task.id]);
    assert.equal(row?.due_date, dueDate);
  });
}

test('createTaskCore: priority AND due_date both omitted -> "medium" default priority carries its own +7d default', async () => {
  const before = Date.now();
  const result = await createTaskCore(
    {
      title: `No priority no date ${RUN_ID}`,
      workspace_id: WS_ID,
      status: 'backlog',
      skipWindowDedup: true,
    },
    { notifyGateway: false },
  );
  assert.ok(result);
  assert.equal(result!.task.priority, 'medium', 'priority itself still defaults to medium, unchanged from today');
  const dueDate = result!.task.due_date as unknown as string | null;
  assert.ok(dueDate);
  const actualMs = new Date(dueDate as string).getTime();
  assert.ok(Math.abs(actualMs - (before + 7 * DAY_MS)) < TOLERANCE_MS);
});

// ── (b) an explicitly-supplied date is NEVER overridden ──────────────────────

test('createTaskCore: an explicit due_date is preserved byte-identical, regardless of priority', async () => {
  const explicit = '2027-03-04T00:00:00.000Z';
  const result = await createTaskCore(
    {
      title: `Explicit date ${RUN_ID}`,
      workspace_id: WS_ID,
      status: 'backlog',
      priority: 'low', // low's own default (+14d) must NOT win over the explicit date
      due_date: explicit,
      skipWindowDedup: true,
    },
    { notifyGateway: false },
  );
  assert.ok(result);
  assert.equal(result!.task.due_date, explicit);

  const row = queryOne<{ due_date: string | null }>('SELECT due_date FROM tasks WHERE id = ?', [result!.task.id]);
  assert.equal(row?.due_date, explicit);
});

// ── (c) an explicit null (the "cleared"/TaskModal-default shape) persists
//        null and is never re-defaulted — byte-identical to pre-U103. ────────

test('createTaskCore: explicit due_date:null (TaskModal "no date" default payload) persists null — never defaulted', async () => {
  const result = await createTaskCore(
    {
      title: `Cleared date ${RUN_ID}`,
      workspace_id: WS_ID,
      status: 'backlog',
      priority: 'critical', // critical's own default (+1d) must NOT win over the explicit clear
      due_date: null,
      skipWindowDedup: true,
    },
    { notifyGateway: false },
  );
  assert.ok(result);
  assert.equal(
    result!.task.due_date,
    null,
    'an explicit null is a deliberate "no due date" and must never be overridden by the smart default',
  );

  const row = queryOne<{ due_date: string | null }>('SELECT due_date FROM tasks WHERE id = ?', [result!.task.id]);
  assert.equal(row?.due_date, null, 'the cleared/null state is what actually persisted, not a re-defaulted value');
});

test('createTaskCore: due_date:"" (falsy-but-not-undefined) also persists null — unchanged pre-existing behaviour', async () => {
  const result = await createTaskCore(
    {
      title: `Empty-string date ${RUN_ID}`,
      workspace_id: WS_ID,
      status: 'backlog',
      priority: 'high',
      due_date: '',
      skipWindowDedup: true,
    },
    { notifyGateway: false },
  );
  assert.ok(result);
  assert.equal(result!.task.due_date, null, 'an explicitly-supplied empty string is not "omitted" and must not be defaulted');
});

// ── (d) no client-facing prompt/notification rides along with the default ───

test('createTaskCore: the smart default fires no extra event/notification beyond ordinary task creation', async () => {
  const withDefault = await createTaskCore(
    {
      title: `No-prompt default ${RUN_ID}`,
      workspace_id: WS_ID,
      status: 'backlog',
      priority: 'high',
      skipWindowDedup: true,
    },
    { notifyGateway: false },
  );
  const withExplicit = await createTaskCore(
    {
      title: `No-prompt explicit ${RUN_ID}`,
      workspace_id: WS_ID,
      status: 'backlog',
      priority: 'high',
      due_date: '2027-01-01T00:00:00.000Z',
      skipWindowDedup: true,
    },
    { notifyGateway: false },
  );
  assert.ok(withDefault && withExplicit);

  const eventsForDefault = queryAll<{ type: string; message: string }>(
    'SELECT type, message FROM events WHERE task_id = ? ORDER BY created_at ASC',
    [withDefault!.task.id],
  );
  const eventsForExplicit = queryAll<{ type: string; message: string }>(
    'SELECT type, message FROM events WHERE task_id = ? ORDER BY created_at ASC',
    [withExplicit!.task.id],
  );

  assert.ok(eventsForDefault.length > 0, 'sanity: task creation logs at least one event');
  // Identical event-type shape whether or not the smart default applied —
  // proves stamping the default piggybacks NOTHING extra (no prompt/notify row).
  assert.deepEqual(
    eventsForDefault.map((e) => e.type),
    eventsForExplicit.map((e) => e.type),
    'the smart-default path must fire the exact same event types as the explicit-date path',
  );

  for (const e of [...eventsForDefault, ...eventsForExplicit]) {
    assert.ok(
      !/due[\s-]?date/i.test(e.message),
      `no event message may reference a due-date prompt/question, got: "${e.message}"`,
    );
  }
});
