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

const ActivityType = z.enum([
  'spawned',
  'updated',
  'completed',
  'file_created',
  'status_changed'
]);

// QC-03: 'image' is a first-class deliverable type. Without it a mis-instructed
// agent that registers an image deliverable is rejected by the Zod enum, falls
// into the empty-manifest → heuristic-cap → stuck trap. Keep in lockstep with
// the DeliverableType TS union in types.ts.
const DeliverableType = z.enum(['file', 'url', 'artifact', 'image']);

// Task validation schemas
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
  assigned_agent_id: z.string().uuid().optional().nullable(),
  created_by_agent_id: z.string().uuid().optional(),
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
});

export const UpdateTaskSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(10000).optional(),
  status: TaskStatus.optional(),
  priority: TaskPriority.optional(),
  assigned_agent_id: z.string().uuid().optional().nullable(),
  due_date: z.string().optional().nullable(),
  updated_by_agent_id: z.string().uuid().optional(),
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
export const CreateActivitySchema = z.object({
  activity_type: ActivityType,
  message: z.string().min(1, 'Message is required').max(5000, 'Message must be 5000 characters or less'),
  agent_id: z.string().uuid().optional(),
  // B-U6 / U20 fix: every real caller (cc_board.py post_activity/post_qc_score,
  // src/lib/orchestration.ts logActivity) sends `metadata` as a nested JSON
  // OBJECT inside the request body — `z.string()` rejected every one of them
  // with a 400 "Validation failed" (empirically confirmed: safeParse({...,
  // metadata: {...}}) -> success:false, "expected string, received object"),
  // silently dropping metadata on EVERY real POST including the already-shipped
  // B-U12/U26 producer-scorecard contract. A pre-stringified string is still
  // accepted for back-compat with any caller that already serializes it itself.
  metadata: z.union([z.record(z.string(), z.unknown()), z.string()]).optional(),
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
  money_ceiling_usd: z.number().nonnegative().optional(),
  estimated_cost_usd: z.number().nonnegative().optional(),
  show_date: z.string().max(100).optional(),
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
})
  // Same poison-state gate as UpdateTaskSchema: an ad stage card parked on a
  // human with no ask is just as unanswerable as a board card.
  .superRefine(rejectBlockedWithoutAsk);
