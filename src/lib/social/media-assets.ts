/**
 * src/lib/social/media-assets.ts — F38 company-bound media lookup and
 * renewable preview access for the Skill 35/57 video evidence player.
 *
 * The sheet writes a "Watch video" HYPERLINK to the client-bound player route
 * (/social/media/{assetId}). That route must NEVER serve bytes because the id
 * was guessed: every lookup resolves the asset THROUGH the caller's verified
 * company identity (company-context.ts, the W0/WF01 seam), and preview URLs
 * are short-lived signed tokens bound to company + asset so a leaked link
 * expires and is renewed by re-fetching the route while authenticated.
 *
 * Properties:
 *   - lookupMediaAsset(assetId, companyId) → the row ONLY when it belongs to
 *     that company; absent/foreign ids are indistinguishable (no oracle).
 *   - signMediaPreviewToken / verifyMediaPreviewToken — HMAC-SHA256 over
 *     `companyId|assetId|exp`, short TTL, secret chain mirrors internal-call.ts
 *     deliberately (the two must never disagree about what this box signs).
 *   - Never logs or echoes secret values.
 */

import { getDb, queryOne } from '@/lib/db';

const PREVIEW_TTL_MS = 10 * 60_000; // 10 minutes — enough to watch, useless if leaked

function previewSecret(): string {
  const value = (
    process.env.MC_TENANT_SESSION_SECRET ||
    process.env.MC_INTERVIEW_COOKIE_SECRET ||
    process.env.MC_API_TOKEN
  );
  if (!value) throw new Error('Media preview secret not configured');
  return value;
}

async function hmac(payload: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(previewSecret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface SocialMediaAsset {
  id: string;
  company_id: string;
  cycle_id: string | null;
  content_revision: string | null;
  kind: string;
  preview_url: string | null;
  original_url: string | null;
  poster_url: string | null;
  duration_seconds: number | null;
  ratio: string | null;
  qc_state: string | null;
  created_at: string;
}

/**
 * Company-bound asset lookup. A foreign or absent assetId resolves to null —
 * callers answer 404 without revealing which. QC-F38: cross-company lookup is
 * rejected.
 */
export function lookupMediaAsset(assetId: string, companyId: string): SocialMediaAsset | null {
  const row = queryOne<SocialMediaAsset>(
    `SELECT id, company_id, cycle_id, content_revision, kind, preview_url,
            original_url, poster_url, duration_seconds, ratio, qc_state, created_at
       FROM social_media_assets
      WHERE id = ? AND company_id = ?`,
    [assetId, companyId],
  );
  return row || null;
}

/** Mint a short-lived preview token bound to company + asset. */
export async function signMediaPreviewToken(
  companyId: string,
  assetId: string,
  url: string,
): Promise<{ token: string; expiresAt: number }> {
  const exp = Date.now() + PREVIEW_TTL_MS;
  const h = await hmac(`${companyId}|${assetId}|${exp}|${url}`);
  return { token: `${exp}.${h}`, expiresAt: exp };
}

/**
 * Verify a preview token. An expired or forged token returns null — the route
 * answers 401 with a renewal path (re-fetch while authenticated), never the
 * media itself.
 */
export async function verifyMediaPreviewToken(
  token: string | null,
  companyId: string,
  assetId: string,
  url: string,
): Promise<boolean> {
  if (!token) return false;
  const [expRaw, sig] = token.split('.');
  if (!expRaw || !sig) return false;
  const exp = Number.parseInt(expRaw, 10);
  if (!Number.isFinite(exp) || exp <= Date.now()) return false;
  const expected = await hmac(`${companyId}|${assetId}|${exp}|${url}`);
  return timingSafeEqual(expected, sig);
}

/** Create/replace an asset row (the ONB writeback adapter's ingest seam). */
export function upsertMediaAsset(asset: {
  id: string;
  company_id: string;
  cycle_id?: string | null;
  content_revision?: string | null;
  kind?: string;
  preview_url?: string | null;
  original_url?: string | null;
  poster_url?: string | null;
  duration_seconds?: number | null;
  ratio?: string | null;
  qc_state?: string | null;
}): SocialMediaAsset {
  const db = getDb();
  db.prepare(
    `INSERT INTO social_media_assets
       (id, company_id, cycle_id, content_revision, kind, preview_url, original_url,
        poster_url, duration_seconds, ratio, qc_state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       company_id = excluded.company_id,
       cycle_id = excluded.cycle_id,
       content_revision = excluded.content_revision,
       kind = excluded.kind,
       preview_url = excluded.preview_url,
       original_url = excluded.original_url,
       poster_url = excluded.poster_url,
       duration_seconds = excluded.duration_seconds,
       ratio = excluded.ratio,
       qc_state = excluded.qc_state`,
  ).run(
    asset.id,
    asset.company_id,
    asset.cycle_id ?? null,
    asset.content_revision ?? null,
    asset.kind || 'video',
    asset.preview_url ?? null,
    asset.original_url ?? null,
    asset.poster_url ?? null,
    asset.duration_seconds ?? null,
    asset.ratio ?? null,
    asset.qc_state ?? null,
  );
  return lookupMediaAsset(asset.id, asset.company_id) as SocialMediaAsset;
}