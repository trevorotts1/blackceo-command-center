/**
 * src/lib/social/company-context.ts — F01 company binding for the Skill 35
 * publish surface.
 *
 * Root cause this closes: POST/GET /api/skill-35/publish accepted a bare
 * task_id (and any query shape) with no proof that the task, the GHL location,
 * the social accounts or the registered planner spreadsheet belong to the
 * caller's company. The queue schema carried no company column at all
 * (migration 026). That made a substituted B-company identifier a
 * cross-client read/write primitive through the automation APIs.
 *
 * This module resolves the caller's company identity the SAME way every other
 * company-scoped CC route does — `resolveTenantContext()` (bearer MC_API_TOKEN,
 * signed tenant session cookie, or CF Access JWT) — and exposes the ownership
 * verifications the publish route needs:
 *
 *   - resolvePublishCompany(request)  → company identity or 403-shaped reason
 *   - assertTaskOwnedByCompany(taskId, companyId) → task (via its workspace's
 *     company_id) or null when the task is foreign/absent
 *   - assertPlannerSheetOwnedByCompany(sheetId, companyId) → registered sheet
 *     row or null (sheet_registry contract: unique(company_id, planner_kind))
 *   - companyGhlLocationId(companyId) → the GHL location bound to this company
 *
 * Ownership data sources:
 *   tasks.company_id      — derivable through tasks.workspace_id →
 *                           workspaces.company_id (the canonical join the
 *                           intake/routing paths use).
 *   company_ghl_bindings  — company → GHL location id (migration 135's
 *                           companion table, created lazily here so the
 *                           binding can be stamped by provisioning).
 *   social_sheet_registry — the sheet_registry W0 contract row set
 *                           (company_id, planner_kind, sheet_id, sharing...).
 *
 * NEVER log or echo secret values. Verification returns ids/shapes only.
 */

import { getDb, queryOne } from '@/lib/db';
import {
  resolveTenantContext,
  TenantAccessError,
  type TenantContext,
} from '@/lib/auth/tenant-context';

export interface PublishCompany {
  companyId: string;
  tenant: TenantContext;
  /** GHL location id bound to this company, when known. */
  ghlLocationId: string | null;
}

export type PublishCompanyResult =
  | { ok: true; company: PublishCompany }
  | { ok: false; status: 403 | 404; error: string };

/** Resolve the authenticated company for a publish request. */
export async function resolvePublishCompany(
  request: { headers: Headers },
): Promise<PublishCompanyResult> {
  let tenant: TenantContext;
  try {
    tenant = await resolveTenantContext(request);
  } catch (error) {
    if (error instanceof TenantAccessError) {
      return { ok: false, status: 403, error: 'Verified company identity required' };
    }
    throw error;
  }
  const companyId = tenant.companyId;
  if (!companyId) {
    return { ok: false, status: 403, error: 'Verified company identity required' };
  }
  return { ok: true, company: { companyId, tenant, ghlLocationId: companyGhlLocationId(companyId) } };
}

/**
 * True iff the given task is visible to this company. A task belongs to a
 * company through its workspace (tasks.workspace_id → workspaces.company_id).
 * Absent or foreign tasks are both "not owned" — the caller answers 404
 * without leaking which. F01-D2 repair: tasks resolving to the 'default'
 * company (legacy rows, workspace-less tasks) are NOT ownable by a verified
 * non-default company — otherwise every legacy task is enqueueable/listable
 * by any tenant. Caller 'default' still owns 'default' rows (same-company).
 */
export function assertTaskOwnedByCompany(
  taskId: string | null | undefined,
  companyId: string,
): { owned: boolean } {
  if (!taskId) return { owned: true }; // no task binding requested — nothing to leak
  const db = getDb();
  const row = db
    .prepare(
      `SELECT w.company_id AS company_id
         FROM tasks t
         LEFT JOIN workspaces w ON w.id = t.workspace_id
        WHERE t.id = ?`,
    )
    .get(taskId) as { company_id: string | null } | undefined;
  if (!row) return { owned: false };
  const taskCompany = row.company_id || 'default';
  if (taskCompany === 'default' && companyId !== 'default') return { owned: false };
  return { owned: taskCompany === companyId };
}

/**
 * Resolve a registered planner spreadsheet for this company (sheet_registry
 * contract: unique(company_id, planner_kind)). A sheetId that is not
 * registered to THIS company resolves to null — callers must treat that as a
 * foreign resource and never append to it.
 */
export function assertPlannerSheetOwnedByCompany(
  sheetId: string | null | undefined,
  companyId: string,
  plannerKind = 'social-planner',
): { sheet: { sheet_id: string; sheet_url: string | null; sharing: string | null } | null } {
  if (!sheetId) return { sheet: null };
  const row = queryOne<{ sheet_id: string; sheet_url: string | null; sharing: string | null }>(
    `SELECT sheet_id, sheet_url, sharing
       FROM social_sheet_registry
      WHERE company_id = ? AND planner_kind = ? AND sheet_id = ?`,
    [companyId, plannerKind, sheetId],
  );
  return { sheet: row || null };
}

/**
 * The GHL location id bound to this company (company_ghl_bindings, created
 * lazily by this module). Null when unbound — callers decide whether that
 * blocks. Never returns a secret; location ids are identifiers, not keys.
 */
export function companyGhlLocationId(companyId: string): string | null {
  ensureSocialBindingTables();
  const row = queryOne<{ ghl_location_id: string }>(
    'SELECT ghl_location_id FROM company_ghl_bindings WHERE company_id = ?',
    [companyId],
  );
  return row?.ghl_location_id || null;
}

// ── F36 — campaign board company scoping ────────────────────────────────────

let campaignColumnEnsured = false;
/**
 * PRAGMA-guarded lazy ALTER adding campaigns.company_id (F36). Same pattern
 * as ensureSocialBindingTables: idempotent, no migration id consumed
 * (documented for WF00's reserved-ID ledger).
 */
export function ensureCampaignCompanyColumn(): boolean {
  if (campaignColumnEnsured) return true;
  try {
    const db = getDb();
    const info = db.prepare('PRAGMA table_info(campaigns)').all() as { name: string }[];
    if (Array.isArray(info) && info.length > 0 && !info.some((c) => c.name === 'company_id')) {
      db.exec(`ALTER TABLE campaigns ADD COLUMN company_id TEXT DEFAULT 'default'`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_campaigns_company ON campaigns(company_id)`);
    }
    campaignColumnEnsured = true;
    return true;
  } catch {
    return false;
  }
}

/**
 * True iff the campaign is visible to this company. A campaign belongs to a
 * company through its company_id column (F36) OR its workspace's company_id
 * (pre-F36 rows carry the lazy column's 'default' DEFAULT, not their real
 * owner). Resolution: an explicitly non-default company_id wins outright; a
 * 'default'/absent company_id resolves through the workspace when one exists
 * (the pre-F36 attribution path), and only falls to the 'default' tenant when
 * there is no workspace to inherit from. 'default'-only rows are the box's
 * own unattributed legacy boards (F01-D2 posture): a verified non-default
 * company never owns them.
 */
export function assertCampaignOwnedByCompany(
  campaign: { id: string; workspace_id?: string | null; company_id?: string | null } | null | undefined,
  companyId: string,
): { owned: boolean } {
  if (!campaign) return { owned: false };
  const campaignCompany = (campaign.company_id || '').trim();
  if (campaignCompany && campaignCompany !== 'default') {
    return { owned: campaignCompany === companyId };
  }
  // 'default' or absent attribution: the workspace decides when present.
  if (campaign.workspace_id) {
    try {
      const row = getDb()
        .prepare('SELECT company_id FROM workspaces WHERE id = ?')
        .get(campaign.workspace_id) as { company_id: string | null } | undefined;
      const wsCompany = row?.company_id || 'default';
      if (wsCompany === 'default' && companyId !== 'default') return { owned: false };
      return { owned: wsCompany === companyId };
    } catch {
      return { owned: false };
    }
  }
  return { owned: companyId === 'default' };
}

/**
 * Resolve the authenticated company for a campaigns-API request. Same tenant
 * chain as the publish route (bearer MC_API_TOKEN / signed tenant session /
 * CF Access JWT). In non-production with no tenant configured, falls back to
 * the box's active company (resolveActiveCompanyId) or 'default' so the
 * dashboard keeps working on single-tenant boxes that have no registry.
 */
export async function resolveCampaignsCompany(
  request: { headers: Headers },
): Promise<PublishCompanyResult> {
  try {
    const tenant = await resolveTenantContext(request);
    if (tenant.companyId) {
      return {
        ok: true,
        company: { companyId: tenant.companyId, tenant, ghlLocationId: companyGhlLocationId(tenant.companyId) },
      };
    }
  } catch (error) {
    if (!(error instanceof TenantAccessError)) throw error;
    // Unauthenticated in production → 403 (no identity, no board).
    if (process.env.NODE_ENV === 'production') {
      return { ok: false, status: 403, error: 'Verified company identity required' };
    }
  }
  if (process.env.NODE_ENV === 'production') {
    return { ok: false, status: 403, error: 'Verified company identity required' };
  }
  // Dev fallback: the box's own active company (single-tenant board).
  const { resolveActiveCompanyId } = await import('@/lib/company');
  const dev = getDb();
  const active = resolveActiveCompanyId(dev) || 'default';
  return {
    ok: true,
    company: {
      companyId: active,
      tenant: {
        tenantId: 'self', companyId: active, clientId: null, kind: 'self',
        subject: 'local:dashboard', host: '', installationId: 'local',
      },
      ghlLocationId: companyGhlLocationId(active),
    },
  };
}

let socialTablesEnsured = false;
/**
 * Create the two F01 binding tables when missing. Kept idempotent and lazy so
 * the publish route works on any box that has run migration 135 without
 * requiring a separate provisioning step.
 */
export function ensureSocialBindingTables(): void {
  if (socialTablesEnsured) return;
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS company_ghl_bindings (
    company_id TEXT PRIMARY KEY,
    ghl_location_id TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS social_sheet_registry (
    company_id TEXT NOT NULL,
    planner_kind TEXT NOT NULL,
    sheet_id TEXT NOT NULL,
    sheet_url TEXT,
    schema_version TEXT,
    sharing TEXT,
    verified_at TEXT,
    PRIMARY KEY (company_id, planner_kind)
  )`);
  socialTablesEnsured = true;
}