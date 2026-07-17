/**
 * Migration 110 `add_ceo_chat_usage_columns` — U62 (JM/U65, master E.2).
 *
 * U65's acceptance requires exact-usage metering be "echoed by history for
 * reload continuity" — a page reload wipes client state, so the LAST
 * assistant message's usage must be persisted, not just held in memory.
 * Purely additive: three nullable columns on the EXISTING `ceo_chat_messages`
 * table (migration 101).
 *
 * ID HISTORY (the campaign's own migration-id-collision lesson, live again):
 * originally authored as id '109' (the next free id at the time — highest
 * existing was '108'). While this branch was in flight, main independently
 * landed ITS OWN migration '109' (guard_general_task_display_name_stays_
 * general_task, D-C2/D8 REJECT) — a real collision on disjoint tables
 * (workspaces vs ceo_chat_messages), same pattern as migrations 107/108's
 * own renumber notes. Renumbered to the next free id, '110', on rebase onto
 * origin/main (v6.0.58).
 *
 * Per the campaign's own migration-id-collision lesson, this suite proves the
 * migration against a REAL PRE-EXISTING DB shape — a box already on migration
 * 109 with a real `ceo_chat_messages` row already in it — not just a fresh
 * DB, and confirms running it adds EXACTLY ONE new `_migrations` row and is
 * idempotent on a second run.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../../src/lib/db/schema';
import { migrations, runMigrations } from '../../src/lib/db/migrations';

describe('migration 110 — ceo_chat_messages usage columns, proved against a pre-existing DB shape', () => {
  let db: Database.Database;

  beforeAll(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);

    // Simulate a REAL box that has already run every migration THROUGH 109
    // (not 110+) — the exact "pre-existing DB shape" the campaign's own
    // migration-id-collision lesson demands. schema.ts already creates
    // ceo_chat_messages fresh, so this reproduces a box that onboarded after
    // migration 101 shipped but before 110 existed.
    const idx110 = migrations.findIndex((m) => m.id === '110');
    expect(idx110, 'this test file assumes migration 110 exists in the array').toBeGreaterThanOrEqual(0);
    const through109 = migrations.slice(0, idx110);
    for (const m of through109) m.up(db);
    db.exec(
      `CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, name TEXT, applied_at TEXT)`,
    );
    for (const m of through109) {
      db.prepare('INSERT OR IGNORE INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)').run(
        m.id,
        m.name,
        new Date().toISOString(),
      );
    }

    // A REAL pre-existing row, inserted with the pre-110 column list (no
    // usage columns exist yet) — proves the ALTER doesn't touch existing data.
    db.prepare(
      `INSERT INTO ceo_chat_messages (id, session_id, role, content, kind, created_at)
       VALUES ('pre-110-row', 'sess-pre-existing', 'assistant', 'Already here before 110.', 'message', '2026-07-01T00:00:00.000Z')`,
    ).run();
  });

  afterAll(() => {
    db.close();
  });

  it('adds exactly ONE new _migrations row for id 110 when run against the pre-existing shape', () => {
    const before = db.prepare("SELECT COUNT(*) as n FROM _migrations WHERE id = '110'").get() as { n: number };
    expect(before.n).toBe(0);

    runMigrations(db);

    const after = db.prepare("SELECT COUNT(*) as n FROM _migrations WHERE id = '110'").get() as { n: number };
    expect(after.n).toBe(1);
  });

  it('adds the three nullable usage columns to the EXISTING table (never recreates it)', () => {
    const cols = new Set(
      (db.prepare('PRAGMA table_info(ceo_chat_messages)').all() as { name: string }[]).map((c) => c.name),
    );
    for (const col of ['usage_input', 'usage_output', 'usage_total']) {
      expect(cols.has(col), `ceo_chat_messages must have column ${col}`).toBe(true);
    }
  });

  it('never touches the pre-existing row\'s data — it survives byte-for-byte, with NULL usage', () => {
    const row = db
      .prepare('SELECT * FROM ceo_chat_messages WHERE id = ?')
      .get('pre-110-row') as Record<string, unknown>;
    expect(row.content).toBe('Already here before 110.');
    expect(row.session_id).toBe('sess-pre-existing');
    expect(row.usage_input).toBeNull();
    expect(row.usage_output).toBeNull();
    expect(row.usage_total).toBeNull();
  });

  it('a fresh row can populate the new usage columns and round-trips them', () => {
    db.prepare(
      `INSERT INTO ceo_chat_messages (id, session_id, role, content, kind, created_at, usage_input, usage_output, usage_total)
       VALUES ('post-110-row', 'sess-post', 'assistant', 'Real usage.', 'message', '2026-07-16T00:00:00.000Z', 16026, 28, 16054)`,
    ).run();
    const row = db
      .prepare('SELECT usage_input, usage_output, usage_total FROM ceo_chat_messages WHERE id = ?')
      .get('post-110-row') as { usage_input: number; usage_output: number; usage_total: number };
    expect(row).toEqual({ usage_input: 16026, usage_output: 28, usage_total: 16054 });
  });

  it('is idempotent — running the full chain again is a no-op (no duplicate row, no ALTER TABLE error)', () => {
    expect(() => runMigrations(db)).not.toThrow();
    const count = db.prepare("SELECT COUNT(*) as n FROM _migrations WHERE id = '110'").get() as { n: number };
    expect(count.n).toBe(1); // still exactly one row, not two
  });
});
