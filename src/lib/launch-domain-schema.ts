/**
 * launch-domain-schema.ts — the versioned storage contract for the F23 governed
 * launch domain: immutable run identity, task bindings, evidence invalidations
 * and the delivery outbox.
 *
 * Pure (no db, no fs, no node builtins) so the NUMBERED migration `178` in
 * `src/lib/db/migrations.ts` and the runtime idempotent bootstrap
 * (`ensureLaunchDomainSchema` in launch-domain.ts) apply the SAME SQL and can
 * never disagree. Same pattern as `src/lib/launch-schema.ts`.
 *
 * Additive only: `IF NOT EXISTS` on every object. A populated older database
 * upgrades in place and no row is rewritten.
 */

export const LAUNCH_DOMAIN_CONTRACT_VERSION = 1;

export const LAUNCH_DOMAIN_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS launch_run_identity (
  run_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  skill INTEGER NOT NULL,
  launch_id TEXT NOT NULL,
  plan_revision INTEGER,
  plan_hash TEXT NOT NULL,
  bound_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_launch_run_identity_launch
  ON launch_run_identity(tenant_id, launch_id);

CREATE TABLE IF NOT EXISTS launch_task_bindings (
  task_id TEXT PRIMARY KEY,
  launch_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  card_level TEXT NOT NULL CHECK (card_level IN ('launch','page','wireframe','copy','automation')),
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_launch_task_bindings_launch
  ON launch_task_bindings(launch_id, run_id);

CREATE TABLE IF NOT EXISTS launch_evidence_invalidations (
  invalidation_id TEXT PRIMARY KEY,
  launch_id TEXT NOT NULL,
  run_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('evidence_changed','approval_revoked','artifact_superseded')),
  subject TEXT NOT NULL,
  previous_state TEXT,
  new_state TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_launch_evidence_invalidations_launch
  ON launch_evidence_invalidations(launch_id, created_at);

CREATE TABLE IF NOT EXISTS launch_event_outbox (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  skill INTEGER NOT NULL,
  launch_id TEXT NOT NULL,
  plan_version INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','accepted','retrying','permanently_rejected')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  claim_token TEXT,
  claimed_at TEXT,
  accepted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_launch_event_outbox_due
  ON launch_event_outbox(status, next_attempt_at, plan_version, sequence);

CREATE TABLE IF NOT EXISTS launch_stage_vocabulary (
  skill INTEGER NOT NULL,
  stage TEXT NOT NULL,
  canonical TEXT NOT NULL,
  alias_of TEXT,
  vocabulary_version INTEGER NOT NULL,
  registered_at TEXT NOT NULL,
  PRIMARY KEY (skill, stage)
);

CREATE TABLE IF NOT EXISTS launch_domain_contract (
  contract TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO launch_domain_contract (contract, version, updated_at)
VALUES ('launch_domain', ${LAUNCH_DOMAIN_CONTRACT_VERSION}, datetime('now'));
`;

/** Statement splitter for drivers that refuse multi-statement prepare. */
export function launchDomainSchemaStatements(): string[] {
  return LAUNCH_DOMAIN_SCHEMA_SQL.split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

/** The tiny slice of a SQLite handle this contract needs. */
export interface LaunchDomainDdlDb {
  exec(sql: string): unknown;
}

/** Apply the governed-launch-domain contract. Idempotent and additive. */
export function applyLaunchDomainContract(db: LaunchDomainDdlDb): void {
  db.exec(LAUNCH_DOMAIN_SCHEMA_SQL);
}
