import { z } from 'zod';

// Task status and priority enums from types
const TaskStatus = z.enum([
  'backlog',
  'in_progress',
  'review',
  'blocked',
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
  due_date: z.string().optional(),
  department: z.string().optional(),
  dependencies: z.array(z.string()).optional(),
  parallel_candidates: z.array(z.string()).optional(),
  block_reason: z.string().optional(),
  sprint: z.string().optional(),
});

export const UpdateTaskSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(10000).optional(),
  status: TaskStatus.optional(),
  priority: TaskPriority.optional(),
  assigned_agent_id: z.string().uuid().optional().nullable(),
  due_date: z.string().optional().nullable(),
  updated_by_agent_id: z.string().uuid().optional(),
  department: z.string().optional().nullable(),
  block_reason: z.string().optional().nullable(),
  sprint: z.string().optional().nullable(),
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
