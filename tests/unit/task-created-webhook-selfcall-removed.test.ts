/**
 * CREATING A TASK MAKES NO HTTP CALL TO THIS PROCESS.
 *
 * `createTaskCore()` used to fire an unauthenticated POST from this process
 * back into this same process at `/api/webhooks/task-created`, once per task
 * created. It did nothing: routing moved IN-PROCESS to `routeTask()` (B4), and
 * the code's own comment recorded that the HTTP-to-WS-gateway call "was a
 * silent no-op … retained only as a best-effort announcement". What it did
 * produce was one `middleware_401` per created task, because the request
 * carries no webhook signature and the middleware rejects it before the route
 * runs.
 *
 * The board learns about the card from the `task_created` SSE broadcast, which
 * is the real notification path and is unaffected.
 *
 * This asserts the BEHAVIOUR, not the source: `fetch` is wrapped for the
 * duration of a real `createTaskCore()` call and every outbound URL recorded.
 * The old code invoked `fetch` synchronously inside its async IIFE, so a
 * restored self-call would be captured here even though it was never awaited.
 *
 * `/api/webhooks/task-created` itself is deliberately untouched and still
 * serves genuine EXTERNAL callers that sign their requests.
 */

// C8 — DB + filesystem isolation. MUST stay the first import.
import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-webhook-selfcall-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;

const RUN_ID = Math.random().toString(36).slice(2, 10);
const WS_ID = `ws-webhook-${RUN_ID}`;

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let closeDb: DbModule['closeDb'];

type TasksModule = typeof import('../../src/lib/tasks');
let createTaskCore: TasksModule['createTaskCore'];

/** Run `fn` with global.fetch wrapped; returns every URL it was called with. */
async function recordFetches(fn: () => Promise<unknown>): Promise<string[]> {
  const urls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: unknown) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : String((input as { url?: unknown })?.url ?? input);
    urls.push(url);
    return (realFetch as (i: unknown, x?: unknown) => Promise<Response>)(input, init);
  }) as typeof globalThis.fetch;
  try {
    await fn();
    // The old self-call was fired without being awaited. Give any queued
    // microtask/macrotask a turn so a restored one cannot slip past the assert.
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    globalThis.fetch = realFetch;
  }
  return urls;
}

test.before(async () => {
  const db = (await import('../../src/lib/db')) as DbModule;
  run = db.run;
  closeDb = db.closeDb;
  db.getDb(); // full migration chain against the temp DB

  const now = new Date().toISOString();
  run(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES ('default', 'Default', 'default', '{}', ?, ?)`,
    [now, now],
  );
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, description, icon, company_id, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'default', ?, ?, ?)`,
    [WS_ID, 'Webhook Test', `webhook-test-${RUN_ID}`, 'Test workspace', '🧪', 1, now, now],
  );

  const tasks = (await import('../../src/lib/tasks')) as TasksModule;
  createTaskCore = tasks.createTaskCore;
});

test.after(() => {
  try {
    if (typeof closeDb === 'function') closeDb();
  } catch {
    /* best-effort */
  }
  try {
    fs.rmSync(path.dirname(TMP_DB), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

test('REGRESSION: creating a task fires NO POST to /api/webhooks/task-created', async () => {
  let createdId: string | undefined;
  const urls = await recordFetches(async () => {
    const result = await createTaskCore({
      title: `Webhook self-call check [${RUN_ID}]`,
      workspace_id: WS_ID,
      status: 'backlog',
      priority: 'medium',
    });
    createdId = result?.task.id;
  });

  assert.ok(createdId, 'the task must actually be created — a no-op test proves nothing');
  const selfCalls = urls.filter((u) => u.includes('/api/webhooks/task-created'));
  assert.deepEqual(
    selfCalls,
    [],
    `createTaskCore must not call its own webhook. Saw: ${JSON.stringify(urls)}`,
  );
});

test('REGRESSION: the default path (no options at all) also fires no self-call', async () => {
  // The old code was gated on `options.notifyGateway !== false`, so the DEFAULT
  // — every caller that passed no options — is exactly the path that emitted a
  // 401 per task. Both option fields are accepted and ignored now; passing them
  // must still compile and must still make no call.
  const urls = await recordFetches(async () => {
    await createTaskCore(
      {
        title: `Webhook self-call check legacy opts [${RUN_ID}]`,
        workspace_id: WS_ID,
        status: 'backlog',
        priority: 'medium',
      },
      { notifyGateway: true, origin: 'http://localhost:4000' },
    );
  });

  assert.deepEqual(
    urls.filter((u) => u.includes('/api/webhooks/task-created')),
    [],
    'notifyGateway:true is accepted and ignored — it must not resurrect the self-call',
  );
});
