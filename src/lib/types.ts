// Core types for Command Center

export type AgentStatus = 'standby' | 'working' | 'offline' | 'active';

// CANONICAL status manifest — the 10 real task statuses. The other three status
// manifests (validation.ts TaskStatus z.enum, task-lifecycle.ts LifecycleState +
// LEGAL_TRANSITIONS) MUST stay in lockstep with this union.
//
// DISP-12: 'archived' is intentionally NOT a member. Archival is a SOFT-archive
// TIMESTAMP (`Task.archived_at` — IS NOT NULL = archived; NULL = live on the
// board), never a status value. Any code that excludes archived tasks must
// filter on `archived_at IS NULL`, NOT `status = 'archived'` / a status set that
// contains 'archived'. task-dispatcher.ts currently references a phantom
// 'archived' status (SKIP_STATUSES + a block WHERE-clause `status NOT IN
// ('done','archived')`); because 'archived' can never equal any real status,
// those clauses are inert today but drift-prone — the fix is to drop 'archived'
// there and use `archived_at IS NULL` (owned by lane L1; see L3 hand-off note).
export type TaskStatus = 'backlog' | 'inbox' | 'planning' | 'in_progress' | 'assigned' | 'review' | 'testing' | 'blocked' | 'pending_dispatch' | 'done';

// Bug ticket lifecycle (T3-001) -- dedicated 7-stage status for the Bugs Department.
// These are SEPARATE from TaskStatus and live in the bug_tickets table, not tasks.
export type BugStatus =
  | 'REPORTED'
  | 'TRIAGED'
  | 'HEALING'
  | 'VERIFYING'
  | 'HEALED'
  | 'REGRESSION WATCH'
  | 'CLOSED';

export type BugSeverity =
  | 'P0 run-dead'
  | 'P1 degraded'
  | 'P2 cosmetic or latent'
  | 'P3 improvement';

export interface BugTicket {
  id: string;                          // BUG-YYYYMMDD-NNN
  workspace_id: string;                // defaults to 'bugs'
  reporter_department: string;
  reporter_specialist?: string;
  reporter_run_id?: string;
  symptom: string;
  severity: BugSeverity;
  suspected_layer?: string;
  client_slug?: string;
  status: BugStatus;
  assigned_healer_agent_id?: string;
  dedup_of?: string;                   // bug_id of the canonical ticket if this is a recurrence
  recurrence_count: number;
  evidence_paths?: string;             // JSON array
  regression_watch_until?: string;
  root_cause?: string;
  fix_summary?: string;
  healing_report_path?: string;
  reported_at: string;
  closed_at?: string;
  created_at: string;
  updated_at: string;
}

export interface BugTicketEvent {
  id: string;
  bug_id: string;
  from_status?: string;
  to_status: string;
  actor?: string;
  reason?: string;
  created_at: string;
}

export interface CreateBugTicketRequest {
  reporter_department: string;
  symptom: string;
  severity?: BugSeverity;
  reporter_specialist?: string;
  reporter_run_id?: string;
  suspected_layer?: string;
  client_slug?: string;
  evidence_paths?: string;
  workspace_id?: string;
}

export type TaskPriority = 'low' | 'medium' | 'high' | 'critical';

export type MessageType = 'text' | 'system' | 'task_update' | 'file';

export type ConversationType = 'direct' | 'group' | 'task';

export type EventType =
  | 'task_created'
  | 'task_assigned'
  | 'task_status_changed'
  | 'task_completed'
  | 'message_sent'
  | 'agent_status_changed'
  | 'agent_joined'
  | 'system';

export interface Agent {
  id: string;
  name: string;
  role: string;
  description?: string;
  avatar_emoji: string;
  status: AgentStatus;
  is_master: boolean;
  workspace_id: string;
  soul_md?: string;
  user_md?: string;
  agents_md?: string;
  tools_md?: string;
  memory_md?: string;
  model?: string;
  /** Active persona for this agent's current/latest task */
  persona?: string;
  /** "permanent" = full-time team member, "on-call" = spawned when needed */
  specialist_type?: 'permanent' | 'on-call';
  created_at: string;
  updated_at: string;
}

/**
 * One sub-task's persona pick on a decomposed (multi-persona) task — a
 * `task_subtask_persona` row (DEP-5 / F3.7 + F3.9). Rendered as a slot chip on
 * the kanban card.
 */
export interface TaskSubtaskPersona {
  seq: number;
  subtask_text?: string | null;
  persona_id: string | null;
  persona_name?: string | null;
  score?: number | null;
  department?: string | null;
  task_category?: string | null;
  /** Which declared SOP slot this sub-task filled (F3.9); NULL for text decomp. */
  slot?: string | null;
}

export interface Task {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  assigned_agent_id: string | null;
  created_by_agent_id: string | null;
  workspace_id: string;
  business_id: string;
  due_date?: string;
  created_at: string;
  updated_at: string;
  // New metadata fields
  dependencies: string[];
  parallel_candidates: string[];
  block_reason?: string;
  // Block transparency fields (migration 073 / v4.44.0).
  // Populated by the QC scorer when it caps the reroute loop and sets the task
  // to `blocked`. The board renders these on the blocked card so the owner or
  // system operator immediately sees WHY the task is stuck and what is needed.
  block_gaps?: string | null;        // JSON-encoded string[] of the specific QC failure reasons
  block_needs?: string | null;       // The single resolving action (human-readable)
  block_audience?: 'OWNER' | 'SYSTEM' | null;  // Who must act: 'OWNER' = human; 'SYSTEM' = operator/system fix
  sprint?: string;
  department?: string;
  // FIX C — Presentations no-skip proof certificate sha (migration 080). Set when
  // a deck run registers its prove-deck.py PROCESS-CERTIFICATE; the done/delivered
  // gate in PATCH /api/tasks/[id] requires a presentations task to carry/match it.
  process_certificate_sha?: string | null;
  // Planning fields
  planning_session_key?: string;
  planning_messages?: string;
  planning_complete?: number;
  planning_spec?: string;
  planning_agents?: string;
  planning_dispatch_error?: string;
  // Persona governance fields (Hop 10 — written by persona-selector-v2.py
  // at dispatch time; consumed by intelligence-resolver and the dashboard UI).
  // Migration 016 adds these columns to the `tasks` table.
  persona_id?: string | null;
  persona_name?: string | null;
  persona_mode?: string | null;
  persona_score?: number | null;
  persona_selected_at?: string | null;
  persona_version?: number | null;
  // Multi-persona plan rows (DEP-5 / F3.7 + F3.9 — migration 088). Present only on
  // decomposed tasks; populated by the tasks GET route + the persona-plan SSE
  // broadcast so the kanban card can render per-sub-task slot chips. Empty/absent
  // for a single-persona task.
  subtask_personas?: TaskSubtaskPersona[];
  // SOP / Triad Rule fields (migration 022)
  sop_id?: string | null;
  sop_step_progress?: string | null;
  // Resolved model pinned at dispatch (v4.0.1 P0-7, migration 044).
  // References model_registry(model_id) at the application layer.
  model_id?: string | null;
  // Soft-archive timestamp set by the weekly Done-clear job (migration 055).
  // IS NOT NULL = task has been archived; NULL = live on the board.
  archived_at?: string | null;
  // QC loop guard (migration 061): number of times the QC scorer has returned
  // this task to backlog after a FAIL. Capped at QC_MAX_REROUTES (default 3)
  // before the task is set to `blocked` for human review.
  qc_reroute_attempts?: number | null;
  // Dispatch attempt-accounting (migration 077 / W8 anti-furnace). Incremented on
  // EVERY failed advance attempt (gateway down / sovereignty / no-runtime). Drives
  // exponential backoff (next_dispatch_eligible_at) and the block-on-N cap so an
  // unadvanceable task can never become a re-dispatch furnace. Reset to 0 on a
  // successful advance to in_progress.
  dispatch_attempts?: number | null;
  last_dispatch_attempt_at?: string | null;
  next_dispatch_eligible_at?: string | null;
  // Campaign board feed (migration 017 column; wired by W8.4). Groups the task
  // onto its department's live campaign Kanban so routed work shows + moves.
  campaign_id?: string | null;
  // PRD 2.12-cc: when set, this task IS the "Author SOP" sub-task for the
  // referenced originalTaskId. The dispatch fast-loop recursion guard skips
  // SOP authoring for any task with this field set. (migration 066)
  sop_authoring_for_task_id?: string | null;
  // Joined fields (populated by the tasks API GET; not stored on the row)
  model_label?: string | null;
  model_provider?: string | null;
  model_input_cost_per_million?: number | null;
  model_output_cost_per_million?: number | null;
  assigned_agent?: Agent;
  created_by_agent?: Agent;
}

export interface Conversation {
  id: string;
  title?: string;
  type: ConversationType;
  task_id?: string;
  created_at: string;
  updated_at: string;
  // Joined fields
  participants?: Agent[];
  last_message?: Message;
}

export interface Message {
  id: string;
  conversation_id: string;
  sender_agent_id?: string;
  content: string;
  message_type: MessageType;
  metadata?: string;
  created_at: string;
  // Joined fields
  sender?: Agent;
}

export interface Event {
  id: string;
  type: EventType;
  agent_id?: string;
  task_id?: string;
  message: string;
  metadata?: string;
  created_at: string;
  // Joined fields
  agent?: Agent;
  task?: Task;
}

export interface Business {
  id: string;
  name: string;
  description?: string;
  created_at: string;
}

export interface Company {
  id: string;
  name: string;
  slug: string;
  industry?: string;
  logo_url?: string;
  config: string;
  created_at: string;
  updated_at: string;
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  description?: string;
  icon: string;
  company_id?: string;
  user_md?: string;
  sort_order?: number;
  /** Agent designated as the department head; rendered prominently on the workspace page. */
  head_agent_id?: string | null;
  head_agent_name?: string | null;
  head_agent_avatar?: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentMemoryLog {
  id: string;
  agent_id: string;
  log_date: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceStats {
  id: string;
  name: string;
  slug: string;
  icon: string;
  sort_order?: number;
  head_agent_id?: string | null;
  head_agent_name?: string | null;
  head_agent_avatar?: string | null;
  taskCounts: {
    backlog: number;
    in_progress: number;
    review: number;
    blocked: number;
    done: number;
    total: number;
  };
  agentCount: number;
}

export interface OpenClawSession {
  id: string;
  agent_id: string;
  openclaw_session_id: string;
  channel?: string;
  status: string;
  session_type: 'persistent' | 'subagent';
  task_id?: string;
  ended_at?: string;
  created_at: string;
  updated_at: string;
}

export type ActivityType = 'spawned' | 'updated' | 'completed' | 'file_created' | 'status_changed' | 'owner_message' | 'agent_message';

export interface TaskActivity {
  id: string;
  task_id: string;
  agent_id?: string;
  activity_type: ActivityType;
  message: string;
  metadata?: string;
  created_at: string;
  // Joined fields
  agent?: Agent;
}

// QC-03: keep in lockstep with the Zod DeliverableType enum in validation.ts.
export type DeliverableType = 'file' | 'url' | 'artifact' | 'image';

export interface TaskDeliverable {
  id: string;
  task_id: string;
  deliverable_type: DeliverableType;
  title: string;
  path?: string;
  description?: string;
  created_at: string;
}

// Planning types
export type PlanningQuestionType = 'multiple_choice' | 'text' | 'yes_no';

export type PlanningCategory = 
  | 'goal'
  | 'audience'
  | 'scope'
  | 'design'
  | 'content'
  | 'technical'
  | 'timeline'
  | 'constraints';

export interface PlanningQuestionOption {
  id: string;
  label: string;
}

export interface PlanningQuestion {
  id: string;
  task_id: string;
  category: PlanningCategory;
  question: string;
  question_type: PlanningQuestionType;
  options?: PlanningQuestionOption[];
  answer?: string;
  answered_at?: string;
  sort_order: number;
  created_at: string;
}

export interface PlanningSpec {
  id: string;
  task_id: string;
  spec_markdown: string;
  locked_at: string;
  locked_by?: string;
  created_at: string;
}

export interface PlanningState {
  questions: PlanningQuestion[];
  spec?: PlanningSpec;
  progress: {
    total: number;
    answered: number;
    percentage: number;
  };
  isLocked: boolean;
}

// Department Memory types
export type MemoryType = 'decision' | 'context' | 'lesson' | 'goal' | 'constraint';

export interface DeptMemory {
  id: string;
  workspace_id: string;
  memory_type: MemoryType;
  content: string;
  created_by: string;
  importance: number;
  created_at: string;
  updated_at: string;
}

export interface CreateDeptMemoryRequest {
  workspace_id: string;
  memory_type: MemoryType;
  content: string;
  created_by?: string;
  importance?: number;
}

export interface UpdateDeptMemoryRequest {
  content?: string;
  importance?: number;
}

// API request/response types
export interface CreateAgentRequest {
  name: string;
  role: string;
  description?: string;
  avatar_emoji?: string;
  is_master?: boolean;
  soul_md?: string;
  user_md?: string;
  agents_md?: string;
  tools_md?: string;
  memory_md?: string;
  model?: string;
  specialist_type?: 'permanent' | 'on-call';
}

export interface UpdateAgentRequest extends Partial<CreateAgentRequest> {
  status?: AgentStatus;
}

export interface CreateTaskRequest {
  title: string;
  description?: string;
  priority?: TaskPriority;
  assigned_agent_id?: string;
  created_by_agent_id?: string;
  business_id?: string;
  due_date?: string;
  dependencies?: string[];
  parallel_candidates?: string[];
  block_reason?: string;
  block_gaps?: string | null;
  block_needs?: string | null;
  block_audience?: 'OWNER' | 'SYSTEM' | null;
  sprint?: string;
  department?: string;
  workspace_id?: string;
  sop_id?: string | null;
}

export interface UpdateTaskRequest extends Partial<CreateTaskRequest> {
  status?: TaskStatus;
  sop_step_progress?: string | null;
}

export interface SendMessageRequest {
  conversation_id: string;
  sender_agent_id: string;
  content: string;
  message_type?: MessageType;
  metadata?: string;
}

// OpenClaw WebSocket message types
export interface OpenClawMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface OpenClawSessionInfo {
  id: string;
  channel: string;
  peer?: string;
  model?: string;
  status: string;
}

// OpenClaw history message format (from Gateway)
export interface OpenClawHistoryMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: string;
}

// Agent with OpenClaw session info (extended for UI use)
export interface AgentWithOpenClaw extends Agent {
  openclawSession?: OpenClawSession | null;
}

// Real-time SSE event types
export type SSEEventType =
  | 'task_updated'
  | 'task_created'
  | 'task_deleted'
  | 'activity_logged'
  | 'task_message'
  | 'deliverable_added'
  | 'agent_spawned'
  | 'agent_completed'
  | 'recommendation_created'
  | 'recommendation_updated'
  | 'execution_queue_updated'
  | 'recommendation_outcome_recorded'
  | 'publish_queued'
  | 'bug_updated'
  | 'bug_created';

export interface SSEEvent {
  type: SSEEventType;
  payload: Task | TaskActivity | TaskDeliverable | Recommendation | ExecutionQueueItem | {
    taskId: string;
    sessionId: string;
    agentName?: string;
    summary?: string;
    deleted?: boolean;
  } | {
    id: string;  // For task_deleted events
  } | {
    recommendation_id: string;
    outcome: unknown;
  } | {
    task_id: string;
    activity: TaskActivity;
  } | PublishQueueItem;
}

// Skill 35 publish-queue row (mirrors the publish_queue table from migration 022)
export interface PublishQueueItem {
  id: string;
  task_id: string | null;
  topic: string;
  platforms: string[];                 // decoded from the stored JSON string
  schedule: 'auto' | 'now' | string;   // ISO 8601 also allowed
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  run_id: string | null;
  requested_by: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface Recommendation {
  id: string;
  department_id: string;
  category: 'do-more' | 'stop' | 'watch' | 'try';
  title: string;
  description: string;
  supporting_data?: string;
  confidence: number;
  status: 'pending' | 'approved' | 'dismissed' | 'saved';
  created_at: string;
  resolved_at?: string;
}

// Execution Queue types (Out-of-Hours)
export type ExecutionWindow = 'evening' | 'overnight' | 'morning';
export type ExecutionQueueStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface ExecutionQueueItem {
  id: string;
  task_id?: string;
  recommendation_id?: string;
  task_name: string;
  department?: string;
  queued_at: string;
  scheduled_window: ExecutionWindow;
  status: ExecutionQueueStatus;
  started_at?: string;
  completed_at?: string;
  result_notes?: string;
  created_at: string;
  updated_at: string;
}

export interface CreateExecutionQueueRequest {
  task_name: string;
  task_id?: string;
  recommendation_id?: string;
  department?: string;
  scheduled_window?: ExecutionWindow;
}

export interface UpdateExecutionQueueRequest {
  status?: ExecutionQueueStatus;
  result_notes?: string;
  started_at?: string;
  completed_at?: string;
}
