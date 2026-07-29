/**
 * persona-choice-route.test.ts — U064 route-level tests.
 *
 * Proves the POST /api/tasks/[id]/persona-choice endpoint's two actions
 * behave correctly against a throwaway database:
 *
 *   - reaim writes NONE of the three client-choice columns, returns rescored
 *   - name-voice writes all three, returns blend_suppressed: true
 *   - persona_source outside CLIENT_FINAL_PERSONA_SOURCES → 400
 *   - name-voice on a task with no bundle row → 409
 *   - name-voice twice with identical values → one activity row (idempotent)
 *   - the migration (116) is a no-op on re-run
 *   - the CHECK constraint rejects out-of-vocabulary INSERTs
 *
 * Node built-in test runner under tsx.  DATABASE_PATH points at a throwaway
 * file BEFORE @/lib/db is imported.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-persona-choice-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;
process.env.OPENCLAW_ROOT = '/nonexistent/openclaw-root-for-tests';
process.env.DISABLE_QC_AUTO_SCORER = 'true';

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let queryAll: DbModule['queryAll'];
let getDb: DbModule['getDb'];
let closeDb: DbModule['closeDb'];

type MigrationsModule = typeof import('../../src/lib/db/migrations');
let runMigrations: MigrationsModule['runMigrations'];

type TypesModule = typeof import('../../src/lib/types');
let CLIENT_FINAL_PERSONA_SOURCES: TypesModule['CLIENT_FINAL_PERSONA_SOURCES'];

let counter = 0;
const nextId = (p: string) => `${p}-${++counter}`;

function seedTask(id: string): void {
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, department, created_at, updated_at)
     VALUES (?, ?, 'backlog', 'medium', NULL, NULL, 'marketing', ?, ?)`,
    [id, `Test task ${id}`, now, now],
  );
}

function seedBundle(taskId: string): void {
  const now = new Date().toISOString();
  const b = JSON.stringify({
    topic: 'SaaS pricing',
    confirm_required: true,
    voice: {
      audience_persona: { id: 'vp1', why: 'founder voice' },
      topic_persona: { id: 'tp1', why: 'pricing craft' },
      collapsed: false,
    },
    blend_directive: 'Write in founder voice with pricing expertise.',
    task_personas: [{ seq: 1, part: 'headline', persona_id: 'tp1', why: 'headline' }],
    catalog_version: '1.3',
  });
  run(
    `INSERT INTO task_persona_bundle (task_id, bundle_json, catalog_version, confirm_state, created_at)
     VALUES (?, ?, '1.3', 'pending', ?)`,
    [taskId, b, now],
  );
}

const load = async (p: string): Promise<Record<string, unknown>> => {
  const m = await import(p);
  return (m.default ?? m) as Record<string, unknown>;
};

test.before(async () => {
  const db = (await load('../../src/lib/db')) as unknown as DbModule;
  ({ run, queryOne, queryAll, getDb, closeDb } = db);
  const mig = (await load('../../src/lib/db/migrations')) as unknown as MigrationsModule;
  ({ runMigrations } = mig);
  const types = (await load('../../src/lib/types')) as unknown as TypesModule;
  ({ CLIENT_FINAL_PERSONA_SOURCES } = types);
  runMigrations(getDb());
});

test.after(() => {
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DB, { force: true }); } catch { /* ignore */ }
  try { fs.rmdirSync(path.dirname(TMP_DB)); } catch { /* ignore */ }
});

// ── Helpers ────────────────────────────────────────────────────────────

async function callRoute(
  id: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { POST } = (await load('../../src/app/api/tasks/[id]/persona-choice/route')) as {
    POST: (
      req: { json: () => Promise<unknown>; headers: { get: () => null } },
      ctx: { params: Promise<{ id: string }> },
    ) => Promise<{ status: number; json: () => Promise<unknown> }>;
  };
  const res = await POST(
    { json: async () => body, headers: { get: () => null } },
    { params: Promise.resolve({ id }) },
  );
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  // NextResponse sets status on the response object differently; extract it.
  const status = (res as unknown as { status?: number }).status ?? 200;
  return { status, body: json };
}

// ── Route tests ────────────────────────────────────────────────────────

test('[route] reaim writes NONE of the three client-choice columns, returns rescored', async () => {
  const id = nextId('reaim');
  seedTask(id);
  seedBundle(id);

  const { status, body } = await callRoute(id, {
    action: 'reaim',
    audience_label: 'founders',
  });

  assert.equal(status, 200, 'reaim should return 200');
  assert.ok(body.success, 'reaim should succeed');
  assert.ok('rescored' in body, 'reaim response must include rescored');

  const row = queryOne<{
    client_persona_id: string | null;
    client_persona_source: string | null;
    client_persona_set_at: string | null;
  }>(
    'SELECT client_persona_id, client_persona_source, client_persona_set_at FROM task_persona_bundle WHERE task_id = ?',
    [id],
  );
  assert.ok(row, 'bundle row must exist');
  assert.equal(row.client_persona_id, null, 'reaim must NOT write client_persona_id');
  assert.equal(row.client_persona_source, null, 'reaim must NOT write client_persona_source');
  assert.equal(row.client_persona_set_at, null, 'reaim must NOT write client_persona_set_at');
});

test('[route] name-voice with each of the five legal sources writes the row', async () => {
  const sources = [...CLIENT_FINAL_PERSONA_SOURCES] as string[];
  assert.equal(sources.length, 5, 'must have exactly 5 legal sources');

  for (const source of sources) {
    const id = nextId(`nv-${source}`);
    seedTask(id);
    seedBundle(id);

    const { status, body } = await callRoute(id, {
      action: 'name-voice',
      persona_id: `persona-${source}`,
      persona_source: source,
    });

    assert.equal(status, 200, `name-voice with source "${source}" should return 200`);
    assert.ok(body.success, `name-voice with source "${source}" should succeed`);
    assert.equal(body.blend_suppressed, true, `name-voice with source "${source}" must return blend_suppressed: true`);
    assert.equal(body.persona_id, `persona-${source}`, 'persona_id must be echoed');
    assert.equal(body.persona_source, source, 'persona_source must be echoed');

    const row = queryOne<{
      client_persona_id: string;
      client_persona_source: string;
      client_persona_set_at: string;
    }>(
      'SELECT client_persona_id, client_persona_source, client_persona_set_at FROM task_persona_bundle WHERE task_id = ?',
      [id],
    );
    assert.ok(row, `bundle row for source "${source}" must exist`);
    assert.equal(row.client_persona_id, `persona-${source}`);
    assert.equal(row.client_persona_source, source);
    assert.ok(row.client_persona_set_at, 'client_persona_set_at must be set');
  }
});

test('[route] persona_source "suggestion" (not a member) → 400', async () => {
  const id = nextId('badsource');
  seedTask(id);
  seedBundle(id);

  const { status, body } = await callRoute(id, {
    action: 'name-voice',
    persona_id: 'p-bad',
    persona_source: 'suggestion',
  });

  assert.equal(status, 400, 'illegal source must return 400');
  assert.ok(body.error, 'error must be present');

  // Verify nothing was written
  const row = queryOne<{
    client_persona_id: string | null;
    client_persona_source: string | null;
  }>(
    'SELECT client_persona_id, client_persona_source FROM task_persona_bundle WHERE task_id = ?',
    [id],
  );
  assert.ok(row, 'bundle row must exist');
  assert.equal(row.client_persona_id, null, 'no client_persona_id should have been written');
  assert.equal(row.client_persona_source, null, 'no client_persona_source should have been written');
});

test('[route] name-voice on a task with no bundle row → 409', async () => {
  const id = nextId('nobundle');
  seedTask(id);
  // Deliberately do NOT seed a bundle row.

  const { status, body } = await callRoute(id, {
    action: 'name-voice',
    persona_id: 'p',
    persona_source: 'client-choice',
  });

  assert.equal(status, 409, 'task with no bundle must return 409');
  assert.ok(body.error, 'error must be present');
});

test('[route] name-voice twice with identical values → one activity row, not two', async () => {
  const id = nextId('idem');
  seedTask(id);
  seedBundle(id);

  const body = {
    action: 'name-voice',
    persona_id: 'ogilvy',
    persona_source: 'client-choice',
  };

  // First call
  const { status: s1 } = await callRoute(id, body);
  assert.equal(s1, 200);

  // Second call (same values)
  const { status: s2 } = await callRoute(id, body);
  assert.equal(s2, 200);

  const rows = queryAll<{ id: string }>(
    `SELECT id FROM task_activities
      WHERE task_id = ?
        AND activity_type = 'persona_choice'
        AND json_extract(metadata, '$.persona_id') = ?
        AND json_extract(metadata, '$.persona_source') = ?`,
    [id, 'ogilvy', 'client-choice'],
  );
  assert.equal(rows.length, 1, 'only ONE activity row should exist — idempotent');
});

test('[route] name-voice response carries blend_suppressed: true', async () => {
  const id = nextId('blendsup');
  seedTask(id);
  seedBundle(id);

  const { status, body } = await callRoute(id, {
    action: 'name-voice',
    persona_id: 'p-suppress',
    persona_source: 'client-choice',
  });

  assert.equal(status, 200);
  assert.strictEqual(body.blend_suppressed, true, 'response must carry blend_suppressed: true');
});

// ── Migration idempotency ──────────────────────────────────────────────

test('[migration] runMigrations twice — second run is a no-op (no duplicate-column error)', () => {
  // The migrations have already run once in test.before.
  // Running again must not throw.
  assert.doesNotThrow(() => {
    runMigrations(getDb());
  }, 'second migration run must be a no-op');
});

test('[migration] schema.ts has all three U064 columns + CHECK constraint', () => {
  const cols = (queryAll<{ name: string; type: string }>(
    'PRAGMA table_info(task_persona_bundle)',
  )).map((c) => c.name);
  for (const col of ['client_persona_id', 'client_persona_source', 'client_persona_set_at']) {
    assert.ok(cols.includes(col), `task_persona_bundle.${col} must exist`);
  }
});

test('[migration] CHECK constraint rejects out-of-vocabulary INSERT', () => {
  const id = nextId('checkfail');
  seedTask(id);

  // The CHECK is on client_persona_source: must be NULL or one of the five.
  assert.throws(
    () => {
      run(
        `INSERT INTO task_persona_bundle (task_id, bundle_json, client_persona_source)
         VALUES (?, '{}', 'suggestion')`,
        [id],
      );
    },
    /CHECK/,
    'database must reject an out-of-vocabulary client_persona_source',
  );

  // But each of the five legal values must succeed
  for (const source of CLIENT_FINAL_PERSONA_SOURCES) {
    const tid = nextId(`checkok-${source}`);
    seedTask(tid);
    assert.doesNotThrow(() => {
      run(
        `INSERT INTO task_persona_bundle (task_id, bundle_json, client_persona_source)
         VALUES (?, '{}', ?)`,
        [tid, source],
      );
    }, `legal source "${source}" must be accepted by CHECK`);
  }
});
