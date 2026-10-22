/**
 * Migration 173 `da_challenge_review_fields` — CC feature-wiring recovery
 * (2026-10-21).
 *
 * CHECKLIST.md's "Devil's Advocate" row carried open items "Risks and
 * alternatives listed" and "Recommended modifications shown" plus the four
 * Review Types: at the 2026-10-19 train head NONE of it had storage. This
 * migration adds the three fields the paired producer (openclaw-onboarding
 * shared-utils/devils-advocate*.py) now emits on POST /api/da-challenges.
 *
 * The suite proves the migration against the REAL pre-173 table shape:
 * a database migrated through 024 (the migration that reconciled
 * da_challenges to its canonical shape) with a live pre-existing row, so a
 * box that already runs the DA pipeline is upgraded without touching that
 * row's data.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../../src/lib/db/schema';
import { migrations } from '../../src/lib/db/migrations';

describe('migration 173 — da_challenges review fields, proved against the pre-173 table shape', () => {
  let db: Database.Database;
  let migration173: (typeof migrations)[number];

  beforeAll(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);

    // A real box that has run migrations THROUGH 024 (the migration that
    // reconciled da_challenges to its canonical shape — later migrations never
    // touch that table, so 024 IS the pre-DA-review-fields shape) but NOT it.
    // Applying through 024 keeps this suite fast and dependency-free (later
    // seed migrations are out of scope for a table-shape proof).
    // Select by NAME, not id: the id is an allocation slot (this entry was
    // renumbered 173 -> 174 when it collided with main's launch contract
    // migration); the name is the entry's identity and never moves.
    migration173 = migrations.find((m) => m.name === 'da_challenge_review_fields');
    expect(migration173, 'this test file assumes migration da_challenge_review_fields exists in the array').toBeDefined();
    const idx024 = migrations.findIndex((m) => m.id === '024');
    expect(idx024, 'this test file assumes migration 024 exists in the array').toBeGreaterThanOrEqual(0);
    for (const m of migrations.slice(0, idx024 + 1)) m.up(db);

    // A REAL pre-existing challenge row, inserted with the pre-173 column
    // list (the reconciled 024 shape: no review fields exist yet).
    db.prepare(
      `INSERT INTO da_challenges
         (id, task_id, campaign_id, department_id, trigger_type, challenge,
          specific_concern, assumptions, severity, confidence, raw_response,
          status, created_at, resolved_at)
       VALUES ('pre-173-row', 'task-1', NULL, 'marketing', 'campaign-review',
               'Why did spend rise while leads did not?', 'concern', 'assumptions',
               'high', 0.7, 'raw text', 'pending', '2026-10-01T00:00:00.000Z', NULL)`,
    ).run();
  });

  afterAll(() => {
    db.close();
  });

  it('adds the three columns to the EXISTING table (never recreates it)', () => {
    migration173.up(db);
    const cols = new Set(
      (db.prepare('PRAGMA table_info(da_challenges)').all() as { name: string }[]).map((c) => c.name),
    );
    for (const col of ['risks_alternatives', 'recommended_modifications', 'review_type']) {
      expect(cols.has(col), `da_challenges must have column ${col}`).toBe(true);
    }
  });

  it('is idempotent: a second run is a clean no-op', () => {
    migration173.up(db); // first run added the columns
    migration173.up(db); // must not throw "duplicate column name"
    const cols = (db.prepare('PRAGMA table_info(da_challenges)').all() as { name: string }[]).filter(
      (c) => c.name === 'risks_alternatives',
    );
    expect(cols.length).toBe(1);
  });

  it("never touches the pre-existing row's data — it survives, with NULLs and the 'required' default", () => {
    const row = db
      .prepare('SELECT * FROM da_challenges WHERE id = ?')
      .get('pre-173-row') as Record<string, unknown>;
    expect(row.challenge).toBe('Why did spend rise while leads did not?');
    expect(row.raw_response).toBe('raw text');
    expect(row.risks_alternatives).toBeNull();
    expect(row.recommended_modifications).toBeNull();
    // SQLite enforces NOT NULL DEFAULT 'required' for pre-existing rows
    expect(row.review_type).toBe('required');
  });

  it('a new row can populate the review fields and round-trips them', () => {
    db.prepare(
      `INSERT INTO da_challenges
         (id, task_id, campaign_id, department_id, trigger_type, challenge,
          specific_concern, assumptions, severity, confidence, raw_response,
          risks_alternatives, recommended_modifications, review_type,
          status, created_at)
       VALUES ('post-173-row', 'task-2', NULL, 'sales', 'campaign-review',
               'Challenge?', NULL, NULL, 'medium', 0.5, NULL,
               'Risk list', 'Modification list', 'deep-dive',
               'pending', '2026-10-21T00:00:00.000Z')`,
    ).run();
    const row = db
      .prepare('SELECT risks_alternatives, recommended_modifications, review_type FROM da_challenges WHERE id = ?')
      .get('post-173-row') as {
      risks_alternatives: string;
      recommended_modifications: string;
      review_type: string;
    };
    expect(row).toEqual({
      risks_alternatives: 'Risk list',
      recommended_modifications: 'Modification list',
      review_type: 'deep-dive',
    });
  });
});
