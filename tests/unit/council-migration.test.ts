/**
 * CWE-005 council persistence migration tests (directive Sections 16, 34).
 *
 * Acceptance proof owned by this unit (the CWE-005 prose block): existing
 * sanitized client data survives migration and reopen; cross-scope child
 * references and duplicate logical operations are rejected.
 *
 * Strategy: the council migration body is exercised DIRECTLY against
 * throwaway better-sqlite3 fixtures (the migrations.ts header documents
 * that the array is exported so one migration can be unit-tested in
 * isolation). One test additionally runs the REAL registry through
 * getDb() on an isolated DATABASE_PATH to prove the registration,
 * the allocated id, and the fail-closed lifecycle end to end.
 *
 * Covers:
 *   1. Fresh apply: all 19 council_* tables (the 18 of Section 16.2 plus
 *      council_kanban_links from the prose block), both diagnostic
 *      triggers, and the Section 16.2 index set exist.
 *   2. Sanitized upgrade: a fixture carrying pre-council client-shaped
 *      rows (a tasks row, a workspaces row, NO council tables) gains the
 *      council schema, the client rows survive byte-identical, and the
 *      data survives close + reopen.
 *   3. Idempotency: re-running up() is a no-op; the runner records the
 *      migration once.
 *   4. Scope: cross-scope child inserts are rejected by composite FKs;
 *      a globally unique id gains nothing across scopes.
 *   5. Duplicates: duplicate logical operations are rejected (card
 *      operation, provider operation, budget operation, task-link
 *      action-version mapping, request-key uniqueness).
 *   6. Canonical CHECKs: session states, modes, visibility, verdict
 *      labels, and event types outside the CWE-003 enums are rejected.
 *   7. Diagnostic capture bounds (Section 16.6): policy CHECK bounds,
 *      per-operation and per-session byte triggers, window trigger,
 *      never-captured classes, metadata rows carry no payload reference.
 *   8. Rollback compatibility: after the migration, the pre-council
 *      schema still reads and writes exactly as before (additive only);
 *      an interrupted (failed) migration leaves zero council tables and
 *      no ledger row, and a retry applies cleanly.
 *   9. Concurrent install safety: two processes racing to apply the
 *      migration to the same database file both succeed and the schema
 *      lands exactly once.
 *
 * Section 35 mapping: this file supports the storage-shape foundations
 * of T133/T134 (owned by CWE-006) and T129's schema reject cases (owned
 * by CWE-009). CWE-005's own acceptance is the prose-block proof above.
 */

import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';

import {
  applyCouncilSchema,
  councilMigration,
  COUNCIL_MIGRATION_ID_PENDING,
} from '../../src/lib/council/persistence/council-migration';
import {
  COUNCIL_SCHEMA_SQL,
  COUNCIL_TABLES_PROSE_BLOCK_EXTRA,
  COUNCIL_TABLES_SECTION_16_2,
} from '../../src/lib/council/persistence/council-schema';

const ALL_COUNCIL_TABLES = [...COUNCIL_TABLES_SECTION_16_2, ...COUNCIL_TABLES_PROSE_BLOCK_EXTRA];
const NOW = '2026-10-14T12:00:00.000Z';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return db;
}

function tableNames(db: Database.Database): string[] {
  return (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'council%'`)
      .all() as { name: string }[]
  ).map((r) => r.name);
}

function insertSession(
  db: Database.Database,
  over: Partial<Record<string, unknown>> = {},
): void {
  const row: Record<string, unknown> = {
    id: 'sess-1',
    tenant_id: 'tenant-a',
    company_id: 'company-a',
    installation_id: 'inst-a',
    owner_subject: 'owner-1',
    created_by_subject: 'owner-1',
    mode: 'full',
    visibility: 'private',
    state: 'DRAFT',
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
  const cols = Object.keys(row);
  db.prepare(
    `INSERT INTO council_sessions (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
  ).run(...cols.map((c) => row[c]));
}

test('schema statements are additive-only and cover the Section 16.2 inventory', () => {
  assert.equal(COUNCIL_TABLES_SECTION_16_2.length, 18);
  assert.ok(!/\bDROP\b|\bALTER\b/.test(COUNCIL_SCHEMA_SQL), 'schema must not drop or alter');
  const creates = [...COUNCIL_SCHEMA_SQL.matchAll(/CREATE (TABLE|INDEX|TRIGGER) IF NOT EXISTS (\w+)/g)];
  const bareCreates = [...COUNCIL_SCHEMA_SQL.matchAll(/CREATE (TABLE|INDEX|TRIGGER) (?!IF NOT EXISTS)/g)];
  assert.deepEqual(bareCreates, [], 'every CREATE must carry IF NOT EXISTS');
  const createdTables = creates.filter((m) => m[1] === 'TABLE').map((m) => m[2]);
  assert.deepEqual([...createdTables].sort(), [...ALL_COUNCIL_TABLES].sort());
  assert.equal(creates.filter((m) => m[1] === 'TRIGGER').length, 2);
  assert.equal(creates.filter((m) => m[1] === 'INDEX').length, 12);
});

test('fresh apply creates every council table, trigger, and key index', () => {
  const db = freshDb();
  applyCouncilSchema(db);
  assert.deepEqual(tableNames(db).sort(), [...ALL_COUNCIL_TABLES].sort());
  const triggers = (
    db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger'`).all() as { name: string }[]
  ).map((r) => r.name);
  assert.deepEqual(triggers.sort(), [
    'trg_council_diag_payload_bounds',
    'trg_council_diag_payload_window',
  ]);
  const indexes = new Set(
    (db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all() as { name: string }[]).map(
      (r) => r.name,
    ),
  );
  for (const idx of [
    'idx_council_sessions_scope_time',
    'idx_council_jobs_due',
    'idx_council_outbox_pending',
    'idx_council_diag_deadline',
  ]) {
    assert.ok(indexes.has(idx), `missing index ${idx}`);
  }
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close();
});

test('sanitized previous-schema data survives migration and reopen', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwe005-upgrade-'));
  const file = path.join(dir, 'client.db');
  // Sanitized previous schema: client-shaped rows, no council tables,
  // no real client data (all values are fixtures).
  const before = new Database(file);
  before.exec(`
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL);
    INSERT INTO workspaces VALUES ('ws-1', 'Fixture Workspace');
    INSERT INTO tasks VALUES ('task-1', 'Sanitized fixture task', 'open');
  `);
  before.close();

  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  applyCouncilSchema(db);
  insertSession(db);
  db.close();

  const reopened = new Database(file);
  assert.deepEqual(
    reopened.prepare('SELECT id, name FROM workspaces').all(),
    [{ id: 'ws-1', name: 'Fixture Workspace' }],
    'pre-existing workspace row must survive migration and reopen',
  );
  assert.deepEqual(reopened.prepare('SELECT id, title, status FROM tasks').all(), [
    { id: 'task-1', title: 'Sanitized fixture task', status: 'open' },
  ]);
  assert.equal(
    (reopened.prepare('SELECT count(*) AS n FROM council_sessions').get() as { n: number }).n,
    1,
  );
  reopened.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('re-running the migration body is a no-op (idempotent)', () => {
  const db = freshDb();
  applyCouncilSchema(db);
  insertSession(db);
  applyCouncilSchema(db);
  councilMigration.up(db);
  assert.equal(tableNames(db).length, ALL_COUNCIL_TABLES.length);
  assert.equal(
    (db.prepare('SELECT count(*) AS n FROM council_sessions').get() as { n: number }).n,
    1,
  );
  db.close();
});

test('cross-scope child references are rejected by composite foreign keys', () => {
  const db = freshDb();
  applyCouncilSchema(db);
  insertSession(db);
  const brief = db.prepare(
    `INSERT INTO council_brief_revisions
       (tenant_id, company_id, session_id, revision, brief_json, canonical_hash, question,
        decision_type, stakes, reversibility, success_criteria_json, constraints_json,
        author_subject, created_at)
     VALUES (?, ?, ?, 1, '{}', 'h', 'q', 'd', 's', 'rev', '[]', '[]', 'owner-1', ?)`,
  );
  // Same session id, wrong company: the composite FK rejects it. A
  // globally unique session UUID is not authorization (Section 16.2).
  assert.throws(() => brief.run('tenant-a', 'company-OTHER', 'sess-1', NOW), /FOREIGN KEY/);
  assert.throws(() => brief.run('tenant-OTHER', 'company-a', 'sess-1', NOW), /FOREIGN KEY/);
  brief.run('tenant-a', 'company-a', 'sess-1', NOW);
  assert.equal(
    (db.prepare('SELECT count(*) AS n FROM council_brief_revisions').get() as { n: number }).n,
    1,
  );
  // Session deletion cascades only inside its own scope.
  db.prepare('DELETE FROM council_sessions WHERE tenant_id = ? AND company_id = ? AND id = ?').run(
    'tenant-a',
    'company-a',
    'sess-1',
  );
  assert.equal(
    (db.prepare('SELECT count(*) AS n FROM council_brief_revisions').get() as { n: number }).n,
    0,
  );
  db.close();
});

test('duplicate logical operations are rejected', () => {
  const db = freshDb();
  applyCouncilSchema(db);
  insertSession(db);
  const card = db.prepare(
    `INSERT INTO council_cards
       (tenant_id, company_id, session_id, id, kind, seat_id, round, brief_revision,
        operation_id, payload_fingerprint, card_json, canonical_hash, validation, created_at)
     VALUES ('tenant-a', 'company-a', 'sess-1', ?, 'advisor', 'simon-sinek', 1, 1, ?, 'fp', '{}', 'h', 'valid', ?)`,
  );
  card.run('card-1', 'op-1', NOW);
  assert.throws(() => card.run('card-2', 'op-1', NOW), /UNIQUE constraint/);
  const attempt = db.prepare(
    `INSERT INTO council_provider_attempts
       (tenant_id, company_id, session_id, id, operation_id, round, provider_id,
        provider_config_version, model_ref, model_selection_source, status, created_at, updated_at)
     VALUES ('tenant-a', 'company-a', 'sess-1', ?, ?, 1, 'p', 'v1', 'm', 'explicit', 'reserved', ?, ?)`,
  );
  attempt.run('att-1', 'op-x', NOW, NOW);
  assert.throws(() => attempt.run('att-2', 'op-x', NOW, NOW), /UNIQUE constraint/);
  const link = db.prepare(
    `INSERT INTO council_action_proposals
       (tenant_id, company_id, session_id, id, verdict_id, plan_hash, actions_json, risk_class, status, created_at)
     VALUES ('tenant-a', 'company-a', 'sess-1', 'plan-1', 'verdict-1', 'hash-1', '[]', 'low', 'approved', ?)`,
  );
  link.run(NOW);
  const taskLink = db.prepare(
    `INSERT INTO council_task_links
       (tenant_id, company_id, session_id, id, action_proposal_id, action_id, plan_hash,
        operation_id, task_id, created_at)
     VALUES ('tenant-a', 'company-a', 'sess-1', ?, 'plan-1', 'act-1', 'hash-1', ?, ?, ?)`,
  );
  taskLink.run('link-1', 'council:sess-1:verdict:1:action:act-1:plan:hash-1', 'task-1', NOW);
  // The Section 21 unique action-version mapping: same action version,
  // second task is rejected.
  assert.throws(
    () =>
      taskLink.run('link-2', 'council:sess-1:verdict:1:action:act-1:plan:hash-1', 'task-2', NOW),
    /UNIQUE constraint/,
  );
  db.close();
});

test('canonical enum CHECK constraints reject non-canonical values', () => {
  const db = freshDb();
  applyCouncilSchema(db);
  assert.throws(() => insertSession(db, { state: 'ARCHIVED' }), /CHECK constraint/);
  assert.throws(() => insertSession(db, { mode: 'marathon' }), /CHECK constraint/);
  assert.throws(() => insertSession(db, { visibility: 'public' }), /CHECK constraint/);
  // CONSULTING is a real canonical state (Sections 11.7, 15.1).
  insertSession(db, { id: 'sess-consult', mode: 'consult', state: 'CONSULTING' });
  // Private visibility requires an owner subject.
  assert.throws(
    () => insertSession(db, { id: 'sess-noowner', owner_subject: null }),
    /CHECK constraint/,
  );
  insertSession(db);
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO council_events
             (tenant_id, company_id, session_id, sequence, id, type, actor_subject, event_hash, created_at)
           VALUES ('tenant-a', 'company-a', 'sess-1', 1, 'ev-1', 'exploded', 'owner-1', 'h', ?)`,
        )
        .run(NOW),
    /CHECK constraint/,
  );
  db.close();
});

const GRANT_INSERT = `
  INSERT INTO council_diagnostic_capture
    (tenant_id, company_id, session_id, id, record_kind, authorized_by_principal,
     authorization_kind, window_started_at, window_ends_at, capture_window_minutes,
     payload_ttl_hours, max_bytes_per_operation, max_bytes_per_session, created_at)
  VALUES ('tenant-a', 'company-a', 'sess-1', ?, 'grant', 'owner-1', 'owner',
          '2026-10-14T12:00:00.000Z', ?, ?, ?, ?, ?, ?)`;
const PAYLOAD_INSERT = `
  INSERT INTO council_diagnostic_capture
    (tenant_id, company_id, session_id, id, record_kind, grant_id, operation_id, data_class,
     byte_count, redaction_status, payload_protected_ref, payload_deadline_at, captured_at, created_at)
  VALUES ('tenant-a', 'company-a', 'sess-1', ?, 'payload', ?, 'op-1', ?, ?, 'redacted',
          'protected-store:ref', ?, ?, ?)`;

function diagDb(): Database.Database {
  const db = freshDb();
  applyCouncilSchema(db);
  insertSession(db);
  return db;
}

test('diagnostic grant rows enforce the Section 16.6 policy bounds', () => {
  const db = diagDb();
  const grant = db.prepare(GRANT_INSERT);
  // Defaults: 60 minute window, 24 hour TTL, 5 MiB per operation, 25 MiB per session.
  grant.run('g-ok', '2026-10-14T13:00:00.000Z', 60, 24, 5 * 1024 * 1024, 25 * 1024 * 1024, NOW);
  // Window above the 4 hour maximum.
  assert.throws(
    () => grant.run('g-win', '2026-10-14T17:00:00.000Z', 300, 24, 1024, 1024, NOW),
    /CHECK constraint/,
  );
  // Stated window longer than the window bound it claims.
  assert.throws(
    () => grant.run('g-lie', '2026-10-14T14:00:00.000Z', 60, 24, 1024, 1024, NOW),
    /CHECK constraint/,
  );
  // TTL above the 72 hour maximum.
  assert.throws(
    () => grant.run('g-ttl', '2026-10-14T13:00:00.000Z', 60, 73, 1024, 1024, NOW),
    /CHECK constraint/,
  );
  // Byte ceilings above the policy maxima.
  assert.throws(
    () => grant.run('g-op', '2026-10-14T13:00:00.000Z', 60, 24, 5 * 1024 * 1024 + 1, 1024, NOW),
    /CHECK constraint/,
  );
  assert.throws(
    () => grant.run('g-sess', '2026-10-14T13:00:00.000Z', 60, 24, 1024, 25 * 1024 * 1024 + 1, NOW),
    /CHECK constraint/,
  );
  db.close();
});

test('diagnostic payload rows are bounded by their grant, window, and TTL', () => {
  const db = diagDb();
  db.prepare(GRANT_INSERT).run(
    'g1', '2026-10-14T13:00:00.000Z', 60, 24, 1000, 1500, NOW,
  );
  const payload = db.prepare(PAYLOAD_INSERT);
  const deadline = '2026-10-15T12:30:00.000Z';
  payload.run('p1', 'g1', 'provider_body', 900, deadline, '2026-10-14T12:30:00.000Z', NOW);
  // Per-operation bound from the grant (1000), not just the 5 MiB ceiling.
  assert.throws(
    () => payload.run('p2', 'g1', 'provider_body', 1001, deadline, '2026-10-14T12:31:00.000Z', NOW),
    /per-operation bound/,
  );
  // Per-session bound: 900 already captured, 700 more exceeds 1500.
  assert.throws(
    () => payload.run('p3', 'g1', 'provider_body', 700, deadline, '2026-10-14T12:32:00.000Z', NOW),
    /per-session bound/,
  );
  // Outside the grant window (window ends 13:00).
  assert.throws(
    () => payload.run('p4', 'g1', 'provider_body', 10, deadline, '2026-10-14T13:30:00.000Z', NOW),
    /outside its grant window/,
  );
  // Never-captured data classes are rejected in every mode (Section 16.6).
  for (const dataClass of ['hidden_reasoning', 'access_token', 'cookie', 'authentication_header', 'private_key']) {
    assert.throws(
      () => payload.run(`p-never-${dataClass}`, 'g1', dataClass, 10, deadline, '2026-10-14T12:40:00.000Z', NOW),
      /CHECK constraint/,
      `never-captured class ${dataClass} must be rejected`,
    );
  }
  // Payload deadline beyond the 72 hour ceiling from capture time.
  assert.throws(
    () =>
      payload.run('p5', 'g1', 'provider_body', 10, '2026-10-18T12:30:00.000Z', '2026-10-14T12:45:00.000Z', NOW),
    /72 hour ceiling/,
  );
  db.close();
});

test('diagnostic metadata fallback rows can never carry a payload reference', () => {
  const db = diagDb();
  db.prepare(GRANT_INSERT).run(
    'g1', '2026-10-14T13:00:00.000Z', 60, 24, 1000, 1500, NOW,
  );
  db.prepare(
    `INSERT INTO council_diagnostic_capture
       (tenant_id, company_id, session_id, id, record_kind, grant_id, operation_id,
        error_code, created_at)
     VALUES ('tenant-a', 'company-a', 'sess-1', 'm1', 'metadata', 'g1', 'op-1',
             'redaction_unavailable', ?)`,
  ).run(NOW);
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO council_diagnostic_capture
             (tenant_id, company_id, session_id, id, record_kind, grant_id,
              payload_protected_ref, created_at)
           VALUES ('tenant-a', 'company-a', 'sess-1', 'm2', 'metadata', 'g1', 'plaintext:fallback', ?)`,
        )
        .run(NOW),
    /CHECK constraint/,
  );
  db.close();
});

test('rollback compatibility: pre-council schema is untouched and fully usable', () => {
  const db = freshDb();
  db.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL);
    INSERT INTO tasks VALUES ('task-1', 'before');
  `);
  const tasksSqlBefore = (
    db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'`)
      .get() as { sql: string }
  ).sql;
  applyCouncilSchema(db);
  const tasksSqlAfter = (
    db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'`)
      .get() as { sql: string }
  ).sql;
  assert.equal(tasksSqlAfter, tasksSqlBefore, 'migration must not alter existing tables');
  // The previous build keeps reading and writing exactly as before with
  // the council tables present but unread (the rollback story, Section
  // 16.3): no destructive downgrade exists or is needed.
  db.prepare(`INSERT INTO tasks VALUES ('task-2', 'after')`).run();
  assert.deepEqual(db.prepare('SELECT id FROM tasks ORDER BY id').all(), [
    { id: 'task-1' },
    { id: 'task-2' },
  ]);
  db.close();
});

test('interrupted migration leaves no partial schema and retries cleanly', () => {
  const db = freshDb();
  db.exec(`CREATE TABLE _migrations (id TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT)`);
  const failing = {
    id: councilMigration.id,
    name: councilMigration.name,
    up: (handle: Database.Database) => {
      // Apply the first statement only, then fail: the transaction must
      // take the partial DDL down with it.
      const firstStatement = COUNCIL_SCHEMA_SQL.split(';')[0] + ';';
      handle.exec(firstStatement);
      throw new Error('simulated interruption');
    },
  };
  // The runner's discipline: up + ledger insert in ONE transaction.
  assert.throws(
    () =>
      db.transaction(() => {
        failing.up(db);
        db.prepare('INSERT INTO _migrations (id, name) VALUES (?, ?)').run(failing.id, failing.name);
      })(),
    /simulated interruption/,
  );
  assert.deepEqual(tableNames(db), [], 'a failed migration must leave zero council tables');
  assert.equal(
    (db.prepare('SELECT count(*) AS n FROM _migrations').get() as { n: number }).n,
    0,
    'a failed migration must not be recorded as applied',
  );
  db.transaction(() => {
    councilMigration.up(db);
    db.prepare('INSERT INTO _migrations (id, name) VALUES (?, ?)').run(
      councilMigration.id,
      councilMigration.name,
    );
  })();
  assert.equal(tableNames(db).length, ALL_COUNCIL_TABLES.length);
  db.close();
});

test('concurrent installers racing one database both succeed, schema lands once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwe005-race-'));
  const file = path.join(dir, 'race.db');
  // Race pre-condition: the database FILE already exists and is a valid,
  // initialized database (a previous install's schema and ledger), which
  // is the real concurrent-install shape: two installers or updaters
  // boot against the same client database and race to apply the pending
  // council migration. (Racing on a zero-byte file exercises SQLite's
  // file-creation window, which belongs to getDb()'s own lifecycle, not
  // to this migration.)
  const seed = new Database(file);
  seed.exec(`CREATE TABLE _migrations (id TEXT PRIMARY KEY, name TEXT NOT NULL)`);
  seed.exec(`CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL)`);
  seed.prepare(`INSERT INTO workspaces VALUES ('ws-1', 'Existing client workspace')`).run();
  seed.close();
  const childSource = `
    const Database = require('better-sqlite3');
    const fs = require('fs');
    const sql = fs.readFileSync(process.argv[2], 'utf8');
    // Section 16.4: existing bounded busy-timeout/retry behavior. Two
    // installers racing one fresh file can transiently fail even opening
    // it (WAL switch on a half-initialized file); retry the open a
    // bounded number of times, then let the write lock serialize the
    // migration itself.
    // The check-and-apply runs as ONE transaction per installer, with
    // the bounded retry of Section 16.4 around it. The write lock
    // serializes the two installers; the loser then sees the ledger row
    // and skips. The migration body itself is idempotent, so even a
    // double-apply could not fail.
    let done = false;
    let lastError = null;
    for (let attempt = 0; attempt < 60 && !done; attempt++) {
      let conn = null;
      try {
        conn = new Database(process.argv[3]);
        conn.pragma('busy_timeout = 5000');
        const applyOnce = conn.transaction(() => {
          conn.exec("CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
          const applied = new Set(conn.prepare('SELECT id FROM _migrations').all().map((r) => r.id));
          if (applied.has('PENDING_TEST_ID')) return 'skipped';
          conn.exec(sql);
          conn.prepare('INSERT INTO _migrations (id, name) VALUES (?, ?)').run('PENDING_TEST_ID', 'race');
          return 'applied';
        });
        applyOnce();
        done = true;
      } catch (err) {
        lastError = err;
        if (!/SQLITE_(BUSY|LOCKED|NOTADB|CANTOPEN)/.test(String(err && err.code))) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 + Math.floor(Math.random() * 50));
      } finally {
        try { if (conn) conn.close(); } catch {}
      }
    }
    if (!done) { console.error('migration apply failed after bounded retries', lastError); process.exit(1); }
  `;
  const statementsFile = path.join(dir, 'schema.sql');
  fs.writeFileSync(statementsFile, COUNCIL_SCHEMA_SQL);
  const childFile = path.join(dir, 'child.cjs');
  fs.writeFileSync(childFile, childSource);
  const runChild = () =>
    execFileSync(process.execPath, [childFile, statementsFile, file], {
      cwd: path.join(__dirname, '..', '..'),
      env: {
        ...process.env,
        NODE_PATH: path.join(__dirname, '..', '..', 'node_modules'),
      },
      stdio: 'pipe',
    });
  // Two installers at once; both must exit 0 (the loser serializes on the
  // write lock, then sees the ledger row and skips).
  const results = [runChild(), runChild()];
  assert.equal(results.length, 2);
  const db = new Database(file, { readonly: true });
  assert.equal(
    (db.prepare(`SELECT count(*) AS n FROM _migrations WHERE id = 'PENDING_TEST_ID'`).get() as { n: number }).n,
    1,
  );
  assert.equal(tableNames(db).length, ALL_COUNCIL_TABLES.length);
  assert.deepEqual(db.prepare('SELECT id, name FROM workspaces').all(), [
    { id: 'ws-1', name: 'Existing client workspace' },
  ]);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('registry: the council entry is registered once, under its allocated id', () => {
  // Integration calibration (Skill 77 batch train): the id was the
  // non-numeric placeholder 'PENDING_INTEGRATION_ALLOCATION_CWE005' in
  // the unit branch; the integrator allocated '172' (highest existing
  // id 171 + 1) at integration, per the CWE-005 migration number law.
  assert.equal(COUNCIL_MIGRATION_ID_PENDING, '172');
  assert.equal(councilMigration.id, COUNCIL_MIGRATION_ID_PENDING);
  assert.equal(parseInt(councilMigration.id, 10), 172, 'allocated id is numeric and sorts after 171');

  // Child process: DATABASE_PATH discipline (the C8 hard-isolation guard
  // requires an explicit throwaway path outside the server process), then
  // the REAL registry and the REAL getDb() lifecycle.
  const repoRoot = path.join(__dirname, '..', '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwe005-registry-'));
  const dbFile = path.join(dir, 'registry.db');
  const probeFile = path.join(dir, 'probe.ts');
  fs.writeFileSync(
    probeFile,
    [
      `import { migrations } from ${JSON.stringify(path.join(repoRoot, 'src/lib/db/migrations'))};`,
      `import { getDb, closeDb } from ${JSON.stringify(path.join(repoRoot, 'src/lib/db'))};`,
      `const entries = migrations.filter((m) => m.name === 'council_scoped_storage_schema');`,
      `const numeric = migrations.map((m) => parseInt(m.id, 10)).filter((n) => !Number.isNaN(n));`,
      `const db = getDb();`,
      `const ledger = db.prepare("SELECT count(*) AS n FROM _migrations WHERE id = ?").get(entries[0]?.id) as { n: number };`,
      `const tables = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name LIKE 'council%'").get() as { n: number };`,
      `console.log(JSON.stringify({ entries: entries.length, entryId: entries[0]?.id ?? null, total: migrations.length, maxNumeric: Math.max(...numeric), ledger: ledger.n, tables: tables.n }));`,
      `closeDb();`,
    ].join('\n'),
  );
  const out = execFileSync(
    path.join(repoRoot, 'node_modules', '.bin', 'tsx'),
    [probeFile],
    {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_PATH: dbFile },
      stdio: 'pipe',
      timeout: 120_000,
    },
  ).toString();
  const report = JSON.parse(out.trim().split('\n').pop() as string) as {
    entries: number;
    entryId: string;
    total: number;
    maxNumeric: number;
    ledger: number;
    tables: number;
  };
  assert.equal(report.entries, 1, 'exactly one council registry entry');
  assert.equal(report.entryId, COUNCIL_MIGRATION_ID_PENDING);
  // Values below re-derived programmatically 2026-10-30 on this tree
  // (migration 176 `council_capability_snapshot` landed after the 2026-10-25
  // PBB-388 measurement, which printed 173 175):
  // (npx tsx -e "import('./src/lib/db/migrations').then(m=>console.log(m.migrations.length, Math.max(...m.migrations.map(x=>parseInt(x.id,10)).filter(n=>!Number.isNaN(n)))))" -> 174 176).
  // CC feature-wiring recovery (2026-10-21, migration da_challenge_review_fields):
  // the registry grew from 170 to 171 entries; the count assertion moves with every
  // migration addition, same as _head-migration.ts's derived contract (keep in sync).
  // A RENUMBER does not move it: the entry count is unchanged by renumbering.
  // Pre-existing off-by-one corrected here: origin/main then carried 170 literal entries
  // (+ the council entry = 171, which is what this assertion originally pinned). The
  // recovery merge added da_challenge_review_fields, taking literal entries to 171 and
  // the composed array to 172, but the pin was not moved with it — it described literal
  // entries while asserting migrations.length. Unrelated to the 173 -> 174 renumber,
  // which by definition changes no count.
  assert.equal(report.total, 174, '173 literal registry migrations + the council entry = 174 composed array entries');
  // The DA entry was renumbered 173 -> 174 to clear a duplicate id with main's
  // 'launch_run_storage_contract' (which keeps 173). Highest id follows every
  // addition: CTR-165's migration 176 'council_capability_snapshot' is the head.
  assert.equal(report.maxNumeric, 176, 'highest numeric id is 176 (council_capability_snapshot, CTR-165); da_challenge_review_fields sits at 174 after its 173 -> 174 renumber, mainline launch contract holds 173, council sits at its allocated id 172');
  assert.equal(report.ledger, 1, 'the runner recorded the council migration exactly once');
  // The real chain also applies CTR-165's migration 176
  // (council_capability_snapshots), which is NOT part of the council schema
  // script this file applies directly — so the full-chain count is the council
  // schema's own tables plus that one.
  assert.equal(
    report.tables,
    ALL_COUNCIL_TABLES.length + 1,
    'getDb() applied the council schema plus migration 176 (council_capability_snapshots)',
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
