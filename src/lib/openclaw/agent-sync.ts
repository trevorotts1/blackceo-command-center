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
 * call the gateway's `agents.list` RPC — the authoritative roster of configured
 * agents — and UPSERT each specialist into the CC `agents` table, carrying over
 * the display name, emoji, and model the operator chose on the gateway.
 *
 * This is deliberately ASYNC and fire-and-forget on boot — the synchronous
 * runMigrations() does NOT block on a gateway RPC.  The instrumentation hook
 * (which runs AFTER migrations complete) triggers the async ingest once the
 * gateway connection is established.
 *
 * Invariants:
 *   • NEVER touches the master Orchestrator row (is_master=1).
 *   • NEVER touches the gateway's default/main orchestrator agent.
 *   • NEVER touches CC-generated trio/head agent rows (qc-agent-*, research-agent-*, da-agent-*, head-agent-*).
 *   • Gateway-unreachable → logged and skipped (non-fatal).  The converge
 *     endpoint can retry later when the gateway is ready.
 *   • Idempotent — keyed on the agent's own stable gateway id, with an
 *     ON CONFLICT UPDATE on re-sync so data stays current.
 */

import { getDb } from '@/lib/db';
import {
  getOpenClawClient,
  type OpenClawAgentEntry,
  type OpenClawAgentsList,
} from './client';

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
 *   1. Call agents.list to fetch the gateway's configured agent roster.
 *   2. Filter out the gateway orchestrator/main agent and CC-managed trio/head
 *      ids (those are owned by the CC, never by this sync).
 *   3. Resolve each specialist's department → workspace id from the CC
 *      `workspaces` table (best-effort; falls back to 'default').
 *   4. UPSERT the agent row (keyed on the gateway id, UPDATE on re-sync).
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

  // ── 2. Discover the specialist roster via agents.list ─────────────────────
  // The gateway's `agents.list` RPC is the AUTHORITATIVE source for the Skill-23
  // workforce: it returns every configured agent with its display name, emoji,
  // and model in one call.
  //
  // (FABLE CORRECTION — the original fix discovered agents via sessions.list and
  // then called node.describe per agent id. That is broken: the gateway's
  // node.describe handler ONLY resolves paired *devices/nodes* (it looks the id
  // up in the node catalog and returns "unknown nodeId" otherwise), so EVERY
  // specialist agent id failed to describe and rows were inserted with garbage
  // fallback names like "Agent a1b2c3d4". agents.list is the RPC the MR-14
  // recommendation names, and it returns the real names + emojis directly.)
  let agentsList: OpenClawAgentsList;
  try {
    agentsList = await client.listAgents();
  } catch (err) {
    result.message = `agents.list RPC failed — skipping specialists ingest (non-fatal): ${(err as Error).message}`;
    return result;
  }

  const gatewayAgents: OpenClawAgentEntry[] = Array.isArray(agentsList?.agents)
    ? agentsList.agents
    : [];

  if (gatewayAgents.length === 0) {
    result.message = 'No agents returned by the gateway — nothing to ingest.';
    return result;
  }

  // The gateway's default/main agent is the operator-facing orchestrator bridge;
  // it maps to the CC master Orchestrator, so never ingest it as a specialist.
  const reservedIds = new Set<string>(
    [agentsList.defaultId, agentsList.mainKey, 'main'].filter(
      (x): x is string => typeof x === 'string' && x.trim().length > 0,
    ),
  );

  console.log(`[Agent-Sync] Discovered ${gatewayAgents.length} agent(s) on the gateway.`);

  // ── 3. Upsert each specialist ─────────────────────────────────────────────
  const db = getDb();
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

  for (const entry of gatewayAgents) {
    const agentId = str(entry?.id, '');
    try {
      if (!agentId) {
        result.skipped++;
        continue;
      }

      // Skip the gateway orchestrator / main agent.
      if (reservedIds.has(agentId)) {
        result.skipped++;
        continue;
      }

      // Skip CC-managed agents (trio/head patterns).
      if (isCcManagedAgentId(agentId)) {
        result.skipped++;
        continue;
      }

      // Skip the master orchestrator if it somehow shares an id.
      const existing = db
        .prepare('SELECT is_master FROM agents WHERE id = ?')
        .get(agentId) as { is_master: number } | undefined;
      if (existing?.is_master === 1) {
        result.skipped++;
        continue;
      }

      // Display name: identity.name wins, then entry.name, then a stable fallback.
      const name =
        str(entry.identity?.name, '') ||
        str(entry.name, '') ||
        `Agent ${agentId.length > 8 ? agentId.slice(0, 8) : agentId}`;

      // Resolve department → workspace id from the agent's name.
      const dept = inferDeptFromAgentName(name);
      const workspaceId = dept ? resolveWorkspaceId(db, dept) : 'default';

      const role = name;
      const deptForDesc = dept || 'general';
      const description = `${role} for the ${deptForDesc} department (synced from OpenClaw gateway).`;
      // Prefer the emoji the operator chose on the gateway; infer one otherwise.
      const emoji = str(entry.identity?.emoji, '') || inferEmoji(name);
      const model = str(entry.model, '') || null;
      // agents.list carries no role_type; specialists are the only kind it lists
      // (the orchestrator/main agent is filtered above).
      const roleType = 'specialist';

      const existedBefore = !!db
        .prepare('SELECT 1 FROM agents WHERE id = ?')
        .get(agentId);

      upsertAgent.run(
        agentId, name, role, description, emoji, 'standby',
        workspaceId, model, roleType, now, now,
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
