/**
 * Intelligence Settings Resolver
 * 
 * Resolves which model and persona should be used for a given agent + department.
 * Resolution order:
 *   1. Role-level override in agent_settings (role_id = agent.id)
 *   2. Department-level default in agent_settings (role_id IS NULL)
 *   3. Hardcoded defaults (DEFAULT_MODEL / DEFAULT_PERSONA)
 * 
 * Both model and persona resolution follow this same cascade.
 * When persona is 'auto', no explicit persona is set — the orchestrator
 * makes the choice at runtime based on task context.
 */

import { queryOne, run } from '@/lib/db';

export const DEFAULT_MODEL = 'openrouter/free';
export const DEFAULT_PERSONA = 'auto';

export interface ResolvedSettings {
  model: string;
  modelSource: 'role_override' | 'department_default' | 'hardcoded_default';
  persona: string;
  personaSource: 'role_override' | 'department_default' | 'hardcoded_default';
}

interface AgentSettingRow {
  value: string;
}

/**
 * Resolve the effective model and persona for an agent in a department.
 * 
 * @param agentId - The agent's ID (used as role_id in agent_settings)
 * @param departmentId - The workspace/department ID
 * @returns ResolvedSettings with the effective model, persona, and their sources
 */
export function resolveSettings(
  agentId: string,
  departmentId: string
): ResolvedSettings {
  // --- MODEL RESOLUTION ---
  // 1. Check role-level override
  const roleModel = queryOne<AgentSettingRow>(
    `SELECT value FROM agent_settings 
     WHERE department_id = ? AND role_id = ? AND setting_type = 'model'`,
    [departmentId, agentId]
  );

  // 2. Check department-level default
  const deptModel = queryOne<AgentSettingRow>(
    `SELECT value FROM agent_settings 
     WHERE department_id = ? AND role_id IS NULL AND setting_type = 'model'`,
    [departmentId]
  );

  const model = roleModel?.value || deptModel?.value || DEFAULT_MODEL;
  const modelSource = roleModel
    ? 'role_override'
    : deptModel
      ? 'department_default'
      : 'hardcoded_default';

  // --- PERSONA RESOLUTION ---
  // 1. Check role-level override
  const rolePersona = queryOne<AgentSettingRow>(
    `SELECT value FROM agent_settings 
     WHERE department_id = ? AND role_id = ? AND setting_type = 'persona'`,
    [departmentId, agentId]
  );

  // 2. Check department-level default
  const deptPersona = queryOne<AgentSettingRow>(
    `SELECT value FROM agent_settings 
     WHERE department_id = ? AND role_id IS NULL AND setting_type = 'persona'`,
    [departmentId]
  );

  const persona = rolePersona?.value || deptPersona?.value || DEFAULT_PERSONA;
  const personaSource = rolePersona
    ? 'role_override'
    : deptPersona
      ? 'department_default'
      : 'hardcoded_default';

  return { model, modelSource, persona, personaSource };
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

  const message =
    `Dispatch resolution: model=${settings.model} (${settings.modelSource}), ` +
    `persona=${personaDesc} (${settings.personaSource})`;

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
        persona: settings.persona,
        personaSource: settings.personaSource,
      }),
    ]
  );
}

/**
 * Full resolution + logging in one call.
 * Use this at dispatch time: resolve, log, return settings.
 */
export function resolveAndLog(
  taskId: string,
  agentId: string,
  departmentId: string
): ResolvedSettings {
  const settings = resolveSettings(agentId, departmentId);
  logDispatchResolution(taskId, agentId, settings);
  return settings;
}
