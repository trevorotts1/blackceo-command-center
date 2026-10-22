import { z } from 'zod';
import {
  BLOCKED_ASK_INVARIANT_MESSAGE,
  violatesBlockedAskInvariant,
} from './blocked-ask';

/**
 * Shared Zod refinement for the blocked-ask invariant (see src/lib/blocked-ask.ts):
 * a payload that names a human in `blocked_on_human` MUST also carry a real,
 * non-blank `ask`. Attached to every schema that can persist the pair, so the
 * unanswerable-forever state is rejected at the request boundary with a 400
 * rather than written and then re-escalated on every sweep tick.
 */
const rejectBlockedWithoutAsk = (
  data: { blocked_on_human?: unknown; ask?: unknown },
  ctx: z.RefinementCtx,
) => {
  if (violatesBlockedAskInvariant(data)) {
    ctx.addIssue({
      code: 'custom',
      path: ['ask'],
      message: BLOCKED_ASK_INVARIANT_MESSAGE,
    });
  }
};

// Task status and priority enums.
// LOCKSTEP: this enum is the request-validation ENFORCER for TaskStatus and MUST
// stay in exact lockstep with the manifest in src/lib/types.ts:5 (the canonical
// 10-status TaskStatus union). If they drift, a status the board/agents
// legitimately set is rejected with a 400 at the gate -- e.g. dragging a card to
// the synthetic "To-Do" column PATCHes status='assigned' (MissionQueue.tsx:262),
// which an out-of-lockstep enum silently blocked, so a card could not enter To-Do.
//
// This enum ONLY validates that a status value is a real member of the manifest.
// It does NOT grant transitions: the Triad gate (backlog -> !backlog), the
// blocked gate, and the QC review->done gate are all enforced separately in
// src/app/api/tasks/[id]/route.ts and remain authoritative regardless of which
// values appear here. Adding the real statuses below does not open any gate.
//
// AUTHORITATIVE terminal transition: a presentations deck closes via 'done'
// (with a matching process_certificate_sha, enforced by the cert gate) — NOT
// 'delivered'. 'delivered' is intentionally absent: it is a note, not a status,
// so a status='delivered' PATCH is rejected here with a 400. Exported so the
// presentations cert-gate contract test can assert the gate's terminal-status
// set is a SUBSET of these values (see presentations-cert-gate.ts).
export const TaskStatus = z.enum([
  'backlog',
  'inbox',
  'planning',
  'in_progress',
  'assigned',
  'review',
  'testing',
  'blocked',
  'pending_dispatch',
  'done'
]);

const TaskPriority = z.enum(['low', 'medium', 'high', 'critical']);

// FIX 37 (W16a-B2) — widened for the presentations engine producers. The board
// engine's board.py posts `comment` progress notes and phase lifecycle rows
// (`phase_started` / `phase_completed` / `error`) plus plain `progress` pings
// through POST /api/tasks/[id]/activities; every one of these 400'd on the old
// five-value enum ("Validation failed"), so no stepper pulse and no comment
// ever reached task_activities. DB side needs no migration:
// task_activities.activity_type is a free TEXT column (schema.ts:442), and the
// TS-side ActivityType union in types.ts:547 is already broader than this gate
// (it carries owner_message / agent_message / trust_*), so widening the gate
// cannot break a consumer — this enum only VALIDATES, it is not a foreign key.
const ActivityType = z.enum([
  'spawned',
  'updated',
  'completed',
  'file_created',
  'status_changed',
  // FIX 37 — engine producer activity types:
  'comment',
  'progress',
  'phase_started',
  'phase_completed',
  'error'
]);

// QC-03: 'image' is a first-class deliverable type. Without it a mis-instructed
// agent that registers an image deliverable is rejected by the Zod enum, falls
// into the empty-manifest → heuristic-cap → stuck trap. Keep in lockstep with
// the DeliverableType TS union in types.ts.
const DeliverableType = z.enum(['file', 'url', 'artifact', 'image']);

// Task validation schemas
// Stored agent keys include both UUIDs and seeded stable slugs. Ownership and
// existence are checked against the database before accepting a reference.
export const TaskAgentId = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
export const CreateTaskSchema = z.object({
  title: z.string().min(1, 'Title is required').max(500, 'Title must be 500 characters or less'),
  description: z.string().max(10000, 'Description must be 10000 characters or less').optional(),
  status: TaskStatus.optional(),
  priority: TaskPriority.optional(),
  // P2-03: BOTH of these must be `.nullable()`, matching UpdateTaskSchema below.
  // TaskModal.handleSubmit() (src/components/TaskModal.tsx) ALWAYS sends
  // `assigned_agent_id: form.assigned_agent_id || null` and
  // `due_date: form.due_date || null` — including on the CREATE path, where
  // leaving the agent unassigned / due date unset (the default, most-common
  // "New Task" state) means the payload carries an EXPLICIT `null`, not a
  // missing key. `.optional()` alone accepts a missing key but rejects an
  // explicit `null`, so every create with these left at default 400'd with
  // "Validation failed" — this was the actual cause of the operator's "create
  // task doesn't really work" report (root-cause outcome (ii) in P2-03).
  assigned_agent_id: TaskAgentId.optional().nullable(),
  created_by_agent_id: TaskAgentId.optional(),
  business_id: z.string().optional(),
  workspace_id: z.string().optional(),
  department: z.string().optional(),
  due_date: z.string().optional().nullable(),
  sop_id: z.string().uuid().optional().nullable(),
  // U94 (X.2.3) — Command-Center UI create is one of the three enumerated
  // requester-stamping doors (trust-engine report-back loop). Optional/
  // nullable, matching assigned_agent_id/due_date above: a caller that knows
  // which human this task is for (e.g. a future "on behalf of" picker, or an
  // operator relaying a specific client's ask) can now attach that identity
  // at create time instead of it being silently dropped. Absent/null on a
  // normal operator create — that task correctly stays unstamped and falls
  // back to the operator digest (never a client-facing send).
  requester_channel: z.string().min(1).max(64).optional().nullable(),
  requester_chat_id: z.string().min(1).max(128).optional().nullable(),
  // Planning Mode ticked in the create form: hold the task from creation.
  planning_mode: z.boolean().optional(),
});

export const UpdateTaskSchema = z.object({
  execution_id: z.string().uuid().optional(),
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(10000).optional(),
  status: TaskStatus.optional(),
  priority: TaskPriority.optional(),
  assigned_agent_id: TaskAgentId.optional().nullable(),
  due_date: z.string().optional().nullable(),
  updated_by_agent_id: TaskAgentId.optional(),
  sop_id: z.string().uuid().optional().nullable(),
  sop_step_progress: z.string().optional().nullable(),
  // Blocked-column gate fields (N36 / migration 071).
  // All three MUST be present when status = 'blocked'; the API route enforces
  // this -- Zod accepts them as optional so the gate can produce a descriptive 400.
  blocked_reason: z.enum(['decision', 'approval', 'credential', 'payment']).optional().nullable(),
  blocked_on_human: z.enum(['owner', 'operator']).optional().nullable(),
  ask: z.string().max(500).optional().nullable(),
  // Presentations done-gate (v4.56.0 / no-skip proof).
  // Required when transitioning a `presentations` department task to `done`.
  // The API route enforces presence; Zod accepts it as optional so other
  // departments are completely unaffected by this field.
  // Presentations done-gate (v4.56.0 / no-skip proof).
  // Required when transitioning a `presentations` department task to `done`.
  // The API route enforces presence; Zod accepts it as optional so other
  // departments are completely unaffected by this field.
  // U033 (audit E3): a sha256 hex digest, exactly as prove-deck.py emits it
  // (hashlib.sha256(...).hexdigest() -> 64 lowercase hex chars). Lowercased and
  // trimmed before the check so a producer that upper-cases or pads is accepted
  // rather than silently 400'd; anything that is not a sha256 is refused HERE,
  // before it can be written into the anti-spoof slot.
  process_certificate_sha: z
    .string()
    .transform((s) => s.trim().toLowerCase())
    .refine((s) => /^[0-9a-f]{64}$/.test(s), {
      message:
        'process_certificate_sha must be a sha256 hex digest (64 hex characters), as written by prove-deck.py into PROCESS-CERTIFICATE.json',
    })
    .optional(),
  // ── U034 (audit E4): the four fields eight board producers have been sending
  // and Zod has been silently stripping. Declared so they ARRIVE; persisted by
  // the PATCH route. Deliberately NOT accompanied by .strict() — see the U034
  // card's "THE STRICT DECISION".
  //
  // RESTORED 2026-07-29: U034 landed these in 8cc525c; a parallel U035 branch
  // that forked from base-d07 rewrote the same PATCH function and dropped them
  // while leaving route.ts's u034Url/u034Qc usages in place — which made every
  // PATCH reaching route.ts:818 throw ReferenceError and return a bare 500.
  //
  // phase_id — the producer's own pipeline phase label, free text, recorded in
  // the audit note. NOT a foreign key: producers mint their own phase ids.
  phase_id: z.string().min(1).max(128).optional(),
  // note — appended to description as a timestamped audit line, exactly the way
  // POST /api/tasks/{id}/status does it.
  note: z.string().max(2000).optional(),
  // deliverable_url — where the produced work landed. Persisted as a `url`
  // deliverable row. http/https only: this value is rendered in the board UI and
  // a javascript:/data: URL there is a stored-XSS vector.
  deliverable_url: z
    .string()
    .url()
    .max(2048)
    .refine((u: string) => /^https?:\/\//i.test(u), {
      message: 'deliverable_url must be an http(s) URL',
    })
    .optional(),
  // qc_scores — the producer's own gate summary (cc_board.py collect_qc_summary).
  // Scalars are persisted to task_qc_results; the per-gate array has no column
  // and rides in `note`. Shaped loosely on purpose: a producer adding a gate
  // must not start 400-ing.
  qc_scores: z
    .object({
      gates_graded: z.number().int().nonnegative().optional(),
      overall_pass: z.boolean().optional(),
      min_average: z.number().nullable().optional(),
      autofails_total: z.number().int().nonnegative().optional(),
      gates: z.array(z.record(z.string(), z.unknown())).max(64).optional(),
    })
    .passthrough()
    .optional(),
})
  // POISON-STATE GATE: `blocked_on_human` set + blank/placeholder `ask` is
  // unanswerable-forever and is rejected here (400). Note this is STRICTER than
  // the route's status=blocked gate: it fires on ANY payload carrying the pair,
  // including one that names a human without touching `status`.
  .superRefine(rejectBlockedWithoutAsk);

// Activity validation schema
//
// PRES-040 (W3 WF12-B): two ADDITIVE fields for structured phase events.
// `scores` carries the producer's structured QC grades (per-gate average /
// pass / autofails) — previously a non-schema key the producer's own
// cc_board.py stripped on 400/422 fallback, permanently losing grades while
// reporting success. Persisted to task_activities.scores (migration 141);
// omitted by legacy callers with zero behavior change. `schema_version`
// rides inside metadata (never a top-level column) as the producer/consumer
// compatibility marker the preflight negotiates.
export const CreateActivitySchema = z.object({
  activity_type: ActivityType,
  message: z.string().min(1, 'Message is required').max(5000, 'Message must be 5000 characters or less'),
  agent_id: TaskAgentId.optional(),
  // B-U6 / U20 fix: every real caller (cc_board.py post_activity/post_qc_score,
  // src/lib/orchestration.ts logActivity) sends `metadata` as a nested JSON
  // OBJECT inside the request body — `z.string()` rejected every one of them
  // with a 400 "Validation failed" (empirically confirmed: safeParse({...,
  // metadata: {...}}) -> success:false, "expected string, received object"),
  // silently dropping metadata on EVERY real POST including the already-shipped
  // B-U12/U26 producer-scorecard contract. A pre-stringified string is still
  // accepted for back-compat with any caller that already serializes it itself.
  metadata: z.union([z.record(z.string(), z.unknown()), z.string()]).optional(),
  // PRES-040: structured QC grades. Plain object or its pre-stringified form
  // (same dual-shape convention as metadata); persisted to scores, echoed
  // back on GET, and folded into the message tail ONLY as display text.
  scores: z.union([z.record(z.string(), z.unknown()), z.string()]).optional(),
});

// Deliverable validation schema
export const CreateDeliverableSchema = z.object({
  deliverable_type: DeliverableType,
  title: z.string().min(1, 'Title is required'),
  path: z.string().optional(),
  description: z.string().optional(),
});

// FIX 5 (presentation rev2 phase A) -- stage-timings ingest contracts.
// Shapes mirror EXACTLY what presentation_job/phases.py emits to
// working/telemetry/stage-timings.jsonl (phase_exit per run_phase_timed call,
// one run_summary per run). The CC route accepts a batch of these rows.
const StageTimingExitSchema = z.object({
  run_id: z.string().min(1),
  phase_id: z.string().min(1),
  wave: z.number().int().min(0).optional(),
  model_used: z.string().nullable().optional(),
  event: z.literal('phase_exit'),
  started_at: z.string().min(1),
  ended_at: z.string().min(1),
  duration_s: z.number().min(0),
  status: z.string().min(1),
  return_code: z.number().int().optional(),
  error_class: z.string().optional(),
  // FIX 53a ([R5A §E, §H6]): the deck-run card this row belongs to, so
  // timings join back to the task and the stepper shows real elapsed times.
  // Optional — older producer builds omit it and stay valid.
  task_id: z.string().min(1).optional(),
  // PRES-037 (W3 WF12-B) — producer event identity + timing split. ALL
  // optional: legacy engine builds (phases.py run_phase_timed, which stamps
  // no event keys) stay valid and take the legacy plain-insert path with no
  // dedupe. Rows that carry event_id take the transactional idempotent path
  // keyed on (company_id, run_id, event_id). provider_s/queue_s/qc_s split
  // wall time so optimization targets the real bottleneck instead of
  // mislabeling concurrent worker CPU totals as wall duration.
  event_id: z.string().min(1).max(128).optional(),
  attempt_id: z.string().min(1).max(128).optional(),
  sequence: z.number().int().min(0).optional(),
  provider_s: z.number().min(0).optional(),
  queue_s: z.number().min(0).optional(),
  qc_s: z.number().min(0).optional(),
});

const StageTimingSummarySchema = z.object({
  run_id: z.string().min(1),
  event: z.literal('run_summary'),
  total_wall_s: z.number().min(0),
  phase_count: z.number().int().min(0),
  slowest_3: z.array(
    z.object({
      phase_id: z.string().min(1),
      duration_s: z.number().min(0),
    }),
  ),
  generated_at: z.string().min(1),
});

export const StageTimingRowSchema = z.discriminatedUnion('event', [
  StageTimingExitSchema,
  StageTimingSummarySchema,
]);

// Batch envelope: the engine (or a relay) posts rows in one request. Capped so
// a runaway or hostile payload cannot smuggle megabytes through the ingest.
export const StageTimingBatchSchema = z.object({
  rows: z.array(StageTimingRowSchema).min(1).max(1000),
});

// Type exports for use in routes
export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;
export type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;
export type CreateActivityInput = z.infer<typeof CreateActivitySchema>;
export type CreateDeliverableInput = z.infer<typeof CreateDeliverableSchema>;

// ---------------------------------------------------------------------------
// Logo URL validation
// ---------------------------------------------------------------------------

const VALID_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.svg', '.webp'];

const BLOCKED_HOSTS = [
  'drive.google.com',
  'docs.google.com',
  'dropbox.com',
  'dl.dropboxusercontent.com',
];

/**
 * Validates that a URL is a direct, publicly-accessible image link.
 * Returns { valid: true } on success or { valid: false, error: string } on failure.
 */
export function validateLogoUrl(url: string): { valid: boolean; error?: string } {
  // Basic URL format check
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      valid: false,
      error: 'That does not look like a valid URL. Please provide a full URL starting with https://',
    };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return {
      valid: false,
      error: 'Please use a URL that starts with https://',
    };
  }

  // Block Google Drive and Dropbox
  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTS.some((blocked) => host === blocked || host.endsWith('.' + blocked))) {
    if (host.includes('google.com')) {
      return {
        valid: false,
        error:
          'Google Drive links will not work. Please use a direct image link ending in .png, .jpg, or .svg. Try uploading your image to imgur.com or your own website and sharing that link instead.',
      };
    }
    return {
      valid: false,
      error:
        'Dropbox links will not work. Please use a direct image link ending in .png, .jpg, or .svg. Try uploading your image to imgur.com or your own website and sharing that link instead.',
    };
  }

  // Check for a valid image extension in the pathname
  const pathname = parsed.pathname.toLowerCase();
  const hasValidExtension = VALID_IMAGE_EXTENSIONS.some((ext) => pathname.endsWith(ext));
  if (!hasValidExtension) {
    return {
      valid: false,
      error: `The URL must point directly to an image file. Please make sure the link ends in .png, .jpg, .jpeg, .svg, or .webp. (Your link ends with "${pathname.split('/').pop() || pathname}")`,
    };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Skill 75 typed completion contract (D14) — the contract/version seam
// ---------------------------------------------------------------------------
//
// A campaign carries a TYPED contract/version. Skill 75 campaigns are held to
// the full completion contract at the server boundary (required stage
// completion, revision-bound approvals, independent reviewer evidence, final
// delivery evidence). EVERY OTHER campaign type is `legacy` and keeps its
// exact, previously supported behavior — this is a per-campaign opt-in, never a
// global breaking change.
//
// Resolution order (see ad-campaigns.resolveCampaignContract):
//   1. the persisted marker line in campaigns.description (written at create
//      from the explicit `contract` field, or from canonical-stage inference);
//   2. no marker → inferred `skill75` when the campaign's stage slugs are
//      EXACTLY the canonical Skill 75 12-stage mapping (a deterministic set
//      match, never a fuzzy guess), otherwise `legacy`.
// A marker that exists but cannot be parsed is FAIL-CLOSED: completion is
// refused with a named error rather than silently downgraded to legacy.

export const SKILL75_CONTRACT = 'skill75' as const;
export const SKILL75_CONTRACT_VERSION = 1 as const;

export const CampaignContractSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('skill75'), version: z.literal(1) }),
  z.object({ kind: z.literal('legacy'), version: z.literal(1) }),
]);
export type CampaignContract = z.infer<typeof CampaignContractSchema>;

export const SKILL75_TYPED_CONTRACT: CampaignContract = {
  kind: SKILL75_CONTRACT,
  version: SKILL75_CONTRACT_VERSION,
};
export const LEGACY_CONTRACT: CampaignContract = { kind: 'legacy', version: 1 };

/**
 * The canonical Skill 75 12-stage board mapping, verbatim from the factory's
 * single source (batch_mode/batch.py STAGES — "Stage IDs come from
 * batch_mode.batch.STAGES verbatim (never a second list)"). Used ONLY as the
 * deterministic contract inference for a campaign that did not carry an
 * explicit marker.
 */
export const SKILL75_STAGE_SLUGS = [
  'research',
  'creative-strategy',
  'script-lyrics',
  'music',
  'continuity-bible',
  'storyboard',
  'image-keyframes',
  'video-generation',
  'qc-retakes',
  'assembly',
  'final-qc',
  'delivery',
] as const;

/**
 * Contract v1's required approval artifact kinds (spec 5.1: script, lyrics,
 * character bible, music, storyboard, and the final production each need a
 * versioned approval before dependent work / completion).
 */
export const SKILL75_REQUIRED_APPROVAL_KINDS = [
  'script',
  'lyrics',
  'character_bible',
  'music',
  'storyboard',
  'final',
] as const;
export type Skill75ArtifactKind = (typeof SKILL75_REQUIRED_APPROVAL_KINDS)[number];

/** The marker line persisted in campaigns.description for a typed contract. */
export function formatContractMarker(contract: CampaignContract): string {
  return `contract=${contract.kind} v${contract.version}`;
}

const CONTRACT_MARKER_RE = /^contract=(skill75|legacy) v(\d+)$/;

/**
 * Parse the persisted contract marker out of a campaigns.description string.
 * Returns the typed contract when a VALID marker is present, `null` when no
 * marker line exists (→ legacy), and `malformed` when a marker line exists but
 * does not parse — which the caller must treat as FAIL-CLOSED (never a silent
 * downgrade to legacy behavior).
 */
export function parseContractMarker(
  description: string | null | undefined,
): { contract: CampaignContract | null; malformed?: string } {
  if (!description) return { contract: null };
  const found: string[] = [];
  for (const line of description.split('\n')) {
    const t = line.trim();
    if (t.startsWith('contract=')) found.push(t);
  }
  if (found.length === 0) return { contract: null };
  // More than one marker line is ambiguous (a duplicate or a corrupted edit):
  // fail closed rather than pick one and silently inherit its behavior.
  if (found.length > 1) return { contract: null, malformed: found.join(' / ') };
  const t = found[0];
  const m = CONTRACT_MARKER_RE.exec(t);
  if (!m) return { contract: null, malformed: t };
  const version = Number(m[2]);
  if (m[1] === 'skill75' && version === SKILL75_CONTRACT_VERSION) {
    return { contract: SKILL75_TYPED_CONTRACT };
  }
  if (m[1] === 'legacy' && version === 1) return { contract: LEGACY_CONTRACT };
  return { contract: null, malformed: t };
}

/** True when the stage-slug set is EXACTLY the canonical Skill 75 12 stages. */
export function isCanonicalSkill75StageSet(slugs: readonly string[]): boolean {
  if (slugs.length !== SKILL75_STAGE_SLUGS.length) return false;
  const seen = new Set(slugs.map((s) => s.trim().toLowerCase()));
  return SKILL75_STAGE_SLUGS.every((s) => seen.has(s));
}

// ── Skill 75 evidence envelopes (spec 5.3 typed artifact envelope) ───────────
//
// Durable decision/evidence records, persisted as task_activities.metadata on
// the campaign's stage cards (and accepted through POST /api/tasks/[id]/activities
// metadata the same way). "A board is a view of the run, never the only copy of
// a decision or the result": these rows ARE the copy the completion guard reads;
// the board merely projects them. Every envelope is versioned and parsed
// fail-closed — malformed metadata reads as MISSING evidence, never as approval.

const Skill75EnvelopeBase = {
  contract: z.literal(SKILL75_CONTRACT),
  version: z.literal(SKILL75_CONTRACT_VERSION),
};

/** A revision-bound approval decision (spec 5.2). */
export const Skill75ApprovalEnvelopeSchema = z.object({
  ...Skill75EnvelopeBase,
  kind: z.literal('approval'),
  artifact_kind: z.enum(SKILL75_REQUIRED_APPROVAL_KINDS),
  revision: z.number().int().positive(),
  // Hash of the approved payload/asset manifest — the revision binding.
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'sha256 must be 64 hex characters')
    .optional(),
  decision: z.enum(['approved', 'revised']),
  approver: z.string().min(1).max(200),
  decided_at: z.string().min(1).max(64),
  thread_id: z.string().max(128).optional(),
});
export type Skill75ApprovalEnvelope = z.infer<typeof Skill75ApprovalEnvelopeSchema>;

/** Independent reviewer evidence — the reviewer may never be the executor. */
export const Skill75ReviewEnvelopeSchema = z.object({
  ...Skill75EnvelopeBase,
  kind: z.literal('review'),
  reviewer: z.string().min(1).max(200),
  /** The executor whose work this review covers (independence check). */
  actor: z.string().max(200),
  verdict: z.enum(['pass', 'fail']),
  scope: z.string().max(64).optional(),
  revision: z.number().int().positive().optional(),
});
export type Skill75ReviewEnvelope = z.infer<typeof Skill75ReviewEnvelopeSchema>;

/**
 * The NATIVE workflow census (spec 10.3): actual native runtime counts are the
 * authority; Command Center rows are a projection that must reconcile to them.
 * Counts are raw observed values — never clamped to a declared peak.
 */
export const Skill75NativeCensusEnvelopeSchema = z.object({
  ...Skill75EnvelopeBase,
  kind: z.literal('native_census'),
  observed_at: z.string().min(1).max(64),
  counts: z.object({
    running: z.number().int().nonnegative(),
    queued: z.number().int().nonnegative(),
    waiting: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    unfinished: z.number().int().nonnegative(),
  }),
  agents_total: z.number().int().nonnegative(),
  per_workflow: z.record(z.string(), z.number().int().nonnegative()).optional(),
});
export type Skill75NativeCensusEnvelope = z.infer<typeof Skill75NativeCensusEnvelopeSchema>;

/** One SELF-REPORTED board agent row. Never proof of execution on its own. */
export const Skill75AgentRowEnvelopeSchema = z.object({
  ...Skill75EnvelopeBase,
  kind: z.literal('agent_row'),
  workflow_id: z.string().min(1).max(128),
  agent_id: z.string().min(1).max(200),
  role: z.string().max(64).optional(),
});
export type Skill75AgentRowEnvelope = z.infer<typeof Skill75AgentRowEnvelopeSchema>;

/** Per-artifact revision + approval state, rendered beside media deliverables. */
export const Skill75ArtifactMetaSchema = z.object({
  ...Skill75EnvelopeBase,
  kind: z.literal('artifact_meta'),
  artifact_kind: z.string().min(1).max(64),
  revision: z.number().int().positive(),
  approval_state: z.enum(['pending', 'approved', 'revised']),
});
export type Skill75ArtifactMeta = z.infer<typeof Skill75ArtifactMetaSchema>;

export const Skill75EnvelopeSchema = z.discriminatedUnion('kind', [
  Skill75ApprovalEnvelopeSchema,
  Skill75ReviewEnvelopeSchema,
  Skill75NativeCensusEnvelopeSchema,
  Skill75AgentRowEnvelopeSchema,
  Skill75ArtifactMetaSchema,
]);
export type Skill75Envelope = z.infer<typeof Skill75EnvelopeSchema>;

/**
 * Parse one task_activities.metadata value into a typed Skill 75 envelope.
 * Accepts the stored JSON string or the already-parsed object (the activities
 * route accepts both shapes). Returns null for anything malformed, unknown, or
 * foreign — FAIL-CLOSED: unparseable evidence is MISSING evidence.
 */
export function parseSkill75Envelope(raw: unknown): Skill75Envelope | null {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  const parsed = Skill75EnvelopeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// Ad-campaign schemas (Skill 48 facebook-ad-generator → board)
// ---------------------------------------------------------------------------

const AdStageSlug = z.string().min(1).max(64);

export const CreateAdCampaignSchema = z.object({
  job_id: z.string().min(1).max(128),
  show_name: z.string().min(1).max(500),
  owner: z.string().max(200).optional(),
  department: z.string().max(100).optional(),
  workspace: z.string().max(200).optional(),
  agent_id: z.string().max(200).optional(), // OpenClaw id; provenance ONLY — never assigned_agent_id
  title_prefix: z.string().max(60).optional(), // epic card title/description prefix; default 'FB Ad Run'
  money_ceiling_usd: z.number().nonnegative().optional(),
  estimated_cost_usd: z.number().nonnegative().optional(),
  show_date: z.string().max(100).optional(),
  // D14 — typed completion contract (see the Skill 75 section below). Absent =
  // legacy: every supported non-Skill-75 producer keeps its exact current
  // behavior. Present = the campaign is held to that contract's completion
  // evidence at the server boundary.
  contract: CampaignContractSchema.optional(),
  // D14 — the run's canonical origin record (spec 5.4), stamped onto every
  // campaign card at creation so status/report-back returns to the recorded
  // requester conversation (Telegram chat/thread or OpenClaw-app session)
  // instead of a global owner Telegram destination. Optional/nullable to match
  // CreateTaskSchema's requester stamping (U94): an unstamped create keeps the
  // owner-report fallback behavior unchanged.
  requester_channel: z.string().min(1).max(64).optional().nullable(),
  requester_chat_id: z.string().min(1).max(128).optional().nullable(),
  requester_session_key: z.string().min(1).max(256).optional().nullable(),
  stages: z
    .array(z.object({ slug: AdStageSlug, title: z.string().max(500).optional() }))
    .max(50)
    .optional(),
});

// LOCKSTEP: ad-campaign stage cards have their OWN narrower status set
// (AdCardStatus in src/lib/ad-campaigns.ts) — NOT the full 10-status board
// TaskStatus. Originally this schema reused TaskStatus because the two happened
// to coincide at 5 values; once TaskStatus widened to the 10-status board
// manifest, reusing it would let an ad card be set to a board-only status
// (inbox/planning/assigned/testing/pending_dispatch) that moveAdStage() cannot
// accept. Pin to the AdCardStatus values to keep schema↔moveAdStage in lockstep.
const AdCardStatus = z.enum(['backlog', 'in_progress', 'review', 'blocked', 'done']);

export const UpdateAdCampaignStageSchema = z.object({
  stage_slug: AdStageSlug,
  status: AdCardStatus, // backlog | in_progress | review | blocked | done
  reason: z.string().max(2000).optional(),
  actor: z.string().max(200).optional(),
  blocked_reason: z.enum(['decision', 'approval', 'credential', 'payment']).optional().nullable(),
  blocked_on_human: z.enum(['owner', 'operator']).optional().nullable(),
  ask: z.string().max(500).optional().nullable(),
  // ── D14 — Skill 75 completion evidence at the server boundary ──────────────
  // The producer's own move contract already validates `evidence` and
  // `reviewer` client-side (cc_sync.py enqueue_move: review/done require
  // evidence, done requires an independent reviewer) but the server schema
  // stripped both, so nothing was recorded and nothing could be enforced.
  // Declared so they ARRIVE and are persisted as durable, typed records that
  // the completion boundary reads (ad-campaigns.checkSkill75Completion):
  // independent reviewer evidence and final delivery evidence must be present
  // before a Skill 75 campaign can complete, and self-approval never counts.
  // Optional everywhere: non-Skill-75 moves are byte-for-byte unchanged.
  // evidence — where the stage's work landed / what proves it (free text).
  evidence: z.string().max(4000).optional(),
  // reviewer — the INDEPENDENT reviewer identity for this move (done moves).
  reviewer: z.string().max(200).optional(),
  // approval — a revision-bound approval decision (Skill 75 envelope).
  approval: Skill75ApprovalEnvelopeSchema.optional(),
  // review — a typed independent-review record (Skill 75 envelope).
  review: Skill75ReviewEnvelopeSchema.optional(),
})
  // Same poison-state gate as UpdateTaskSchema: an ad stage card parked on a
  // human with no ask is just as unanswerable as a board card.
  .superRefine(rejectBlockedWithoutAsk);

// ---------------------------------------------------------------------------
// Archify-run schemas (Skill 69 archify → board)
//
// Same shape (and the same reasoning) as the ad-campaign schemas above: the
// producer owns the phase list, the server owns legality. The diagram type is
// a strict enum so a typo cannot create a grouping whose type no renderer
// understands.
// ---------------------------------------------------------------------------

const ArchifyPhaseSlug = z.string().min(1).max(64);

const ArchifyDiagramType = z.enum([
  'architecture',
  'workflow',
  'sequence',
  'dataflow',
  'lifecycle',
]);

export const CreateArchifyRunSchema = z.object({
  // Idempotency key. Optional: when omitted, external_run_id deterministically
  // derives the grouping id; when BOTH are omitted the server mints one and no
  // dedupe is possible (a keyless create is a create).
  run_id: z.string().min(1).max(128).optional(),
  external_run_id: z.string().min(1).max(200).optional(),
  title: z.string().min(1).max(500),
  diagram_type: ArchifyDiagramType,
  owner: z.string().max(200).optional(),
  department: z.string().max(100).optional(),
  workspace: z.string().max(200).optional(),
  agent_id: z.string().max(200).optional(), // OpenClaw id; provenance ONLY — never assigned_agent_id
  source_path: z.string().max(1000).optional(),
  phases: z
    .array(z.object({ slug: ArchifyPhaseSlug, title: z.string().max(500).optional() }))
    .max(50)
    .optional(),
});

// LOCKSTEP: archify phase cards have their OWN narrower status set
// (ArchifyCardStatus in src/lib/archify-runs.ts) — NOT the full 10-status board
// TaskStatus, exactly as AdCardStatus above is pinned. Reusing TaskStatus would
// let a phase card be set to a board-only status (inbox/planning/assigned/
// testing/pending_dispatch) that moveArchifyPhase() cannot accept.
const ArchifyCardStatus = z.enum(['backlog', 'in_progress', 'review', 'blocked', 'done']);

export const UpdateArchifyRunPhaseSchema = z.object({
  phase_slug: ArchifyPhaseSlug,
  status: ArchifyCardStatus, // backlog | in_progress | review | blocked | done
  // Progress note + where the phase's work landed. artifact_url must be a valid
  // http(s) URL or an existing non-empty path on the CC box, because the
  // review/done gates require registered, REACHABLE evidence (FIX 25 / T0-01).
  note: z.string().max(2000).optional().nullable(),
  artifact_url: z.string().max(2000).optional().nullable(),
  reason: z.string().max(2000).optional(),
  actor: z.string().max(200).optional(),
  blocked_reason: z.enum(['decision', 'approval', 'credential', 'payment']).optional().nullable(),
  blocked_on_human: z.enum(['owner', 'operator']).optional().nullable(),
  ask: z.string().max(500).optional().nullable(),
})
  // Same poison-state gate: a phase card parked on a human with no ask is just
  // as unanswerable as a board card.
  .superRefine(rejectBlockedWithoutAsk);
