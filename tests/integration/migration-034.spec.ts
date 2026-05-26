/**
 * Migration 034 regression test (Bug 1, v4.0.2).
 *
 * Creates a fresh in-memory SQLite DB, applies the base schema and
 * migrations 001..044, and asserts:
 *   - All apply without throwing
 *   - The final agents.status CHECK includes 'busy' and 'degraded'
 *   - foreign_keys is back ON after migration 034 finishes
 *
 * Pure DB test, no Next.js. Uses playwright/test only as the existing
 * test runner harness in this repo.
 */

import { test, expect } from 'playwright/test';
import Database from 'better-sqlite3';
import { schema } from '../../src/lib/db/schema';
import { runMigrations } from '../../src/lib/db/migrations';

test.describe('Migration 034: agents.status CHECK rebuild', () => {
  test('applies cleanly on a fresh DB and preserves FK integrity', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);

    runMigrations(db);

    const tableRow = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='agents'"
    ).get() as { sql: string } | undefined;

    expect(tableRow, 'agents table must exist after migrations').toBeTruthy();
    const sql = tableRow!.sql;
    expect(sql).toContain("'busy'");
    expect(sql).toContain("'degraded'");

    const fk = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    expect(fk.foreign_keys).toBe(1);

    const applied = db
      .prepare("SELECT id FROM _migrations WHERE id = '034'")
      .get() as { id: string } | undefined;
    expect(applied?.id).toBe('034');

    const violations = db.prepare('PRAGMA foreign_key_check').all();
    expect(violations.length).toBe(0);

    db.close();
  });
});
