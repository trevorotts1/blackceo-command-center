/**
 * T-33 — migration 175 upgrade safety.
 *
 * A populated pre-175 database gains the operation + receipt tables additively;
 * running it twice is a no-op, and an existing task row is untouched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrations, migrationIds } from '../../src/lib/db/migrations';

test('migration 175 exists exactly once', () => {
  assert.equal(migrationIds().filter((id) => id === '175').length, 1);
});

test('migration 175 is additive, idempotent and leaves existing rows alone', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL)`);
  db.prepare(`INSERT INTO tasks (id, title) VALUES ('t1', 'Old task')`).run();
  const migration = migrations.find((m) => m.id === '175');
  assert.ok(migration);
  migration.up(db);
  migration.up(db); // idempotent
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map(
    (r) => r.name,
  );
  assert.ok(tables.includes('fulfillment_operations'));
  assert.ok(tables.includes('fulfillment_operation_receipts'));
  assert.deepEqual(db.prepare(`SELECT id, title FROM tasks`).all(), [{ id: 't1', title: 'Old task' }]);
  db.close();
});
