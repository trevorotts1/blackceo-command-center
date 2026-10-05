/**
 * Company Headquarters — canonical dynamic roster projection (unit B03, milestone V03).
 *
 * Authority: SPEC.md revision 4 §S3 (identity resolution, roster projection,
 * planned/archived/legacy rows) and the frozen contracts in `./types`
 * (unit P01). This module CONSUMES the frozen `HqAgent`/`HqDepartment` shapes and
 * never redeclares them; it also never invents a field for a fact the SPEC leaves
 * undefined (first consumer freezes it under S17).
 *
 * READ-ONLY, PURE and CLOCK-FREE: no database, no filesystem, no clock, no
 * mutation of the input rows. A storage reader (B08 snapshot) reads the scoped
 * rows, the existing runtime-binding resolver and the installed-registry probe;
 * this module decides what those rows MEAN. `observedAt` is copied from the
 * source observation and is never stamped with the projection time (S3).
 *
 * Every ambiguity the SPEC names becomes an explicit bucket or diagnostic —
 * never a silently repaired value:
 *   - unrecognized status  -> `'unknown'`, raw value restricted to diagnostics
 *   - status never observed -> diagnostic, still `'unknown'`
 *   - runtime binding absent/unverified -> `runtimeBound=false`, `canTalk=false`
 *   - declared head that resolves to no row -> `headAgentId=null` + diagnostic
 *   - enrolled-but-unmaterialized roles -> `plannedRoles`, never agent rows
 *   - untranslated department rows -> `archivedDepartments`
 *   - unattributed ("default"/NULL) rows -> `unassigned`, operator-view only
 *   - planned roles on non-scoped workspaces -> `plannedRoles`, operator-view only
 *   - foreign-company rows -> refused loudly (the caller's query is broken)
 */

import {
  HQ_AGENT_STATUSES,
  HQ_PROVISIONING_STATES,
  HQ_STAFFING,
  type HqAgent,
  type HqAgentStatus,
  type HqBindingKind,
  type HqDepartment,
  type HqProvisioning,
  type HqStaffing,
} from './types';

/* ================================================================== *
 * Input rows — the plain data a storage reader hands the projection.
 * ================================================================== */

/** One `workspaces` row (department identity is `workspaces.id`, SPEC S3). */
export type HqRosterWorkspaceRow = {
  id: string;
  slug: string;
  name: string;
  /** `workspaces.company_id`; `null`/`''`/`'default'` = this box's unattributed rows. */
  companyId: string | null;
  /** `workspaces.head_agent_id`, unresolved — the projection validates it against actual rows. */
  headAgentId: string | null;
  /** Soft-archive marker; the SPEC's archive/decline evidence lives here. */
  archivedAt: string | null;
  /** `workspaces.sort_order` — the "existing sort order" input to layout ordering. */
  sortOrder: number | null;
  /** Raw onboarding/provisioning receipt value (S3 source precedence 3). */
  provisioningRaw: string | null;
};

/** One `agents` row — a ROLE ROW, the S3 roster unit of work. */
export type HqRosterAgentRow = {
  id: string;
  workspaceId: string;
  displayName: string;
  role: string;
  isMaster: boolean;
  /** Raw reported status. Only exact known values map to themselves (S3). */
  status: string | null;
  /** Source observation time (e.g. `agents.updated_at` / a liveness receipt) — never fetch time. */
  observedAt: string | null;
  /** Raw `specialist_type`; the column's own default is `'on-call'`. */
  staffingRaw: string | null;
  /** `agents.openclaw_agent_id` — an EXPLICIT binding, or null. */
  openclawAgentId: string | null;
  /** What the existing resolver maps this role row to when no explicit binding exists. */
  resolvedRuntimeId: string | null;
  activeTaskIds: readonly string[];
};

/**
 * Enrolled-but-unmaterialized role (provisioning receipt, S3 precedence 3).
 * A bare role-library template describes capability only and is NOT evidence an
 * employee exists — passing one here is a caller defect the type cannot catch.
 */
export type HqPlannedRoleInput = {
  workspaceId: string;
  /** Template/receipt identity. Never an agent row id. */
  key: string;
  name: string;
};

export type HqRosterInput = {
  companyId: string;
  /**
   * Verified caller class (B02 `requireHqContext`). Unattributed/legacy rows are
   * for the verified operator only; a client projection never receives them (S3).
   */
  viewer: 'operator' | 'client';
  workspaces: readonly HqRosterWorkspaceRow[];
  agents: readonly HqRosterAgentRow[];
  plannedRoles?: readonly HqPlannedRoleInput[];
  /** Runtime ids present in the installed registry AND the runtime directory (S3 precedence 2). */
  installedRuntimeIds: readonly string[];
};

/* ================================================================== *
 * Output — the frozen department shape plus the non-aggregate sections.
 * ================================================================== */

/** Planned role: visually distinct, never counted as a running agent, never clickable live chat. */
export type HqPlannedRole = { workspaceId: string; key: string; name: string };

export type HqRosterDiagnostic =
  | { code: 'unrecognized_status'; agentId: string; rawValue: string }
  | { code: 'unrecognized_staffing'; agentId: string; rawValue: string | null }
  | { code: 'status_not_observed'; agentId: string }
  | { code: 'runtime_binding_unavailable'; agentId: string }
  | { code: 'missing_head'; workspaceId: string; declaredHeadAgentId: string };

export type HqRosterProjection = {
  /** Active, authorized departments — every one, no 24/30 floor, no cap. */
  departments: HqDepartment[];
  /** Honored archive/decline rows: still projected truthfully, never resurrected. */
  archivedDepartments: HqDepartment[];
  /** Legacy/default rows for the verified operator only (`viewer==='client'` -> empty). */
  unassigned: HqAgent[];
  plannedRoles: HqPlannedRole[];
  diagnostics: HqRosterDiagnostic[];
};

/** The SPEC's verbatim S3 labels, frozen once so every view spells them identically. */
export const HQ_ROSTER_LABELS = {
  setupIncomplete: 'Setup incomplete',
  runtimeBindingUnavailable: 'Runtime binding unavailable',
  statusNotObserved: 'Status not observed',
  sharedExecutor: 'Shared department executor',
  plannedRole: 'Planned role',
  unassignedSection: 'Unassigned records',
} as const;

/** A foreign-company or duplicate-id row reached the projection: the caller's query is wrong. */
export class HqRosterScopeError extends Error {
  readonly code: 'foreign_workspace' | 'duplicate_workspace';
  constructor(code: 'foreign_workspace' | 'duplicate_workspace', message: string) {
    super(message);
    this.name = 'HqRosterScopeError';
    this.code = code;
  }
}

/* ================================================================== *
 * Projection
 * ================================================================== */

const UNATTRIBUTED_COMPANY_IDS = new Set(['', 'default']);

function isUnattributed(companyId: string | null): boolean {
  return companyId === null || UNATTRIBUTED_COMPANY_IDS.has(companyId);
}

function knownStatus(raw: string | null): raw is HqAgentStatus {
  return raw !== null && (HQ_AGENT_STATUSES as readonly string[]).includes(raw);
}

function knownStaffing(raw: string | null): raw is HqStaffing {
  return raw !== null && (HQ_STAFFING as readonly string[]).includes(raw);
}

function knownProvisioning(raw: string | null): raw is HqProvisioning {
  return raw !== null && (HQ_PROVISIONING_STATES as readonly string[]).includes(raw);
}

type Binding = {
  runtimeAgentId: string | null;
  bindingKind: HqBindingKind;
  runtimeBound: boolean;
  canTalk: boolean;
};

/**
 * Runtime binding for one role row.
 *
 * `bindingKind` records what was DECLARED; `runtimeBound`/`canTalk` record what was
 * VERIFIED. An explicit id that fails installation verification therefore stays
 * `'explicit'` (so the failure is legible) while `canTalk` goes false — and it never
 * falls back to another runtime (S3: no name guess, no silent target).
 */
function bindingOf(row: HqRosterAgentRow, installed: ReadonlySet<string>, diagnostics: HqRosterDiagnostic[]): Binding {
  const explicit = row.openclawAgentId;
  const resolved = explicit ?? row.resolvedRuntimeId;
  const runtimeBound = resolved !== null && installed.has(resolved);
  const bindingKind: HqBindingKind = explicit !== null ? 'explicit' : resolved !== null ? 'department-shared' : 'unbound';
  if (!runtimeBound) diagnostics.push({ code: 'runtime_binding_unavailable', agentId: row.id });
  return { runtimeAgentId: resolved, bindingKind, runtimeBound, canTalk: runtimeBound };
}

function statusOf(row: HqRosterAgentRow, diagnostics: HqRosterDiagnostic[]): HqAgentStatus {
  // Unrecognized and unobserved are independent facts about one row: both are
  // reported when both hold, so the raw value is never silently erased.
  if (row.status !== null && !knownStatus(row.status)) {
    // S3: unrecognized -> unknown, raw value restricted to diagnostics.
    diagnostics.push({ code: 'unrecognized_status', agentId: row.id, rawValue: row.status });
  }
  if (row.status === null || row.observedAt === null) {
    // "Status not observed": no source observation at all, or no status value.
    diagnostics.push({ code: 'status_not_observed', agentId: row.id });
    return 'unknown';
  }
  return knownStatus(row.status) ? row.status : 'unknown';
}

function staffingOf(row: HqRosterAgentRow, diagnostics: HqRosterDiagnostic[]): HqStaffing {
  if (knownStaffing(row.staffingRaw)) return row.staffingRaw;
  // The column's own default (schema: specialist_type DEFAULT 'on-call'); the raw
  // value is still surfaced so an odd one cannot hide.
  diagnostics.push({ code: 'unrecognized_staffing', agentId: row.id, rawValue: row.staffingRaw });
  return 'on-call';
}

/**
 * Project one department's rows into the frozen `HqDepartment` shape.
 *
 * Seat/geometry ordering is NOT decided here (B04 `buildLayout` owns "head first,
 * then permanent by role then agent ID"). This projection emits a canonical,
 * input-order-independent order (ascending agent id) so a shuffled input can never
 * change the projection — and, through it, the layout hash.
 */
function projectDepartment(
  ws: HqRosterWorkspaceRow,
  rows: readonly HqRosterAgentRow[],
  planned: readonly HqPlannedRoleInput[],
  installed: ReadonlySet<string>,
  diagnostics: HqRosterDiagnostic[],
): HqDepartment {
  const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const declaredHead = ws.headAgentId;
  const headExists = declaredHead !== null && sorted.some((r) => r.id === declaredHead);
  if (declaredHead !== null && !headExists) {
    // "Head is head_agent_id resolved through an existing row" — a dangling id is
    // reported as no head, and is never resolved by a display-name guess.
    diagnostics.push({ code: 'missing_head', workspaceId: ws.id, declaredHeadAgentId: declaredHead });
  }
  const headAgentId = headExists ? declaredHead : null;

  const bindings = new Map<string, Binding>();
  for (const row of sorted) bindings.set(row.id, bindingOf(row, installed, diagnostics));

  // One observed runtime presence per (department, verified runtime id): role rows
  // sharing a runtime are linked seats, not several independent active employees.
  const presence = new Map<string, string[]>();
  for (const row of sorted) {
    const binding = bindings.get(row.id)!;
    if (!binding.runtimeBound || binding.runtimeAgentId === null) continue;
    const key = binding.runtimeAgentId;
    const group = presence.get(key);
    if (group) group.push(row.id);
    else presence.set(key, [row.id]);
  }
  const sharedWith = new Map<string, string[]>();
  for (const ids of presence.values()) {
    const ordered = [...ids].sort();
    for (const id of ordered) sharedWith.set(id, ordered.filter((other) => other !== id));
  }

  const agents: HqAgent[] = sorted.map((row) => {
    const binding = bindings.get(row.id)!;
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      displayName: row.displayName,
      role: row.role,
      isHead: row.id === headAgentId,
      staffing: staffingOf(row, diagnostics),
      runtimeBound: binding.runtimeBound,
      canTalk: binding.canTalk,
      runtimeAgentId: binding.runtimeAgentId,
      bindingKind: binding.bindingKind,
      sharedRoleIds: sharedWith.get(row.id) ?? [],
      status: statusOf(row, diagnostics),
      observedAt: row.observedAt,
      activeTaskIds: [...row.activeTaskIds],
    };
  });

  const provisioning: HqProvisioning = planned.length > 0
    // An enrolled role with no agent row outranks a stale "ready" receipt: the
    // conflict is shown as "Setup incomplete", not silently repaired (S3).
    ? 'incomplete'
    : knownProvisioning(ws.provisioningRaw) ? ws.provisioningRaw : 'unknown';

  return { id: ws.id, slug: ws.slug, name: ws.name, headAgentId, provisioning, agents };
}

/** Distinct verified runtime presences in a projected department (S3: a shared department executor counts once). */
export function hqObservedRuntimeCount(department: HqDepartment): number {
  const keys = new Set<string>();
  for (const agent of department.agents) {
    if (agent.runtimeBound && agent.runtimeAgentId !== null) keys.add(agent.runtimeAgentId);
  }
  return keys.size;
}

/**
 * Project scoped rows into the canonical roster. Pure: same input, same output,
 * regardless of row order; no clock, no I/O; the input is never mutated.
 */
export function buildRoster(input: HqRosterInput): HqRosterProjection {
  const installed = new Set(input.installedRuntimeIds);
  const diagnostics: HqRosterDiagnostic[] = [];
  const planned = input.plannedRoles ?? [];

  const byWorkspace = new Map<string, HqRosterAgentRow[]>();
  for (const row of input.agents) {
    const bucket = byWorkspace.get(row.workspaceId);
    if (bucket) bucket.push(row);
    else byWorkspace.set(row.workspaceId, [row]);
  }

  const workspaceIds = new Set<string>();
  const scopedWorkspaceIds = new Set<string>();
  for (const ws of input.workspaces) {
    if (workspaceIds.has(ws.id)) {
      throw new HqRosterScopeError('duplicate_workspace', `duplicate workspace row id '${ws.id}' — refusing to merge distinct department rows`);
    }
    workspaceIds.add(ws.id);
    if (!isUnattributed(ws.companyId) && ws.companyId === input.companyId) scopedWorkspaceIds.add(ws.id);
  }

  const departments: HqDepartment[] = [];
  const archivedDepartments: HqDepartment[] = [];
  const orphaned: HqRosterAgentRow[] = [];

  // "existing sort order, then stable workspace ID" — the geometry rule's data half.
  const ordered = [...input.workspaces].sort(
    (a, b) => (a.sortOrder ?? 1000) - (b.sortOrder ?? 1000) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  for (const ws of ordered) {
    const rows = byWorkspace.get(ws.id) ?? [];
    if (isUnattributed(ws.companyId)) {
      // Legacy/default rows: a separate "Unassigned records" section, operator only.
      orphaned.push(...rows);
      continue;
    }
    if (ws.companyId !== input.companyId) {
      throw new HqRosterScopeError('foreign_workspace', `workspace '${ws.id}' belongs to another company — the scoped query must not return it`);
    }
    const projected = projectDepartment(
      ws,
      rows,
      planned.filter((p) => p.workspaceId === ws.id),
      installed,
      diagnostics,
    );
    if (ws.archivedAt !== null) archivedDepartments.push(projected);
    else departments.push(projected);
  }

  // Role rows whose workspace row is absent are unattributed by definition.
  for (const [workspaceId, rows] of byWorkspace) {
    if (!workspaceIds.has(workspaceId)) orphaned.push(...rows);
  }

  // Planned roles obey the same scope as the rows they describe: a role on an
  // unattributed/default or unread workspace is legacy truth — operator-view
  // only, exactly like the `unassigned` agent section above.
  const visiblePlanned: HqPlannedRole[] = planned
    .filter((p) => input.viewer === 'operator' || scopedWorkspaceIds.has(p.workspaceId))
    .map((p) => ({ workspaceId: p.workspaceId, key: p.key, name: p.name }))
    .sort(
      (a, b) =>
        (a.workspaceId < b.workspaceId ? -1 : a.workspaceId > b.workspaceId ? 1 : 0) ||
        (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );

  return {
    departments,
    archivedDepartments,
    unassigned: input.viewer === 'operator' ? projectUnassigned(orphaned, installed, diagnostics) : [],
    plannedRoles: visiblePlanned,
    diagnostics,
  };
}

/** Legacy rows get the same truth treatment as any other row — they are just not a department. */
function projectUnassigned(
  rows: readonly HqRosterAgentRow[],
  installed: ReadonlySet<string>,
  diagnostics: HqRosterDiagnostic[],
): HqAgent[] {
  return [...rows]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((row) => {
      const binding = bindingOf(row, installed, diagnostics);
      return {
        id: row.id,
        workspaceId: row.workspaceId,
        displayName: row.displayName,
        role: row.role,
        isHead: false,
        staffing: staffingOf(row, diagnostics),
        runtimeBound: binding.runtimeBound,
        canTalk: binding.canTalk,
        runtimeAgentId: binding.runtimeAgentId,
        bindingKind: binding.bindingKind,
        sharedRoleIds: [],
        status: statusOf(row, diagnostics),
        observedAt: row.observedAt,
        activeTaskIds: [...row.activeTaskIds],
      };
    });
}
