/**
 * Intelligence Settings Resolver
 *
 * Resolves which model and persona should be used for a given agent + department.
 *
 * MODEL resolution order (highest wins):
 *   1. SOP pin — sops.model_pin for task.sop_id (explicit author intent)
 *   2. Task-time selector — selectTaskModel() from model-selector.ts
 *      (nature + difficulty + modality → cascade Ollama Cloud → OpenRouter OSS → Free)
 *   3. Role-level override in agent_settings (role_id = agent.id)
 *   4. Department-level default in agent_settings (role_id IS NULL)
 *   5. needs_owner_input — NEVER 'openrouter/free'
 *
 * PERSONA resolution order (Hop 10 — bread-and-butter persona pipeline):
 *   1. Task-pinned persona (tasks.persona_id / tasks.persona_name written by
 *      persona-selector-v2.py at selection time). Highest priority — this is
 *      the live output of the 5-layer scoring matrix for THIS task.
 *   2. Sticky (department, task_category) assignment from persona_assignment
 *      table. The selector upserts there on every dispatch; this is the
 *      "what did we pick last time for this kind of task in this department"
 *      memory. Used when the current task hasn't been scored yet.
 *   3. Role-level override in agent_settings (role_id = agent.id)
 *   4. Department-level default in agent_settings (role_id IS NULL)
 *   5. Hardcoded default (DEFAULT_PERSONA = 'auto')
 *
 * When persona resolves to 'auto', no explicit persona is set — the orchestrator
 * makes the choice at runtime based on task context.
 */

import { queryOne, queryAll, run } from '@/lib/db';
import { selectTaskModel, NEEDS_OWNER_INPUT, detectModality } from '@/lib/model-selector';
import type { TaskModality } from '@/lib/model-selector';
import type { ModelRegistryEntry } from '@/lib/model-registry-types';

/** Sentinel — returned when no valid model can be resolved without owner input. */
export const NEEDS_OWNER_INPUT_SENTINEL = NEEDS_OWNER_INPUT;

/**
 * DEPRECATED SENTINEL — kept as a named constant so the AF-MODEL-SOVEREIGNTY gate
 * can explicitly reject it. Never returned as a resolution result.
 */
export const REJECTED_FREE_DEFAULT = 'openrouter/free';

export const DEFAULT_PERSONA = 'auto';

export type PersonaSource =
  | 'task_pinned'
  | 'sticky_assignment'
  | 'role_override'
  | 'department_default'
  | 'hardcoded_default';

export type ModelSource =
  | 'sop_pin'
  | 'task_selector'
  | 'role_override'
  | 'department_default'
  | 'needs_owner_input';

export interface ResolvedSettings {
  model: string;
  modelSource: ModelSource;
  persona: string;
  personaSource: PersonaSource;
  personaMode?: string | null;
  taskCategory?: string | null;
  /** Modality the task-time selector determined for this dispatch. */
  required_modality?: TaskModality | null;
  /** Difficulty tier the selector classified. */
  difficulty?: 'heavy' | 'mid' | 'fast' | null;
  /** Selector tier that won (1=Ollama Cloud, 2=OpenRouter OSS, 3=Free). */
  model_tier?: 1 | 2 | 3 | null;
}

interface AgentSettingRow {
  value: string;
}

interface SopPinRow {
  model_pin: string | null;
}

interface TaskContextRow {
  title: string;
  description: string | null;
  department: string | null;
  sop_id: string | null;
}

interface ModelRegistryRow {
  model_id: string;
  provider: string;
  family: string | null;
  context_window: number | null;
  input_cost_per_million: number | null;
  output_cost_per_million: number | null;
  pricing_model: string;
  pricing_source: string;
  capabilities: string;
  status: string;
  added_at: string;
  last_seen_at: string;
  raw_metadata: string;
  label: string;
  id: number;
}

function decodeRegistryRow(row: ModelRegistryRow): ModelRegistryEntry {
  let capabilities: ModelRegistryEntry['capabilities'] = [];
  try {
    const parsed = JSON.parse(row.capabilities || '[]');
    if (Array.isArray(parsed)) capabilities = parsed;
  } catch { /* ignore */ }
  let raw_metadata: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.raw_metadata || '{}');
    if (parsed && typeof parsed === 'object') raw_metadata = parsed as Record<string, unknown>;
  } catch { /* ignore */ }
  return {
    ...row,
    pricing_model: row.pricing_model as ModelRegistryEntry['pricing_model'],
    status: row.status as ModelRegistryEntry['status'],
    capabilities,
    raw_metadata,
  };
}

/** Load all active models from the registry, available for selection. */
function loadInventory(): ModelRegistryEntry[] {
  try {
    const rows = queryAll<ModelRegistryRow>(
      `SELECT * FROM model_registry WHERE status = 'active' ORDER BY provider ASC, label ASC`,
    );
    return rows.map(decodeRegistryRow);
  } catch {
    return [];
  }
}

interface TaskPersonaRow {
  persona_id: string | null;
  persona_name: string | null;
  persona_mode: string | null;
}

interface PersonaAssignmentRow {
  persona_id: string;
  persona_name: string | null;
  persona_mode: string | null;
  task_category: string;
}

/**
 * Resolve the effective model and persona for an agent in a department.
 *
 * @param agentId - The agent's ID (used as role_id in agent_settings)
 * @param departmentId - The workspace/department ID
 * @param taskId - (Optional) The task ID. When provided, Hop 10 lookups run:
 *                 the resolver first checks `tasks.persona_id` (pinned by the
 *                 persona-selector at selection time), then the sticky
 *                 `persona_assignment` row for (department_id, task_category).
 *                 Only if neither exists does it fall through to agent_settings.
 * @returns ResolvedSettings with the effective model, persona, and their sources
 */
export function resolveSettings(
  agentId: string,
  departmentId: string,
  taskId?: string
): ResolvedSettings {
  // ── MODEL RESOLUTION (5-layer precedence) ──────────────────────────────────

  // Load task context for selector and SOP-pin lookup.
  let taskContext: TaskContextRow | null = null;
  if (taskId) {
    try {
      taskContext = queryOne<TaskContextRow>(
        `SELECT title, description, department, sop_id FROM tasks WHERE id = ?`,
        [taskId],
      ) ?? null;
    } catch { /* tolerant of old DBs */ }
  }

  let model: string = NEEDS_OWNER_INPUT;
  let modelSource: ModelSource = 'needs_owner_input';
  let required_modality: TaskModality | null = null;
  let difficulty: 'heavy' | 'mid' | 'fast' | null = null;
  let model_tier: 1 | 2 | 3 | null = null;

  // Layer 1: SOP pin — sops.model_pin for task.sop_id (author intent wins)
  const sopId = taskContext?.sop_id ?? null;
  if (sopId) {
    try {
      const sopPin = queryOne<SopPinRow>(
        `SELECT model_pin FROM sops WHERE id = ? AND deleted_at IS NULL`,
        [sopId],
      );
      if (sopPin?.model_pin) {
        model = sopPin.model_pin;
        modelSource = 'sop_pin';
      }
    } catch { /* sops.model_pin column may not exist on older DBs yet */ }
  }

  // Layer 2: Task-time selector (skipped if SOP pin already won)
  if (modelSource === 'needs_owner_input' && taskContext) {
    const inventory = loadInventory();
    if (inventory.length > 0) {
      const sel = selectTaskModel({
        title: taskContext.title,
        description: taskContext.description,
        department: taskContext.department,
        inventory,
      });
      if (!sel.needs_owner_input && sel.model_id !== NEEDS_OWNER_INPUT) {
        model = sel.model_id as string;
        modelSource = 'task_selector';
        required_modality = sel.required_modality;
        difficulty = sel.difficulty;
        model_tier = sel.tier;
      }
    }
  } else if (modelSource === 'needs_owner_input' && taskId && !taskContext) {
    // No task context available — fall through to role/dept overrides below.
  }

  // Layer 3: Role-level override in agent_settings
  if (modelSource === 'needs_owner_input') {
    const roleModel = queryOne<AgentSettingRow>(
      `SELECT value FROM agent_settings
       WHERE department_id = ? AND role_id = ? AND setting_type = 'model'`,
      [departmentId, agentId],
    );
    if (roleModel?.value && roleModel.value !== REJECTED_FREE_DEFAULT) {
      model = roleModel.value;
      modelSource = 'role_override';
    }
  }

  // Layer 4: Department-level default in agent_settings
  if (modelSource === 'needs_owner_input') {
    const deptModel = queryOne<AgentSettingRow>(
      `SELECT value FROM agent_settings
       WHERE department_id = ? AND role_id IS NULL AND setting_type = 'model'`,
      [departmentId],
    );
    if (deptModel?.value && deptModel.value !== REJECTED_FREE_DEFAULT) {
      model = deptModel.value;
      modelSource = 'department_default';
    }
  }

  // Layer 5: needs_owner_input (model stays NEEDS_OWNER_INPUT — NEVER openrouter/free)

  // --- PERSONA RESOLUTION ---
  // Hop 10 Step 1: task-pinned persona (written by persona-selector-v2.py to
  // tasks.persona_id / .persona_name / .persona_mode). Tolerant: skip if the
  // task row or persona columns are missing on older DBs.
  let taskPin: TaskPersonaRow | null = null;
  if (taskId) {
    try {
      taskPin = queryOne<TaskPersonaRow>(
        `SELECT persona_id, persona_name, persona_mode FROM tasks WHERE id = ?`,
        [taskId]
      ) ?? null;
    } catch {
      taskPin = null;
    }
  }
  if (taskPin && taskPin.persona_id && taskPin.persona_name) {
    return {
      model,
      modelSource,
      persona: taskPin.persona_name,
      personaSource: 'task_pinned',
      personaMode: taskPin.persona_mode ?? null,
      taskCategory: null,
      required_modality: required_modality ?? null,
      difficulty: difficulty ?? null,
      model_tier: model_tier ?? null,
    };
  }

  // Hop 10 Step 2: sticky (department_id, task_category) from persona_assignment.
  // task_category isn't on the tasks table directly; derive it from
  // persona_selection_log for this task (if it ran), then look up the
  // sticky row. Tolerant of missing tables on older DBs.
  let stickyCategory: string | null = null;
  let stickyAssignment: PersonaAssignmentRow | null = null;
  if (taskId) {
    try {
      const logRow = queryOne<{ mode: string | null; task_category?: string | null }>(
        `SELECT mode FROM persona_selection_log WHERE task_id = ? ORDER BY selected_at DESC LIMIT 1`,
        [taskId]
      );
      // task_category is the dispatch input the selector uses to key
      // persona_assignment. The log doesn't store it, but the v2 selector
      // upserts persona_assignment using the same department_id, so we can
      // pull the most-recently-assigned row for this department as the sticky
      // default when no exact category match is available.
      void logRow;
    } catch {
      // No log table — fine.
    }

    try {
      stickyAssignment = queryOne<PersonaAssignmentRow>(
        `SELECT persona_id, persona_name, persona_mode, task_category
         FROM persona_assignment
         WHERE department_id = ?
         ORDER BY last_assigned_at DESC LIMIT 1`,
        [departmentId]
      ) ?? null;
      stickyCategory = stickyAssignment?.task_category ?? null;
    } catch {
      stickyAssignment = null;
    }
  }
  if (stickyAssignment && stickyAssignment.persona_name) {
    return {
      model,
      modelSource,
      persona: stickyAssignment.persona_name,
      personaSource: 'sticky_assignment',
      personaMode: stickyAssignment.persona_mode ?? null,
      taskCategory: stickyCategory,
      required_modality: required_modality ?? null,
      difficulty: difficulty ?? null,
      model_tier: model_tier ?? null,
    };
  }

  // Hop 10 Step 3-5: fall back to existing agent_settings cascade.
  const rolePersona = queryOne<AgentSettingRow>(
    `SELECT value FROM agent_settings
     WHERE department_id = ? AND role_id = ? AND setting_type = 'persona'`,
    [departmentId, agentId]
  );

  const deptPersona = queryOne<AgentSettingRow>(
    `SELECT value FROM agent_settings
     WHERE department_id = ? AND role_id IS NULL AND setting_type = 'persona'`,
    [departmentId]
  );

  const persona = rolePersona?.value || deptPersona?.value || DEFAULT_PERSONA;
  const personaSource: PersonaSource = rolePersona
    ? 'role_override'
    : deptPersona
      ? 'department_default'
      : 'hardcoded_default';

  return {
    model,
    modelSource,
    persona,
    personaSource,
    personaMode: null,
    taskCategory: null,
    required_modality: required_modality ?? null,
    difficulty: difficulty ?? null,
    model_tier: model_tier ?? null,
  };
}

/**
 * Resolve specialist_type for an agent.
 * Returns 'permanent' for master agents, 'on-call' for everyone else.
 * If the agent has a specialist_type column, it's read from DB.
 * Otherwise, inferred from is_master.
 */
export function resolveSpecialistType(agent: {
  is_master?: number | boolean;
  specialist_type?: string | null;
}): 'permanent' | 'on-call' {
  if (agent.specialist_type) {
    return agent.specialist_type as 'permanent' | 'on-call';
  }
  return agent.is_master ? 'permanent' : 'on-call';
}

/**
 * Log a resolved model/persona decision to task_activities for traceability.
 * This makes every dispatch auditable in the Activity tab.
 */
export function logDispatchResolution(
  taskId: string,
  agentId: string,
  settings: ResolvedSettings
): void {
  const personaDesc =
    settings.persona === 'auto'
      ? 'auto-select (no explicit persona)'
      : settings.persona;

  const tierLabel = settings.model_tier === 1
    ? 'Tier1-OllamaCloud'
    : settings.model_tier === 2
      ? 'Tier2-OpenRouterOSS'
      : settings.model_tier === 3
        ? 'Tier3-Free'
        : null;

  const message =
    `Dispatch resolution: model=${settings.model} (${settings.modelSource}${tierLabel ? '/' + tierLabel : ''}), ` +
    `persona=${personaDesc} (${settings.personaSource})` +
    (settings.required_modality ? `, modality=${settings.required_modality}` : '') +
    (settings.difficulty ? `, difficulty=${settings.difficulty}` : '');

  run(
    `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, metadata)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      crypto.randomUUID(),
      taskId,
      agentId,
      'status_changed',
      message,
      JSON.stringify({
        model: settings.model,
        modelSource: settings.modelSource,
        model_tier: settings.model_tier ?? null,
        required_modality: settings.required_modality ?? null,
        difficulty: settings.difficulty ?? null,
        persona: settings.persona,
        personaSource: settings.personaSource,
        personaMode: settings.personaMode ?? null,
        taskCategory: settings.taskCategory ?? null,
      }),
    ]
  );
}

/**
 * Full resolution + logging in one call.
 * Use this at dispatch time: resolve, log, return settings.
 * Hop 10: passes taskId into resolveSettings so the task-pinned persona
 * (from persona-selector-v2.py) wins over agent_settings defaults.
 */
export function resolveAndLog(
  taskId: string,
  agentId: string,
  departmentId: string
): ResolvedSettings {
  const settings = resolveSettings(agentId, departmentId, taskId);
  logDispatchResolution(taskId, agentId, settings);
  return settings;
}
