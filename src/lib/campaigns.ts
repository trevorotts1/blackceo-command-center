/**
 * campaigns.ts — campaign-board feed (W8.4 — "wire the board so nothing sticks").
 *
 * PROBLEM (W8):
 *   The campaign Kanban (`/campaigns/[id]`) is the board the spec calls "the
 *   board", but it had ZERO data: `campaigns` had 0 rows and `tasks.campaign_id`
 *   was NULL on every task. Routing produced cards but never fed them to a
 *   campaign, so routed work (e.g. a routed deck) never appeared on — let alone
 *   moved across — the board.
 *
 * FIX:
 *   Every task that lands with a resolvable home (workspace or department) is
 *   attached to a single durable "<Department> Board" campaign for that home.
 *   The card then renders on that campaign's Kanban and advances lane-by-lane as
 *   the task's status changes (the page maps status → column live). This is the
 *   data feed the board always lacked.
 *
 * IDEMPOTENT BY CONSTRUCTION:
 *   The board campaign id is deterministic — `board-<workspaceOrDeptSlug>` — so a
 *   second create is an `INSERT OR IGNORE` no-op and a task is only ever attached
 *   once (the UPDATE is guarded on `campaign_id IS NULL`). Safe to call from
 *   create, route, and re-home paths without producing duplicate campaigns or
 *   churning `updated_at` (the attach never bumps the task's `updated_at`, so the
 *   dispatcher's grace/backoff windows are untouched).
 *
 * Disable with CAMPAIGN_BOARD_FEED_DISABLED=1 (leaves campaign_id NULL — the
 * board simply stays empty, exactly as before this wiring).
 */

import { run } from '@/lib/db';
import { canonicalDeptSlug } from '@/lib/routing/canonical-slug';

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

  // Resolve the grouping key: prefer the explicit workspace id (the campaign
  // page filters tasks per campaign, not per workspace, so the key is only used
  // to make the campaign deterministic + named). Fall back to the canonical
  // department slug when no workspace is known.
  const deptSlug = opts.department ? canonicalDeptSlug(opts.department) : null;
  const key = (opts.workspaceId && opts.workspaceId.trim()) || deptSlug || null;
  if (!key) return null;

  const campaignId = `board-${key}`;
  const label = humanizeLabel(deptSlug || opts.workspaceId || key);
  const now = new Date().toISOString();

  try {
    // Find-or-create the board campaign (deterministic id → idempotent).
    run(
      `INSERT OR IGNORE INTO campaigns
         (id, name, description, status, department_ids, workspace_id, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`,
      [
        campaignId,
        `${label} Board`,
        `Live work board for ${label}. Cards appear and advance here as tasks are routed and dispatched.`,
        JSON.stringify(deptSlug ? [deptSlug] : []),
        opts.workspaceId || null,
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
