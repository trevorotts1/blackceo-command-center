/**
 * Intelligence Settings Resolver
 *
 * Resolves which model and persona should be used for a given agent + department.
 *
 * MODEL resolution order (highest wins):
 *   0. Task pin — tasks.model_id set before dispatch (CEO/owner-sanctioned; GOAL-5 Item 5)
 *   1. SOP pin — sops.model_pin for task.sop_id (explicit author intent)
 *   2. Role-level override in agent_settings (role_id = agent.id)
 *   3. Department-level default in agent_settings (role_id IS NULL)
 *   4. Task-time selector — selectTaskModel() from model-selector.ts
 *      (nature + difficulty + modality → cascade Ollama Cloud → OpenRouter OSS → Free)
 *   4b. Sovereign DEFAULT (W8.5) — non-null/non-free/non-forbidden fallback
 *   5. needs_owner_input — NEVER 'openrouter/free'
 *
 * ORDER-FIX (BUG 2): role/department overrides previously sat BELOW the
 * task-time selector (layers 3/4 after layer 2), so an operator's explicit
 * Intelligence Settings pick almost never applied — the selector nearly
 * always resolves to SOMETHING as soon as any model_registry inventory
 * exists, which starves the explicit override of a chance to win. The
 * Settings UI advertises these as authoritative overrides, so they now
 * outrank the automatic selector (moved to layers 2/3, above the selector
 * at layer 4). Every explicit pick still passes through the full
 * `checkModelSovereignty` gate (not just a literal 'openrouter/free' string
 * match) — a forbidden/free/wrong-modality explicit pick is skipped with a
 * logged reason and falls through to the next layer, rather than either
 * silently winning or silently being skipped without a trace.
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
import {
  selectTaskModel,
  NEEDS_OWNER_INPUT,
  detectModality,
  resolveSovereignDefault,
  checkModelSovereignty,
} from '@/lib/model-selector';
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
  | 'sovereign_default'
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
 * Category keyword map — PORTED VERBATIM from
 * openclaw-onboarding/23-ai-workforce-blueprint/scripts/infer-task-category.py
 * (CATEGORY_KEYWORDS).
 *
 * MUST stay in LOCKSTEP with that file. The persona selector
 * (persona-selector-v2.py) keys the persona_assignment table by the
 * (department_id, task_category) pair this categorizer produces; any drift here
 * re-introduces the RESOLVER-CATEGORY misroute (Gap E) where an unpinned task
 * inherits the wrong category's persona.
 *
 * PERS-02 — TIE-BREAK CONTRACT (pinned, must match Python): declaration ORDER is
 * load-bearing. `inferTaskCategory` selects with a strict `>` (see below), so on
 * a score tie the FIRST category declared here wins. Python's infer_task_category
 * iterates this same dict in insertion order and also compares with `>`, so the
 * two engines break ties identically ONLY while this key order matches the Python
 * dict's key order. Do not reorder keys without reordering the Python dict too.
 * The golden-parity corpus in tests/unit/pers02-category-parity.test.ts locks the
 * TS side (including tie cases); run the same corpus through the Python engine to
 * close cross-repo parity.
 */
export const CATEGORY_KEYWORDS: Record<string, string[]> = {
  'email-outreach':   ['email', 'outreach', 'follow-up', 'follow up', 'cold email', 'send to', 'newsletter'],
  'social-post':      ['social', 'instagram', 'linkedin', 'facebook', 'twitter', 'tiktok', 'pinterest', 'post on', 'reel', 'story'],
  'content-write':    ['article', 'blog', 'essay', 'long form', 'long-form', 'story', 'write a', 'writeup'],
  'video-script':     ['script', 'video', 'reel script', 'ad creative', 'vsl', 'ad copy'],
  'research':         ['research', 'analyze', 'study', 'investigate', 'compile', 'find out', 'look into'],
  'strategy':         ['strategy', 'plan', 'roadmap', 'vision', 'framework', 'approach'],
  'design':           ['design', 'graphic', 'logo', 'layout', 'mockup', 'visual', 'illustrate'],
  'ops':              ['sop', 'process', 'workflow', 'automation', 'operations', 'procedure'],
  'finance':          ['budget', 'p&l', 'cashflow', 'forecast', 'pricing', 'invoice', 'payment'],
  'legal':            ['contract', 'nda', 'terms', 'policy', 'compliance', 'agreement'],
  'hr':               ['hire', 'fire', 'onboard', 'review performance', 'recruit'],
  'customer-service': ['refund', 'ticket', 'support', 'complaint', 'service issue', 'customer issue'],
  'coaching-prompt':  ['stuck', 'decide', 'advice', 'help me think', 'help me decide', 'what should i'],
  'review-feedback':  ['review my', 'feedback on my', 'critique my', 'edit my'],
};

/**
 * Faithful TS port of infer_task_category() (Python). Word-boundary match for
 * single-word keywords, substring match for multi-word keywords; highest score
 * wins; defaults to 'general'. Determinism is REQUIRED — this must reproduce the
 * exact category the selector computed so the sticky (department_id,
 * task_category) lookup hits the right persona_assignment row.
 *
 * PERS-02 tie-break: the `> bestScore` comparison is strict, so the FIRST
 * category (in CATEGORY_KEYWORDS declaration order) to reach the maximum score
 * wins a tie. This is the pinned contract shared with the Python engine — see the
 * CATEGORY_KEYWORDS docstring. Exported so PERS-11's category-aware sticky lookup
 * (tasks.ts, L7) and the golden-parity test can reuse the exact same computation.
 */
export function inferTaskCategory(taskText: string | null | undefined): string {
  const text = (taskText || '').toLowerCase();
  let bestCat = 'general';
  let bestScore = 0;
  for (const [cat, kws] of Object.entries(CATEGORY_KEYWORDS)) {
    let score = 0;
    for (const kw of kws) {
      if (kw.includes(' ')) {
        if (text.includes(kw)) score += 1;
      } else {
        // \b...\b — escape regex-special chars (mirrors Python re.escape; '-'
        // and '&' are literal outside a char class in both engines).
        const pattern = new RegExp('\\b' + kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
        if (pattern.test(text)) score += 1;
      }
    }
    // Strict `>`: on a tie the earlier-declared category holds (pinned tie-break).
    if (score > bestScore) {
      bestScore = score;
      bestCat = cat;
    }
  }
  return bestCat;
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
  // ── MODEL RESOLUTION (precedence, highest wins — see order in the file-top
  //    docstring) ────────────────────────────────────────────────────────────

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

  // Layer 0: CEO model choice (GOAL-5 Item 5). The CEO is gated from EXECUTING
  // work but PRESERVES the right to pick which model a department runs the task
  // on. That choice is persisted onto `tasks.model_id` by the ingest route
  // (requested_model) and survives re-emit/re-dispatch. When a non-empty
  // `tasks.model_id` is already set BEFORE dispatch resolution runs, it is an
  // explicit, owner-/CEO-sanctioned model and outranks every other source.
  if (taskId) {
    try {
      const pinned = queryOne<{ model_id: string | null }>(
        `SELECT model_id FROM tasks WHERE id = ?`,
        [taskId],
      );
      if (pinned?.model_id && pinned.model_id !== NEEDS_OWNER_INPUT) {
        model = pinned.model_id;
        modelSource = 'role_override'; // explicit pin; treated as a hard override
      }
    } catch { /* tasks.model_id may be absent on very old DBs — tolerant */ }
  }

  // Layer 1: SOP pin — sops.model_pin for task.sop_id (author intent wins).
  // Guarded on needs_owner_input so a Layer-0 CEO model pin (GOAL-5 Item 5) is
  // never clobbered by an SOP pin.
  const sopId = taskContext?.sop_id ?? null;
  if (modelSource === 'needs_owner_input' && sopId) {
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

  // Modality is computed once, up front, so it can gate BOTH the explicit
  // role/department override sovereignty check below AND the task-time
  // selector further down — avoids detecting it twice and keeps both layers
  // looking at the same classification for this dispatch.
  const detectedModality: TaskModality = taskContext
    ? detectModality(taskContext.title, taskContext.description)
    : 'text';

  // Inventory is loaded lazily and cached for the remainder of this call —
  // several of the layers below may each need it (role/dept sovereignty
  // check, task selector, sovereign default) but a single resolution should
  // only hit model_registry once.
  let inventoryCache: ModelRegistryEntry[] | null = null;
  const getInventory = (): ModelRegistryEntry[] => {
    if (inventoryCache === null) inventoryCache = loadInventory();
    return inventoryCache;
  };

  // Layer 2: Role-level override in agent_settings (role_id = agent.id).
  // BUG-FIX (ORDER): this used to run AFTER the task-time selector (old Layer
  // 3), so the operator's explicit Intelligence Settings pick almost never
  // applied — the selector nearly always resolves to something first. It now
  // outranks the selector. The explicit pick is gated on the FULL
  // checkModelSovereignty check (not just a literal REJECTED_FREE_DEFAULT
  // string match) so a forbidden/free/wrong-modality override is skipped
  // with a logged reason and falls through, rather than either winning
  // outright or being silently dropped without a trace.
  if (modelSource === 'needs_owner_input') {
    const roleModel = queryOne<AgentSettingRow>(
      `SELECT value FROM agent_settings
       WHERE department_id = ? AND role_id = ? AND setting_type = 'model'`,
      [departmentId, agentId],
    );
    if (roleModel?.value) {
      const violation = checkModelSovereignty(roleModel.value, getInventory(), detectedModality);
      if (!violation) {
        model = roleModel.value;
        modelSource = 'role_override';
      } else {
        console.warn(
          `[intelligence-resolver] role override rejected (agent=${agentId} dept=${departmentId} reason=${violation.reason}): ${roleModel.value}`,
        );
      }
    }
  }

  // Layer 3: Department-level default in agent_settings (role_id IS NULL).
  // Same sovereignty gate as Layer 2.
  if (modelSource === 'needs_owner_input') {
    const deptModel = queryOne<AgentSettingRow>(
      `SELECT value FROM agent_settings
       WHERE department_id = ? AND role_id IS NULL AND setting_type = 'model'`,
      [departmentId],
    );
    if (deptModel?.value) {
      const violation = checkModelSovereignty(deptModel.value, getInventory(), detectedModality);
      if (!violation) {
        model = deptModel.value;
        modelSource = 'department_default';
      } else {
        console.warn(
          `[intelligence-resolver] department default rejected (dept=${departmentId} reason=${violation.reason}): ${deptModel.value}`,
        );
      }
    }
  }

  // Layer 4: Task-time selector — only runs when no explicit override above
  // (Layers 0-3) already won. Previously this ran BEFORE Layers 2/3 (see
  // ORDER-FIX note above); moved here so it is strictly the fallback it was
  // always documented to be.
  if (modelSource === 'needs_owner_input' && taskContext) {
    const inventory = getInventory();
    if (inventory.length > 0) {
      const sel = selectTaskModel({
        title: taskContext.title,
        description: taskContext.description,
        department: taskContext.department,
        required_modality: detectedModality,
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
  }

  // Layer 4b: Sovereign DEFAULT (W8.5). Applied ONLY when every express source
  // above declined (modelSource still needs_owner_input) so dispatch's model_id
  // is never NULL — the 172/183-null-model_id board-stall root cause. Sovereignty
  // is preserved: this is a default, never a substitution of an owner/CEO/SOP/
  // role/dept express model (those already won at Layers 0-3). Modality is
  // respected — a generic text default is only applied to text tasks; an
  // image/video/audio task with no matching model stays needs_owner_input so
  // the owner adds the right modality model rather than running on a
  // wrong-modality default.
  if (modelSource === 'needs_owner_input') {
    const inv = getInventory();
    const mod: TaskModality = required_modality ?? detectedModality;
    const sovereignDefault = resolveSovereignDefault(inv, mod);
    if (sovereignDefault) {
      model = sovereignDefault;
      modelSource = 'sovereign_default';
      if (!required_modality) required_modality = mod;
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
  //
  // RESOLVER-CATEGORY FIX (Gap E): persona_assignment has a UNIQUE
  // (department_id, task_category) key and the selector upserts/reads it by that
  // pair (persona-selector-v2.py check_sticky_assignment). The previous lookup
  // keyed on department_id ALONE and grabbed the most-recently-assigned row of
  // ANY category — so an unpinned task inherited the WRONG category's persona.
  // We now derive THIS task's category and require an EXACT (department_id,
  // task_category) match, mirroring the selector's key.
  //
  // task_category is derived in priority order:
  //   1. The category the selector actually recorded for this task, embedded as
  //      "task_category" inside persona_selection_log.layer_scores (authoritative).
  //   2. inferTaskCategory(title + description) — a verbatim port of the
  //      selector's infer_task_category(), so an unscored task still resolves to
  //      the SAME category the selector would compute.
  // If no category is derivable AND no exact sticky row exists, we fall through
  // to the agent_settings cascade rather than guessing a wrong persona.
  let stickyCategory: string | null = null;
  let stickyAssignment: PersonaAssignmentRow | null = null;
  if (taskId) {
    // (1) Authoritative: the category the selector recorded for this task.
    try {
      const logRow = queryOne<{ layer_scores: string | null }>(
        `SELECT layer_scores FROM persona_selection_log
         WHERE task_id = ? ORDER BY selected_at DESC LIMIT 1`,
        [taskId]
      );
      if (logRow?.layer_scores) {
        const parsed = JSON.parse(logRow.layer_scores) as Record<string, unknown>;
        const cat = parsed?.task_category;
        if (typeof cat === 'string' && cat) stickyCategory = cat;
      }
    } catch {
      // No log table / unparseable layer_scores — fall through to inference.
    }

    // (2) Derive the category from task text the same way the selector does.
    if (!stickyCategory) {
      const catText = `${taskContext?.title ?? ''} ${taskContext?.description ?? ''}`.trim();
      if (catText) stickyCategory = inferTaskCategory(catText);
    }

    // EXACT (department_id, task_category) match — the selector's UNIQUE key.
    if (stickyCategory) {
      try {
        stickyAssignment = queryOne<PersonaAssignmentRow>(
          `SELECT persona_id, persona_name, persona_mode, task_category
           FROM persona_assignment
           WHERE department_id = ? AND task_category = ?
           ORDER BY last_assigned_at DESC LIMIT 1`,
          [departmentId, stickyCategory]
        ) ?? null;
      } catch {
        stickyAssignment = null;
      }
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
