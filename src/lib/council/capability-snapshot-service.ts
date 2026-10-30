/**
 * Capability snapshot service (CTR-165).
 *
 * One production read path for the report: use the scope-bound stored
 * snapshot. The Command Center may capture the snapshot through the existing
 * platform resolver ONLY when the verified principal's installation is THIS
 * host's own installation: tenant kind `self` AND the resolved
 * `installation_id` equals this process's declared `MC_INSTALLATION_ID`.
 * That is the same installation equality the middleware fence, Headquarters,
 * and the readiness receipt already require; a `self` tenant kind alone is a
 * registration label, not proof of which box this is. An undeclared
 * `MC_INSTALLATION_ID` is no proof at all, so no inventory is captured. A
 * `client` tenant is never read from disk; its runtime must push a snapshot
 * through the authenticated ingest route.
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

/**
 * True only when this request's verified installation IS this host.
 *
 * `MC_INSTALLATION_ID` is the installation's own stable identity, provisioned
 * on the box and paired with a `kind: "self"` registry entry for its own
 * hostname (32-command-center-setup/TENANT-CONFIGURATION.md). The equality
 * below is the one `src/middleware.ts` (`x-expected-installation-id`),
 * `src/lib/hq/context.ts`, `src/lib/readiness.ts` and
 * `src/lib/task-agent-assignment.ts` already enforce. Neither the request
 * host nor a tenant kind is accepted as proof: a shared host can carry a
 * `self` registration, and an unset id names no installation at all.
 */
export function isHostLocalInstallation(
  principal: Pick<CouncilPrincipal, 'tenantKind' | 'scope'>,
): boolean {
  const localInstallationId = (process.env.MC_INSTALLATION_ID ?? '').trim();
  if (localInstallationId === '') return false;
  return (
    principal.tenantKind === 'self' &&
    principal.scope.installation_id === localInstallationId
  );
}

export interface LoadCapabilitySnapshotOptions {
  /** `YYYY-MM-DD`; defaults to the report date. */
  captured_at?: string;
  now?: string;
}

/**
 * Load the snapshot for the caller's exact scope. When the verified principal
 * is this host's own installation and no snapshot is stored, capture and
 * persist one (the owner subject is the verified principal's subject). For
 * any other installation — a client box, another installation registered on
 * this host, or a host that declares no installation id — return null: the
 * server does not read another box and never labels this box's inventory with
 * someone else's installation id.
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
  if (!isHostLocalInstallation(principal)) return null;
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
