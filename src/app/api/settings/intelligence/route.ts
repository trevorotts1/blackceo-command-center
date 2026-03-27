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
  // Sales & Revenue
  { id: 'hormozi-100m-offers', label: 'Alex Hormozi' },
  { id: 'voss-never-split-difference', label: 'Chris Voss' },
  { id: 'rackham-spin-selling', label: 'Neil Rackham' },
  { id: 'pink-to-sell-is-human', label: 'Daniel Pink' },
  { id: 'jones-exactly-what-to-say', label: 'Phil Jones' },
  { id: 'kane-hook-point', label: 'Brendan Kane' },
  { id: 'priestley-oversubscribed', label: 'Daniel Priestley' },
  // Marketing & Content
  { id: 'miller-building-storybrand-2', label: 'Donald Miller' },
  { id: 'godin-this-is-marketing', label: 'Seth Godin' },
  { id: 'bly-copywriters-handbook', label: 'Robert Bly' },
  { id: 'wiebe-copy-hackers', label: 'Joanna Wiebe' },
  { id: 'cialdini-influence', label: 'Robert Cialdini' },
  { id: 'charvet-words-change-minds', label: 'Shelle Rose Charvet' },
  // Leadership & Strategy
  { id: 'sinek-start-with-why', label: 'Simon Sinek' },
  { id: 'sinek-find-your-why', label: 'Simon Sinek' },
  { id: 'collins-good-to-great', label: 'Jim Collins' },
  { id: 'samit-disrupt-yourself', label: 'Jay Samit' },
  { id: 'lakhiani-extraordinary-mind', label: 'Vishen Lakhiani' },
  { id: 'grover-relentless', label: 'Tim Grover' },
  // Productivity & Systems
  { id: 'clear-atomic-habits', label: 'James Clear' },
  { id: 'forte-building-second-brain', label: 'Tiago Forte' },
  { id: 'forte-para-method', label: 'Tiago Forte' },
  { id: 'moran-12-week-year', label: 'Brian Moran' },
  { id: 'duhigg-power-of-habit', label: 'Charles Duhigg' },
  { id: 'pink-when', label: 'Daniel Pink' },
  // Finance & Business Health
  { id: 'michalowicz-profit-first', label: 'Mike Michalowicz' },
  // Coaching & Human Development
  { id: 'robbins-five-second-rule', label: 'Mel Robbins' },
  { id: 'robbins-let-them-theory', label: 'Mel Robbins' },
  { id: 'sharma-5am-club', label: 'Robin Sharma' },
  { id: 'goggins-cant-hurt-me', label: 'David Goggins' },
  { id: 'jakes-instinct', label: 'TD Jakes' },
  { id: 'pink-drive', label: 'Daniel Pink' },
  { id: 'attwood-passion-test', label: 'Janet Attwood' },
  { id: 'grenny-crucial-conversations', label: 'Grenny Patterson' },
  // Emotional Intelligence & Relationships
  { id: 'tawwab-set-boundaries-find-peace', label: 'Nedra Tawwab' },
  { id: 'brown-atlas-of-heart', label: 'Brené Brown' },
  { id: 'obama-becoming', label: 'Michelle Obama' },
  { id: 'obama-light-we-carry', label: 'Michelle Obama' },
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
  specialist_type: string | null;
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
      'SELECT id, name, role, workspace_id, avatar_emoji, is_master, specialist_type FROM agents ORDER BY name'
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

        // Determine agent type for UI labeling using real DB column
        const agentType: 'persistent' | 'specialist' = agent.is_master ? 'persistent' : 'specialist';
        const specialistType: 'permanent' | 'on-call' | null = agent.specialist_type as 'permanent' | 'on-call' | null ?? (agent.is_master ? null : 'on-call');

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
      const matrixPaths = [
        join(homedir(), 'clawd', 'persona-matrix.md'),
        join(homedir(), 'clawd', 'persona-matrix', 'persona-matrix.md'),
        join(homedir(), '.openclaw', 'persona-matrix.md'),
      ];
      for (const matrixPath of matrixPaths) {
        if (existsSync(matrixPath)) {
          const raw = readFileSync(matrixPath, 'utf-8');
          // Parse persona slugs from various markdown formats:
          // 1. Backtick slugs: `hormozi-100m-offers`
          const backtickPattern = /`([a-z][a-z0-9]+(?:-[a-z0-9]+)+)`/g;
          let match;
          while ((match = backtickPattern.exec(raw)) !== null) {
            const slug = match[1];
            if (slug && slug !== 'auto' && !enrichedPersonas.find(p => p.id === slug)) {
              enrichedPersonas.push({ id: slug, label: slug.replace(/-/g, ' ') });
            }
          }
          // 2. List items with bold names: - **Name** → `slug`
          // 3. Headers: ## slug-name
          const headerPattern = /(?:^|\n)#{1,4}\s+([a-z][a-z0-9]+(?:-[a-z0-9]+)+)/g;
          while ((match = headerPattern.exec(raw)) !== null) {
            const slug = match[1];
            if (slug && slug !== 'auto' && !enrichedPersonas.find(p => p.id === slug)) {
              enrichedPersonas.push({ id: slug, label: slug.replace(/-/g, ' ') });
            }
          }
          // 4. Dash-prefixed slugs: - slug-name
          const dashPattern = /(?:^|\n)\s*-\s+([a-z][a-z0-9]+(?:-[a-z0-9]+)+)(?:\s|$)/g;
          while ((match = dashPattern.exec(raw)) !== null) {
            const slug = match[1];
            if (slug && slug !== 'auto' && !enrichedPersonas.find(p => p.id === slug)) {
              enrichedPersonas.push({ id: slug, label: slug.replace(/-/g, ' ') });
            }
          }
          if (enrichedPersonas.length > AVAILABLE_PERSONAS.length) break; // Found extras, stop
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
