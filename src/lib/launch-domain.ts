/**
 * launch-domain.ts — F23: the governed launch domain's admission, identity,
 * projection, invalidation and presentation rules.
 *
 * ONE module owns the answer to "may this governed launch card advance?" so the
 * central task lifecycle (`src/lib/task-lifecycle.ts`) does not grow a second,
 * drifting copy. It is split into:
 *
 *   PURE CORE (no db, no fs) — projection, scope, states, link labels, legacy
 *   reconciliation, invalidation derivation and the card-admission verdict.
 *   DB ADAPTER — the verdict reads the launch domain tables (identity, binding,
 *   stages, approvals, invalidations) exactly as the producer wrote them.
 *
 * RULES THIS MODULE ENFORCES (F23 items in parentheses):
 *   1. a launch card is GOVERNED by its binding/source, and a governed card
 *      cannot enter review/complete without launch-specific evidence (6);
 *   2. admission is decided BEFORE any operator override is consulted — the
 *      caller (checkPreconditions) places this check above that bail-out, and
 *      a test fails if the order is reversed (13);
 *   3. a report's overall/percentage is a PROJECTION of canonical unit
 *      evidence, never the producer's own summary (3, 4);
 *   4. a closed stage needs a pass receipt AND artifact hashes that are
 *      verified against registered deliverables (3);
 *   5. run identity is immutable: a mismatch is rejected, never overwritten
 *      (2);
 *   6. changed evidence, a revoked scoped approval and a superseded artifact
 *      mint explicit invalidation events and the old green state stops being
 *      current (5);
 *   7. a card completes at its own granularity; a completed subtask never
 *      closes its parent automatically (7);
 *   8. evidence links are labelled local / preview / live and a tenant
 *      mismatch is refused (9);
 *   9. legacy ambiguous runs are reconciled conservatively and no historical
 *      receipt is fabricated (11).
 */

import { queryAll, queryOne, run, transaction } from '@/lib/db';

import {
  LAUNCH_ABILITIES,
  computeLaunchProgress,
  getLaunchAbility,
  launchStageVocabulary,
  type LaunchAbility,
  type LaunchStageRow,
} from './launch-abilities';
import { launchDomainSchemaStatements } from './launch-domain-schema';

// ---------------------------------------------------------------------------
// Idempotent schema bootstrap (SAME SQL as numbered migration 178)
// ---------------------------------------------------------------------------

let schemaReady = false;

export function ensureLaunchDomainSchema(): void {
  if (schemaReady) return;
  transaction(() => {
    const present = queryAll<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'launch_run_identity'`,
    );
    if (present.length === 0) {
      for (const statement of launchDomainSchemaStatements()) run(`${statement};`);
    }
    // Register the versioned vocabulary. INSERT OR IGNORE keeps an existing
    // registration and never rewrites history.
    const now = new Date().toISOString();
    for (const row of launchStageVocabulary()) {
      run(
        `INSERT OR IGNORE INTO launch_stage_vocabulary
           (skill, stage, canonical, alias_of, vocabulary_version, registered_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [row.skill, row.stage, row.canonical, row.alias_of, row.vocabulary_version, now],
      );
    }
  });
  schemaReady = true;
}

// ---------------------------------------------------------------------------
// F23.1 — which cards belong to the governed launch domain
// ---------------------------------------------------------------------------

/**
 * Producer sources whose cards are governed launch cards. The binding table is
 * the authoritative signal; these sources let a card that has NOT yet been
 * reconciled be recognized as governed instead of being treated as unrelated
 * background work.
 */
export const GOVERNED_LAUNCH_SOURCES: ReadonlySet<string> = new Set([
  'signature-funnel',
  'signature-launch',
  'black-friday-launcher',
  'signature-page',
  'launch',
]);

/** Departments whose cards are governed launch cards. */
export const GOVERNED_LAUNCH_DEPARTMENTS: ReadonlySet<string> = new Set([
  'launch',
  'launches',
  'black-friday-launcher',
  'signature-funnel',
  'signature-launch',
]);

export interface GovernedCardShape {
  id: string;
  source?: string | null;
  department?: string | null;
  title?: string | null;
}

function normalized(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  return text ? text : null;
}

/** True when a task is shaped like a governed launch card (before binding). */
export function isGovernedLaunchCard(task: GovernedCardShape): boolean {
  const source = normalized(task.source);
  if (source && GOVERNED_LAUNCH_SOURCES.has(source)) return true;
  const department = normalized(task.department);
  if (department && GOVERNED_LAUNCH_DEPARTMENTS.has(department)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// F23.2 — immutable run identity
// ---------------------------------------------------------------------------

export interface LaunchRunIdentity {
  runId: string;
  tenantId: string;
  workspaceId: string;
  installationId: string;
  skill: number;
  launchId: string;
  /** Null when the plan carries no revision; a later non-null revision then conflicts. */
  planRevision: number | null;
  planHash: string;
}

export type IdentityField =
  | 'tenant_id'
  | 'workspace_id'
  | 'installation_id'
  | 'skill'
  | 'launch_id'
  | 'plan_revision'
  | 'plan_hash';

export interface IdentityMismatch {
  field: IdentityField;
  stored: string;
  incoming: string;
}

const IDENTITY_FIELDS: ReadonlyArray<{
  field: IdentityField;
  read: (identity: LaunchRunIdentity) => string;
}> = [
  { field: 'tenant_id', read: (i) => i.tenantId },
  { field: 'workspace_id', read: (i) => i.workspaceId },
  { field: 'installation_id', read: (i) => i.installationId },
  { field: 'skill', read: (i) => String(i.skill) },
  { field: 'launch_id', read: (i) => i.launchId },
  { field: 'plan_revision', read: (i) => (i.planRevision === null ? '' : String(i.planRevision)) },
  { field: 'plan_hash', read: (i) => i.planHash },
];

/** Every stored/incoming difference on the immutable identity tuple. */
export function diffRunIdentity(
  stored: LaunchRunIdentity,
  incoming: LaunchRunIdentity,
): IdentityMismatch[] {
  const mismatches: IdentityMismatch[] = [];
  for (const { field, read } of IDENTITY_FIELDS) {
    const a = read(stored);
    const b = read(incoming);
    if (a !== b) mismatches.push({ field, stored: a, incoming: b });
  }
  return mismatches;
}

export type BindIdentityResult =
  | { status: 'bound' }
  | { status: 'unchanged' }
  | { status: 'rejected'; mismatches: IdentityMismatch[] };

/**
 * Bind a run's identity immutably. First writer binds; every later writer must
 * match on the WHOLE tuple. A mismatch is rejected and the stored row is never
 * overwritten — re-binding a run to a different client, installation, launch or
 * plan revision is exactly the defect this function closes.
 */
export function bindLaunchRunIdentity(
  incoming: LaunchRunIdentity,
  now = new Date().toISOString(),
): BindIdentityResult {
  ensureLaunchDomainSchema();
  return transaction(() => {
    const row = queryOne<{
      run_id: string;
      tenant_id: string;
      workspace_id: string;
      installation_id: string;
      skill: number;
      launch_id: string;
      plan_revision: number | null;
      plan_hash: string;
    }>(`SELECT * FROM launch_run_identity WHERE run_id = ?`, [incoming.runId]);
    if (!row) {
      run(
        `INSERT INTO launch_run_identity
           (run_id, tenant_id, workspace_id, installation_id, skill, launch_id,
            plan_revision, plan_hash, bound_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          incoming.runId,
          incoming.tenantId,
          incoming.workspaceId,
          incoming.installationId,
          incoming.skill,
          incoming.launchId,
          incoming.planRevision,
          incoming.planHash,
          now,
        ],
      );
      return { status: 'bound' } as BindIdentityResult;
    }
    const stored: LaunchRunIdentity = {
      runId: row.run_id,
      tenantId: row.tenant_id,
      workspaceId: row.workspace_id,
      installationId: row.installation_id,
      skill: row.skill,
      launchId: row.launch_id,
      planRevision: row.plan_revision,
      planHash: row.plan_hash,
    };
    const mismatches = diffRunIdentity(stored, incoming);
    if (mismatches.length === 0) return { status: 'unchanged' } as BindIdentityResult;
    return { status: 'rejected', mismatches } as BindIdentityResult;
  });
}

export function readLaunchRunIdentity(runId: string): LaunchRunIdentity | null {
  ensureLaunchDomainSchema();
  const row = queryOne<{
    run_id: string;
    tenant_id: string;
    workspace_id: string;
    installation_id: string;
    skill: number;
    launch_id: string;
    plan_revision: number | null;
    plan_hash: string;
  }>(`SELECT * FROM launch_run_identity WHERE run_id = ?`, [runId]);
  if (!row) return null;
  return {
    runId: row.run_id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    installationId: row.installation_id,
    skill: row.skill,
    launchId: row.launch_id,
    planRevision: row.plan_revision,
    planHash: row.plan_hash,
  };
}

// ---------------------------------------------------------------------------
// F23.7 — card granularity (explicit, never implied by a child completing)
// ---------------------------------------------------------------------------

export type LaunchCardLevel = 'launch' | 'page' | 'wireframe' | 'copy' | 'automation';

export const LAUNCH_CARD_LEVELS: readonly LaunchCardLevel[] = [
  'launch',
  'page',
  'wireframe',
  'copy',
  'automation',
];

export interface ScopeRequirement {
  level: LaunchCardLevel;
  /** Evidence kinds this card needs before it can complete. */
  requiredEvidence: readonly string[];
  /** Only an entire-launch card needs the client's approved launch scope. */
  requiresApprovedScope: boolean;
}

const SCOPE_BY_LEVEL: Record<LaunchCardLevel, ScopeRequirement> = {
  launch: { level: 'launch', requiredEvidence: ['approved_launch_scope', 'unit_inventory'], requiresApprovedScope: true },
  page: { level: 'page', requiredEvidence: ['page'], requiresApprovedScope: false },
  wireframe: { level: 'wireframe', requiredEvidence: ['wireframe'], requiresApprovedScope: false },
  copy: { level: 'copy', requiredEvidence: ['copy'], requiresApprovedScope: false },
  automation: { level: 'automation', requiredEvidence: ['automation'], requiresApprovedScope: false },
};

export function requiredScopeFor(level: LaunchCardLevel): ScopeRequirement {
  return SCOPE_BY_LEVEL[level];
}

export interface CardCompletionInput {
  level: LaunchCardLevel;
  presentEvidence: Iterable<string>;
  approvedScope: boolean;
  /** True only when the canonical unit inventory is complete. */
  canonicalInventoryComplete: boolean;
}

export interface CardCompletionVerdict {
  ok: boolean;
  missing: string[];
  reason?: string;
}

/**
 * Evaluate a card at ITS OWN granularity. A wireframe completes as a wireframe;
 * a page needs a page artifact; an entire-launch card needs the approved scope
 * AND a complete canonical unit inventory. None of these is implied by a child
 * card completing.
 */
export function evaluateCardCompletion(input: CardCompletionInput): CardCompletionVerdict {
  const requirement = requiredScopeFor(input.level);
  const present = new Set(input.presentEvidence);
  const missing = requirement.requiredEvidence.filter((kind) => !present.has(kind));
  if (input.level === 'launch') {
    if (!input.approvedScope) missing.push('approved_scope');
    if (!input.canonicalInventoryComplete) missing.push('canonical_unit_inventory');
  }
  if (missing.length > 0) {
    return {
      ok: false,
      missing,
      reason:
        `A ${input.level} card needs ${requirement.requiredEvidence.join(', ')}` +
        `${requirement.requiresApprovedScope ? ' plus the approved launch scope' : ''}; ` +
        `missing: ${missing.join(', ')}.`,
    };
  }
  return { ok: true, missing: [] };
}

/**
 * F23.7 — a completed subtask must not automatically close its parent. Stated
 * as a function so every caller gets the same answer instead of re-deriving it.
 */
export function subtaskCompletionClosesParent(): { closes: false; reason: string } {
  return {
    closes: false,
    reason:
      'A completed subtask establishes only its own granularity; the parent closes on its own ' +
      'required evidence (and, for a launch card, the approved scope).',
  };
}

// ---------------------------------------------------------------------------
// F23.3 / F23.4 — canonical projection (never the producer's own summary)
// ---------------------------------------------------------------------------

export type CanonicalUnitState =
  | 'complete'
  | 'pending'
  | 'running'
  | 'blocked'
  | 'failed'
  | 'dropped'
  | 'unknown';

export interface CanonicalUnitEvidence {
  id: string;
  kind: string;
  required: boolean;
  state: CanonicalUnitState;
  /** SHA-256 of the delivered artifact, when the unit delivered one. */
  artifactHash?: string | null;
}

export interface CanonicalProgressProjection {
  totalUnits: number;
  doneUnits: number;
  /** Dropped is NOT delivered: the launch is not complete until it is fixed or dropped by the client. */
  droppedUnits: number;
  unknownUnits: number;
  percentage: number;
  /** Stage closure, kept SEPARATE from unit completion when displayed. */
  stagePercentage: number | null;
  stagePercentageLabel: string;
  complete: boolean;
  blocked: boolean;
}

/**
 * Project progress from the canonical unit inventory. Only `complete` counts.
 * Dropped/unknown/running/pending are never delivered, and an empty inventory
 * is never 100%.
 */
export function projectCanonicalProgress(
  units: readonly CanonicalUnitEvidence[],
  stagePercentage: number | null = null,
): CanonicalProgressProjection {
  const totalUnits = units.length;
  const doneUnits = units.filter((unit) => unit.state === 'complete').length;
  const droppedUnits = units.filter((unit) => unit.state === 'dropped').length;
  const unknownUnits = units.filter((unit) => unit.state === 'unknown').length;
  const blocked = units.some((unit) => unit.state === 'blocked' || unit.state === 'failed');
  const percentage = totalUnits === 0 ? 0 : Math.round((doneUnits / totalUnits) * 100);
  return {
    totalUnits,
    doneUnits,
    droppedUnits,
    unknownUnits,
    percentage,
    stagePercentage,
    stagePercentageLabel:
      stagePercentage === null ? 'stage progress not reported' : 'stage progress (stages, not units)',
    complete: totalUnits > 0 && doneUnits === totalUnits && unknownUnits === 0 && !blocked,
    blocked,
  };
}

export type ProjectedReportOverall = 'complete' | 'incomplete' | 'blocked' | 'test-run';

/**
 * Replace an agent-supplied report overall with a projection of current
 * evidence. A producer that says `complete` while a unit is pending is stored
 * as `incomplete`; the producer's claim stays in the event log for audit.
 */
export function projectReportOverall(input: {
  units: readonly CanonicalUnitEvidence[];
  reportedOverall?: string | null;
}): ProjectedReportOverall {
  const projection = projectCanonicalProgress(input.units);
  if (input.reportedOverall === 'test-run') return 'test-run';
  if (projection.complete) return 'complete';
  if (projection.blocked) return 'blocked';
  return 'incomplete';
}

/**
 * Project a report overall from the ability's stage rows. A stage counts only
 * when it is closed with a pass receipt; blocked stages make the run blocked.
 */
export function projectStageReportOverall(
  ability: LaunchAbility,
  launchId: string,
  rows: readonly LaunchStageRow[],
): ProjectedReportOverall {
  const progress = computeLaunchProgress(ability, launchId, rows);
  if (progress.blocked_stages.length > 0) return 'blocked';
  return progress.stages_closed === progress.stages_total && progress.stages_total > 0
    ? 'complete'
    : 'incomplete';
}

// ---------------------------------------------------------------------------
// F23.3 — verify artifact/receipt references before accepting a closed stage
// ---------------------------------------------------------------------------

export interface StageCloseVerificationInput {
  receiptStatus: string | null | undefined;
  artifactHashes: Record<string, string> | null | undefined;
  /** Hashes of artifacts actually registered against the card. */
  verifiedArtifactHashes: Iterable<string>;
  closedAt?: string | null;
  /** Injectable clock for tests. */
  now?: number;
}

export interface StageCloseVerification {
  ok: boolean;
  errors: string[];
}

const SHA256_HEX = /^[0-9a-f]{64}$/i;

/**
 * A closed stage is accepted only when the receipt PASSED, at least one
 * artifact hash was recorded, every recorded hash is verified against a
 * registered artifact, and the close timestamp parses. Authentication of the
 * transport is not completion; this is the content check.
 */
export function verifyStageClose(input: StageCloseVerificationInput): StageCloseVerification {
  const errors: string[] = [];
  if (input.receiptStatus !== 'pass') {
    errors.push(`receipt_status must be pass (got ${String(input.receiptStatus ?? 'absent')})`);
  }
  const hashes = Object.entries(input.artifactHashes ?? {});
  if (hashes.length === 0) errors.push('a closed stage must cite at least one artifact hash');
  const verified = new Set([...input.verifiedArtifactHashes].map((h) => h.toLowerCase()));
  for (const [name, hash] of hashes) {
    if (typeof hash !== 'string' || !SHA256_HEX.test(hash)) {
      errors.push(`artifact ${name} hash is not a SHA-256 hex string`);
      continue;
    }
    if (!verified.has(hash.toLowerCase())) {
      errors.push(`artifact ${name} hash ${hash} is not registered against this card`);
    }
  }
  if (!input.closedAt || Number.isNaN(Date.parse(input.closedAt))) {
    errors.push('closed_at must be a parseable date-time');
  } else if (input.now !== undefined && Date.parse(input.closedAt) > input.now) {
    errors.push('closed_at is in the future');
  }
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// F23.5 — explicit invalidation / revision events
// ---------------------------------------------------------------------------

export type InvalidationKind = 'evidence_changed' | 'approval_revoked' | 'artifact_superseded';

export interface InvalidationEvent {
  kind: InvalidationKind;
  launchId: string;
  runId: string | null;
  subject: string;
  previousState: string | null;
  newState: 'stale';
  reason: string;
}

export interface InvalidationInput {
  launchId: string;
  runId?: string | null;
  previousUnits: readonly CanonicalUnitEvidence[];
  currentUnits: readonly CanonicalUnitEvidence[];
  approvalsBefore?: ReadonlyArray<{ approvalId: string; revoked: boolean; expiresAt?: string | null }>;
  approvalsAfter?: ReadonlyArray<{ approvalId: string; revoked: boolean; expiresAt?: string | null }>;
  artifactsBefore?: readonly string[];
  artifactsAfter?: readonly string[];
  now?: number;
}

/**
 * Derive the invalidation events that make an old green state stop being
 * current. History is preserved: nothing is deleted, an event is appended.
 */
export function deriveInvalidationEvents(input: InvalidationInput): InvalidationEvent[] {
  const events: InvalidationEvent[] = [];
  const previousById = new Map(input.previousUnits.map((unit) => [unit.id, unit]));
  for (const current of input.currentUnits) {
    const before = previousById.get(current.id);
    if (!before) continue;
    if ((before.artifactHash ?? null) !== (current.artifactHash ?? null)) {
      events.push({
        kind: 'evidence_changed',
        launchId: input.launchId,
        runId: input.runId ?? null,
        subject: current.id,
        previousState: before.artifactHash ?? null,
        newState: 'stale',
        reason: `artifact hash changed for unit ${current.id}`,
      });
    }
  }
  const afterApprovals = new Map(
    (input.approvalsAfter ?? []).map((a) => [a.approvalId, a] as const),
  );
  for (const before of input.approvalsBefore ?? []) {
    const after = afterApprovals.get(before.approvalId);
    if (after && !before.revoked && after.revoked) {
      events.push({
        kind: 'approval_revoked',
        launchId: input.launchId,
        runId: input.runId ?? null,
        subject: before.approvalId,
        previousState: 'active',
        newState: 'stale',
        reason: `scoped approval ${before.approvalId} was revoked`,
      });
    }
  }
  if (input.artifactsBefore && input.artifactsAfter) {
    const after = new Set(input.artifactsAfter);
    for (const hash of input.artifactsBefore) {
      if (!after.has(hash)) {
        events.push({
          kind: 'artifact_superseded',
          launchId: input.launchId,
          runId: input.runId ?? null,
          subject: hash,
          previousState: hash,
          newState: 'stale',
          reason: `artifact ${hash} is no longer current`,
        });
      }
    }
  }
  return events;
}

/** Append invalidation events. Returns the ids written. */
export function recordInvalidationEvents(
  events: readonly InvalidationEvent[],
  now = new Date().toISOString(),
): string[] {
  ensureLaunchDomainSchema();
  const ids: string[] = [];
  transaction(() => {
    for (const event of events) {
      const id = `inv-${event.launchId}-${event.kind}-${event.subject}-${Date.now()}-${ids.length}`;
      run(
        `INSERT INTO launch_evidence_invalidations
           (invalidation_id, launch_id, run_id, kind, subject, previous_state, new_state, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          event.launchId,
          event.runId,
          event.kind,
          event.subject,
          event.previousState,
          event.newState,
          event.reason,
          now,
        ],
      );
      ids.push(id);
    }
  });
  return ids;
}

/** Invalidation events recorded for a launch, newest first. */
export function listInvalidationEvents(launchId: string): InvalidationEvent[] {
  ensureLaunchDomainSchema();
  const rows = queryAll<{
    kind: InvalidationKind;
    launch_id: string;
    run_id: string | null;
    subject: string;
    previous_state: string | null;
    new_state: string;
    reason: string;
    created_at: string;
  }>(
    `SELECT kind, launch_id, run_id, subject, previous_state, new_state, reason, created_at
       FROM launch_evidence_invalidations
      WHERE launch_id = ?
      ORDER BY created_at DESC`,
    [launchId],
  );
  return rows.map((row) => ({
    kind: row.kind,
    launchId: row.launch_id,
    runId: row.run_id,
    subject: row.subject,
    previousState: row.previous_state,
    newState: 'stale',
    reason: row.reason,
  }));
}

/**
 * A completion is current only when no invalidation event was recorded after
 * the evidence it rests on. `evidenceAt` is the close/accept time.
 */
export function completionIsCurrent(launchId: string, evidenceAt: string | null): boolean {
  ensureLaunchDomainSchema();
  if (!evidenceAt) return false;
  const row = queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM launch_evidence_invalidations
      WHERE launch_id = ? AND created_at > ?`,
    [launchId, evidenceAt],
  );
  return (row?.n ?? 0) === 0;
}

// ---------------------------------------------------------------------------
// F23.8 — practical launch states
// ---------------------------------------------------------------------------

export type PracticalLaunchState =
  | 'awaiting_design_choice'
  | 'awaiting_brand'
  | 'awaiting_copy'
  | 'awaiting_wireframes'
  | 'awaiting_mockups'
  | 'awaiting_image_work'
  | 'awaiting_independent_review'
  | 'awaiting_scoped_approval'
  | 'installed_draft'
  | 'published_observed'
  | 'blocked'
  | 'stale'
  | 'incomplete';

export interface PracticalStateInput {
  /** Existing board status (backlog/in_progress/review/blocked/done). */
  boardStatus?: string | null;
  /** Design/brand/copy/wireframe/mockup gates the run reports as open. */
  openGates?: readonly string[];
  /** True when an approval is required and not active. */
  awaitingApproval?: boolean;
  /** True when a governing proof changed after completion. */
  stale?: boolean;
  /** True once the draft is installed but not published. */
  installedDraft?: boolean;
  /** True only when a verified live publication was observed. */
  publishedObserved?: boolean;
  /** True when canonical unit evidence is incomplete. */
  incomplete?: boolean;
}

export interface PracticalLaunchStateResult {
  state: PracticalLaunchState;
  label: string;
}

const STATE_LABELS: Record<PracticalLaunchState, string> = {
  awaiting_design_choice: 'Awaiting your design choice',
  awaiting_brand: 'Awaiting brand assets',
  awaiting_copy: 'Awaiting copy',
  awaiting_wireframes: 'Awaiting wireframes',
  awaiting_mockups: 'Awaiting mockups',
  awaiting_image_work: 'Awaiting image work',
  awaiting_independent_review: 'Awaiting independent review',
  awaiting_scoped_approval: 'Awaiting your scoped approval',
  installed_draft: 'Installed as a draft',
  published_observed: 'Published (observed live)',
  blocked: 'Blocked',
  stale: 'Stale — evidence changed',
  incomplete: 'Incomplete',
};

/** Map a run onto the practical states the board already uses. */
export function practicalLaunchState(input: PracticalStateInput): PracticalLaunchStateResult {
  const pick = (state: PracticalLaunchState): PracticalLaunchStateResult => ({
    state,
    label: STATE_LABELS[state],
  });
  if (input.stale) return pick('stale');
  if (input.boardStatus === 'blocked') return pick('blocked');
  if (input.publishedObserved) return pick('published_observed');
  if (input.awaitingApproval) return pick('awaiting_scoped_approval');
  const gates = new Set((input.openGates ?? []).map((g) => g.trim().toLowerCase()));
  const order: Array<[string, PracticalLaunchState]> = [
    ['design_choice', 'awaiting_design_choice'],
    ['design', 'awaiting_design_choice'],
    ['brand', 'awaiting_brand'],
    ['copy', 'awaiting_copy'],
    ['wireframes', 'awaiting_wireframes'],
    ['mockups', 'awaiting_mockups'],
    ['image_work', 'awaiting_image_work'],
    ['images', 'awaiting_image_work'],
    ['independent_review', 'awaiting_independent_review'],
    ['review', 'awaiting_independent_review'],
  ];
  for (const [gate, state] of order) if (gates.has(gate)) return pick(state);
  if (input.installedDraft) return pick('installed_draft');
  return pick('incomplete');
}

// ---------------------------------------------------------------------------
// F23.9 — evidence links for the viewer, without crossing tenants
// ---------------------------------------------------------------------------

export type EvidenceLinkKind = 'local' | 'preview' | 'live' | 'refused';

export interface EvidenceLinkInput {
  href: string;
  /** True only when the live URL was independently observed, not asserted. */
  verifiedLive?: boolean;
  viewerTenantId?: string | null;
  ownerTenantId?: string | null;
}

export interface EvidenceLinkResult {
  kind: EvidenceLinkKind;
  label: string;
  href: string | null;
}

/**
 * Label a link the way the viewer can use it. A local path is labelled local
 * and never presented as a public preview; an unverified URL is a preview, not
 * live; a tenant that does not own the evidence is refused outright.
 */
export function classifyEvidenceLink(input: EvidenceLinkInput): EvidenceLinkResult {
  if (
    input.viewerTenantId &&
    input.ownerTenantId &&
    input.viewerTenantId !== input.ownerTenantId
  ) {
    return { kind: 'refused', label: 'Not available to this tenant', href: null };
  }
  const href = (input.href ?? '').trim();
  if (!href) return { kind: 'refused', label: 'No evidence link', href: null };
  if (/^file:\/\//i.test(href) || href.startsWith('/') || /^[A-Za-z]:[\\/]/.test(href)) {
    return { kind: 'local', label: 'Local path (this machine only)', href };
  }
  if (/^https?:\/\//i.test(href)) {
    if (input.verifiedLive === true) {
      return { kind: 'live', label: 'Live (observed)', href };
    }
    try {
      const parsed = new URL(href);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return { kind: 'preview', label: 'Preview (not verified live)', href };
      }
    } catch {
      /* fall through to refused */
    }
  }
  return { kind: 'refused', label: 'Invalid evidence link', href: null };
}

// ---------------------------------------------------------------------------
// F23.11 — conservative legacy reconciliation
// ---------------------------------------------------------------------------

export type LegacyReconciliationStatus = 'reconciled' | 'unverified' | 'quarantined';

export interface LegacyRunClaim {
  runId: string;
  launchId?: string | null;
  planHash?: string | null;
  status?: string | null;
  overall?: string | null;
}

export interface LegacyReconciliation {
  status: LegacyReconciliationStatus;
  runId: string;
  launchId: string | null;
  /** Legacy claims never mint a receipt: this is always false. */
  fabricatedReceipt: false;
  notes: string[];
}

const LAUNCH_ID_RE = /^[a-z0-9][a-z0-9-]{2,}$/;
const PLAN_HASH_RE = /^(?:sha256:)?([0-9a-f]{64})$/i;
const KNOWN_STATUSES = new Set([
  'incomplete',
  'complete',
  'blocked',
  'in_progress',
  'pending',
]);

/**
 * Reconcile an old ambiguous run without inventing anything. Complete identity
 * is linked; a partial claim stays unverified; contradictory claims (status vs
 * overall, or two incompatible identities) are quarantined. Historical receipts
 * are never fabricated.
 */
export function reconcileLegacyRun(claim: LegacyRunClaim): LegacyReconciliation {
  const notes: string[] = [];
  const launchId = typeof claim.launchId === 'string' ? claim.launchId.trim() : '';
  const planHashMatch = typeof claim.planHash === 'string' ? PLAN_HASH_RE.exec(claim.planHash) : null;
  const status = typeof claim.status === 'string' ? claim.status.trim().toLowerCase() : '';
  const overall = typeof claim.overall === 'string' ? claim.overall.trim().toLowerCase() : '';

  if (!LAUNCH_ID_RE.test(launchId)) {
    notes.push('legacy run has no usable launch_id; identity stays unresolved');
  }
  if (!planHashMatch) {
    notes.push('legacy run has no usable plan hash; no receipt can be reconstructed');
  }
  if (status && !KNOWN_STATUSES.has(status)) {
    notes.push(`legacy status "${status}" is not a known state`);
  }
  if (overall && !KNOWN_STATUSES.has(overall)) {
    notes.push(`legacy overall "${overall}" is not a known state`);
  }

  if (status && overall && status !== overall && !(status === 'in_progress' && overall === 'incomplete')) {
    return {
      status: 'quarantined',
      runId: claim.runId,
      launchId: launchId || null,
      fabricatedReceipt: false,
      notes: [...notes, `status "${status}" contradicts overall "${overall}"`],
    };
  }
  if (notes.length > 0) {
    return {
      status: 'unverified',
      runId: claim.runId,
      launchId: launchId || null,
      fabricatedReceipt: false,
      notes,
    };
  }
  return {
    status: 'reconciled',
    runId: claim.runId,
    launchId,
    fabricatedReceipt: false,
    notes: ['identity linked; completion must be re-derived from current evidence, not copied'],
  };
}

// ---------------------------------------------------------------------------
// F23.6 / F23.13 — admission for a governed launch card
// ---------------------------------------------------------------------------

export interface LaunchAdmissionTask {
  id: string;
  title?: string | null;
  source?: string | null;
  department?: string | null;
  status: string;
}

export type LaunchAdmissionCode =
  | 'LAUNCH_BINDING_MISSING'
  | 'LAUNCH_RUN_MISSING'
  | 'LAUNCH_IDENTITY_UNBOUND'
  | 'LAUNCH_IDENTITY_MISMATCH'
  | 'LAUNCH_EVIDENCE_INSUFFICIENT'
  | 'LAUNCH_APPROVAL_INVALID'
  | 'LAUNCH_CARD_LEVEL_INVALID'
  | 'LAUNCH_COMPLETION_STALE';

export interface LaunchAdmissionVerdict {
  allow: boolean;
  governed: boolean;
  code: LaunchAdmissionCode | null;
  reason: string;
}

const allowVerdict = (governed: boolean): LaunchAdmissionVerdict => ({
  allow: true,
  governed,
  code: null,
  reason: '',
});

const refuse = (code: LaunchAdmissionCode, reason: string): LaunchAdmissionVerdict => ({
  allow: false,
  governed: true,
  code,
  reason,
});

interface BindingRow {
  taskId: string;
  launchId: string;
  runId: string;
  cardLevel: LaunchCardLevel;
  tenantId: string;
  workspaceId: string;
  installationId: string;
}

interface BindingSqlRow {
  task_id: string;
  launch_id: string;
  run_id: string;
  card_level: LaunchCardLevel;
  tenant_id: string;
  workspace_id: string;
  installation_id: string;
}

function readBinding(taskId: string): BindingRow | null {
  const row = queryOne<BindingSqlRow>(
    `SELECT * FROM launch_task_bindings WHERE task_id = ?`,
    [taskId],
  );
  if (!row) return null;
  return {
    taskId: row.task_id,
    launchId: row.launch_id,
    runId: row.run_id,
    cardLevel: row.card_level,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    installationId: row.installation_id,
  };
}

/** The launch-specific evidence kinds a task's registered deliverables carry. */
function evidenceKindsForTask(taskId: string, artifactHashes: Iterable<string>): Set<string> {
  const kinds = new Set<string>();
  const hashes = new Set([...artifactHashes].map((h) => h.toLowerCase()));
  const rows = queryAll<{ deliverable_type: string; sha256: string | null }>(
    `SELECT deliverable_type, sha256 FROM task_deliverables WHERE task_id = ?`,
    [taskId],
  );
  for (const row of rows) {
    if (row.sha256 && hashes.has(row.sha256.toLowerCase())) {
      kinds.add(row.deliverable_type);
      kinds.add('artifact');
    }
  }
  if (rows.some((row) => row.deliverable_type === 'url')) kinds.add('page');
  return kinds;
}

/**
 * THE governed-launch admission decision.
 *
 * Callers: `checkPreconditions()` in task-lifecycle.ts, ABOVE the
 * `operatorOverride` bail-out, and the same-status revalidation path. This
 * function never consults an override: an override may re-decide routing, it
 * cannot make launch evidence exist or make a revoked approval active.
 */
export function launchAdmissionForTransition(
  task: LaunchAdmissionTask,
  to: string,
  now = Date.now(),
): LaunchAdmissionVerdict {
  ensureLaunchDomainSchema();
  const binding = readBinding(task.id);
  const governed = Boolean(binding) || isGovernedLaunchCard(task);
  if (!governed) return allowVerdict(false);
  // Only review/complete are gated here. Transport states stay untouched.
  if (to !== 'review' && to !== 'done') return allowVerdict(true);

  if (!binding) {
    return refuse(
      'LAUNCH_BINDING_MISSING',
      `Task ${task.id} is a governed launch card with no launch binding. Reconcile it to a ` +
        `launch run (and its approved plan) before review or completion; a free-form status ` +
        `update cannot stand in for launch evidence.`,
    );
  }

  const identity = readLaunchRunIdentity(binding.runId);
  if (!identity) {
    return refuse(
      'LAUNCH_IDENTITY_UNBOUND',
      `Task ${task.id} is bound to launch run ${binding.runId}, but that run has no immutable ` +
        `identity record. Bind tenant/workspace/installation/skill/launch/plan first.`,
    );
  }
  if (
    identity.launchId !== binding.launchId ||
    identity.tenantId !== binding.tenantId ||
    identity.workspaceId !== binding.workspaceId ||
    identity.installationId !== binding.installationId
  ) {
    return refuse(
      'LAUNCH_IDENTITY_MISMATCH',
      `Task ${task.id} binding (${binding.tenantId}/${binding.workspaceId}/` +
        `${binding.installationId}/${binding.launchId}) does not match run ${binding.runId}'s ` +
        `immutable identity (${identity.tenantId}/${identity.workspaceId}/` +
        `${identity.installationId}/${identity.launchId}). A mismatch is rejected, never rewritten.`,
    );
  }

  const runRow = queryOne<{ run_id: string; skill: number; launch_id: string | null }>(
    `SELECT run_id, skill, launch_id FROM launch_runs WHERE run_id = ?`,
    [binding.runId],
  );
  if (!runRow) {
    return refuse(
      'LAUNCH_RUN_MISSING',
      `Task ${task.id} is bound to launch run ${binding.runId}, but no such run exists in the ` +
        `launch store. Deliver a verified run before advancing the card.`,
    );
  }
  if (runRow.skill !== identity.skill || (runRow.launch_id && runRow.launch_id !== identity.launchId)) {
    return refuse(
      'LAUNCH_IDENTITY_MISMATCH',
      `Run ${binding.runId} reports skill ${runRow.skill}/launch ${runRow.launch_id ?? 'unset'}, ` +
        `which contradicts its bound identity (skill ${identity.skill}/launch ${identity.launchId}).`,
    );
  }

  const ability = getLaunchAbility(identity.skill);
  if (!ability) {
    return refuse(
      'LAUNCH_IDENTITY_MISMATCH',
      `Run ${binding.runId} claims skill ${identity.skill}, which is not a registered launch ability.`,
    );
  }
  if (!LAUNCH_CARD_LEVELS.includes(binding.cardLevel)) {
    return refuse('LAUNCH_CARD_LEVEL_INVALID', `Unknown launch card level "${binding.cardLevel}".`);
  }

  const stageRows = queryAll<{
    stage: string;
    status: string;
    receipt_status: string | null;
    closed_at: string | null;
    artifact_hashes_json: string | null;
  }>(
    `SELECT stage, status, receipt_status, closed_at, artifact_hashes_json
       FROM launch_run_stages WHERE run_id = ?`,
    [binding.runId],
  );
  const closed = stageRows.filter((row) => row.status === 'closed');
  if (closed.length === 0) {
    return refuse(
      'LAUNCH_EVIDENCE_INSUFFICIENT',
      `Run ${binding.runId} has no closed stage with a pass receipt; transport authentication ` +
        `alone is not completion.`,
    );
  }

  const stageHashes: string[] = [];
  for (const row of closed) {
    let hashes: Record<string, string> | null = null;
    if (row.artifact_hashes_json) {
      try {
        hashes = JSON.parse(row.artifact_hashes_json) as Record<string, string>;
      } catch {
        hashes = null;
      }
    }
    for (const hash of Object.values(hashes ?? {})) stageHashes.push(hash);
  }
  const deliverableHashes = queryAll<{ sha256: string | null }>(
    `SELECT sha256 FROM task_deliverables WHERE task_id = ? AND sha256 IS NOT NULL`,
    [task.id],
  )
    .map((row) => row.sha256)
    .filter((hash): hash is string => typeof hash === 'string');

  const verified = new Set(deliverableHashes.map((h) => h.toLowerCase()));
  const verifiedStageHashes = stageHashes.filter((hash) => verified.has(hash.toLowerCase()));
  if (verifiedStageHashes.length === 0) {
    return refuse(
      'LAUNCH_EVIDENCE_INSUFFICIENT',
      `Task ${task.id} has no registered deliverable whose SHA-256 matches an artifact cited by ` +
        `run ${binding.runId}'s closed stages. A launch card needs launch-specific evidence, not ` +
        `a single nonempty file or a syntactically valid URL.`,
    );
  }

  // A revoked or expired scoped approval invalidates the governing proof.
  const approval = queryOne<{ revoked: number; expires_at: string }>(
    `SELECT revoked, expires_at FROM launch_approvals
      WHERE tenant_id = ? AND plan_hash = ? AND kind = 'plan_build'
      ORDER BY created_at DESC LIMIT 1`,
    [binding.tenantId, identity.planHash],
  );
  if (approval) {
    if (approval.revoked === 1 || Date.parse(approval.expires_at) <= now) {
      return refuse(
        'LAUNCH_APPROVAL_INVALID',
        `The scoped plan approval for ${identity.planHash} is revoked or expired; completion cannot ` +
          `rest on a withdrawn approval.`,
      );
    }
  } else if (binding.cardLevel === 'launch') {
    return refuse(
      'LAUNCH_APPROVAL_INVALID',
      `An entire-launch card needs an active scoped approval for plan ${identity.planHash}; none exists.`,
    );
  }

  // Recompute completion from the SAME unit inventory the producer used.
  const units: CanonicalUnitEvidence[] = stageRows.map((row) => ({
    id: row.stage,
    kind: 'stage',
    required: true,
    state:
      row.status === 'closed' && row.receipt_status === 'pass'
        ? 'complete'
        : row.status === 'blocked'
          ? 'blocked'
          : row.status === 'closed'
            ? 'failed'
            : 'pending',
    artifactHash: null,
  }));
  const projection = projectCanonicalProgress(units);

  const cardEvidence = evidenceKindsForTask(task.id, stageHashes);
  // A verified artifact registered against this card IS evidence at the card's
  // own granularity (a wireframe completes as a wireframe, a page as a page).
  if (verifiedStageHashes.length > 0) cardEvidence.add(binding.cardLevel);
  if (binding.cardLevel === 'launch') {
    if (approval !== undefined && approval.revoked === 0) cardEvidence.add('approved_launch_scope');
    if (projection.complete) cardEvidence.add('unit_inventory');
  }
  const cardVerdict = evaluateCardCompletion({
    level: binding.cardLevel,
    presentEvidence: cardEvidence,
    approvedScope: approval !== undefined && approval.revoked === 0,
    canonicalInventoryComplete: projection.complete,
  });
  if (!cardVerdict.ok) {
    return refuse('LAUNCH_EVIDENCE_INSUFFICIENT', cardVerdict.reason ?? 'launch card evidence is incomplete');
  }

  // Old evidence that was invalidated after the close cannot stay current.
  const lastClose = closed
    .map((row) => row.closed_at ?? '')
    .filter(Boolean)
    .sort()
    .pop() ?? null;
  if (!completionIsCurrent(binding.launchId, lastClose)) {
    return refuse(
      'LAUNCH_COMPLETION_STALE',
      `Launch ${binding.launchId} has an invalidation event recorded after its last verified close; ` +
        `completion must be re-derived from current evidence.`,
    );
  }

  return allowVerdict(true);
}

/**
 * F23.13 — the same-status shortcut must not preserve stale completion.
 * Called BEFORE transition()'s idempotent early return for a governed card.
 */
export function revalidateSameStatusCompletion(
  task: LaunchAdmissionTask,
  now = Date.now(),
): LaunchAdmissionVerdict {
  if (task.status !== 'review' && task.status !== 'done') return allowVerdict(false);
  const verdict = launchAdmissionForTransition(task, task.status, now);
  if (verdict.allow) return verdict;
  return {
    allow: false,
    governed: true,
    code: 'LAUNCH_COMPLETION_STALE',
    reason:
      `Current status "${task.status}" is no longer supported by governing launch evidence: ` +
      verdict.reason,
  };
}

/** Bind a task to a run. A different existing binding is rejected. */
export function bindLaunchTask(input: {
  taskId: string;
  launchId: string;
  runId: string;
  cardLevel: LaunchCardLevel;
  tenantId: string;
  workspaceId: string;
  installationId: string;
  now?: string;
}): { status: 'bound' | 'unchanged' | 'rejected'; reason?: string } {
  ensureLaunchDomainSchema();
  const now = input.now ?? new Date().toISOString();
  return transaction(() => {
    const existing = readBinding(input.taskId);
    if (existing) {
      const same =
        existing.launchId === input.launchId &&
        existing.runId === input.runId &&
        existing.cardLevel === input.cardLevel &&
        existing.tenantId === input.tenantId &&
        existing.workspaceId === input.workspaceId &&
        existing.installationId === input.installationId;
      if (same) return { status: 'unchanged' as const };
      return {
        status: 'rejected' as const,
        reason: `task ${input.taskId} is already bound to ${existing.launchId}/${existing.runId}; a binding is immutable`,
      };
    }
    run(
      `INSERT INTO launch_task_bindings
         (task_id, launch_id, run_id, card_level, tenant_id, workspace_id, installation_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.taskId,
        input.launchId,
        input.runId,
        input.cardLevel,
        input.tenantId,
        input.workspaceId,
        input.installationId,
        now,
        now,
      ],
    );
    return { status: 'bound' as const };
  });
}

/** Every registered launch ability — used by callers that need the vocabulary. */
export function launchAbilities(): readonly LaunchAbility[] {
  return LAUNCH_ABILITIES;
}
