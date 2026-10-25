/**
 * PBB-129 / T-34 — Command Center booking, failure and outcome views.
 *
 * WHAT THIS IS
 * ------------
 * One read-only view model for the three client-facing surfaces the class
 * promises: BOOKINGS (request → confirmation → service → outcome), FAILURES
 * (P0–P3, one owner, coalesced duplicates, proven clearance) and OUTCOMES
 * (gift / contact / booking / sale counted independently, truthful
 * attribution). It renders over REAL adapter records and NAMES the missing
 * adapter instead of inventing capability the repo does not have.
 *
 * HARD RULES (each one is pinned by a test):
 *   - An unproven fact is UNKNOWN with a reason. It is never `0`, never
 *     "everything is fine", never a default priority.
 *   - A P0–P3 row without an owner is `unowned` (explicit), never blank and
 *     never assigned by guessing.
 *   - Duplicates coalesce onto one row; the folded ids and the count stay
 *     visible, so coalescing can never hide volume.
 *   - Clearance requires time + actor + evidence. A CLOSED record with no
 *     closing actor cannot claim `cleared`.
 *   - A stale or gapped snapshot is refused: equal revisions replay as a
 *     no-op, a revision jump demands an authoritative reload, and a clearance
 *     command bound to a stale revision is refused.
 *   - A booking is NEVER counted as a sale, and a booking claimed complete
 *     without a service receipt stays `unknown`.
 *   - An adapter that hands back something that is not a list is UNKNOWN with
 *     a named reason (`<surface>_adapter_invalid_return:<type>`). It is never
 *     a crash and never an empty success.
 *   - A record that cannot be used at all (missing/empty/non-string id, or a
 *     null row) is COUNTED in `excluded_malformed`, never dropped silently.
 *     The counter is `null` — UNKNOWN, not 0 — whenever its surface is unknown.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 * The repo has no booking or funnel table, and neither the T-28 booking
 * adapter (onboarding) nor the T-30 funnel adapter (command center) is on
 * `main` yet. This module therefore takes them as injected adapter contracts.
 * When an adapter is not registered the surface renders UNKNOWN with the
 * reason `no_<surface>_adapter` — it is NOT a fake-only UI and it is NOT an
 * empty success. The only surface the repo can serve from its own tables is
 * FAILURES (`bug_tickets` + `bug_ticket_events`, in
 * `exceptions-outcomes-db.ts`).
 *
 * ponytail: no new tables, no migrations, no write path. Ceiling — bookings
 * and outcomes stay UNKNOWN until T-28/T-30 register adapters. Upgrade path —
 * implement `SourceAdapter<BookingInput>` / `SourceAdapter<OutcomeRecord>`
 * over those adapters and pass them to `buildExceptionsOutcomesView`.
 *
 * Server-safe: no React, no DB import, no browser globals.
 */

// ─── Priority ───────────────────────────────────────────────────────────────

export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const;
export type Priority = (typeof PRIORITIES)[number];

/** P0 halts the affected scope, P1 needs action, P2 is digest, P3 monthly. */
export const PRIORITY_TREATMENT: Record<Priority, 'halt' | 'action' | 'digest' | 'monthly'> = {
  P0: 'halt',
  P1: 'action',
  P2: 'digest',
  P3: 'monthly',
};

const PRIORITY_ORDER: Record<Priority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/**
 * Classify a raw severity. Accepts the repo's real `BugSeverity` strings
 * ('P0 run-dead' … 'P3 improvement') and a bare 'P1'. Anything else is
 * UNKNOWN — never silently defaulted to P2/P3, which would hide a fault.
 */
export function priorityFromSeverity(raw: unknown): { priority: Priority | null; reason: string | null } {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { priority: null, reason: 'severity_missing' };
  }
  const match = /^\s*P([0-3])\b/i.exec(raw);
  if (!match) return { priority: null, reason: `unrecognised_severity:${raw}` };
  return { priority: `P${match[1]}` as Priority, reason: null };
}

/** Kept small and total: no throw for a raw value we have never seen. */
function mostSevere(current: Priority | null, next: Priority | null): Priority | null {
  if (!next) return current;
  if (!current) return next;
  return PRIORITY_ORDER[next] < PRIORITY_ORDER[current] ? next : current;
}

// ─── Ownership ──────────────────────────────────────────────────────────────

export interface OwnerInput {
  assigned_agent_id?: string | null;
  assigned_agent_name?: string | null;
  owner_name?: string | null;
}

export interface Owner {
  kind: 'agent' | 'human' | 'unowned';
  id: string | null;
  name: string | null;
}

export interface OwnerResolution {
  owner: Owner;
  reason: string | null;
}

function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'null' || trimmed === 'undefined') return null;
  return trimmed;
}

/**
 * Exactly ONE owner per row. Agent id wins, then agent name, then a named
 * human. Nothing known means `unowned` with a reason that the escalation
 * surface can act on — never an invented name.
 */
export function resolveOwner(input?: OwnerInput | null): OwnerResolution {
  const agentId = cleanText(input?.assigned_agent_id);
  const agentName = cleanText(input?.assigned_agent_name);
  const humanName = cleanText(input?.owner_name);
  if (agentId) return { owner: { kind: 'agent', id: agentId, name: agentName }, reason: null };
  if (agentName) return { owner: { kind: 'agent', id: null, name: agentName }, reason: null };
  if (humanName) return { owner: { kind: 'human', id: null, name: humanName }, reason: null };
  return { owner: { kind: 'unowned', id: null, name: null }, reason: 'owner_not_assigned' };
}

/** The one next action a client can take. Never empty, never "monitor". */
export function nextActionFor(priority: Priority | null, ownerKind: Owner['kind']): string {
  if (priority === null) return 'Classify the severity before acting on this item.';
  if (ownerKind === 'unowned') {
    return priority === 'P0' || priority === 'P1'
      ? 'Name one owner now, then halt and repair the affected scope.'
      : 'Name one owner before this goes into the review queue.';
  }
  switch (PRIORITY_TREATMENT[priority]) {
    case 'halt':
      return 'Halt the affected scope, then reconcile the unsafe action.';
    case 'action':
      return 'Repair the broken promise and confirm the fix with a receipt.';
    case 'digest':
      return 'Review in the daily digest.';
    case 'monthly':
      return 'Queue for the monthly review.';
  }
}

// ─── Clearance ──────────────────────────────────────────────────────────────

export interface ClearanceInput {
  at?: string | null;
  by?: string | null;
  evidence?: string | null;
}

export type ClearanceState = 'open' | 'cleared' | 'clearance_unknown';

export interface ClearanceResolution {
  state: ClearanceState;
  reason: string | null;
  missing: string[];
  by: string | null;
  at: string | null;
  evidence: string | null;
}

/**
 * Clearance is a proof, not an absence. All three parts are required:
 * when (`at`), who (`by`) and what proves it (`evidence`). A partial record
 * is `clearance_unknown`, never `cleared`.
 */
export function resolveClearance(input?: ClearanceInput | null): ClearanceResolution {
  if (!input) {
    return { state: 'open', reason: null, missing: [], by: null, at: null, evidence: null };
  }
  const at = cleanText(input.at);
  const by = cleanText(input.by);
  const evidence = cleanText(input.evidence);
  const missing: string[] = [];
  if (!at) missing.push('at');
  if (!by) missing.push('by');
  if (!evidence) missing.push('evidence');
  if (missing.length === 0) {
    return { state: 'cleared', reason: null, missing, by, at, evidence };
  }
  return {
    state: 'clearance_unknown',
    reason: `clearance_missing:${missing.join(',')}`,
    missing,
    by,
    at,
    evidence,
  };
}

// ─── Failure alerts: ownership, coalescing, clearance ───────────────────────

/** One failure record as an adapter supplies it. Raw values, unnormalised. */
export interface AlertInput {
  id: string;
  surface: string;
  severity: string;
  title: string;
  owner?: OwnerInput | null;
  /** Canonical ticket id this record duplicates (real: `bug_tickets.dedup_of`). */
  dedup_of?: string | null;
  /** Coalescing key for records that are not linked by `dedup_of`. */
  fingerprint?: string | null;
  first_seen_at?: string | null;
  last_seen_at?: string | null;
  revision?: number | null;
  next_action?: string | null;
  clearance?: ClearanceInput | null;
}

export type AlertState = 'open' | 'cleared' | 'clearance_unknown' | 'unknown';

export interface AlertRow {
  id: string;
  surface: string;
  title: string;
  priority: Priority | null;
  priority_reason: string | null;
  /** True when coalesced members disagreed; the most severe one governs. */
  priority_conflict: boolean;
  owner: Owner;
  owner_reason: string | null;
  next_action: string;
  state: AlertState;
  unknown_reason: string | null;
  /** Members whose severity could not be classified — never hidden. */
  unknown_member_ids: string[];
  cleared_partially: boolean;
  clearance: { by: string | null; at: string | null; evidence: string | null };
  coalesced_ids: string[];
  coalesced_count: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
  revision: number | null;
}

export interface AlertProjection {
  rows: AlertRow[];
  /** Source records folded into another row (never silently lost). */
  folded: number;
  orphans: string[];
  cycles: string[];
  /** Records unusable at all (bad id / null row). `null` = UNKNOWN, never 0. */
  excluded_malformed: number | null;
}

/**
 * Parse a stored timestamp to epoch milliseconds. Accepts both writers the
 * repo actually uses: `new Date().toISOString()` and sqlite `datetime('now')`
 * ('YYYY-MM-DD HH:MM:SS'); a bare value is read as UTC, the same convention
 * sqlite's own `datetime('now')` writes. Exported so the failure adapter orders
 * audit events by TIME instead of by raw string.
 */
export function parseTime(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  const hasZone = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(trimmed);
  const normalised = trimmed.includes(' ') ? trimmed.replace(' ', 'T') : trimmed;
  const ms = Date.parse(hasZone ? normalised : `${normalised}Z`);
  return Number.isFinite(ms) ? ms : null;
}

function earliest(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  const am = parseTime(a);
  const bm = parseTime(b);
  if (am === null) return b;
  if (bm === null) return a;
  return bm < am ? b : a;
}

function latest(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  const am = parseTime(a);
  const bm = parseTime(b);
  if (am === null) return b;
  if (bm === null) return a;
  return bm > am ? b : a;
}

const MAX_DEDUP_HOPS = 32;

/**
 * Project raw failure records into client-facing rows.
 *
 * Coalescing is deterministic and order-independent: a `dedup_of` child folds
 * into its canonical ticket, and records sharing an explicit fingerprint fold
 * together. A child pointing at an id that is not in the snapshot is kept and
 * marked `dedup_parent_missing`; a dedup cycle is kept and marked `dedup_cycle`.
 * Neither is ever dropped, and neither is ever treated as unique-and-fine.
 */
export function projectAlerts(alerts: readonly AlertInput[]): AlertProjection {
  // A non-list is not a snapshot: report UNKNOWN rather than crash or render 0.
  if (!Array.isArray(alerts)) {
    return { rows: [], folded: 0, orphans: [], cycles: [], excluded_malformed: null };
  }
  const duplicateIdFolds: string[] = [];
  const byId = new Map<string, AlertInput>();
  const incomingIds = new Set<string>();
  let excludedMalformed = 0;

  // Duplicate ids in one snapshot are themselves duplicates: keep the newest
  // revision so a replay cannot resurrect an older state.
  for (const alert of alerts) {
    if (!alert || typeof alert.id !== 'string' || !alert.id) {
      // Unusable, but never invisible: the volume is reported, not dropped.
      excludedMalformed += 1;
      continue;
    }
    incomingIds.add(alert.id);
    const held = byId.get(alert.id);
    if (held) {
      duplicateIdFolds.push(alert.id);
      const heldRev = typeof held.revision === 'number' ? held.revision : -Infinity;
      const nextRev = typeof alert.revision === 'number' ? alert.revision : -Infinity;
      if (nextRev >= heldRev) byId.set(alert.id, alert);
      continue;
    }
    byId.set(alert.id, alert);
  }

  // Resolve each record to a canonical root. `orphan` / `cycle` are terminal.
  const rootOf = new Map<string, string>();
  const orphanOf = new Map<string, string>();
  const cycleOf = new Set<string>();

  for (const id of byId.keys()) {
    let cursor = id;
    const seen = new Set<string>([id]);
    let state: 'root' | 'orphan' | 'cycle' = 'root';
    for (let hop = 0; hop < MAX_DEDUP_HOPS; hop += 1) {
      const record = byId.get(cursor);
      const parent = cleanText(record?.dedup_of);
      if (!parent || parent === cursor) break;
      if (!byId.has(parent)) {
        state = 'orphan';
        orphanOf.set(id, parent);
        break;
      }
      if (seen.has(parent)) {
        state = 'cycle';
        cycleOf.add(id);
        break;
      }
      seen.add(parent);
      cursor = parent;
    }
    rootOf.set(id, state === 'root' ? cursor : id);
  }

  // Group by root, then fold explicit fingerprints among the roots.
  const groups = new Map<string, string[]>();
  for (const id of byId.keys()) {
    const root = rootOf.get(id) ?? id;
    const bucket = groups.get(root);
    if (bucket) bucket.push(id);
    else groups.set(root, [id]);
  }

  const fingerprints = new Map<string, string[]>();
  for (const [root, members] of groups) {
    const record = byId.get(root);
    if (orphanOf.has(root) || cycleOf.has(root)) continue;
    const key = buildFingerprintKey(record);
    if (!key) continue;
    const bucket = fingerprints.get(key);
    if (bucket) bucket.push(root);
    else fingerprints.set(key, [root]);
  }
  for (const roots of fingerprints.values()) {
    if (roots.length < 2) continue;
    const sorted = [...roots].sort();
    const keeper = sorted[0];
    const keeperMembers = groups.get(keeper) ?? [];
    for (const other of sorted.slice(1)) {
      const moved = groups.get(other) ?? [];
      keeperMembers.push(...moved);
      groups.delete(other);
      // Every member of a merged root now belongs to the keeper's row.
      for (const member of moved) rootOf.set(member, keeper);
    }
    groups.set(keeper, keeperMembers);
  }

  const rows: AlertRow[] = [];
  const orphans: string[] = [];
  const cycles: string[] = [];

  for (const [root, members] of groups) {
    const memberIds = [...new Set(members)].sort();
    const representative = byId.get(root) ?? byId.get(memberIds[0])!;
    const recordIds = memberIds.map((id) => byId.get(id)!).filter(Boolean);

    let priority: Priority | null = null;
    let priorityReason: string | null = null;
    let priorityConflict = false;
    const unknownMemberIds: string[] = [];
    const seenPriorities = new Set<Priority>();

    for (const record of recordIds) {
      const classified = priorityFromSeverity(record.severity);
      if (classified.priority) {
        seenPriorities.add(classified.priority);
        priority = mostSevere(priority, classified.priority);
      } else {
        unknownMemberIds.push(record.id);
        priorityReason = priorityReason ?? classified.reason;
      }
    }
    if (seenPriorities.size > 1) priorityConflict = true;

    const ownerCandidates = [representative, ...recordIds].map((record) => resolveOwner(record.owner));
    const namedOwner =
      ownerCandidates.find((candidate) => candidate.owner.kind !== 'unowned') ?? ownerCandidates[0];
    const owner = namedOwner.owner;

    let clearance: ClearanceResolution = {
      state: 'open',
      reason: null,
      missing: [],
      by: null,
      at: null,
      evidence: null,
    };
    let anyOpen = false;
    let partialClearance: ClearanceResolution | null = null;
    let clearedClearance: ClearanceResolution | null = null;
    for (const record of recordIds) {
      const resolved = resolveClearance(record.clearance);
      if (resolved.state === 'open') anyOpen = true;
      else if (resolved.state === 'clearance_unknown') partialClearance ??= resolved;
      else clearedClearance ??= resolved;
    }
    if (anyOpen) {
      clearance = { state: 'open', reason: null, missing: [], by: null, at: null, evidence: null };
    } else if (partialClearance) {
      // A group is not cleared while one of its records cannot prove it.
      clearance = partialClearance;
    } else if (clearedClearance) {
      clearance = { ...clearedClearance, state: 'cleared', reason: null };
    }

    let state: AlertState = clearance.state;
    let unknownReason: string | null = null;
    if (orphanOf.has(root)) {
      state = 'unknown';
      unknownReason = `dedup_parent_missing:${orphanOf.get(root)}`;
      orphans.push(root);
    } else if (cycleOf.has(root)) {
      state = 'unknown';
      unknownReason = 'dedup_cycle';
      cycles.push(root);
    } else if (priority === null) {
      state = 'unknown';
      unknownReason = priorityReason ?? 'severity_missing';
    } else if (clearance.state === 'clearance_unknown') {
      // The clearance is the unknown fact, and its own reason names the
      // missing proof (e.g. `clearance_missing:by`).
      unknownReason = clearance.reason ?? 'clearance_missing';
    } else if (unknownMemberIds.length > 0) {
      unknownReason = `member_severity_unknown:${[...unknownMemberIds].sort().join(',')}`;
    }

    let firstSeen: string | null = null;
    let lastSeen: string | null = null;
    let revision: number | null = null;
    for (const record of recordIds) {
      firstSeen = earliest(firstSeen, cleanText(record.first_seen_at));
      lastSeen = latest(lastSeen, cleanText(record.last_seen_at));
      if (typeof record.revision === 'number' && Number.isFinite(record.revision)) {
        revision = revision === null ? record.revision : Math.max(revision, record.revision);
      }
    }

    const suppliedAction = cleanText(representative.next_action);

    rows.push({
      id: root,
      surface: representative.surface,
      title: representative.title,
      priority,
      priority_reason: priority === null ? priorityReason : null,
      priority_conflict: priorityConflict,
      owner,
      owner_reason: namedOwner.reason,
      next_action: suppliedAction ?? nextActionFor(priority, owner.kind),
      state,
      unknown_reason: unknownReason,
      unknown_member_ids: [...new Set(unknownMemberIds)].sort(),
      /** Some members of this row are cleared, some are not. */
      cleared_partially: anyOpen && (clearedClearance !== null || partialClearance !== null),
      clearance: { by: clearance.by, at: clearance.at, evidence: clearance.evidence },
      coalesced_ids: memberIds,
      coalesced_count: memberIds.length,
      first_seen_at: firstSeen,
      last_seen_at: lastSeen,
      revision,
    });
  }

  rows.sort(compareAlertRows);

  // Every record that did not become its own row is a fold: records folded
  // into a group (coalesced_count - 1) plus any repeated id we replaced.
  const absorbed = rows.reduce((sum, row) => sum + (row.coalesced_count - 1), 0);

  return {
    rows,
    folded: absorbed + duplicateIdFolds.length,
    orphans: orphans.sort(),
    cycles: cycles.sort(),
    excluded_malformed: excludedMalformed,
  };
}

function buildFingerprintKey(record: AlertInput | undefined): string | null {
  const fingerprint = cleanText(record?.fingerprint);
  if (!record || !fingerprint) return null;
  const severity = priorityFromSeverity(record.severity).priority ?? 'unknown';
  return `${record.surface}\u0000${severity}\u0000${fingerprint}`;
}

function compareAlertRows(a: AlertRow, b: AlertRow): number {
  const ap = a.priority ? PRIORITY_ORDER[a.priority] : 99;
  const bp = b.priority ? PRIORITY_ORDER[b.priority] : 99;
  if (ap !== bp) return ap - bp;
  const am = parseTime(a.last_seen_at);
  const bm = parseTime(b.last_seen_at);
  if (am !== null && bm !== null && am !== bm) return bm - am;
  if (am !== null && bm === null) return -1;
  if (am === null && bm !== null) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ─── Client workload (P0/P1 list, P2 digest, P3 monthly) ────────────────────

export interface WorkItem {
  id: string;
  surface: string;
  title: string;
  priority: Priority | null;
  owner: Owner;
  next_action: string;
  state: AlertState;
  unknown_reason: string | null;
  coalesced_count: number;
  last_seen_at: string | null;
}

export interface WorkloadRollup {
  count: number;
  by_surface: Record<string, number>;
  latest_at: string | null;
  owners: string[];
}

export interface WorkloadSection {
  kind: 'immediate' | 'digest' | 'monthly' | 'unknown';
  state: 'live' | 'unknown';
  reason: string | null;
  items: WorkItem[];
  /** Digest/monthly sections carry a roll-up instead of a per-item list. */
  rollup: WorkloadRollup | null;
}

export interface ClientWorkload {
  immediate: WorkloadSection;
  digest: WorkloadSection;
  monthly: WorkloadSection;
  unknown: WorkloadSection;
  totals: {
    open: number;
    cleared: number;
    clearance_unknown: number;
    unclassified: number;
    duplicates_folded: number;
  };
}

function toWorkItem(row: AlertRow): WorkItem {
  return {
    id: row.id,
    surface: row.surface,
    title: row.title,
    priority: row.priority,
    owner: row.owner,
    next_action: row.next_action,
    state: row.state,
    unknown_reason: row.unknown_reason,
    coalesced_count: row.coalesced_count,
    last_seen_at: row.last_seen_at,
  };
}

function rollupOf(rows: readonly AlertRow[]): WorkloadRollup {
  const bySurface: Record<string, number> = {};
  const owners = new Set<string>();
  let latestAt: string | null = null;
  for (const row of rows) {
    bySurface[row.surface] = (bySurface[row.surface] ?? 0) + 1;
    if (row.owner.name) owners.add(row.owner.name);
    latestAt = latest(latestAt, row.last_seen_at);
  }
  return {
    count: rows.length,
    by_surface: bySurface,
    latest_at: latestAt,
    owners: [...owners].sort(),
  };
}

/**
 * A workload the client can actually work: P0/P1 arrive as individual items,
 * P2 collapses into one digest line, P3 into one monthly line. Unclassifiable
 * rows are listed individually in the `unknown` section — they are never
 * blended into a roll-up where nobody would see them.
 */
export function buildClientWorkload(rows: readonly AlertRow[], duplicatesFolded = 0): ClientWorkload {
  const open = rows.filter((row) => row.state !== 'cleared');
  const immediateRows = open.filter((row) => row.priority === 'P0' || row.priority === 'P1');
  const digestRows = open.filter((row) => row.priority === 'P2');
  const monthlyRows = open.filter((row) => row.priority === 'P3');
  const unknownRows = open.filter((row) => row.priority === null);

  return {
    immediate: {
      kind: 'immediate',
      state: 'live',
      reason: null,
      items: immediateRows.map(toWorkItem),
      rollup: null,
    },
    digest: {
      kind: 'digest',
      state: 'live',
      reason: null,
      items: [],
      rollup: rollupOf(digestRows),
    },
    monthly: {
      kind: 'monthly',
      state: 'live',
      reason: null,
      items: [],
      rollup: rollupOf(monthlyRows),
    },
    unknown: {
      kind: 'unknown',
      state: 'live',
      reason: null,
      items: unknownRows.map(toWorkItem),
      rollup: null,
    },
    totals: {
      open: open.length,
      cleared: rows.length - open.length,
      clearance_unknown: rows.filter((row) => row.state === 'clearance_unknown').length,
      unclassified: unknownRows.length,
      duplicates_folded: duplicatesFolded,
    },
  };
}

// ─── Snapshot versioning (stale event / command) ────────────────────────────

export interface SurfaceSnapshot<T> {
  /** Monotonic cursor. Missing or non-finite is UNPROVEN, never current. */
  revision: number;
  generated_at?: string | null;
  items: readonly T[];
}

export type SnapshotOutcome =
  | 'applied'
  | 'stale_ignored'
  | 'revision_gap'
  | 'revision_conflict'
  | 'unproven';

export interface SnapshotDecision<T> {
  outcome: SnapshotOutcome;
  state: 'live' | 'unknown';
  reason: string | null;
  /** The snapshot the view should now render (previous one on any refusal). */
  snapshot: SurfaceSnapshot<T> | null;
}

function snapshotItemsKey<T>(items: readonly T[]): string {
  try {
    return JSON.stringify(items);
  } catch {
    return '<unserialisable>';
  }
}

/**
 * C-F13 — a snapshot is only applied when it is the exact next revision.
 *   equal revision + same items → replay of what we already show (no-op);
 *   equal revision + different items → CONFLICT (two writers, one cursor);
 *   lower revision → STALE, ignored, previous view stays;
 *   a gap → the authoritative snapshot must be reloaded; we refuse to render
 *   the partial delta as if it were complete.
 */
export function applySurfaceSnapshot<T>(
  previous: SurfaceSnapshot<T> | null,
  incoming: SurfaceSnapshot<T>,
): SnapshotDecision<T> {
  const revision = incoming?.revision;
  if (typeof revision !== 'number' || !Number.isFinite(revision)) {
    return { outcome: 'unproven', state: 'unknown', reason: 'revision_missing', snapshot: previous };
  }
  if (!previous) {
    return { outcome: 'applied', state: 'live', reason: null, snapshot: incoming };
  }

  const held = previous.revision;
  if (revision === held) {
    if (snapshotItemsKey(previous.items) === snapshotItemsKey(incoming.items)) {
      return {
        outcome: 'stale_ignored',
        state: 'live',
        reason: `stale_revision_replayed:${revision}`,
        snapshot: previous,
      };
    }
    return {
      outcome: 'revision_conflict',
      state: 'unknown',
      reason: `revision_conflict:${revision}`,
      snapshot: previous,
    };
  }
  if (revision < held) {
    return {
      outcome: 'stale_ignored',
      state: 'live',
      reason: `stale_revision:${revision}_behind_${held}`,
      snapshot: previous,
    };
  }
  if (revision > held + 1) {
    return {
      outcome: 'revision_gap',
      state: 'unknown',
      reason: `revision_gap:${held}_to_${revision}_reload_required`,
      snapshot: previous,
    };
  }
  return { outcome: 'applied', state: 'live', reason: null, snapshot: incoming };
}

export interface ClearanceCommand {
  item_id: string;
  actor?: string | null;
  expected_revision?: number | null;
  evidence?: string | null;
}

export interface CommandDecision {
  accepted: boolean;
  reason: string | null;
}

/**
 * Authorize (never perform) a clearance command. The row is bound to the
 * revision the client was shown: a command against a newer row is refused
 * rather than silently clearing a state the client never saw.
 */
export function authorizeClearanceCommand(
  row: AlertRow | null | undefined,
  command: ClearanceCommand,
): CommandDecision {
  if (!row || row.id !== command.item_id) {
    return { accepted: false, reason: 'item_not_found' };
  }
  if (row.state === 'cleared') {
    return { accepted: false, reason: 'already_cleared' };
  }
  if (!cleanText(command.actor)) {
    return { accepted: false, reason: 'actor_required' };
  }
  if (!cleanText(command.evidence)) {
    return { accepted: false, reason: 'evidence_required' };
  }
  if (typeof command.expected_revision !== 'number' || !Number.isFinite(command.expected_revision)) {
    return { accepted: false, reason: 'expected_revision_required' };
  }
  if (row.revision !== command.expected_revision) {
    return {
      accepted: false,
      reason: `revision_conflict:${command.expected_revision}_!=_${row.revision ?? 'unknown'}`,
    };
  }
  return { accepted: true, reason: null };
}

// ─── Bookings ───────────────────────────────────────────────────────────────

export type BookingStage = 'requested' | 'confirmed' | 'serviced' | 'outcome_recorded' | 'unknown';

export interface BookingOutcomeInput {
  kind: string;
  verified: boolean;
  evidence?: string | null;
}

export interface BookingInput {
  id: string;
  revision?: number | null;
  /** Raw adapter status. Unrecognised values are UNKNOWN, never guessed. */
  status: string;
  requested_at?: string | null;
  /** Proof the client's booking was confirmed (calendar receipt/confirmation id). */
  confirmation_receipt?: string | null;
  /** Proof the service actually happened. */
  service_receipt?: string | null;
  owner?: OwnerInput | null;
  outcome?: BookingOutcomeInput | null;
}

export interface BookingRow {
  id: string;
  stage: BookingStage;
  state: 'live' | 'unknown';
  reason: string | null;
  owner: Owner;
  requested_at: string | null;
  confirmation_receipt: string | null;
  service_receipt: string | null;
  revision: number | null;
  /** A booking is a booking. It is never counted as revenue. */
  counts_as_sale: false;
}

const BOOKING_STATUS_STAGE: Record<string, BookingStage> = {
  requested: 'requested',
  pending: 'requested',
  confirmed: 'confirmed',
  booked: 'confirmed',
  completed: 'serviced',
  serviced: 'serviced',
  attended: 'serviced',
  no_show: 'serviced',
  cancelled: 'serviced',
};

/**
 * Derive the furthest PROVEN stage. The adapter's claim is never enough on
 * its own: a "confirmed" status with no confirmation receipt is UNKNOWN, and
 * a "completed" status with no service receipt is UNKNOWN. The follow-through
 * is the receipt, not the label (R-18).
 */
export interface BookingProjection {
  rows: BookingRow[];
  unknown: number;
  /** Records unusable at all (bad id / null row). `null` = UNKNOWN, never 0. */
  excluded_malformed: number | null;
}

export function projectBookings(records: readonly BookingInput[]): BookingProjection {
  // A non-list is not a snapshot: report UNKNOWN rather than crash or render 0.
  if (!Array.isArray(records)) {
    return { rows: [], unknown: 0, excluded_malformed: null };
  }
  const rows: BookingRow[] = [];
  let excludedMalformed = 0;
  for (const record of records) {
    if (!record || typeof record.id !== 'string' || !record.id) {
      // Unusable, but never invisible: the volume is reported, not dropped.
      excludedMalformed += 1;
      continue;
    }
    const receipt = cleanText(record.confirmation_receipt);
    const serviceReceipt = cleanText(record.service_receipt);
    const rawStatus = typeof record.status === 'string' ? record.status.trim() : '';
    const claimed = BOOKING_STATUS_STAGE[rawStatus.toLowerCase()] ?? null;
    const owner = resolveOwner(record.owner).owner;

    let stage: BookingStage;
    let state: 'live' | 'unknown' = 'live';
    let reason: string | null = null;

    if (!rawStatus) {
      stage = 'unknown';
      state = 'unknown';
      reason = 'booking_status_missing';
    } else if (claimed === null) {
      stage = 'unknown';
      state = 'unknown';
      reason = `unrecognised_booking_status:${rawStatus}`;
    } else if (claimed === 'requested') {
      stage = 'requested';
    } else if (claimed === 'confirmed') {
      if (!receipt) {
        stage = 'unknown';
        state = 'unknown';
        reason = 'confirmation_unproven';
      } else {
        stage = 'confirmed';
      }
    } else {
      // The record claims service happened; require the service receipt.
      if (!serviceReceipt) {
        stage = receipt ? 'confirmed' : 'unknown';
        state = 'unknown';
        reason = 'service_unproven';
      } else {
        stage = 'serviced';
      }
    }

    if (stage === 'serviced' && record.outcome) {
      const evidence = cleanText(record.outcome.evidence);
      if (record.outcome.verified && evidence && cleanText(record.outcome.kind)) {
        stage = 'outcome_recorded';
      } else {
        state = 'unknown';
        reason = 'outcome_unproven';
      }
    }

    rows.push({
      id: record.id,
      stage,
      state,
      reason,
      owner,
      requested_at: cleanText(record.requested_at),
      confirmation_receipt: receipt,
      service_receipt: serviceReceipt,
      revision:
        typeof record.revision === 'number' && Number.isFinite(record.revision)
          ? record.revision
          : null,
      counts_as_sale: false,
    });
  }
  rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    rows,
    unknown: rows.filter((row) => row.state === 'unknown').length,
    excluded_malformed: excludedMalformed,
  };
}

// ─── Outcomes: independent counts, truthful attribution ─────────────────────

export const OUTCOME_KINDS = ['gift', 'contact', 'booking', 'sale'] as const;
export type OutcomeKind = (typeof OUTCOME_KINDS)[number];

export const ATTRIBUTION_BUCKETS = ['observed_keyword', 'unknown', 'multitouch'] as const;
export type AttributionBucketName = (typeof ATTRIBUTION_BUCKETS)[number];

export interface OutcomeRecord {
  id: string;
  /** Raw kind. An unrecognised kind is reported, never folded into a real one. */
  kind: string;
  verified: boolean;
  evidence?: string | null;
  attribution: string;
  revision?: number | null;
}

export interface CountBucket {
  state: 'live' | 'unknown';
  /** NULL means UNKNOWN. A real zero is 0, never null. */
  count: number | null;
  /** Records with no proven evidence — excluded from `count`, never dropped. */
  excluded_unproven: number;
  reason: string | null;
}

export interface OutcomeView {
  state: 'live' | 'unknown';
  reason: string | null;
  counts: Record<OutcomeKind, CountBucket>;
  attribution: {
    state: 'live' | 'unknown';
    reason: string | null;
    buckets: Record<AttributionBucketName, number | null>;
  };
  /** Records whose kind is not one of the four — counted here, never folded in. */
  excluded_unrecognised_kind: number | null;
  /** Records unusable at all (bad id / null row). `null` = UNKNOWN, never 0. */
  excluded_malformed: number | null;
  /** Counts are independent. Nothing here is summed into "revenue". */
  counts_independent: true;
}

function unknownCount(reason: string): CountBucket {
  return { state: 'unknown', count: null, excluded_unproven: 0, reason };
}

const OUTCOME_KIND_LIST: readonly OutcomeKind[] = OUTCOME_KINDS;

/** Everything unknown, with the adapter named as the missing proof. */
export function unknownOutcomeView(reason = 'no_outcome_adapter'): OutcomeView {
  const counts = {
    gift: unknownCount(reason),
    contact: unknownCount(reason),
    booking: unknownCount(reason),
    sale: unknownCount(reason),
  } as Record<OutcomeKind, CountBucket>;
  return {
    state: 'unknown',
    reason,
    counts,
    attribution: {
      state: 'unknown',
      reason,
      buckets: { observed_keyword: null, unknown: null, multitouch: null },
    },
    excluded_unrecognised_kind: null,
    excluded_malformed: null,
    counts_independent: true,
  };
}

/**
 * Count each outcome kind INDEPENDENTLY (R-20 / T-30): a booking is not a
 * sale, a contact is not a booking, and the three attribution states are
 * reported separately. `null` records mean the adapter is absent — every
 * count is UNKNOWN, never zero. An empty real snapshot is a proven zero.
 */
export function projectOutcomes(records: readonly OutcomeRecord[] | null): OutcomeView {
  if (records === null) return unknownOutcomeView();
  // A non-list is not a snapshot: report UNKNOWN rather than crash or render 0.
  if (!Array.isArray(records)) {
    return unknownOutcomeView(`outcomes_records_invalid_return:${typeof records}`);
  }

  const counts = {} as Record<OutcomeKind, CountBucket>;
  for (const kind of OUTCOME_KIND_LIST) {
    counts[kind] = {
      state: 'live',
      count: 0,
      excluded_unproven: 0,
      reason: null,
    };
  }
  let excludedUnrecognisedKind = 0;
  let excludedMalformed = 0;

  const attribution: Record<AttributionBucketName, number | null> = {
    observed_keyword: 0,
    unknown: 0,
    multitouch: 0,
  };

  for (const record of records) {
    if (!record || typeof record.id !== 'string' || !record.id) {
      // Unusable, but never invisible: the volume is reported, not dropped.
      excludedMalformed += 1;
      continue;
    }
    const attributionName = typeof record.attribution === 'string' ? record.attribution.trim() : '';
    const bucketName = (ATTRIBUTION_BUCKETS as readonly string[]).includes(attributionName)
      ? (attributionName as AttributionBucketName)
      : 'unknown';
    attribution[bucketName] = (attribution[bucketName] ?? 0) + 1;

    const kind = typeof record.kind === 'string' ? record.kind.trim() : '';
    const isKnownKind = (OUTCOME_KINDS as readonly string[]).includes(kind);
    if (!isKnownKind) {
      excludedUnrecognisedKind += 1;
      continue;
    }

    const target = counts[kind as OutcomeKind];
    const evidence = cleanText(record.evidence);
    if (!record.verified || !evidence) {
      target.excluded_unproven += 1;
      continue;
    }
    target.count = (target.count ?? 0) + 1;
  }

  return {
    state: 'live',
    reason: null,
    counts,
    attribution: { state: 'live', reason: null, buckets: attribution },
    excluded_unrecognised_kind: excludedUnrecognisedKind,
    excluded_malformed: excludedMalformed,
    counts_independent: true,
  };
}

// ─── Adapters ───────────────────────────────────────────────────────────────

/** A real data source. `load()` returning null means "not connected". */
export interface SourceAdapter<T> {
  name: string;
  load(): readonly T[] | null;
}

export interface SurfaceResult<T> {
  state: 'live' | 'unknown';
  reason: string | null;
  adapter: string | null;
  items: readonly T[];
}

/**
 * Run one adapter. A missing adapter, a null load, a throw and a load that
 * hands back anything other than a LIST are all UNKNOWN with a named reason —
 * an adapter failure never renders as an empty success, and never crashes the
 * view it feeds. An EMPTY array from a working adapter is a proven zero and
 * stays live.
 */
export function loadSurface<T>(
  adapter: SourceAdapter<T> | null | undefined,
  surface: string,
): SurfaceResult<T> {
  if (!adapter) {
    return { state: 'unknown', reason: `no_${surface}_adapter`, adapter: null, items: [] };
  }
  let loaded: readonly T[] | null;
  try {
    loaded = adapter.load();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      state: 'unknown',
      reason: `${surface}_adapter_failed:${message}`,
      adapter: adapter.name,
      items: [],
    };
  }
  if (loaded === null) {
    return {
      state: 'unknown',
      reason: `${surface}_adapter_unavailable`,
      adapter: adapter.name,
      items: [],
    };
  }
  if (!Array.isArray(loaded)) {
    // `undefined`, a string, an object … anything that is not a list. A string
    // would otherwise iterate as characters and render as a live 0-row success.
    return {
      state: 'unknown',
      reason: `${surface}_adapter_invalid_return:${typeof loaded}`,
      adapter: adapter.name,
      items: [],
    };
  }
  return { state: 'live', reason: null, adapter: adapter.name, items: loaded };
}

// ─── Whole view ─────────────────────────────────────────────────────────────

export interface ExceptionsOutcomesView {
  tenant: { slug: string | null; state: 'live' | 'unknown'; reason: string | null };
  failures: {
    state: 'live' | 'unknown';
    reason: string | null;
    adapter: string | null;
    rows: AlertRow[];
    folded: number;
    orphans: string[];
    cycles: string[];
    /** `null` when the surface is UNKNOWN — unknown is never a zero. */
    excluded_malformed: number | null;
    workload: ClientWorkload;
  };
  bookings: {
    state: 'live' | 'unknown';
    reason: string | null;
    adapter: string | null;
    rows: BookingRow[];
    unknown: number;
    /** `null` when the surface is UNKNOWN — unknown is never a zero. */
    excluded_malformed: number | null;
  };
  outcomes: OutcomeView;
}

export interface BuildViewInput {
  tenantSlug: string | null | undefined;
  failures: SurfaceResult<AlertInput> | SourceAdapter<AlertInput> | null | undefined;
  bookings: SurfaceResult<BookingInput> | SourceAdapter<BookingInput> | null | undefined;
  outcomes: SurfaceResult<OutcomeRecord> | SourceAdapter<OutcomeRecord> | readonly OutcomeRecord[] | null | undefined;
}

function resolveSurface<T>(
  input: SurfaceResult<T> | SourceAdapter<T> | null | undefined,
  surface: string,
): SurfaceResult<T> {
  if (input === null || input === undefined) return loadSurface<T>(null, surface);
  if (typeof (input as SourceAdapter<T>).load === 'function') {
    return loadSurface<T>(input as SourceAdapter<T>, surface);
  }
  const result = input as SurfaceResult<T>;
  // A pre-built result carries the same contract as an adapter: its payload is
  // a LIST. Anything else is UNKNOWN, never a live 0-row success.
  if (!Array.isArray(result?.items)) {
    return {
      state: 'unknown',
      reason: `${surface}_adapter_invalid_return:${typeof result?.items}`,
      adapter: result?.adapter ?? null,
      items: [],
    };
  }
  return result;
}

function resolveOutcomes(
  input: BuildViewInput['outcomes'],
): OutcomeView {
  if (input === null || input === undefined) return unknownOutcomeView();
  if (Array.isArray(input)) return projectOutcomes(input as readonly OutcomeRecord[]);
  if (typeof (input as SourceAdapter<OutcomeRecord>).load === 'function') {
    const loaded = loadSurface<OutcomeRecord>(input as SourceAdapter<OutcomeRecord>, 'outcomes');
    if (loaded.state === 'unknown') return unknownOutcomeView(loaded.reason ?? 'outcomes_unknown');
    return projectOutcomes(loaded.items);
  }
  const result = input as SurfaceResult<OutcomeRecord>;
  if (result.state === 'unknown') return unknownOutcomeView(result.reason ?? 'outcomes_unknown');
  return projectOutcomes(result.items);
}

/** Assemble the three surfaces a client actually works from. */
export function buildExceptionsOutcomesView(input: BuildViewInput): ExceptionsOutcomesView {
  const tenantSlug = cleanText(input.tenantSlug);
  const failuresSurface = resolveSurface<AlertInput>(input.failures, 'failures');
  const projection = projectAlerts(failuresSurface.items);
  const workload = buildClientWorkload(projection.rows, projection.folded);

  const bookingsSurface = resolveSurface<BookingInput>(input.bookings, 'bookings');
  const bookingProjection = projectBookings(bookingsSurface.items);

  if (failuresSurface.state === 'unknown') {
    workload.immediate = { ...workload.immediate, state: 'unknown', reason: failuresSurface.reason };
    workload.digest = { ...workload.digest, state: 'unknown', reason: failuresSurface.reason, rollup: null };
    workload.monthly = { ...workload.monthly, state: 'unknown', reason: failuresSurface.reason, rollup: null };
    workload.unknown = { ...workload.unknown, state: 'unknown', reason: failuresSurface.reason };
  }

  return {
    tenant: {
      slug: tenantSlug,
      state: tenantSlug ? 'live' : 'unknown',
      reason: tenantSlug ? null : 'tenant_required',
    },
    failures: {
      state: failuresSurface.state,
      reason: failuresSurface.reason,
      adapter: failuresSurface.adapter,
      rows: projection.rows,
      folded: projection.folded,
      orphans: projection.orphans,
      cycles: projection.cycles,
      excluded_malformed:
        failuresSurface.state === 'unknown' ? null : projection.excluded_malformed,
      workload,
    },
    bookings: {
      state: bookingsSurface.state,
      reason: bookingsSurface.reason,
      adapter: bookingsSurface.adapter,
      rows: bookingProjection.rows,
      unknown: bookingProjection.unknown,
      excluded_malformed:
        bookingsSurface.state === 'unknown' ? null : bookingProjection.excluded_malformed,
    },
    outcomes: resolveOutcomes(input.outcomes),
  };
}
