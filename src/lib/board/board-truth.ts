/**
 * JEV-025 — board/task-detail truth helpers (spec 11.1/11.4, A39/A41).
 *
 * WHAT THIS IS
 * ------------
 * Read-only projectors over data OTHER units already write. This module owns
 * no state, writes no rows, mutates no assignment, and never re-selects.
 * Every function degrades to an honest "unknown" instead of inventing green.
 *
 * SOURCES (all pre-existing, additive, nullable):
 * - tasks row mirror columns (persona/voice/topic/audience/model/routing_*).
 * - task_persona_bundle row (the stored proposed decision).
 * - task_executions.persona_bundle_shas (what dispatch ACTUALLY handed).
 * - task_activities persona_used reports (what the producer says it USED).
 * - task_executions.provider + state (actual runtime provenance).
 *
 * DELIBERATE NON-GOALS (ponytail):
 * - No D24 dispatch-parity contract consumed here. Producer cards are marked
 *   with an explicit prerequisite hold until D24 lands; upgrade path is to
 *   replace `d24Prerequisite()` with the real D24 verdict reader.
 * - No live JEV selection-confidence plumbing. The selector stores a fit
 *   score, not a calibrated confidence; this module labels it as fit, never
 *   as confidence.
 */

import { queryOne, queryAll } from '@/lib/db';
import { personaBundleHash } from '@/lib/persona-state';
import { normalizeBoardSource } from '@/lib/board-sources';

// ─── Executor (actual worker + owner-direct vs delegated) ────────────────────

export type ExecutorKind = 'owner-direct' | 'delegated' | 'unassigned';

export interface ExecutorTaskInput {
  assigned_agent_id?: string | null;
  routing_reason?: string | null;
  assigned_agent?: { name?: string | null } | null;
  assigned_agent_name?: string | null;
}

/** Owner-direct pin marker written by resolveSpecialistPin (department-router). */
const OWNER_PIN_PREFIX = 'Owner-direct specialist pin';

export function resolveExecutorKind(task: ExecutorTaskInput): ExecutorKind {
  if (!task.assigned_agent_id) return 'unassigned';
  if (
    typeof task.routing_reason === 'string' &&
    task.routing_reason.startsWith(OWNER_PIN_PREFIX)
  ) {
    return 'owner-direct';
  }
  return 'delegated';
}

export function executorAgentName(task: ExecutorTaskInput): string | null {
  const name = task.assigned_agent?.name ?? task.assigned_agent_name ?? null;
  return typeof name === 'string' && name.trim() ? name : null;
}

export interface ExecutorChip {
  label: 'owner-direct' | 'delegated';
  title: string;
}

/**
 * Card-face chip props. Null when unassigned (nothing to claim). Never
 * invents an executor: without an assigned agent there is no chip.
 */
export function executorChipProps(task: ExecutorTaskInput): ExecutorChip | null {
  const kind = resolveExecutorKind(task);
  if (kind === 'unassigned') return null;
  const agent = executorAgentName(task) ?? 'assigned specialist';
  if (kind === 'owner-direct') {
    return {
      label: 'owner-direct',
      title:
        `Owner named ${agent} directly — routed straight to the specialist, ` +
        `bypassing department classification and role-fit scoring.`,
    };
  }
  return {
    label: 'delegated',
    title:
      `Routed through department classification to ${agent} ` +
      `(role-fit + load scoring, not an owner pin).`,
  };
}

// ─── Proposed vs committed vs used bundle truth (A39) ────────────────────────

export type BundleMatchStatus = 'match' | 'mismatch' | 'unknown';
export type BundleMismatchSource = 'bundle_sha' | 'voice' | null;

export interface BundleTruthInput {
  declaredVoicePersonaId?: string | null;
  proposedSha?: string | null;
  committedSha?: string | null;
  usedSha?: string | null;
  usedVoicePersonaId?: string | null;
}

export interface BundleTruth extends BundleTruthInput {
  status: BundleMatchStatus;
  mismatchSource: BundleMismatchSource;
}

function cleanId(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t || t === 'null' || t === 'undefined') return null;
  return t;
}

export function resolveBundleTruth(input: BundleTruthInput): BundleTruth {
  const declaredVoice = cleanId(input.declaredVoicePersonaId);
  const usedVoice = cleanId(input.usedVoicePersonaId);
  const committedSha =
    typeof input.committedSha === 'string' && input.committedSha ? input.committedSha : null;
  const usedSha = typeof input.usedSha === 'string' && input.usedSha ? input.usedSha : null;
  // Without BOTH sides there is nothing to compare. Unknown is the honest
  // answer — never a fabricated match, never a fabricated warning.
  if (!committedSha || !usedSha) {
    return { ...input, status: 'unknown', mismatchSource: null };
  }
  if (committedSha !== usedSha) {
    return { ...input, status: 'mismatch', mismatchSource: 'bundle_sha' };
  }
  if (declaredVoice && usedVoice && declaredVoice !== usedVoice) {
    return { ...input, status: 'mismatch', mismatchSource: 'voice' };
  }
  return { ...input, status: 'match', mismatchSource: null };
}

export interface BundleTruthDb {
  proposedSha: string | null;
  committedSha: string | null;
  usedSha: string | null;
  usedVoicePersonaId: string | null;
  executionProvider: string | null;
  executionState: string | null;
}

/**
 * Read the three bundle identities plus runtime provenance straight from the
 * database. Fail-soft throughout: any missing table/row/parse yields nulls,
 * never a throw, never a fabricated sha.
 */
export function bundleTruthFromDb(taskId: string): BundleTruthDb {
  const empty: BundleTruthDb = {
    proposedSha: null,
    committedSha: null,
    usedSha: null,
    usedVoicePersonaId: null,
    executionProvider: null,
    executionState: null,
  };
  try {
    const bundleRow = queryOne<{ bundle_json: string | null }>(
      'SELECT bundle_json FROM task_persona_bundle WHERE task_id = ?',
      [taskId],
    );
    if (bundleRow?.bundle_json) {
      try {
        empty.proposedSha = personaBundleHash(JSON.parse(bundleRow.bundle_json));
      } catch {
        /* corrupt stored bundle: proposed stays unknown, reported loudly by QC, not here */
      }
    }
    const exec = queryOne<{
      id: string;
      provider: string | null;
      state: string | null;
      agent_id: string | null;
      persona_bundle_shas: string | null;
    }>(
      'SELECT id, provider, state, agent_id, persona_bundle_shas FROM task_executions ' +
        'WHERE task_id = ? ORDER BY generation DESC LIMIT 1',
      [taskId],
    );
    if (!exec) return empty;
    empty.executionProvider = exec.provider ?? null;
    empty.executionState = exec.state ?? null;
    if (exec.persona_bundle_shas) {
      try {
        const parsed = JSON.parse(exec.persona_bundle_shas) as {
          root?: string | null;
        };
        empty.committedSha = parsed.root ?? null;
      } catch {
        /* malformed snapshot: committed stays unknown */
      }
    }
    // Producer USED reports for THIS execution only (mirrors the conformance
    // read: latest-first, first report bound to this execution wins).
    try {
      const rows = queryAll<{ metadata: string | null }>(
        `SELECT metadata FROM task_activities WHERE task_id = ? AND agent_id = ? ` +
          `AND json_valid(metadata) AND json_extract(metadata, '$.kind') = 'persona_used' ` +
          `ORDER BY created_at DESC, rowid DESC`,
        [taskId, exec.agent_id],
      );
      for (const r of rows) {
        if (!r.metadata) continue;
        try {
          const report = JSON.parse(r.metadata) as {
            execution_id?: string;
            bundle_sha?: string | null;
            voice_persona_id?: string | null;
          };
          if (report.execution_id !== exec.id) continue;
          empty.usedSha =
            typeof report.bundle_sha === 'string' && report.bundle_sha
              ? report.bundle_sha
              : null;
          empty.usedVoicePersonaId = cleanId(report.voice_persona_id);
          break;
        } catch {
          continue;
        }
      }
    } catch {
      /* activity-table read failure: used stays unknown */
    }
    return empty;
  } catch {
    return empty;
  }
}

// ─── Provider provenance ─────────────────────────────────────────────────────

export interface ProviderTaskInput {
  model_id?: string | null;
  model_label?: string | null;
  model_provider?: string | null;
}

export interface ProviderTruth {
  intendedModel: string | null;
  intendedProvider: string | null;
  actualProvider: string | null;
  executionState: string | null;
}

/**
 * Intended (CC-resolved at dispatch) vs actual (execution-row provider).
 * The gateway runs the agent's own configured model, so "intended" is never
 * presented as "used" — the panel copy states that boundary verbatim.
 */
export function resolveProviderTruth(
  task: ProviderTaskInput,
  exec: { executionProvider: string | null; executionState: string | null } | null,
): ProviderTruth {
  return {
    intendedModel: task.model_label || task.model_id || null,
    intendedProvider: task.model_provider || null,
    actualProvider: exec?.executionProvider ?? null,
    executionState: exec?.executionState ?? null,
  };
}

// ─── Selection holds (non-duplicated surfaces only) ──────────────────────────

export interface SelectionHold {
  kind: 'routing-wait' | 'audience-confirm' | 'house-voice-fallback';
  title: string;
  message: string;
}

export interface SelectionHoldTaskInput {
  routing_reason?: string | null;
  routing_wait_owner?: string | null;
  routing_next_action?: string | null;
  blend_confirm_state?: string | null;
}

/**
 * Holds rendered ONLY here: dispatch-hold, block, and QC-park already have
 * their own panels (DispatchHoldPanel, BlockedReasonPanel, QcPromotePanel).
 * This covers the routing-wait and audience-confirm surfaces nothing else shows.
 */
export function selectionHolds(task: SelectionHoldTaskInput): SelectionHold[] {
  const holds: SelectionHold[] = [];
  if (task.routing_reason || task.routing_wait_owner) {
    holds.push({
      kind: 'routing-wait',
      title:
        task.routing_wait_owner === 'SYSTEM'
          ? 'Routing waiting on the system'
          : 'Routing waiting on a decision',
      message: [
        task.routing_reason ?? 'Routing has not completed.',
        task.routing_next_action ?? null,
      ]
        .filter(Boolean)
        .join(' Next action: '),
    });
  }
  if (task.blend_confirm_state === 'pending') {
    holds.push({
      kind: 'audience-confirm',
      title: 'Waiting for your answer',
      message:
        'This task is waiting for you to say who will read it. If it stays ' +
        'unanswered, it starts after 30 minutes in a neutral house voice.',
    });
  } else if (task.blend_confirm_state === 'deadline_fallback') {
    holds.push({
      kind: 'house-voice-fallback',
      title: 'Released on house voice',
      message:
        'Nobody said who would read this in time, so it was written in a neutral ' +
        'house voice. Tell us who will read your future tasks to get a closer match.',
    });
  }
  return holds;
}

// ─── D24 prerequisite hold ───────────────────────────────────────────────────

/**
 * D24 (producer-bundle auto/manual dispatch parity) has not landed. Until it
 * does, producer-bundle reuse on ANY producer card is unverified — mark it as
 * a prerequisite hold rather than implying parity. Upgrade path: replace this
 * call with the real D24 verdict reader when D24 ships.
 */
export function d24Prerequisite(task: { source?: string | null }): boolean {
  return normalizeBoardSource(task.source) !== null;
}
