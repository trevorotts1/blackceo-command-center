/**
 * Shared task-creation core.
 *
 * The canonical "write a task onto the board" path used by BOTH:
 *   - the operator UI create route (POST /api/tasks), and
 *   - the universal task-ingest endpoint (POST /api/tasks/ingest).
 *
 * Extracting it here guarantees the two front doors can't drift: same INSERT,
 * same `task_created` event, same SOP auto-suggest, same persona selection,
 * same SSE broadcast, and the same outbound `task-created` webhook notify that
 * tells the OpenClaw COM/CEO agent a task is now on the board.
 *
 * IMPORTANT (ingest safety): `assigned_agent_id` / `created_by_agent_id` are
 * FK columns into `agents` and are validated as `.uuid()` by CreateTaskSchema.
 * An external OpenClaw payload cannot carry a Command Center agent UUID, so the
 * ingest endpoint MUST leave both NULL — never pass a raw external id here.
 *
 * DEDUPLICATION (two layers):
 *
 * Layer 1 — Idempotency key: callers that supply an `idempotency_key` in
 * CreateTaskCoreInput get an event-marker check (`[ingest:<key>]` embedded in
 * the task_created event message). A second call with the same key returns the
 * existing task immediately.
 *
 * Layer 2 — Title+workspace window: before any insert, we check for a
 * NON-archived task with the same normalised title (lowercase, trimmed,
 * punctuation-collapsed) AND the same workspace/department, created within the
 * last DEDUP_WINDOW_SEC seconds (default 120, env-overridable). A match returns
 * the existing task with deduped:true so the caller surfaces it correctly.
 * This layer fires for BOTH the ingest path and the normal UI create path.
 */

import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { queryOne, queryAll, run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { selectPersonaForTask } from '@/lib/persona-selector';
import { getBestSOPForTask } from '@/lib/sops';
import { routeTask } from '@/lib/routing/department-router';
import { canonicalDeptSlug } from '@/lib/routing/canonical-slug';
import { autoDispatchTask } from '@/lib/task-dispatcher';
import { ensureCampaignForTask } from '@/lib/campaigns';
import type { Task, TaskPriority, Agent } from '@/lib/types';

// ─── SENTINEL GUARD HELPERS ──────────────────────────────────────────────────

/**
 * Read the onboarding skill version installed on this box.
 *
 * The installer writes a single-line version string to one of these locations:
 *   Mac Mini:   ~/.onboarding-version
 *   VPS Docker: /data/.onboarding-version
 *
 * Falls back to the ONBOARDING_VERSION env var (useful for testing / CI).
 * Returns "unknown" if neither source is available.
 *
 * Exported so unit tests can verify the lookup without spawning processes.
 */
export function getInstalledSkillVersion(): string {
  const envOverride = process.env.ONBOARDING_VERSION;
  if (envOverride && envOverride.trim()) return envOverride.trim();

  const candidates: string[] = [
    '/data/.onboarding-version',               // VPS Docker (persistent /data volume)
    path.join(os.homedir(), '.onboarding-version'), // Mac Mini / dev
  ];

  for (const candidate of candidates) {
    try {
      const raw = fs.readFileSync(candidate, 'utf-8').trim();
      if (raw) return raw;
    } catch {
      // File absent — try next candidate.
    }
  }

  return 'unknown';
}

/**
 * Persona IDs that an old, buggy list_available_personas() emitted instead of
 * real persona ids (the bug was fixed in persona-selector-v2.py, see line
 * 604-611 of that file).  This guard is intentionally kept for ONE release to
 * surface stale installs via a loud warning, not silently swallow them.
 *
 * PRD 3.4: keep the guard, but LOG A LOUD WARNING with the installed skill
 * version so operators can identify and update stale boxes.
 */
export const SENTINEL_IDS = new Set([
  'schemaVersion',
  'created',
  'domainTags',
  'perspectiveTags',
  'personas',
]);

// ─── PERSONA PIN (G10-TRIAD-PERSONA-RESOLVE) ────────────────────────────────
// The persona pick is async (spawns persona-selector-v2.py). Historically it ran
// as a single fire-and-forget block AFTER autoDispatchTask, so first-of-(dept,
// category) tasks dispatched while tasks.persona_id was still NULL — the dispatcher
// (intelligence-resolver.resolveAndLog reads tasks.persona_id at send time) then
// fell back to 'auto' self-select, so the persona the BOARD showed != the persona
// the RUNTIME used (Cause A). It was also one-shot: a transient selector failure
// left the task permanently unpinned, which then 400'd the Triad gate on the first
// move out of backlog (human drag silently reverted).
//
// resolvePersonaAndPin() centralises the selection + pin + SSE re-broadcast with a
// BOUNDED retry (no cron, no self-resurrect, no furnace): at most
// PERSONA_PIN_MAX_ATTEMPTS python spawns with capped linear backoff. createTaskCore
// kicks this off concurrently, then gates autoDispatchTask on it for a bounded
// budget so board persona == runtime persona without blocking the API response.
export const PERSONA_PIN_MAX_ATTEMPTS = 3;
export const PERSONA_PIN_RETRY_BASE_MS = 1500;
// Max time auto-dispatch waits for the pin before proceeding (degraded to 'auto').
// The retry promise still lands the pin + re-broadcasts after dispatch if it times out.
export const PERSONA_PIN_DISPATCH_BUDGET_MS = 8000;

// ─── DEPARTMENT-DEFAULT PERSONA FALLBACK (POINT 10 fix 1) ────────────────────
// The founder's board invariant: EVERY task carries a persona. Historically,
// resolvePersonaAndPin() left a task personaless after PERSONA_PIN_MAX_ATTEMPTS
// failed selector spawns, so a card could sit in backlog with no persona chip
// until it was moved (the Triad gate auto-resolved on the first move). On a box
// whose selector is degraded, that is a silent, board-wide gap. On exhaustion we
// now pin a DETERMINISTIC department-default persona and flag it
// `persona_fallback=1` for audit. `no_persona_required` (intentional) is handled
// earlier and stays personaless.

/** Collapse a persona id / slug to a human-readable display name. */
function humanizeSlug(slug: string): string {
  return slug
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/** Whether the tasks table carries the persona_fallback audit column (migration 083). */
function tasksHasPersonaFallbackColumn(): boolean {
  try {
    const cols = queryAll<{ name: string }>('PRAGMA table_info(tasks)', []);
    return cols.some((c) => c.name === 'persona_fallback');
  } catch {
    return false;
  }
}

export interface DepartmentDefaultPersona {
  persona_id: string;
  persona_name: string;
  persona_mode: string;
  /** How the default was derived — for audit + observability. */
  source: 'department-sticky' | 'department-synthetic';
}

/**
 * Derive a deterministic department-default persona for the exhaustion path.
 *
 * Tier 1 — the department's current sticky "lead" persona from
 *   `persona_assignment` (the genuine, selector-recorded stickiness state per
 *   department/category). The most-recently-assigned, highest-switch row is the
 *   closest thing the board has to a department-head persona. This table is
 *   written ONLY by the real selector — never by this fallback path — so it can
 *   never feed on itself.
 * Tier 2 — a stable, department-tagged synthetic default (`dept-default-<slug>`).
 *   Deterministic from the canonical slug, so a brand-new department with zero
 *   history still gets the SAME default every time and the board invariant holds.
 *
 * Never throws for a caller: any DB error degrades to the Tier-2 synthetic id.
 */
export function deriveDepartmentDefaultPersona(
  department: string | null | undefined,
): DepartmentDefaultPersona {
  const canon = canonicalDeptSlug(department || '') || 'general-task';

  try {
    const sticky = queryOne<{
      persona_id: string;
      persona_name: string | null;
      persona_mode: string | null;
    }>(
      `SELECT persona_id, persona_name, persona_mode
         FROM persona_assignment
        WHERE department_id = ?
          AND persona_id IS NOT NULL AND persona_id != ''
        ORDER BY last_assigned_at DESC, switch_count DESC, persona_id ASC
        LIMIT 1`,
      [canon],
    );
    if (sticky && sticky.persona_id && !SENTINEL_IDS.has(sticky.persona_id)) {
      return {
        persona_id: sticky.persona_id,
        persona_name: sticky.persona_name || humanizeSlug(sticky.persona_id),
        persona_mode: sticky.persona_mode || 'leadership',
        source: 'department-sticky',
      };
    }
  } catch {
    // persona_assignment absent (pre-migration-019) — fall through to synthetic.
  }

  return {
    persona_id: `dept-default-${canon}`,
    persona_name: `${humanizeSlug(canon)} Department Default`,
    persona_mode: 'leadership',
    source: 'department-synthetic',
  };
}

/**
 * Pin a department-default persona onto a task and mark it persona_fallback=true.
 * Writes a queryable `persona_fallback` audit event (independent of the column so
 * the record exists even on a pre-migration DB) and re-broadcasts the row.
 */
function pinDepartmentDefaultPersona(taskId: string, fb: DepartmentDefaultPersona): void {
  const now = new Date().toISOString();

  if (tasksHasPersonaFallbackColumn()) {
    run(
      `UPDATE tasks
          SET persona_id = ?, persona_name = ?, persona_mode = ?,
              persona_score = NULL, persona_version = 1,
              persona_selected_at = ?, persona_fallback = 1
        WHERE id = ?`,
      [fb.persona_id, fb.persona_name, fb.persona_mode, now, taskId],
    );
  } else {
    run(
      `UPDATE tasks
          SET persona_id = ?, persona_name = ?, persona_mode = ?,
              persona_score = NULL, persona_version = 1,
              persona_selected_at = ?
        WHERE id = ?`,
      [fb.persona_id, fb.persona_name, fb.persona_mode, now, taskId],
    );
  }

  run(
    `INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, ?, ?, ?, ?)`,
    [
      uuidv4(),
      'persona_fallback',
      taskId,
      `[PERSONA-FALLBACK] Selector exhausted after ${PERSONA_PIN_MAX_ATTEMPTS} attempts — pinned ${fb.source} ` +
        `department-default persona "${fb.persona_id}" (${fb.persona_name}). persona_fallback=true.`,
      now,
    ],
  );

  const updatedTask = queryOne<Task>(
    `SELECT t.*,
        aa.name as assigned_agent_name,
        aa.avatar_emoji as assigned_agent_emoji,
        ca.name as created_by_agent_name,
        ca.avatar_emoji as created_by_agent_emoji
       FROM tasks t
       LEFT JOIN agents aa ON t.assigned_agent_id = aa.id
       LEFT JOIN agents ca ON t.created_by_agent_id = ca.id
      WHERE t.id = ?`,
    [taskId],
  );
  if (updatedTask) {
    broadcast({ type: 'task_updated', payload: updatedTask });
    console.log(
      `[resolvePersonaAndPin] department-default persona pinned for task ${taskId}: ${fb.persona_id} (persona_fallback=true)`,
    );
  }
}

/**
 * Select a persona for a task, persist it (tasks.persona_*), and re-broadcast the
 * updated task over SSE so the board chip lands. Retry-backed and bounded.
 *
 * @returns the pinned persona_id (a matched persona OR, on selector exhaustion, a
 *          deterministic department-default flagged persona_fallback=true), or null
 *          ONLY when the selector explicitly returned no_persona_required.
 */
export async function resolvePersonaAndPin(
  taskId: string,
  taskDescription: string,
  departmentForSelector: string,
): Promise<string | null> {
  for (let attempt = 1; attempt <= PERSONA_PIN_MAX_ATTEMPTS; attempt++) {
    try {
      const persona = await selectPersonaForTask(taskId, taskDescription, departmentForSelector);

      // PRD 3.4 SENTINEL GUARD: loudly flag bad ids from a stale selector install.
      if (persona && persona.persona_id && SENTINEL_IDS.has(persona.persona_id)) {
        console.warn(
          `[resolvePersonaAndPin] ⚠️  STALE INSTALL: selector returned sentinel id ` +
          `"${persona.persona_id}" (skill ${getInstalledSkillVersion()}, task_id=${taskId}). ` +
          `Update onboarding skills on this box.`,
        );
      }

      // Explicit "no persona required" is terminal — not a failure, do not retry.
      if (persona && persona.no_persona_required) {
        return null;
      }

      if (persona && persona.persona_id && !SENTINEL_IDS.has(persona.persona_id)) {
        const personaSelectedAt = new Date().toISOString();
        run(
          `UPDATE tasks
              SET persona_id = ?,
                  persona_name = ?,
                  persona_mode = ?,
                  persona_score = ?,
                  persona_version = ?,
                  persona_selected_at = ?
            WHERE id = ?`,
          [
            persona.persona_id,
            persona.persona_name,
            persona.interaction_mode,
            persona.score ?? null,
            persona.persona_version ?? 1,
            personaSelectedAt,
            taskId,
          ],
        );

        const updatedTask = queryOne<Task>(
          `SELECT t.*,
            aa.name as assigned_agent_name,
            aa.avatar_emoji as assigned_agent_emoji,
            ca.name as created_by_agent_name,
            ca.avatar_emoji as created_by_agent_emoji
           FROM tasks t
           LEFT JOIN agents aa ON t.assigned_agent_id = aa.id
           LEFT JOIN agents ca ON t.created_by_agent_id = ca.id
           WHERE t.id = ?`,
          [taskId],
        );
        if (updatedTask) {
          broadcast({ type: 'task_updated', payload: updatedTask });
          console.log(`[resolvePersonaAndPin] Persona landed for task ${taskId}: ${persona.persona_id}`);
        }
        return persona.persona_id;
      }
      // null / sentinel-only result — transient; fall through to retry with backoff.
    } catch (err) {
      console.error(`[resolvePersonaAndPin] attempt ${attempt}/${PERSONA_PIN_MAX_ATTEMPTS} threw for task ${taskId}:`, err);
    }
    if (attempt < PERSONA_PIN_MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, PERSONA_PIN_RETRY_BASE_MS * attempt));
    }
  }
  // EXHAUSTION FALLBACK (Point 10 fix 1): the selector failed every attempt.
  // Never leave a task personaless — pin a deterministic department-default and
  // flag it persona_fallback=true for audit so the board invariant ("EVERY task
  // carries a persona") holds. `no_persona_required` is handled ABOVE (returns
  // null early) and is intentionally left personaless.
  try {
    const fallback = deriveDepartmentDefaultPersona(departmentForSelector);
    pinDepartmentDefaultPersona(taskId, fallback);
    console.warn(
      `[resolvePersonaAndPin] exhausted ${PERSONA_PIN_MAX_ATTEMPTS} attempts for task ${taskId} — ` +
      `pinned ${fallback.source} department-default persona "${fallback.persona_id}" (persona_fallback=true).`,
    );
    return fallback.persona_id;
  } catch (fbErr) {
    console.error(
      `[resolvePersonaAndPin] department-default fallback pin FAILED for task ${taskId} — left unpinned:`,
      fbErr,
    );
    return null;
  }
}

// ─── DEDUPLICATION HELPERS ──────────────────────────────────────────────────

/**
 * Default dedup window in seconds. Override via DEDUP_WINDOW_SEC env var.
 * Two identical tasks created within this window are considered duplicates.
 */
export const DEFAULT_DEDUP_WINDOW_SEC = 120;

/**
 * Collapse a task title to a normalised comparison key.
 * Rules: lowercase, trim, collapse all whitespace to single space, strip
 * all non-alphanumeric non-space chars so minor punctuation differences
 * (em-dashes, commas, periods) don't create false negatives.
 */
export function normalizeTitle(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s]/g, ' ') // collapse punctuation to spaces
    .replace(/\s+/g, ' ')          // collapse runs of whitespace
    .trim();
}

export interface DedupeResult {
  task: Task;
  deduped: true;
}

/**
 * Check whether a non-archived task with the same normalised title and same
 * workspace already exists within the configured dedup window.
 *
 * Returns the matching Task if found, null otherwise.
 *
 * SQLite has no native normalisation function so we pull candidate rows by
 * workspace + recency window and filter in JS. The candidate set is tiny
 * (tasks created in the last N seconds) so this is fast and schema-free.
 */
export function findDuplicateByTitleWindow(
  title: string,
  workspaceId: string | null | undefined,
  dedupWindowSec?: number,
): Task | null {
  const windowSec =
    dedupWindowSec ??
    (process.env.DEDUP_WINDOW_SEC ? parseInt(process.env.DEDUP_WINDOW_SEC, 10) : DEFAULT_DEDUP_WINDOW_SEC);
  const cutoff = new Date(Date.now() - windowSec * 1000).toISOString();
  const normalised = normalizeTitle(title);

  const JOIN_CLAUSE = `
    SELECT t.*,
        aa.name             as assigned_agent_name,
        aa.avatar_emoji     as assigned_agent_emoji,
        ca.name             as created_by_agent_name,
        ca.avatar_emoji     as created_by_agent_emoji
    FROM tasks t
    LEFT JOIN agents aa ON t.assigned_agent_id  = aa.id
    LEFT JOIN agents ca ON t.created_by_agent_id = ca.id`;

  let candidates: Task[];
  if (workspaceId) {
    candidates = queryAll<Task>(
      `${JOIN_CLAUSE}
       WHERE t.status != 'archived'
         AND t.workspace_id = ?
         AND t.created_at >= ?
       ORDER BY t.created_at ASC`,
      [workspaceId, cutoff],
    );
  } else {
    // Match tasks with NULL workspace_id
    candidates = queryAll<Task>(
      `${JOIN_CLAUSE}
       WHERE t.status != 'archived'
         AND t.workspace_id IS NULL
         AND t.created_at >= ?
       ORDER BY t.created_at ASC`,
      [cutoff],
    );
  }

  for (const c of candidates) {
    if (normalizeTitle(c.title) === normalised) {
      return c;
    }
  }
  return null;
}

export interface CreateTaskCoreInput {
  title: string;
  description?: string | null;
  status?: string;
  priority?: TaskPriority;
  assigned_agent_id?: string | null;
  created_by_agent_id?: string | null;
  business_id?: string | null;
  workspace_id?: string | null;
  department?: string | null;
  due_date?: string | null;
  sop_id?: string | null;
  /**
   * Free-text message stored on the `task_created` event row. When omitted a
   * default is composed. The ingest endpoint embeds its idempotency key here so
   * a retry/backfill can dedupe without a schema change.
   */
  eventMessage?: string;
  /**
   * Caller-supplied idempotency key. When provided, createTaskCore checks for
   * a prior `task_created` event carrying `[ingest:<key>]` and returns that
   * task with deduped:true instead of inserting a duplicate.
   */
  idempotency_key?: string | null;
  /**
   * When true, skip the title+workspace window dedup check. Use only for
   * explicit operator UI creates where the user intentionally wants two tasks
   * with the same title (e.g. recurring tasks). Default: false.
   */
  skipWindowDedup?: boolean;
}

export interface CreateTaskCoreResult {
  task: Task;
  deduped: boolean;
}

export interface CreateTaskCoreOptions {
  /**
   * Fire the outbound `/api/webhooks/task-created` notify to the OpenClaw
   * gateway. Defaults to true so ingested tasks announce themselves exactly
   * like UI-created ones. The base URL is derived from `origin` (falling back
   * to NEXT_PUBLIC_APP_URL / localhost:4000).
   */
  notifyGateway?: boolean;
  /** Request origin used to build the absolute webhook URL. */
  origin?: string | null;
}

/**
 * Insert a task, log the creation event, run persona selection (non-fatal),
 * broadcast over SSE, and (optionally) notify the OpenClaw gateway.
 *
 * Returns { task, deduped } — `deduped:true` when a matching task already
 * existed (either via idempotency_key or the title+workspace window check) and
 * no new row was written.
 */
export async function createTaskCore(
  input: CreateTaskCoreInput,
  options: CreateTaskCoreOptions = {}
): Promise<CreateTaskCoreResult | undefined> {
  // ── DEDUP LAYER 1: idempotency_key ────────────────────────────────────────
  // Check for a prior task_created event carrying the [ingest:<key>] marker.
  if (input.idempotency_key) {
    // Escape LIKE metacharacters (% and _) — and the escape character itself (\)
    // — so an idempotency_key that contains them cannot false-match unrelated
    // events.  The outer %…% wildcards are intentional and must NOT be escaped.
    const escapedKey = input.idempotency_key
      .replace(/\\/g, '\\\\')
      .replace(/%/g, '\\%')
      .replace(/_/g, '\\_');
    const existing = queryOne<{ task_id: string }>(
      "SELECT task_id FROM events WHERE type = 'task_created' AND message LIKE ? ESCAPE '\\' AND task_id IS NOT NULL ORDER BY created_at ASC LIMIT 1",
      [`%[ingest:${escapedKey}]%`],
    );
    if (existing?.task_id) {
      const priorTask = queryOne<Task>(
        `SELECT t.*,
            aa.name  as assigned_agent_name,
            aa.avatar_emoji as assigned_agent_emoji,
            ca.name  as created_by_agent_name,
            ca.avatar_emoji as created_by_agent_emoji
         FROM tasks t
         LEFT JOIN agents aa ON t.assigned_agent_id  = aa.id
         LEFT JOIN agents ca ON t.created_by_agent_id = ca.id
         WHERE t.id = ?`,
        [existing.task_id],
      );
      if (priorTask) {
        return { task: priorTask, deduped: true };
      }
    }
  }

  // ── DEDUP LAYER 2: title + workspace window ────────────────────────────────
  // Applies to BOTH ingest and UI create paths unless the caller explicitly
  // opts out (skipWindowDedup:true for deliberate repeated creates).
  if (!input.skipWindowDedup) {
    const duplicate = findDuplicateByTitleWindow(
      input.title,
      input.workspace_id,
    );
    if (duplicate) {
      return { task: duplicate, deduped: true };
    }
  }

  const id = uuidv4();
  const now = new Date().toISOString();

  // Derive workspace_id from the canonical department slug when not explicitly
  // supplied, instead of falling back to 'default' (which has no row in the
  // workspaces table and causes a FK crash).  The canonical department slug IS
  // the workspace id by convention (seed-workspaces + add-department.sh both
  // use the slug as the workspace primary key).  If neither is available, we
  // leave workspace_id NULL rather than inserting a nonexistent 'default' row.
  //
  // PRD 1.5: workspaceSlug tracks the canonical slug of the resolved workspace
  // so the persona selector always receives the slug (e.g. "marketing"), never
  // a UUID.  UI-created workspaces have a UUID primary key; passing that UUID
  // as --department caused the Python script's dept dir lookup, KPI layer,
  // stickiness keys, and persona_selection_log.department_id to all key on
  // garbage.
  let workspaceId: string | null = input.workspace_id || null;
  let workspaceSlug: string | null = null;

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getDb: _getDb } = require('@/lib/db');
  const _db = _getDb();

  if (workspaceId) {
    // workspaceId was supplied by the caller (UI path: a UUID for UI-created
    // workspaces, or already a slug for seed-created ones).  Resolve the slug
    // so the persona selector gets the canonical department name.
    try {
      const ws = _db.prepare('SELECT id, slug FROM workspaces WHERE id = ?').get(workspaceId) as { id: string; slug: string } | undefined;
      if (ws) workspaceSlug = ws.slug;
    } catch {
      // non-fatal — workspaceSlug stays null; selector falls back to 'general'
    }
  }

  if (!workspaceId && input.department) {
    const canon = canonicalDeptSlug(input.department);
    if (canon) {
      // Verify the workspace exists before stamping it; also capture the slug
      // for the persona selector (PRD 1.5).
      try {
        const ws = _db.prepare('SELECT id, slug FROM workspaces WHERE id = ? OR slug = ?').get(canon, canon) as { id: string; slug: string } | undefined;
        if (ws) {
          workspaceId = ws.id;
          workspaceSlug = ws.slug;
        }
      } catch {
        // non-fatal — leave workspaceId null
      }
    }
  }
  const status = input.status || 'backlog';

  // Auto-suggest SOP if none provided. Scored by department + keyword overlap;
  // anything below 0.5 leaves sop_id NULL so the operator picks manually.
  let sopId: string | null = input.sop_id ?? null;
  if (!sopId) {
    try {
      const best = await getBestSOPForTask({
        title: input.title,
        description: input.description ?? undefined,
        department: input.department ?? undefined,
        workspace_id: workspaceId,
      });
      if (best) sopId = best.id;
    } catch (err) {
      console.warn('[createTaskCore] SOP auto-suggest failed (non-fatal):', err);
    }
  }

  run(
    `INSERT INTO tasks (id, title, description, status, priority, assigned_agent_id, created_by_agent_id, workspace_id, business_id, department, due_date, sop_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.title,
      input.description || null,
      status,
      input.priority || 'medium',
      input.assigned_agent_id || null,
      input.created_by_agent_id || null,
      workspaceId,   // NULL when no valid workspace found — avoids FK crash on 'default'
      input.business_id || null,
      input.department ? canonicalDeptSlug(input.department) : null,
      input.due_date || null,
      sopId,
      now,
      now,
    ]
  );

  // --- INSTANT IN-PROCESS ROUTING (B4 / B8) ---
  // If no agent was explicitly assigned (UI quick-add, or any inbound
  // Telegram/Discord/Slack task via /api/tasks/ingest which always lands
  // unassigned), route by CONTENT the moment the task is created instead of
  // dumping it unassigned in the CEO/workspace backlog.
  //
  // routeTask() is an async in-process function — it adds minimal latency only
  // when OPENAI_API_KEY is configured (embedding call). Falls back to sync
  // keyword scoring when no key is set. Supersedes the broken
  // `/api/webhooks/task-created` HTTP-to-gateway notify (which targeted a WS
  // URL with an HTTP shape and silently no-op'd).
  //
  // Safe-fallback chain (all inside comDispatch): explicit department tag →
  // keyword score → least-loaded role-fit agent → least-loaded master/CEO
  // agent. If routeTask returns null (no agents seeded yet), we leave the task
  // unassigned in backlog — the correct human-review fallback, identical to the
  // prior ingest behavior. The CEO is thus a dispatcher, not a dumping ground:
  // a task only stays on the CEO when it genuinely scores to a master agent.
  let resolvedAgentId: string | null = input.assigned_agent_id || null;
  let routedDepartment: string | null = input.department || null;
  let routedReason: string | null = null;
  if (!resolvedAgentId) {
    try {
      // Pass workspace_id: null so routeTask considers agents across ALL
      // departments, not just the workspace the task happened to land in. This
      // is what lets a CEO/default-landed inbound task get delegated DOWN to
      // the right department (B8) instead of staying stuck on the CEO. The
      // winning department is stamped back onto the task below.
      const routing = await routeTask({
        title: input.title,
        description: input.description ?? '',
        priority: (input.priority as TaskPriority) || 'medium',
        workspace_id: null,
        department: input.department ?? undefined,
      });
      if (routing) {
        resolvedAgentId = routing.agentId;
        routedDepartment = routing.department || routedDepartment;
        routedReason = routing.reason;
        run(
          `UPDATE tasks SET assigned_agent_id = ?, department = ?, updated_at = ? WHERE id = ?`,
          [resolvedAgentId, routedDepartment, now, id]
        );
        // Surface the routing decision so an operator can see why a task moved
        // (comDispatch already produces a human-readable reason string).
        run(
          `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [uuidv4(), 'task_dispatched', resolvedAgentId, id, `Auto-routed: ${routedReason}`, now]
        );
      }
    } catch (routeErr) {
      // Never fail task creation on a routing error — the task simply stays
      // unassigned in backlog for manual triage.
      console.warn('[createTaskCore] In-process routing failed (non-fatal):', routeErr);
    }
  }
  // --- END INSTANT ROUTING ---

  // --- CAMPAIGN BOARD FEED (W8.4) ---
  // Attach the new card to its department's live campaign board so routed work
  // actually shows + advances on the Kanban (the board had 0 rows / campaign_id
  // NULL on every task before this). Idempotent + best-effort; does NOT bump
  // updated_at, so the dispatcher's grace/backoff windows are untouched.
  ensureCampaignForTask(id, {
    workspaceId: workspaceId,
    department: routedDepartment || input.department || null,
    title: input.title,
  });
  // --- END CAMPAIGN BOARD FEED ---

  // --- PERSONA PIN KICK-OFF (G10-TRIAD-PERSONA-RESOLVE) ---
  // Start persona resolution NOW (concurrently with the rest of createTaskCore) so
  // the pin can land in tasks.persona_id BEFORE auto-dispatch reads it. Retry-backed
  // + bounded inside resolvePersonaAndPin (no cron, no self-resurrect, no furnace).
  // PRD 1.5: pass the canonical workspace slug, never the raw UUID.
  const personaTaskDescription =
    `${input.title}${input.description ? `. ${input.description}` : ''}`.trim();
  const personaDepartment =
    canonicalDeptSlug(workspaceSlug) ||
    (input.department ? canonicalDeptSlug(input.department) : null) ||
    'general';
  const personaPinPromise = resolvePersonaAndPin(id, personaTaskDescription, personaDepartment);
  // Swallow at the source so a background failure never becomes an unhandled
  // rejection — resolvePersonaAndPin logs internally and never throws to callers.
  void personaPinPromise.catch(() => null);

  // --- AUTO-DISPATCH (v4.14.0) ---
  // If routing assigned a non-master specialist, fire the OpenClaw invocation
  // immediately so the specialist actually runs without a manual UI click.
  // Fire-and-forget: routing must not fail if OpenClaw is temporarily down.
  //
  // G10-TRIAD-PERSONA-RESOLVE: gate dispatch on the persona pin so the persona the
  // BOARD shows (tasks.persona_id) is the SAME one the dispatcher sends — the
  // dispatcher's resolveAndLog reads tasks.persona_id at send time, so the pin MUST
  // land first or the runtime falls back to 'auto' self-select (board chip != runtime
  // persona, Cause A). Bounded: if the pin doesn't land within the budget, dispatch
  // proceeds (degraded to 'auto') and the retry promise still lands + re-broadcasts
  // the pin afterwards. The await lives inside a detached task so the API still
  // responds immediately (dispatch was already fire-and-forget).
  if (resolvedAgentId) {
    void (async () => {
      await Promise.race([
        personaPinPromise.catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), PERSONA_PIN_DISPATCH_BUDGET_MS)),
      ]);
      await autoDispatchTask(id, 'createTaskCore');
    })();
  }
  // --- END AUTO-DISPATCH ---

  // Log event. Caller may supply an explicit message (the ingest path embeds
  // its idempotency/provenance marker here).
  let eventMessage = input.eventMessage ?? `New task: ${input.title}`;
  if (!input.eventMessage && input.created_by_agent_id) {
    const creator = queryOne<Agent>('SELECT name FROM agents WHERE id = ?', [input.created_by_agent_id]);
    if (creator) {
      eventMessage = `${creator.name} created task: ${input.title}`;
    }
  }

  run(
    `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [uuidv4(), 'task_created', input.created_by_agent_id || null, id, eventMessage, now]
  );

  // Fetch created task with all joined fields BEFORE persona selection so we can
  // broadcast task_created immediately and return < 500ms (PRD 1.6).
  const task = queryOne<Task>(
    `SELECT t.*,
      aa.name as assigned_agent_name,
      aa.avatar_emoji as assigned_agent_emoji,
      ca.name as created_by_agent_name,
      ca.avatar_emoji as created_by_agent_emoji
     FROM tasks t
     LEFT JOIN agents aa ON t.assigned_agent_id = aa.id
     LEFT JOIN agents ca ON t.created_by_agent_id = ca.id
     WHERE t.id = ?`,
    [id]
  );

  if (!task) return undefined;

  // Broadcast task creation via SSE immediately — the card appears on the board
  // without waiting for persona selection (which can take several seconds).
  broadcast({
    type: 'task_created',
    payload: task,
  });

  // Notify the OpenClaw gateway asynchronously — don't block.
  // NOTE (B4): routing now happens IN-PROCESS above via routeTask(), so this
  // outbound notify is no longer the routing mechanism (the old
  // /api/webhooks/task-created HTTP-to-WS-gateway call was a silent no-op). It
  // is retained only as a best-effort "a task exists" announcement and is fully
  // non-fatal; routing does not depend on it.
  if (options.notifyGateway !== false) {
    const origin =
      options.origin || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:4000';
    const webhookUrl = `${origin}/api/webhooks/task-created`;
    (async () => {
      try {
        const webhookResponse = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskId: task.id,
            title: task.title,
            description: task.description,
            department: task.department,
            priority: task.priority,
            workspaceId: task.workspace_id,
          }),
        });
        if (!webhookResponse.ok) {
          console.error('[createTaskCore] Webhook notification failed:', await webhookResponse.text());
        }
      } catch (webhookError) {
        // Log but never fail the task creation.
        console.error('[createTaskCore] Failed to trigger webhook:', webhookError);
      }
    })();
  }

  // ── ASYNC PERSONA SELECTION (PRD 1.6 / G10-TRIAD-PERSONA-RESOLVE) ─────────────
  // Persona selection + pin + task_updated SSE re-broadcast are owned by
  // resolvePersonaAndPin(), kicked off above as `personaPinPromise` (BEFORE the
  // auto-dispatch gate so board persona == runtime persona). For the no-dispatch
  // path it completes in the background; for the dispatch path the gate already
  // awaited it (bounded). The task row was inserted + broadcast (task_created)
  // above, so the persona chip lands via a follow-up task_updated event. Nothing
  // further to do here — the promise is already running and its rejection is
  // swallowed at the source.

  return { task, deduped: false };
}
