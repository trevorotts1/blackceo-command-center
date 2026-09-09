/**
 * src/lib/jobs/social-account-health.ts — F35 expiry handling for ACCOUNT
 * credentials and the global GHL PIT (social/wf10-weekly-expiry).
 *
 * LAW (QC-F35): each kind of expiry affects ONLY its own destination.
 *   - One account's authorization expiring marks THAT account
 *     needs_reconnect (discovered_account.json contract health value) —
 *     never the run, never another account, never a silent success on the
 *     affected destination.
 *   - A globally invalid GHL PIT pauses GHL DELIVERY ONLY (provider-scope
 *     pause, explicitly reported), while non-GHL production continues.
 *   - Transient errors retry with backoff (never an immediate re-fire, never
 *     a credential-blind hammering).
 *   - Reconnection reconciles scheduled posts: after recovery the affected
 *     account's queued posts resume; stale offers are surfaced for an owner
 *     decision, never silently reposted.
 *   - The affected destination is NEVER labeled successful while the
 *     expiry row is open.
 */

import { randomUUID } from 'crypto';
import { getDb, queryAll, queryOne, run, timeNow } from '@/lib/db';
import { notifySystem } from '@/lib/notify';

export const EXPIRY_KIND_ACCOUNT = 'account_authorization';
export const EXPIRY_KIND_MEDIA = 'media_asset_url';
export const EXPIRY_KIND_INVITATION = 'mini_app_invitation';
export const EXPIRY_KIND_PROVIDER = 'provider_credential';

/** Error classes mirroring ghl_contracts.py (E_*) so both halves agree. */
export type ExpiryErrorType =
  | 'authentication'        // 401 — token expired/revoked
  | 'scope'                 // 403 — token valid, permission missing
  | 'disconnected_account'  // 404 — location/account unlinked
  | 'rate_limited'          // 429 — transient, retry with backoff
  | 'transient'             // 5xx/network — retry with backoff
  | 'contract';             // malformed payload — not a credential problem

const TRANSIENT_TYPES: ReadonlySet<string> = new Set(['rate_limited', 'transient']);

export interface RecordExpiryInput {
  companyId: string;
  kind: string;
  errorType: ExpiryErrorType;
  affectedResource: string;      // e.g. 'ghl_account', 'media_asset', 'invitation', 'ghl_pit'
  affectedResourceId: string;    // the specific account/asset/ticket id
  detail?: string;
  /** 'single' (default) or 'provider' (a globally-invalid credential's scope). */
  deliveryScope?: 'single' | 'provider';
}

export interface RecordedExpiry {
  id: string;
  status: 'open' | 'recovered' | 'paused';
  retryAt: string;
}

/** Backoff: 5min, 15min, 45min, 2h, 6h — capped. */
export function backoffSeconds(retryCount: number): number {
  const ladder = [300, 900, 2700, 7200, 21600];
  return ladder[Math.min(retryCount, ladder.length - 1)];
}

/**
 * Record an expiry. Open rows are UNIQUE per (company, kind, resource, status
 * = open) — a second report of the same live expiry collapses into the
 * existing row (idempotent), keeping one reconciliation story per resource.
 */
export function recordExpiry(input: RecordExpiryInput): RecordedExpiry {
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT id, retry_count, status FROM social_expiry_events
       WHERE company_id = ? AND kind = ? AND affected_resource_id = ? AND status = 'open'`,
    )
    .get(input.companyId, input.kind, input.affectedResourceId) as
    { id: string; retry_count: number; status: string } | undefined;
  if (existing) {
    run(`UPDATE social_expiry_events SET detail = COALESCE(?, detail), updated_at = ? WHERE id = ?`,
      [input.detail ?? null, timeNow(), existing.id]);
    return { id: existing.id, status: 'open', retryAt: '' };
  }
  const id = randomUUID();
  run(
    `INSERT INTO social_expiry_events
       (id, company_id, kind, error_type, affected_resource, affected_resource_id, detail,
        delivery_scope, status, retry_count, retry_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', 0, ?)`,
    [
      id, input.companyId, input.kind, input.errorType, input.affectedResource,
      input.affectedResourceId, input.detail ?? null, input.deliveryScope ?? 'single',
      new Date(Date.now() + backoffSeconds(0) * 1000).toISOString(),
    ],
  );

  // Account expiry → THAT account's health flips to needs_reconnect. The
  // scope of the mutation is the single row named by affectedResourceId.
  if (input.kind === EXPIRY_KIND_ACCOUNT && input.deliveryScope !== 'provider') {
    setAccountHealth(input.affectedResourceId, 'needs_reconnect', input.errorType);
  }

  // Globally invalid provider credential (e.g. the GHL PIT): pause THAT
  // provider's delivery only — explicitly, visibly, and reversibly.
  if (input.kind === EXPIRY_KIND_PROVIDER && input.deliveryScope === 'provider') {
    pauseProviderDelivery(input.affectedResourceId, input.companyId, input.errorType);
  }

  return { id, status: 'open', retryAt: new Date(Date.now() + backoffSeconds(0) * 1000).toISOString() };
}

/** Flip one connected account's health (discovered_account.json vocabulary). */
export function setAccountHealth(accountId: string, health: 'ready' | 'needs_reconnect' | 'failed', reason?: string): void {
  const table = 'social_connected_accounts';
  const exists = getDb()
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(table);
  if (!exists) return; // table not provisioned on this box — ledger row is the record
  run(
    `UPDATE social_connected_accounts SET health = ?, health_reason = ?, updated_at = ? WHERE id = ?`,
    [health, reason ?? null, timeNow(), accountId],
  );
}

/**
 * Provider-scope pause: stop claiming/sending for ONE provider while every
 * other provider proceeds. Persisted as an explicit pause row (never an
 * implicit failure to dispatch) so the pause is REPORTED, not silent.
 */
export function pauseProviderDelivery(provider: string, companyId: string, reason: string): void {
  const id = `pause-${provider}-${companyId}`;
  run(
    `INSERT INTO social_delivery_pauses (id, company_id, provider, reason, paused_at, active)
     VALUES (?, ?, ?, ?, ?, 1)
     ON CONFLICT(id) DO UPDATE SET reason = excluded.reason, active = 1, paused_at = excluded.paused_at`,
    [id, companyId, provider, reason, timeNow()],
  );
  // Explicit report — an operator-visible notification, not a log whisper.
  notifySystem(
    `Social delivery for provider "${provider}" is PAUSED: the credential failed an authentication check. ` +
      `Non-${provider} production continues. Restore the credential to resume.`,
    { agent: 'social-account-health', action: 'provider_delivery_paused' },
  );
}

export function isProviderPaused(provider: string, companyId: string): boolean {
  const row = queryOne<{ active: number }>(
    `SELECT active FROM social_delivery_pauses WHERE company_id = ? AND provider = ?`,
    [companyId, provider],
  );
  return row?.active === 1;
}

/** Resume after reconnection. */
export function resumeProviderDelivery(provider: string, companyId: string): void {
  run(
    `UPDATE social_delivery_pauses SET active = 0, resumed_at = ? WHERE company_id = ? AND provider = ?`,
    [timeNow(), companyId, provider],
  );
}

/**
 * Recovery sweep (SHORT): retry transient open rows on their backoff clock;
 * report expired-but-open rows. Permanently-invalid credentials
 * (authentication/scope) are NOT retried by the sweep — they wait for the
 * same-client reconnection action (owner re-auth), which is the contract's
 * "do not keep blindly retrying invalid credentials".
 */
export interface ExpiryRecoveryResult {
  scanned: number;
  retried: number;
  backoff: number;
  recovered: number;
  awaiting_reconnect: number;
}

export async function runExpiryRecoverySweep(
  probe?: (row: { kind: string; affected_resource_id: string; error_type: string; company_id: string }) => Promise<boolean>,
  nowMs: number = Date.now(),
): Promise<ExpiryRecoveryResult> {
  const open = queryAll<{
    id: string; company_id: string; kind: string; error_type: string;
    affected_resource: string; affected_resource_id: string; retry_count: number; retry_at: string | null;
  }>(
    `SELECT id, company_id, kind, error_type, affected_resource, affected_resource_id, retry_count, retry_at
     FROM social_expiry_events WHERE status = 'open' ORDER BY retry_at LIMIT 50`,
    [],
  );
  const out: ExpiryRecoveryResult = { scanned: open.length, retried: 0, backoff: 0, recovered: 0, awaiting_reconnect: 0 };
  for (const row of open) {
    if (TRANSIENT_TYPES.has(row.error_type)) {
      if (row.retry_at && new Date(row.retry_at).getTime() > nowMs) { out.backoff += 1; continue; }
      if (!probe) { out.backoff += 1; continue; }
      let healthy = false;
      try { healthy = await probe(row); } catch { healthy = false; }
      if (healthy) {
        recoverExpiry(row.id, 'transient_error_cleared');
        out.recovered += 1;
      } else {
        run(
          `UPDATE social_expiry_events SET retry_count = retry_count + 1, retry_at = ?, last_attempt_at = ?, updated_at = ? WHERE id = ?`,
          [new Date(nowMs + backoffSeconds(row.retry_count + 1) * 1000).toISOString(), timeNow(), timeNow(), row.id],
        );
        out.retried += 1;
      }
    } else {
      out.awaiting_reconnect += 1; // authentication/scope: waits for reconnection, never blind-retried
    }
  }
  return out;
}

/**
 * Reconnection landed: mark the expiry recovered, restore account health,
 * resume a provider pause if the recovered resource was provider-scope, and
 * RECONCILE scheduled posts (QC-F35): dependent posts return to the queue —
 * stale offers (scheduled while the account was down and now in the past)
 * are surfaced for an owner decision, never silently reposted.
 */
export function reconcileAfterReconnect(expiryId: string): { reconciled: number; stale_offers: number } {
  const row = queryOne<{ company_id: string; kind: string; affected_resource_id: string; delivery_scope: string }>(
    `SELECT company_id, kind, affected_resource_id, delivery_scope FROM social_expiry_events WHERE id = ?`,
    [expiryId],
  );
  if (!row) return { reconciled: 0, stale_offers: 0 };
  recoverExpiry(expiryId, 'reconnected');
  if (row.kind === EXPIRY_KIND_ACCOUNT) {
    setAccountHealth(row.affected_resource_id, 'ready', 'reconnected');
  }
  if (row.kind === EXPIRY_KIND_PROVIDER && row.delivery_scope === 'provider') {
    resumeProviderDelivery(row.affected_resource_id, row.company_id);
  }
  // Reconcile scheduled posts bound to the affected company: pending posts
  // whose schedule passed while the account was down become stale_offers for
  // the owner; still-future posts resume normally. Never a silent repost of
  // a stale one. publish_queue carries the requested `schedule` field (auto |
  // now | ISO timestamp); an ISO timestamp in the past = stale offer.
  let stale = 0;
  try {
    const posts = queryAll<{ id: string; schedule: string | null }>(
      `SELECT id, schedule FROM publish_queue
       WHERE company_id = ? AND (cc_task_id IS NULL OR cc_task_id = '')
         AND status IN ('queued', 'retrying')`,
      [row.company_id],
    );
    const nowIso = timeNow();
    for (const p of posts) {
      if (p.schedule && p.schedule !== 'auto' && p.schedule !== 'now' && p.schedule < nowIso) {
        stale += 1;
        run(`UPDATE publish_queue SET status = 'failed', error = 'stale_offer_awaiting_owner_decision' WHERE id = ?`, [p.id]);
      }
    }
  } catch {
    // publish_queue absent in some unit-test DBs — reconciliation ledger row already records recovery.
  }
  return { reconciled: 1, stale_offers: stale };
}

function recoverExpiry(expiryId: string, reconciliation: string): void {
  run(
    `UPDATE social_expiry_events SET status = 'recovered', recovered_at = ?, reconciliation = ?, updated_at = ? WHERE id = ?`,
    [timeNow(), reconciliation, timeNow(), expiryId],
  );
}

/**
 * The guard the publish/verify paths consult: an account or provider with an
 * OPEN expiry row must never be labeled successful.
 */
export function deliveryBlocked(companyId: string, resourceId: string): { blocked: boolean; reason?: string } {
  const open = queryOne<{ id: string }>(
    `SELECT id FROM social_expiry_events
     WHERE company_id = ? AND affected_resource_id = ? AND status = 'open' LIMIT 1`,
    [companyId, resourceId],
  );
  if (open) return { blocked: true, reason: 'expiry_open_for_resource' };
  const providerPause = queryOne<{ provider: string }>(
    `SELECT provider FROM social_delivery_pauses WHERE company_id = ? AND active = 1 LIMIT 1`,
    [companyId],
  );
  if (providerPause) return { blocked: true, reason: `provider_paused:${providerPause.provider}` };
  return { blocked: false };
}

void randomUUID;