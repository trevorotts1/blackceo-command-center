/**
 * launch-schema.ts — the ONE versioned storage contract for launch data.
 *
 * Launch data arrives through two independent transports (files on a mounted
 * run directory, and the authenticated run-event HTTP ingest) and lands in two
 * stores (disk manifests, database tables). Both stores must agree on the same
 * contract version or the reader refuses to consume them; a silent drift here
 * is what turns an old row into a fabricated percentage.
 *
 * The tables are created by the NUMBERED migration `173` in
 * `src/lib/db/migrations.ts` (never by request-time DDL on a production boot).
 * `ensureLaunchSchema()` below is the idempotent bootstrap used by the
 * migration itself, by fresh-install code paths and by isolated tests — it
 * executes the SAME SQL, so the two can never disagree.
 */

export const LAUNCH_STORAGE_CONTRACT_VERSION = 1;

/** launch-plan.schema.json (U-CONTRACT v1) — the plan contract version. */
export const LAUNCH_PLAN_SCHEMA_VERSION = '1.0.0';

/** progress_file.schema.json (WF-SWARM / L03) — the progress contract version. */
export const LAUNCH_PROGRESS_SCHEMA_VERSION = '1.0';

/**
 * Purely additive, `IF NOT EXISTS` everywhere: an older populated database that
 * already carries lazily-created launch tables upgrades in place without
 * touching a row. The contract row records the version this box now stores.
 */
export const LAUNCH_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS launch_runs (
  run_id TEXT PRIMARY KEY,
  skill INTEGER NOT NULL,
  ability_slug TEXT NOT NULL,
  launch_id TEXT,
  client_slug TEXT,
  host_shape TEXT,
  installation_id TEXT,
  run_dir TEXT,
  overall TEXT NOT NULL DEFAULT 'incomplete',
  review_mode TEXT,
  report_json_path TEXT,
  report_md_path TEXT,
  blocked_stage TEXT,
  started_at TEXT,
  last_event_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_launch_runs_skill ON launch_runs(skill);
CREATE INDEX IF NOT EXISTS idx_launch_runs_launch ON launch_runs(launch_id);

CREATE TABLE IF NOT EXISTS launch_run_stages (
  run_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  receipt_status TEXT,
  closed_at TEXT,
  blocked_at TEXT,
  duration_s REAL,
  scores_summary_json TEXT,
  cost_json TEXT,
  artifact_hashes_json TEXT,
  failures_json TEXT,
  items_json TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, stage)
);

CREATE TABLE IF NOT EXISTS launch_run_events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  skill INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  emitted_at TEXT NOT NULL,
  source TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  installation_id TEXT,
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_launch_run_events_run ON launch_run_events(run_id);

CREATE TABLE IF NOT EXISTS launch_progress_samples (
  launch_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  build_percent REAL NOT NULL,
  batch_merge_percent REAL NOT NULL,
  batch_status TEXT NOT NULL,
  client_slug TEXT,
  host_shape TEXT,
  installation_id TEXT,
  sample_json TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (launch_id, room_id, observed_at)
);

CREATE TABLE IF NOT EXISTS launch_storage_contract (
  contract TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO launch_storage_contract (contract, version, updated_at)
VALUES ('launch', ${LAUNCH_STORAGE_CONTRACT_VERSION}, datetime('now'));
`;

/** Statement splitter for drivers that refuse multi-statement prepare. */
export function launchSchemaStatements(): string[] {
  return LAUNCH_SCHEMA_SQL.split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

/** The tiny slice of a SQLite handle this contract needs. Structural, so the
 *  pure modules and the migration runner can share one implementation. */
export interface LaunchDdlDb {
  exec(sql: string): unknown;
  prepare(sql: string): { all(): unknown[] };
}

/**
 * Apply the launch storage contract to an existing database. This is the EXACT
 * body of numbered migration 173, exported so the migration and the
 * upgrade-safety test can never drift.
 *
 * Idempotent and additive: `IF NOT EXISTS` for every table/index, and a
 * PRAGMA-guarded `ADD COLUMN` for the provenance columns on a database that
 * predates this migration. Rows are never rewritten, so a populated older
 * database upgrades in place.
 */
export function applyLaunchStorageContract(db: LaunchDdlDb): void {
  db.exec(LAUNCH_SCHEMA_SQL);
  const ensureColumn = (table: string, column: string, type: string) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (cols.length > 0 && !cols.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  };
  ensureColumn('launch_runs', 'installation_id', 'TEXT');
  ensureColumn('launch_run_events', 'installation_id', 'TEXT');
  ensureColumn('launch_progress_samples', 'client_slug', 'TEXT');
  ensureColumn('launch_progress_samples', 'host_shape', 'TEXT');
  ensureColumn('launch_progress_samples', 'installation_id', 'TEXT');
}
