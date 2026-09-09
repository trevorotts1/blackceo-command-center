/**
 * campaigns.ts — campaign-board feed (W8.4 + F36 company binding).
 *
 * PROBLEM (W8): the campaign Kanban had zero data; every routed task now
 * attaches to a durable per-home board campaign and advances lane-by-lane.
 *
 * F36 — COMPANY BINDING: the original grouping key fell back to the
 * department slug ALONE when no workspace was known, so two companies with
 * the same department slug ("marketing") shared ONE board campaign — a
 * cross-client leak through the fallback path. The key is now
 * COMPANY-SCOPED: `<company_id>:<workspaceOrDept>` so two companies with
 * identical department slugs never share a campaign, and every campaign row
 * carries the owning company_id. Company ownership is enforced in the
 * list/detail/update routes (see src/app/api/campaigns/*).
 *
 * IDEMPOTENT BY CONSTRUCTION: the campaign id is deterministic —
 * `board-<company>:<workspaceOrDeptSlug>` — so a second create is an
 * `INSERT OR IGNORE` no-op and a task is only attached once (the UPDATE is
 * guarded on `campaign_id IS NULL`). The attach never bumps tasks.updated_at,
 * so dispatcher grace/backoff windows are untouched.
 *
 * Disable with CAMPAIGN_BOARD_FEED_DISABLED=1 (leaves campaign_id NULL — the
 * board simply stays empty, exactly as before this wiring).
 *
 * MIGRATION NOTE (documented for WF00, no migration id consumed): the
 * company_id column on campaigns is added lazily via ensureCampaignCompanyColumn()
 * (PRAGMA-guarded ALTER, same pattern migration 135 used for publish_queue) so
 * pre-existing boards keep working without a DDL migration in this branch.
 */

import { getDb, run } from '@/lib/db';
import { canonicalDeptSlug } from '@/lib/routing/canonical-slug';

/** The fallback company for rows that predate company attribution. */
export const DEFAULT_COMPANY_ID = 'default';

let companyColumnEnsured = false;

/**
 * PRAGMA-guarded lazy ALTER adding campaigns.company_id. Mirrors migration
 * 135's publish_queue shape (TEXT DEFAULT 'default'). Best-effort: a failure
 * only degrades company scoping to legacy rows, never breaks task creation.
 */
export function ensureCampaignCompanyColumn(): void {
  if (companyColumnEnsured) return;
  try {
    const db = getDb();
    const info = db.prepare('PRAGMA table_info(campaigns)').all() as { name: string }[];
    if (Array.isArray(info) && info.length > 0 && !info.some((c) => c.name === 'company_id')) {
      db.exec(`ALTER TABLE campaigns ADD COLUMN company_id TEXT DEFAULT 'default'`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_campaigns_company ON campaigns(company_id)`);
    }
    companyColumnEnsured = true;
  } catch {
    // Pre-migration DB (no campaigns table) — retry on the next call.
  }
}

/** Title-case a slug/department for a human-readable campaign name. */
function humanizeLabel(raw: string): string {
  const cleaned = raw.replace(/^dept-/, '').replace(/[-_]+/g, ' ').trim();
  if (!cleaned) return 'Workspace';
  return cleaned
    .split(' ')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

export interface CampaignAttachOptions {
  workspaceId?: string | null;
  department?: string | null;
  title?: string | null;
  /**
   * F36: the owning company. Falls back to the workspace's company_id, then
   * 'default'. Two companies with the same department slug get DISTINCT
   * campaign ids because the company is part of the deterministic key.
   */
  companyId?: string | null;
}

/**
 * Resolve the company a campaign home belongs to. Preference order:
 * explicit companyId → the workspace's workspaces.company_id → 'default'.
 * The workspace join is the same canonical one company-context.ts uses for
 * task ownership.
 */
export function resolveCampaignCompanyId(
  opts: Pick<CampaignAttachOptions, 'workspaceId' | 'companyId'>,
): string {
  if (opts.companyId && String(opts.companyId).trim()) return String(opts.companyId).trim();
  if (opts.workspaceId && String(opts.workspaceId).trim()) {
    try {
      const db = getDb();
      const row = db
        .prepare('SELECT company_id FROM workspaces WHERE id = ?')
        .get(String(opts.workspaceId).trim()) as { company_id: string | null } | undefined;
      if (row?.company_id) return row.company_id;
    } catch {
      // fall through to default
    }
  }
  return DEFAULT_COMPANY_ID;
}

/**
 * The deterministic company-scoped campaign id.
 * `board-<companyId>:<workspaceId|deptSlug>` — the company prefix is what
 * makes two same-slug departments at two companies never collide.
 */
export function campaignKeyFor(opts: {
  workspaceId?: string | null;
  department?: string | null;
  companyId?: string | null;
}): { campaignId: string; companyId: string; key: string; deptSlug: string | null } | null {
  const deptSlug = opts.department ? canonicalDeptSlug(opts.department) : null;
  const key = (opts.workspaceId && opts.workspaceId.trim()) || deptSlug || null;
  if (!key) return null;
  const companyId = resolveCampaignCompanyId(opts);
  return { campaignId: `board-${companyId}:${key}`, companyId, key, deptSlug };
}

/**
 * Find-or-create the durable board campaign for a task's home, then attach the
 * task to it. Returns the campaign id, or null when there is no resolvable home
 * (no workspace and no department) so the caller leaves campaign_id NULL.
 *
 * Best-effort: never throws — a board-feed failure must never break task
 * creation, routing, or dispatch.
 */
export function ensureCampaignForTask(
  taskId: string,
  opts: CampaignAttachOptions,
): string | null {
  if (process.env.CAMPAIGN_BOARD_FEED_DISABLED === '1') return null;

  const resolved = campaignKeyFor(opts);
  if (!resolved) return null;
  const { campaignId, companyId, key, deptSlug } = resolved;
  const label = humanizeLabel(deptSlug || key);
  const now = new Date().toISOString();

  try {
    ensureCampaignCompanyColumn();

    // Find-or-create the board campaign (deterministic id → idempotent).
    run(
      `INSERT OR IGNORE INTO campaigns
         (id, name, description, status, department_ids, workspace_id, company_id, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
      [
        campaignId,
        `${label} Board`,
        `Live work board for ${label}. Cards appear and advance here as tasks are routed and dispatched.`,
        JSON.stringify(deptSlug ? [deptSlug] : []),
        opts.workspaceId || null,
        companyId,
        now,
        now,
      ],
    );

    // Attach the task ONCE. Deliberately does NOT touch tasks.updated_at so the
    // dispatcher's grace + backoff windows are not reset by a board attach.
    run(
      `UPDATE tasks SET campaign_id = ?
       WHERE id = ? AND (campaign_id IS NULL OR campaign_id = '')`,
      [campaignId, taskId],
    );
  } catch (err) {
    // Pre-migration DB (no campaigns table / campaign_id column) or any other
    // failure: never break the calling path.
    console.warn('[campaigns] ensureCampaignForTask non-fatal:', (err as Error).message);
    return null;
  }

  return campaignId;
}