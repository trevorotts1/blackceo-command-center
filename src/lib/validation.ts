import { z } from 'zod';

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
const TaskStatus = z.enum([
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

const DeliverableType = z.enum(['file', 'url', 'artifact']);

// Task validation schemas
export const CreateTaskSchema = z.object({
  title: z.string().min(1, 'Title is required').max(500, 'Title must be 500 characters or less'),
  description: z.string().max(10000, 'Description must be 10000 characters or less').optional(),
  status: TaskStatus.optional(),
  priority: TaskPriority.optional(),
  assigned_agent_id: z.string().uuid().optional(),
  created_by_agent_id: z.string().uuid().optional(),
  business_id: z.string().optional(),
  workspace_id: z.string().optional(),
  department: z.string().optional(),
  due_date: z.string().optional(),
  sop_id: z.string().uuid().optional().nullable(),
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
  process_certificate_sha: z.string().optional(),
});

// Activity validation schema
export const CreateActivitySchema = z.object({
  activity_type: ActivityType,
  message: z.string().min(1, 'Message is required').max(5000, 'Message must be 5000 characters or less'),
  agent_id: z.string().uuid().optional(),
  metadata: z.string().optional(),
});

// Deliverable validation schema
export const CreateDeliverableSchema = z.object({
  deliverable_type: DeliverableType,
  title: z.string().min(1, 'Title is required'),
  path: z.string().optional(),
  description: z.string().optional(),
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
});
