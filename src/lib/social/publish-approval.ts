/**
 * PBB-917 / T-54 (review C3) — the approval gate between a campaign placement
 * and the publish queue.
 *
 * PROBLEM (review C3): `POST /api/skill-35/publish` inserted a `queued` row
 * with no approval check and the dispatcher claimed every `queued` row, so an
 * owner approval never controlled publication. The order was also backwards:
 * a placement became approvable only after a publish row existed, and the
 * dispatcher claimed that row on its next sweep.
 *
 * CONTRACT IMPLEMENTED HERE:
 *   • a campaign placement is enqueued as `awaiting_approval` (never claimed);
 *   • approving the campaign flips the approved placements to `queued` inside
 *     the same transaction that records the approval receipt;
 *   • a placement whose fingerprint changed (INVALIDATED) goes back to
 *     `awaiting_approval` before the next sweep;
 *   • the dispatcher keeps `awaiting_approval` out of its claim query (it is
 *     not in `queued|retrying`) and refuses any unapproved row that still
 *     reaches it (defense in depth).
 *
 * Columns are added lazily (PRAGMA/CREATE pattern already used by
 * `ensureCampaignCompanyColumn`), so no migration id is consumed.
 *
 * SERVER-ONLY.
 */
import { getDb, queryOne } from '@/lib/db';
import {
  newestPublishRow,
  placementFingerprint,
  type CampaignTaskSource,
  type PlacementView,
  type PublishQueueSource,
} from '@/lib/campaigns/approval-contract';

export const AWAITING_APPROVAL = 'awaiting_approval' as const;

/** Client-facing board vocabulary (item 6 of the C3 Exactly-how). */
export const AWAITING_APPROVAL_LABEL = 'Waiting for your approval';

let columnsEnsured = false;

/** Idempotent lazy DDL: publish_queue gains campaign_id + placement_id. */
export function ensurePublishQueueApprovalColumns(): boolean {
  if (columnsEnsured) return true;
  try {
    const db = getDb();
    const info = db.prepare('PRAGMA table_info(publish_queue)').all() as { name: string }[];
    const names = new Set(info.map((column) => column.name));
    if (!names.has('campaign_id')) db.exec(`ALTER TABLE publish_queue ADD COLUMN campaign_id TEXT`);
    if (!names.has('placement_id')) db.exec(`ALTER TABLE publish_queue ADD COLUMN placement_id TEXT`);
    columnsEnsured = true;
    return true;
  } catch {
    return false;
  }
}

/**
 * The campaign identity of the task a publish intent is queued for. A task with
 * no campaign is an ordinary (non-Purple) publish and keeps the old `queued`
 * behaviour, so no other flow changes.
 */
export function taskCampaignContext(
  taskId: string | null,
): { campaignId: string | null; placementId: string | null } {
  if (!taskId) return { campaignId: null, placementId: null };
  try {
    const row = queryOne<{ id: string; campaign_id: string | null }>(
      'SELECT id, campaign_id FROM tasks WHERE id = ?',
      [taskId],
    );
    if (!row?.campaign_id) return { campaignId: null, placementId: null };
    return { campaignId: row.campaign_id, placementId: row.id };
  } catch {
    return { campaignId: null, placementId: null };
  }
}

/** The exact refusal token the C3 order names: `unapproved_placement:<id>@rev<n>`. */
export function unapprovedPlacementError(placementId: string, revision: number): string {
  return `unapproved_placement:${placementId}@rev${revision}`;
}

export interface PlacementGate {
  approved: boolean;
  state: string;
  reason: string;
  revision: number;
}

/**
 * Read one placement's approval truth from the campaign snapshot. Anything the
 * snapshot cannot prove (absent campaign, absent placement, absent receipt) is
 * NOT approved — the gate never defaults open.
 */
export function placementGateFromSnapshot(
  snapshot: { view: { revision: number; placements: readonly PlacementView[] } } | null,
  placementId: string,
): PlacementGate {
  if (!snapshot) return { approved: false, state: 'UNKNOWN', reason: 'campaign_not_found', revision: 0 };
  const view = snapshot.view;
  const placement = view.placements.find((candidate) => candidate.placement_id === placementId);
  if (!placement) {
    return { approved: false, state: 'UNKNOWN', reason: 'placement_not_in_campaign', revision: view.revision };
  }
  return {
    approved: placement.approval_state === 'APPROVED',
    state: placement.approval_state,
    reason: placement.approval_reason,
    revision: view.revision,
  };
}

/**
 * Flip `awaiting_approval` rows to `queued` for the placements approved at
 * their CURRENT fingerprint. Called INSIDE the receipt transaction so an
 * approval and the queue release commit together (or neither does).
 *
 * Fingerprints are recomputed from the same rows the approval was derived
 * from; a placement whose content changed between decide and commit does not
 * release.
 */
export function flipApprovedPlacementRows(args: {
  companyId: string;
  campaignId: string;
  placements: readonly { placement_id: string; fingerprint: string }[];
  tasks: readonly CampaignTaskSource[];
  publishRows: readonly PublishQueueSource[];
  now?: string;
}): { flipped: number; skipped: string[] } {
  if (!ensurePublishQueueApprovalColumns()) return { flipped: 0, skipped: ['publish_queue_columns_unavailable'] };
  const db = getDb();
  const now = args.now ?? new Date().toISOString();
  const taskById = new Map(args.tasks.map((task) => [task.id, task]));
  const statement = db.prepare(
    `UPDATE publish_queue SET status = 'queued', error = NULL, updated_at = ?
      WHERE company_id = ? AND placement_id = ? AND status = 'awaiting_approval'
        AND (campaign_id IS NULL OR campaign_id = ?)`,
  );
  let flipped = 0;
  const skipped: string[] = [];
  for (const approved of args.placements) {
    const task = taskById.get(approved.placement_id);
    if (!task) {
      skipped.push(approved.placement_id);
      continue;
    }
    const channel = newestPublishRow(args.publishRows, task.id)?.platforms ?? null;
    if (placementFingerprint(task, channel) !== approved.fingerprint) {
      skipped.push(approved.placement_id);
      continue;
    }
    const result = statement.run(now, args.companyId, approved.placement_id, args.campaignId);
    flipped += result.changes;
  }
  return { flipped, skipped };
}
