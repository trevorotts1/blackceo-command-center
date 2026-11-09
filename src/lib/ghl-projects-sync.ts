/**
 * ghl-projects-sync.ts — WF33: the one-way Command Center -> GHL Projects
 * projection (Document 1 section 29.7; acceptance B20 + IG-PROJECT-07).
 *
 * Command Center is authoritative for build state, evidence and VERIFIED
 * completion. This module projects a narrow, approved slice of a CC task into a
 * GHL Projects task. It never reads completion back from Projects, never dispatches
 * work from a remote change, and never writes CC task state.
 *
 * Event procedure (one projection pass, one adapter write at most):
 *   capture CC event/revision -> verify the allowed sync binding -> compute only
 *   CC-owned changed fields -> persist the intent -> call the authorized adapter
 *   ONCE -> read back -> acknowledge the intent and store the fingerprint.
 *
 * Safety properties proven by tests/unit/ghl-projects-sync.test.ts:
 *   - opt-in only: no binding / disabled binding / scope mismatch => no write;
 *   - duplicate and reordered events never duplicate a remote task or downgrade
 *     a newer applied revision;
 *   - an ambiguous create is recorded as unknown_outcome and reconciled by
 *     marker lookup BEFORE any second create;
 *   - a Projects outage blocks only this projection and returns a value; it does
 *     not throw into (or otherwise disturb) the business work;
 *   - human GHL notes/dates are never overwritten unless the field is CC-owned;
 *   - a remote disagreement is reported as drift, never fought with a rewrite;
 *   - a remote "Done" event can never certify a CC task.
 */

import { randomUUID } from 'node:crypto';
import {
  canonicalJson,
  fingerprintOf,
  SYNC_POLICY_VERSION,
  type FieldOwnership,
  type GhlProjectsMapping,
  type ProjectsSyncIntent,
  type ProjectsSyncStore,
  type SyncIntentStatus,
} from './ghl-projects-mappings';

export type CcTaskStatus = 'pending' | 'in_progress' | 'blocked' | 'done';

/**
 * CC source event. `sourceSequence` is CC's monotonic sequence for this task;
 * it is what protects against reordered delivery, which an opaque revision
 * string alone cannot do.
 */
export interface CcTaskProjectionSource {
  /** Where the event came from. A Projects-originated event is never a CC
   *  certification and is refused here. */
  origin?: 'cc' | 'projects';
  companyId: string;
  locationId: string;
  ccTaskId: string;
  sourceRevision: string;
  sourceSequence: number;
  title: string;
  status: CcTaskStatus;
  /** CC's independently verified completion. Only CC sets this. */
  verifiedCompletion: boolean;
  evidenceLinks: string[];
  /** Real approved accountable due date (YYYY-MM-DD) or null when unresolved. */
  approvedDueDate: string | null;
  /** At most one approved accountable owner. Several are never silently reduced. */
  approvedAssigneeIds: string[];
  humanNotes?: string | null;
  /** Scope tags this task belongs to, e.g. ['verified_completion']. */
  taskScopes: string[];
}

/**
 * Remote status is derived from VERIFIED completion, not from a raw CC "done".
 * A CC task marked done but not yet verified stays in progress remotely, so the
 * remote board can never display unverified work as completed.
 */
export const REMOTE_STATUS_MAP: Record<CcTaskStatus, string> = {
  pending: 'not_started',
  in_progress: 'in_progress',
  blocked: 'blocked',
  done: 'in_progress',
};

export interface GhlProjectTaskRef {
  companyId: string;
  locationId: string;
  spaceId: string;
  homeListId: string;
  projectTaskId: string;
}

export interface GhlProjectTaskSnapshot {
  projectTaskId: string;
  spaceId: string;
  homeListId: string;
  title: string;
  status: string;
  dueDate: string | null;
  notes: string | null;
  assigneeIds: string[];
  marker: string | null;
}

export interface GhlProjectTaskCreateRequest {
  companyId: string;
  locationId: string;
  spaceId: string;
  homeListId: string;
  title: string;
  status: string;
  dueDate: string;
  assigneeId: string;
  notes: string;
  marker: string;
}

export interface GhlProjectTaskUpdateRequest {
  ref: Omit<GhlProjectTaskRef, 'projectTaskId'> & { projectTaskId: string };
  /** Only CC-owned, actually-changed fields. Never due date or assignee. */
  fields: Record<string, unknown>;
}

/** Adapter errors are VALUES, not exceptions: the engine must be able to tell
 *  "not applied" from "outcome unknown" without guessing. */
export type AdapterResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string; retryable: boolean; ambiguous?: boolean; notFound?: boolean };

/** WF32's Projects adapter surface. WF33 calls it once per projection pass. */
export interface GhlProjectsAdapter {
  createTask(request: GhlProjectTaskCreateRequest): Promise<AdapterResult<GhlProjectTaskSnapshot>>;
  updateTask(request: GhlProjectTaskUpdateRequest): Promise<AdapterResult<GhlProjectTaskSnapshot>>;
  readTask(ref: GhlProjectTaskRef): Promise<AdapterResult<GhlProjectTaskSnapshot | null>>;
  /** Lost-create reconciliation: find a task carrying our correlation marker. */
  findTaskByMarker(request: {
    companyId: string;
    locationId: string;
    spaceId: string;
    homeListId: string;
    marker: string;
  }): Promise<AdapterResult<GhlProjectTaskSnapshot | null>>;
}

export type ProjectionOutcome =
  | 'verified'
  | 'processing'
  | 'duplicate'
  | 'unknown_outcome'
  | 'drift'
  | 'blocked'
  | 'failed'
  | 'not_requested';

export interface ProjectionResult {
  outcome: ProjectionOutcome;
  reason: string;
  retryable: boolean;
  mapping: GhlProjectsMapping | null;
  intent: ProjectsSyncIntent | null;
}

export interface ProjectionDeps {
  store: ProjectsSyncStore;
  adapter: GhlProjectsAdapter;
  now?: () => string;
  newId?: () => string;
}

function parseApplied(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Values this projection is allowed to own and write. */
function ccOwnedFields(source: CcTaskProjectionSource, ownership: FieldOwnership): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (ownership.title === 'cc') fields.title = source.title;
  if (ownership.status === 'cc') {
    fields.status = source.verifiedCompletion ? 'completed' : REMOTE_STATUS_MAP[source.status];
  }
  if (ownership.notes === 'cc') fields.notes = source.humanNotes ?? '';
  if (ownership.evidence_links === 'cc') fields.evidence_links = [...source.evidenceLinks].sort();
  if (ownership.verified_completion === 'cc') fields.verified_completion = source.verifiedCompletion === true;
  return fields;
}

function changedFields(
  current: Record<string, unknown>,
  applied: Record<string, unknown>,
): Record<string, unknown> {
  const changed: Record<string, unknown> = {};
  for (const key of Object.keys(current)) {
    if (canonicalJson(current[key]) !== canonicalJson(applied[key])) changed[key] = current[key];
  }
  return changed;
}

function composeNotes(source: CcTaskProjectionSource, ownership: FieldOwnership): string {
  const lines = [`[${'cc-wf33'}] Command Center projection`];
  if (ownership.evidence_links === 'cc' && source.evidenceLinks.length > 0) {
    lines.push('Evidence:');
    for (const link of [...source.evidenceLinks].sort()) lines.push(`- ${link}`);
  }
  if (ownership.notes === 'cc' && source.humanNotes) lines.push('', source.humanNotes);
  return lines.join('\n');
}

async function callAdapter<T>(fn: () => Promise<AdapterResult<T>>): Promise<AdapterResult<T>> {
  try {
    return await fn();
  } catch (err) {
    // An exception out of a WRITE call is genuinely ambiguous: it may or may
    // not have been applied. Treat it as ambiguous; reconcilers decide later.
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
      retryable: true,
      ambiguous: true,
    };
  }
}

/**
 * Run one projection pass for one CC task event.
 *
 * Returns a value in every case. A Projects outage yields `blocked`/`retryable`
 * and leaves the original CC work untouched — the caller must not treat this as
 * a task failure.
 */
export async function projectCcTaskEvent(
  source: CcTaskProjectionSource,
  deps: ProjectionDeps,
): Promise<ProjectionResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  const newId = deps.newId ?? (() => randomUUID());
  const { store, adapter } = deps;

  const stop = (
    outcome: ProjectionOutcome,
    reason: string,
    mapping: GhlProjectsMapping | null,
    intent: ProjectsSyncIntent | null = null,
    retryable = false,
  ): ProjectionResult => ({ outcome, reason, retryable, mapping, intent });

  // A Projects-originated event is never a CC certification.
  if (source.origin === 'projects') {
    return stop('not_requested', 'remote_projects_event_never_certifies_cc', null);
  }
  if (!source.companyId || !source.locationId) {
    return stop('not_requested', 'missing_authenticated_tenant', null);
  }
  if (!Number.isInteger(source.sourceSequence) || source.sourceSequence < 0) {
    return stop('blocked', 'invalid_source_sequence', null);
  }

  const mapping = store.getMapping(source.companyId, source.locationId, source.ccTaskId);
  if (!mapping) return stop('not_requested', 'no_authorized_binding', null);
  if (!mapping.enabled) return stop('not_requested', 'projection_disabled_for_tenant', mapping);
  if (mapping.sync_policy_version !== SYNC_POLICY_VERSION) {
    return stop('blocked', 'sync_policy_version_unsupported', mapping);
  }
  const inScope = source.taskScopes.some((scope) => mapping.allowed_task_scopes.includes(scope));
  if (!inScope) return stop('not_requested', 'task_outside_authorized_scope', mapping);

  // Reordered delivery: a newer applied sequence is never downgraded.
  if (source.sourceSequence < mapping.last_source_sequence) {
    return stop('duplicate', 'reordered_event_ignored', mapping);
  }

  const ownership = mapping.field_ownership;
  const currentFields = ccOwnedFields(source, ownership);
  const fingerprint = fingerprintOf({
    fields: currentFields,
    sourceRevision: source.sourceRevision,
    syncPolicyVersion: mapping.sync_policy_version,
  });
  const logicalKey = [
    source.companyId,
    source.locationId,
    source.ccTaskId,
    String(source.sourceSequence),
    fingerprint,
  ].join('|');

  let intent = store.getIntent(logicalKey);
  if (intent && intent.status === 'acknowledged') {
    return stop('duplicate', 'already_applied', mapping, intent);
  }
  if (
    mapping.sync_state === 'in_sync' &&
    mapping.last_applied_fingerprint === fingerprint &&
    mapping.last_source_revision === source.sourceRevision
  ) {
    return stop('duplicate', 'already_applied', mapping, intent);
  }

  let operation: 'create' | 'update' = mapping.project_task_id ? 'update' : 'create';
  const applied = parseApplied(mapping.last_applied_fields_json);
  const changed = changedFields(currentFields, applied);

  if (operation === 'update' && Object.keys(changed).length === 0) {
    const observed: GhlProjectsMapping = {
      ...mapping,
      last_source_revision: source.sourceRevision,
      last_source_sequence: source.sourceSequence,
      last_observed_at: now(),
      pending_reason: null,
    };
    store.saveMapping(observed);
    return stop('duplicate', 'no_cc_owned_field_changed', observed, intent);
  }

  const persistBlocked = (reason: string): ProjectionResult => {
    const at = now();
    const blockedIntent: ProjectsSyncIntent = intent
      ? { ...intent, status: 'blocked', last_error: reason, updated_at: at }
      : {
          intent_id: newId(),
          logical_key: logicalKey,
          company_id: source.companyId,
          location_id: source.locationId,
          cc_task_id: source.ccTaskId,
          source_revision: source.sourceRevision,
          source_sequence: source.sourceSequence,
          fingerprint,
          operation,
          payload_json: canonicalJson(currentFields),
          status: 'blocked',
          attempts: 0,
          last_attempt_id: null,
          last_error: reason,
          created_at: at,
          updated_at: at,
        };
    store.saveIntent(blockedIntent);
    const blockedMapping: GhlProjectsMapping = {
      ...mapping,
      sync_state: 'blocked',
      pending_reason: reason,
      last_observed_at: at,
    };
    store.saveMapping(blockedMapping);
    return stop('blocked', reason, blockedMapping, blockedIntent, false);
  };

  // Create preconditions: never guess a date, never silently pick an owner.
  if (operation === 'create') {
    if (!source.approvedDueDate) return persistBlocked('missing_approved_due_date');
    if (source.approvedAssigneeIds.length === 0) return persistBlocked('missing_approved_assignee');
    if (source.approvedAssigneeIds.length > 1) return persistBlocked('multiple_assignees_not_supported');
  }

  const at = now();
  intent = intent
    ? { ...intent, payload_json: canonicalJson(currentFields), updated_at: at }
    : {
        intent_id: newId(),
        logical_key: logicalKey,
        company_id: source.companyId,
        location_id: source.locationId,
        cc_task_id: source.ccTaskId,
        source_revision: source.sourceRevision,
        source_sequence: source.sourceSequence,
        fingerprint,
        operation,
        payload_json: canonicalJson(currentFields),
        status: 'pending',
        attempts: 0,
        last_attempt_id: null,
        last_error: null,
        created_at: at,
        updated_at: at,
      };

  // Reconcile a previous uncertain create BEFORE issuing another one.
  let workingMapping: GhlProjectsMapping = { ...mapping };
  if (!workingMapping.project_task_id && workingMapping.last_attempt_id) {
    const found = await callAdapter(() =>
      adapter.findTaskByMarker({
        companyId: source.companyId,
        locationId: source.locationId,
        spaceId: workingMapping.project_space_id,
        homeListId: workingMapping.project_home_list_id,
        marker: workingMapping.correlation_marker,
      }),
    );
    if (!found.ok) {
      const pendingIntent: ProjectsSyncIntent = { ...intent, status: 'pending', last_error: found.reason, updated_at: now() };
      store.saveIntent(pendingIntent);
      const blockedMapping: GhlProjectsMapping = {
        ...workingMapping,
        sync_state: 'blocked',
        pending_reason: 'projects_unavailable_on_reconcile',
        last_observed_at: now(),
      };
      store.saveMapping(blockedMapping);
      return stop('blocked', 'projects_unavailable_on_reconcile', blockedMapping, pendingIntent, true);
    }
    if (found.value) {
      // Adopt the task that already exists: reuse the mapping, never duplicate.
      workingMapping = {
        ...workingMapping,
        project_task_id: found.value.projectTaskId,
        last_observed_at: now(),
      };
      operation = 'update';
    }
  }

  const attemptId = newId();
  intent = {
    ...intent,
    status: 'submitted',
    attempts: intent.attempts + 1,
    last_attempt_id: attemptId,
    updated_at: now(),
  };
  workingMapping = { ...workingMapping, last_attempt_id: attemptId, last_observed_at: now() };
  // Persist BEFORE the call: an ambiguous outcome is recoverable from disk.
  store.saveIntent(intent);
  store.saveMapping(workingMapping);

  const marker = workingMapping.correlation_marker;
  const call =
    operation === 'create'
      ? callAdapter(() =>
          adapter.createTask({
            companyId: source.companyId,
            locationId: source.locationId,
            spaceId: workingMapping.project_space_id,
            homeListId: workingMapping.project_home_list_id,
            title: String(currentFields.title ?? source.title),
            status: String(currentFields.status ?? REMOTE_STATUS_MAP[source.status]),
            dueDate: source.approvedDueDate as string,
            assigneeId: source.approvedAssigneeIds[0],
            notes: composeNotes(source, ownership),
            marker,
          }),
        )
      : callAdapter(() =>
          adapter.updateTask({
            ref: {
              companyId: source.companyId,
              locationId: source.locationId,
              spaceId: workingMapping.project_space_id,
              homeListId: workingMapping.project_home_list_id,
              projectTaskId: workingMapping.project_task_id as string,
            },
            fields: changed,
          }),
        );

  const wrote = await call;

  if (!wrote.ok) {
    if (wrote.notFound === true) {
      // The mapped remote target was deleted. Report drift; recreating it needs
      // an approved new binding, never an automatic second create.
      const driftIntent: ProjectsSyncIntent = {
        ...intent,
        status: 'blocked',
        last_error: 'remote_target_missing',
        updated_at: now(),
      };
      store.saveIntent(driftIntent);
      const driftMapping: GhlProjectsMapping = {
        ...workingMapping,
        sync_state: 'drift',
        pending_reason: 'remote_target_missing',
        last_observed_at: now(),
      };
      store.saveMapping(driftMapping);
      return stop('drift', 'remote_target_missing', driftMapping, driftIntent, false);
    }
    const ambiguous = wrote.ambiguous === true;
    const status: SyncIntentStatus = ambiguous ? 'unknown_outcome' : wrote.retryable ? 'pending' : 'failed';
    const failedIntent: ProjectsSyncIntent = {
      ...intent,
      status,
      last_error: wrote.reason,
      updated_at: now(),
    };
    store.saveIntent(failedIntent);

    if (status === 'unknown_outcome') {
      const unknownMapping: GhlProjectsMapping = {
        ...workingMapping,
        sync_state: 'blocked',
        pending_reason: 'unknown_outcome_awaiting_reconcile',
        last_observed_at: now(),
      };
      store.saveMapping(unknownMapping);
      // No second write. The next pass reconciles by marker first.
      return stop('unknown_outcome', 'write_outcome_unknown_reconcile_before_retry', unknownMapping, failedIntent, true);
    }
    if (status === 'pending') {
      const outageMapping: GhlProjectsMapping = {
        ...workingMapping,
        sync_state: 'blocked',
        pending_reason: 'projects_unavailable',
        last_observed_at: now(),
      };
      store.saveMapping(outageMapping);
      return stop('blocked', 'projects_unavailable', outageMapping, failedIntent, true);
    }
    const failedMapping: GhlProjectsMapping = {
      ...workingMapping,
      sync_state: 'failed',
      pending_reason: wrote.reason,
      last_observed_at: now(),
    };
    store.saveMapping(failedMapping);
    return stop('failed', wrote.reason, failedMapping, failedIntent, false);
  }

  const writtenSnapshot = wrote.value;
  const ref = {
    companyId: source.companyId,
    locationId: source.locationId,
    spaceId: workingMapping.project_space_id,
    homeListId: workingMapping.project_home_list_id,
    projectTaskId: writtenSnapshot.projectTaskId,
  };

  const read = await callAdapter(() => adapter.readTask(ref));
  if (!read.ok) {
    const pendingIntent: ProjectsSyncIntent = { ...intent, status: 'submitted', last_error: read.reason, updated_at: now() };
    store.saveIntent(pendingIntent);
    const pendingMapping: GhlProjectsMapping = {
      ...workingMapping,
      project_task_id: writtenSnapshot.projectTaskId,
      sync_state: 'pending',
      pending_reason: 'readback_pending',
      last_observed_at: now(),
    };
    store.saveMapping(pendingMapping);
    return stop('processing', 'readback_pending', pendingMapping, pendingIntent, true);
  }

  if (!read.value) {
    if (operation === 'create') {
      const unknownIntent = { ...intent, status: 'unknown_outcome' as SyncIntentStatus, updated_at: now() };
      store.saveIntent(unknownIntent);
      const unknownMapping: GhlProjectsMapping = {
        ...workingMapping,
        sync_state: 'blocked',
        pending_reason: 'created_task_not_readable',
        last_observed_at: now(),
      };
      store.saveMapping(unknownMapping);
      return stop('unknown_outcome', 'created_task_not_readable', unknownMapping, unknownIntent, true);
    }
    // The mapped remote target no longer exists. Report; never recreate it
    // without an approved new binding.
    const driftIntent = { ...intent, status: 'blocked' as SyncIntentStatus, last_error: 'remote_target_missing', updated_at: now() };
    store.saveIntent(driftIntent);
    const driftMapping: GhlProjectsMapping = {
      ...workingMapping,
      sync_state: 'drift',
      pending_reason: 'remote_target_missing',
      last_observed_at: now(),
    };
    store.saveMapping(driftMapping);
    return stop('drift', 'remote_target_missing', driftMapping, driftIntent, false);
  }

  const snapshot = read.value;
  const mismatched: string[] = [];
  if (ownership.title === 'cc' && snapshot.title !== currentFields.title) mismatched.push('title');
  if (ownership.status === 'cc' && snapshot.status !== currentFields.status) mismatched.push('status');
  if (ownership.notes === 'cc' && (snapshot.notes ?? '') !== String(currentFields.notes ?? '')) {
    mismatched.push('notes');
  }
  if (!snapshot.marker || !snapshot.marker.includes(marker)) mismatched.push('marker');

  if (mismatched.length > 0) {
    // Drift is reported, never fought: no second write in this pass.
    const driftIntent: ProjectsSyncIntent = {
      ...intent,
      status: 'blocked',
      last_error: `readback_mismatch:${mismatched.join(',')}`,
      updated_at: now(),
    };
    store.saveIntent(driftIntent);
    const driftMapping: GhlProjectsMapping = {
      ...workingMapping,
      project_task_id: snapshot.projectTaskId,
      sync_state: 'drift',
      pending_reason: `readback_mismatch:${mismatched.join(',')}`,
      last_observed_at: now(),
    };
    store.saveMapping(driftMapping);
    return stop('drift', `readback_mismatch:${mismatched.join(',')}`, driftMapping, driftIntent, false);
  }

  const verifiedIntent: ProjectsSyncIntent = {
    ...intent,
    status: 'acknowledged',
    last_error: null,
    updated_at: now(),
  };
  store.saveIntent(verifiedIntent);
  const verifiedMapping: GhlProjectsMapping = {
    ...workingMapping,
    project_task_id: snapshot.projectTaskId,
    last_source_revision: source.sourceRevision,
    last_source_sequence: source.sourceSequence,
    last_applied_fingerprint: fingerprint,
    last_applied_fields_json: canonicalJson(currentFields),
    last_provider_readback_ref: `readback:${snapshot.projectTaskId}:${source.sourceSequence}`,
    sync_state: 'in_sync',
    pending_reason: null,
    last_observed_at: now(),
  };
  store.saveMapping(verifiedMapping);
  return stop('verified', 'readback_matched', verifiedMapping, verifiedIntent, false);
}
