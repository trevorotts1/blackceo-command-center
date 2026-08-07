/**
 * runtime-model.ts — Resolve the ACTUAL model an agent will run on.
 *
 * FIX-15 (Error 7 / Rule R7 — model skew): CC `tasks.model_id` used to be
 * written from the CC's own resolution (`settings.model` — the registry /
 * selector's "intended" model, e.g. `ollama-cloud/mistral-large-3:675b`),
 * which is NOT the model the OpenClaw runtime actually loads. The runtime
 * selects the model from the agent's OWN `openclaw.json` config entry
 * (`agents.list[i].model.primary`), e.g. `ollama/deepseek-v4-flash:0731-cloud`.
 * The owner was told a deck was built by a model it wasn't (Error 7).
 *
 * This module resolves the runtime model from the agent config BEFORE the
 * task row is written, so `tasks.model_id` reflects what will actually run —
 * and reports `model_skew_detected` events whenever the CC's intended model
 * diverges from the runtime model, so the skew is queryable (the FIX-15 QC
 * gate reads that event row).
 *
 * Resolution order (read-only, never throws, tolerant of missing boxes):
 *   1. OPENCLAW CONFIG (`openclaw.json` → `agents.list`) — the authoritative
 *      runtime model. The entry is matched by the same slug derivation the
 *      dispatch routes use (`resolveSpecialistSessionKey`: workspace slug →
 *      `dept-<slug>` then bare slug, then role slug, then agent-name slug).
 *      `model.primary` is what the agent will load when its session starts.
 *   2. GATEWAY SESSION (live `sessions.list`) — when the runtime session for
 *      this agent is live, the gateway reports the model it ACTUALLY ran with
 *      (`model` + `modelProvider`). Preferred when present — it is the
 *      confirmed, not just configured, runtime model.
 *   3. AGENT DB COLUMN (`agents.model`) — legacy/UI-pinned model. Lowest
 *      authority; it is empty for every presentation agent today (Error 7).
 *
 * All three are read-only. This module never writes, never mutates a client
 * config, and never touches credentials — it only READS `openclaw.json`.
 */

import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { run } from '@/lib/db';
import { openclawConfigPath } from '@/lib/platform';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { canonicalDeptSlug } from '@/lib/routing/canonical-slug';
import type { Agent } from '@/lib/types';

/** Where the resolved runtime model came from. */
export type RuntimeModelSource =
  | 'openclaw_config'
  | 'gateway_session'
  | 'agent_db'
  | 'none';

export interface RuntimeModelResolution {
  /** The model id the runtime will load (provider-prefixed, e.g. `ollama/deepseek-v4-flash:0731-cloud`). */
  model_id: string | null;
  /** Provider portion of the runtime model id, when split (e.g. `ollama`). */
  provider: string | null;
  /** Which source produced this resolution. */
  source: RuntimeModelSource;
  /** The config entry id matched inside `openclaw.json`, for diagnostics. */
  configAgentId: string | null;
  /** The raw `model.primary` string read from the config, if any. */
  configPrimary: string | null;
  /** Live gateway session model, when a session was found and reported one. */
  gatewayModel: string | null;
}

/** Maximum bytes of `openclaw.json` we will read — mirrors `/api/openclaw/models`. */
const MAX_CONFIG_SIZE_BYTES = 1024 * 1024;

interface OpenClawAgentConfigEntry {
  id?: string;
  model?: {
    primary?: string;
  };
}

interface OpenClawConfigShape {
  agents?: {
    list?: OpenClawAgentConfigEntry[];
  };
}

/**
 * Read `openclaw.json` once, tolerantly. Returns null on any failure (missing
 * file, unparseable JSON, oversized file) — never throws.
 *
 * `configPathOverride` exists for tests / maintenance scripts that want a
 * deterministic fixture instead of the live box config.
 */
export function readOpenClawConfig(configPathOverride?: string): OpenClawConfigShape | null {
  try {
    const p = configPathOverride || openclawConfigPath();
    if (!fs.existsSync(p)) return null;
    const stat = fs.statSync(p);
    if (stat.size > MAX_CONFIG_SIZE_BYTES) return null;
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return parsed as OpenClawConfigShape;
  } catch {
    return null;
  }
}

/**
 * Derive candidate runtime slugs for an agent, in the SAME order the dispatch
 * routes use (`resolveSpecialistSessionKey`): workspace slug (`dept-<slug>`
 * then bare), role slug, then agent-name slug. Returns a deduped ordered list.
 */
export function runtimeSlugCandidates(agent: Agent, workspaceId?: string): string[] {
  const out: string[] = [];
  const push = (s: string | null | undefined) => {
    if (!s) return;
    const slug = s.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    if (slug && !out.includes(slug)) out.push(slug);
  };

  // 1. Workspace slug — dept-prefixed FIRST (live dirs are dept-funnels, etc.),
  //    then bare, then canonical alias (mirrors the dispatch route exactly).
  if (workspaceId) {
    push(workspaceId);
    const canonical = canonicalDeptSlug(workspaceId.toLowerCase());
    if (canonical && canonical !== workspaceId.toLowerCase()) push(canonical);
  }
  // 2. Role slug.
  push(agent.role);
  // 3. Agent-name slug.
  push(agent.name);

  return out;
}

/**
 * Resolve the runtime model for an agent from its OpenClaw config entry.
 * Returns null when no entry or no `model.primary` is found.
 */
export function resolveRuntimeModelFromConfig(
  agent: Agent,
  workspaceId?: string,
  configPathOverride?: string,
): { model_id: string | null; configAgentId: string | null } | null {
  const config = readOpenClawConfig(configPathOverride);
  const list = config?.agents?.list;
  if (!list || !Array.isArray(list) || list.length === 0) return null;

  const candidates = runtimeSlugCandidates(agent, workspaceId);

  // Match by id: the config entry id (e.g. `dept-presentations`) is compared
  // against each candidate slug with AND without the `dept-` prefix. A bare
  // candidate `presentations` therefore matches a config id of either
  // `presentations` or `dept-presentations`; a dept-prefixed candidate
  // `dept-funnels` matches `funnels` or `dept-funnels`. Order in `list` wins.
  const entry = list.find((e) => {
    const id = e?.id;
    if (!id) return false;
    const lowered = id.toLowerCase();
    const bare = lowered.replace(/^dept-/, '');
    return candidates.some(
      (c) => c === lowered || c === bare || c === `dept-${bare}`,
    );
  });

  if (!entry) return null;
  const primary = entry.model?.primary ?? null;
  if (!primary) {
    return { model_id: null, configAgentId: entry.id ?? null };
  }
  return { model_id: primary, configAgentId: entry.id ?? null };
}

/**
 * Try to read the live runtime model from the gateway `sessions.list`.
 *
 * The gateway reports, per session, the model it ACTUALLY ran with
 * (`model` + `modelProvider`). A freshly created session that has not started
 * yet may be absent, so this is a best-effort CROSS-CHECK, never a hard
 * dependency. Never throws.
 */
export async function resolveRuntimeModelFromGateway(
  agent: Agent,
  workspaceId: string | undefined,
  sessionOpenClawSessionId: string,
): Promise<{ model: string | null; provider: string | null } | null> {
  try {
    const client = getOpenClawClient();
    if (!client.isConnected()) {
      try {
        await client.connect();
      } catch {
        return null;
      }
    }
    const sessions = await client.listSessions();
    if (!Array.isArray(sessions)) return null;

    const candidates = runtimeSlugCandidates(agent, workspaceId);
    // The session key is `agent:<slug>:<sessionId>`. Match the middle segment
    // to any candidate slug, and (when known) the trailing segment to the
    // agent's own OpenClaw session id.
    for (const s of sessions) {
      const key = (s as { key?: string }).key ?? '';
      const parts = key.split(':');
      if (parts.length < 3) continue;
      const slug = parts[1]?.toLowerCase() ?? '';
      if (!candidates.includes(slug) && !candidates.includes(slug.replace(/^dept-/, ''))) continue;
      if (sessionOpenClawSessionId && !key.endsWith(sessionOpenClawSessionId)) continue;
      const model = (s as { model?: string }).model ?? null;
      if (!model) continue;
      return { model, provider: (s as { modelProvider?: string }).modelProvider ?? null };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve the runtime model for a dispatch. Best-effort: never throws, never
 * blocks dispatch. Prefers the gateway live session (confirmed runtime), falls
 * back to the agent config `model.primary` (what the runtime will load), then
 * the CC `agents.model` column.
 */
export async function resolveAgentRuntimeModel(
  agent: Agent,
  workspaceId?: string,
  sessionOpenClawSessionId?: string,
  configPathOverride?: string,
): Promise<RuntimeModelResolution> {
  const base: RuntimeModelResolution = {
    model_id: null,
    provider: null,
    source: 'none',
    configAgentId: null,
    configPrimary: null,
    gatewayModel: null,
  };

  // 1. Gateway live session — the CONFIRMED runtime model, when the session is
  //    live and reports one.
  if (sessionOpenClawSessionId) {
    const gw = await resolveRuntimeModelFromGateway(agent, workspaceId, sessionOpenClawSessionId);
    if (gw?.model) {
      return {
        ...base,
        model_id: gw.model,
        provider: gw.provider,
        source: 'gateway_session',
        gatewayModel: gw.model,
      };
    }
  }

  // 2. OpenClaw config `agents.list[i].model.primary` — what the runtime loads.
  const cfg = resolveRuntimeModelFromConfig(agent, workspaceId, configPathOverride);
  if (cfg?.model_id) {
    const provider = cfg.model_id.includes('/') ? cfg.model_id.split('/')[0] : null;
    return {
      ...base,
      model_id: cfg.model_id,
      provider,
      source: 'openclaw_config',
      configAgentId: cfg.configAgentId,
      configPrimary: cfg.model_id,
    };
  }

  // 3. CC `agents.model` column — legacy UI-pinned model (lowest authority).
  const dbModel = agent.model ?? null;
  if (dbModel) {
    const provider = dbModel.includes('/') ? dbModel.split('/')[0] : null;
    return {
      ...base,
      model_id: dbModel,
      provider,
      source: 'agent_db',
    };
  }

  return base;
}

/**
 * Normalize two model ids for comparison. Strips provider prefixes and lowercases
 * so `ollama/deepseek-v4-flash:0731-cloud` and `deepseek-v4-flash:0731-cloud`
 * compare equal regardless of how the provider was written.
 */
export function normalizeModelId(model: string | null | undefined): string {
  if (!model) return '';
  const noPrefix = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model;
  return noPrefix.toLowerCase();
}

/** True when two model ids refer to the same runtime model. */
export function modelsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeModelId(a);
  const nb = normalizeModelId(b);
  if (!na || !nb) return false;
  return na === nb;
}

/**
 * Record a `model_skew_detected` event row when the CC's intended model and the
 * runtime model differ. Always writes the row (even when they match, the caller
 * may pass a "skew" flag explicitly). Never throws — a failed insert must not
 * fail a dispatch.
 */
export function recordModelSkewEvent(opts: {
  taskId: string;
  agentId: string;
  intended: string | null | undefined;
  runtime: string | null | undefined;
  skew: boolean;
  detail: Record<string, unknown>;
}): void {
  try {
    const skew = opts.skew;
    const message =
      skew
        ? `MODEL-SKEW: task ${opts.taskId} intended="${opts.intended ?? 'null'}" but runtime="'${opts.runtime ?? 'null'}"`
        : `MODEL-MATCH: task ${opts.taskId} model="${opts.runtime ?? opts.intended ?? 'null'}" confirmed runtime`;
    run(
      `INSERT INTO events (id, type, agent_id, task_id, message, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        uuidv4(),
        skew ? 'model_skew_detected' : 'model_runtime_confirmed',
        opts.agentId,
        opts.taskId,
        message,
        JSON.stringify({
          intended_model: opts.intended ?? null,
          runtime_model: opts.runtime ?? null,
          skew,
          ...opts.detail,
        }),
        new Date().toISOString(),
      ],
    );
  } catch {
    // A telemetry row must never fail a dispatch.
  }
}
