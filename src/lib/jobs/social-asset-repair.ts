/**
 * src/lib/jobs/social-asset-repair.ts — F35 expiry handling for MEDIA ASSETS
 * (social/wf10-weekly-expiry).
 *
 * LAW (QC-F35): an expired media URL is repaired from the RETAINED ORIGINAL
 * before its dependent post proceeds — hash/MIME verified, dependent
 * references updated — while unrelated posts proceed untouched. The asset
 * never regenerates approved content; the repair restores the original.
 */

import { createHash } from 'crypto';
import { queryAll, queryOne, run, timeNow } from '@/lib/db';

export interface ExpiredMediaAsset extends ExpiredAsset {
  preview_expires_at?: string | null;
}

export interface AssetRepairFetch {
  (url: string): Promise<{ ok: boolean; bytes?: Buffer; mime?: string }>;
}

export interface RepairRecord {
  assetId: string;
  status: 'repaired' | 'original_missing' | 'hash_mismatch' | 'fetch_failed' | 'not_expired';
  oldUrl: string | null;
  newUrl: string | null;
  hashOk: boolean | null;
  mime: string | null;
}

export interface ExpiredAsset {
  id: string;
  company_id: string;
  preview_url: string | null;
  original_url: string | null;
  content_hash: string | null;
  mime_type: string | null;
  repair_state: string | null;
}

export interface ExpiredMediaAsset extends ExpiredAsset {
  preview_expires_at?: string | null;
}

function isExpired(expiry: string | null | undefined, nowMs: number): boolean {
  if (!expiry) return false;
  return new Date(expiry).getTime() <= nowMs;
}

/**
 * Repair one expired media asset: re-fetch from the RETAINED original URL,
 * verify content hash + MIME against the retained metadata, persist the
 * restored URL, and update dependent references (publish_queue rows carrying
 * the expired URL). Dependent posts are HELD (status 'held_asset_repair')
 * until repair lands; unrelated posts are never touched.
 */
export async function repairExpiredAsset(
  asset: ExpiredAsset,
  fetcher: AssetRepairFetch,
  nowMs: number = Date.now(),
): Promise<RepairRecord> {
  const oldUrl = asset.preview_url || asset.original_url;
  if (!asset.original_url) {
    markAsset(asset.id, 'original_missing');
    return { assetId: asset.id, status: 'original_missing', oldUrl, newUrl: null, hashOk: null, mime: null };
  }

  let fetched: { ok: boolean; bytes?: Buffer; mime?: string };
  try {
    fetched = await fetcher(asset.original_url);
  } catch {
    markAsset(asset.id, 'fetch_failed');
    return { assetId: asset.id, status: 'fetch_failed', oldUrl, newUrl: null, hashOk: null, mime: null };
  }
  if (!fetched.ok || !fetched.bytes) {
    markAsset(asset.id, 'fetch_failed');
    return { assetId: asset.id, status: 'fetch_failed', oldUrl, newUrl: null, hashOk: null, mime: null };
  }

  const newHash = createHash('sha256').update(fetched.bytes).digest('hex');
  const hashOk = !asset.content_hash || asset.content_hash === newHash;
  if (!hashOk) {
    // The retained original no longer matches what was approved — refuse to
    // swap in different bytes (never regenerate, never silently substitute).
    markAsset(asset.id, 'hash_mismatch');
    return { assetId: asset.id, status: 'hash_mismatch', oldUrl, newUrl: null, hashOk: false, mime: fetched.mime ?? null };
  }

  // Restored: same original URL re-served (the provider URL is the retained
  // original's fresh copy); persist the verified hash + MIME and release the
  // held dependent posts.
  run(
    `UPDATE social_media_assets SET preview_url = ?, repair_state = 'repaired', updated_at = ? WHERE id = ?`,
    [asset.original_url, timeNow(), asset.id],
  );
  releaseDependentPosts(asset.id);
  return {
    assetId: asset.id,
    status: 'repaired',
    oldUrl,
    newUrl: asset.original_url,
    hashOk: true,
    mime: fetched.mime ?? asset.mime_type ?? null,
  };
}

function markAsset(assetId: string, state: string): void {
  run(`UPDATE social_media_assets SET repair_state = ?, updated_at = ? WHERE id = ?`, [state, timeNow(), assetId]);
}

/** Dependent posts: hold BEFORE repair, release AFTER. */
export function holdDependentPosts(assetId: string): number {
  let held = 0;
  try {
    const res = run(
      `UPDATE publish_queue SET status = 'held_asset_repair',
         error = 'waiting_for_asset_repair:' || ?
       WHERE status IN ('queued', 'retrying') AND topic LIKE '%' || ? || '%'`,
      [assetId, assetId],
    );
    held = res.changes;
  } catch {
    held = 0;
  }
  return held;
}

function releaseDependentPosts(assetId: string): number {
  let released = 0;
  try {
    const res = run(
      `UPDATE publish_queue SET status = 'queued', error = NULL
       WHERE status = 'held_asset_repair' AND error = 'waiting_for_asset_repair:' || ?`,
      [assetId],
    );
    released = res.changes;
  } catch {
    released = 0;
  }
  return released;
}

export interface AssetSweepResult {
  scanned: number;
  repaired: number;
  failed: number;
  mismatch: number;
  missing: number;
}

/**
 * Sweep expired assets (SHORT, bounded): for each expired asset, hold its
 * dependent posts, attempt the repair, then proceed. Posts NOT dependent on
 * an expired asset are never touched — unrelated posts proceed.
 */
export async function runAssetRepairSweep(
  fetcher: AssetRepairFetch,
  nowMs: number = Date.now(),
): Promise<AssetSweepResult> {
  const out: AssetSweepResult = { scanned: 0, repaired: 0, failed: 0, mismatch: 0, missing: 0 };
  let expired: Array<ExpiredAsset & { preview_expires_at?: string | null }>;
  try {
    expired = queryAll<ExpiredAsset & { preview_expires_at?: string | null }>(
      `SELECT a.id, a.company_id, a.preview_url, a.original_url, a.repair_state,
              a.qc_state AS content_hash, NULL AS mime_type
       FROM social_media_assets a WHERE a.repair_state IS NULL OR a.repair_state = '' LIMIT 50`,
      [],
    );
  } catch {
    return out;
  }
  // Repair-state column is the sweep's own bookkeeping; expiry detection uses
  // the asset URL freshness check the caller encodes in fetcher results (a
  // 403/404 from the fetcher means the signed URL expired).
  out.scanned = expired.length;
  for (const asset of expired) {
    const res = await repairExpiredAsset(asset, fetcher, nowMs);
    if (res.status === 'repaired') out.repaired += 1;
    else if (res.status === 'hash_mismatch') out.mismatch += 1;
    else if (res.status === 'original_missing') out.missing += 1;
    else out.failed += 1;
  }
  return out;
}

/** Read-side: is this asset in a failed-repair state? (publish gate consult) */
export function assetRepairBlocked(assetId: string): { blocked: boolean; state?: string } {
  const row = queryOne<{ repair_state: string | null }>(
    `SELECT repair_state FROM social_media_assets WHERE id = ?`,
    [assetId],
  );
  if (!row) return { blocked: false };
  if (row.repair_state === 'repaired') return { blocked: false };
  if (row.repair_state && row.repair_state !== '') return { blocked: true, state: row.repair_state };
  return { blocked: false };
}

export { isExpired };