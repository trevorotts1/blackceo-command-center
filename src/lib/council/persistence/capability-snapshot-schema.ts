/**
 * Installation capability snapshot storage (CTR-165).
 *
 * One row per (tenant, company, installation). The row is bound to the
 * authenticated scope; insertion and reads always carry all three keys.
 * Only the bounded snapshot JSON is stored: there is no client absolute
 * path, prompt, memory, credential, or configuration value column.
 */

export const CAPABILITY_SNAPSHOT_SCHEMA_MIGRATION_NAME =
  'council_capability_snapshot';

export const CAPABILITY_SNAPSHOT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS council_capability_snapshots (
  tenant_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  basis TEXT NOT NULL CHECK (basis IN ('at_sitting', 'at_export')),
  source TEXT NOT NULL CHECK (source IN ('client_push', 'local_capture')),
  owner_subject TEXT NOT NULL,
  item_count INTEGER NOT NULL CHECK (item_count >= 0),
  items_json TEXT NOT NULL,
  limitations_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, company_id, installation_id)
);
`;
