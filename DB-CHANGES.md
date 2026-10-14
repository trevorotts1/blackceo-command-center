# Skill 71 run tracking: database changes (Item 26)

Two edits, following this repo's schema convention (schema.ts for fresh
databases, a migration for existing ones). The migration id is **171**:
at the HEAD this build was grounded on, the highest existing migration
id in `src/lib/db/migrations.ts` is `'170'`. If a higher id has landed
by integration time, renumber this one to highest + 1 and keep the name.

## 1. `src/lib/db/schema.ts`: append inside the schema string

```sql
-- Skill 71 run tracking (fix plan Items 24-26). Populated ONLY by event
-- ingestion (src/lib/skill71-runs.ts): the file importer
-- (scripts/import-skill71-runs.ts) and POST /api/skill-runs/ingest.
-- Stores IDs, verdicts, hashes, and score aggregates: never page copy,
-- prompt text, review notes, or credential values.
CREATE TABLE IF NOT EXISTS skill71_runs (
  run_id TEXT PRIMARY KEY,
  page_name TEXT,
  brand_id TEXT,
  client TEXT,
  client_slug TEXT,
  host_shape TEXT,
  run_dir TEXT,
  test_run INTEGER NOT NULL DEFAULT 0,
  overall TEXT NOT NULL DEFAULT 'incomplete',
  review_mode TEXT,
  report_json_path TEXT,
  report_md_path TEXT,
  blocked_stage TEXT,
  started_at TEXT,
  last_event_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS skill71_run_stages (
  run_id TEXT NOT NULL REFERENCES skill71_runs(run_id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  receipt_status TEXT,
  closed_at TEXT,
  duration_s REAL,
  scores_summary_json TEXT,
  cost_json TEXT,
  artifact_hashes_json TEXT,
  failures_json TEXT,
  items_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (run_id, stage)
);

CREATE TABLE IF NOT EXISTS skill71_run_events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  emitted_at TEXT NOT NULL,
  source TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skill71_ingest_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  client_slug TEXT NOT NULL,
  host_shape TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  revoked_at TEXT
);
```

Indexes for these tables are created by migration 171 (not here), per
the schema.ts rule: an index on a column a migration owns must be created
by that migration, unconditionally, so fresh installs get it too.

## 2. `src/lib/db/migrations.ts`: append one entry to `migrations`

```ts
  {
    id: '171',
    name: 'skill71_run_tracking_tables',
    up: (db) => {
      console.log('[Migration 171] Adding Skill 71 run tracking tables...');
      db.exec(`
        CREATE TABLE IF NOT EXISTS skill71_runs (
          run_id TEXT PRIMARY KEY,
          page_name TEXT,
          brand_id TEXT,
          client TEXT,
          client_slug TEXT,
          host_shape TEXT,
          run_dir TEXT,
          test_run INTEGER NOT NULL DEFAULT 0,
          overall TEXT NOT NULL DEFAULT 'incomplete',
          review_mode TEXT,
          report_json_path TEXT,
          report_md_path TEXT,
          blocked_stage TEXT,
          started_at TEXT,
          last_event_at TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS skill71_run_stages (
          run_id TEXT NOT NULL REFERENCES skill71_runs(run_id) ON DELETE CASCADE,
          stage TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'open',
          receipt_status TEXT,
          closed_at TEXT,
          duration_s REAL,
          scores_summary_json TEXT,
          cost_json TEXT,
          artifact_hashes_json TEXT,
          failures_json TEXT,
          items_json TEXT NOT NULL DEFAULT '{}',
          updated_at TEXT DEFAULT (datetime('now')),
          PRIMARY KEY (run_id, stage)
        );
        CREATE TABLE IF NOT EXISTS skill71_run_events (
          event_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          emitted_at TEXT NOT NULL,
          source TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          received_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS skill71_ingest_tokens (
          id TEXT PRIMARY KEY,
          token_hash TEXT NOT NULL UNIQUE,
          client_slug TEXT NOT NULL,
          host_shape TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now')),
          revoked_at TEXT
        );
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_skill71_events_run ON skill71_run_events(run_id);`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_skill71_runs_last_event ON skill71_runs(last_event_at);`);
    }
  },
```

## 3. Seeding an ingest token (operator step, per client install)

The ingest endpoint authenticates per-client bearer tokens. Only the
SHA-256 hash is stored; the token value lives on the client box in its
own secrets, in the file `SKILL71_RUNS_SHIP_TOKEN_FILE` points at.

```sql
-- Generate the token on the client box (openssl rand -hex 32), then:
INSERT INTO skill71_ingest_tokens (id, token_hash, client_slug, host_shape)
VALUES ('<uuid>', '<sha256 hex of the token>', '<client-slug>', 'fleet-hostinger');
```

## Notes

- `src/app/api/skill-runs/ingest/route.ts` authenticates with these
  per-client tokens itself and must **not** be added to
  `src/lib/bearer-required-routes.ts`: the global MC_API_TOKEN layer is a
  different credential for a different caller, and stacking it would make
  client boxes need Trevor's operator token, which they must never hold.
- `GET /api/skill-runs` follows the same posture as `GET
  /api/archify-runs` (board read, no per-route credential check).
