/**
 * Capability snapshot service (CTR-165).
 *
 * One production read path for the report: use the scope-bound stored
 * snapshot. When the caller's tenant kind is `self`, the Command Center is
 * running on the installation it serves, so it may capture the snapshot
 * through the existing platform resolver and store it. A `client` tenant is
 * never read from disk; its runtime must push a snapshot through the
 * authenticated ingest route.
 */

import type Database from 'better-sqlite3';
import type { CouncilPrincipal } from './auth';
import {
  captureLocalCapabilities,
  type CaptureLocalCapabilitiesOptions,
} from './capability-snapshot-capture';
import type { InstallationCapabilitySnapshot } from './capability-snapshot';
import {
  loadCapabilitySnapshot,
  saveCapabilitySnapshot,
  type CapabilitySnapshotScope,
} from './persistence/capability-snapshot-store';

export interface LoadedCapabilitySnapshot {
  snapshot: InstallationCapabilitySnapshot;
  source: 'client_push' | 'local_capture';
  captured_now: boolean;
}

export function scopeForPrincipal(
  principal: Pick<CouncilPrincipal, 'scope'>,
): CapabilitySnapshotScope {
  return {
    tenant_id: principal.scope.tenant_id,
    company_id: principal.scope.company_id,
    installation_id: principal.scope.installation_id,
  };
}

export interface LoadCapabilitySnapshotOptions {
  /** `YYYY-MM-DD`; defaults to the report date. */
  captured_at?: string;
  now?: string;
}

/**
 * Load the snapshot for the caller's exact scope. For a self installation
 * with no stored snapshot, capture and persist one. For a client
 * installation with no stored snapshot, return null: the server does not
 * read another box.
 */
export function loadCapabilitySnapshotForPrincipal(
  db: Database.Database,
  principal: CouncilPrincipal,
  options: LoadCapabilitySnapshotOptions = {},
): LoadedCapabilitySnapshot | null {
  const scope = scopeForPrincipal(principal);
  const stored = loadCapabilitySnapshot(db, scope);
  if (stored !== null) {
    return {
      snapshot: stored.snapshot,
      source: stored.source,
      captured_now: false,
    };
  }
  if (principal.tenantKind !== 'self') return null;
  const now = options.now ?? new Date().toISOString();
  const capturedAt = options.captured_at ?? now.slice(0, 10);
  const snapshot = captureLocalCapabilities({
    installation_id: scope.installation_id,
    captured_at: capturedAt,
  } satisfies CaptureLocalCapabilitiesOptions);
  saveCapabilitySnapshot(db, scope, {
    snapshot,
    source: 'local_capture',
    owner_subject: principal.subject,
    now,
  });
  return { snapshot, source: 'local_capture', captured_now: true };
}
