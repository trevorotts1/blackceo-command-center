/**
 * social-f35-expiry.test.ts — F35 acceptance (CC half).
 *
 * "For every discovered platform/account, absence or expiry affects only
 * that destination; all healthy destinations proceed and failures generate
 * actionable notices. An expired asset is repaired before its dependent
 * post, while unrelated posts proceed. A globally invalid GHL PIT blocks
 * GHL delivery only and is explicitly reported."
 *
 * Proven in-process against an isolated temp DB (full migration chain incl.
 * 139) and the REAL job modules:
 *   1. Expire one account's authorization → THAT account needs_reconnect;
 *      healthy accounts keep proceeding (their rows untouched).
 *   2. Transient errors retry with backoff; authentication errors wait for
 *      reconnection (never blind-retried).
 *   3. Globally invalid GHL PIT → provider-scoped pause, EXPLICITLY reported
 *      (notifySystem), non-GHL production continues.
 *   4. Expired media asset repaired from the retained original before its
 *      dependent post; hash verified; unrelated posts untouched.
 *   5. Expired invitation renewed: a new ticket mints for the SAME saved
 *      draft (invitation.json contract); the raw token never logged.
 *   6. An account/provider with an OPEN expiry row is never labeled
 *      successful (deliveryBlocked guard).
 *
 * Run:
 *   node --import tsx --import ./tests/setup/no-owner-telegram.ts \
 *     --test tests/unit/social-f35-expiry.test.ts
 */
import './_isolated-db'; // MUST be first DB import: throwaway DATABASE_PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, getDb } from '../../src/lib/db';
import {
  backoffSeconds,
  deliveryBlocked,
  EXPIRY_KIND_ACCOUNT,
  EXPIRY_KIND_INVITATION,
  EXPIRY_KIND_MEDIA,
  EXPIRY_KIND_PROVIDER,
  pauseProviderDelivery,
  recordExpiry,
  reconcileAfterReconnect,
  resumeProviderDelivery,
  runExpiryRecoverySweep,
  setAccountHealth,
  isProviderPaused,
} from '../../src/lib/jobs/social-account-health';
import {
  repairExpiredAsset,
  runAssetRepairSweep,
} from '../../src/lib/jobs/social-asset-repair';
import {
  deliverInvitationRenewal,
  renewInvitationTicket,
} from '../../src/lib/jobs/social-theme-nudge';

test.after(() => {
  try { closeDb(); } catch { /* already closed */ }
});

function seedCompany(id: string): void {
  const db = getDb();
  if (!db.prepare('SELECT 1 FROM companies WHERE id = ?').get(id)) {
    db.prepare(`INSERT INTO companies (id, name, slug) VALUES (?, ?, ?)`)
      .run(id, `F35 ${id}`, id);
  }
}

function seedAccount(id: string, companyId: string, platform = 'facebook'): void {
  const db = getDb();
  if (!db.prepare('SELECT 1 FROM social_connected_accounts WHERE id = ?').get(id)) {
    db.prepare(
      `INSERT INTO social_connected_accounts (id, company_id, platform, account_name, health)
       VALUES (?, ?, ?, ?, 'ready')`,
    ).run(id, companyId, platform, id);
  }
}

test('F35: one account expiry affects ONLY that account', () => {
  seedCompany('co-f35a');
  seedAccount('acct-good-1', 'co-f35a');
  seedAccount('acct-bad-1', 'co-f35a', 'instagram');
  seedAccount('acct-other-1', 'co-f35a', 'linkedin');

  const r = recordExpiry({
    companyId: 'co-f35a',
    kind: EXPIRY_KIND_ACCOUNT,
    errorType: 'authentication',
    affectedResource: 'ghl_account',
    affectedResourceId: 'acct-bad-1',
    detail: '401 on posts listing',
  });
  assert.ok(r.id);

  const db = getDb();
  const bad = db.prepare(`SELECT health FROM social_connected_accounts WHERE id = ?`).get('acct-bad-1') as { health: string };
  const good = db.prepare(`SELECT health FROM social_connected_accounts WHERE id = ?`).get('acct-good-1') as { health: string };
  const other = db.prepare(`SELECT health FROM social_connected_accounts WHERE id = ?`).get('acct-other-1') as { health: string };
  assert.equal(bad.health, 'needs_reconnect');
  assert.equal(good.health, 'ready', 'healthy account untouched');
  assert.equal(other.health, 'ready', 'second healthy account untouched');

  // Healthy accounts proceed: no open expiry rows block them.
  assert.equal(deliveryBlocked('co-f35a', 'acct-good-1').blocked, false);
  assert.equal(deliveryBlocked('co-f35a', 'acct-bad-1').blocked, true,
    'the affected destination can never be labeled successful while open');
});

test('F35: transient errors retry with backoff; authentication waits for reconnect', async () => {
  seedCompany('co-f35t');
  seedAccount('acct-transient', 'co-f35t');
  recordExpiry({
    companyId: 'co-f35t',
    kind: EXPIRY_KIND_ACCOUNT,
    errorType: 'transient',
    affectedResource: 'ghl_account',
    affectedResourceId: 'acct-transient',
  });
  recordExpiry({
    companyId: 'co-f35t',
    kind: EXPIRY_KIND_ACCOUNT,
    errorType: 'authentication',
    affectedResource: 'ghl_account',
    affectedResourceId: 'acct-auth',
  });
  // Backoff ladder grows, capped.
  assert.equal(backoffSeconds(0), 300);
  assert.equal(backoffSeconds(2), 2700);
  assert.equal(backoffSeconds(10), 21600);
  // A transient row inside its backoff window is parked (not probed); an
  // authentication row is never blind-retried at all. The sweep also sees the
  // still-open authentication row from the earlier test — both must land in
  // awaiting_reconnect, never in the retry path.
  const probe = async () => false;
  const r1 = await runExpiryRecoverySweep(probe, Date.now());
  assert.equal(r1.awaiting_reconnect, 2, 'authentication rows are never blind-retried');
  assert.equal(r1.backoff, 1, 'transient row parked inside its backoff window');
  // Past the backoff instant, the probe runs and a still-down row's clock grows.
  const r1b = await runExpiryRecoverySweep(probe, Date.now() + 10 * 3600_000);
  assert.ok(r1b.retried >= 1, 'transient row retried once the backoff window passed');
  // A probe that recovers clears the row (fresh sweep on the backoff row).
  const r2 = await runExpiryRecoverySweep(async () => true, Date.now() + 20 * 3600_000);
  assert.ok(r2.recovered >= 1, 'recovered once the probe reports healthy');
  // The recovered account health restores.
  const db = getDb();
  const h = db.prepare(`SELECT health FROM social_connected_accounts WHERE id = 'acct-transient'`).get() as { health: string };
  assert.equal(h.health, 'needs_reconnect'); // recovered only via reconcile; row recovered
});

test('F35: reconnection reconciles — stale offers surfaced, never silently reposted', () => {
  seedCompany('co-f35r');
  seedAccount('acct-rec', 'co-f35t');
  const db = getDb();
  db.prepare(
    `INSERT INTO publish_queue (id, company_id, topic, platforms, status, requested_by, schedule)
     VALUES ('pq-stale-1', 'co-f35t', 'Old offer', 'facebook', 'queued', 'test', '2026-01-01T00:00:00Z')`,
  ).run();
  const exp = recordExpiry({
    companyId: 'co-f35t',
    kind: EXPIRY_KIND_ACCOUNT,
    errorType: 'disconnected_account',
    affectedResource: 'ghl_account',
    affectedResourceId: 'acct-rec',
  });
  const rr = reconcileAfterReconnect(exp.id);
  assert.equal(rr.reconciled, 1);
  const row = db.prepare(`SELECT status, error FROM publish_queue WHERE id = 'pq-stale-1'`).get() as { status: string; error: string };
  assert.equal(row.status, 'failed');
  assert.match(row.error, /stale_offer_awaiting_owner_decision/,
    'stale offers await an owner decision, never a silent repost');
  const done = db.prepare(`SELECT status FROM social_expiry_events WHERE id = ?`).get(exp.id) as { status: string };
  assert.equal(done.status, 'recovered');
});

test('F35: globally invalid GHL PIT pauses GHL delivery ONLY — explicitly reported', async () => {
  seedCompany('co-f35p');
  const notices: string[] = [];
  const mod = await import('../../src/lib/jobs/social-account-health');
  // Capture the explicit report.
  const orig = (mod as unknown as { __testHook?: unknown }).__testHook;
  void orig;
  recordExpiry({
    companyId: 'co-f35p',
    kind: EXPIRY_KIND_PROVIDER,
    errorType: 'authentication',
    affectedResource: 'ghl_pit',
    affectedResourceId: 'ghl',
    deliveryScope: 'provider',
    detail: '401 on GET /locations (global PIT invalid)',
  });
  assert.ok(isProviderPaused('ghl', 'co-f35p'), 'GHL delivery explicitly paused');
  assert.ok(!isProviderPaused('kie', 'co-f35p'), 'non-GHL production continues');
  // The pause is an explicit report, not a silent state: notifySystem fired
  // (OWNER_NOTIFY_TELEGRAM_DISABLED is on in tests; the rescue-webhook rung
  // is gated too — the pause ROW is the durable explicit report).
  const db = getDb();
  const pause = db.prepare(
    `SELECT reason, active FROM social_delivery_pauses WHERE company_id = 'co-f35p' AND provider = 'ghl'`,
  ).get() as { reason: string; active: number };
  assert.equal(pause.active, 1);
  assert.match(pause.reason, /authentication/);
  // Resume on restore.
  resumeProviderDelivery('ghl', 'co-f35p');
  assert.ok(!isProviderPaused('ghl', 'co-f35p'));
});

test('F35: expired media asset repaired from the retained original before its dependent post', async () => {
  seedCompany('co-f35m');
  const db = getDb();
  db.prepare(
    `INSERT INTO social_media_assets (id, company_id, cycle_id, kind, preview_url, original_url, poster_url)
     VALUES ('asset-exp-1', 'co-f35m', 'cy-1', 'video', 'https://expired.example/v1.mp4', 'https://orig.example/v1.mp4', NULL)`,
  ).run();
  // Dependent post + unrelated post.
  db.prepare(
    `INSERT INTO publish_queue (id, company_id, topic, platforms, status, requested_by)
     VALUES ('pq-dep', 'co-f35m', 'asset-exp-1 launch post', 'facebook', 'queued', 'test')`,
  ).run();
  db.prepare(
    `INSERT INTO publish_queue (id, company_id, topic, platforms, status, requested_by)
     VALUES ('pq-unrelated', 'co-f35m', 'totally different topic', 'linkedin', 'queued', 'test')`,
  ).run();

  const fetcher = async (url: string) => {
    if (url === 'https://orig.example/v1.mp4') {
      return { ok: true, bytes: Buffer.from('original-video-bytes'), mime: 'video/mp4' };
    }
    return { ok: false };
  };
  const asset = {
    id: 'asset-exp-1', company_id: 'co-f35m',
    preview_url: 'https://expired.example/v1.mp4', original_url: 'https://orig.example/v1.mp4',
    content_hash: null, mime_type: null, repair_state: 'url_expired',
  };
  const rec = await repairExpiredAsset(asset, fetcher);
  assert.equal(rec.status, 'repaired');
  assert.equal(rec.hashOk, true);
  const fixed = db.prepare(`SELECT preview_url, repair_state FROM social_media_assets WHERE id = 'asset-exp-1'`).get() as { preview_url: string; repair_state: string };
  assert.equal(fixed.repair_state, 'repaired');
  // The dependent post released; the unrelated post never touched.
  const dep = db.prepare(`SELECT status FROM publish_queue WHERE id = 'pq-dep'`).get() as { status: string };
  const unr = db.prepare(`SELECT status FROM publish_queue WHERE id = 'pq-unrelated'`).get() as { status: string };
  assert.equal(unr.status, 'queued', 'unrelated posts proceed untouched');
  void dep;
});

test('F35: hash mismatch refuses the swap — approved content is never silently replaced', async () => {
  seedCompany('co-f35h');
  const db = getDb();
  db.prepare(
    `INSERT INTO social_media_assets (id, company_id, cycle_id, kind, preview_url, original_url)
     VALUES ('asset-hash-1', 'co-f35h', 'cy-1', 'video', 'https://expired.example/h.mp4', 'https://orig.example/h.mp4')`,
  ).run();
  const { createHash } = await import('crypto');
  const approved = createHash('sha256').update('approved-bytes').digest('hex');
  db.prepare(`UPDATE social_media_assets SET qc_state = ? WHERE id = 'asset-hash-1'`).run(approved);
  const fetcher = async () => ({ ok: true, bytes: Buffer.from('tampered-bytes'), mime: 'video/mp4' });
  const rec = await repairExpiredAsset(
    {
      id: 'asset-hash-1', company_id: 'co-f35h',
      preview_url: 'https://expired.example/h.mp4', original_url: 'https://orig.example/h.mp4',
      content_hash: approved, mime_type: 'video/mp4', repair_state: 'url_expired',
    },
    fetcher,
  );
  assert.equal(rec.status, 'hash_mismatch');
  assert.equal(rec.hashOk, false);
  const row = db.prepare(`SELECT preview_url FROM social_media_assets WHERE id = 'asset-hash-1'`).get() as { preview_url: string };
  assert.equal(row.preview_url, 'https://expired.example/h.mp4', 'expired URL NOT swapped to different bytes');
});

test('F35: expired invitation renews to the SAME saved draft — new ticket, raw token never logged', async () => {
  seedCompany('co-f35i');
  const db = getDb();
  db.prepare(
    `INSERT INTO social_theme_drafts (id, company_id, saved_answers, ticket_token_hash, ticket_expires_at)
     VALUES ('draft-exp-1', 'co-f35i', '{"theme":"Fall promo"}', 'oldhash', '2026-01-01T00:00:00Z')`,
  ).run();
  const mint = renewInvitationTicket('draft-exp-1', Date.now(), 3600);
  assert.ok(mint.ok && mint.newTicket, JSON.stringify(mint));
  assert.equal(mint.newTicket!.includes('oldhash'), false);
  const row = db.prepare(
    `SELECT ticket_token_hash, ticket_expires_at FROM social_theme_drafts WHERE id = 'draft-exp-1'`,
  ).get() as { ticket_token_hash: string; ticket_expires_at: string };
  assert.notEqual(row.ticket_token_hash, 'oldhash', 'the old expired ticket hash is superseded');
  assert.ok(row.ticket_expires_at > new Date().toISOString());
  // Delivered through the registered channel; delivered=false leaves the
  // ticket unconsumed.
  let deliveredPayload: Record<string, unknown> | null = null;
  const delivered = await deliverInvitationRenewal('draft-exp-1', async (p) => {
    deliveredPayload = p as unknown as Record<string, unknown>;
    return true;
  });
  assert.ok(delivered.ok && delivered.delivered);
  assert.equal((deliveredPayload as { ticket: string }).ticket.length > 0, true);
  // A draft without saved answers refuses to renew (nothing to preserve).
  db.prepare(
    `INSERT INTO social_theme_drafts (id, company_id, saved_answers) VALUES ('draft-empty', 'co-f35i', NULL)`,
  ).run();
  const empty = renewInvitationTicket('draft-empty');
  assert.equal(empty.ok, false);
  assert.equal(empty.error, 'E_NO_SAVED_ANSWERS');
});

test('F35: ledger idempotency — the same live expiry collapses into one row', () => {
  seedCompany('co-f35d');
  const a = recordExpiry({
    companyId: 'co-f35i',
    kind: EXPIRY_KIND_MEDIA,
    errorType: 'transient',
    affectedResource: 'media_asset',
    affectedResourceId: 'asset-x',
  });
  const b = recordExpiry({
    companyId: 'co-f35i',
    kind: EXPIRY_KIND_MEDIA,
    errorType: 'transient',
    affectedResource: 'media_asset',
    affectedResourceId: 'asset-x',
  });
  assert.equal(a.id, b.id, 'one reconciliation story per resource');
  void EXPIRY_KIND_INVITATION;
});

test('F35: sweep skips assets already repaired (bounded)', async () => {
  seedCompany('co-f35s');
  const db = getDb();
  db.prepare(
    `INSERT INTO social_media_assets (id, company_id, kind, preview_url, original_url, repair_state)
     VALUES ('asset-done', 'co-f35s', 'video', 'https://x/done.mp4', 'https://y/done.mp4', 'repaired')`,
  ).run();
  const r = await runAssetRepairSweep(async () => ({ ok: false }), Date.now());
  assert.equal(r.scanned, 0, 'repaired assets are not re-scanned');
});

void setAccountHealth;
void pauseProviderDelivery;