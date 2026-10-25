/**
 * PBB-128 / T-32 — Command Center campaign, approval and publication contract.
 *
 * WHAT THIS IS
 * ------------
 * The campaign view used to be a list of task rows with a status pill: it could
 * not tell "scheduled and approved" from "scheduled and nobody approved it",
 * and it could not tell "published" from "the publish request was admitted".
 * This module is the PURE read-model + command decision for the campaign
 * calendar. It never talks to a provider, a dispatcher or a queue:
 *
 *   • CALENDAR — one cell per real `tasks.due_date` under the campaign. Every
 *     cell carries its own evidence pointer (task id + due date + newest
 *     `task_events` row) or an explicit UNKNOWN with a reason.
 *   • APPROVAL — a placement is APPROVED only when a real applied
 *     `approve_campaign` receipt covers THIS placement's current fingerprint
 *     AND every manifest field the contract requires has a real source. A
 *     field the repository cannot prove (no account binding column, no CTA
 *     column, no keyword column — T-23/T-24 are not merged) makes the whole
 *     placement UNKNOWN with the field named. Never APPROVED by default.
 *   • MUTATION — a placement whose fingerprint changed after approval is
 *     INVALIDATED, that placement ONLY (DATA-CONTRACTS §10). Siblings keep
 *     their approval.
 *   • RECEIPTS — publication truth comes from real `publish_queue` rows.
 *     HTTP admission / a running row is NEVER "published"; a task completion
 *     without provider readback is BEHIND. No row at all is UNKNOWN.
 *   • COMMANDS — targeted approve/hold only, with an expected-revision CAS and
 *     a tenant check. Every other cc-command action (`retry_failed_step`,
 *     `handoff`, `pause_surface`, ...) is refused from this view: this surface
 *     has NO send, enqueue or dispatch path, so it cannot become a direct
 *     bypass around the publish gate.
 *
 * STALE (C-F13) — two silent failure modes are made loud:
 *   • a placement whose newest lifecycle event is older than the window while
 *     the card is still in flight → `stale` / `event_stream_stalled`;
 *   • a command receipt the target revision has moved past → `stale` /
 *     `superseded_revision`. Neither ever renders as success.
 *
 * The DB-facing half lives in `approval-store.ts`; this file is pure so every
 * clause above is unit-testable without a database.
 */
import { createHash } from 'node:crypto';
import { parseEventTime, type LifecycleEventRow } from '@/lib/board/lifecycle-projection';

export type { LifecycleEventRow };

// ─── Vocabulary ─────────────────────────────────────────────────────────────

/** `schemas/cc-command.schema.json` — the full audited command vocabulary. */
export const CC_COMMAND_ACTIONS = [
  'approve_campaign',
  'hold_placement',
  'pause_surface',
  'resume_surface',
  'retry_failed_step',
  'handoff',
  'release_handoff',
] as const;
export type CcCommandAction = (typeof CC_COMMAND_ACTIONS)[number];

export const CC_TARGET_TYPES = [
  'campaign',
  'placement',
  'tenant_surface',
  'action',
  'fulfillment',
  'conversation',
] as const;
export type CcTargetType = (typeof CC_TARGET_TYPES)[number];

/**
 * The ONLY actions this view may apply. Everything else is refused with
 * `action_not_available_in_view` — a campaign calendar is not a dispatch door.
 */
export const VIEW_COMMAND_ACTIONS: readonly CcCommandAction[] = ['approve_campaign', 'hold_placement'];

/** Required manifest fields (DATA-CONTRACTS §10) with their real CC source. */
export interface ManifestFieldSource {
  field: string;
  /** Where the value would come from, or null when CC has no such column yet. */
  source: string | null;
}

export const MANIFEST_FIELD_SOURCES: readonly ManifestFieldSource[] = [
  { field: 'campaign_cycle_id', source: 'campaign.id' },
  { field: 'placement_id', source: 'tasks.id' },
  { field: 'scheduled_at', source: 'tasks.due_date' },
  { field: 'content_revision', source: 'sha256(tasks.title+description+updated_at)' },
  { field: 'channel', source: 'publish_queue.platforms' },
  { field: 'account_id', source: null },
  { field: 'account_binding_revision', source: null },
  { field: 'cta_text', source: null },
  { field: 'keyword', source: null },
  { field: 'promised_item_version', source: null },
  { field: 'conversation_policy_version', source: null },
];

/**
 * Placement approval states. UNKNOWN is a first-class, never-success state.
 *
 * No 'REVOKED': nothing in this repo produces it — the reachable set is
 * exactly APPROVED | DRAFT | HELD | INVALIDATED | UNKNOWN, proven in
 * tests/unit/pbb285-t32-dead-state-class.test.ts. A member no input can reach
 * is a permanently false promise in this public type (same class as the
 * 'APPROVED' summary state removed earlier), so it is gone rather than
 * documented. Reintroduce it only with a producer and a test that reaches it.
 */
export type PlacementApprovalState =
  | 'APPROVED'
  | 'HELD'
  | 'DRAFT'
  | 'INVALIDATED'
  | 'UNKNOWN';

/**
 * Publication receipt vocabulary — the claim-gate row tokens.
 * No 'UNREACHABLE': classifyPublication() only ever returns
 * CURRENT | BEHIND | UNKNOWN (an unreachable provider is an absent or
 * unrecognized receipt, which is UNKNOWN), and the board must not carry a
 * style row for a state it can never render.
 */
export type PublicationState = 'CURRENT' | 'BEHIND' | 'UNKNOWN';

export type FreshnessState = 'live' | 'stale' | 'unknown';

export type CalendarCellState =
  | 'published'
  | 'scheduled'
  | 'held'
  | 'unapproved'
  | 'stale'
  | 'unknown';

// ─── Inputs ─────────────────────────────────────────────────────────────────

/** The `tasks` columns this projection needs (src/lib/db/schema.ts). */
export interface CampaignTaskSource {
  id: string;
  title: string;
  description?: string | null;
  status: string;
  due_date: string | null;
  updated_at?: string | null;
  campaign_id?: string | null;
}

/** The `publish_queue` columns this projection needs (migrations 026/135/136). */
export interface PublishQueueSource {
  id: string;
  task_id?: string | null;
  cc_task_id?: string | null;
  company_id?: string | null;
  platforms?: string | null;
  status: string;
  error?: string | null;
  attempt_count?: number | null;
  completed_at?: string | null;
  updated_at?: string | null;
}

/** One applied `campaign_command_receipts` row (see approval-store.ts). */
export interface CommandReceipt {
  command_id: string;
  company_id: string;
  campaign_id: string;
  action: string;
  target_type: string;
  target_id: string;
  expected_revision: number;
  applied_revision: number | null;
  state: 'applied' | 'refused';
  refusal_code: string | null;
  reason: string;
  payload_json: string | null;
  submitted_at: string;
  recorded_at: string;
}

export interface CampaignSource {
  id: string;
  name: string;
  company_id?: string | null;
  start_date?: string | null;
  target_date?: string | null;
}

export interface CampaignApprovalInput {
  campaign: CampaignSource;
  tasks: readonly CampaignTaskSource[];
  publishRows: readonly PublishQueueSource[];
  events: readonly LifecycleEventRow[];
  receipts: readonly CommandReceipt[];
  now?: number | string | Date;
  staleAfterMs?: number;
}

// ─── Outputs ────────────────────────────────────────────────────────────────

export interface PlacementView {
  placement_id: string;
  task_id: string;
  title: string;
  task_status: string;
  scheduled_at: string | null;
  date: string | null;
  /** Fingerprint of the REAL fields that exist — approval is bound to this. */
  fingerprint: string;
  approval_state: PlacementApprovalState;
  approval_reason: string;
  publication_state: PublicationState;
  publication_reason: string;
  publication_evidence: string | null;
  freshness: FreshnessState;
  freshness_reason: string | null;
  last_event_at: string | null;
  last_event_id: string | null;
  /** Manifest fields CC cannot prove for this placement (named, never guessed). */
  unknown_fields: string[];
  /** Fields that make approval itself impossible (date, channel). */
  approval_blockers: string[];
  /** True only when the placement's own calendar identity is proven. */
  approvable: boolean;
}

export interface CalendarDay {
  date: string;
  placements: string[];
  counts: Record<CalendarCellState, number>;
  has_unknown: boolean;
  has_stale: boolean;
}

export interface ReceiptView {
  command_id: string;
  action: string;
  target_type: string;
  target_id: string;
  state: 'applied' | 'refused';
  refusal_code: string | null;
  reason: string;
  applied_revision: number | null;
  recorded_at: string;
  /** 'stale' when the target revision has moved past this receipt. */
  freshness: 'live' | 'stale';
  freshness_reason: string | null;
}

export interface CampaignApprovalView {
  campaign_id: string;
  campaign_name: string;
  company_id: string | null;
  /** Current applied-command revision (0 = never commanded). */
  revision: number;
  approval_summary: {
    /**
     * NO 'APPROVED'. `MANIFEST_FIELD_SOURCES` has six fields with
     * `source: null` — account binding, CTA, keyword, promised item and
     * conversation policy versions — and CC has no table that can ever prove
     * them. `unprovenManifestFields()` therefore always returns a non-empty
     * set, so an 'APPROVED' roll-up was a value no input could reach: a
     * permanently false promise in this public type. The roll-up reports the
     * truth as PARTIAL and NAMES the unproven fields instead. Per-placement
     * approval is unaffected — a placement is APPROVED at its fingerprint.
     */
    state: 'PARTIAL' | 'UNKNOWN' | 'NONE';
    approved_at: string | null;
    approved_by: string | null;
    reason: string;
  };
  placements: PlacementView[];
  calendar: CalendarDay[];
  receipts: ReceiptView[];
  unknowns: string[];
}

// ─── Time ───────────────────────────────────────────────────────────────────

export const DEFAULT_CALENDAR_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/** Env override in hours. Malformed → default (never 0, never NaN). */
export function resolveCalendarStaleAfterMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CAMPAIGN_STALE_AFTER_HOURS;
  if (!raw) return DEFAULT_CALENDAR_STALE_AFTER_MS;
  const hours = Number.parseFloat(raw);
  if (!Number.isFinite(hours) || hours <= 0) return DEFAULT_CALENDAR_STALE_AFTER_MS;
  return hours * 60 * 60 * 1000;
}

function toMs(now: number | string | Date | undefined): number {
  if (now === undefined) return Date.now();
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number') return now;
  return parseEventTime(now) ?? Date.now();
}

/**
 * `tasks.due_date` is `YYYY-MM-DD` (or an ISO stamp) — the calendar day.
 *
 * The day must be a REAL calendar day. A regex alone accepts '2026-99-99' and
 * '2026-02-31', and a fabricated day that reaches the calendar is rendered,
 * approvable and APPROVED — which contradicts "a placement with no real date is
 * UNKNOWN". So the shape is matched first, then the day is round-tripped
 * through Date.UTC and rejected unless it survives unchanged. Anything after
 * the day must be an ISO datetime separator (`T` or a space) and must itself
 * parse, so a junk suffix never smuggles a date out.
 */
export function calendarDate(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})(.*)$/.exec(trimmed);
  if (!match) return null;
  const [, yearText, monthText, dayText, rest] = match;
  // A trailing datetime is fine only when it IS a datetime.
  if (rest !== '' && rest[0] !== 'T' && rest[0] !== ' ') return null;
  if (rest !== '' && parseEventTime(trimmed) === null) return null;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // setUTCFullYear (not Date.UTC) so a year under 100 is not folded into 19xx.
  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day);
  probe.setUTCHours(0, 0, 0, 0);
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return null; // rolled over: 2026-02-31, 2026-13-45, 2026-02-29 in a non-leap year
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}

// ─── Fingerprint ────────────────────────────────────────────────────────────

/**
 * The immutable identity approval is bound to. Only REAL fields participate —
 * a field CC cannot read is named in `unknown_fields`, never hashed as ''.
 */
export function placementFingerprint(task: CampaignTaskSource, channel: string | null): string {
  const canonical = JSON.stringify({
    placement_id: task.id,
    task_id: task.id,
    scheduled_at: calendarDate(task.due_date) ?? task.due_date ?? null,
    content_revision: contentRevision(task),
    channel: channel ? channel.trim().toLowerCase() : null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** Content identity from the real content columns (never from status). */
export function contentRevision(task: CampaignTaskSource): string {
  const canonical = JSON.stringify({
    title: (task.title ?? '').trim(),
    description: (task.description ?? '').trim(),
    updated_at: task.updated_at ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Which required manifest fields have no real CC source for this placement.
 * These are reported, never hashed as '' and never treated as approved.
 */
export function unprovenManifestFields(channel: string | null): string[] {
  const unproven: string[] = [];
  for (const entry of MANIFEST_FIELD_SOURCES) {
    if (entry.source === null && !unproven.includes(entry.field)) unproven.push(entry.field);
  }
  if (!channel || !channel.trim()) unproven.push('channel');
  return unproven;
}

/**
 * Fields WITHOUT which this view cannot approve even a calendar-scoped
 * placement: the date and the channel are the placement's identity. Missing
 * them is UNKNOWN, not "approved anyway".
 */
export function approvalBlockers(task: CampaignTaskSource, channel: string | null): string[] {
  const blockers: string[] = [];
  if (!calendarDate(task.due_date)) blockers.push('scheduled_at');
  if (!channel || !channel.trim()) blockers.push('channel');
  return blockers;
}

// ─── Publication receipts ───────────────────────────────────────────────────

/**
 * A completion stamp counts as DATED only when the day is a real calendar day
 * AND the stamp parses. `parseEventTime` alone is not enough: it reads `'0'` as
 * year 2000 and rolls `'2026-02-31'` forward to March, so a bogus stamp would
 * still earn a provider completion receipt.
 */
function parseCompletionStamp(value: string): number | null {
  const trimmed = value.trim();
  if (calendarDate(trimmed) === null) return null;
  return parseEventTime(trimmed);
}

/**
 * Map ONE real publish_queue row onto the receipt vocabulary. Fail-closed:
 * a row that is not PROVEN complete is never CURRENT. A `running` row is
 * exactly the D-13 trap (request admitted, reply not completed) — UNKNOWN.
 */
export function classifyPublication(row: PublishQueueSource | null | undefined): {
  state: PublicationState;
  reason: string;
  evidence: string | null;
} {
  if (!row) {
    return { state: 'UNKNOWN', reason: 'no_publication_receipt', evidence: null };
  }
  const status = (row.status || '').trim().toLowerCase();
  const rawCompleted = typeof row.completed_at === 'string' ? row.completed_at : null;
  const hasCompletedText = rawCompleted !== null && rawCompleted.trim().length > 0;
  // "Dated" means it parses as a real timestamp. A non-empty string is not a
  // date: 'not-a-date' and 'yesterday' used to earn CURRENT / provider_completion_receipt,
  // contradicting "only a dated completion is CURRENT".
  const completedAt = hasCompletedText ? parseCompletionStamp(rawCompleted) : null;

  if (status === 'published' || status === 'completed') {
    if (!hasCompletedText) {
      return {
        state: 'UNKNOWN',
        reason: 'completion_status_without_completed_at',
        evidence: `publish_queue:${row.id}`,
      };
    }
    if (completedAt === null) {
      return {
        state: 'UNKNOWN',
        reason: 'completion_timestamp_unparseable',
        evidence: `publish_queue:${row.id}@${rawCompleted}`,
      };
    }
    return {
      state: 'CURRENT',
      reason: 'provider_completion_receipt',
      evidence: `publish_queue:${row.id}@${rawCompleted}`,
    };
  }
  if (status === 'verification_required') {
    return {
      state: 'BEHIND',
      reason: 'task_complete_without_provider_readback',
      evidence: `publish_queue:${row.id}`,
    };
  }
  if (status === 'failed') {
    return {
      state: 'BEHIND',
      reason: `publish_failed:${(row.error || 'unknown_error').slice(0, 160)}`,
      evidence: `publish_queue:${row.id}`,
    };
  }
  if (status === 'queued' || status === 'retrying' || status === 'overdue') {
    return {
      state: 'BEHIND',
      reason: `not_published_status:${status}`,
      evidence: `publish_queue:${row.id}`,
    };
  }
  if (status === 'running') {
    // A dispatched/admitted request is NOT a completed reply (D-13).
    return {
      state: 'UNKNOWN',
      reason: 'admission_only_not_completion',
      evidence: `publish_queue:${row.id}`,
    };
  }
  return {
    state: 'UNKNOWN',
    reason: `unrecognized_publish_status:${status || 'empty'}`,
    evidence: `publish_queue:${row.id}`,
  };
}

/**
 * Newest publish row per task (a retried intent can leave several).
 *
 * The ordering is a TOTAL order, so the winner is independent of the order the
 * rows arrive in. The old fold let an unparseable `updated_at` outrank a real
 * one whenever the real row was seen first, so the same data set answered
 * BEHIND in one order and CURRENT in the other.
 */
export function newestPublishRow(
  rows: readonly PublishQueueSource[],
  taskId: string,
): PublishQueueSource | null {
  let best: PublishQueueSource | null = null;
  for (const row of rows) {
    if (row.task_id !== taskId && row.cc_task_id !== taskId) continue;
    if (!best || comparePublishRecency(row, best) > 0) best = row;
  }
  return best;
}

/** -1 / 0 / 1. Strict, antisymmetric, transitive — never order-dependent. */
function comparePublishRecency(next: PublishQueueSource, held: PublishQueueSource): number {
  const nextMs = parseEventTime(next.updated_at);
  const heldMs = parseEventTime(held.updated_at);
  if (nextMs !== null && heldMs !== null && nextMs !== heldMs) return nextMs > heldMs ? 1 : -1;
  // A row whose stamp parses always outranks one whose stamp is garbage: the
  // malformed row says nothing about when it happened, so it cannot be newest.
  if (nextMs !== null && heldMs === null) return 1;
  if (nextMs === null && heldMs !== null) return -1;
  // Same recency, or both unparseable: deterministic tie-break on id.
  return next.id === held.id ? 0 : next.id > held.id ? 1 : -1;
}

// ─── Approval receipts ──────────────────────────────────────────────────────

export interface ApprovedPlacement {
  placement_id: string;
  fingerprint: string;
}

/** The latest applied approve_campaign receipt (the standing approval). */
export function latestApprovalReceipt(receipts: readonly CommandReceipt[]): CommandReceipt | null {
  let best: CommandReceipt | null = null;
  for (const receipt of receipts) {
    if (receipt.state !== 'applied' || receipt.action !== 'approve_campaign') continue;
    if (!best) {
      best = receipt;
      continue;
    }
    const next = parseEventTime(receipt.recorded_at);
    const held = parseEventTime(best.recorded_at);
    if (next !== null && held !== null && next !== held) {
      if (next > held) best = receipt;
      continue;
    }
    if (next !== null && held === null) best = receipt;
    else if (next === null && held !== null) continue;
    else if ((receipt.applied_revision ?? -1) > (best.applied_revision ?? -1)) best = receipt;
  }
  return best;
}

/** Parse the placements an approve receipt locked in. Malformed → unknown. */
export function approvedPlacementsOf(receipt: CommandReceipt | null): ApprovedPlacement[] | null {
  if (!receipt?.payload_json) return null;
  try {
    const parsed = JSON.parse(receipt.payload_json) as { placements?: unknown };
    if (!Array.isArray(parsed.placements)) return null;
    const out: ApprovedPlacement[] = [];
    for (const entry of parsed.placements) {
      if (!entry || typeof entry !== 'object') return null;
      const row = entry as { placement_id?: unknown; fingerprint?: unknown };
      if (typeof row.placement_id !== 'string' || typeof row.fingerprint !== 'string') return null;
      out.push({ placement_id: row.placement_id, fingerprint: row.fingerprint });
    }
    return out;
  } catch {
    return null;
  }
}

/** The latest applied hold_placement receipt per placement id. */
export function heldPlacementIds(receipts: readonly CommandReceipt[]): Set<string> {
  const held = new Set<string>();
  for (const receipt of receipts) {
    if (receipt.state !== 'applied' || receipt.action !== 'hold_placement') continue;
    if (receipt.target_type !== 'placement') continue;
    held.add(receipt.target_id);
  }
  return held;
}

/** Current revision = number of applied commands for the campaign. */
export function currentRevision(receipts: readonly CommandReceipt[]): number {
  return receipts.filter((receipt) => receipt.state === 'applied').length;
}

// ─── Projection ─────────────────────────────────────────────────────────────

function receiptFreshness(receipt: CommandReceipt, revision: number): ReceiptView {
  const applied = receipt.applied_revision;
  const stale = receipt.state === 'applied' && applied !== null && applied < revision;
  return {
    command_id: receipt.command_id,
    action: receipt.action,
    target_type: receipt.target_type,
    target_id: receipt.target_id,
    state: receipt.state,
    refusal_code: receipt.refusal_code,
    reason: receipt.reason,
    applied_revision: applied,
    recorded_at: receipt.recorded_at,
    freshness: stale ? 'stale' : 'live',
    freshness_reason: stale ? 'superseded_revision' : null,
  };
}

function newestEventFor(events: readonly LifecycleEventRow[], taskId: string): LifecycleEventRow | null {
  let best: LifecycleEventRow | null = null;
  for (const event of events) {
    if (event.task_id !== taskId) continue;
    if (!best) {
      best = event;
      continue;
    }
    const next = parseEventTime(event.created_at);
    const held = parseEventTime(best.created_at);
    if (next !== null && held !== null && next !== held) {
      if (next > held) best = event;
      continue;
    }
    if (next !== null && held === null) best = event;
    else if (next === null && held !== null) continue;
    else if (event.id > best.id) best = event;
  }
  return best;
}

const TERMINAL_STATUSES = new Set(['done']);

function emptyCounts(): Record<CalendarCellState, number> {
  return { published: 0, scheduled: 0, held: 0, unapproved: 0, stale: 0, unknown: 0 };
}

/**
 * Build the whole view. Pure: every input is passed in, so the projection is
 * deterministic under test (supply `now`).
 */
export function buildCampaignApprovalView(input: CampaignApprovalInput): CampaignApprovalView {
  const nowMs = toMs(input.now);
  const staleAfterMs =
    typeof input.staleAfterMs === 'number' && Number.isFinite(input.staleAfterMs)
      ? input.staleAfterMs
      : DEFAULT_CALENDAR_STALE_AFTER_MS;

  const revision = currentRevision(input.receipts);
  const approvalReceipt = latestApprovalReceipt(input.receipts);
  const approvedList = approvedPlacementsOf(approvalReceipt);
  const approvedByPlacement = new Map<string, string>();
  for (const entry of approvedList ?? []) approvedByPlacement.set(entry.placement_id, entry.fingerprint);
  const held = heldPlacementIds(input.receipts);
  const unknowns: string[] = [];

  if (!approvalReceipt) unknowns.push('no_applied_approval_receipt');
  else if (approvedList === null) unknowns.push('approval_receipt_payload_unreadable');

  const placements: PlacementView[] = [];
  const sortedTasks = [...input.tasks].sort((a, b) => {
    const da = calendarDate(a.due_date) ?? '9999-99-99';
    const db = calendarDate(b.due_date) ?? '9999-99-99';
    if (da !== db) return da < db ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  for (const task of sortedTasks) {
    const publishRow = newestPublishRow(input.publishRows, task.id);
    const channel = publishRow?.platforms ?? null;
    const unknownFields = unprovenManifestFields(channel);
    const blockers = approvalBlockers(task, channel);
    const fingerprint = placementFingerprint(task, channel);
    const lastEvent = newestEventFor(input.events, task.id);
    const date = calendarDate(task.due_date);

    // ── approval state ──
    let approvalState: PlacementApprovalState;
    let approvalReason: string;
    const approvedFingerprint = approvedByPlacement.get(task.id);
    if (held.has(task.id)) {
      approvalState = 'HELD';
      approvalReason = 'targeted_hold_applied';
    } else if (blockers.length > 0) {
      approvalState = 'UNKNOWN';
      approvalReason = `approval_prerequisites_missing:${blockers.join(',')}`;
    } else if (!approvalReceipt) {
      approvalState = 'DRAFT';
      approvalReason = 'no_approval_receipt';
    } else if (approvedFingerprint === undefined) {
      approvalState = 'DRAFT';
      approvalReason = 'not_in_approved_manifest';
    } else if (approvedFingerprint !== fingerprint) {
      approvalState = 'INVALIDATED';
      approvalReason = 'placement_changed_since_approval';
    } else {
      approvalState = 'APPROVED';
      approvalReason = `approved_by:${approvalReceipt.command_id}`;
    }

    // ── publication receipt ──
    const publication = classifyPublication(publishRow);

    // ── freshness (C-F13) ──
    // Freshness answers ONE question: is the lifecycle event stream still
    // moving? It must never contradict its own reason, so a missing schedule is
    // NOT folded in here — that fact lives on `date` and in
    // `approval_blockers: ['scheduled_at']`. The old `date === null → unknown`
    // overwrote a real STALE verdict while keeping its
    // 'event_stream_stalled' reason: the state and its own reason disagreed and
    // the STALE signal C-F13 exists to surface was masked.
    let freshness: FreshnessState = 'live';
    let freshnessReason: string | null = null;
    if (!lastEvent) {
      freshness = 'unknown';
      freshnessReason = 'no_lifecycle_event';
    } else if (!TERMINAL_STATUSES.has(task.status)) {
      const lastMs = parseEventTime(lastEvent.created_at);
      if (lastMs !== null && nowMs - lastMs > staleAfterMs) {
        freshness = 'stale';
        freshnessReason = 'event_stream_stalled';
      }
    }

    placements.push({
      placement_id: task.id,
      task_id: task.id,
      title: task.title,
      task_status: task.status,
      scheduled_at: task.due_date ?? null,
      date,
      fingerprint,
      approval_state: approvalState,
      approval_reason: approvalReason,
      publication_state: publication.state,
      publication_reason: publication.reason,
      publication_evidence: publication.evidence,
      freshness,
      freshness_reason: freshnessReason,
      last_event_at: lastEvent?.created_at ?? null,
      last_event_id: lastEvent?.id ?? null,
      unknown_fields: unknownFields,
      approval_blockers: blockers,
      approvable: blockers.length === 0,
    });
  }

  // ── calendar days ──
  const dayMap = new Map<string, CalendarDay>();
  for (const placement of placements) {
    if (!placement.date) continue;
    let day = dayMap.get(placement.date);
    if (!day) {
      day = { date: placement.date, placements: [], counts: emptyCounts(), has_unknown: false, has_stale: false };
      dayMap.set(placement.date, day);
    }
    day.placements.push(placement.placement_id);
    const cell = cellStateOf(placement);
    day.counts[cell] += 1;
    if (cell === 'unknown') day.has_unknown = true;
    if (cell === 'stale') day.has_stale = true;
  }
  const calendar = [...dayMap.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // ── summary ──
  let summaryState: CampaignApprovalView['approval_summary']['state'];
  let summaryReason: string;
  if (!approvalReceipt) {
    summaryState = 'NONE';
    summaryReason = 'no_applied_approval_receipt';
  } else if (approvedList === null) {
    summaryState = 'UNKNOWN';
    summaryReason = 'approval_receipt_payload_unreadable';
  } else {
    const approvedIds = new Set(approvedList.map((entry) => entry.placement_id));
    const invalidated = placements.filter(
      (placement) => placement.approval_state === 'INVALIDATED' || placement.approval_state === 'UNKNOWN',
    );
    const covered = placements.filter((placement) => approvedIds.has(placement.placement_id));
    const unproven = new Set<string>();
    for (const placement of placements) for (const field of placement.unknown_fields) unproven.add(field);
    if (placements.length === 0) {
      summaryState = 'UNKNOWN';
      summaryReason = 'campaign_has_no_placements';
    } else if (covered.length !== placements.length || invalidated.length > 0) {
      summaryState = 'PARTIAL';
      summaryReason = `placements_unapproved_or_invalidated:${placements.length - covered.length + invalidated.length}`;
    } else {
      // Every placement is approved at its current fingerprint, but manifest
      // fields this repo cannot prove (account binding, CTA, keyword, …) are
      // still UNKNOWN. The campaign is therefore NOT fully approved — and from
      // CC alone it never can be, because those fields have no source here (see
      // MANIFEST_FIELD_SOURCES). This is the terminal branch, not a stop on the
      // way to an 'APPROVED' that no input can reach; the fields are named
      // below and on every placement so nothing is hidden.
      summaryState = 'PARTIAL';
      summaryReason = `manifest_fields_unproven:${[...unproven].sort().join(',') || 'none'}`;
    }
  }

  const approvalBy = approvalReceipt ? approvedByOf(approvalReceipt) : null;

  return {
    campaign_id: input.campaign.id,
    campaign_name: input.campaign.name,
    company_id: input.campaign.company_id ?? null,
    revision,
    approval_summary: {
      state: summaryState,
      approved_at: approvalBy?.approved_at ?? null,
      approved_by: approvalBy?.approved_by ?? null,
      reason: summaryReason,
    },
    placements,
    calendar,
    receipts: input.receipts.map((receipt) => receiptFreshness(receipt, revision)),
    unknowns,
  };
}

/** The calendar cell a placement lands in. Publication only with a receipt. */
export function cellStateOf(placement: PlacementView): CalendarCellState {
  // A dated provider completion receipt is the strongest evidence there is;
  // freshness still rides the row for the operator to see.
  if (placement.publication_state === 'CURRENT') return 'published';
  if (placement.freshness === 'stale') return 'stale';
  if (placement.freshness === 'unknown') return 'unknown';
  if (placement.approval_state === 'HELD') return 'held';
  if (placement.approval_state === 'APPROVED') return 'scheduled';
  if (placement.approval_state === 'UNKNOWN') return 'unknown';
  return 'unapproved';
}

function approvedByOf(receipt: CommandReceipt): { approved_by: string | null; approved_at: string | null } | null {
  if (!receipt.payload_json) return null;
  try {
    const parsed = JSON.parse(receipt.payload_json) as {
      approved_by?: unknown;
      approved_at?: unknown;
    };
    return {
      approved_by: typeof parsed.approved_by === 'string' ? parsed.approved_by : null,
      approved_at: typeof parsed.approved_at === 'string' ? parsed.approved_at : null,
    };
  } catch {
    return null;
  }
}

// ─── Commands ───────────────────────────────────────────────────────────────

export interface CampaignCommand {
  schema_version: 1;
  command_id: string;
  tenant_id: string;
  actor_id: string;
  action: CcCommandAction;
  target_type: CcTargetType;
  target_id: string;
  expected_revision: number;
  purpose: string;
  submitted_at: string;
}

export type CommandRejection =
  | 'malformed_command'
  | 'tenant_mismatch'
  | 'target_mismatch'
  | 'target_not_found'
  | 'action_not_available_in_view'
  | 'revision_conflict'
  | 'manifest_incomplete'
  | 'terminal_placement'
  | 'already_held';

/** Validate one raw command against schemas/cc-command.schema.json. */
export function validateCommand(raw: unknown): { ok: true; command: CampaignCommand } | { ok: false; code: CommandRejection; reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'malformed_command', reason: 'command must be an object' };
  }
  const record = raw as Record<string, unknown>;
  const allowed = new Set([
    'schema_version',
    'command_id',
    'tenant_id',
    'actor_id',
    'action',
    'target_type',
    'target_id',
    'expected_revision',
    'purpose',
    'submitted_at',
  ]);
  const extra = Object.keys(record).filter((key) => !allowed.has(key));
  if (extra.length > 0) {
    return { ok: false, code: 'malformed_command', reason: `unexpected fields: ${extra.join(',')}` };
  }
  if (record.schema_version !== 1) {
    return { ok: false, code: 'malformed_command', reason: 'schema_version must be 1' };
  }
  for (const field of ['command_id', 'tenant_id', 'actor_id', 'target_id', 'purpose', 'submitted_at'] as const) {
    const value = record[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      return { ok: false, code: 'malformed_command', reason: `${field} must be a non-empty string` };
    }
  }
  if (typeof record.action !== 'string' || !(CC_COMMAND_ACTIONS as readonly string[]).includes(record.action)) {
    return { ok: false, code: 'malformed_command', reason: 'action is not a known cc-command action' };
  }
  if (typeof record.target_type !== 'string' || !(CC_TARGET_TYPES as readonly string[]).includes(record.target_type)) {
    return { ok: false, code: 'malformed_command', reason: 'target_type is not a known cc-command target' };
  }
  if (
    typeof record.expected_revision !== 'number' ||
    !Number.isInteger(record.expected_revision) ||
    record.expected_revision < 0
  ) {
    return { ok: false, code: 'malformed_command', reason: 'expected_revision must be a non-negative integer' };
  }
  return { ok: true, command: record as unknown as CampaignCommand };
}

export type CommandEffect =
  | {
      kind: 'approve';
      payload: {
        scope: 'calendar_placement';
        approved_by: string;
        approved_at: string;
        campaign_cycle_id: string;
        placements: ApprovedPlacement[];
        unknown_fields: string[];
        manifest_sha256: string;
      };
    }
  | { kind: 'hold'; task_id: string };

export type CommandDecision =
  | { ok: true; effect: CommandEffect; applied_revision: number }
  | { ok: false; code: CommandRejection; reason: string; current_revision: number };

/**
 * Decide a validated command against the CURRENT campaign state.
 *
 * Deliberately synchronous + pure: the store re-checks the revision inside its
 * transaction, so a race cannot apply two commands at one revision.
 */
export function decideCommand(args: {
  command: CampaignCommand;
  companyId: string;
  campaign: CampaignSource;
  tasks: readonly CampaignTaskSource[];
  publishRows: readonly PublishQueueSource[];
  receipts: readonly CommandReceipt[];
  now?: string;
}): CommandDecision {
  const { command, companyId, campaign } = args;
  const revision = currentRevision(args.receipts);
  const at = args.now ?? new Date().toISOString();

  if (command.tenant_id !== companyId) {
    return { ok: false, code: 'tenant_mismatch', reason: 'command tenant does not match the verified company', current_revision: revision };
  }
  if (!VIEW_COMMAND_ACTIONS.includes(command.action)) {
    return {
      ok: false,
      code: 'action_not_available_in_view',
      reason: `action ${command.action} is not available from the campaign approval view (no send/dispatch path here)`,
      current_revision: revision,
    };
  }
  if (command.expected_revision !== revision) {
    return {
      ok: false,
      code: 'revision_conflict',
      reason: `expected revision ${command.expected_revision} but the campaign is at ${revision}`,
      current_revision: revision,
    };
  }

  if (command.action === 'approve_campaign') {
    if (command.target_type !== 'campaign' || command.target_id !== campaign.id) {
      return { ok: false, code: 'target_mismatch', reason: 'approve_campaign must target this campaign', current_revision: revision };
    }
    const placements: ApprovedPlacement[] = [];
    const incomplete: string[] = [];
    const unprovenAll = new Set<string>();
    for (const task of args.tasks) {
      const publishRow = newestPublishRow(args.publishRows, task.id);
      const channel = publishRow?.platforms ?? null;
      const blockers = approvalBlockers(task, channel);
      if (blockers.length > 0) {
        incomplete.push(`${task.id}:${blockers.join('+')}`);
        continue;
      }
      for (const field of unprovenManifestFields(channel)) unprovenAll.add(field);
      placements.push({ placement_id: task.id, fingerprint: placementFingerprint(task, channel) });
    }
    if (incomplete.length > 0) {
      return {
        ok: false,
        code: 'manifest_incomplete',
        reason: `ambiguous or unproven placement identity: ${incomplete.join('; ')}`,
        current_revision: revision,
      };
    }
    if (placements.length === 0) {
      return { ok: false, code: 'manifest_incomplete', reason: 'campaign has no placements to approve', current_revision: revision };
    }
    const manifest = {
      scope: 'calendar_placement' as const,
      approved_by: command.actor_id,
      approved_at: at,
      campaign_cycle_id: campaign.id,
      placements: [...placements].sort((a, b) => (a.placement_id < b.placement_id ? -1 : 1)),
      unknown_fields: [...unprovenAll].sort(),
      manifest_sha256: '',
    };
    manifest.manifest_sha256 = createHash('sha256')
      .update(JSON.stringify({ ...manifest, manifest_sha256: undefined }))
      .digest('hex');
    return { ok: true, effect: { kind: 'approve', payload: manifest }, applied_revision: revision + 1 };
  }

  // hold_placement — safety action, always available, never a send.
  if (command.target_type !== 'placement') {
    return { ok: false, code: 'target_mismatch', reason: 'hold_placement must target a placement', current_revision: revision };
  }
  const task = args.tasks.find((candidate) => candidate.id === command.target_id);
  if (!task) {
    return { ok: false, code: 'target_not_found', reason: 'placement is not part of this campaign', current_revision: revision };
  }
  if (TERMINAL_STATUSES.has(task.status)) {
    return {
      ok: false,
      code: 'terminal_placement',
      reason: 'placement is already terminal; there is nothing left to hold',
      current_revision: revision,
    };
  }
  if (heldPlacementIds(args.receipts).has(task.id) && task.status === 'blocked') {
    return { ok: false, code: 'already_held', reason: 'placement is already held', current_revision: revision };
  }
  return { ok: true, effect: { kind: 'hold', task_id: task.id }, applied_revision: revision + 1 };
}
