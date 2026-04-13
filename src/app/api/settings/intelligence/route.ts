import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '@/lib/db';
import { readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';

const DEFAULT_MODEL = 'openrouter/free';
const DEFAULT_PERSONA = 'auto';

/* ── Persona details: loaded at runtime from persona-categories.json ── */
interface PersonaCategoryEntry {
  author: string;
  book: string;
  domain: string[];
  perspective: string[];
  custom: string[];
}

function loadPersonaCategories(): Record<string, PersonaCategoryEntry> {
  const homedir = process.env.HOME || process.env.USERPROFILE || '/root';
  const workspaceBase = process.env.WORKSPACE_BASE_PATH
    ? resolve(process.env.WORKSPACE_BASE_PATH.replace(/^~/, homedir))
    : join(homedir, 'clawd');

  const candidatePaths = [
    join(workspaceBase, 'coaching-personas', 'persona-categories.json'),
    join(homedir, 'Downloads', 'openclaw-master-files', 'coaching-personas', 'persona-categories.json'),
    join(homedir, '.openclaw', 'skills', '22-book-to-persona-coaching-leadership-system', 'persona-categories.json'),
  ];

  for (const p of candidatePaths) {
    if (existsSync(p)) {
      try {
        const raw = JSON.parse(readFileSync(p, 'utf-8'));
        return raw.personas || {};
      } catch {
        console.error(`[Intelligence] Failed to parse ${p}`);
      }
    }
  }
  console.warn('[Intelligence] No persona-categories.json found, using empty list');
  return {};
}

const DOMAIN_TO_CATEGORY: Record<string, string> = {
  'marketing': 'Marketing & Content',
  'sales': 'Sales & Revenue',
  'leadership': 'Leadership & Strategy',
  'finance': 'Finance & Business Health',
  'operations': 'Productivity & Systems',
  'communication': 'Communication',
  'copywriting': 'Marketing & Content',
  'mindset': 'Coaching & Development',
  'productivity-systems': 'Productivity & Systems',
  'coaching': 'Coaching & Development',
  'strategy-innovation': 'Leadership & Strategy',
  'personal-development': 'Coaching & Development',
};

function getPersonaCategory(entry: PersonaCategoryEntry): string {
  for (const d of entry.domain || []) {
    if (DOMAIN_TO_CATEGORY[d]) return DOMAIN_TO_CATEGORY[d];
  }
  return 'General';
}

function formatPersonaLabel(id: string): string {
  if (id === 'auto') return 'Auto-assign (recommended)';
  const personas = loadPersonaCategories();
  const entry = personas[id];
  if (!entry) return id.replace(/-/g, ' ');
  return `${entry.author} - ${entry.book} (${getPersonaCategory(entry)})`;
}

const AVAILABLE_MODELS = [
  { id: 'openrouter/free', label: 'Free Models Router' },
  { id: 'moonshot/kimi-k2.5', label: 'Kimi K2.5' },
  { id: 'openrouter/xiaomi/mimo-v2-pro', label: 'MiMo V2 Pro' },
  { id: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet' },
  { id: 'openai-codex/gpt-5.4', label: 'GPT 5.4' },
  { id: 'google/gemini-3-flash-preview', label: 'Gemini 3 Flash' },
];

const AVAILABLE_PERSONAS = [
  { id: 'auto', label: formatPersonaLabel('auto') },
  // Sales & Revenue
  { id: 'hormozi-100m-offers', label: formatPersonaLabel('hormozi-100m-offers') },
  { id: 'voss-never-split-difference', label: formatPersonaLabel('voss-never-split-difference') },
  { id: 'rackham-spin-selling', label: formatPersonaLabel('rackham-spin-selling') },
  { id: 'pink-to-sell-is-human', label: formatPersonaLabel('pink-to-sell-is-human') },
  { id: 'jones-exactly-what-to-say', label: formatPersonaLabel('jones-exactly-what-to-say') },
  { id: 'kane-hook-point', label: formatPersonaLabel('kane-hook-point') },
  { id: 'priestley-oversubscribed', label: formatPersonaLabel('priestley-oversubscribed') },
  // Marketing & Content
  { id: 'miller-building-storybrand-2', label: formatPersonaLabel('miller-building-storybrand-2') },
  { id: 'godin-this-is-marketing', label: formatPersonaLabel('godin-this-is-marketing') },
  { id: 'bly-copywriters-handbook', label: formatPersonaLabel('bly-copywriters-handbook') },
  { id: 'wiebe-copy-hackers', label: formatPersonaLabel('wiebe-copy-hackers') },
  { id: 'cialdini-influence', label: formatPersonaLabel('cialdini-influence') },
  { id: 'charvet-words-change-minds', label: formatPersonaLabel('charvet-words-change-minds') },
  // Leadership & Strategy
  { id: 'sinek-start-with-why', label: formatPersonaLabel('sinek-start-with-why') },
  { id: 'sinek-find-your-why', label: formatPersonaLabel('sinek-find-your-why') },
  { id: 'collins-good-to-great', label: formatPersonaLabel('collins-good-to-great') },
  { id: 'samit-disrupt-yourself', label: formatPersonaLabel('samit-disrupt-yourself') },
  { id: 'lakhiani-extraordinary-mind', label: formatPersonaLabel('lakhiani-extraordinary-mind') },
  { id: 'grover-relentless', label: formatPersonaLabel('grover-relentless') },
  // Productivity & Systems
  { id: 'clear-atomic-habits', label: formatPersonaLabel('clear-atomic-habits') },
  { id: 'forte-building-second-brain', label: formatPersonaLabel('forte-building-second-brain') },
  { id: 'forte-para-method', label: formatPersonaLabel('forte-para-method') },
  { id: 'moran-12-week-year', label: formatPersonaLabel('moran-12-week-year') },
  { id: 'duhigg-power-of-habit', label: formatPersonaLabel('duhigg-power-of-habit') },
  { id: 'pink-when', label: formatPersonaLabel('pink-when') },
  // Finance & Business Health
  { id: 'michalowicz-profit-first', label: formatPersonaLabel('michalowicz-profit-first') },
  // Coaching & Human Development
  { id: 'robbins-five-second-rule', label: formatPersonaLabel('robbins-five-second-rule') },
  { id: 'robbins-let-them-theory', label: formatPersonaLabel('robbins-let-them-theory') },
  { id: 'sharma-5am-club', label: formatPersonaLabel('sharma-5am-club') },
  { id: 'goggins-cant-hurt-me', label: formatPersonaLabel('goggins-cant-hurt-me') },
  { id: 'jakes-instinct', label: formatPersonaLabel('jakes-instinct') },
  { id: 'pink-drive', label: formatPersonaLabel('pink-drive') },
  { id: 'attwood-passion-test', label: formatPersonaLabel('attwood-passion-test') },
  { id: 'grenny-crucial-conversations', label: formatPersonaLabel('grenny-crucial-conversations') },
  // Emotional Intelligence & Relationships
  { id: 'tawwab-set-boundaries-find-peace', label: formatPersonaLabel('tawwab-set-boundaries-find-peace') },
  { id: 'brown-atlas-of-heart', label: formatPersonaLabel('brown-atlas-of-heart') },
  { id: 'obama-becoming', label: formatPersonaLabel('obama-becoming') },
  { id: 'obama-light-we-carry', label: formatPersonaLabel('obama-light-we-carry') },
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
              enrichedPersonas.push({ id: slug, label: formatPersonaLabel(slug) });
            }
          }
          // 2. List items with bold names: - **Name** → `slug`
          // 3. Headers: ## slug-name
          const headerPattern = /(?:^|\n)#{1,4}\s+([a-z][a-z0-9]+(?:-[a-z0-9]+)+)/g;
          while ((match = headerPattern.exec(raw)) !== null) {
            const slug = match[1];
            if (slug && slug !== 'auto' && !enrichedPersonas.find(p => p.id === slug)) {
              enrichedPersonas.push({ id: slug, label: formatPersonaLabel(slug) });
            }
          }
          // 4. Dash-prefixed slugs: - slug-name
          const dashPattern = /(?:^|\n)\s*-\s+([a-z][a-z0-9]+(?:-[a-z0-9]+)+)(?:\s|$)/g;
          while ((match = dashPattern.exec(raw)) !== null) {
            const slug = match[1];
            if (slug && slug !== 'auto' && !enrichedPersonas.find(p => p.id === slug)) {
              enrichedPersonas.push({ id: slug, label: formatPersonaLabel(slug) });
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
