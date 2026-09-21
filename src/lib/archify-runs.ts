/**
 * archify-runs.ts — Skill 69 (archify) → Command Center board.
 *
 * The server half of the archify board hookup. An external producer (the
 * OpenClaw Skill 69 archify diagram assembly line, a zero-dependency Node CLI
 * that emits architecture / workflow / sequence / dataflow / lifecycle
 * diagrams) lands ONE diagram run on the EXISTING Kanban board as a campaign
 * grouping + one card per phase, and moves those cards through the lifecycle as
 * the run progresses.
 *
 * This module is a deliberate structural MIRROR of src/lib/ad-campaigns.ts
 * (Skill 48 → board, CC >= v4.50.0) — same grouping store (`campaigns`), same
 * card model (`tasks` + `campaign_id` + `stage_slug`), same lifecycle engine,
 * same idempotency-on-the-caller's-id contract. There is NO parallel board
 * concept here: an archify card IS a board card, in the same columns, moving
 * through the same `transition()` legal map, rendered by the same board.
 *
 * DESIGN CONSTRAINTS (copied from ad-campaigns.ts — read that file's header for
 * the full rationale; the same constraints apply verbatim):
 *   - CREATE uses a DIRECT INSERT (mirrors POST /api/campaigns), NOT
 *     createTaskCore(): createTaskCore() auto-routes and fires autoDispatchTask()
 *     — a real OpenClaw invocation per card. For an externally-driven diagram
 *     pipeline that would fire ~5 redundant agent runs and is wrong here.
 *   - MOVES go through the canonical `transition()` engine (legal-map enforced,
 *     task_events + SSE written), NOT through PATCH /api/tasks/[id]: that route
 *     adds a Triad gate, a QC auto-scorer on →review (which would auto-advance
 *     review→done and skip the validation pause), and a blocked-authority gate.
 *   - `operatorOverride: true` is required on every move because archify cards
 *     have assigned_agent_id = NULL; the in_progress precondition would
 *     otherwise fail.
 *   - The OpenClaw `agent_id` is provenance ONLY. It is NEVER written to
 *     tasks.assigned_agent_id (an FK into the CC `agents` table — an external id
 *     would break the constraint). It lives in the card description.
 *
 * IDEMPOTENCY (so a producer retry cannot double-create)
 *   The grouping id is `run_id` (== campaigns.id == every tasks.campaign_id):
 *     1. caller supplies `run_id`              → that IS the idempotency key;
 *     2. else caller supplies `external_run_id` → run_id is DERIVED
 *        deterministically (sha256 of the external id), so a re-sent create
 *        lands on the same grouping and returns the same cards;
 *     3. else the server mints an opaque id and NO dedupe is possible (a
 *        keyless create is a create — documented, not silently deduped).
 *   A replay with the SAME semantic parameters returns 200 {created:false} and
 *   writes nothing. A replay of the same id with DIFFERENT parameters throws
 *   IDEMPOTENCY_CONFLICT (409) rather than silently returning a grouping whose
 *   cards do not describe the request. `external_run_id` is always echoed.
 *
 * LIFECYCLE (the producer drives it; the server is the authority on legality)
 *   received → authoring → validate → render → deliver
 *   (the Skill 69 producer's own PHASES tuple — the one vocabulary, shared with
 *   DEFAULT_ARCHIFY_PHASES below; see the note on that constant)
 *   Suggested mapping onto the CC status vocabulary — every move is the
 *   producer's call, exactly as skill 48 drives its own phases:
 *     received         → in_progress→review→done (acknowledged)
 *     authoring        → in_progress
 *     validate         → review   (the diagram-quality gate / human pause)
 *     render           → in_progress → review
 *     deliver          → done     (then epic → done completes the grouping)
 *   FAIL-SOFT is the PRODUCER's job: this module throws typed errors so the
 *   route can answer with a clean status code, and the producer decides whether
 *   a board problem may fail its run (it must not — see the skill's caller).
 */

import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { queryOne, queryAll, run, transaction } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { transition, TransitionError } from '@/lib/task-lifecycle';
import { recordBlockEvent } from '@/lib/block-events';
import { isBlankAsk } from '@/lib/blocked-ask';
import { isUsableFile, isUsableUrl, bundleReverifyEnabled, isBundleDeliverablePath, verifyPresentationBundleDeliverable } from '@/lib/completion-evidence';
import type { Task } from '@/lib/types';
import { linkDeliverableToExecution } from '@/lib/execution-attempts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The five diagram families archify produces. */
export const ARCHIFY_DIAGRAM_TYPES = [
  'architecture',
  'workflow',
  'sequence',
  'dataflow',
  'lifecycle',
] as const;

export type ArchifyDiagramType = (typeof ARCHIFY_DIAGRAM_TYPES)[number];

export type ArchifyCardStatus = 'backlog' | 'in_progress' | 'review' | 'blocked' | 'done';

export interface ArchifyPhaseInput {
  slug: string;
  title?: string;
}

export interface CreateArchifyRunInput {
  /** Caller-supplied grouping id (idempotency key). Optional — see header. */
  run_id?: string;
  /** External archify run/job id (provenance + secondary idempotency). */
  external_run_id?: string;
  title: string;
  diagram_type: ArchifyDiagramType;
  phases?: ArchifyPhaseInput[];
  owner?: string;
  department?: string;
  workspace?: string;
  agent_id?: string;
  /** Provenance only: the archify architecture JSON the run consumed. */
  source_path?: string;
}

export interface MoveArchifyPhaseInput {
  phase_slug: string;
  status: ArchifyCardStatus;
  /** Free-text progress note; appended to the card's provenance block. */
  note?: string | null;
  /**
   * Where the phase's work landed. A valid http(s) URL or an existing,
   * non-empty absolute path is registered as the card's completion evidence so
   * the canonical review/done gates can pass (see registerArtifactEvidence).
   */
  artifact_url?: string | null;
  reason?: string | null;
  actor?: string | null;
  blocked_reason?: 'decision' | 'approval' | 'credential' | 'payment' | null;
  blocked_on_human?: 'owner' | 'operator' | null;
  ask?: string | null;
}

/** One phase card as the producer sees it. */
export interface ArchifyPhaseRef {
  slug: string;
  id: string;
  status: string;
}

export interface CreateArchifyRunResult {
  ok: true;
  created: boolean;
  /** The grouping id — the canonical field for archify producers. */
  run_id: string;
  /** Alias of run_id: the grouping row IS a `campaigns` row (board parity). */
  campaign_id: string;
  /** Echo of the caller-supplied external id (null when not supplied). */
  external_run_id: string | null;
  /** The parent/rollup card id (stage_slug='epic'). */
  parent_id: string | null;
  phases: ArchifyPhaseRef[];
  /** Deterministic digest of the create parameters (replay/conflict evidence). */
  fingerprint: string;
}

/**
 * Domain error with an HTTP status hint, so the thin route layer can map
 * cleanly (validation / blocked-gate failures → 400, unknown phase → 404,
 * idempotency conflict → 409).
 */
export class ArchifyRunError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ArchifyRunError';
  }
}

// Default phase list when the producer does not pass `phases`. The producer
// SHOULD pass its own to stay authoritative; this keeps CC decoupled from
// skill 69 internals while still giving stable slugs. (`epic` is the parent.)
//
// The slugs below are the producer's OWN vocabulary, verbatim — cc_board.py
// PHASES = ("received", "authoring", "validate", "render", "deliver"). They are
// NOT cosmetic: the producer addresses cards BY SLUG (`cc_board.py phase
// --phase received`, `advance_run()` walks PHASES), so a default list in any
// other spelling creates cards that the producer's own CLI can never address
// (every move 404s PHASE_NOT_FOUND) while CREATE still answers 201. If the
// producer ever renames a phase, rename it here in the same change —
// tests/unit/archify-runs-producer-contract.test.ts fails the build otherwise.
export const DEFAULT_ARCHIFY_PHASES: ArchifyPhaseInput[] = [
  { slug: 'received', title: 'Request received' },
  { slug: 'authoring', title: 'Authoring' },
  { slug: 'validate', title: 'Validate' },
  { slug: 'render', title: 'Render' },
  { slug: 'deliver', title: 'Deliver' },
];

const EPIC_SLUG = 'epic';
const DEFAULT_DEPARTMENT = 'engineering';
const VALID_BLOCKED_REASONS = new Set(['decision', 'approval', 'credential', 'payment']);
/** The marker line every archify grouping row carries in `description`. */
const ARCHIFY_MARKER = '[archify-run]';

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

/**
 * Deterministic grouping id for a caller that supplies only an external run id.
 * Stable across retries and across boxes, so a re-sent create can never
 * double-create a second grouping for the same external run.
 */
export function deriveRunIdFromExternalId(externalRunId: string): string {
  const digest = createHash('sha256').update(externalRunId.trim()).digest('hex');
  return `archify-${digest.slice(0, 32)}`;
}

/**
 * Digest of the SEMANTIC create parameters. Two creates with the same key and
 * the same digest are a replay (idempotent 200); the same key with a different
 * digest is a genuine conflict (409). Provenance-only fields (owner, agent_id,
 * source_path) are deliberately EXCLUDED so a retry that adds provenance is
 * still recognised as the same run rather than refusing a legitimate retry.
 */
export function archifyRunFingerprint(input: CreateArchifyRunInput): string {
  const phaseSlugs = (input.phases && input.phases.length > 0 ? input.phases : DEFAULT_ARCHIFY_PHASES)
    .map((p) => p.slug);
  const semantic = JSON.stringify([
    input.title,
    input.diagram_type,
    input.external_run_id ?? '',
    phaseSlugs,
    input.workspace ?? '',
  ]);
  return createHash('sha256').update(semantic).digest('hex');
}

/** The grouping row's description: marker + fingerprint + provenance lines. */
function groupingDescription(input: CreateArchifyRunInput, fingerprint: string): string {
  const lines = [
    `Skill 69 archify diagram run (${input.diagram_type}).`,
    `${ARCHIFY_MARKER} fingerprint=${fingerprint}`,
    `title=${input.title}`,
    `diagram_type=${input.diagram_type}`,
  ];
  if (input.external_run_id) lines.push(`external_run_id=${input.external_run_id}`);
  if (input.owner) lines.push(`owner=${input.owner}`);
  if (input.department) lines.push(`department=${input.department}`);
  if (input.agent_id) lines.push(`source_agent=${input.agent_id}`); // provenance ONLY
  if (input.source_path) lines.push(`source_path=${input.source_path}`);
  return lines.join('\n');
}

/**
 * Build a card's provenance description (never holds secrets). `runId` is
 * passed in — NOT re-resolved — because a keyless create mints its id once and
 * every card must carry that same id.
 */
function provenanceDescription(
  input: CreateArchifyRunInput,
  runId: string,
  phaseSlug: string,
): string {
  const lines = [
    `[archify-run] phase=${phaseSlug}`,
    `run_id=${runId}`,
    `title=${input.title}`,
    `diagram_type=${input.diagram_type}`,
  ];
  if (input.external_run_id) lines.push(`external_run_id=${input.external_run_id}`);
  if (input.owner) lines.push(`owner=${input.owner}`);
  if (input.department) lines.push(`department=${input.department}`);
  if (input.agent_id) lines.push(`source_agent=${input.agent_id}`); // provenance ONLY
  if (input.source_path) lines.push(`source_path=${input.source_path}`);
  return lines.join('\n');
}

/** The grouping id this input resolves to (supplied → derived → minted). */
function resolveRunId(input: CreateArchifyRunInput): string {
  if (input.run_id) return input.run_id;
  if (input.external_run_id) return deriveRunIdFromExternalId(input.external_run_id);
  return `archify-${uuidv4()}`;
}

/** Read the fingerprint an existing grouping row carries, or null if foreign. */
function readStoredFingerprint(runId: string): string | null {
  const row = queryOne<{ description: string | null }>(
    'SELECT description FROM campaigns WHERE id = ?',
    [runId],
  );
  if (!row?.description || !row.description.includes(ARCHIFY_MARKER)) return null;
  const m = row.description.match(/fingerprint=([0-9a-f]{64})/);
  return m ? m[1] : null;
}

/** Rebuild the phase refs (non-epic cards) + parent epic id from the DB. */
function readPhaseRefs(runId: string): { parentId: string | null; phases: ArchifyPhaseRef[] } {
  const rows = queryAll<{ id: string; status: string; stage_slug: string | null }>(
    'SELECT id, status, stage_slug FROM tasks WHERE campaign_id = ? ORDER BY stage_slug',
    [runId],
  );
  let parentId: string | null = null;
  const phases: ArchifyPhaseRef[] = [];
  for (const r of rows) {
    if (r.stage_slug === EPIC_SLUG) {
      parentId = r.id;
    } else if (r.stage_slug) {
      phases.push({ slug: r.stage_slug, id: r.id, status: r.status });
    }
  }
  return { parentId, phases };
}

/**
 * Register the phase's artifact as the card's completion evidence.
 *
 * The canonical review (FIX 25) and done (T0-01) gates require at least one
 * registered, REACHABLE deliverable — `operatorOverride` deliberately cannot
 * skip them, and their own refusal text names this remedy ("a 'url' type
 * pointing at where the work landed is sufficient"). An external diagram
 * producer has no other way to say where its render landed, so when it declares
 * one we register it, under the SAME registration-time gates the canonical
 * POST /api/tasks/{id}/deliverables route applies (FIX 27 reachability + FIX 54
 * bundle byte probe), so a row written here can never be weaker evidence than
 * one written there:
 *   - http(s) URL            → deliverable_type 'url' (validated by shape)
 *   - existing non-empty file → deliverable_type 'file' (probed if bundle-shaped)
 *   - anything else          → 400 INVALID_ARTIFACT_URL, and NO row is written
 *
 * Deliberate, documented deviation: the FIX 54 bundle probe runs only for
 * FILE-backed artifacts. The canonical route also runs it for 'url' rows, where
 * a URL is not a filesystem path and the probe can only ever answer ABSENT —
 * i.e. it would refuse a legitimate link merely for ending in `infographic.png`.
 * FIX 27's own header states the intent for URLs as "validated by shape", so
 * this follows the intent, not the incidental path.
 */
function registerArtifactEvidence(cardId: string, artifact: string, phaseSlug: string): void {
  const trimmed = artifact.trim();
  let deliverableType: 'url' | 'file';
  if (isUsableUrl(trimmed)) {
    deliverableType = 'url';
  } else if (isUsableFile(trimmed)) {
    deliverableType = 'file';
  } else {
    throw new ArchifyRunError(
      400,
      'INVALID_ARTIFACT_URL',
      'artifact_url must be a valid http(s) URL or an existing non-empty file path on the Command Center box',
    );
  }

  // FIX 54 — a bundle-SHAPED file (PRESENTER-GUIDE.pdf, *-FINAL.pdf,
  // infographic.png, …) must survive the same byte probe the done gate runs, or
  // it is refused HERE (422 + the probe's own named status) instead of being
  // registered and then failing the move to done. Rollback: PRESENTATION_BUNDLE_REVERIFY=0.
  if (deliverableType === 'file' && bundleReverifyEnabled() && isBundleDeliverablePath(trimmed)) {
    const verdict = verifyPresentationBundleDeliverable(trimmed);
    if (!verdict.ok) {
      throw new ArchifyRunError(
        422,
        'BUNDLE_REJECTED',
        `Bundle deliverable rejected at registration: ${verdict.reason ?? 'bundle verification failed'} (${verdict.status ?? 'FAILED'})`,
      );
    }
  }

  const existing = queryOne<{ id: string }>(
    'SELECT id FROM task_deliverables WHERE task_id = ? AND path = ?',
    [cardId, trimmed],
  );
  // Attribute the row to the current attempt either way — a re-run re-claiming
  // the same path is registering it for ITS attempt (execution-attempts.ts).
  if (existing) { linkDeliverableToExecution(cardId, existing.id); return; }

  const now = new Date().toISOString();
  const deliverableId = uuidv4();
  run(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      deliverableId,
      cardId,
      deliverableType,
      `archify ${phaseSlug} artifact`,
      trimmed,
      `Registered from PATCH /api/archify-runs by the Skill 69 producer.`,
      now,
      now,
    ],
  );
  linkDeliverableToExecution(cardId, deliverableId);
}

/** Append a progress note to the card's provenance block (bounded, never overwrites). */
function appendCardNote(cardId: string, note: string, phaseSlug: string): void {
  const row = queryOne<{ description: string | null }>(
    'SELECT description FROM tasks WHERE id = ?',
    [cardId],
  );
  const stamp = new Date().toISOString();
  const line = `[note ${stamp}] phase=${phaseSlug} ${note.trim().slice(0, 2000)}`;
  const next = row?.description ? `${row.description}\n${line}` : line;
  run('UPDATE tasks SET description = ?, updated_at = ? WHERE id = ?', [next, stamp, cardId]);
}

// ---------------------------------------------------------------------------
// createArchifyRun — create-only, idempotent on run_id (see header)
// ---------------------------------------------------------------------------

export function createArchifyRun(input: CreateArchifyRunInput): CreateArchifyRunResult {
  const runId = resolveRunId(input);
  const fingerprint = archifyRunFingerprint(input);
  const externalRunId = input.external_run_id ?? null;

  // Idempotency / conflict resolution against an existing grouping row.
  const existing = queryOne<{ id: string }>('SELECT id FROM campaigns WHERE id = ?', [runId]);
  if (existing) {
    const stored = readStoredFingerprint(runId);
    if (stored === null) {
      // The id is taken by a grouping this endpoint did not create (e.g. a
      // Skill 48 job_id). Refuse loudly instead of adopting a foreign run.
      throw new ArchifyRunError(
        409,
        'IDEMPOTENCY_CONFLICT',
        `run_id ${runId} already belongs to a non-archify grouping; supply a distinct run_id or external_run_id`,
      );
    }
    if (stored !== fingerprint) {
      throw new ArchifyRunError(
        409,
        'IDEMPOTENCY_CONFLICT',
        `run_id ${runId} already exists with different run parameters; a replay must carry the same title/diagram_type/phases`,
      );
    }
    const { parentId, phases } = readPhaseRefs(runId);
    return {
      ok: true,
      created: false,
      run_id: runId,
      campaign_id: runId,
      external_run_id: externalRunId,
      parent_id: parentId,
      phases,
      fingerprint,
    };
  }

  const workspaceId = resolveWorkspaceId(input.workspace);
  const department = input.department || DEFAULT_DEPARTMENT;
  const now = new Date().toISOString();

  // Build the card list: epic parent first, then one card per phase.
  const phaseList = input.phases && input.phases.length > 0 ? input.phases : DEFAULT_ARCHIFY_PHASES;
  const cardsToInsert: Array<{ id: string; slug: string; title: string }> = [
    { id: uuidv4(), slug: EPIC_SLUG, title: `Archify Run — ${input.title}` },
  ];
  for (const phase of phaseList) {
    cardsToInsert.push({
      id: uuidv4(),
      slug: phase.slug,
      title: phase.title || `${input.title} — ${phase.slug}`,
    });
  }

  const insertedTasks: Task[] = [];

  transaction(() => {
    // 1. Parent grouping row (FK target for tasks.campaign_id) — must exist first.
    run(
      `INSERT INTO campaigns (id, name, description, status, department_ids, start_date, target_date, workspace_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        runId,
        `Archify Run — ${input.title}`,
        groupingDescription(input, fingerprint),
        'active',
        JSON.stringify([]),
        null,
        null,
        workspaceId,
        now,
        now,
      ],
    );

    // 2. One card per phase (+ epic parent). All start in `backlog`,
    //    assigned_agent_id NULL (FK-safe), provenance in description.
    for (const card of cardsToInsert) {
      run(
        `INSERT INTO tasks (id, title, description, status, priority, assigned_agent_id, created_by_agent_id, workspace_id, business_id, department, campaign_id, stage_slug, created_at, updated_at)
         VALUES (?, ?, ?, 'backlog', 'medium', NULL, NULL, ?, NULL, ?, ?, ?, ?, ?)`,
        [
          card.id,
          card.title,
          provenanceDescription(input, runId, card.slug),
          workspaceId,
          department,
          runId,
          card.slug,
          now,
          now,
        ],
      );

      // Legacy events row (live feed / existing queries) — mirrors createTaskCore.
      run(
        `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
         VALUES (?, 'task_created', NULL, ?, ?, ?)`,
        [uuidv4(), card.id, `Archify card created: ${card.title}`, now],
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

  const { parentId, phases } = readPhaseRefs(runId);
  return {
    ok: true,
    created: true,
    run_id: runId,
    campaign_id: runId,
    external_run_id: externalRunId,
    parent_id: parentId,
    phases,
    fingerprint,
  };
}

// ---------------------------------------------------------------------------
// moveArchifyPhase — move ONE phase card through the lifecycle via transition()
// ---------------------------------------------------------------------------

export async function moveArchifyPhase(
  runId: string,
  input: MoveArchifyPhaseInput,
): Promise<Task> {
  const actor = input.actor || 'skill69-archify';
  const reason = input.reason ?? input.note ?? undefined;

  const grouping = queryOne<{ id: string }>('SELECT id FROM campaigns WHERE id = ?', [runId]);
  if (!grouping) {
    throw new ArchifyRunError(404, 'RUN_NOT_FOUND', `No archify run ${runId}`);
  }

  const card = queryOne<{ id: string; status: string }>(
    'SELECT id, status FROM tasks WHERE campaign_id = ? AND stage_slug = ?',
    [runId, input.phase_slug],
  );
  if (!card) {
    throw new ArchifyRunError(
      404,
      'PHASE_NOT_FOUND',
      `No card for run ${runId} phase ${input.phase_slug}`,
    );
  }

  const now = new Date().toISOString();

  // Evidence BEFORE the move: the review/done gates run inside transition() and
  // cannot be waived by operatorOverride, so the artifact must already exist.
  if (input.artifact_url) {
    registerArtifactEvidence(card.id, input.artifact_url, input.phase_slug);
  }
  if (input.note) {
    appendCardNote(card.id, input.note, input.phase_slug);
  }

  if (input.status === 'blocked') {
    // Mirror the repo's blocked-column gate: a structured reason + a human ask.
    if (!input.blocked_reason || !VALID_BLOCKED_REASONS.has(input.blocked_reason)) {
      throw new ArchifyRunError(
        400,
        'BLOCKED_REASON_REQUIRED',
        `status=blocked requires blocked_reason ∈ {decision,approval,credential,payment}`,
      );
    }
    // isBlankAsk also rejects a rendered placeholder ("(no ask specified)") — a
    // phase card parked on a human with a placeholder ask is unanswerable-forever
    // exactly like one with no ask. See src/lib/blocked-ask.ts.
    if (isBlankAsk(input.ask)) {
      throw new ArchifyRunError(
        400,
        'ASK_REQUIRED',
        'status=blocked requires a non-empty ask',
      );
    }
    run(
      'UPDATE tasks SET blocked_reason = ?, blocked_on_human = ?, ask = ?, last_progress_at = ? WHERE id = ?',
      [input.blocked_reason, input.blocked_on_human || 'operator', input.ask, now, card.id],
    );
    const updated = await transition(card.id, 'blocked', { actor, reason, operatorOverride: true });
    // Snapshot the block metadata so the history survives the unblock. Gated on
    // a genuine entry into blocked: transition() is idempotent for same-state,
    // so a re-sent block on an already-blocked card writes no duplicate row.
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
    return updated;
  }

  // Leaving blocked → clear ALL SIX block-metadata columns first (the human-block
  // trio AND the SYSTEM trio the QC-scorer / stuck-in-progress sweep write), in
  // ONE atomic UPDATE, mirroring src/lib/ad-campaigns.ts (B3 parity).
  if (card.status === 'blocked') {
    run(
      `UPDATE tasks
          SET blocked_reason = NULL, blocked_on_human = NULL, ask = NULL,
              block_reason = NULL, block_needs = NULL, block_audience = NULL
        WHERE id = ?`,
      [card.id],
    );
  }

  const updated = await transition(card.id, input.status, { actor, reason, operatorOverride: true });

  // Epic done ⇒ the whole run is complete; reflect it on the grouping row.
  if (input.phase_slug === EPIC_SLUG && input.status === 'done') {
    run('UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ?', ['complete', now, runId]);
  }

  return updated;
}

// ---------------------------------------------------------------------------
// getArchifyRun — poll helper
// ---------------------------------------------------------------------------

export function getArchifyRun(runId: string): {
  campaign: unknown | null;
  cards: Task[];
  phases: ArchifyPhaseRef[];
} {
  const campaign = queryOne('SELECT * FROM campaigns WHERE id = ?', [runId]) ?? null;
  const cards = queryAll<Task>(
    'SELECT * FROM tasks WHERE campaign_id = ? ORDER BY stage_slug',
    [runId],
  );
  const { phases } = readPhaseRefs(runId);
  return { campaign, cards, phases };
}

/**
 * Resolve an external archify run id to its grouping id. Two deterministic
 * paths, never a guess:
 *   1. the derived key the create path mints when `run_id` is ABSENT;
 *   2. an explicit `run_id` supplied alongside the external id — matched on the
 *      exact provenance LINE, so a prefix of a longer id can never match and a
 *      LIKE wildcard inside an id is inert (`instr` is a literal substring
 *      search, and the candidate is re-verified line-by-line in JS).
 */
export function resolveRunIdByExternalId(externalRunId: string): string | null {
  const trimmed = externalRunId.trim();
  if (!trimmed) return null;

  const derived = deriveRunIdFromExternalId(trimmed);
  const direct = queryOne<{ id: string }>(
    'SELECT id FROM campaigns WHERE id = ? AND description LIKE ?',
    [derived, `%${ARCHIFY_MARKER}%`],
  );
  if (direct) return direct.id;

  const candidates = queryAll<{ id: string; description: string | null }>(
    `SELECT id, description FROM campaigns
      WHERE description LIKE ? AND instr(description, ?) > 0`,
    [`%${ARCHIFY_MARKER}%`, `external_run_id=${trimmed}`],
  );
  const exactLine = `external_run_id=${trimmed}`;
  const match = candidates.find((c) =>
    (c.description ?? '').split('\n').some((line) => line.trim() === exactLine),
  );
  return match?.id ?? null;
}

export { TransitionError };
