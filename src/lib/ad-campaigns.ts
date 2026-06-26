/**
 * ad-campaigns.ts — Skill 48 (facebook-ad-generator) → Command Center board.
 *
 * An external producer (the OpenClaw Skill 48 assembly line) drives a 10-stage
 * Facebook/Instagram ad run with two human pause points. This module lands that
 * run on the existing Kanban board as a campaign + one card per stage, and moves
 * those cards through the lifecycle as the run progresses.
 *
 * DESIGN CONSTRAINTS (why this looks the way it does):
 *   - CREATE uses a DIRECT INSERT (mirrors POST /api/campaigns), NOT
 *     createTaskCore(): createTaskCore() auto-routes and fires autoDispatchTask()
 *     — a real OpenClaw invocation per card. For an externally-driven assembly
 *     line that would fire ~8 redundant agent runs and is wrong here.
 *   - MOVES go through the canonical `transition()` engine (legal-map enforced,
 *     task_events + SSE written), NOT through PATCH /api/tasks/[id]: that route
 *     adds a Triad gate, a QC auto-scorer on →review (which would auto-advance
 *     review→done and skip the human pause), and a blocked-authority gate. None
 *     of those apply to this pipeline.
 *   - `operatorOverride: true` is required on every move because ad cards have
 *     assigned_agent_id = NULL; the in_progress precondition would otherwise fail.
 *   - The OpenClaw `agent_id` is provenance ONLY. It is NEVER written to
 *     tasks.assigned_agent_id (an FK into the CC `agents` table — an external id
 *     would break the constraint). It lives in the card description.
 *
 * Idempotency: keyed on `job_id` (the Skill 48 receipt id == ledger run_id),
 * which becomes campaigns.id AND every tasks.campaign_id. Re-creating returns the
 * existing campaign + cards without writing or duplicating.
 */

import { v4 as uuidv4 } from 'uuid';
import { queryOne, queryAll, run, transaction } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { transition, TransitionError } from '@/lib/task-lifecycle';
import type { Task } from '@/lib/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AdCardStatus = 'backlog' | 'in_progress' | 'review' | 'blocked' | 'done';

export interface AdStageInput {
  slug: string;
  title?: string;
}

export interface CreateAdCampaignInput {
  job_id: string;
  show_name: string;
  owner?: string;
  department?: string;
  workspace?: string;
  agent_id?: string;
  money_ceiling_usd?: number;
  estimated_cost_usd?: number;
  show_date?: string;
  stages?: AdStageInput[];
}

export interface MoveAdStageInput {
  stage_slug: string;
  status: AdCardStatus;
  reason?: string | null;
  actor?: string | null;
  blocked_reason?: 'decision' | 'approval' | 'credential' | 'payment' | null;
  blocked_on_human?: 'owner' | 'operator' | null;
  ask?: string | null;
}

export interface StageRef {
  slug: string;
  id: string;
  status: string;
}

export interface CreateAdCampaignResult {
  ok: true;
  created: boolean;
  campaign_id: string;
  parent_id: string | null;
  stages: StageRef[];
}

/**
 * Domain error with an HTTP status hint, so the thin route layer can map cleanly
 * (validation / blocked-gate failures → 400, missing card → 404).
 */
export class AdCampaignError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AdCampaignError';
  }
}

// Default stage list when the producer does not pass `stages`. The producer
// SHOULD pass its own to stay authoritative; this keeps CC decoupled from
// Skill 48 internals while still giving stable slugs. (`epic` is the parent.)
export const DEFAULT_AD_STAGES: AdStageInput[] = [
  { slug: 's1-overlays', title: 'Stage 1 — Overlays' },
  { slug: 's2-bodies', title: 'Stage 2 — Bodies' },
  { slug: 's3-headlines', title: 'Stage 3 — Headlines' },
  { slug: 's4-prompts', title: 'Stage 4 — Prompts' },
  { slug: 's5-images', title: 'Stage 5 — Images' },
  { slug: 's6-adtext', title: 'Stage 6 — Ad text' },
  { slug: 's7-deliver', title: 'Stage 7 — Deliver' },
];

const EPIC_SLUG = 'epic';
const VALID_BLOCKED_REASONS = new Set(['decision', 'approval', 'credential', 'payment']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve a workspace slug/id/name → workspaces.id, or NULL (FK-safe). */
function resolveWorkspaceId(workspace?: string): string | null {
  if (!workspace) return null;
  const w = workspace.toLowerCase();
  const row = queryOne<{ id: string }>(
    'SELECT id FROM workspaces WHERE lower(slug) = ? OR lower(id) = ? OR lower(name) = ? LIMIT 1',
    [w, w, w],
  );
  return row?.id ?? null;
}

/** Build a provenance description string from create input (never holds secrets). */
function provenanceDescription(input: CreateAdCampaignInput, stageSlug: string): string {
  const lines = [
    `[fb-ad-run] stage=${stageSlug}`,
    `job_id=${input.job_id}`,
    `show=${input.show_name}`,
  ];
  if (input.owner) lines.push(`owner=${input.owner}`);
  if (input.department) lines.push(`department=${input.department}`);
  if (input.agent_id) lines.push(`source_agent=${input.agent_id}`); // provenance ONLY
  if (typeof input.money_ceiling_usd === 'number') lines.push(`money_ceiling_usd=${input.money_ceiling_usd}`);
  if (typeof input.estimated_cost_usd === 'number') lines.push(`estimated_cost_usd=${input.estimated_cost_usd}`);
  if (input.show_date) lines.push(`show_date=${input.show_date}`);
  return lines.join('\n');
}

/** Rebuild the StageRef list (non-epic cards) + parent epic id from the DB. */
function readStageRefs(jobId: string): { parentId: string | null; stages: StageRef[] } {
  const rows = queryAll<{ id: string; status: string; stage_slug: string | null }>(
    'SELECT id, status, stage_slug FROM tasks WHERE campaign_id = ? ORDER BY stage_slug',
    [jobId],
  );
  let parentId: string | null = null;
  const stages: StageRef[] = [];
  for (const r of rows) {
    if (r.stage_slug === EPIC_SLUG) {
      parentId = r.id;
    } else if (r.stage_slug) {
      stages.push({ slug: r.stage_slug, id: r.id, status: r.status });
    }
  }
  return { parentId, stages };
}

// ---------------------------------------------------------------------------
// createAdCampaign — create-only, idempotent on job_id
// ---------------------------------------------------------------------------

export function createAdCampaign(input: CreateAdCampaignInput): CreateAdCampaignResult {
  const jobId = input.job_id;

  // Idempotency: campaign row already exists → return it, write nothing.
  const existing = queryOne<{ id: string; status: string }>(
    'SELECT id, status FROM campaigns WHERE id = ?',
    [jobId],
  );
  if (existing) {
    const { parentId, stages } = readStageRefs(jobId);
    return { ok: true, created: false, campaign_id: jobId, parent_id: parentId, stages };
  }

  const workspaceId = resolveWorkspaceId(input.workspace);
  const department = input.department || 'marketing';
  const now = new Date().toISOString();

  // Build the card list: epic parent first, then one card per stage.
  const stageList = input.stages && input.stages.length > 0 ? input.stages : DEFAULT_AD_STAGES;
  const cardsToInsert: Array<{ id: string; slug: string; title: string }> = [];
  cardsToInsert.push({
    id: uuidv4(),
    slug: EPIC_SLUG,
    title: `FB Ad Run — ${input.show_name}`,
  });
  for (const stage of stageList) {
    cardsToInsert.push({
      id: uuidv4(),
      slug: stage.slug,
      title: stage.title || `${input.show_name} — ${stage.slug}`,
    });
  }

  const insertedTasks: Task[] = [];

  transaction(() => {
    // 1. Parent campaign row (FK target for tasks.campaign_id) — must exist first.
    run(
      `INSERT INTO campaigns (id, name, description, status, department_ids, start_date, target_date, workspace_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        jobId,
        `FB Ad Run — ${input.show_name}`,
        input.owner ? `Skill 48 Facebook ad run. owner=${input.owner}` : 'Skill 48 Facebook ad run.',
        'active',
        JSON.stringify([]),
        null,
        input.show_date || null,
        workspaceId,
        now,
        now,
      ],
    );

    // 2. One card per stage (+ epic parent). All start in `backlog`,
    //    assigned_agent_id NULL (FK-safe), provenance in description.
    for (const card of cardsToInsert) {
      run(
        `INSERT INTO tasks (id, title, description, status, priority, assigned_agent_id, created_by_agent_id, workspace_id, business_id, department, campaign_id, stage_slug, created_at, updated_at)
         VALUES (?, ?, ?, 'backlog', 'medium', NULL, NULL, ?, NULL, ?, ?, ?, ?, ?)`,
        [
          card.id,
          card.title,
          provenanceDescription(input, card.slug),
          workspaceId,
          department,
          jobId,
          card.slug,
          now,
          now,
        ],
      );

      // Legacy events row (live feed / existing queries) — mirrors createTaskCore.
      run(
        `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
         VALUES (?, 'task_created', NULL, ?, ?, ?)`,
        [uuidv4(), card.id, `FB ad card created: ${card.title}`, now],
      );

      const taskRow = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [card.id]);
      if (taskRow) insertedTasks.push(taskRow);
    }
  });

  // SSE broadcast AFTER the transaction commits (no broadcasts on rollback).
  for (const t of insertedTasks) {
    broadcast({ type: 'task_created', payload: t });
  }

  const { parentId, stages } = readStageRefs(jobId);
  return { ok: true, created: true, campaign_id: jobId, parent_id: parentId, stages };
}

// ---------------------------------------------------------------------------
// moveAdStage — move ONE stage card through the lifecycle via transition()
// ---------------------------------------------------------------------------

export async function moveAdStage(jobId: string, input: MoveAdStageInput): Promise<Task> {
  const actor = input.actor || 'skill48';
  const reason = input.reason ?? undefined;

  const card = queryOne<{ id: string; status: string }>(
    'SELECT id, status FROM tasks WHERE campaign_id = ? AND stage_slug = ?',
    [jobId, input.stage_slug],
  );
  if (!card) {
    throw new AdCampaignError(404, 'CARD_NOT_FOUND', `No card for job ${jobId} stage ${input.stage_slug}`);
  }

  const now = new Date().toISOString();

  if (input.status === 'blocked') {
    // Mirror the repo's blocked-column gate: a structured reason + a human ask.
    if (!input.blocked_reason || !VALID_BLOCKED_REASONS.has(input.blocked_reason)) {
      throw new AdCampaignError(
        400,
        'BLOCKED_REASON_REQUIRED',
        `status=blocked requires blocked_reason ∈ {decision,approval,credential,payment}`,
      );
    }
    if (!input.ask || input.ask.trim().length === 0) {
      throw new AdCampaignError(400, 'ASK_REQUIRED', 'status=blocked requires a non-empty ask');
    }
    run(
      'UPDATE tasks SET blocked_reason = ?, blocked_on_human = ?, ask = ?, last_progress_at = ? WHERE id = ?',
      [input.blocked_reason, input.blocked_on_human || 'operator', input.ask, now, card.id],
    );
    return transition(card.id, 'blocked', { actor, reason, operatorOverride: true });
  }

  // Leaving blocked → clear the blocked columns first (back to a clean card).
  // (input.status is already narrowed to non-'blocked' here: the blocked branch
  // above returns early, so reaching this point means status !== 'blocked'.)
  if (card.status === 'blocked') {
    run(
      'UPDATE tasks SET blocked_reason = NULL, blocked_on_human = NULL, ask = NULL WHERE id = ?',
      [card.id],
    );
  }

  const updated = await transition(card.id, input.status, { actor, reason, operatorOverride: true });

  // Epic done ⇒ the whole run is complete; reflect it on the campaign row.
  if (input.stage_slug === EPIC_SLUG && input.status === 'done') {
    run('UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ?', ['complete', now, jobId]);
  }

  return updated;
}

// ---------------------------------------------------------------------------
// getAdCampaign — poll helper
// ---------------------------------------------------------------------------

export function getAdCampaign(jobId: string): { campaign: unknown | null; cards: Task[] } {
  const campaign = queryOne('SELECT * FROM campaigns WHERE id = ?', [jobId]) ?? null;
  const cards = queryAll<Task>(
    'SELECT * FROM tasks WHERE campaign_id = ? ORDER BY stage_slug',
    [jobId],
  );
  return { campaign, cards };
}

export { TransitionError };
