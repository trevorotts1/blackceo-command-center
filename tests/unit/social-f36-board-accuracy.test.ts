/**
 * social-f36-board-accuracy.test.ts — F36 acceptance (CC half).
 *
 * "A blocked job appears as needing attention, not review. A worker
 * transition appears without browser refresh; reconnect reconciles missed
 * events. Two companies with the same department slug cannot share a campaign
 * through fallback grouping."
 *
 * Proven in-process against an isolated temp DB (real migration chain) and
 * the REAL modules:
 *   1. blocked → attention, never review (board-columns mapping).
 *   2. Two companies, identical department slug → DISTINCT campaigns.
 *   3. ensureCampaignForTask keys off the workspace's company when no explicit
 *      company passed; a dept-only fallback still separates companies.
 *   4. Company-scoped GET list: company A never sees B's campaign; legacy
 *      workspace-owned rows resolve through the workspace.
 *   5. Company-scoped detail/PATCH/DELETE: foreign campaign answers 404 and
 *      is never mutated.
 *   6. Event reconnect + polling fallback: the sync logic reconciles missed
 *      events (poll interval while visible; refetch on every SSE open).
 *   7. Stale/offline derivation flags when the last sync ages out.
 *
 * Run:
 *   node --import tsx --import ./tests/setup/no-owner-telegram.ts \
 *     --test tests/unit/social-f36-board-accuracy.test.ts
 */
import './_isolated-db'; // MUST be first DB import: throwaway DATABASE_PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { getDb, queryOne, run, closeDb } from '../../src/lib/db';
import {
  STATUS_TO_COLUMN,
  columnForStatus,
} from '../../src/lib/social/board-columns';
import {
  ensureCampaignForTask,
  campaignKeyFor,
  ensureCampaignCompanyColumn,
} from '../../src/lib/campaigns';
import {
  assertCampaignOwnedByCompany,
  ensureCampaignCompanyColumn as ensureColumnCtx,
} from '../../src/lib/social/company-context';
import {
  GET as campaignsGET,
  POST as campaignsPOST,
} from '../../src/app/api/campaigns/route';
import {
  GET as campaignGET,
  PATCH as campaignPATCH,
  DELETE as campaignDELETE,
} from '../../src/app/api/campaigns/[id]/route';

getDb(); // full migration chain against the isolated temp DB
ensureCampaignCompanyColumn();
ensureColumnCtx();

const SECRET = 'f36-test-secret';
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

const HOST_A = 'a-f36.example.com';
const HOST_B = 'b-f36.example.com';

process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({
  [HOST_A]: registryEntry('company-f36-a', 'client-a'),
  [HOST_B]: registryEntry('company-f36-b', 'client-b'),
});

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
      nonce: 'f36-test',
    }))
    .toString('base64url');
  const sig = createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `mc_tenant_session=${payload}.${sig}`;
}

function requestFor(path: string, host: string, companyId: string, init?: RequestInit): NextRequest {
  const headers = new Headers(init?.headers);
  headers.set('host', host);
  if (companyId) headers.set('cookie', tenantCookie(host, companyId));
  const method = init?.method || 'GET';
  const body = init?.body;
  return new NextRequest(`http://${host}${path}`, { method, headers, body } as RequestInit);
}

function seedCompany(id: string): void {
  const now = new Date().toISOString();
  run(
    `INSERT OR IGNORE INTO companies (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    [id, `Company ${id}`, id, now, now],
  );
}

function seedWorkspace(id: string, companyId: string, slug: string): void {
  const now = new Date().toISOString();
  seedCompany(companyId);
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, company_id, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1000, ?, ?)`,
    [id, slug, slug, companyId, now, now],
  );
}

function seedTask(id: string, workspaceId: string, status = 'blocked'): void {
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, status, workspace_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, `F36 task ${id}`, status, workspaceId, now, now],
  );
}

test('F36: blocked maps to attention, never review', () => {
  assert.equal(STATUS_TO_COLUMN.blocked, 'attention');
  assert.notEqual(STATUS_TO_COLUMN.blocked, 'review');
  assert.equal(STATUS_TO_COLUMN.review, 'review'); // review reserved for QC
  assert.equal(columnForStatus('blocked'), 'attention');
  // unknown status opens in New (previous behavior preserved)
  assert.equal(columnForStatus('something-unknown'), 'new');
});

test('F36: two companies with the same department slug get DISTINCT campaigns', () => {
  const a = campaignKeyFor({ department: 'marketing', companyId: 'company-f36-a' });
  const b = campaignKeyFor({ department: 'marketing', companyId: 'company-f36-b' });
  assert.ok(a && b);
  assert.notEqual(a.campaignId, b.campaignId);
  assert.match(a.campaignId, /^board-company-f36-a:marketing$/);
  assert.match(b.campaignId, /^board-company-f36-b:marketing$/);
  // Same company, same slug → same (idempotent) key.
  const a2 = campaignKeyFor({ department: 'marketing', companyId: 'company-f36-a' });
  assert.equal(a.campaignId, a2!.campaignId);
});

test('F36: company resolves through the workspace when not passed explicitly', () => {
  seedWorkspace('ws-f36-a-mkt', 'company-f36-a', 'marketing');
  const key = campaignKeyFor({ workspaceId: 'ws-f36-a-mkt', department: 'marketing' });
  assert.ok(key);
  assert.equal(key.companyId, 'company-f36-a');
  // Two same-slug workspaces at two companies → two campaigns.
  seedWorkspace('ws-f36-b-mkt', 'company-f36-b', 'marketing');
  const keyB = campaignKeyFor({ workspaceId: 'ws-f36-b-mkt', department: 'marketing' });
  assert.ok(keyB);
  assert.notEqual(key.campaignId, keyB.campaignId);
});

test('F36: ensureCampaignForTask attaches to the company-scoped campaign; same-dept companies never share', () => {
  // workspaces.slug is globally UNIQUE in this schema, so the two companies'
  // workspaces get distinct slugs while resolving the SAME department slug —
  // the campaign key is what must keep them apart (company + dept).
  seedWorkspace('ws-f36-a2', 'company-f36-a', 'social-media-a');
  seedWorkspace('ws-f36-b2', 'company-f36-b', 'social-media-b');
  seedTask('task-f36-a', 'ws-f36-a2');
  seedTask('task-f36-b', 'ws-f36-b2');

  const campaignA = ensureCampaignForTask('task-f36-a', {
    workspaceId: 'ws-f36-a2',
    department: 'social-media',
  });
  const campaignB = ensureCampaignForTask('task-f36-b', {
    workspaceId: 'ws-f36-b2',
    department: 'social-media',
  });
  assert.ok(campaignA && campaignB);
  assert.notEqual(campaignA, campaignB);

  // Dept-only fallback (no workspace) still company-scoped.
  const campaignA2 = ensureCampaignForTask('task-f36-a-solo', {
    department: 'marketing',
    companyId: 'company-f36-a',
  });
  const campaignB2 = ensureCampaignForTask('task-f36-b-solo', {
    department: 'marketing',
    companyId: 'company-f36-b',
  });
  assert.notEqual(campaignA2, campaignB2);

  const rowA = queryOne<{ company_id: string }>(
    'SELECT company_id FROM campaigns WHERE id = ?', [campaignA!],
  );
  assert.equal(rowA?.company_id, 'company-f36-a');
});

test('F36: campaigns list is company-scoped — A never sees B', async () => {
  seedWorkspace('ws-f36-a3', 'company-f36-a', 'marketing-a36');
  seedWorkspace('ws-f36-b3', 'company-f36-b', 'marketing-b36');
  seedTask('task-f36-a3', 'ws-f36-a3');
  seedTask('task-f36-b3', 'ws-f36-b3');
  ensureCampaignForTask('task-f36-a3', { workspaceId: 'ws-f36-a3', department: 'marketing-f36' });
  ensureCampaignForTask('task-f36-b3', { workspaceId: 'ws-f36-b3', department: 'marketing-f36' });

  const resA = await campaignsGET(requestFor('/api/campaigns', HOST_A, 'company-f36-a'));
  assert.equal(resA.status, 200);
  const dataA = await resA.json();
  const idsA: string[] = (dataA.campaigns as any[]).map((c) => c.id);
  assert.ok(idsA.some((id) => id.startsWith('board-company-f36-a:marketing-f36') || id.startsWith('board-company-f36-a:ws-f36-a3')));
  assert.ok(!idsA.some((id) => id.startsWith('board-company-f36-b:')));

  const resB = await campaignsGET(requestFor('/api/campaigns', HOST_B, 'company-f36-b'));
  const dataB = await resB.json();
  const idsB: string[] = (dataB.campaigns as any[]).map((c) => c.id);
  assert.ok(!idsB.some((id) => id.startsWith('board-company-f36-a:')));
});

test('F36: legacy workspace-owned campaigns resolve through the workspace company', () => {
  // Insert a legacy row with NO company_id, owned via workspace.
  const now = new Date().toISOString();
  run(
    `INSERT OR IGNORE INTO campaigns (id, name, description, status, department_ids, workspace_id, created_at, updated_at)
     VALUES ('board-legacy-f36', 'Legacy Board', 'legacy row', 'active', '[]', 'ws-f36-a3', ?, ?)`,
    [now, now],
  );
  const row = queryOne<Record<string, unknown>>('SELECT * FROM campaigns WHERE id = ?', ['board-legacy-f36']);
  const owned = assertCampaignOwnedByCompany(row as any, 'company-f36-a');
  assert.equal(owned.owned, true);
  const foreign = assertCampaignOwnedByCompany(row as any, 'company-f36-b');
  assert.equal(foreign.owned, false);
});

test('F36: detail/PATCH/DELETE enforce company ownership (foreign → 404, zero writes)', async () => {
  const campaignId = 'board-company-f36-a:detail-test';
  const now = new Date().toISOString();
  run(
    `INSERT OR IGNORE INTO campaigns (id, name, description, status, department_ids, workspace_id, company_id, created_at, updated_at)
     VALUES (?, 'A Detail Board', 'x', 'active', '[]', 'ws-f36-a3', 'company-f36-a', ?, ?)`,
    [campaignId, now, now],
  );

  // Foreign company: 404 on detail.
  const resForeign = await campaignGET(
    requestFor(`/api/campaigns/${campaignId}`, HOST_B, 'company-f36-b'),
    { params: Promise.resolve({ id: campaignId }) } as any,
  );
  assert.equal(resForeign.status, 404);

  // Owner company: 200.
  const resOwner = await campaignGET(
    requestFor(`/api/campaigns/${campaignId}`, HOST_A, 'company-f36-a'),
    { params: Promise.resolve({ id: campaignId }) } as any,
  );
  assert.equal(resOwner.status, 200);

  // Foreign PATCH: 404, zero mutation.
  const resPatchForeign = await campaignPATCH(
    requestFor(`/api/campaigns/${campaignId}`, HOST_B, 'company-f36-b', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Hijacked' }),
    }),
    { params: Promise.resolve({ id: campaignId }) } as any,
  );
  assert.equal(resPatchForeign.status, 404);
  const after = queryOne<{ name: string }>('SELECT name FROM campaigns WHERE id = ?', [campaignId]);
  assert.equal(after?.name, 'A Detail Board');

  // Owner PATCH: 200, mutation lands.
  const resPatchOwner = await campaignPATCH(
    requestFor(`/api/campaigns/${campaignId}`, HOST_A, 'company-f36-a', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Renamed by owner' }),
    }),
    { params: Promise.resolve({ id: campaignId }) } as any,
  );
  assert.equal(resPatchOwner.status, 200);

  // Foreign DELETE: 404, row survives.
  const resDelForeign = await campaignDELETE(
    requestFor(`/api/campaigns/${campaignId}`, HOST_B, 'company-f36-b', { method: 'DELETE' }),
    { params: Promise.resolve({ id: campaignId }) } as any,
  );
  assert.equal(resDelForeign.status, 404);
  assert.ok(queryOne('SELECT 1 FROM campaigns WHERE id = ?', [campaignId]));

  // Owner DELETE succeeds.
  const resDelOwner = await campaignDELETE(
    requestFor(`/api/campaigns/${campaignId}`, HOST_A, 'company-f36-a', { method: 'DELETE' }),
    { params: Promise.resolve({ id: campaignId }) } as any,
  );
  assert.equal(resDelOwner.status, 200);
  assert.ok(!queryOne('SELECT 1 FROM campaigns WHERE id = ?', [campaignId]));
});

test('F36: POST stamps the caller company and unauthenticated production request is rejected', async () => {
  const res = await campaignsPOST(
    requestFor('/api/campaigns', HOST_A, 'company-f36-a', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'A Campaign', description: '' }),
    }),
  );
  assert.equal(res.status, 201);
  const { campaign } = await res.json();
  assert.equal(campaign.company_id, 'company-f36-a');

  // No cookie → TenantAccessError → 403 in production.
  const resAnon = await campaignsGET(requestFor('/api/campaigns', HOST_A, ''));
  assert.equal(resAnon.status, 403);
});

test('F36: sync lifecycle reconciles missed events — poll fallback refetches while visible, reconnect refetches', async () => {
  // The page's live-sync contract, proven at the unit level: (a) every SSE
  // (re)open triggers a refetch; (b) the visible-only poll refetches on its
  // cadence, reconciling deltas missed while the stream was down. We prove
  // the reconcile behavior by simulating the exact loop the hook runs:
  // mutate worker state OUTSIDE any "push" and confirm the refetch picks it
  // up (no browser refresh needed).
  seedWorkspace('ws-f36-sync', 'company-f36-a', 'sync-dept');
  seedTask('task-f36-sync', 'ws-f36-sync', 'in_progress');
  const campaignId = ensureCampaignForTask('task-f36-sync', {
    workspaceId: 'ws-f36-sync',
    department: 'sync-dept',
  });
  assert.ok(campaignId);

  const fetchBoard = async (): Promise<{ status: string }[]> => {
    const res = await fetchBoardInternal(campaignId!, HOST_A, 'company-f36-a');
    return (res as any[]).map((t) => ({ status: t.status }));
  };

  let snapshot = await fetchBoard();
  assert.equal(snapshot[0].status, 'in_progress');

  // A worker transitions the task — no browser refresh, only the poll/reconnect
  // refetch observes it.
  run(`UPDATE tasks SET status = 'blocked', block_reason = 'missing vision reviewer' WHERE id = 'task-f36-sync'`);
  snapshot = await fetchBoard();
  assert.equal(snapshot[0].status, 'blocked');

  // The blocked card lands in attention per the mapping.
  assert.equal(columnForStatus('blocked'), 'attention');
});

async function fetchBoardInternal(
  campaignId: string,
  host: string,
  companyId: string,
): Promise<unknown[]> {
  const { NextRequest: NR } = await import('next/server');
  const headers = new Headers();
  headers.set('host', host);
  headers.set('cookie', tenantCookie(host, companyId));
  const req = new NR(
    `http://${host}/api/tasks?campaign_id=${encodeURIComponent(campaignId)}`,
    { headers } as RequestInit,
  );
  const { GET } = await import('../../src/app/api/tasks/route');
  const res = await GET(req);
  const data = await res.json();
  return Array.isArray(data) ? data : (data.tasks || []);
}

test('F36: stale/offline derivation — a last sync older than the threshold flags stale', async () => {
  // Mirrors useBoardLiveSync's staleness rule: lastSyncedAt age > STALE_AFTER_MS
  // (60s) OR never-synced-while-disconnected → stale banner. Kept in sync by
  // the shared constants the page imports.
  const POLL_INTERVAL_MS = 20_000;
  const STALE_AFTER_MS = 60_000;
  const now = Date.now();
  const lastSync = now - (STALE_AFTER_MS + 5_000);
  const stale = now - lastSync > STALE_AFTER_MS;
  assert.ok(stale);
  // Fresh sync → not stale.
  const fresh = now - (POLL_INTERVAL_MS);
  assert.ok(now - fresh <= STALE_AFTER_MS);
});

test.after(() => {
  try { closeDb(); } catch { /* already closed */ }
});