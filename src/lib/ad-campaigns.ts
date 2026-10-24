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
 *
 * D14 (Skill 75 typed completion contract): a campaign carries a typed
 * contract/version (explicit `contract` at create, or the canonical 12-stage
 * inference — see resolveCampaignContract). For `skill75` campaigns the server
 * boundary REFUSES the campaign completion claim (epic → done flipping the
 * campaign row) unless required stages are complete, revision-bound approvals
 * cover the current artifact revisions, independent reviewer evidence exists
 * (self-approval rejected), final delivery evidence is registered AND
 * reachable, and the board's self-reported rows reconcile to the native
 * workflow census. The epic card's own lifecycle (legal map, FIX 25 evidence
 * gate) is unchanged — "an epic marked done can never complete the campaign"
 * is enforced on the completion claim. `legacy` campaigns — every supported
 * non-Skill-75 producer — keep their exact previous behavior. The named
 * consumer contract lives in work/S75-W08-U2/CONTRACT.md.
 */

import { v4 as uuidv4 } from 'uuid';
import { queryOne, queryAll, run, transaction } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { transition, TransitionError } from '@/lib/task-lifecycle';
import { recordBlockEvent } from '@/lib/block-events';
import { stopCardPermanently } from '@/lib/stop-card';
import { isBlankAsk } from '@/lib/blocked-ask';
import { collectCompletionEvidence } from '@/lib/completion-evidence';
import { normalizeRequesterSessionKey } from '@/lib/requester-session';
import {
  SKILL75_TYPED_CONTRACT,
  LEGACY_CONTRACT,
  SKILL75_REQUIRED_APPROVAL_KINDS,
  formatContractMarker,
  parseContractMarker,
  isCanonicalSkill75StageSet,
  parseSkill75Envelope,
  type CampaignContract,
  type Skill75ApprovalEnvelope,
  type Skill75ReviewEnvelope,
  type Skill75NativeCensusEnvelope,
  type Skill75Envelope,
} from '@/lib/validation';
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
  /** Optional epic title prefix; default 'FB Ad Run' when absent. */
  title_prefix?: string;
  money_ceiling_usd?: number;
  estimated_cost_usd?: number;
  show_date?: string;
  stages?: AdStageInput[];
  /**
   * D14 — typed completion contract/version. Absent = resolved by the
   * canonical-stage inference (see resolveCampaignContract); `legacy` keeps the
   * exact pre-D14 behavior for every non-Skill-75 producer.
   */
  contract?: CampaignContract | null;
  /**
   * D14 — the run's canonical origin record (spec 5.4), stamped onto every
   * campaign card so report-back returns to the recorded requester
   * conversation instead of a global owner Telegram destination.
   */
  requester_channel?: string | null;
  requester_chat_id?: string | null;
  requester_session_key?: string | null;
}

export interface MoveAdStageInput {
  stage_slug: string;
  status: AdCardStatus;
  reason?: string | null;
  actor?: string | null;
  blocked_reason?: 'decision' | 'approval' | 'credential' | 'payment' | null;
  blocked_on_human?: 'owner' | 'operator' | null;
  ask?: string | null;
  /** D14 — what proves this move's work landed (required on Skill 75 review/done). */
  evidence?: string | null;
  /** D14 — the INDEPENDENT reviewer for a done move (never the actor). */
  reviewer?: string | null;
  /** D14 — a revision-bound approval decision, persisted as a durable record. */
  approval?: Skill75ApprovalEnvelope | null;
  /** D14 — an explicit independent-review record, persisted as a durable record. */
  review?: Skill75ReviewEnvelope | null;
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
  title_prefix?: string;
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
// D14 — Skill 75 typed completion contract at the server boundary
// ---------------------------------------------------------------------------

/** Trimmed-equality for identities; blank never matches (never self-approves). */
function sameIdentity(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = (a ?? '').trim().toLowerCase();
  const y = (b ?? '').trim().toLowerCase();
  return x.length > 0 && x === y;
}

export interface CampaignContractResolution {
  contract: CampaignContract;
  /** Present when a contract marker exists but does not parse — FAIL-CLOSED. */
  markerError?: string;
}

/**
 * The campaign's typed contract/version, resolved in ONE place:
 *   1. the persisted marker in campaigns.description (explicit contract at
 *      create, or the canonical-stage inference recorded at create);
 *   2. absent marker → deterministic canonical-stage inference;
 *   3. anything else → `legacy` (every non-Skill-75 producer unchanged).
 * A malformed marker is reported as `markerError` and must refuse completion —
 * it is never silently downgraded to legacy behavior.
 */
export function resolveCampaignContract(jobId: string): CampaignContractResolution {
  const campaign = queryOne<{ description: string | null }>(
    'SELECT description FROM campaigns WHERE id = ?',
    [jobId],
  );
  const marker = parseContractMarker(campaign?.description ?? null);
  if (marker.malformed) {
    return {
      contract: LEGACY_CONTRACT,
      markerError: `campaigns.description carries an unparseable contract marker (${marker.malformed})`,
    };
  }
  if (marker.contract) return { contract: marker.contract };
  const { stages } = readStageRefs(jobId);
  return {
    contract: isCanonicalSkill75StageSet(stages.map((s) => s.slug))
      ? SKILL75_TYPED_CONTRACT
      : LEGACY_CONTRACT,
  };
}

/** Every typed Skill 75 envelope recorded against a campaign's cards. */
function loadCampaignEnvelopes(jobId: string): Skill75Envelope[] {
  let rows: { metadata: string | null }[] = [];
  try {
    rows = queryAll<{ metadata: string | null }>(
      `SELECT ta.metadata FROM task_activities ta
         JOIN tasks t ON t.id = ta.task_id
        WHERE t.campaign_id = ? AND ta.metadata IS NOT NULL`,
      [jobId],
    );
  } catch {
    return []; // fail-closed: unreadable evidence reads as missing evidence
  }
  const out: Skill75Envelope[] = [];
  for (const r of rows) {
    const env = parseSkill75Envelope(r.metadata);
    if (env) out.push(env);
  }
  return out;
}

/**
 * Reconcile the board's SELF-REPORTED agent rows against the native workflow
 * census. Self-reported rows never prove execution (spec 10.3: "Command Center
 * records are a projection and must reconcile to them") — so a missing or
 * unreadable native census is UNKNOWN, never zero, and raw observed counts are
 * reported unclamped.
 */
export interface BoardNativeReconciliation {
  status: 'reconciled' | 'mismatch' | 'unknown';
  /** Self-reported board agent rows (distinct claimed identities). */
  boardAgentRows: number;
  /** Workflow ids claimed by self-reported rows. */
  boardWorkflows: string[];
  /** The latest recorded native census, or null when none is readable. */
  native: Skill75NativeCensusEnvelope | null;
  differences: string[];
}

export function reconcileBoardAgentRows(jobId: string): BoardNativeReconciliation {
  const envelopes = loadCampaignEnvelopes(jobId);

  const claimedAgents = new Set<string>();
  const claimedWorkflows = new Set<string>();
  let anonymousRows = 0;

  for (const env of envelopes) {
    if (env.kind === 'agent_row') {
      claimedAgents.add(env.agent_id);
      claimedWorkflows.add(env.workflow_id);
    }
  }

  // Untyped self-reported board rows (activity_type 'spawned') count too — the
  // board's rows are what must reconcile, whichever shape they arrive in.
  try {
    const rows = queryAll<{ activity_type: string; agent_id: string | null; metadata: string | null }>(
      `SELECT ta.activity_type, ta.agent_id, ta.metadata FROM task_activities ta
         JOIN tasks t ON t.id = ta.task_id
        WHERE t.campaign_id = ?`,
      [jobId],
    );
    for (const r of rows) {
      if (r.activity_type !== 'spawned') continue;
      const env = parseSkill75Envelope(r.metadata);
      const claimed = env && env.kind === 'agent_row' ? env.agent_id : (r.agent_id ?? '').trim();
      if (claimed) claimedAgents.add(claimed);
      else anonymousRows += 1;
    }
  } catch {
    /* unreadable board rows stay counted from the typed envelopes only */
  }

  const boardAgentRows = claimedAgents.size + anonymousRows;

  // Latest native census by recorded time (rowid breaks ties).
  let native: Skill75NativeCensusEnvelope | null = null;
  for (const env of envelopes) {
    if (env.kind !== 'native_census') continue;
    if (!native || env.observed_at >= native.observed_at) native = env;
  }

  if (!native) {
    return {
      status: 'unknown',
      boardAgentRows,
      boardWorkflows: [...claimedWorkflows].sort(),
      native: null,
      differences: [
        `no readable native workflow census recorded (board shows ${boardAgentRows} self-reported agent row(s)) — ` +
          'self-reported rows are not proof of execution; missing/unreadable census is unknown, not zero',
      ],
    };
  }

  const differences: string[] = [];
  if (boardAgentRows !== native.agents_total) {
    differences.push(
      `board self-reported agent rows: ${boardAgentRows}; native census agents_total: ${native.agents_total} (raw observed, never clamped)`,
    );
  }
  if (native.per_workflow) {
    for (const wf of claimedWorkflows) {
      if (!(wf in native.per_workflow)) {
        differences.push(`board rows claim workflow '${wf}' which the native census does not list`);
      }
    }
  }

  return {
    status: differences.length === 0 ? 'reconciled' : 'mismatch',
    boardAgentRows,
    boardWorkflows: [...claimedWorkflows].sort(),
    native,
    differences,
  };
}

export interface Skill75CompletionReport {
  ok: boolean;
  /** Human-readable, actionable reasons completion is refused (empty when ok). */
  missing: string[];
  reconciliation: BoardNativeReconciliation;
}

/**
 * The Skill 75 completion contract, checked at the server boundary BEFORE any
 * completion state is written: required stage completion, revision-bound
 * approvals, independent reviewer evidence and final delivery evidence must
 * ALL be present, and the board's rows must reconcile to the native workflow
 * census. Unknown/malformed evidence is MISSING evidence (fail-closed) — an
 * epic marked done can never complete the campaign while required child stages
 * are incomplete or failed.
 */
export function checkSkill75Completion(
  jobId: string,
  opts: { actor: string; reviewer?: string | null },
): Skill75CompletionReport {
  const missing: string[] = [];

  // 1. Required stage completion — every required child stage done.
  const { parentId, stages } = readStageRefs(jobId);
  if (stages.length === 0) {
    missing.push('no required child stage cards exist for this campaign (the canonical stage mapping must be created first)');
  }
  const notDone = stages.filter((s) => s.status !== 'done');
  if (notDone.length > 0) {
    missing.push(
      `required stage(s) incomplete or failed: ${notDone.map((s) => `${s.slug}=${s.status}`).join(', ')}`,
    );
  }

  const envelopes = loadCampaignEnvelopes(jobId);

  // 2. Revision-bound approvals — every required artifact kind approved at its
  //    CURRENT revision. A changed/revised artifact invalidates its approval.
  const approvals = envelopes.filter((e): e is Skill75ApprovalEnvelope => e.kind === 'approval');
  for (const kind of SKILL75_REQUIRED_APPROVAL_KINDS) {
    const forKind = approvals
      .filter((e) => e.artifact_kind === kind)
      .sort((a, b) => a.revision - b.revision || a.decided_at.localeCompare(b.decided_at));
    if (forKind.length === 0) {
      missing.push(`revision-bound approval missing for artifact kind '${kind}'`);
      continue;
    }
    const currentRevision = forKind[forKind.length - 1].revision;
    const atCurrent = forKind.filter((e) => e.revision === currentRevision);
    const shas = new Set(
      atCurrent.map((e) => (e.sha256 ? e.sha256.toLowerCase() : null)).filter((s): s is string => !!s),
    );
    if (shas.size > 1) {
      missing.push(
        `artifact '${kind}' revision ${currentRevision} carries conflicting sha256 bindings — the approval binding is ambiguous`,
      );
      continue;
    }
    const latest = atCurrent[atCurrent.length - 1];
    if (latest.decision !== 'approved') {
      missing.push(
        `artifact '${kind}' revision ${currentRevision} is '${latest.decision}', not approved — a changed artifact invalidates its approval`,
      );
    }
  }

  // 3. Independent reviewer evidence — a recorded passing review whose reviewer
  //    is NOT the executing agent (or the completing move's own reviewer).
  //    Self-approval is rejected at the completion boundary exactly as the
  //    producer rejects it client-side (cc_sync SelfApprovalError): an actor may
  //    never approve their own done, and such a record never counts as evidence.
  if (opts.reviewer && sameIdentity(opts.reviewer, opts.actor)) {
    missing.push('actor may not approve own done (self-approval rejected)');
  }
  const independentReview = envelopes.some(
    (e) => e.kind === 'review' && e.verdict === 'pass' && !sameIdentity(e.reviewer, e.actor),
  );
  const incomingIndependent =
    !!opts.reviewer && !sameIdentity(opts.reviewer, opts.actor);
  if (!independentReview && !incomingIndependent) {
    missing.push(
      'independent reviewer evidence missing: no recorded review whose reviewer differs from the executing agent',
    );
  }

  // 4. Final delivery evidence — registered and REACHABLE on the epic card,
  //    through the existing evidence/reachability checks (never disabled).
  if (!parentId) {
    missing.push('epic card missing — no final delivery target');
  } else {
    const evidence = collectCompletionEvidence(parentId);
    if (!evidence.hasEvidence) {
      missing.push(
        `final delivery evidence missing or unreachable on the epic card: ${
          evidence.problems.join('; ') || 'no deliverable registered'
        }`,
      );
    }
  }

  // 5. Board projection must reconcile to the native workflow census —
  //    self-reported rows never prove execution.
  const reconciliation = reconcileBoardAgentRows(jobId);
  if (reconciliation.status === 'unknown') {
    missing.push(
      'native workflow census unknown — record a skill75 native_census envelope; unknown is not zero and self-reported rows prove nothing',
    );
  } else if (reconciliation.status === 'mismatch') {
    missing.push(`board/native counts disagree: ${reconciliation.differences.join('; ')}`);
  }

  return { ok: missing.length === 0, missing, reconciliation };
}

/**
 * Persist the move's durable evidence records (approval / review / evidence
 * text) as task_activities rows. "A board is a view of the run, never the only
 * copy of a decision or the result" — these rows are the copy the completion
 * guard reads; the board only projects them.
 */
function persistMoveEnvelopes(cardId: string, input: MoveAdStageInput, actor: string): void {
  const now = new Date().toISOString();
  const insert = (message: string, envelope: object | null) => {
    run(
      `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, metadata, created_at)
       VALUES (?, ?, NULL, 'comment', ?, ?, ?)`,
      [uuidv4(), cardId, message, envelope ? JSON.stringify(envelope) : null, now],
    );
  };

  if (input.approval) {
    const a = input.approval;
    insert(
      `skill75 approval: ${a.artifact_kind} rev ${a.revision} ${a.decision} by ${a.approver}`,
      a,
    );
  }

  const review: Skill75ReviewEnvelope | null =
    input.review ??
    (input.status === 'done' && input.reviewer
      ? {
          contract: 'skill75',
          version: 1,
          kind: 'review',
          reviewer: input.reviewer.trim(),
          actor,
          verdict: 'pass',
        }
      : null);
  if (review) {
    insert(`skill75 review: ${review.verdict} by ${review.reviewer} (actor ${review.actor})`, review);
  }

  const evidence = (input.evidence ?? '').trim();
  if (evidence) {
    insert(`completion evidence: ${evidence}`, null);
  }
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

  // D14 — typed contract/version. Explicit wins; otherwise the canonical
  // Skill 75 stage set infers `skill75`; everything else is `legacy` and keeps
  // its exact pre-D14 behavior. The marker is persisted so completion-time
  // resolution never depends on re-guessing.
  const contract: CampaignContract =
    input.contract ??
    (isCanonicalSkill75StageSet((input.stages ?? DEFAULT_AD_STAGES).map((s) => s.slug))
      ? SKILL75_TYPED_CONTRACT
      : LEGACY_CONTRACT);
  const contractMarker = formatContractMarker(contract);

  // D14 — the run's canonical origin record, stamped onto every card. A
  // requester_session_key that is not an addressable gateway key is refused at
  // the boundary (never stored as a destination the delivery lane would fail on).
  const requesterSessionKey = input.requester_session_key
    ? normalizeRequesterSessionKey(input.requester_session_key)
    : null;
  if (input.requester_session_key && !requesterSessionKey) {
    throw new AdCampaignError(
      400,
      'REQUESTER_SESSION_KEY_INVALID',
      'requester_session_key must be an addressable gateway session key (agent:<agentId>:<peer>)',
    );
  }
  const requesterChannel = input.requester_channel?.trim() || null;
  const requesterChatId = input.requester_chat_id?.trim() || null;

  // Epic title/description use the optional title_prefix; 'FB Ad Run' default
  // keeps Skill 48 payloads (no title_prefix) byte-identical to before.
  const epicTitle = `${input.title_prefix ?? 'FB Ad Run'} — ${input.show_name}`;
  const epicDescription = `${input.owner ? `Skill 48 Facebook ad run. owner=${input.owner}` : 'Skill 48 Facebook ad run.'}\n${contractMarker}`;

  // Build the card list: epic parent first, then one card per stage.
  const stageList = input.stages && input.stages.length > 0 ? input.stages : DEFAULT_AD_STAGES;
  const cardsToInsert: Array<{ id: string; slug: string; title: string }> = [];
  cardsToInsert.push({
    id: uuidv4(),
    slug: EPIC_SLUG,
    title: epicTitle,
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
        epicTitle,
        epicDescription,
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
    //    assigned_agent_id NULL (FK-safe), provenance in description. D14: each
    //    card carries the run's canonical origin record so report-back can
    //    return to the recorded requester conversation.
    for (const card of cardsToInsert) {
      run(
        `INSERT INTO tasks (id, title, description, status, priority, assigned_agent_id, created_by_agent_id, workspace_id, business_id, department, campaign_id, stage_slug, requester_channel, requester_chat_id, requester_session_key, created_at, updated_at)
         VALUES (?, ?, ?, 'backlog', 'medium', NULL, NULL, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          card.id,
          card.title,
          card.slug === EPIC_SLUG
            ? `${provenanceDescription(input, card.slug)}\n${contractMarker}`
            : provenanceDescription(input, card.slug),
          workspaceId,
          department,
          jobId,
          card.slug,
          requesterChannel,
          requesterChatId,
          requesterSessionKey,
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
  // W3QC-01 — broadcast() auto-scopes each card to its company.
  for (const t of insertedTasks) {
    broadcast({ type: 'task_created', payload: t });
  }

  const { parentId, stages } = readStageRefs(jobId);
  return { ok: true, created: true, campaign_id: jobId, parent_id: parentId, stages, title_prefix: input.title_prefix };
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

  // ── D14: Skill 75 contract resolution (used at the completion boundary) ────
  const resolution = resolveCampaignContract(jobId);
  const isSkill75 = resolution.contract.kind === 'skill75';
  const reviewerText = (input.reviewer ?? '').trim();

  if (input.status === 'blocked') {
    // Mirror the repo's blocked-column gate: a structured reason + a human ask.
    if (!input.blocked_reason || !VALID_BLOCKED_REASONS.has(input.blocked_reason)) {
      throw new AdCampaignError(
        400,
        'BLOCKED_REASON_REQUIRED',
        `status=blocked requires blocked_reason ∈ {decision,approval,credential,payment}`,
      );
    }
    // isBlankAsk also rejects a rendered placeholder ("(no ask specified)") — a
    // stage card parked on a human with a placeholder ask is unanswerable-forever
    // exactly like one with no ask. See src/lib/blocked-ask.ts.
    if (isBlankAsk(input.ask)) {
      throw new AdCampaignError(400, 'ASK_REQUIRED', 'status=blocked requires a non-empty ask');
    }
    run(
      'UPDATE tasks SET blocked_reason = ?, blocked_on_human = ?, ask = ?, last_progress_at = ? WHERE id = ?',
      [input.blocked_reason, input.blocked_on_human || 'operator', input.ask, now, card.id],
    );
    const updated = await transition(card.id, 'blocked', { actor, reason, operatorOverride: true });
    // NO-SILENT-STOP: a stage card parked on a named human is a card that will not
    // move again until that human acts — a permanent stop by any definition, and
    // until now one that told nobody. The producer that called this API knows;
    // the person named in `blocked_on_human` did not. The chokepoint stamps the
    // claim and sends exactly one notice, on the lane that person belongs to.
    // applyBlock:false — the transition and the block_* metadata landed above.
    await stopCardPermanently({
      taskId: card.id,
      source: actor,
      reason:
        `This step is waiting on a person before it can go any further` +
        `${input.blocked_reason ? ` (${input.blocked_reason})` : ''}. ` +
        `Nothing else will happen on it until that is answered.`,
      needs: input.ask ?? 'Answer the question on the card so the work can continue.',
      audience: (input.blocked_on_human || 'operator') === 'owner' ? 'OWNER' : 'SYSTEM',
      machineDetail: reason ?? `stage stage parked: ${input.blocked_reason}`,
      applyBlock: false,
    });
    // MR-30 — snapshot the block metadata so the history survives the unblock
    // (the blocked_* columns are cleared when the card leaves blocked). Gated
    // on a genuine entry into blocked: transition() is idempotent for same-
    // state, so a re-sent block on an already-blocked card writes no duplicate
    // history row.
    if (card.status !== 'blocked') {
      recordBlockEvent({
        taskId: card.id,
        blockReason: input.blocked_reason,
        blockNeeds: input.ask ?? null,
        blockAudience: (input.blocked_on_human || 'operator') === 'owner' ? 'OWNER' : 'SYSTEM',
        blockedOnHuman: input.blocked_on_human || 'operator',
        ask: input.ask ?? null,
        actor,
      });
    }
    persistMoveEnvelopes(card.id, input, actor);
    return updated;
  }

  // Leaving blocked → clear the blocked columns first (back to a clean card).
  // (input.status is already narrowed to non-'blocked' here: the blocked branch
  // above returns early, so reaching this point means status !== 'blocked'.)
  if (card.status === 'blocked') {
    // Clear ALL SIX block-metadata columns, not just the human-block trio.
    // B3 (parity with tasks/[id]/route.ts): also NULL the SYSTEM block-metadata
    // columns (block_reason / block_needs / block_audience) the QC-scorer and
    // stuck-in-progress sweep write. Leaving them populated made an unblocked
    // campaign card still read as SYSTEM-blocked on the board and in audience
    // routing. All six clear in the SAME UPDATE so the unblock is atomic.
    run(
      `UPDATE tasks
          SET blocked_reason = NULL, blocked_on_human = NULL, ask = NULL,
              block_reason = NULL, block_needs = NULL, block_audience = NULL,
              blocked_notice_sent_at = NULL
        WHERE id = ?`,
      [card.id],
    );
  }

  const updated = await transition(card.id, input.status, { actor, reason, operatorOverride: true });

  // Durable decision/evidence records — the board is only a view of these.
  persistMoveEnvelopes(card.id, input, actor);

  // Epic done ⇒ the whole run is complete; reflect it on the campaign row.
  //
  // D14 — THE COMPLETION BOUNDARY. The epic card's own transition follows the
  // unchanged lifecycle rules (legal map, FIX 25 reachable-evidence gate); what
  // the Skill 75 contract gates is the CAMPAIGN completion claim. "An epic
  // marked done can never complete the campaign while required child stages are
  // incomplete or failed": the card may read done, the campaign row may only
  // read complete after the full evidence proof below. A refusal is loud (422
  // with every missing item named) AND durable (an activity record on the epic),
  // and a later replay of the same move re-runs this gate, so completing after
  // the evidence lands needs no manual database edit.
  if (input.stage_slug === EPIC_SLUG && input.status === 'done') {
    if (resolution.markerError) {
      recordCompletionRefusal(card.id, resolution.markerError);
      throw new AdCampaignError(
        422,
        'CONTRACT_MARKER_INVALID',
        `campaign completion refused: ${resolution.markerError}`,
      );
    }
    if (isSkill75) {
      const report = checkSkill75Completion(jobId, { actor, reviewer: reviewerText });
      if (!report.ok) {
        const detail = `campaign completion refused: ${report.missing.join(' | ')}`;
        recordCompletionRefusal(card.id, detail);
        throw new AdCampaignError(422, 'SKILL75_COMPLETION_INCOMPLETE', detail);
      }
    }
    run('UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ?', ['complete', now, jobId]);
  }

  return updated;
}

/** Durable record of a refused campaign completion (the board shows WHY). */
function recordCompletionRefusal(taskId: string, detail: string): void {
  try {
    run(
      `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, metadata, created_at)
       VALUES (?, ?, NULL, 'error', ?, NULL, ?)`,
      [uuidv4(), taskId, `skill75 completion refused — ${detail}`, new Date().toISOString()],
    );
  } catch {
    /* best-effort: the 422 refusal itself is the authoritative signal */
  }
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
