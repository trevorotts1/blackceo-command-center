/**
 * PBB-128 / T-32 — DB half of the campaign approval/publication view.
 *
 * Reads the REAL rows the projection needs and writes ONLY two things:
 *   • a `campaign_command_receipts` row (this module's own audit surface), and
 *   • for `hold_placement`, `stopCardPermanently()` — the repo's terminal-stop
 *     chokepoint, which flips the card to `blocked` through the canonical
 *     lifecycle transition AND writes block_reason, the machine detail and
 *     exactly one owner notice. Parking the card with a bare lifecycle
 *     transition to `blocked` is the silent stop
 *     `scripts/guard-silent-terminal-stops.ts` rejects: the card would stop and
 *     nobody would be told.
 *
 * It deliberately has NO publish, enqueue, dispatch or provider import. The
 * campaign approval view can approve a manifest and hold one placement; it
 * cannot send anything. `retry_failed_step`, `handoff`, `pause_surface` and
 * friends are refused before they reach this file (see approval-contract.ts).
 *
 * Tables are created lazily (PRAGMA/CREATE IF NOT EXISTS, the same pattern
 * `ensureCampaignCompanyColumn` and `ensureSocialBindingTables` already use),
 * so no migration id is consumed and no existing file is edited.
 *
 * SERVER-ONLY.
 */
import { v4 as uuidv4 } from 'uuid';
import { getDb, queryAll, queryOne, run, transaction } from '@/lib/db';
import { flipApprovedPlacementRows } from '@/lib/social/publish-approval';
import { loadLifecycleEvents } from '@/lib/board/lifecycle-projection';
import {
  ensureCampaignCompanyColumn,
  assertCampaignOwnedByCompany,
} from '@/lib/social/company-context';
import { stopCardPermanently } from '@/lib/stop-card';
import type { LifecycleState } from '@/lib/task-lifecycle';
import {
  buildCampaignApprovalView,
  currentRevision,
  decideCommand,
  resolveCalendarStaleAfterMs,
  validateCommand,
  type CampaignApprovalView,
  type CampaignSource,
  type CampaignTaskSource,
  type CommandReceipt,
  type PublishQueueSource,
} from './approval-contract';

export const RECEIPT_TABLE = 'campaign_command_receipts';

let tablesEnsured = false;

/** Idempotent lazy DDL. Separate table, no migration id consumed. */
export function ensureCampaignCommandTables(): boolean {
  if (tablesEnsured) return true;
  try {
    // The campaign read joins the F36 company column; it is created lazily by
    // the shared campaign-context helper (no migration id consumed).
    ensureCampaignCompanyColumn();
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS ${RECEIPT_TABLE} (
      command_id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      campaign_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      expected_revision INTEGER NOT NULL,
      applied_revision INTEGER,
      state TEXT NOT NULL CHECK (state IN ('applied', 'refused')),
      refusal_code TEXT,
      reason TEXT NOT NULL,
      payload_json TEXT,
      submitted_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_campaign_command_campaign
      ON ${RECEIPT_TABLE}(company_id, campaign_id, recorded_at DESC)`);
    // The revision CAS: two commands at the same revision cannot both apply.
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_command_revision
      ON ${RECEIPT_TABLE}(company_id, campaign_id, applied_revision)
      WHERE applied_revision IS NOT NULL`);
    tablesEnsured = true;
    return true;
  } catch {
    return false;
  }
}

const RECEIPT_COLUMNS =
  'command_id, company_id, campaign_id, action, target_type, target_id, expected_revision, ' +
  'applied_revision, state, refusal_code, reason, payload_json, submitted_at, recorded_at';

export function loadReceipts(companyId: string, campaignId: string): CommandReceipt[] {
  if (!ensureCampaignCommandTables()) return [];
  try {
    return queryAll<CommandReceipt>(
      `SELECT ${RECEIPT_COLUMNS} FROM ${RECEIPT_TABLE}
        WHERE company_id = ? AND campaign_id = ?
        ORDER BY recorded_at ASC, command_id ASC`,
      [companyId, campaignId],
    );
  } catch {
    return [];
  }
}

interface CampaignRow {
  id: string;
  name: string;
  company_id?: string | null;
  workspace_id?: string | null;
  start_date?: string | null;
  target_date?: string | null;
}

export function loadCampaign(campaignId: string, companyId: string): CampaignRow | null {
  ensureCampaignCompanyColumn();
  try {
    const row = queryOne<CampaignRow>(
      `SELECT id, name, company_id, workspace_id, start_date, target_date
         FROM campaigns WHERE id = ?`,
      [campaignId],
    );
    if (!row) return null;
    return assertCampaignOwnedByCompany(row, companyId).owned ? row : null;
  } catch {
    return null;
  }
}

export function loadCampaignTasks(campaignId: string): CampaignTaskSource[] {
  try {
    return queryAll<CampaignTaskSource>(
      `SELECT id, title, description, status, due_date, updated_at, campaign_id
         FROM tasks WHERE campaign_id = ? ORDER BY due_date ASC, id ASC`,
      [campaignId],
    );
  } catch {
    return [];
  }
}

/** Real publish_queue rows for these tasks. Absent table → no receipts. */
export function loadPublishRows(taskIds: readonly string[]): PublishQueueSource[] {
  const ids = Array.from(new Set(taskIds.filter((id) => typeof id === 'string' && id.length > 0)));
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  try {
    return queryAll<PublishQueueSource>(
      `SELECT id, task_id, cc_task_id, company_id, platforms, status, error,
              attempt_count, completed_at, updated_at
         FROM publish_queue
        WHERE task_id IN (${placeholders}) OR cc_task_id IN (${placeholders})`,
      [...ids, ...ids],
    );
  } catch {
    // A box before migration 026 has no publish_queue: every placement is
    // UNKNOWN('no_publication_receipt'), which is the truthful answer.
    return [];
  }
}

export interface CampaignApprovalSnapshot {
  campaign: CampaignSource;
  tasks: CampaignTaskSource[];
  publishRows: PublishQueueSource[];
  receipts: CommandReceipt[];
  view: CampaignApprovalView;
}

/**
 * The whole read model for one campaign. `null` when the campaign does not
 * exist OR belongs to another company (callers answer 404 either way, so the
 * two cases are indistinguishable to a caller).
 */
export function loadCampaignApprovalSnapshot(
  campaignId: string,
  companyId: string,
  options: { now?: number | string | Date; staleAfterMs?: number } = {},
): CampaignApprovalSnapshot | null {
  const campaign = loadCampaign(campaignId, companyId);
  if (!campaign) return null;
  const tasks = loadCampaignTasks(campaignId);
  const publishRows = loadPublishRows(tasks.map((task) => task.id));
  const receipts = loadReceipts(companyId, campaignId);
  const events = loadLifecycleEvents(tasks.map((task) => task.id));
  const view = buildCampaignApprovalView({
    campaign,
    tasks,
    publishRows,
    events,
    receipts,
    now: options.now,
    staleAfterMs: options.staleAfterMs ?? resolveCalendarStaleAfterMs(),
  });
  return { campaign, tasks, publishRows, receipts, view };
}

export type ApplyResult =
  | { ok: true; receipt: CommandReceipt }
  | { ok: false; code: string; reason: string; status: 400 | 404 | 409; receipt: CommandReceipt | null };

function recordReceipt(row: Omit<CommandReceipt, 'recorded_at'> & { recorded_at: string }): CommandReceipt {
  ensureCampaignCommandTables();
  run(
    `INSERT INTO ${RECEIPT_TABLE} (${RECEIPT_COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(command_id) DO NOTHING`,
    [
      row.command_id,
      row.company_id,
      row.campaign_id,
      row.action,
      row.target_type,
      row.target_id,
      row.expected_revision,
      row.applied_revision,
      row.state,
      row.refusal_code,
      row.reason,
      row.payload_json,
      row.submitted_at,
      row.recorded_at,
    ],
  );
  const stored = queryOne<CommandReceipt>(
    `SELECT ${RECEIPT_COLUMNS} FROM ${RECEIPT_TABLE} WHERE command_id = ?`,
    [row.command_id],
  );
  if (!stored) throw new Error(`campaign command receipt ${row.command_id} was not persisted`);
  return stored;
}

function refused(
  command: {
    command_id: string;
    tenant_id: string;
    actor_id: string;
    action: string;
    target_type: string;
    target_id: string;
    expected_revision: number;
    submitted_at: string;
  },
  campaignId: string,
  code: string,
  reason: string,
  /** The VERIFIED company is the audit owner — a command claiming another
   * tenant is recorded where the campaign's owner can see it. */
  companyId: string,
): CommandReceipt {
  return recordReceipt({
    command_id: command.command_id,
    company_id: companyId,
    campaign_id: campaignId,
    action: command.action,
    target_type: command.target_type,
    target_id: command.target_id,
    expected_revision: command.expected_revision,
    applied_revision: null,
    state: 'refused',
    refusal_code: code,
    reason,
    payload_json: null,
    submitted_at: command.submitted_at,
    recorded_at: new Date().toISOString(),
  });
}

/**
 * Apply ONE campaign command.
 *
 * Order for a hold is effect-then-receipt: `transition()` is the real state
 * change and it must be allowed to refuse (illegal/CAS/WIP) BEFORE anything is
 * recorded as applied. A crash between the two leaves the task visibly blocked
 * with its own `task_events` row and no receipt — visible, never a silent
 * "applied" claim.
 */
export async function applyCampaignCommand(raw: unknown, companyId: string): Promise<ApplyResult> {
  const validated = validateCommand(raw);
  if (!validated.ok) {
    return { ok: false, code: validated.code, reason: validated.reason, status: 400, receipt: null };
  }
  const command = validated.command;

  // This view applies exactly two actions. Everything else is refused here,
  // BEFORE any campaign is read, so no other cc-command action can be routed
  // through the calendar by bending its target fields.
  if (command.action !== 'approve_campaign' && command.action !== 'hold_placement') {
    return {
      ok: false,
      code: 'action_not_available_in_view',
      reason: `action ${command.action} is not available from the campaign approval view (no send/dispatch path here)`,
      status: 400,
      receipt: null,
    };
  }

  if (command.action === 'approve_campaign' && command.target_type !== 'campaign') {
    return { ok: false, code: 'target_mismatch', reason: 'approve_campaign must target a campaign', status: 400, receipt: null };
  }
  if (command.action === 'hold_placement' && command.target_type !== 'placement') {
    return { ok: false, code: 'target_mismatch', reason: 'hold_placement must target a placement', status: 400, receipt: null };
  }

  const campaignId = command.action === 'approve_campaign' ? command.target_id : campaignOfPlacement(command.target_id);
  if (!campaignId) {
    return {
      ok: false,
      code: 'target_not_found',
      reason: 'placement is not part of any campaign',
      status: 404,
      receipt: null,
    };
  }
  const campaign = loadCampaign(campaignId, companyId);
  if (!campaign) {
    return { ok: false, code: 'target_not_found', reason: 'campaign not found for this company', status: 404, receipt: null };
  }

  const tasks = loadCampaignTasks(campaignId);
  const publishRows = loadPublishRows(tasks.map((task) => task.id));
  const receipts = loadReceipts(companyId, campaignId);

  const decision = decideCommand({ command, companyId, campaign, tasks, publishRows, receipts });
  if (!decision.ok) {
    const receipt = refused(command, campaignId, decision.code, decision.reason, companyId);
    const status: 400 | 409 = decision.code === 'revision_conflict' ? 409 : 400;
    return { ok: false, code: decision.code, reason: decision.reason, status, receipt };
  }

  let payload: string;
  if (decision.effect.kind === 'hold') {
    const taskId = decision.effect.task_id;
    const current = tasks.find((candidate) => candidate.id === taskId);
    // NO-SILENT-STOP: a hold parks this placement in `blocked` until a person
    // answers — a card that will not move again on its own, which is exactly
    // what this repo's terminal-stop doctrine means by a permanent stop. The
    // chokepoint writes block_reason and the machine detail, stamps the notice
    // claim and sends exactly one notice to the owner. A bare transition() to
    // 'blocked' here is the silent stop scripts/guard-silent-terminal-stops.ts
    // rejects, and it left the owner with no block_reason and no notice.
    // `applyBlock` stays on so the chokepoint owns the write and its CAS.
    const stopped = await stopCardPermanently({
      taskId,
      source: command.actor_id,
      reason: `This campaign placement is on hold and cannot go out until you release it.`,
      needs: `Review the hold on this placement (${command.purpose}) and answer before it resumes.`,
      audience: 'OWNER',
      machineDetail: `campaign_approval_hold:${command.purpose}`.slice(0, 500),
      expectedFrom: (current?.status as LifecycleState | undefined) ?? undefined,
    });
    if (!stopped.blocked) {
      // The chokepoint never throws: a lost CAS or a vanished row both come
      // back as `blocked: false`, and the two are told apart by the load above.
      const refusalCode = current ? 'placement_state_changed' : 'target_not_found';
      const receipt = refused(command, campaignId, refusalCode, `hold refused (${refusalCode})`, companyId);
      return {
        ok: false,
        code: refusalCode,
        reason:
          refusalCode === 'target_not_found'
            ? 'campaign not found for this company'
            : 'placement changed before the hold was applied',
        status: refusalCode === 'target_not_found' ? 404 : 409,
        receipt,
      };
    }
    payload = JSON.stringify({ task_id: taskId, to_status: 'blocked' });
  } else {
    payload = JSON.stringify(decision.effect.payload);
  }

  try {
    // C3 (PBB-917 / T-54) — the receipt and the queue release are ONE
    // transaction: an approved placement becomes claimable exactly when, and
    // only when, its approval receipt commits. A crash cannot leave an approval
    // recorded with nothing released, or a released row with no receipt.
    const receipt = transaction(() => {
      const applied = recordReceipt({
        command_id: command.command_id,
        company_id: companyId,
        campaign_id: campaignId,
        action: command.action,
        target_type: command.target_type,
        target_id: command.target_id,
        expected_revision: command.expected_revision,
        applied_revision: decision.applied_revision,
        state: 'applied',
        refusal_code: null,
        reason: command.purpose,
        payload_json: payload,
        submitted_at: command.submitted_at,
        recorded_at: new Date().toISOString(),
      });
      if (applied.state === 'applied' && decision.effect.kind === 'approve') {
        flipApprovedPlacementRows({
          companyId,
          campaignId,
          placements: decision.effect.payload.placements,
          tasks,
          publishRows,
        });
      }
      return applied;
    });
    if (receipt.state === 'refused') {
      // Same command_id already recorded as refused → report that, never a
      // second "applied" claim for one command.
      return { ok: false, code: receipt.refusal_code ?? 'revision_conflict', reason: receipt.reason, status: 409, receipt };
    }
    return { ok: true, receipt };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/UNIQUE/.test(message)) {
      const now = currentRevision(loadReceipts(companyId, campaignId));
      return {
        ok: false,
        code: 'revision_conflict',
        reason: `another command applied revision ${decision.applied_revision}; campaign is now at ${now}`,
        status: 409,
        receipt: null,
      };
    }
    throw error;
  }
}

/** hold_placement names a placement; its campaign comes from the real task row. */
function campaignOfPlacement(placementId: string): string | null {
  try {
    const row = queryOne<{ campaign_id: string | null }>(
      'SELECT campaign_id FROM tasks WHERE id = ?',
      [placementId],
    );
    return row?.campaign_id ?? null;
  } catch {
    return null;
  }
}
