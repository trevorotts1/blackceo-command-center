/**
 * social-f38-media-player.test.ts — F38 acceptance (CC half).
 *
 * "Watch video plays the correct revision on desktop and mobile; expired
 * preview access is renewable, and the published link points to the correct
 * destination."
 *
 * Proven in-process against an isolated temp DB (real migration chain incl.
 * 138), the REAL route handlers and the REAL signed-token helpers:
 *   1. Migration 138 creates social_media_assets.
 *   2. Cross-company lookup rejected: company B's assetId answers 404 to
 *      company A with zero bytes and no existence oracle.
 *   3. Unauthenticated → 403.
 *   4. Owned asset serves metadata + a SHORT-LIVED signed preview token bound
 *      to company + asset + url.
 *   5. Expired preview → renewable via re-auth (POST verifies a fresh token;
 *      a stale/expired token is rejected with renewable: true and never
 *      serves media).
 *   6. Correct revision served: the row's content_revision is what the
 *      player route returns.
 *   7. Published URL is separate from the draft player (published_url/original
 *      fields vs the preview target).
 *
 * Run:
 *   node --import tsx --import ./tests/setup/no-owner-telegram.ts \
 *     --test tests/unit/social-f38-media-player.test.ts
 */
import './_isolated-db'; // MUST be first DB import: throwaway DATABASE_PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { getDb, queryOne, run, closeDb } from '../../src/lib/db';
import { GET as mediaGET, POST as mediaPOST } from '../../src/app/api/social/media/[assetId]/route';
import {
  lookupMediaAsset,
  signMediaPreviewToken,
  verifyMediaPreviewToken,
  upsertMediaAsset,
} from '../../src/lib/social/media-assets';

getDb(); // trigger the full migration chain (incl. 138) against the isolated temp DB

const SECRET = 'f38-test-secret';
process.env.MC_TENANT_SESSION_SECRET = SECRET;
process.env.NODE_ENV = 'production';

function registryEntry(companyId: string, clientId: string) {
  return {
    tenantId: `tenant-${companyId}`,
    companyId,
    clientId,
    kind: 'client' as const,
    installationId: `install-${companyId}`,
  };
}

function setTenantRegistry(hostA: string, hostB: string): void {
  process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({
    [hostA]: registryEntry('company-a', 'client-a'),
    [hostB]: registryEntry('company-b', 'client-b'),
  });
}

function tenantCookie(host: string, companyId: string): string {
  const payload = Buffer
    .from(JSON.stringify({
      purpose: 'session',
      tenantId: `tenant-${companyId}`,
      companyId,
      subject: 'owner:fixture',
      host,
      installationId: `install-${companyId}`,
      exp: Date.now() / 1000 + 3600,
      nonce: 'f38-test',
    }))
    .toString('base64url');
  const sig = createHmac('sha256', SECRET)
    .update(payload)
    .digest('base64url');
  return `mc_tenant_session=${payload}.${sig}`;
}

function requestFor(host: string, companyId: string, path?: string): NextRequest {
  const headers = new Headers();
  headers.set('host', host); // NextRequest does not derive Host from the URL
  if (companyId) headers.set('cookie', tenantCookie(host, companyId));
  return new NextRequest(`http://${host}${path || '/api/social/media/x'}`, {
    method: 'GET',
    headers,
  });
}

const HOST_A = 'a-f38.example.com';
const HOST_B = 'b-f38.example.com';

const ASSET_A = {
  id: 'asset-a-1',
  company_id: 'company-a',
  cycle_id: '2026-W37',
  content_revision: 'r2',
  kind: 'video',
  preview_url: 'https://assets.cdn.filesafe.space/loc-a/media/draft-r2.mp4',
  original_url: 'https://assets.cdn.filesafe.space/loc-a/media/draft-r2-original.mp4',
  poster_url: 'https://assets.cdn.filesafe.space/loc-a/media/poster-r2.png',
  duration_seconds: 25.0,
  ratio: '9:16',
  qc_state: 'QC Review',
};

function seedAssetA(): void {
  upsertMediaAsset(ASSET_A);
}

function mediaPath(assetId: string, query = ''): string {
  return `/api/social/media/${assetId}${query}`;
}

test.after(() => {
  try { closeDb(); } catch { /* ignore */ }
});

// ─── migration 138: the asset registry exists ────────────────────────────────

test('F38 migration 138: social_media_assets table with company binding', () => {
  const db = getDb();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'social_media_assets'")
    .get();
  assert.ok(tables, 'social_media_assets must exist');
  const cols = (db.prepare('PRAGMA table_info(social_media_assets)').all() as { name: string }[])
    .map((c) => c.name);
  for (const col of ['id', 'company_id', 'cycle_id', 'content_revision', 'kind',
    'preview_url', 'original_url', 'poster_url', 'duration_seconds', 'ratio',
    'qc_state', 'created_at']) {
    assert.ok(cols.includes(col), `social_media_assets.${col} must exist`);
  }
  const applied = queryOne<{ id: string }>("SELECT id FROM _migrations WHERE id = '138'");
  assert.ok(applied, 'migration 138 must be recorded as applied');
});

// ─── company-bound lookup helpers ─────────────────────────────────────────────

test('F38 lookupMediaAsset: own asset resolves, foreign/absent are null (no oracle)', () => {
  setTenantRegistry(HOST_A, HOST_B);
  seedAssetA();
  const own = lookupMediaAsset('asset-a-1', 'company-a');
  assert.ok(own, 'the owner resolves its own asset');
  assert.equal(own.company_id, 'company-a');

  const foreign = lookupMediaAsset('asset-a-1', 'company-b');
  assert.equal(foreign, null, 'a B lookup of an A asset must resolve null');
  const absent = lookupMediaAsset('asset-never-registered', 'company-b');
  assert.equal(absent, null, 'an absent asset is indistinguishable from foreign');
});

// ─── route: cross-company lookup rejected ─────────────────────────────────────

test('F38 route: company B cannot read company A asset -> 404, no metadata leaks', async () => {
  setTenantRegistry(HOST_A, HOST_B);
  seedAssetA();
  const res = await mediaGET(
    requestFor(HOST_B, 'company-b', mediaPath('asset-a-1')),
    { params: Promise.resolve({ assetId: 'asset-a-1' }) },
  );
  assert.equal(res.status, 404, 'a substituted foreign assetId must 404');
  const body = (await res.json()) as { error?: string; asset?: unknown };
  assert.ok(body.error);
  assert.equal(body.asset, undefined, 'zero asset metadata may leak');
});

test('F38 route: unauthenticated request -> 403', async () => {
  setTenantRegistry(HOST_A, HOST_B);
  const res = await mediaGET(
    requestFor(HOST_A, '', mediaPath('asset-a-1')),
    { params: Promise.resolve({ assetId: 'asset-a-1' }) },
  );
  assert.equal(res.status, 403);
});

// ─── route: owned asset serves correct revision + signed preview ─────────────

test('F38 route: owned asset serves the correct revision + short-lived preview token', async () => {
  setTenantRegistry(HOST_A, HOST_B);
  seedAssetA();
  const res = await mediaGET(
    requestFor(HOST_A, 'company-a', mediaPath('asset-a-1')),
    { params: Promise.resolve({ assetId: 'asset-a-1' }) },
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    asset: { content_revision: string | null; duration_seconds: number | null; poster_url: string | null; watch_url: string };
    preview: { token: string; expires_at: string; url: string };
  };
  // Correct revision: r2, not r1.
  assert.equal(body.asset.content_revision, 'r2');
  assert.equal(body.asset.duration_seconds, 25.0);
  assert.ok(body.asset.poster_url);
  // The preview token is present, bound to the draft preview URL, and verifies.
  assert.equal(body.preview.url, ASSET_A.preview_url);
  const ok = await verifyMediaPreviewToken(
    body.preview.token, 'company-a', 'asset-a-1', ASSET_A.preview_url,
  );
  assert.ok(ok, 'the minted preview token must verify for the owning company');
  const foreign = await verifyMediaPreviewToken(
    body.preview.token, 'company-b', 'asset-a-1', ASSET_A.preview_url,
  );
  assert.equal(foreign, false, 'the token must NOT verify for another company');
  // Short-lived: expires within 15 minutes.
  const expMs = new Date(body.preview.expires_at).getTime();
  assert.ok(expMs - Date.now() < 15 * 60_000, 'preview token must be short-lived');
});

// ─── expired preview → renewable via re-auth ─────────────────────────────────

test('F38 expired preview is rejected as renewable, and a fresh token re-verifies', async () => {
  setTenantRegistry(HOST_A, HOST_B);
  seedAssetA();
  // 1) A stale token (already expired) is rejected with renewable: true.
  const stale = await signMediaPreviewToken('company-a', 'asset-a-1', ASSET_A.preview_url);
  const pastExp = Date.now() - 1000;
  const forgedStale = `${pastExp}.${(await import('node:crypto'))
    .createHmac('sha256', SECRET).update(`company-a|asset-a-1|${pastExp}|${ASSET_A.preview_url}`)
    .digest('hex')}`;
  const staleRejected = await verifyMediaPreviewToken(
    forgedStale, 'company-a', 'asset-a-1', ASSET_A.preview_url,
  );
  assert.equal(staleRejected, false, 'an expired token must not verify');

  // 2) Renewal path through POST: verify the FRESH token -> 200.
  const fresh = await signMediaPreviewToken('company-a', 'asset-a-1', ASSET_A.preview_url);
  const renewReq = new NextRequest(`http://${HOST_A}${mediaPath('asset-a-1')}`, {
    method: 'POST',
    headers: { host: HOST_A, cookie: tenantCookie(HOST_A, 'company-a'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: fresh.token, url: ASSET_A.preview_url }),
  });
  const renewRes = await mediaPOST(renewReq, { params: Promise.resolve({ assetId: 'asset-a-1' }) });
  assert.equal(renewRes.status, 200);
  const renewBody = (await renewRes.json()) as { ok: boolean; url: string };
  assert.equal(renewBody.ok, true);
  assert.equal(renewBody.url, ASSET_A.preview_url);

  // 3) The renewal path rejects an expired/garbage token with renewable: true.
  const badReq = new NextRequest(`http://${HOST_A}${mediaPath('asset-a-1')}`, {
    method: 'POST',
    headers: { host: HOST_A, cookie: tenantCookie(HOST_A, 'company-a'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: stale.token.replace(/^\d+/, String(pastExp)), url: ASSET_A.preview_url }),
  });
  const badRes = await mediaPOST(badReq, { params: Promise.resolve({ assetId: 'asset-a-1' }) });
  assert.equal(badRes.status, 401);
  const badBody = (await badRes.json()) as { renewable: boolean };
  assert.equal(badBody.renewable, true, 'expired preview must answer renewable, not fatal');
});

// ─── D-F38-02: POST register wires upsertMediaAsset into production ──────────

test('F38 POST register: company-bound ingest writes the asset row under the caller company', async () => {
  setTenantRegistry(HOST_A, HOST_B);
  const registerReq = new NextRequest(`http://${HOST_A}${mediaPath('asset-reg-1')}`, {
    method: 'POST',
    headers: { host: HOST_A, cookie: tenantCookie(HOST_A, 'company-a'), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'register',
      asset: {
        cycle_id: '2026-W37',
        content_revision: 'r1',
        kind: 'video',
        preview_url: 'https://assets.cdn.filesafe.space/loc-a/media/reg-r1.mp4',
        duration_seconds: 12.5,
        ratio: '9:16',
        qc_state: 'draft',
      },
    }),
  });
  const res = await mediaPOST(registerReq, { params: Promise.resolve({ assetId: 'asset-reg-1' }) });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; asset: { id: string; company_id: string; content_revision: string | null } };
  assert.equal(body.ok, true);
  assert.equal(body.asset.id, 'asset-reg-1');
  assert.equal(body.asset.company_id, 'company-a', 'row bound to the caller company, never the body');
  assert.equal(body.asset.content_revision, 'r1');

  // The registered asset is immediately playable through the same route.
  const get = await mediaGET(
    requestFor(HOST_A, 'company-a', mediaPath('asset-reg-1')),
    { params: Promise.resolve({ assetId: 'asset-reg-1' }) },
  );
  assert.equal(get.status, 200);
});

test('F38 POST register: a B-company caller cannot read or overwrite an A asset', async () => {
  setTenantRegistry(HOST_A, HOST_B);
  seedAssetA();
  // B registering the SAME assetId is REFUSED (409): the bare-id PRIMARY KEY
  // means a naive upsert would overwrite A's row — the guarded upsert leaves
  // the foreign row untouched and returns null instead.
  const evilReq = new NextRequest(`http://${HOST_B}${mediaPath('asset-a-1')}`, {
    method: 'POST',
    headers: { host: HOST_B, cookie: tenantCookie(HOST_B, 'company-b'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'register', asset: { preview_url: 'https://evil.example/x.mp4' } }),
  });
  const evilRes = await mediaPOST(evilReq, { params: Promise.resolve({ assetId: 'asset-a-1' }) });
  assert.equal(evilRes.status, 409, 'foreign-id register refused without touching the row');
  // A's own asset still resolves to A's row with A's preview URL.
  const own = lookupMediaAsset('asset-a-1', 'company-a');
  assert.ok(own);
  assert.equal(own.preview_url, ASSET_A.preview_url, 'A row untouched by the B-company register');
  // And B still cannot READ A's row through GET.
  const bGet = await mediaGET(
    requestFor(HOST_B, 'company-b', mediaPath('asset-a-1')),
    { params: Promise.resolve({ assetId: 'asset-a-1' }) },
  );
  assert.equal(bGet.status, 404, 'B GET of the A assetId still 404s');
});

test('F38 POST register: invalid asset id rejected', async () => {
  setTenantRegistry(HOST_A, HOST_B);
  const badReq = new NextRequest(`http://${HOST_A}${mediaPath('x')}`, {
    method: 'POST',
    headers: { host: HOST_A, cookie: tenantCookie(HOST_A, 'company-a'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'register', asset: {} }),
  });
  const badRes = await mediaPOST(badReq, { params: Promise.resolve({ assetId: '../escape' }) });
  assert.equal(badRes.status, 400);
});

// ─── published URL separate from the draft player ─────────────────────────────

test('F38 published URL is a separate field from the draft player target', () => {
  setTenantRegistry(HOST_A, HOST_B);
  seedAssetA();
  run(
    `UPDATE social_media_assets SET original_url = 'https://www.youtube.com/watch?v=published-xyz'
      WHERE id = 'asset-a-1'`,
  );
  const row = queryOne<{ preview_url: string; original_url: string }>(
    'SELECT preview_url, original_url FROM social_media_assets WHERE id = ?',
    ['asset-a-1'],
  );
  assert.ok(row);
  // The draft player target (preview_url) is the private CDN draft; the
  // published destination (original_url) is the separate post-publish link.
  assert.notEqual(row.preview_url, row.original_url);
  assert.match(row.preview_url, /^https:\/\/assets\.cdn\.filesafe\.space\//);
  assert.match(row.original_url, /^https:\/\/www\.youtube\.com\//);
});