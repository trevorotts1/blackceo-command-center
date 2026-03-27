import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '@/lib/db';

const DEFAULT_MODEL = 'openrouter/free';
const DEFAULT_PERSONA = 'auto';

const AVAILABLE_MODELS = [
  { id: 'openrouter/free', label: 'Free Models Router' },
  { id: 'moonshot/kimi-k2.5', label: 'Kimi K2.5' },
  { id: 'openrouter/xiaomi/mimo-v2-pro', label: 'MiMo V2 Pro' },
  { id: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet' },
  { id: 'openai-codex/gpt-5.4', label: 'GPT 5.4' },
  { id: 'google/gemini-3-flash-preview', label: 'Gemini 3 Flash' },
];

const AVAILABLE_PERSONAS = [
  { id: 'auto', label: 'Auto-assign (recommended)' },
  { id: 'clear-atomic-habits', label: 'James Clear' },
  { id: 'godin-this-is-marketing', label: 'Seth Godin' },
  { id: 'hormozi-100m-offers', label: 'Alex Hormozi' },
  { id: 'miller-building-storybrand-2', label: 'Donald Miller' },
  { id: 'voss-never-split-difference', label: 'Chris Voss' },
];

interface AgentSetting {
  id: string;
  department_id: string;
  role_id: string | null;
  setting_type: string;
  value: string;
  created_at: string;
  updated_at: string;
}

interface Workspace {
  id: string;
  name: string;
  slug: string;
  icon: string;
  description: string;
}

interface Agent {
  id: string;
  name: string;
  role: string;
  workspace_id: string;
  avatar_emoji: string;
  is_master: number;
}

/**
 * GET /api/settings/intelligence
 *
 * Returns current model/persona assignments per department and role,
 * plus available models and personas, and the full department/role list.
 */
export async function GET() {
  try {
    const db = getDb();

    // Fetch all workspaces (departments)
    const workspaces = db.prepare(
      'SELECT id, name, slug, icon, description FROM workspaces ORDER BY name'
    ).all() as Workspace[];

    // Filter out demo/utility workspaces
    const departments = workspaces.filter(w =>
      !w.slug.startsWith('acme-') &&
      !w.slug.startsWith('zhw-') &&
      w.slug !== 'default'
    );

    // Fetch all agents grouped by workspace
    const agents = db.prepare(
      'SELECT id, name, role, workspace_id, avatar_emoji, is_master FROM agents ORDER BY name'
    ).all() as Agent[];

    // Fetch all existing settings
    const settings = db.prepare(
      'SELECT * FROM agent_settings'
    ).all() as AgentSetting[];

    // Build lookup maps
    const modelSettings = new Map<string, string>(); // key: deptId or deptId:roleId
    const personaSettings = new Map<string, string>();

    for (const s of settings) {
      const key = s.role_id ? `${s.department_id}:${s.role_id}` : s.department_id;
      if (s.setting_type === 'model') modelSettings.set(key, s.value);
      if (s.setting_type === 'persona') personaSettings.set(key, s.value);
    }

    // Build department structure with inherited values
    const departmentsWithRoles = departments.map(dept => {
      const deptModel = modelSettings.get(dept.id) || DEFAULT_MODEL;
      const deptPersona = personaSettings.get(dept.id) || DEFAULT_PERSONA;
      const deptAgents = agents.filter(a => a.workspace_id === dept.id);

      const roles = deptAgents.map(agent => {
        const roleKey = `${dept.id}:${agent.id}`;
        const roleModel = modelSettings.get(roleKey);
        const rolePersona = personaSettings.get(roleKey);

        // Determine agent type for UI labeling
        const agentType: 'persistent' | 'specialist' = agent.is_master ? 'persistent' : 'specialist';
        // specialist_type is not yet in DB schema; default non-master agents to 'on-call'
        const specialistType: 'permanent' | 'on-call' | null = agent.is_master ? null : 'on-call';

        return {
          id: agent.id,
          name: agent.role,
          agentName: agent.name,
          emoji: agent.avatar_emoji,
          model: roleModel || deptModel,
          modelInherited: !roleModel,
          persona: rolePersona || deptPersona,
          personaInherited: !rolePersona,
          agentType,
          specialistType,
        };
      });

      return {
        id: dept.id,
        name: dept.name,
        slug: dept.slug,
        icon: dept.icon,
        model: deptModel,
        persona: deptPersona,
        roles,
      };
    });

    // Try to enrich available models from OpenClaw config
    const enrichedModels = [...AVAILABLE_MODELS];
    try {
      const { existsSync, readFileSync, statSync } = await import('fs');
      const { homedir } = await import('os');
      const { join } = await import('path');
      const configPath = join(homedir(), '.openclaw', 'openclaw.json');
      if (existsSync(configPath)) {
        const stats = statSync(configPath);
        if (stats.size < 1024 * 1024) {
          const config = JSON.parse(readFileSync(configPath, 'utf-8'));
          const providerModels = config?.models?.providers;
          if (providerModels) {
            for (const [prov, p] of Object.entries(providerModels)) {
              const models = (p as { models?: Array<{ id: string; name: string }> }).models;
              if (models) {
                for (const m of models) {
                  const fullId = `${prov}/${m.id}`;
                  if (!enrichedModels.find(x => x.id === fullId)) {
                    enrichedModels.push({ id: fullId, label: m.name || m.id });
                  }
                }
              }
            }
          }
        }
      }
    } catch {
      // Use static list
    }

    // Try to enrich personas from persona-matrix.md
    const enrichedPersonas = [...AVAILABLE_PERSONAS];
    try {
      const { existsSync, readFileSync } = await import('fs');
      const { homedir } = await import('os');
      const { join } = await import('path');
      const matrixPath = join(homedir(), 'clawd', 'persona-matrix.md');
      if (existsSync(matrixPath)) {
        const raw = readFileSync(matrixPath, 'utf-8');
        // Parse persona slugs from markdown headers or list items
        const slugPattern = /(?:^|\n)(?:[-*]\s+|\#+\s+)([\w-]+)\s*[\(:\-]/g;
        let match;
        while ((match = slugPattern.exec(raw)) !== null) {
          const slug = match[1];
          if (slug && slug !== 'auto' && !enrichedPersonas.find(p => p.id === slug)) {
            enrichedPersonas.push({ id: slug, label: slug.replace(/-/g, ' ') });
          }
        }
      }
    } catch {
      // Use static list
    }

    return NextResponse.json({
      departments: departmentsWithRoles,
      models: enrichedModels,
      personas: enrichedPersonas,
      defaults: { model: DEFAULT_MODEL, persona: DEFAULT_PERSONA },
    });
  } catch (error) {
    console.error('Failed to fetch intelligence settings:', error);
    return NextResponse.json(
      { error: 'Failed to fetch intelligence settings' },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/settings/intelligence
 *
 * Saves model/persona assignments.
 * Body: { assignments: Array<{ department_id, role_id?, setting_type, value }> }
 */
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { assignments } = body as {
      assignments: Array<{
        department_id: string;
        role_id?: string | null;
        setting_type: 'model' | 'persona';
        value: string;
      }>;
    };

    if (!Array.isArray(assignments)) {
      return NextResponse.json(
        { error: 'assignments must be an array' },
        { status: 400 }
      );
    }

    const db = getDb();

    const upsert = db.transaction(() => {
      for (const a of assignments) {
        if (!a.department_id || !a.setting_type || !a.value) {
          continue;
        }
        if (a.setting_type !== 'model' && a.setting_type !== 'persona') {
          continue;
        }

        const roleId = a.role_id || null;

        // Check if setting already exists
        const existing = db.prepare(
          'SELECT id FROM agent_settings WHERE department_id = ? AND role_id IS ? AND setting_type = ?'
        ).get(a.department_id, roleId, a.setting_type) as { id: string } | undefined;

        if (existing) {
          // Update
          db.prepare(
            'UPDATE agent_settings SET value = ?, updated_at = datetime(\'now\') WHERE id = ?'
          ).run(a.value, existing.id);
        } else {
          // Insert
          db.prepare(
            'INSERT INTO agent_settings (id, department_id, role_id, setting_type, value) VALUES (?, ?, ?, ?, ?)'
          ).run(uuidv4(), a.department_id, roleId, a.setting_type, a.value);
        }
      }
    });

    upsert();

    return NextResponse.json({ success: true, saved: assignments.length });
  } catch (error) {
    console.error('Failed to save intelligence settings:', error);
    return NextResponse.json(
      { error: 'Failed to save intelligence settings' },
      { status: 500 }
    );
  }
}
