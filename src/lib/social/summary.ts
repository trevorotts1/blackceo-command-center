/**
 * src/lib/social/summary.ts — F30 client completion + exception summary.
 *
 * PROBLEM (F30): a generic "we are working" message conceals whether the
 * system is awaiting an answer, queued without a worker, producing assets or
 * waiting for GHL to publish. Clients need a truthful next action and
 * evidence.
 *
 * CONTRACT: every message is DERIVED FROM PERSISTED STATE ONLY:
 *   - publish_queue rows (F03 execution contract: status, retry_at,
 *     attempt_count, cc_task_id, error),
 *   - task state (status, block_reason/block_needs, dispatch attempts,
 *     task_events transition history = the last verified milestone),
 *   - social_cycles (F07/WF10 contract: response_state — awaiting theme,
 *     theme chosen, skipped; closed-cycle disposition),
 *   - social_delivery rows' provider_state via the delivery.json contract
 *     (draft/scheduled/published/failed/unknown, published_url,
 *     scheduled_at, failure_reason),
 *   - social_expiry_events (F35 ledger: which resource expired, recovery
 *     path, retry deadline).
 * NEVER an unsupported completion promise: a stage label is emitted only when
 * a persisted row proves it; "unknown" is stated as unknown with the check to
 * run. The owner is explicit: "system" (the engine acts next, with a retry
 * deadline) or "client" (the client must answer/approve/reconnect).
 *
 * CONSOLIDATED NOTIFICATIONS (no retry spam): notifyCompany() dedupes on
 * (company_id, resource, event-class) inside a cooldown window — the same
 * event re-firing only re-notifies after the dedupe window passes. Failed
 * delivery of a notification is VISIBLE (persisted row with the failure
 * reason) and retried on later calls for the same key, never silently
 * dropped; a per-key attempt cap stops infinite retry loops.
 *
 * MIGRATION NOTE (documented for WF00, no migration id consumed): the
 * social_notification_outbox table is created lazily by
 * ensureSocialOutboxTable() (CREATE TABLE IF NOT EXISTS) — same lazy-table
 * pattern as company_ghl_bindings.
 */

import { getDb, queryOne, queryAll, run } from '@/lib/db';

// ── Contract types ──────────────────────────────────────────────────────────

/** delivery.json provider_state enum. */
export type ProviderState = 'draft' | 'scheduled' | 'published' | 'failed' | 'unknown';

/** publish_queue states the F03 dispatcher persists (W0 contract). */
export type PublishQueueState =
  | 'queued' | 'running' | 'retrying' | 'scheduled' | 'published'
  | 'failed' | 'overdue' | 'done' | 'cancelled';

export type SummaryOwner = 'system' | 'client';

export interface SocialSummaryMessage {
  /** The truthful current stage, e.g. "queued", "awaiting theme", "scheduled". */
  stage: string;
  /** Last milestone with persisted evidence, e.g. "theme approved Sep 7". */
  lastVerified: string | null;
  /** The single truthful next action. */
  nextAction: string;
  /** Who owns the next action. */
  owner: SummaryOwner;
  /** Retry deadline (ISO) when the system owns a retry; null otherwise. */
  retryDeadline: string | null;
  /** Persisted evidence row ids backing this message (auditable, never prose). */
  evidence: { kind: string; id: string; at: string }[];
  /** Unresolved failure lines, one per affected resource. */
  failures: string[];
}

export interface CycleCloseSummary {
  companyId: string;
  cycleId: string;
  weekStart: string | null;
  publishedUrls: { url: string; account: string; at: string | null }[];
  scheduledItems: { account: string; scheduledAt: string; state: ProviderState }[];
  intentionallySkipped: { account: string; reason: string }[];
  unresolvedFailures: { account: string; reason: string; repair: string }[];
  /** History of theme answers / approvals / outcome changes (persisted rows). */
  history: { at: string; kind: string; detail: string }[];
}

// ── Persisted-row input shapes (what the callers read from the DB) ──────────

export interface SummaryPublishRow {
  id: string;
  company_id: string;
  task_id: string | null;
  topic: string;
  platforms: string;
  status: string;
  error: string | null;
  retry_at: string | null;
  attempt_count?: number | null;
  created_at: string;
  updated_at: string;
  cc_task_id?: string | null;
}

export interface SummaryTaskRow {
  id: string;
  status: string;
  block_reason?: string | null;
  block_needs?: string | null;
  dispatch_attempts?: number | null;
  next_dispatch_eligible_at?: string | null;
  updated_at: string;
}

export interface SummaryDeliveryRow {
  delivery_id: string;
  company_id: string;
  cycle_id: string;
  account_id: string;
  provider_state: ProviderState | string;
  scheduled_at: string | null;
  published_url: string | null;
  failure_reason: string | null;
  checked_at: string;
}

export interface SummaryCycleRow {
  id: string;
  company_id: string;
  week_start_local: string;
  state: string;
  response_state: string | null;
  responded_at: string | null;
  reminder_count?: number | null;
  cutoff_at?: string | null;
  disposition?: string | null;
}

export interface SummaryExpiryRow {
  id: string;
  kind: string;
  error_type: string;
  affected_resource: string;
  affected_resource_id?: string | null;
  status: string;
  retry_at?: string | null;
  recovery?: string | null;
}

// ── Client message derivation (F30 step 2) ──────────────────────────────────

function parsePlatforms(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Derive the client-facing message for ONE publish intent from its persisted
 * rows. Stage names mirror persisted states verbatim — "queued says queued",
 * "scheduled says scheduled" (F30 required outcome). The task_events history
 * supplies the last verified milestone; nothing is asserted that no row
 * proves.
 */
export function buildPublishMessage(
  publish: SummaryPublishRow,
  task: SummaryTaskRow | null,
  taskEvents: { to_status: string; created_at: string; reason?: string | null }[] = [],
): SocialSummaryMessage {
  const status = (publish.status || 'queued').toLowerCase() as PublishQueueState;
  const evidence: SocialSummaryMessage['evidence'] = [
    { kind: 'publish_queue', id: publish.id, at: publish.updated_at },
  ];
  const failures: string[] = [];

  const lastEvent = taskEvents.length
    ? taskEvents.reduce((a, b) => (a.created_at > b.created_at ? a : b))
    : null;
  const lastVerified = lastEvent
    ? `${lastEvent.to_status} verified ${new Date(lastEvent.created_at).toLocaleString()}${lastEvent.reason ? ` (${lastEvent.reason})` : ''}`
    : task
      ? `${task.status} as of ${new Date(task.updated_at).toLocaleString()}`
      : null;
  if (task) evidence.push({ kind: 'task', id: task.id, at: task.updated_at });
  if (lastEvent) evidence.push({ kind: 'task_events', id: `${publish.id}:${lastEvent.to_status}`, at: lastEvent.created_at });

  let stage: string;
  let nextAction: string;
  let owner: SummaryOwner;
  let retryDeadline: string | null = null;

  switch (status) {
    case 'queued':
      stage = 'queued';
      nextAction = 'The publishing worker will pick this up automatically. If it stays queued for more than a few minutes, the worker may be offline — we will surface it as overdue.';
      owner = 'system';
      break;
    case 'overdue':
      stage = 'overdue';
      nextAction = 'The publish worker is stopped or stalled. We are retrying automatically; if attempts run out this becomes a visible failure.';
      owner = 'system';
      break;
    case 'running':
      stage = 'producing';
      nextAction = task?.status === 'review'
        ? 'Content is produced and awaiting quality review.'
        : 'Content is being produced and dispatched.';
      owner = 'system';
      break;
    case 'retrying':
      stage = 'retrying';
      retryDeadline = publish.retry_at ?? null;
      nextAction = retryDeadline
        ? `A dispatch attempt failed; the system retries automatically by ${new Date(retryDeadline).toLocaleString()} (attempt ${publish.attempt_count ?? 'n/a'}).`
        : 'A dispatch attempt failed; the system retries automatically.';
      owner = 'system';
      if (publish.error) failures.push(publish.error);
      break;
    case 'scheduled':
      stage = 'scheduled';
      nextAction = 'Posts are scheduled and will publish at their scheduled times.';
      owner = 'system';
      break;
    case 'published':
    case 'done':
      stage = 'published';
      nextAction = 'This cycle completed. See the cycle summary for the published links.';
      owner = 'system';
      break;
    case 'failed':
      stage = 'failed';
      nextAction = 'The publish failed after its attempt budget. Retry the publish or contact support — nothing is silently dropped.';
      owner = 'system';
      if (publish.error) failures.push(publish.error);
      break;
    default:
      stage = status;
      nextAction = `State "${status}" is recorded; no further action is pending.`;
      owner = 'system';
  }

  // Task-level truth narrows the client-owned cases (the theme gate).
  if (task?.status === 'blocked') {
    const needs = task.block_needs || task.block_reason || 'attention';
    stage = 'blocked';
    const clientOwned = /theme|approve|approval|confirm|reconnect|account/i.test(needs);
    owner = clientOwned ? 'client' : 'system';
    nextAction = clientOwned
      ? `Waiting on you: ${needs}.`
      : `Blocked: ${needs}. The system is on it; you do not need to act.`;
    failures.push(needs);
    retryDeadline = null;
  }

  // Theme gate (F07 contract): an unanswered cycle outranks everything — the
  // client, not the system, owns the week's next action.
  const cycle = queryOne<SummaryCycleRow>(
    `SELECT * FROM social_cycles WHERE company_id = ? ORDER BY created_at DESC LIMIT 1`,
    [publish.company_id],
  );
  if (cycle && (cycle.state === 'invited' || cycle.state === 'draft') && !cycle.response_state) {
    stage = 'awaiting theme';
    owner = 'client';
    nextAction = 'This week is waiting for your theme answer. Pick a theme (or skip the week) to start the publishing cycle.';
    retryDeadline = null;
    evidence.push({ kind: 'social_cycles', id: cycle.id, at: cycle.responded_at || cycle.state });
  }

  return { stage, lastVerified, nextAction, owner, retryDeadline, evidence, failures };
}

/**
 * Derive the client message for a task detail/status surface from canonical
 * task state only (the task + its events + its linked publish rows).
 */
export function buildTaskSummary(
  task: SummaryTaskRow,
  publishRows: SummaryPublishRow[] = [],
  taskEvents: { to_status: string; created_at: string; reason?: string | null }[] = [],
): SocialSummaryMessage {
  const evidence: SocialSummaryMessage['evidence'] = [
    { kind: 'task', id: task.id, at: task.updated_at },
  ];
  const failures: string[] = [];
  const lastEvent = taskEvents.length
    ? taskEvents.reduce((a, b) => (a.created_at > b.created_at ? a : b))
    : null;
  const lastVerified = lastEvent
    ? `${lastEvent.to_status} verified ${new Date(lastEvent.created_at).toLocaleString()}${lastEvent.reason ? ` (${lastEvent.reason})` : ''}`
    : `${task.status} as of ${new Date(task.updated_at).toLocaleString()}`;

  let stage = task.status;
  let nextAction = 'No action needed — work is progressing.';
  let owner: SummaryOwner = 'system';
  let retryDeadline: string | null = null;

  if (task.status === 'blocked') {
    const needs = task.block_needs || task.block_reason || 'attention';
    const clientOwned = /theme|approve|approval|confirm|reconnect|account/i.test(needs);
    owner = clientOwned ? 'client' : 'system';
    nextAction = clientOwned ? `Waiting on you: ${needs}.` : `Blocked: ${needs}. The system is handling it.`;
    failures.push(needs);
  } else if (task.status === 'done') {
    nextAction = 'Completed. Deliverables are on the task record.';
  } else if (task.status === 'review') {
    nextAction = 'Awaiting quality review before delivery.';
  }

  const activePublish = publishRows.find((p) =>
    ['queued', 'running', 'retrying', 'scheduled', 'overdue'].includes((p.status || '').toLowerCase()));
  if (activePublish) {
    const ps = (activePublish.status || '').toLowerCase();
    stage = ps === 'overdue' ? 'overdue' : ps === 'retrying' ? 'retrying' : ps === 'scheduled' ? 'scheduled' : ps === 'queued' ? 'queued' : 'producing';
    if (ps === 'retrying' && activePublish.retry_at) {
      retryDeadline = activePublish.retry_at;
      nextAction = `Dispatch retries automatically by ${new Date(activePublish.retry_at).toLocaleString()}.`;
    }
    evidence.push({ kind: 'publish_queue', id: activePublish.id, at: activePublish.updated_at });
    if (activePublish.error && ps === 'retrying') failures.push(activePublish.error);
  }

  return { stage, lastVerified, nextAction, owner, retryDeadline, evidence, failures };
}

// ── Cycle close summary (F30 step 3) ────────────────────────────────────────

/**
 * Build the cycle-close rollup from PERSISTED rows: delivery.json provider
 * states (published URLs, scheduled times, failed accounts), the F35 expiry
 * ledger (skipped/expired resources with repair paths), and the cycle's
 * response history. Every line cites a row that exists — a healthy week lists
 * healthy results and the one affected channel, never a blanket "done".
 */
export function buildCycleCloseSummary(input: {
  companyId: string;
  cycleId: string;
  deliveries: SummaryDeliveryRow[];
  expiryEvents?: SummaryExpiryRow[];
  cycle?: SummaryCycleRow | null;
}): CycleCloseSummary {
  const publishedUrls: CycleCloseSummary['publishedUrls'] = [];
  const scheduledItems: CycleCloseSummary['scheduledItems'] = [];
  const unresolvedFailures: CycleCloseSummary['unresolvedFailures'] = [];
  const intentionallySkipped: CycleCloseSummary['intentionallySkipped'] = [];
  const history: CycleCloseSummary['history'] = [];

  for (const d of input.deliveries) {
    const state = (d.provider_state || 'unknown').toLowerCase();
    if (state === 'published') {
      publishedUrls.push({ url: d.published_url || '', account: d.account_id, at: d.checked_at });
      history.push({ at: d.checked_at, kind: 'published', detail: `${d.account_id}: ${d.published_url || 'url pending'}` });
    } else if (state === 'scheduled') {
      scheduledItems.push({
        account: d.account_id,
        scheduledAt: d.scheduled_at || 'unscheduled',
        state: 'scheduled',
      });
      history.push({ at: d.scheduled_at || d.checked_at, kind: 'scheduled', detail: `${d.account_id}: scheduled ${d.scheduled_at || ''}`.trim() });
    } else if (state === 'failed') {
      unresolvedFailures.push({
        account: d.account_id,
        reason: d.failure_reason || 'provider reported failure',
        repair: 'Retry from the task detail, or reconnect the account and re-run this channel.',
      });
      history.push({ at: d.checked_at, kind: 'failed', detail: `${d.account_id}: ${d.failure_reason || 'failed'}` });
    } else if (state === 'draft') {
      history.push({ at: d.checked_at, kind: 'draft', detail: `${d.account_id}: draft (not yet submitted)` });
    } else {
      // 'unknown' is stated AS unknown with the check to run — never "done".
      unresolvedFailures.push({
        account: d.account_id,
        reason: `delivery state unknown (last checked ${d.checked_at})`,
        repair: 'Verify the post on the account, or re-run the delivery check for this channel.',
      });
      history.push({ at: d.checked_at, kind: 'unknown', detail: `${d.account_id}: state unknown` });
    }
  }

  for (const e of input.expiryEvents ?? []) {
    if ((e.status || '') === 'open') {
      const account = e.affected_resource_id || e.affected_resource;
      intentionallySkipped.push({
        account,
        reason: `${e.kind}/${e.error_type}: ${e.affected_resource}`,
      });
      unresolvedFailures.push({
        account,
        reason: `${e.error_type} on ${e.affected_resource}`,
        repair: e.recovery || 'Reconnect the affected resource; healthy channels continue independently.',
      });
      history.push({ at: e.retry_at || '', kind: 'expiry', detail: `${e.kind}: ${e.error_type} on ${e.affected_resource}` });
    }
  }

  if (input.cycle) {
    if (input.cycle.response_state) {
      history.push({
        at: input.cycle.responded_at || input.cycle.state,
        kind: 'theme_answer',
        detail: `theme answer: ${input.cycle.response_state}`,
      });
    }
    if (input.cycle.disposition) {
      history.push({ at: input.cycle.state, kind: 'disposition', detail: input.cycle.disposition });
    }
  }

  return {
    companyId: input.companyId,
    cycleId: input.cycleId,
    weekStart: input.cycle?.week_start_local ?? null,
    publishedUrls,
    scheduledItems,
    intentionallySkipped,
    unresolvedFailures,
    history,
  };
}

/**
 * Read the cycle-close summary straight from the DB for a company+cycle
 * (the persisted-state path the UI/notification calls).
 */
export function loadCycleCloseSummary(companyId: string, cycleId: string): CycleCloseSummary {
  const db = getDb();
  const deliveries = queryAll<SummaryDeliveryRow>(
    `SELECT * FROM social_deliveries WHERE company_id = ? AND cycle_id = ?`,
    [companyId, cycleId],
  );
  const cycle = queryOne<SummaryCycleRow>(
    'SELECT * FROM social_cycles WHERE id = ? AND company_id = ?',
    [cycleId, companyId],
  );
  let expiryEvents: SummaryExpiryRow[] = [];
  try {
    expiryEvents = queryAll<SummaryExpiryRow>(
      `SELECT * FROM social_expiry_events WHERE company_id = ? AND status = 'open'`,
      [companyId],
    );
  } catch {
    // pre-WF10 box without the expiry ledger — the delivery rows still speak.
  }
  return buildCycleCloseSummary({ companyId, cycleId, deliveries, expiryEvents, cycle });
}

// ── Consolidated notifications (F30 step 3, no retry spam) ──────────────────

export interface SocialOutboxRow {
  id: string;
  company_id: string;
  resource: string;
  event: string;
  dedupe_key: string;
  message: string;
  state: 'pending' | 'sent' | 'failed';
  attempt_count: number;
  last_error: string | null;
  last_attempt_at: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}

const OUTBOX_DEDUPE_WINDOW_MS = 30 * 60_000; // same event re-notified at most every 30 min
const OUTBOX_MAX_ATTEMPTS = 5;

let outboxEnsured = false;
/** Lazy CREATE TABLE IF NOT EXISTS (no migration id; documented for WF00). */
export function ensureSocialOutboxTable(): void {
  if (outboxEnsured) return;
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS social_notification_outbox (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL,
    resource TEXT NOT NULL,
    event TEXT NOT NULL,
    dedupe_key TEXT NOT NULL,
    message TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sent','failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    last_attempt_at TEXT,
    sent_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_social_outbox_dedupe
    ON social_notification_outbox(company_id, dedupe_key, created_at DESC)`);
  outboxEnsured = true;
}

export interface NotifyCompanyResult {
  id: string;
  deduped: boolean;
  state: 'pending' | 'sent' | 'failed';
  error?: string;
}

/**
 * Notify this company about one event on one resource, consolidated:
 *   - DEDUPE: the same (company_id, resource, event) inside the dedupe window
 *     is a no-op — retries and repeated sweeps never spam the client.
 *   - VISIBLE FAILURE: a send failure persists a 'failed' outbox row with the
 *     error; the failure is observable, not swallowed.
 *   - BOUNDED RETRY: a later call for the same key past the window retries the
     notification (attempt-capped); past the cap it stays failed, visibly.
 *
 * `send` is the channel adapter (Telegram/owner-notify/etc). It receives the
 * message text and returns true on success. The default adapter is the
 * shared notifySystem() (best-effort, test-safe, gateway-routed).
 */
export async function notifyCompany(
  input: {
    companyId: string;
    resource: string;
    event: string;
    message: string;
  },
  send: (message: string) => Promise<boolean> | boolean = defaultSend,
  nowMs: number = Date.now(),
): Promise<NotifyCompanyResult> {
  ensureSocialOutboxTable();
  const db = getDb();
  const dedupeKey = `${input.resource}|${input.event}`;
  const nowIso = new Date(nowMs).toISOString();

  // DEDUPE: a sent row for the same key inside the window absorbs the repeat.
  const recent = queryOne<SocialOutboxRow>(
    `SELECT * FROM social_notification_outbox
      WHERE company_id = ? AND dedupe_key = ? AND state = 'sent'
      ORDER BY created_at DESC LIMIT 1`,
    [input.companyId, dedupeKey],
  );
  if (recent) {
    const age = nowMs - new Date(recent.sent_at || recent.created_at).getTime();
    if (age >= 0 && age < OUTBOX_DEDUPE_WINDOW_MS) {
      return { id: recent.id, deduped: true, state: 'sent' };
    }
  }

  // Retry budget: a prior failed row for the same key retries (capped).
  const prior = queryOne<SocialOutboxRow>(
    `SELECT * FROM social_notification_outbox
      WHERE company_id = ? AND dedupe_key = ? AND state IN ('pending','failed')
      ORDER BY created_at DESC LIMIT 1`,
    [input.companyId, dedupeKey],
  );
  if (prior && prior.attempt_count >= OUTBOX_MAX_ATTEMPTS) {
    return { id: prior.id, deduped: true, state: prior.state as SocialOutboxRow['state'], error: 'retry cap reached' };
  }

  const id = prior?.id || crypto.randomUUID();
  let sent = false;
  let error: string | undefined;
  try {
    sent = Boolean(await send(input.message));
    if (!sent) error = 'send returned false';
  } catch (err) {
    sent = false;
    error = (err as Error).message;
  }

  run(
    `INSERT INTO social_notification_outbox
       (id, company_id, resource, event, dedupe_key, message, state, attempt_count, last_error, last_attempt_at, sent_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       state = excluded.state,
       attempt_count = attempt_count + 1,
       last_error = excluded.last_error,
       last_attempt_at = excluded.last_attempt_at,
       sent_at = excluded.sent_at,
       updated_at = excluded.updated_at`,
    [
      id, input.companyId, input.resource, input.event, dedupeKey, input.message,
      sent ? 'sent' : 'failed', error ?? null, nowIso, sent ? nowIso : null,
      new Date(prior ? new Date(prior.created_at).getTime() : nowMs).toISOString(), nowIso,
    ],
  );

  return { id, deduped: false, state: sent ? 'sent' : 'failed', error };
}

/** Failed deliveries that still need attention (visible, not swallowed). */
export function listFailedNotifications(companyId: string): SocialOutboxRow[] {
  ensureSocialOutboxTable();
  return queryAll<SocialOutboxRow>(
    `SELECT * FROM social_notification_outbox
      WHERE company_id = ? AND state IN ('failed','pending')
      ORDER BY created_at DESC LIMIT 100`,
    [companyId],
  );
}

/** Default channel: the shared system notify (best-effort, test-safe). */
async function defaultSend(message: string): Promise<boolean> {
  const { notifySystem } = await import('@/lib/notify');
  return notifySystem(message);
}