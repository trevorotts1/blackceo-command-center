/**
 * ghl-projects-mappings.ts — WF33 mapping schema for the one-way
 * Command Center -> GHL Projects projection (Document 1 section 29.7).
 *
 * Command Center stays authoritative for build state, evidence and verified
 * completion. A GHL Projects task is a read-only echo of approved fields; a
 * remote task being marked done never certifies anything in Command Center.
 *
 * This module owns the mapping/intent SHAPES and their validation only. It
 * performs no I/O: the durable store and the GHL adapter are injected, so the
 * domain logic is testable offline and no second credentialed GHL client is
 * created inside Command Center.
 *
 * The projection is OPT-IN per tenant. A mapping exists only after an
 * authorized binding names the target space, home list and allowed task scope.
 * No "export the whole board" path exists.
 */

import { createHash } from 'node:crypto';

/** Bump when the projection semantics change in a way that needs re-mapping. */
export const SYNC_POLICY_VERSION = 1;

/**
 * Post-create field ownership. `cc` means Command Center may overwrite the
 * field on update; `human` means a human-entered GHL value is never overwritten
 * by this projection. Due date and assignee are applied ONCE at create from an
 * approved accountable value and then belong to the human, per section 29.7.
 */
export const GHL_PROJECT_FIELDS = [
  'title',
  'status',
  'due_date',
  'notes',
  'evidence_links',
  'verified_completion',
  'assignee',
] as const;

export type GhlProjectField = (typeof GHL_PROJECT_FIELDS)[number];
export type FieldOwnership = Record<GhlProjectField, 'cc' | 'human'>;

export const DEFAULT_FIELD_OWNERSHIP: FieldOwnership = {
  title: 'cc',
  status: 'cc',
  due_date: 'human',
  notes: 'human',
  evidence_links: 'cc',
  verified_completion: 'cc',
  assignee: 'human',
};

export type SyncState = 'unsynced' | 'pending' | 'in_sync' | 'drift' | 'blocked' | 'failed';

/** Stable, non-secret correlation marker written on the remote task so a lost
 *  create response can be reconciled by lookup instead of a duplicate create. */
export function correlationMarkerFor(companyId: string, locationId: string, ccTaskId: string): string {
  return `cc-wf33:${companyId}:${locationId}:${ccTaskId}`;
}

/**
 * Required internal mapping (section 29.7). Every target id is bound to the
 * authenticated company/location at bind time; a body-supplied company id can
 * never override server context.
 */
export interface GhlProjectsMapping {
  company_id: string;
  location_id: string;
  cc_task_id: string;
  project_space_id: string;
  project_home_list_id: string;
  /** null until the remote task has been created and read back. */
  project_task_id: string | null;
  sync_policy_version: number;
  enabled: boolean;
  field_ownership: FieldOwnership;
  /** Task scopes this binding authorizes, e.g. ['verified_completion']. */
  allowed_task_scopes: string[];
  correlation_marker: string;
  last_source_revision: string | null;
  /** Monotonic CC source sequence; protects against reordered events. */
  last_source_sequence: number;
  last_applied_fingerprint: string | null;
  /** Canonical JSON of the last values this projection actually applied, so an
   *  update sends only CC-owned fields that really changed. */
  last_applied_fields_json: string | null;
  last_attempt_id: string | null;
  last_provider_readback_ref: string | null;
  sync_state: SyncState;
  pending_reason: string | null;
  last_observed_at: string | null;
}

export type SyncIntentStatus =
  | 'pending'
  | 'submitted'
  | 'acknowledged'
  | 'blocked'
  | 'unknown_outcome'
  | 'failed';

/**
 * Durable sync intent ("outbox" for the projection). Written BEFORE the single
 * adapter call, so an ambiguous outcome is always reconciled from persisted
 * state rather than re-guessed in memory.
 */
export interface ProjectsSyncIntent {
  intent_id: string;
  /** Dedupe key: tenant + task + source sequence + fingerprint. */
  logical_key: string;
  company_id: string;
  location_id: string;
  cc_task_id: string;
  source_revision: string;
  source_sequence: number;
  fingerprint: string;
  operation: 'create' | 'update';
  payload_json: string;
  status: SyncIntentStatus;
  attempts: number;
  last_attempt_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/** Persistence boundary. The SQL-backed store and its migration are WF18's
 *  (see GHL_PROJECTS_SYNC_MIGRATION_SQL and the WF33 change request). */
export interface ProjectsSyncStore {
  getMapping(companyId: string, locationId: string, ccTaskId: string): GhlProjectsMapping | null;
  saveMapping(mapping: GhlProjectsMapping): void;
  getIntent(logicalKey: string): ProjectsSyncIntent | null;
  saveIntent(intent: ProjectsSyncIntent): void;
}

export interface AuthenticatedTenant {
  companyId: string;
  locationId: string;
}

export interface BindProjectsTargetInput {
  /** Server-derived tenant. Never taken from a request body. */
  auth: AuthenticatedTenant;
  ccTaskId: string;
  target: {
    /** Optional values echoed from a request body; validated, never trusted. */
    companyId?: string | null;
    locationId?: string | null;
    spaceId: string;
    homeListId: string;
  };
  allowedTaskScopes: string[];
  fieldOwnership?: Partial<FieldOwnership>;
  enabled?: boolean;
}

export type BindResult =
  | { ok: true; mapping: GhlProjectsMapping }
  | { ok: false; reason: string };

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Build a mapping from an authorized binding. Rejects any target binding whose
 * body-supplied tenant disagrees with the authenticated tenant, and rejects an
 * unbounded scope (no scope list, or a wildcard) because that is the
 * "export everything" path this feature must not have.
 */
export function buildProjectsMapping(input: BindProjectsTargetInput): BindResult {
  const { auth, target } = input;
  if (!nonEmpty(auth?.companyId) || !nonEmpty(auth?.locationId)) {
    return { ok: false, reason: 'missing_authenticated_tenant' };
  }
  if (!nonEmpty(input.ccTaskId)) return { ok: false, reason: 'missing_cc_task_id' };

  if (nonEmpty(target?.companyId) && target.companyId !== auth.companyId) {
    return { ok: false, reason: 'target_company_mismatch' };
  }
  if (nonEmpty(target?.locationId) && target.locationId !== auth.locationId) {
    return { ok: false, reason: 'target_location_mismatch' };
  }
  if (!nonEmpty(target?.spaceId)) return { ok: false, reason: 'missing_target_space_id' };
  if (!nonEmpty(target?.homeListId)) return { ok: false, reason: 'missing_target_home_list_id' };

  const scopes = (input.allowedTaskScopes ?? []).filter(nonEmpty);
  if (scopes.length === 0) return { ok: false, reason: 'missing_task_scope' };
  if (scopes.some((scope) => scope === '*' || scope === 'all')) {
    return { ok: false, reason: 'wildcard_task_scope_not_allowed' };
  }

  const fieldOwnership: FieldOwnership = { ...DEFAULT_FIELD_OWNERSHIP };
  for (const [field, owner] of Object.entries(input.fieldOwnership ?? {})) {
    if (!(GHL_PROJECT_FIELDS as readonly string[]).includes(field)) {
      return { ok: false, reason: `unknown_field_ownership:${field}` };
    }
    if (owner !== 'cc' && owner !== 'human') {
      return { ok: false, reason: `invalid_field_ownership:${field}` };
    }
    fieldOwnership[field as GhlProjectField] = owner;
  }
  // Completion authority is never delegatable.
  fieldOwnership.verified_completion = 'cc';
  fieldOwnership.evidence_links = 'cc';

  return {
    ok: true,
    mapping: {
      company_id: auth.companyId,
      location_id: auth.locationId,
      cc_task_id: input.ccTaskId,
      project_space_id: target.spaceId,
      project_home_list_id: target.homeListId,
      project_task_id: null,
      sync_policy_version: SYNC_POLICY_VERSION,
      enabled: input.enabled ?? false,
      field_ownership: fieldOwnership,
      allowed_task_scopes: scopes,
      correlation_marker: correlationMarkerFor(auth.companyId, auth.locationId, input.ccTaskId),
      last_source_revision: null,
      last_source_sequence: 0,
      last_applied_fingerprint: null,
      last_applied_fields_json: null,
      last_attempt_id: null,
      last_provider_readback_ref: null,
      sync_state: 'unsynced',
      pending_reason: null,
      last_observed_at: null,
    },
  };
}

/** Canonical JSON: sorted keys, no whitespace — stable fingerprints. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** sha256 over the canonical CC-owned payload + revision + policy version. */
export function fingerprintOf(parts: {
  fields: Record<string, unknown>;
  sourceRevision: string;
  syncPolicyVersion: number;
}): string {
  const digest = createHash('sha256')
    .update(canonicalJson(parts))
    .digest('hex');
  return `sha256:${digest}`;
}

/**
 * Migration SQL for WF18 to register (WF33 owns no shared migration file).
 * Additive only: two new tables, no existing table touched.
 */
export const GHL_PROJECTS_SYNC_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS ghl_projects_sync_mappings (
  company_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  cc_task_id TEXT NOT NULL,
  project_space_id TEXT NOT NULL,
  project_home_list_id TEXT NOT NULL,
  project_task_id TEXT,
  sync_policy_version INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 0,
  field_ownership_json TEXT NOT NULL,
  allowed_task_scopes_json TEXT NOT NULL,
  correlation_marker TEXT NOT NULL,
  last_source_revision TEXT,
  last_source_sequence INTEGER NOT NULL DEFAULT 0,
  last_applied_fingerprint TEXT,
  last_applied_fields_json TEXT,
  last_attempt_id TEXT,
  last_provider_readback_ref TEXT,
  sync_state TEXT NOT NULL DEFAULT 'unsynced',
  pending_reason TEXT,
  last_observed_at TEXT,
  PRIMARY KEY (company_id, location_id, cc_task_id)
);

CREATE TABLE IF NOT EXISTS ghl_projects_sync_intents (
  logical_key TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  cc_task_id TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  source_sequence INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  operation TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ghl_projects_sync_intents_task
  ON ghl_projects_sync_intents (company_id, location_id, cc_task_id, source_sequence);
`;
