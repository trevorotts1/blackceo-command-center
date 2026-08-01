/**
 * OpenClaw Agent Sync — ingests Skill-23 specialist agents from the OpenClaw
 * gateway into the Command Center's agents table.
 *
 * PROBLEM (MR-14): Only the head orchestrator + trio agents
 * (QC / Research / Devil's Advocate) are auto-seeded by the CC.  The full
 * specialist roster that Skill-23 (AI Workforce Interview) creates on the
 * OpenClaw gateway never makes it into the agents table, so newly onboarded
 * specialists are invisible to routing, the board's agent pill, and task
 * dispatch.
 *
 * FIX: On boot (instrumentation.ts) and on converge (POST /api/system/converge),
 * call the gateway's `sessions.list` RPC to discover active agent sessions,
 * then `agent.describe` each agent to extract its department, role, and name.
 * UPSERT those specialist agents into the CC `agents` table.
 *
 * This is deliberately ASYNC and fire-and-forget on boot — the synchronous
 * runMigrations() does NOT block on a gateway RPC.  The instrumentation hook
 * (which runs AFTER migrations complete) triggers the async ingest once the
 * gateway connection is established.
 *
 * Invariants:
 *   • NEVER touches the master Orchestrator row (is_master=1).
 *   • NEVER touches CC-generated trio/head agent rows (qc-agent-*, research-agent-*, da-agent-*, head-agent-*).
 *   • Gateway-unreachable → logged and skipped (non-fatal).  The converge
 *     endpoint can retry later when the gateway is ready.
 *   • Idempotent — INSERT OR IGNORE on the agent's own stable node id, plus
 *     an UPDATE on re-sync so data stays current.
 */

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '@/lib/db';
import { getOpenClawClient, type OpenClawClient } from './client';

/* ─────────────────────────────── Types ─────────────────────────────────────── */

/** Shape of one session returned by sessions.list (OpenClawSessionInfo + extensions). */
interface GatewaySession {
  id: string;
  channel?: string;
  peer?: string;
  agentId?: string;
  agent_id?: string;
  agentName?: string;
  agent_name?: string;
  status?: string;
  model?: string;
}

/** Shape of one agent returned by the gateway's agent.info / agent.describe RPC. */
interface GatewayAgent {
  id: string;
  name?: string;
  displayName?: string;
  label?: string;
  role?: string;
  roleType?: string;
  type?: string;
  status?: string;
  description?: string;
  model?: string;
  workspaceId?: string;
  department?: string;
}

/* ─────────────────────────────── Helpers ───────────────────────────────────── */

function str(v: unknown, fallback: string): string {
  if (typeof v === 'string' && v.trim()) return v.trim();
  return fallback;
}

/** Map a name/role string to an emoji via keyword match. */
function inferEmoji(name: string): string {
  if (!name) return '🤖';
  const n = name.toLowerCase();
  const map: Record<string, string> = {
    writer: '✍️', writing: '✍️', copywriter: '✍️', copy: '✍️',
    designer: '🎨', design: '🎨', graphics: '🎨', graphic: '🎨',
    developer: '💻', dev: '💻', engineer: '💻', engineering: '💻', coder: '💻',
    researcher: '🔬', research: '🔬', analyst: '📊', analytics: '📊',
    marketer: '📢', marketing: '📢', ads: '📢', advertising: '📢',
    sales: '💰', seller: '💰', closer: '💰',
    support: '🛟', 'customer service': '🛟', 'help desk': '🛟',
    manager: '📋', director: '📋', head: '📋', lead: '📋',
    legal: '⚖️', lawyer: '⚖️', compliance: '⚖️',
    finance: '💵', billing: '💵', accounting: '💵',
    social: '📱', 'social media': '📱',
    video: '🎬', film: '🎬', editor: '🎬',
    audio: '🎧', podcast: '🎧', music: '🎧', sound: '🎧',
    presenter: '📽️', presentation: '📽️', deck: '📽️',
    coach: '🎯', coaching: '🎯',
    course: '📚', curriculum: '📚',
    community: '👥', moderator: '👥',
    assistant: '🤖', pa: '🤖',
    security: '🛡️', threat: '🛡️', auditor: '🛡️',
    qc: '🔍', quality: '🔍',
    strategist: '🧠', strategy: '🧠',
    photographer: '📸', photo: '📸',
    funnel: '🌀', funnels: '🌀',
    app: '📱', mobile: '📱',
  };
  for (const [key, emoji] of Object.entries(map)) {
    if (n.includes(key)) return emoji;
  }
  return '🤖';
}

/** True for CC-generated deterministic agent ids (trio + heads). */
function isCcManagedAgentId(id: string): boolean {
  return /^(qc|research|da)-agent-/.test(id) || /^head-agent-/.test(id);
}

/** Derive a role_type from a node's metadata, never returning a trio role. */
function inferRoleType(node: GatewayAgent): string {
  const rt = str(node.roleType, '') || str(node.role, '') || str(node.type, '') || 'specialist';
  const lowered = rt.toLowerCase();
  // Trio roles are CC-managed — never ingest them as a specialist.
  if (['research', 'deep-research', 'devils-advocate', 'da', 'qc', 'quality-control'].includes(lowered)) {
    return 'specialist';
  }
  if (['leadership', 'head', 'lead'].includes(lowered)) return 'leadership';
  if (lowered === 'healer') return 'healer';
  if (lowered === 'orchestrator') return 'orchestrator';
  return 'specialist';
}

/** Resolve a workspace id from a department slug, falling back to the slug itself. */
function resolveWorkspaceId(db: ReturnType<typeof getDb>, slug: string): string {
  if (!slug) return 'default';
  const row = db
    .prepare('SELECT id FROM workspaces WHERE lower(slug) = ? OR lower(id) = ? LIMIT 1')
    .get(slug.toLowerCase(), slug.toLowerCase()) as { id: string } | undefined;
  if (row) return row.id;
  // Try stripping a 'dept-' prefix (some workspaces have slug='dept-marketing',
  // but the agent's department is just 'marketing').
  if (slug.startsWith('dept-')) {
    const bare = slug.slice(5);
    const row2 = db
      .prepare('SELECT id FROM workspaces WHERE lower(slug) = ? LIMIT 1')
      .get(bare.toLowerCase()) as { id: string } | undefined;
    if (row2) return row2.id;
  }
  // Fallback: use the slug as the workspace id directly (the workspace may have
  // been created with the slug as its literal id).
  return slug;
}

/* ────────────────────────────── Core sync ──────────────────────────────────── */

export interface SyncResult {
  inserted: number;
  updated: number;
  skipped: number;
  /** Summary message suitable for logging. */
  message: string;
}

/**
 * Sync specialist agents from the OpenClaw gateway into the CC agents table.
 *
 * Strategy:
 *   1. Call sessions.list to discover active agent sessions on the gateway.
 *   2. For each unique agent id found, call agent.describe (or node.describe)
 *      to get the agent's name, role, department, and model.
 *   3. Resolve the department → workspace id from the CC `workspaces` table.
 *   4. UPSERT the agent row (INSERT OR IGNORE on id, UPDATE on re-sync).
 *
 * Non-fatal: a missing gateway or partial data → logged and the remaining
 * agents are processed.  This is a best-effort sync, not a transaction.
 */
export async function syncSpecialistAgentsFromOpenClaw(): Promise<SyncResult> {
  const result: SyncResult = { inserted: 0, updated: 0, skipped: 0, message: '' };

  // ── 1. Connect to the gateway ─────────────────────────────────────────────
  const client = getOpenClawClient();
  if (!client.isConnected()) {
    try {
      await client.connect();
    } catch (err) {
      result.message = `Gateway unreachable — skipping specialists ingest (non-fatal): ${(err as Error).message}`;
      return result;
    }
  }

  // ── 2. Discover agent sessions ────────────────────────────────────────────
  let sessions: GatewaySession[];
  try {
    sessions = (await client.listSessions()) as GatewaySession[];
  } catch (err) {
    result.message = `sessions.list RPC failed — skipping specialists ingest (non-fatal): ${(err as Error).message}`;
    return result;
  }

  if (!Array.isArray(sessions) || sessions.length === 0) {
    result.message = 'No sessions returned by the gateway — nothing to ingest.';
    return result;
  }

  // ── 3. Extract unique agent ids from sessions ─────────────────────────────
  const agentIds = new Set<string>();
  for (const s of sessions) {
    const aid = str(s.agentId, '') || str(s.agent_id, '');
    if (aid) agentIds.add(aid);
  }

  if (agentIds.size === 0) {
    result.message =
      `Scanned ${sessions.length} session(s), found zero agent ids — nothing to ingest.`;
    return result;
  }

  console.log(
    `[Agent-Sync] Discovered ${agentIds.size} unique agent id(s) across ${sessions.length} session(s).`,
  );

  // ── 4. Describe each agent via the gateway ────────────────────────────────
  const db = getDb();

  // Workspace slug → id lookup
  const wsRows = db.prepare('SELECT id, slug FROM workspaces').all() as { id: string; slug: string }[];
  const workspaceBySlug = new Map<string, string>();
  for (const ws of wsRows) {
    workspaceBySlug.set(ws.slug.toLowerCase(), ws.id);
  }

  const now = new Date().toISOString();

  const upsertAgent = db.prepare(`
    INSERT INTO agents
      (id, name, role, description, avatar_emoji, status, is_master,
       workspace_id, model, specialist_type, role_type, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 'permanent', ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name            = excluded.name,
      role            = excluded.role,
      description     = COALESCE(excluded.description, agents.description),
      avatar_emoji    = COALESCE(excluded.avatar_emoji, agents.avatar_emoji),
      status          = COALESCE(excluded.status, agents.status),
      model           = COALESCE(excluded.model, agents.model),
      role_type       = COALESCE(excluded.role_type, agents.role_type),
      updated_at      = excluded.updated_at
  `);

  for (const agentId of Array.from(agentIds)) {
    try {
      // Skip CC-managed agents (trio/head patterns).
      if (isCcManagedAgentId(agentId)) {
        result.skipped++;
        continue;
      }

      // Skip the master orchestrator.
      const existing = db
        .prepare('SELECT is_master FROM agents WHERE id = ?')
        .get(agentId) as { is_master: number } | undefined;
      if (existing?.is_master === 1) {
        result.skipped++;
        continue;
      }

      // Describe the agent. node.describe and agent.describe may both work;
      // we try node.describe first (see client.ts).
      let agent: GatewayAgent | null = null;
      try {
        const raw = await client.describeNode(agentId);
        if (raw && typeof raw === 'object') {
          const obj = raw as Record<string, unknown>;
          agent = {
            id: agentId,
            name: str(obj.name, '') || str(obj.displayName, '') || str(obj.label, '') || undefined,
            displayName: str(obj.displayName, ''),
            label: str(obj.label, ''),
            role: str(obj.role, ''),
            roleType: str(obj.roleType, '') || str(obj.role, ''),
            type: str(obj.type, ''),
            status: str(obj.status, ''),
            description: str(obj.description, ''),
            model: str(obj.model, ''),
            workspaceId: str(obj.workspaceId, '') || str(obj.workspace_id, ''),
            department: str(obj.department, ''),
          };
          // If the describe payload embeds the department inside metadata.
          const meta = obj.metadata;
          if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
            const m = meta as Record<string, unknown>;
            if (!agent.department) agent.department = str(m.department, '');
            if (!agent.workspaceId) agent.workspaceId = str(m.workspaceId, '') || str(m.workspace_id, '');
            if (!agent.name) agent.name = str(m.name, '') || str(m.agentName, '');
            if (!agent.role) agent.role = str(m.role, '');
          }
        }
      } catch {
        // node.describe failed — the agent may not be a node.
        // Still try to create a minimal entry from the session data.
      }

      if (!agent || !agent.name) {
        // Use the agent id itself as a fallback name (strip hex noise).
        const fallback = agentId.length > 8 ? `Agent ${agentId.slice(0, 8)}` : `Agent ${agentId}`;
        if (!agent) {
          agent = { id: agentId, name: fallback };
        } else {
          agent.name = agent.name || fallback;
        }
      }

      // At this point agent and agent.name are guaranteed non-null.
      const agentName: string = agent.name!;
      const agentDept = agent.department;

      // Resolve department → workspace id.
      const dept: string | null = agentDept || inferDeptFromAgentName(agentName);
      const workspaceId = dept ? resolveWorkspaceId(db, dept) : 'default';

      const name = agentName;
      const role = agent.role || name;
      const deptForDesc = dept || 'general';
      const description = agent.description || `${role} for the ${deptForDesc} department (synced from OpenClaw gateway).`;
      const emoji = inferEmoji(`${name} ${role}`);
      const ccStatus = mapGatewayStatus(agent.status);
      const model = agent.model || null;
      const roleType = inferRoleType(agent);

      const existedBefore = !!db
        .prepare('SELECT 1 FROM agents WHERE id = ?')
        .get(agentId);

      upsertAgent.run(
        agentId, name, role, description || null, emoji, ccStatus,
        workspaceId, model || null, roleType, now, now,
      );

      if (existedBefore) result.updated++;
      else result.inserted++;
    } catch (err) {
      console.log(
        `[Agent-Sync] error processing agent "${agentId}": ${(err as Error).message}`,
      );
      result.skipped++;
    }
  }

  result.message =
    `Ingested ${result.inserted} new + updated ${result.updated} Skill-23 specialist agent(s) ` +
    `from OpenClaw gateway (${result.skipped} agent(s) skipped).`;

  return result;
}

/* ────────────────────────────── Helpers ────────────────────────────────────── */

function mapGatewayStatus(status: string | undefined): string {
  const s = (status ?? '').toLowerCase();
  if (s === 'online' || s === 'active' || s === 'standby' || s === 'idle') return 'standby';
  if (s === 'busy' || s === 'working') return 'working';
  if (s === 'offline' || s === 'disconnected') return 'offline';
  return 'standby';
}

/** Guess a department slug from an agent name like "Marketing Specialist" → "marketing". */
function inferDeptFromAgentName(name: string): string | null {
  if (!name) return null;
  // Pattern: "<Department> <Role>" → extract department.
  const deptKeywords = [
    'marketing', 'sales', 'billing', 'finance', 'support', 'crm',
    'legal', 'research', 'web', 'graphics', 'video', 'audio',
    'social', 'podcast', 'presentations', 'funnels', 'communications',
    'security', 'community', 'coach', 'course', 'app', 'quality',
    'general', 'personal', 'paid', 'openclaw',
  ];
  const lowered = name.toLowerCase();
  for (const kw of deptKeywords) {
    if (lowered.includes(kw)) {
      // Map to canonical slug.
      if (kw === 'billing' || kw === 'finance') return 'billing-finance';
      if (kw === 'support' || kw === 'customer') return 'customer-support';
      if (kw === 'web') return 'web-development';
      if (kw === 'app') return 'app-development';
      if (kw === 'social') return 'social-media';
      if (kw === 'paid') return 'paid-advertisement';
      if (kw === 'openclaw') return 'openclaw-maintenance';
      if (kw === 'personal') return 'personal-assistant';
      if (kw === 'community') return 'community-management';
      if (kw === 'coach') return 'client-coaches';
      if (kw === 'course') return 'course-creator';
      if (kw === 'general') return 'general-task';
      return kw;
    }
  }
  return null;
}
