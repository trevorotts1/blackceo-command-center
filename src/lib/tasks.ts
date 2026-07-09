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
import {
  selectPersonaForTask,
  selectPersonaPlanForTask,
  loadSubtaskPersonas,
  broadcastPersonaPlan,
  persistPersonaBundle,
  DEFAULT_PERSONA_FALLBACK,
  GOVERNANCE_PERSONA_FALLBACK,
  type SubtaskPersona,
  type SopSelectorContext,
} from '@/lib/persona-selector';
import { getBestSOPForTask, getPersonaSlots, type PersonaSlot, type SOP } from '@/lib/sops';
import { routeTask } from '@/lib/routing/department-router';
import { canonicalDeptSlug } from '@/lib/routing/canonical-slug';
import { autoDispatchTask } from '@/lib/task-dispatcher';
import { ensureCampaignForTask } from '@/lib/campaigns';
import { notifySystem } from '@/lib/notify';
import type { Task, TaskPriority, Agent, PersonaBundle, TaskPersonaBundleRow } from '@/lib/types';

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
//
// F3.1 / FDN-2: the per-spawn timeout is 60s (PERSONA_SELECT_TIMEOUT_MS) and the
// policy is "1 retry after 5s" — one real attempt, a 5s cool-off, then one retry
// (2 spawns total) before the deterministic TS fallback chain engages. A
// slow-but-valid selection now has 60s to land; a genuinely broken selector fails
// over in bounded time instead of hammering the box. The retry is off the hot
// path — autoDispatchTask only waits PERSONA_PIN_DISPATCH_BUDGET_MS and the
// dispatch gate heals anything still naked, so the 5s cool-off never stalls a board.
export const PERSONA_PIN_MAX_ATTEMPTS = 2;
// 5s cool-off before the single retry (backoff = BASE * attempt; attempt 1 → 5s).
export const PERSONA_PIN_RETRY_BASE_MS = 5000;
// Max time auto-dispatch waits for the pin before proceeding (degraded to 'auto').
// The retry promise still lands the pin + re-broadcasts after dispatch if it times out.
export const PERSONA_PIN_DISPATCH_BUDGET_MS = 8000;
// Dispatch-time SOP rescore (F3.4) is a single bounded, heuristic-mode spawn so
// dispatch stays responsive — no retry loop, tighter than the creation timeout.
export const PERSONA_RESCORE_TIMEOUT_MS = 10000;

// ─── DEFAULT-PERSONA FALLBACK CHAIN (POINT 10 fix 1 / F3.1 FDN-2) ────────────
// The founder's board invariant: EVERY task carries a persona. Historically,
// resolvePersonaAndPin() left a task personaless after PERSONA_PIN_MAX_ATTEMPTS
// failed selector spawns, so a card could sit in backlog with no persona chip
// until it was moved (the Triad gate auto-resolved on the first move). On a box
// whose selector is degraded, that is a silent, board-wide gap. On exhaustion we
// now pin a DETERMINISTIC default persona and flag it `persona_fallback=1` for
// audit. `no_persona_required` (intentional) is handled earlier and stays
// personaless (but carries a governance oversight pointer).
//
// The TS-side fallback chain (resolved Q2 decision), in order:
//   1. last department persona_assignment  (per-department sticky "lead")
//   2. company-config.json `default_persona_id`  (per-client override)
//   3. DEFAULT_PERSONA_FALLBACK constant ('blackceo-house-voice')
// Tier 3 is a REAL, embedded fleet persona (triad 81->82) — deliberately generic
// so it never out-scores a specialist, and it exists in the library so the doer's
// Section-4 load at dispatch always resolves. It replaces the old synthetic
// `dept-default-<slug>` id, which pointed at a blueprint that did not exist.

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
  source: 'department-sticky' | 'company-default' | 'house-voice-constant';
}

/**
 * Read the per-client persona-override fields from config/company-config.json.
 * Additive + non-breaking: any missing file / field / parse error degrades to
 * nulls (the constant tiers then apply). Never throws.
 *
 * Resolution mirrors persona-selector.ts:resolveCompanyConfigHint — explicit
 * OPENCLAW_COMPANY_CONFIG env override, else <cwd>/config/company-config.json.
 */
export function readCompanyConfigPersonaDefaults(): {
  default_persona_id: string | null;
  governance_persona_id: string | null;
} {
  const empty = { default_persona_id: null, governance_persona_id: null };
  try {
    const explicit = process.env.OPENCLAW_COMPANY_CONFIG;
    const configPath =
      explicit && fs.existsSync(explicit)
        ? explicit
        : path.join(process.cwd(), 'config', 'company-config.json');
    if (!fs.existsSync(configPath)) return empty;
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      default_persona_id?: unknown;
      governance_persona_id?: unknown;
    };
    const norm = (v: unknown): string | null =>
      typeof v === 'string' && v.trim() ? v.trim() : null;
    return {
      default_persona_id: norm(parsed.default_persona_id),
      governance_persona_id: norm(parsed.governance_persona_id),
    };
  } catch {
    return empty;
  }
}

/**
 * Resolve the governance oversight pointer for a mechanical (no_persona_required)
 * task (Q1): company-config.json `governance_persona_id` else the pinned
 * GOVERNANCE_PERSONA_FALLBACK constant. Always non-null — a mechanical task is
 * never "naked" of oversight even though it carries no full coaching persona.
 */
export function resolveGovernancePersonaId(): string {
  return readCompanyConfigPersonaDefaults().governance_persona_id || GOVERNANCE_PERSONA_FALLBACK;
}

/**
 * Derive a deterministic default persona for the exhaustion / dispatch-heal path,
 * walking the resolved Q2 fallback chain.
 *
 * Tier 1 — the department's current sticky "lead" persona from
 *   `persona_assignment` (the genuine, selector-recorded stickiness state per
 *   department/category). The most-recently-assigned, highest-switch row is the
 *   closest thing the board has to a department-head persona. This table is
 *   written ONLY by the real selector — never by this fallback path — so it can
 *   never feed on itself.
 * Tier 2 — the per-client `default_persona_id` from company-config.json, so an
 *   operator can pin a client-chosen house default without a code change.
 * Tier 3 — DEFAULT_PERSONA_FALLBACK ('blackceo-house-voice'): a real, embedded,
 *   brand-neutral fleet persona. Deterministic and always available, so a
 *   brand-new department with zero history still gets a loadable persona and the
 *   board invariant holds.
 *
 * Never throws for a caller: any DB/config error degrades to the Tier-3 constant.
 */
export function deriveDepartmentDefaultPersona(
  department: string | null | undefined,
): DepartmentDefaultPersona {
  const canon = canonicalDeptSlug(department || '') || 'general-task';

  // Tier 1 — department sticky lead.
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
    // persona_assignment absent (pre-migration-019) — fall through to config/constant.
  }

  // Tier 2 — per-client company-config override.
  const configured = readCompanyConfigPersonaDefaults().default_persona_id;
  if (configured && !SENTINEL_IDS.has(configured)) {
    return {
      persona_id: configured,
      persona_name: humanizeSlug(configured),
      persona_mode: 'leadership',
      source: 'company-default',
    };
  }

  // Tier 3 — pinned house-voice constant (always available, always loadable).
  return {
    persona_id: DEFAULT_PERSONA_FALLBACK,
    persona_name: humanizeSlug(DEFAULT_PERSONA_FALLBACK),
    persona_mode: 'leadership',
    source: 'house-voice-constant',
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

// ─── SOP-AWARE MATCHING (F3.4) ──────────────────────────────────────────────
// The persona match is only as good as the context it sees. Historically the
// selector saw task title+description only; the running SOP — which governs HOW
// the work is done and carries curated `persona_hints` — never informed the
// match (`sops.persona_hints` had five writers and zero readers). These helpers
// translate an SOP row into the selector's SopSelectorContext (slug + name +
// parsed persona_hints) so createTaskCore can pass it AT creation and the
// dispatcher can re-score when a DIFFERENT SOP resolves at dispatch time.

/** Minimal SOP shape needed to build selector context. */
type SopContextRow = Pick<SOP, 'slug' | 'name' | 'persona_hints'>;

/**
 * Parse an SOP's `persona_hints` JSON (a string[] of canonical persona slugs)
 * defensively — never throws. Drops empties and known sentinel ids so a stale /
 * malformed hint list can never poison the candidate pool.
 */
export function parsePersonaHints(raw: string | null | undefined): string[] {
  if (!raw || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((h) => (typeof h === 'string' ? h.trim() : ''))
      .filter((h) => h.length > 0 && !SENTINEL_IDS.has(h));
  } catch {
    return [];
  }
}

/** Build the selector SOP context from an SOP row (undefined when it carries nothing usable). */
export function sopSelectorContextFromRow(
  sop: SopContextRow | null | undefined,
): SopSelectorContext | undefined {
  if (!sop) return undefined;
  const hints = parsePersonaHints(sop.persona_hints);
  const slug = sop.slug ?? null;
  const name = sop.name ?? null;
  if (!slug && !name && hints.length === 0) return undefined;
  return { slug, name, hints };
}

/** Load an SOP's selector context by id (used at the dispatch-time rescore). */
export function loadSopSelectorContextById(
  sopId: string | null | undefined,
): SopSelectorContext | undefined {
  if (!sopId) return undefined;
  try {
    const row = queryOne<SopContextRow>(
      `SELECT slug, name, persona_hints FROM sops WHERE id = ? AND deleted_at IS NULL`,
      [sopId],
    );
    return sopSelectorContextFromRow(row);
  } catch {
    return undefined;
  }
}

/**
 * Select a persona for a task, persist it (tasks.persona_*), and re-broadcast the
 * updated task over SSE so the board chip lands. Retry-backed and bounded.
 *
 * @param sopContext Optional SOP context (F3.4) folded into the match at creation.
 * @returns the pinned persona_id (a matched persona OR, on selector exhaustion, a
 *          deterministic department-default flagged persona_fallback=true), or null
 *          ONLY when the selector explicitly returned no_persona_required.
 */
export async function resolvePersonaAndPin(
  taskId: string,
  taskDescription: string,
  departmentForSelector: string,
  sopContext?: SopSelectorContext,
): Promise<string | null> {
  for (let attempt = 1; attempt <= PERSONA_PIN_MAX_ATTEMPTS; attempt++) {
    try {
      const persona = await selectPersonaForTask(taskId, taskDescription, departmentForSelector, sopContext);

      // PRD 3.4 SENTINEL GUARD: loudly flag bad ids from a stale selector install.
      if (persona && persona.persona_id && SENTINEL_IDS.has(persona.persona_id)) {
        console.warn(
          `[resolvePersonaAndPin] ⚠️  STALE INSTALL: selector returned sentinel id ` +
          `"${persona.persona_id}" (skill ${getInstalledSkillVersion()}, task_id=${taskId}). ` +
          `Update onboarding skills on this box.`,
        );
      }

      // Explicit "no persona required" is terminal — not a failure, do not retry.
      // The task stays personaless BY DESIGN (a chmod does not need coaching), but
      // it is never "naked" of oversight: we record the governance pointer (Q1) —
      // company-config.governance_persona_id else GOVERNANCE_PERSONA_FALLBACK — as a
      // queryable audit event the dispatcher reads as a light oversight pointer.
      if (persona && persona.no_persona_required) {
        try {
          const governanceId =
            (persona.governance_persona_id && persona.governance_persona_id.trim())
              ? persona.governance_persona_id.trim()
              : resolveGovernancePersonaId();
          run(
            `INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, ?, ?, ?, ?)`,
            [
              uuidv4(),
              'persona_governance',
              taskId,
              `[PERSONA-GOVERNANCE] no_persona_required task — governance oversight pointer "${governanceId}" ` +
                `(no full persona load). persona_id stays NULL by design.`,
              new Date().toISOString(),
            ],
          );
        } catch {
          /* audit-only — never block the no-persona-required path */
        }
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
        // PERSONA-BLEND: when the matcher emitted a bundle SUPERSET, persist it
        // (task_persona_bundle row + mirror columns) so the dispatcher can render
        // the blend directive and gate the write on audience confirmation. NULL
        // bundle (legacy/non-content result) → no-op, no behaviour change.
        if (persona.bundle) {
          try {
            persistPersonaBundle(taskId, persona.bundle);
          } catch (bundleErr) {
            console.warn(`[resolvePersonaAndPin] bundle persist non-fatal for task ${taskId}:`, (bundleErr as Error).message);
          }
        }

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

// ─── MULTI-PERSONA DECOMPOSITION DECISION (DEP-5 / F3.7 + F3.9) ──────────────
// createTaskCore decides single-persona vs `--combined` decomposition. It runs
// combined selection when EITHER:
//   (i)  the resolved SOP declares >1 `persona_slot` (F3.9 — authoritative), OR
//   (ii) a cheap, FREE heuristic decomposition probe yields >1 sub-task AND the
//        task is non-mechanical (F3.7).
// The probe is a faithful TS mirror of decompose-task.py's `heuristic_decompose`
// (pure regex, no LLM, no subprocess) so the DECISION costs nothing; the real
// (LLM-allowed) decomposition only runs once combined mode is chosen.

/** Hard cap on sub-tasks — mirrors decompose-task.py DECOMP_MAX_SUBTASKS. */
export const DECOMP_MAX_SUBTASKS = 6;

// Mirror of decompose-task.py `_ACTION_VERBS` (coordination-split gate).
const _ACTION_VERBS = [
  'write', 'create', 'build', 'design', 'draft', 'compose', 'produce',
  'send', 'schedule', 'publish', 'post', 'edit', 'research', 'analyze',
  'plan', 'structure', 'set up', 'configure', 'review', 'format', 'generate',
  'map', 'outline', 'sketch', 'record', 'compile', 'summarize', 'sequence',
];

// Mirror of decompose-task.py `_SEQ_SPLIT_RE` (sequence markers / lists).
const _SEQ_SPLIT_RE =
  /(?:\b(?:then|after that|afterwards|next|followed by|and then|finally|once that(?:'s| is) done)\b|;|→|->|\n\s*[-*•]\s+|\n\s*\d+[.)]\s+)/gi;

function _stripEnds(s: string): string {
  return s.replace(/^[\s\t,.;]+/, '').replace(/[\s\t,.;]+$/, '');
}

/** Mirror of `_split_on_for_sections`: "…for the X, …for the Y" → 2 parts. */
function _splitOnForSections(chunk: string): string[] {
  const cues = chunk.match(/\bfor the\b/gi);
  if (!cues || cues.length < 2) return [chunk];
  const parts = chunk
    .split(/\s*,\s*(?=(?:a |an |another |the )?[\w\- ]{0,40}?\bfor the\b)/i)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length >= 2 ? parts : [chunk];
}

/** Mirror of `_coordination_split`: split "X and Y" only when both are actions. */
function _coordinationSplit(chunk: string): string[] {
  const pieces = chunk.split(/\s+\band\b\s+/i);
  if (pieces.length < 2) return [chunk];
  const out: string[] = [];
  let buf = pieces[0];
  for (const nxt of pieces.slice(1)) {
    const nxtL = nxt.toLowerCase().replace(/^\s+/, '');
    const startsAction = _ACTION_VERBS.some((v) => nxtL.startsWith(v));
    const bufL = buf.toLowerCase();
    const bufHasAction = _ACTION_VERBS.some((v) =>
      new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(bufL),
    );
    if (startsAction && bufHasAction) {
      out.push(buf.trim());
      buf = nxt;
    } else {
      buf = `${buf} and ${nxt}`;
    }
  }
  out.push(buf.trim());
  return out.filter(Boolean);
}

/**
 * Faithful TS mirror of decompose-task.py `heuristic_decompose` — returns the
 * ordered list of raw sub-task strings. Single-part → 1 element (no regression).
 * Deterministic, pure-regex, FREE (no LLM). Exported for the contract test.
 */
export function heuristicDecompose(text: string, maxSubtasks = DECOMP_MAX_SUBTASKS): string[] {
  const raw = (text || '').trim();
  if (!raw) return [];
  let chunks = raw
    .split(_SEQ_SPLIT_RE)
    .map((c) => (c ? _stripEnds(c) : ''))
    .filter((c) => c && c.length > 0);
  if (chunks.length === 0) chunks = [raw];

  const expanded: string[] = [];
  for (const ch of chunks) {
    for (const seg of _splitOnForSections(ch)) {
      expanded.push(..._coordinationSplit(seg));
    }
  }

  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const s of expanded) {
    let s2 = _stripEnds(s);
    s2 = s2.replace(/^\s*(?:and|then|next|also)\b\s+/i, '');
    s2 = s2.replace(/\s*[,;]?\s*(?:and|then)\s*$/i, '');
    s2 = _stripEnds(s2);
    const key = s2.toLowerCase();
    if (s2.length >= 3 && !seen.has(key)) {
      seen.add(key);
      ordered.push(s2);
    }
  }
  const final = ordered.length > 0 ? ordered : [raw];
  return final.slice(0, maxSubtasks);
}

/** Cheap sub-task count for the single-vs-combined decision (never throws). */
export function heuristicSubtaskCount(text: string, maxSubtasks = DECOMP_MAX_SUBTASKS): number {
  try {
    return heuristicDecompose(text, maxSubtasks).length;
  } catch {
    return 1;
  }
}

// Mirror of decompose-task.py `_is_mechanical` — a send/deploy/plumbing task is
// persona-free by design; it must NOT trigger multi-persona decomposition.
const _MECH_MULTIWORD = ['check disk', 'check memory'];
const _MECH_SINGLEWORD = ['restart', 'reboot', 'ping', 'ls', 'chmod', 'chown'];
const _MECH_DELIVERY = [
  'send it', 'send the', 'schedule the send', 'deploy', 'publish to',
  'push to', 'upload', 'queue the', 'sequence the send', 'blast',
];

/** Whether a task is mechanical/operational (mirror of the selector's gate). */
export function isMechanicalTask(text: string): boolean {
  const t = (text || '').toLowerCase();
  if (_MECH_MULTIWORD.some((m) => t.includes(m))) return true;
  if (_MECH_SINGLEWORD.some((m) => new RegExp(`\\b${m}\\b`).test(t))) return true;
  if (_MECH_DELIVERY.some((m) => t.includes(m))) return true;
  return false;
}

/**
 * Decide whether a task should run multi-persona decomposition, and gather the
 * SOP-declared slots. Pure + free (no subprocess). Exported for the contract test.
 */
export function decideMultiPersona(
  taskText: string,
  slots: PersonaSlot[],
): { combined: boolean; reason: string } {
  if (slots.length > 1) {
    return { combined: true, reason: `sop-slots(${slots.length})` };
  }
  if (isMechanicalTask(taskText)) {
    return { combined: false, reason: 'mechanical' };
  }
  const count = heuristicSubtaskCount(taskText);
  if (count > 1) {
    return { combined: true, reason: `heuristic-subtasks(${count})` };
  }
  return { combined: false, reason: 'single' };
}

/** Load the persona slots declared by a task's resolved SOP (never throws). */
function loadSopPersonaSlots(sopId: string | null): PersonaSlot[] {
  if (!sopId) return [];
  try {
    const row = queryOne<{ steps: string | null }>('SELECT steps FROM sops WHERE id = ?', [sopId]);
    return row ? getPersonaSlots(row.steps) : [];
  } catch {
    return [];
  }
}

/**
 * Run multi-persona decomposition for a task, persist the primary (seq-1) persona
 * onto `tasks.persona_*` for back-compat, enforce the FDN-1 fallback guarantee on
 * every REQUIRED slot, and broadcast the plan over SSE.
 *
 * Never leaves a task naked: on decomposition failure / empty plan it falls back
 * to single-persona `resolvePersonaAndPin` (which itself has the exhaustion
 * fallback). Returns the pinned primary persona id, or null only when the plan is
 * genuinely all-mechanical AND single selection returns `no_persona_required`.
 */
export async function resolvePersonaPlanAndPin(
  taskId: string,
  taskDescription: string,
  departmentForSelector: string,
  slots: PersonaSlot[],
): Promise<string | null> {
  let plan;
  try {
    plan = await selectPersonaPlanForTask(taskId, taskDescription, departmentForSelector, { slots });
  } catch (err) {
    console.error(`[resolvePersonaPlanAndPin] decomposition threw for task ${taskId}:`, err);
    plan = null;
  }

  // No usable plan (or only a single sub-task) → single-persona path. This keeps
  // the never-naked invariant intact through the existing exhaustion fallback.
  if (!plan || plan.subtask_personas.length < 2) {
    console.log(
      `[resolvePersonaPlanAndPin] task ${taskId}: decomposition yielded ` +
      `${plan ? plan.subtask_personas.length : 0} sub-task(s) — using single-persona selection`,
    );
    return resolvePersonaAndPin(taskId, taskDescription, departmentForSelector);
  }

  // FDN-1 REQUIRED-SLOT GUARANTEE: a REQUIRED slot may never be empty. When a
  // slot was declared required (slots[i]) but its sub-task came back persona-less
  // (no persona available — NOT a mechanical step), backfill the dept-default so
  // the required slot always carries a persona.
  try {
    enforceRequiredSlots(taskId, plan.subtask_personas, slots, departmentForSelector);
  } catch (err) {
    console.error(`[resolvePersonaPlanAndPin] required-slot enforcement failed for task ${taskId}:`, err);
  }

  // Pin the PRIMARY (seq-1) persona onto tasks.persona_* for back-compat. If the
  // seq-1 sub-task is mechanical / persona-less, fall to the first sub-task that
  // DID resolve a persona; if none, the dept-default exhaustion fallback ensures
  // the board invariant (every task carries a persona) still holds.
  const rows = loadSubtaskPersonas(taskId);
  const source = rows.length > 0 ? rows : plan.subtask_personas;
  const primary =
    source.find((s) => s.seq === 1 && s.persona_id && !SENTINEL_IDS.has(s.persona_id)) ||
    source.find((s) => s.persona_id && !SENTINEL_IDS.has(s.persona_id!));

  if (primary && primary.persona_id) {
    const personaSelectedAt = new Date().toISOString();
    run(
      `UPDATE tasks
          SET persona_id = ?, persona_name = ?, persona_mode = ?,
              persona_score = ?, persona_version = ?, persona_selected_at = ?
        WHERE id = ?`,
      [
        primary.persona_id,
        primary.persona_name || humanizeSlug(primary.persona_id),
        'leadership',
        primary.score ?? null,
        1,
        personaSelectedAt,
        taskId,
      ],
    );
    broadcastPersonaPlan(taskId);
    console.log(
      `[resolvePersonaPlanAndPin] task ${taskId}: pinned primary "${primary.persona_id}" ` +
      `(seq ${primary.seq}); ${plan.distinct_persona_count} distinct persona(s) across ` +
      `${plan.subtask_count} sub-tasks.`,
    );
    return primary.persona_id;
  }

  // Every sub-task was mechanical / persona-less. Broadcast the plan (so the card
  // shows the mechanical sub-tasks) then fall back to single selection for the
  // primary field — which handles no_persona_required + the exhaustion fallback.
  broadcastPersonaPlan(taskId);
  console.log(`[resolvePersonaPlanAndPin] task ${taskId}: plan had no non-mechanical persona — single-persona fallback for primary`);
  return resolvePersonaAndPin(taskId, taskDescription, departmentForSelector);
}

/**
 * FDN-1 guarantee for REQUIRED slots: patch any required slot whose sub-task came
 * back persona-less with the deterministic dept-default persona (never empty).
 * Correlates slots to plan rows by order (slot[i] ↔ seq i+1, the contract when
 * slots drive decomposition). Best-effort; logs a per-task audit event.
 */
function enforceRequiredSlots(
  taskId: string,
  subtaskPersonas: SubtaskPersona[],
  slots: PersonaSlot[],
  department: string,
): void {
  if (slots.length === 0) return;
  const rows = loadSubtaskPersonas(taskId);
  const bySeq = new Map(rows.map((r) => [r.seq, r]));
  const fallback = deriveDepartmentDefaultPersona(department);
  const now = new Date().toISOString();

  slots.forEach((slot, i) => {
    if (!slot.required) return;
    const seq = i + 1;
    const row = bySeq.get(seq) ?? subtaskPersonas.find((s) => s.seq === seq);
    // A resolved persona (from decompose) needs nothing. Only a persona-LESS
    // required slot (no persona available) is backfilled.
    if (!row || (row.persona_id && !SENTINEL_IDS.has(row.persona_id))) return;

    try {
      run(
        `UPDATE task_subtask_persona
            SET persona_id = ?, persona_name = ?
          WHERE task_id = ? AND seq = ?`,
        [fallback.persona_id, fallback.persona_name, taskId, seq],
      );
      run(
        `INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, ?, ?, ?, ?)`,
        [
          uuidv4(),
          'persona_fallback',
          taskId,
          `[PERSONA-SLOT-FALLBACK] Required slot "${slot.slot}" (seq ${seq}) came back empty — ` +
            `pinned ${fallback.source} department-default persona "${fallback.persona_id}".`,
          now,
        ],
      );
    } catch (err) {
      console.error(`[enforceRequiredSlots] backfill failed for task ${taskId} slot "${slot.slot}":`, err);
    }
  });
}

// ─── F3.4 DISPATCH-TIME SOP RESCORE (DEP-2) ─────────────────────────────────

export interface RescoreResult {
  /** True when the rescore landed a DIFFERENT persona than the task already carried. */
  changed: boolean;
  persona_id: string | null;
  persona_name: string | null;
  persona_mode: string | null;
}

/**
 * Re-run persona selection WITH SOP context at dispatch time (F3.4).
 *
 * Called by the dispatcher when the SOP it resolves differs from the one the
 * creation-time selection saw (or selection saw none). Single-shot + bounded
 * (heuristic mode, PERSONA_RESCORE_TIMEOUT_MS) so dispatch stays responsive.
 *
 * FAIL-CLOSED: an empty / mechanical / sentinel selector result NEVER downgrades
 * a persona the task already carries — the existing pin is kept untouched. Only a
 * concrete, non-sentinel persona replaces the pin. Persists a queryable
 * `persona_rescored_at_dispatch` event and re-broadcasts the row. Never throws
 * (dispatch must proceed regardless).
 *
 * The persona currently on the row (for the never-downgrade guard + audit) is
 * read here, not passed in — the DB already knows it.
 *
 * @returns the persona now on the row (changed=false + the prior persona echoed
 *          back on any no-op).
 */
export async function rescorePersonaWithSOP(
  taskId: string,
  taskDescription: string,
  departmentForSelector: string,
  sopContext: SopSelectorContext,
): Promise<RescoreResult> {
  const prev = queryOne<{
    persona_id: string | null;
    persona_name: string | null;
    persona_mode: string | null;
  }>('SELECT persona_id, persona_name, persona_mode FROM tasks WHERE id = ?', [taskId]);
  const unchanged: RescoreResult = {
    changed: false,
    persona_id: prev?.persona_id ?? null,
    persona_name: prev?.persona_name ?? null,
    persona_mode: prev?.persona_mode ?? null,
  };
  try {
    const persona = await selectPersonaForTask(
      taskId,
      taskDescription,
      departmentForSelector,
      sopContext,
      { timeoutMs: PERSONA_RESCORE_TIMEOUT_MS },
    );

    // Never-downgrade: a null / mechanical / sentinel result keeps the current pin.
    if (
      !persona ||
      persona.no_persona_required ||
      !persona.persona_id ||
      SENTINEL_IDS.has(persona.persona_id)
    ) {
      return unchanged;
    }

    const changed = persona.persona_id !== (prev?.persona_id ?? null);
    const now = new Date().toISOString();

    run(
      `UPDATE tasks
          SET persona_id = ?, persona_name = ?, persona_mode = ?,
              persona_score = ?, persona_version = ?, persona_selected_at = ?
        WHERE id = ?`,
      [
        persona.persona_id,
        persona.persona_name,
        persona.interaction_mode,
        persona.score ?? null,
        persona.persona_version ?? 1,
        now,
        taskId,
      ],
    );

    const sopLabel = sopContext.slug || sopContext.name || 'sop';
    run(
      `INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, ?, ?, ?, ?)`,
      [
        uuidv4(),
        'persona_rescored_at_dispatch',
        taskId,
        `[PERSONA-RESCORE] SOP "${sopLabel}" resolved at dispatch differed from the SOP the ` +
          `creation-time selection saw — re-ran SOP-aware selection. persona ` +
          `${prev?.persona_id ?? '(none)'} → ${persona.persona_id}${changed ? '' : ' (unchanged)'}.`,
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
    if (updatedTask) broadcast({ type: 'task_updated', payload: updatedTask });

    console.log(
      `[rescorePersonaWithSOP] task ${taskId}: SOP "${sopLabel}" → persona ` +
        `${persona.persona_id}${changed ? ` (was ${prev?.persona_id ?? '(none)'})` : ' (unchanged)'}.`,
    );

    return {
      changed,
      persona_id: persona.persona_id,
      persona_name: persona.persona_name,
      persona_mode: persona.interaction_mode,
    };
  } catch (err) {
    console.warn(
      `[rescorePersonaWithSOP] non-fatal for task ${taskId}:`,
      (err as Error).message,
    );
    return unchanged;
  }
}

// ─── F3.1 / FDN-2 SYNCHRONOUS DISPATCH GATE ─────────────────────────────────

export interface DispatchPersonaResolution {
  persona_id: string;
  persona_name: string;
  persona_mode: string;
  /** true when the persona was applied by this gate (task was naked at dispatch). */
  healed: boolean;
}

/**
 * SYNCHRONOUS DISPATCH GATE (F3.1 / FDN-2) — the last-hop guarantee that no task
 * is dispatched naked. HEAL, NOT STALL: if a task reaches the dispatcher with no
 * pinned persona (a create-time selection that silently failed, or a pre-existing
 * backlog task), apply the DETERMINISTIC fallback chain immediately and pin it —
 * never HOLD the task for a persona (availability > purity; the fallback makes
 * NULL impossible anyway). It runs no Python (real selection already had its turn
 * at create-time with retries, and the persona-backfill sweep re-runs it in the
 * background) so it adds no latency to the hot dispatch path.
 *
 * Returns the persona the dispatcher must deliver:
 *   - the already-pinned persona when one exists (healed:false), or
 *   - a freshly pinned deterministic fallback (healed:true).
 * Never returns null — a persona is always resolvable via the constant tier.
 */
export function ensurePersonaForDispatch(
  taskId: string,
  departmentForSelector: string | null | undefined,
): DispatchPersonaResolution {
  // Already pinned? Deliver it unchanged.
  try {
    const row = queryOne<{ persona_id: string | null; persona_name: string | null; persona_mode: string | null }>(
      'SELECT persona_id, persona_name, persona_mode FROM tasks WHERE id = ?',
      [taskId],
    );
    if (row && row.persona_id && !SENTINEL_IDS.has(row.persona_id)) {
      return {
        persona_id: row.persona_id,
        persona_name: row.persona_name || humanizeSlug(row.persona_id),
        persona_mode: row.persona_mode || 'leadership',
        healed: false,
      };
    }
  } catch {
    /* fall through to heal */
  }

  // Naked at dispatch — heal deterministically (no stall). pinDepartmentDefaultPersona
  // writes the persona_fallback audit event + re-broadcasts the row.
  const fb = deriveDepartmentDefaultPersona(departmentForSelector);
  try {
    pinDepartmentDefaultPersona(taskId, fb);
    console.warn(
      `[ensurePersonaForDispatch] task ${taskId} was naked at dispatch — healed with ${fb.source} ` +
        `persona "${fb.persona_id}" (persona_fallback=true).`,
    );
  } catch (err) {
    // Even a failed pin still returns the persona so the message is never naked.
    console.error(`[ensurePersonaForDispatch] heal-pin failed for task ${taskId} (delivering anyway):`, err);
  }
  return { persona_id: fb.persona_id, persona_name: fb.persona_name, persona_mode: fb.persona_mode, healed: true };
}


// ─── AUDIENCE-CONFIRM GATE (persona-blend) ───────────────────────────────────
//
// Content tasks that went through the audience/topic blend carry a persona bundle
// with `confirm_required`. The audience the content is FOR is resolved from the
// client ICP but — per the ALWAYS-confirm rule — is NEVER written without operator
// sign-off. `evaluateAudienceConfirmGate` is the pure decision the dispatcher calls
// BEFORE its write step; the side-effecting helpers below apply the hold / deadline
// fallback / confirmation. Non-content tasks (no bundle) are never gated → no
// regression. NEVER-NAKED: unconfirmed past the deadline, we fall back to house-voice
// governance ONLY (keeping the prompt visible) and never fabricate an audience.

/** Confidence at/above which a single ICP audience is a "confirm" prompt rather
 *  than an open "what audience?" ask. */
export const AUDIENCE_HIGH_CONFIDENCE = 0.75;

/** How long a task waits for operator audience confirmation before the never-naked
 *  house-voice fallback releases it. Env-overridable; default 30 min. */
export const AUDIENCE_CONFIRM_DEADLINE_MS = Math.max(
  60_000,
  parseInt(process.env.AUDIENCE_CONFIRM_DEADLINE_MS || '1800000', 10),
);

/** Quiet re-poll window while a task is held for confirmation (so sweeps don't
 *  hammer it). Does NOT count toward the anti-furnace block cap — a legitimate
 *  operator wait is not a dispatch failure. Env-overridable; default 5 min. */
export const AUDIENCE_CONFIRM_POLL_MS = Math.max(
  30_000,
  parseInt(process.env.AUDIENCE_CONFIRM_POLL_MS || '300000', 10),
);

export interface AudienceConfirmDecision {
  hold: boolean;
  state: 'no_bundle' | 'not_required' | 'confirmed' | 'pending' | 'deadline_fallback';
  reason: string;
  audienceLabel: string | null;
  candidates: string[];
  /** Operator-facing prompt (never client spam). Present when hold or deadline_fallback. */
  prompt: string | null;
  /** True only on the FIRST hold — so the operator is surfaced ONCE, not every sweep. */
  firstHold: boolean;
}

/**
 * Build the operator-facing audience prompt. A single high-confidence ICP audience
 * gets a CONFIRM prompt; multiple / low-confidence / none gets the exact
 * "What audience are we dealing with?" ask enumerating the known ICP audiences.
 */
function buildAudiencePrompt(
  label: string | null,
  candidates: string[],
  confidence: number,
): string {
  if (label && candidates.length <= 1 && confidence >= AUDIENCE_HIGH_CONFIDENCE) {
    return `Confirm the audience for this content task: "${label}". This is the ICP we will write FOR — reply to change it if that's wrong before the task is dispatched.`;
  }
  const list = candidates.length
    ? candidates.map((c) => `• ${c}`).join('\n')
    : '(no ICP audiences on file — name the audience)';
  return `What audience are we dealing with? This content task needs a confirmed audience before dispatch. Known ICP audiences:\n${list}`;
}

/**
 * Decide whether a task's write must be HELD for operator audience confirmation.
 * PURE (reads DB, no mutation) so it is unit-testable without the dispatcher.
 *
 *   no bundle / not_required / confirmed / deadline_fallback → hold:false (proceed)
 *   pending within deadline                                  → hold:true  (block write)
 *   pending past deadline                                    → hold:false, state
 *                                                              deadline_fallback (NEVER-
 *                                                              NAKED house-voice release)
 */
export function evaluateAudienceConfirmGate(
  taskId: string,
  nowMs: number = Date.now(),
): AudienceConfirmDecision {
  const none: AudienceConfirmDecision = {
    hold: false, state: 'no_bundle', reason: 'no persona bundle',
    audienceLabel: null, candidates: [], prompt: null, firstHold: false,
  };

  let row: TaskPersonaBundleRow | undefined;
  try {
    row = queryOne<TaskPersonaBundleRow>('SELECT * FROM task_persona_bundle WHERE task_id = ?', [taskId]);
  } catch {
    return none; // pre-090 DB — no gate
  }
  if (!row) return none;

  let bundle: PersonaBundle | null = null;
  try { bundle = JSON.parse(row.bundle_json) as PersonaBundle; } catch { bundle = null; }
  const audience = bundle?.resolved_audience ?? null;
  const candidates = audience?.candidates ?? [];
  const audienceLabel = audience?.label ?? (candidates.length === 1 ? candidates[0] : null);

  const state = String(row.confirm_state ?? '');
  if (state === 'confirmed' || state === 'not_required' || state === 'deadline_fallback') {
    return {
      hold: false,
      state: state as AudienceConfirmDecision['state'],
      reason: `confirm_state=${state}`,
      audienceLabel, candidates, prompt: null, firstHold: false,
    };
  }

  // 'pending' (or any unknown state — fail-closed to a hold).
  const created = Date.parse(row.created_at);
  const pastDeadline = Number.isFinite(created) && nowMs - created >= AUDIENCE_CONFIRM_DEADLINE_MS;
  const prompt = buildAudiencePrompt(audienceLabel, candidates, audience?.confidence ?? 0);

  if (pastDeadline) {
    return {
      hold: false, state: 'deadline_fallback',
      reason: 'unconfirmed past deadline — house-voice governance only (audience still unconfirmed)',
      audienceLabel, candidates, prompt, firstHold: false,
    };
  }

  let priorEvent = false;
  try {
    const ev = queryOne<{ n: number }>(
      "SELECT COUNT(*) as n FROM events WHERE task_id = ? AND type = 'audience_confirm_pending'",
      [taskId],
    );
    priorEvent = (ev?.n ?? 0) > 0;
  } catch { priorEvent = false; }

  return {
    hold: true, state: 'pending',
    reason: 'awaiting operator audience confirmation',
    audienceLabel, candidates, prompt, firstHold: !priorEvent,
  };
}

/**
 * Apply a HOLD for audience confirmation: quietly defer the task (short poll window,
 * NOT counted toward the anti-furnace block cap) and surface the prompt to the
 * OPERATOR exactly once (never client spam — MOVE-IN-SILENCE). The dispatcher calls
 * this then returns WITHOUT writing/dispatching.
 */
export function holdForAudienceConfirm(
  taskId: string,
  agentId: string | null,
  decision: AudienceConfirmDecision,
): void {
  const now = new Date().toISOString();
  const nextEligible = new Date(Date.now() + AUDIENCE_CONFIRM_POLL_MS).toISOString();
  try {
    run('UPDATE tasks SET next_dispatch_eligible_at = ? WHERE id = ?', [nextEligible, taskId]);
  } catch { /* pre-migration tolerant */ }

  if (decision.firstHold) {
    try {
      run(
        `INSERT INTO events (id, type, agent_id, task_id, message, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [uuidv4(), 'audience_confirm_pending', agentId, taskId, `[AUDIENCE-CONFIRM] ${decision.prompt ?? 'audience confirmation required'}`, now],
      );
    } catch { /* audit best-effort */ }
    try {
      // OPERATOR-facing (Rescue Rangers / server), never the client's chat.
      notifySystem(`Audience check before dispatch — ${decision.prompt ?? 'confirm the audience for this content task'}`, {
        agent: 'audience-confirm',
        action: 'escalate',
      });
    } catch { /* notify best-effort */ }
  }
  console.log(`[audience-confirm] task ${taskId} HELD — awaiting operator audience confirmation`);
}

/**
 * NEVER-NAKED deadline release: an unconfirmed task past the deadline is dispatched
 * under house-voice GOVERNANCE only. We flip the bundle to 'deadline_fallback' (once)
 * and record a visible event; `confirm_required` is left visible so the operator can
 * still confirm afterwards. No audience is fabricated.
 */
export function markAudienceDeadlineFallback(taskId: string): void {
  const now = new Date().toISOString();
  try {
    const res = run(
      `UPDATE task_persona_bundle SET confirm_state = 'deadline_fallback' WHERE task_id = ? AND confirm_state = 'pending'`,
      [taskId],
    );
    // Only emit the event on the transition (res.changes === 1), never every sweep.
    if (res.changes === 1) {
      run(
        `INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, ?, ?, ?, ?)`,
        [uuidv4(), 'audience_confirm_deadline_fallback', taskId,
          `[AUDIENCE-CONFIRM] unconfirmed past deadline — dispatching under house-voice governance ONLY; audience still unconfirmed (no audience fabricated).`, now],
      );
    }
  } catch { /* best-effort — never block dispatch on the fallback bookkeeping */ }
}

/**
 * Operator confirms (or changes) the audience for a task. Flips the bundle to
 * 'confirmed', mirrors the confirmed audience onto tasks.audience_* with
 * source='operator_confirmed', records a visible event, and re-broadcasts the row.
 * On a CHANGE the caller should follow with a voice re-score (re-run
 * resolvePersonaAndPin) so the blend reflects the new audience.
 *
 * Library-only (no route wired here) so the operator-facing API route can call it.
 */
export function confirmTaskAudience(
  taskId: string,
  opts: { audienceId?: string | null; audienceLabel?: string | null; changed?: boolean } = {},
): void {
  const now = new Date().toISOString();
  try {
    run(`UPDATE task_persona_bundle SET confirm_state = 'confirmed' WHERE task_id = ?`, [taskId]);
  } catch { /* pre-090 tolerant */ }
  try {
    run(
      `UPDATE tasks
          SET audience_id = COALESCE(?, audience_id),
              audience_label = COALESCE(?, audience_label),
              audience_source = 'operator_confirmed'
        WHERE id = ?`,
      [opts.audienceId ?? null, opts.audienceLabel ?? null, taskId],
    );
  } catch { /* pre-090 tolerant */ }
  try {
    run(
      `INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, ?, ?, ?, ?)`,
      [uuidv4(), 'audience_confirmed', taskId,
        `[AUDIENCE-CONFIRM] operator confirmed audience${opts.audienceLabel ? ` "${opts.audienceLabel}"` : ''}${opts.changed ? ' (changed — voice re-score recommended)' : ''}.`, now],
    );
  } catch { /* audit best-effort */ }
  try {
    const t = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
    if (t) broadcast({ type: 'task_updated', payload: t });
  } catch { /* broadcast best-effort */ }
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
   * Immutable board-producer provenance (migration 089 / INGEST-10). Stamped
   * ONLY here, at creation, from the VALIDATED ingest `source` value — never
   * from caller-editable text. Never accept this on an update path
   * (UpdateTaskSchema has no `source` field and PATCH /api/tasks/[id] never
   * writes it) or the immutability guarantee that /api/tasks/[id]/status's
   * resolveBoardSource() relies on is broken.
   */
  source?: string | null;
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
  // Applies to the UI / Telegram create paths that carry NO idempotency key.
  //
  // Layer 1 (idempotency_key) TAKES PRECEDENCE over this generic window: a
  // caller-supplied idempotency key is an authoritative, deliberate identity.
  // When Layer 1 ran above and found no prior task, this is a KNOWINGLY-DISTINCT
  // card, and the generic same-title+workspace window must NOT collapse it onto
  // a same-titled neighbour. (E.g. one contact enrolled in two different
  // anthologies produces two cards whose titles can briefly coincide but whose
  // idempotency keys are distinct — Layer 2 must never merge those two onto one
  // task row.) So the title window is SKIPPED whenever an idempotency_key was
  // supplied; it still guards keyless callers against accidental duplicates.
  if (!input.skipWindowDedup && !input.idempotency_key) {
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
  //
  // F3.4 (SOP-aware matching): the SOP auto-suggest runs HERE, BEFORE persona
  // selection is kicked off below, so the winning SOP's slug + name + curated
  // persona_hints can be folded into the match (`sops.persona_hints` was
  // written by five paths and read by none until now). `sopContext` is passed
  // through to resolvePersonaAndPin → the selector.
  let sopId: string | null = input.sop_id ?? null;
  let sopContext: SopSelectorContext | undefined;
  if (!sopId) {
    try {
      const best = await getBestSOPForTask({
        title: input.title,
        description: input.description ?? undefined,
        department: input.department ?? undefined,
        workspace_id: workspaceId,
      });
      if (best) {
        sopId = best.id;
        sopContext = sopSelectorContextFromRow(best);
      }
    } catch (err) {
      console.warn('[createTaskCore] SOP auto-suggest failed (non-fatal):', err);
    }
  } else {
    // Caller supplied an explicit SOP — load its selector context too (F3.4).
    sopContext = loadSopSelectorContextById(sopId);
  }

  // Department backfill (UI-created-task visibility fix): the operator UI
  // create path (TaskModal -> POST /api/tasks) never sends `department`, only
  // `workspace_id` — so without this, tasks.department is written as NULL for
  // every UI-created task. The /tasks/all board's department filter chip
  // compares `task.department === selectedDepartment` (a workspace-slug
  // string), which NULL never matches, so those tasks silently vanished from
  // any department-scoped view. `workspaceSlug` was already resolved above
  // (from the workspaces table, keyed by the same workspaceId) for the
  // persona selector further down — reuse it here too, canonicalized with the
  // same canonicalDeptSlug() helper every other department write in this file
  // uses, so a UI-created task lands with the same department value a
  // department-tagged ingest task would get.
  const resolvedDepartment = input.department
    ? canonicalDeptSlug(input.department)
    : workspaceSlug
      ? canonicalDeptSlug(workspaceSlug)
      : null;

  run(
    `INSERT INTO tasks (id, title, description, status, priority, assigned_agent_id, created_by_agent_id, workspace_id, business_id, department, due_date, sop_id, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      resolvedDepartment,
      input.due_date || null,
      sopId,
      input.source || null,   // INGEST-10: immutable board-producer provenance, creation-only
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

  // DEP-5 / F3.7 + F3.9 — decide single-persona vs multi-persona decomposition.
  // Combined mode runs when the resolved SOP declares >1 persona slot OR a free
  // heuristic probe finds >1 sub-task on a non-mechanical task. The primary
  // (seq-1) persona is still pinned onto tasks.persona_* for back-compat either
  // way; combined mode additionally persists the per-sub-task plan rows.
  // F3.4 (DEP-2): the single-persona path stays SOP-aware by folding the resolved
  // SOP context into the creation-time match.
  const personaSlots = loadSopPersonaSlots(sopId);
  const { combined: useCombinedPersona, reason: decompReason } = decideMultiPersona(
    personaTaskDescription,
    personaSlots,
  );
  if (useCombinedPersona) {
    console.log(`[createTaskCore] task ${id}: multi-persona decomposition (${decompReason})`);
  }
  const personaPinPromise = useCombinedPersona
    ? resolvePersonaPlanAndPin(id, personaTaskDescription, personaDepartment, personaSlots)
    : resolvePersonaAndPin(id, personaTaskDescription, personaDepartment, sopContext);
  // Swallow at the source so a background failure never becomes an unhandled
  // rejection — both resolvers log internally and never throw to callers.
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
