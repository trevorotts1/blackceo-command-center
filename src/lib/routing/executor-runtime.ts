import { runtimeRegistryEntries } from '@/lib/openclaw/runtime-registry';
import * as fs from 'fs';
import * as path from 'path';
import { queryOne } from '@/lib/db';
import { resolveOpenClawRuntimeRoot } from '@/lib/openclaw/runtime-root';
import { canonicalDeptSlug, expandDeptSlugAliases } from '@/lib/routing/canonical-slug';
import type { Agent } from '@/lib/types';

/**
 * LOG DEDUPE — one "no runtime dir" warning per distinct miss per window.
 *
 * This resolver is called on the drop-path of a sweep that runs every two
 * minutes, once per in-flight task. When a task's department has no runtime dir
 * on the box the miss is PERMANENT: nothing about it changes between ticks, and
 * every tick logged the same sentence again. One box logged it 7,788 times for a
 * SINGLE task that had never produced an execution. That volume does not make
 * the condition more visible; it buries every other line in the error log, which
 * is where a real fault has to be legible.
 *
 * The condition still warns — it is a real misconfiguration — but at most once
 * per (caller, slug, agent) per RESOLVE_WARN_INTERVAL_MS. The key deliberately
 * includes the agent id so a SECOND task hitting the same missing runtime is
 * still reported rather than hidden behind the first, and the caller `context`
 * so a dispatch miss is never swallowed by an earlier watcher miss.
 *
 * In-process rather than durable on purpose: there is no artifact here, only a
 * log line, so a restart re-logging once is correct — the operator reading a
 * fresh log should see the condition. This mirrors the triad-hold dedupe in
 * task-dispatcher.ts, which uses a durable `events` row only because that row is
 * itself the audit record. Nothing here needs to outlive the process.
 */
const RESOLVE_WARN_INTERVAL_MS = Math.max(
  0,
  parseInt(process.env.RESOLVE_WARN_INTERVAL_MS || String(6 * 60 * 60 * 1000), 10),
);
const lastResolveWarnAt = new Map<string, number>();

/** True when this exact miss has not been warned about inside the window. */
function shouldWarnResolveMiss(key: string): boolean {
  const now = Date.now();
  const last = lastResolveWarnAt.get(key);
  if (last !== undefined && now - last < RESOLVE_WARN_INTERVAL_MS) return false;
  lastResolveWarnAt.set(key, now);
  // The map is keyed by (context, slug, agent) and a box has a bounded number of
  // each, so it cannot grow without limit. The sweep drops entries that have
  // aged out anyway, which keeps it small on a long-lived process.
  if (lastResolveWarnAt.size > 512) {
    for (const [k, t] of lastResolveWarnAt) if (now - t >= RESOLVE_WARN_INTERVAL_MS) lastResolveWarnAt.delete(k);
  }
  return true;
}

/** Test seam: clear the dedupe window so a test can observe the warn again. */
export function resetResolveWarnDedupe(): void { lastResolveWarnAt.clear(); }

export function resolveSpecialistSessionKey(
  agent: Agent,
  openclawSessionId: string,
  workspaceId: string | undefined,
  context: string,
  allowCeoExecution = false,
): string | null {
  // P1-5 FIX — no hardcoded operator home. Was `process.env.HOME ?? <hardcoded operator
  // absolute path>`: on a box where HOME is unset (PM2/systemd/container contexts), a
  // CLIENT box silently resolved the OPERATOR's own home path. Mirrors
  // src/lib/context-pack.ts agentsRoot() / src/lib/platform.ts detectPlatform(): VPS
  // Docker keeps the `/data/.openclaw` persistent-volume marker; any home-relative
  // fallback goes through `os.homedir()`.
  let AGENTS_ROOT: string;
  try { AGENTS_ROOT = path.join(resolveOpenClawRuntimeRoot(), 'agents'); }
  catch { return null; }

  // A runtime binding must exist in this installation's registry and on disk.
  // Never infer `main` from an absent specialist runtime or an agent's name.
  const binding = queryOne<{openclaw_agent_id: string | null}>(
    'SELECT openclaw_agent_id FROM agents WHERE id=? AND workspace_id=?', [agent.id, workspaceId ?? null]);
  if (binding?.openclaw_agent_id) {
    const runtimeId = binding.openclaw_agent_id;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(runtimeId) || (runtimeId === 'main' && !allowCeoExecution)) return null;
    try {
      const configPath = path.join(resolveOpenClawRuntimeRoot(), 'openclaw.json');
      if (fs.statSync(configPath).size > 1024 * 1024) return null;
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (runtimeRegistryEntries(config).some(entry => entry.id === runtimeId)
        && fs.statSync(path.join(AGENTS_ROOT, runtimeId)).isDirectory()) {
        return `agent:${runtimeId}:${openclawSessionId}`;
      }
    } catch { /* An invalid explicit binding must not target another runtime. */ }
    return null;
  }

  // Attempt 1: lookup workspace slug from DB.
  if (workspaceId) {
    try {
      const ws = queryOne<{ slug: string }>(
        'SELECT slug FROM workspaces WHERE id = ? LIMIT 1',
        [workspaceId],
      );
      if (ws?.slug && ws.slug.toLowerCase() !== 'main') {
        const candidateSlug = ws.slug.toLowerCase();
        // Check BOTH the bare slug dir AND the dept- prefixed dir.
        // On live boxes the runtime dirs are dept-funnels / dept-web-development
        // (bare ones do NOT exist), so we must probe the dept- prefix first.
        const deptPrefixedSlug = `dept-${candidateSlug}`;
        const deptPrefixedDir = path.join(AGENTS_ROOT, deptPrefixedSlug);
        const bareDir = path.join(AGENTS_ROOT, candidateSlug);
        if (fs.existsSync(deptPrefixedDir)) {
          const key = `agent:${deptPrefixedSlug}:${openclawSessionId}`;
          console.log(`[${context}] resolveSpecialistSessionKey: workspace slug "${candidateSlug}" → dept-prefixed runtime found → key ${key}`);
          return key;
        }
        if (fs.existsSync(bareDir)) {
          const key = `agent:${candidateSlug}:${openclawSessionId}`;
          console.log(`[${context}] resolveSpecialistSessionKey: workspace slug "${candidateSlug}" → bare runtime found → key ${key}`);
          return key;
        }
        // Attempt 1b — ALIAS-AWARE runtime resolution, BOTH directions.
        //
        // Two sub-cases, both closed by probing every RAW spelling that
        // canonicalizes to the same department (expandDeptSlugAliases — the
        // documented inverse of canonicalDeptSlug):
        //   (a) legacy/aliased slug → CANONICAL runtime. A workspace slug
        //       like `ceo` or `webdev` has its runtime dir under the
        //       canonical name (`master-orchestrator`, `web-development`).
        //   (b) an ALREADY-canonical slug → a LEGACY-ALIAS runtime still on
        //       disk. A workspace slug that IS the canonical name (e.g.
        //       `billing-finance`) can have its runtime dir provisioned
        //       under a shorter legacy alias (`dept-billing`) instead of the
        //       canonical dir.
        // BUG (fixed here): the old guard (`canonicalSlug !== candidateSlug`)
        // skipped this WHOLE block whenever the slug was already canonical —
        // exactly sub-case (b) — so a canonical-slug workspace could NEVER
        // find an alias-named runtime dir even when one existed on disk (a
        // box with workspace `billing-finance` and runtime dir `dept-billing`
        // could never dispatch, despite the runtime existing — resolution
        // only ever ran alias → canonical, never canonical → alias). Probing
        // every alias closes both directions with the same code path.
        const canonicalSlug = canonicalDeptSlug(candidateSlug);
        if (canonicalSlug) {
          const aliasSlugs = expandDeptSlugAliases(candidateSlug).filter(
            (s) => !s.startsWith('dept-') && s !== candidateSlug,
          );
          for (const alias of aliasSlugs) {
            const aliasDeptDir = path.join(AGENTS_ROOT, `dept-${alias}`);
            const aliasBareDir = path.join(AGENTS_ROOT, alias);
            if (fs.existsSync(aliasDeptDir)) {
              const key = `agent:dept-${alias}:${openclawSessionId}`;
              console.log(`[${context}] resolveSpecialistSessionKey: slug "${candidateSlug}" (canonical "${canonicalSlug}") → alias "${alias}" → dept-prefixed runtime → key ${key}`);
              return key;
            }
            if (fs.existsSync(aliasBareDir)) {
              const key = `agent:${alias}:${openclawSessionId}`;
              console.log(`[${context}] resolveSpecialistSessionKey: slug "${candidateSlug}" (canonical "${canonicalSlug}") → alias "${alias}" → bare runtime → key ${key}`);
              return key;
            }
          }
        }
        if (shouldWarnResolveMiss(`${context}|${candidateSlug}|${agent.id}`)) {
          console.warn(`[${context}] resolveSpecialistSessionKey: workspace slug "${candidateSlug}" (canonical "${canonicalSlug}") has no runtime dir at ${deptPrefixedDir} or ${bareDir} — trying agent role slug. Further identical misses are suppressed for ${Math.round(RESOLVE_WARN_INTERVAL_MS / 3600000)}h.`);
        }
      }
    } catch (err) {
      console.warn(`[${context}] resolveSpecialistSessionKey: workspace lookup failed (non-fatal):`, (err as Error).message);
    }
  }

  // Attempt 2: derive a slug from the agent's role field (e.g. "Presentations Lead" → "dept-presentations").
  if (agent.role) {
    const roleSlug = `dept-${agent.role.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')}`;
    const runtimeDir = path.join(AGENTS_ROOT, roleSlug);
    if (fs.existsSync(runtimeDir)) {
      const key = `agent:${roleSlug}:${openclawSessionId}`;
      console.log(`[${context}] resolveSpecialistSessionKey: role slug "${roleSlug}" → runtime found → key ${key}`);
      return key;
    }
  }

  // Attempt 3: try agent name slug directly (e.g. agent named "dept-presentations").
  const nameSlug = agent.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  if (nameSlug && nameSlug !== 'main') {
    const runtimeDir = path.join(AGENTS_ROOT, nameSlug);
    if (fs.existsSync(runtimeDir)) {
      const key = `agent:${nameSlug}:${openclawSessionId}`;
      console.log(`[${context}] resolveSpecialistSessionKey: name slug "${nameSlug}" → runtime found → key ${key}`);
      return key;
    }
  }

  // RESOLVER-DISPATCH FIX (Gap E): NO per-department runtime resolved.
  //
  // The legacy behavior silently returned `agent:main:<id>` — the CEO/Stefanie
  // orchestrator, whose prompt FORBIDS building. That key re-ingests the task
  // into the loop-gate, burns turns, and produces ZERO artifacts; worse, the
  // silent fallback HIDES the misroute (the card looks dispatched but nothing
  // is built). We refuse the agent:main fallback and return null so the caller
  // can emit a loud, queryable 'routed but not dispatched' signal and HOLD the
  // task (visible) instead of feeding the loop. This changes the loop-gate's
  // VISIBILITY/AVOIDANCE only — not the loop-gate behavior itself.
  console.error(
    `[${context}] resolveSpecialistSessionKey: NO specialist runtime for agent "${agent.name}" ` +
    `(workspace_id=${workspaceId ?? 'none'}, role=${agent.role ?? 'none'}). ` +
    `REFUSING silent agent:main fallback — task will be held as 'routed but not dispatched'. ` +
    `Add ~/.openclaw/agents/<dept-slug>/ to wire this department.`,
  );
  return null;
}

