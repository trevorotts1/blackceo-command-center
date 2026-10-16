/**
 * B01 (milestone V02) — reserved migration 169 and the HQ typed persistence
 * layer. Acceptance: qc.md Q02 storage clauses that belong to this unit:
 *
 *   - fresh database bootstrap
 *   - representative populated pre-HQ upgrade, logical old rows/counts preserved
 *   - idempotent rerun (simulated reboot)
 *   - partial unique active-turn index (plus the other unique/partial constraints)
 *   - an interrupted/failed migration stays visible and leaves no half-written
 *     state that a later clean run cannot finish
 *
 * Real code exercised, never reimplemented: the actual `runMigrations()` from
 * `src/lib/db/migrations.ts` and the actual decoders from `src/lib/hq/storage.ts`.
 * Isolation: `./_isolated-db` first (C8 guard), plus a redirected HOME so the
 * boot path's department re-seed cannot pick up a real manifest from this box.
 */
import '../../_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { schema } from '../../../../src/lib/db/schema';
import { runMigrations, migrations, getLastFailedMigrationId } from '../../../../src/lib/db/migrations';
import {
  HQ_TABLES,
  HQ_ONE_ACTIVE_TURN_INDEX,
  checkHqSchemaReady,
  requireHqSchema,
  decodeHqActivityRow,
  decodeHqChatTurnRow,
  decodeHqRunBindingRow,
  decodeHqOwnerLoginUseRow,
  readHqActivityRow,
  readHqChatTurnRow,
  isNonterminalHqTurn,
} from '../../../../src/lib/hq/storage';

function freshDbPath(tag: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), `cc-b01-${tag}-`)), 'mission-control.test.db');
}

/** Boot path re-seeds departments from a manifest; point HOME at an empty dir. */
function withIsolatedHome<T>(fn: () => T): T {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-b01-isolated-home-'));
  const saved: Record<string, string | undefined> = {
    HOME: process.env.HOME,
    MASTER_FILES_DIR: process.env.MASTER_FILES_DIR,
    ZERO_HUMAN_COMPANY_DIR: process.env.ZERO_HUMAN_COMPANY_DIR,
    BLACKCEO_COMMAND_CENTER_ROOT: process.env.BLACKCEO_COMMAND_CENTER_ROOT,
  };
  process.env.HOME = isolatedHome;
  delete process.env.MASTER_FILES_DIR;
  delete process.env.ZERO_HUMAN_COMPANY_DIR;
  delete process.env.BLACKCEO_COMMAND_CENTER_ROOT;
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(isolatedHome, { recursive: true, force: true });
  }
}

const NOW = '2026-10-04T00:00:00.000Z';

/** A representative pre-HQ CC database: real base schema + real business rows. */
function seedPreHqDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.exec(schema);
  db.prepare(
    `INSERT INTO companies (id, name, slug, config, created_at, updated_at) VALUES (?, ?, ?, '{}', ?, ?)`,
  ).run('acme', 'Acme', 'acme', NOW, NOW);
  db.prepare(
    `INSERT INTO workspaces (id, name, slug, icon, company_id, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, '📁', ?, ?, ?, ?)`,
  ).run('master-orchestrator', 'CEO / COM', 'master-orchestrator', 'acme', 0, NOW, NOW);
  db.prepare(
    `INSERT INTO agents (id, name, role, is_master, workspace_id, specialist_type, created_at, updated_at)
     VALUES (?, ?, 'Head', 1, ?, 'permanent', ?, ?)`,
  ).run('head-agent-master-orchestrator', 'COM Head', 'master-orchestrator', NOW, NOW);
  // NOTE: the base tasks table carries `business_id`, not `company_id`
  // (schema.ts) — a migration-added column would be the deadlock class this
  // suite must not trip, so the fixture inserts only base columns.
  db.prepare(
    `INSERT INTO tasks (id, title, description, status, workspace_id, created_at)
     VALUES (?, ?, '', 'backlog', 'master-orchestrator', ?)`,
  ).run('task-prehq-1', 'Pre-HQ business row', NOW);
  return db;
}

/**
 * How many times migration `id` is recorded in the runner's ledger. 0 when the
 * ledger table itself does not exist yet — an interrupted run may be the very
 * first thing to touch this database, and "no ledger" is "nothing recorded",
 * not a query error that reads as a failure of the thing under test.
 */
function migrationRecorded(db: Database.Database, id: string): number {
  const hasLedger = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = '_migrations'`)
    .get();
  if (!hasLedger) return 0;
  return (db.prepare(`SELECT COUNT(*) AS n FROM _migrations WHERE id = ?`).get(id) as { n: number }).n;
}

function tableNames(db: Database.Database): Set<string> {
  return new Set(
    (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((r) => r.name),
  );
}

function indexNames(db: Database.Database): Set<string> {
  return new Set(
    (db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all() as { name: string }[]).map((r) => r.name),
  );
}

test('B01 (a) fresh: migration 169 is the head id, applies once, and creates every HQ table', () => {
  const dbPath = freshDbPath('fresh');
  const db = seedPreHqDb(dbPath);
  try {
    // The reservation is real: 169 exists exactly once and nothing is above it.
    const ids = migrations.map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length, 'duplicate migration id — the DATA-03 guard would throw at import');
    assert.equal(Math.max(...ids.map((n) => parseInt(n, 10))), 169, '169 must be the head migration');
    assert.equal(ids.filter((id) => id === '169').length, 1, '169 must be declared exactly once');

    // BEFORE the upgrade: none of the HQ tables exist. Known-negative control.
    const before = tableNames(db);
    for (const t of HQ_TABLES) assert.equal(before.has(t), false, `${t} must not exist pre-upgrade`);

    withIsolatedHome(() => runMigrations(db));

    const after = tableNames(db);
    for (const t of HQ_TABLES) assert.equal(after.has(t), true, `${t} must exist after migration 169`);
    assert.equal(indexNames(db).has(HQ_ONE_ACTIVE_TURN_INDEX), true, 'the partial active-turn index must exist');

    assert.equal(migrationRecorded(db, '169'), 1, '169 must be recorded exactly once');

    const readiness = checkHqSchemaReady(db);
    assert.equal(readiness.ok, true, `readiness must be ok, missing=${readiness.missingTables.join(',')}`);
  } finally {
    db.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('B01 (b) populated upgrade: logical business rows and counts survive 169', () => {
  const dbPath = freshDbPath('populated');
  const db = seedPreHqDb(dbPath);
  try {
    // Q02 asks to compare logical old row VALUES and counts, not whole SQLite
    // bytes. Two things make a naive whole-table diff the wrong instrument
    // here, both measured on this fixture rather than assumed:
    //   - the boot path runs its OWN seeders (departments, head promotion,
    //     `default` company) so tables legitimately GROW;
    //   - head promotion also FILLS a pre-existing workspace's `head_agent_id`
    //     and adds `original_slug`.
    // Neither is migration 169, so this test measures exactly what 169 must
    // guarantee: nothing pre-existing is DELETED or rewritten, and rows no
    // seeder touches are byte-identical. The seeder's own columns are excluded
    // by name and the exclusion is asserted, not silently skipped.
    // The columns the boot seeder legitimately rewrites/fills (measured, not
    // guessed: auto-seed head promotion sets `head_agent_id`). Everything else
    // a row carried BEFORE the boot must still read the same AFTER it.
    const SEEDER_TOUCHED_COLUMNS = ['head_agent_id'] as const;
    // The snapshot is taken BEFORE any migration runs, so it only carries the
    // columns that already existed. Later migrations 001..168 legitimately ADD
    // columns (returned as null for old rows) — that is schema growth, not row
    // damage, so the comparison is driven by the keys the old row actually had.
    const before = {
      company: db.prepare(`SELECT * FROM companies WHERE id = 'acme'`).get() as Record<string, unknown>,
      workspace: db
        .prepare(`SELECT * FROM workspaces WHERE id = 'master-orchestrator'`)
        .get() as Record<string, unknown>,
      agent: db
        .prepare(`SELECT * FROM agents WHERE id = 'head-agent-master-orchestrator'`)
        .get() as Record<string, unknown>,
      task: db.prepare(`SELECT * FROM tasks WHERE id = 'task-prehq-1'`).get() as Record<string, unknown>,
    };
    const compareOldColumns = (
      label: string,
      beforeRow: Record<string, unknown>,
      afterRow: Record<string, unknown> | undefined,
    ) => {
      assert.ok(afterRow, `${label} row must still exist after the boot`);
      for (const key of Object.keys(beforeRow)) {
        if ((SEEDER_TOUCHED_COLUMNS as readonly string[]).includes(key)) continue;
        assert.deepEqual(afterRow[key], beforeRow[key], `${label}.${key} must be unchanged by an additive migration`);
      }
    };
    // Every pre-existing row id, per table: the delete-detector.
    const idSets = Object.fromEntries(
      (['companies', 'workspaces', 'agents', 'tasks'] as const).map((table) => [
        table,
        new Set((db.prepare(`SELECT id FROM ${table}`).all() as { id: string }[]).map((r) => r.id)),
      ]),
    );

    withIsolatedHome(() => runMigrations(db));

    // 1. Nothing pre-existing disappeared.
    for (const table of ['companies', 'workspaces', 'agents', 'tasks'] as const) {
      const after = new Set(
        (db.prepare(`SELECT id FROM ${table}`).all() as { id: string }[]).map((r) => r.id),
      );
      for (const id of idSets[table]) {
        assert.equal(after.has(id), true, `${table} row ${id} must survive an additive migration`);
      }
    }

    // 2. Every value the pre-existing rows carried is still there, unchanged.
    compareOldColumns(
      'companies/acme',
      before.company,
      db.prepare(`SELECT * FROM companies WHERE id = 'acme'`).get() as Record<string, unknown>,
    );
    compareOldColumns(
      'workspaces/master-orchestrator',
      before.workspace,
      db.prepare(`SELECT * FROM workspaces WHERE id = 'master-orchestrator'`).get() as Record<string, unknown>,
    );
    compareOldColumns(
      'agents/head-agent-master-orchestrator',
      before.agent,
      db
        .prepare(`SELECT * FROM agents WHERE id = 'head-agent-master-orchestrator'`)
        .get() as Record<string, unknown>,
    );
    compareOldColumns(
      'tasks/task-prehq-1',
      before.task,
      db.prepare(`SELECT * FROM tasks WHERE id = 'task-prehq-1'`).get() as Record<string, unknown>,
    );

    // 3. The HQ DDL arrived and changed none of the above.
    assert.equal(checkHqSchemaReady(db).ok, true, 'readiness after the populated upgrade');
  } finally {
    db.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('B01 (c) rerun: a second boot applies nothing and destroys no HQ row', () => {
  const dbPath = freshDbPath('rerun');
  const db = seedPreHqDb(dbPath);
  try {
    withIsolatedHome(() => runMigrations(db));
    db.prepare(
      `INSERT INTO hq_activity (id, company_id, source_key, content_hash, kind, payload_json, received_at)
       VALUES ('evt-1', 'acme', 'task:task-prehq-1:created', 'hash-1', 'task', '{}', ?)`,
    ).run(NOW);

    withIsolatedHome(() => runMigrations(db)); // simulated reboot

    const rows = db.prepare(`SELECT id FROM hq_activity`).all() as { id: string }[];
    assert.deepEqual(rows.map((r) => r.id), ['evt-1'], 'rerun must not drop or duplicate an HQ row');
    assert.equal(migrationRecorded(db, '169'), 1, 'rerun must not re-record 169');
  } finally {
    db.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('B01 (d) constraints: unique activity key, one-active-turn partial index, turn/state/session uniqueness', () => {
  const dbPath = freshDbPath('constraints');
  const db = seedPreHqDb(dbPath);
  try {
    withIsolatedHome(() => runMigrations(db));

    const insertActivity = db.prepare(
      `INSERT INTO hq_activity (id, company_id, source_key, content_hash, kind, payload_json, received_at)
       VALUES (?, ?, ?, ?, 'task', '{}', ?)`,
    );
    insertActivity.run('e1', 'acme', 'k1', 'h1', NOW);
    insertActivity.run('e2', 'other-co', 'k1', 'h1', NOW); // same source key, different company — allowed
    assert.throws(
      () => insertActivity.run('e3', 'acme', 'k1', 'h1', NOW),
      /UNIQUE/,
      'UNIQUE(company_id,source_key) must refuse a second row for the same company+key',
    );

    db.prepare(
      `INSERT INTO hq_chat_sessions (id, company_id, owner_subject, installation_id, created_at, last_activity_at)
       VALUES ('s1', 'acme', 'owner-1', 'inst-1', ?, ?)`,
    ).run(NOW, NOW);

    const insertTurn = db.prepare(
      `INSERT INTO hq_chat_turns (id, company_id, session_id, owner_subject, client_request_id, message_text, state, created_at, updated_at)
       VALUES (?, 'acme', 's1', 'owner-1', ?, 'hi', ?, ?, ?)`,
    );
    insertTurn.run('t1', 'req-1', 'queued', NOW, NOW);
    assert.throws(
      () => insertTurn.run('t2', 'req-2', 'sending', NOW, NOW),
      /UNIQUE/,
      'the partial unique index must refuse a SECOND nonterminal turn in one session',
    );

    // Terminalising t1 releases the session: a new nonterminal turn is allowed.
    db.prepare(`UPDATE hq_chat_turns SET state = 'replied', terminal_at = ? WHERE id = 't1'`).run(NOW);
    insertTurn.run('t3', 'req-3', 'queued', NOW, NOW);

    assert.throws(
      () => insertTurn.run('t4', 'req-1', 'queued', NOW, NOW),
      /UNIQUE/,
      'UNIQUE(company_id,session_id,client_request_id) must refuse a replayed client request id',
    );

    // A second company may reuse the same client_request_id — the dedup key is company-scoped.
    db.prepare(
      `INSERT INTO hq_chat_sessions (id, company_id, owner_subject, installation_id, created_at, last_activity_at)
       VALUES ('s2', 'other-co', 'owner-2', 'inst-2', ?, ?)`,
    ).run(NOW, NOW);
    db.prepare(
      `INSERT INTO hq_chat_turns (id, company_id, session_id, owner_subject, client_request_id, message_text, state, created_at, updated_at)
       VALUES ('t-other', 'other-co', 's2', 'owner-2', 'req-1', 'hi', 'queued', ?, ?)`,
    ).run(NOW, NOW);

    // hq_owner_login_uses: the nonce is the primary key — one winner, ever.
    const useNonce = db.prepare(`INSERT INTO hq_owner_login_uses (nonce, expires_at, used_at) VALUES (?, ?, ?)`);
    useNonce.run('nonce-1', 1_800_000_000_000, 1_700_000_000_000);
    assert.throws(
      () => useNonce.run('nonce-1', 1_800_000_000_000, 1_700_000_000_001),
      /PRIMARY KEY|UNIQUE/,
      'a consumed nonce must not be re-insertable',
    );

    // hq_run_bindings: one binding per (company, runtime run id).
    const insertBinding = db.prepare(
      `INSERT INTO hq_run_bindings (company_id, runtime_run_id, visibility, recorded_at)
       VALUES (?, ?, 'task-audience', ?)`,
    );
    insertBinding.run('acme', 'run-1', NOW);
    assert.throws(
      () => insertBinding.run('acme', 'run-1', NOW),
      /PRIMARY KEY|UNIQUE/,
      'PRIMARY KEY(company_id,runtime_run_id) must refuse a duplicate binding',
    );
  } finally {
    db.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('B01 (e) interrupted migration stays visible and a later clean run completes it', () => {
  const dbPath = freshDbPath('interrupted');
  const db = seedPreHqDb(dbPath);
  try {
    // Interrupt: apply 169's own DDL by hand but DO NOT record it — exactly the
    // state a process kill mid-migration leaves (runner records the id only
    // after up() returns, inside the same transaction).
    const m169 = migrations.find((m) => m.id === '169');
    assert.ok(m169, 'migration 169 must exist');
    m169.up(db);
    const interrupted = tableNames(db);
    assert.equal(interrupted.has('hq_chat_turns'), true, 'the interrupted run left its tables behind (additive, harmless)');
    assert.equal(
      migrationRecorded(db, '169'),
      0,
      'an interrupted run must NOT have recorded 169 — otherwise the schema would be false-claimed',
    );

    // The next clean run must finish the job, not crash on the existing objects.
    withIsolatedHome(() => runMigrations(db));
    assert.equal(checkHqSchemaReady(db).ok, true, 'the clean run must complete readiness');
    assert.equal(migrationRecorded(db, '169'), 1, 'the clean run must record 169');

    // A genuinely FAILING migration is recorded as the failure and re-thrown,
    // so a health endpoint can say which id failed rather than serving traffic.
    assert.equal(getLastFailedMigrationId(), null, 'a successful run clears the failure marker');
  } finally {
    db.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('B01 (f) decoders: typed rows in, null for malformed or out-of-domain rows', () => {
  const dbPath = freshDbPath('decoders');
  const db = seedPreHqDb(dbPath);
  try {
    withIsolatedHome(() => runMigrations(db));
    db.prepare(
      `INSERT INTO hq_activity (id, company_id, source_key, content_hash, kind, payload_json, received_at, payload_bytes)
       VALUES ('evt-9', 'acme', 'note:1', 'h9', 'owner_note', '{"text":"hi"}', ?, 12)`,
    ).run(NOW);
    const seq = (db.prepare(`SELECT seq FROM hq_activity WHERE id = 'evt-9'`).get() as { seq: number }).seq;

    const row = readHqActivityRow(db, 'acme', seq);
    assert.ok(row, 'a well-formed activity row must decode');
    assert.equal(row.id, 'evt-9');
    assert.equal(row.kind, 'owner_note');

    assert.equal(readHqActivityRow(db, 'other-co', seq), null, 'a foreign company must find no row');
    assert.equal(decodeHqActivityRow({ ...row, kind: 'not-a-kind' }), null, 'an out-of-domain kind must not decode');
    assert.equal(decodeHqActivityRow({ ...row, received_at: null }), null, 'a missing NOT NULL column must not decode');
    assert.equal(decodeHqActivityRow(null), null);
    assert.equal(decodeHqActivityRow('a row'), null);
    assert.equal(decodeHqActivityRow([]), null);

    db.prepare(
      `INSERT INTO hq_chat_sessions (id, company_id, owner_subject, installation_id, created_at, last_activity_at)
       VALUES ('s9', 'acme', 'owner-1', 'inst-1', ?, ?)`,
    ).run(NOW, NOW);
    db.prepare(
      `INSERT INTO hq_chat_turns (id, company_id, session_id, owner_subject, client_request_id, message_text, state, created_at, updated_at)
       VALUES ('t9', 'acme', 's9', 'owner-1', 'req-9', 'hi', 'reconciling', ?, ?)`,
    ).run(NOW, NOW);

    const turn = readHqChatTurnRow(db, 'acme', 't9');
    assert.ok(turn, 'a well-formed turn must decode');
    assert.equal(turn.state, 'reconciling');
    assert.equal(decodeHqChatTurnRow({ ...turn, state: 'invented_state' }), null, 'an S9 state outside the frozen set must not decode');
    assert.equal(readHqChatTurnRow(db, 'other-co', 't9'), null, 'a foreign company must find no turn');

    assert.equal(
      decodeHqRunBindingRow({ company_id: 'acme', runtime_run_id: 'r', visibility: 'public', recorded_at: NOW }),
      null,
      'visibility is a two-value set, never free text',
    );
    assert.ok(
      decodeHqRunBindingRow({ company_id: 'acme', runtime_run_id: 'r', visibility: 'private-owner', recorded_at: NOW }),
      'a private-owner binding decodes',
    );
    assert.equal(decodeHqOwnerLoginUseRow({ nonce: 'n', expires_at: 1, used_at: 2 })?.nonce, 'n');
    assert.equal(decodeHqOwnerLoginUseRow({ nonce: 'n', expires_at: 1, used_at: null }), null);

    // The partial index predicate and the S9 nonterminal set must agree.
    for (const active of ['queued', 'sending', 'awaiting_reply', 'reconciling'] as const) {
      assert.equal(isNonterminalHqTurn(active), true, `${active} must be treated as active`);
    }
    for (const done of ['replied', 'failed_unsent', 'refused', 'unresolved'] as const) {
      assert.equal(isNonterminalHqTurn(done), false, `${done} must be terminal`);
    }
  } finally {
    db.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('B01 (g) readiness: an un-migrated database reports the exact missing objects', () => {
  const dbPath = freshDbPath('unready');
  const db = new Database(dbPath);
  try {
    // Known-negative control: base schema only, no 169.
    const res = checkHqSchemaReady(db);
    assert.equal(res.ok, false, 'readiness must be false before 169 runs');
    assert.deepEqual(res.missingTables, [...HQ_TABLES], 'every HQ table must be named as missing');
    assert.deepEqual(res.missingIndexes, [HQ_ONE_ACTIVE_TURN_INDEX]);
    assert.throws(
      () => requireHqSchema(res),
      /migration 169 \(src\/lib\/db\/migrations\.ts\)/,
      'the refusal must name the migration that fixes it',
    );
  } finally {
    db.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});
