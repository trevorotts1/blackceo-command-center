/**
 * Installation capability snapshot store (CTR-165).
 *
 * The snapshot is a scope-bound fact, not a global catalog. Every read and
 * write names tenant, company, and installation; a snapshot for another
 * installation is refused at both boundaries. The store never stores or
 * returns a client path.
 */

import type Database from 'better-sqlite3';
import {
  assertSnapshotInstallation,
  validateCapabilitySnapshot,
  type InstallationCapabilitySnapshot,
} from '../capability-snapshot';

export interface CapabilitySnapshotScope {
  tenant_id: string;
  company_id: string;
  installation_id: string;
}

export interface StoredCapabilitySnapshot {
  snapshot: InstallationCapabilitySnapshot;
  source: 'client_push' | 'local_capture';
  owner_subject: string;
  created_at: string;
  updated_at: string;
}

export interface SaveCapabilitySnapshotInput {
  snapshot: InstallationCapabilitySnapshot;
  source: 'client_push' | 'local_capture';
  owner_subject: string;
  now: string;
}

/**
 * Persist one snapshot. The snapshot's own installation id must match the
 * authenticated scope before anything is written; a cross-installation
 * snapshot is refused and no row changes.
 */
export function saveCapabilitySnapshot(
  db: Database.Database,
  scope: CapabilitySnapshotScope,
  input: SaveCapabilitySnapshotInput,
): void {
  assertSnapshotInstallation(input.snapshot, scope.installation_id);
  const snapshot = validateCapabilitySnapshot(input.snapshot);
  const itemsJson = JSON.stringify(snapshot.items);
  const limitationsJson = JSON.stringify(snapshot.limitations);
  db.prepare(
    `INSERT INTO council_capability_snapshots
       (tenant_id, company_id, installation_id, schema_version, captured_at,
        basis, source, owner_subject, item_count, items_json,
        limitations_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, company_id, installation_id) DO UPDATE SET
       schema_version = excluded.schema_version,
       captured_at = excluded.captured_at,
       basis = excluded.basis,
       source = excluded.source,
       owner_subject = excluded.owner_subject,
       item_count = excluded.item_count,
       items_json = excluded.items_json,
       limitations_json = excluded.limitations_json,
       updated_at = excluded.updated_at`,
  ).run(
    scope.tenant_id,
    scope.company_id,
    scope.installation_id,
    snapshot.schema_version,
    snapshot.captured_at,
    snapshot.basis,
    input.source,
    input.owner_subject,
    snapshot.items.length,
    itemsJson,
    limitationsJson,
    input.now,
    input.now,
  );
}

interface CapabilitySnapshotRow {
  schema_version: string;
  captured_at: string;
  basis: string;
  source: string;
  owner_subject: string;
  items_json: string;
  limitations_json: string;
  created_at: string;
  updated_at: string;
}

/**
 * Read the snapshot for exactly this scope. An unreadable or now-invalid
 * stored row is treated as absent (fail closed) rather than served with a
 * guessed shape.
 */
export function loadCapabilitySnapshot(
  db: Database.Database,
  scope: CapabilitySnapshotScope,
): StoredCapabilitySnapshot | null {
  const row = db
    .prepare(
      `SELECT schema_version, captured_at, basis, source, owner_subject,
              items_json, limitations_json, created_at, updated_at
         FROM council_capability_snapshots
        WHERE tenant_id = ? AND company_id = ? AND installation_id = ?`,
    )
    .get(scope.tenant_id, scope.company_id, scope.installation_id) as
    | CapabilitySnapshotRow
    | undefined;
  if (!row) return null;
  try {
    const snapshot = validateCapabilitySnapshot({
      schema_version: row.schema_version,
      installation_id: scope.installation_id,
      captured_at: row.captured_at,
      basis: row.basis,
      items: JSON.parse(row.items_json) as unknown,
      limitations: JSON.parse(row.limitations_json) as unknown,
    });
    assertSnapshotInstallation(snapshot, scope.installation_id);
    return {
      snapshot,
      source: row.source === 'local_capture' ? 'local_capture' : 'client_push',
      owner_subject: row.owner_subject,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  } catch {
    return null;
  }
}
