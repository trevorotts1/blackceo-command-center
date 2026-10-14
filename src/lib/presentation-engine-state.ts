/**
 * presentation-engine-state.ts — Item 19 (FIX-PLAN): the CC board's read of
 * the presentation engine's OWN run record.
 *
 * ── WHY THIS MODULE EXISTS ────────────────────────────────────────────────────
 * The board's task rows are the producer's POSTED view of a run (cc_board
 * posts statuses and block fields as it observes them). Three run truths
 * never reached that view, so the board could not show them at all:
 *
 *   1. the P-U upsell branch's elections (the sealed intake record), so the
 *      stepper had no honest way to know which branch steps exist;
 *   2. the engine's terminal ABANDONED (the producer posts every terminal
 *      run as `review`, so an abandoned run sat in review-limbo forever,
 *      indistinguishable from work awaiting QC);
 *   3. WHY a run is parked, in the plain words the engine records for
 *      exactly this purpose (Item 10's `state["park_status"]` record).
 *
 * All three live in the run directory the PRES-010 registry binds to the
 * task (state.json + working/copy/intake.json) — the same channel the
 * deliverables route already reads run files through. This module is the
 * one reader: binding-first resolution, tolerant parsing, fail-soft nulls.
 *
 * ── HONESTY RULES (the Wiring Gate) ──────────────────────────────────────────
 *   * Absence of a binding, a state file, or a field is UNDETERMINED (null),
 *     never a default. No election is ever guessed: the intake resolution
 *     mirrors the engine's own defers.py order INCLUDING its declared
 *     defaults, and only when the sealed record itself is readable.
 *   * The blocked record's raw `reason` is NEVER carried into the park
 *     view. Item 10's doctrine: the raw reason is an engine diagnostic
 *     (gate codes, provider text); the client-safe record is park_status,
 *     whose fields are plain words by construction. Pre-Item-10 states
 *     fall back to the configuration_pending stamp (whose owner /
 *     next_action are likewise written as plain words) or to phase +
 *     timestamp alone — never to the raw reason.
 *
 * SERVER-ONLY (fs + DB). Never import from a 'use client' module.
 */

import { existsSync, readFileSync } from 'fs';
import path from 'path';
import {
  resolveRunDirForTask,
  type RunResolution,
} from '@/lib/presentation-run-bindings';
import { operatorPresentationRunDir } from '@/lib/presentation-run-roots';
import { loadOperatorPresentationContract } from '@/lib/presentation-operator-contract';
import type { UpsellElections } from '@/lib/presentation-phases';

export type EngineTerminal = 'DONE' | 'BLOCKED' | 'ABANDONED';

const ENGINE_TERMINALS: readonly string[] = ['DONE', 'BLOCKED', 'ABANDONED'];

/**
 * Item 10's `state["park_status"]` record, as written by the engine's
 * resume system (park_status_record in presentation_job/auto_resume.py).
 * Every field is read tolerantly: a partial or older record yields nulls
 * for the missing pieces, never invented values.
 */
export interface ParkStatusRecord {
  park_class: string | null;
  label: string | null;
  waiting_on: string | null;
  needed: string | null;
  phase: string | null;
  since: string | null;
  recorded_at: string | null;
  auto_resume: boolean | null;
  attempts_used: number | null;
  attempts_cap: number | null;
  by: string | null;
}

/**
 * The client-safe park view the card renders: plain words only (waiting on
 * whom, what is needed, since when). `source` names which engine record the
 * view came from, so a reader can tell an Item 10 record from a pre-Item-10
 * fallback at a glance.
 */
export interface ParkView {
  label: string;
  waiting_on: 'client' | 'operator' | 'system' | null;
  needed: string | null;
  phase: string | null;
  since: string | null;
  park_class: string | null;
  auto_resume: boolean | null;
  attempts_used: number | null;
  attempts_cap: number | null;
  source: 'park_status' | 'configuration_pending' | 'blocked';
}

export interface EngineRunState {
  jobId: string | null;
  terminal: EngineTerminal | null;
  /** The park's phase + timestamp. The raw reason is deliberately absent. */
  blocked: { phase: string | null; at: string | null } | null;
  parkStatus: ParkStatusRecord | null;
  configurationPending: {
    owner: string | null;
    nextAction: string | null;
    phase: string | null;
    at: string | null;
  } | null;
  resumeHistoryCount: number;
  updatedAt: string | null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}
function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** Parse one run dir's state.json. Null when absent or unreadable. */
export function readEngineRunState(runDir: string): EngineRunState | null {
  const statePath = path.join(runDir, 'state.json');
  let raw: unknown;
  try {
    if (!existsSync(statePath)) return null;
    raw = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
  const state = rec(raw);
  if (!state) return null;

  const terminalRaw = str(state.terminal);
  const terminal =
    terminalRaw && ENGINE_TERMINALS.includes(terminalRaw)
      ? (terminalRaw as EngineTerminal)
      : null;

  const blockedRec = rec(state.blocked);
  const blocked = blockedRec
    ? { phase: str(blockedRec.phase), at: str(blockedRec.at) }
    : null;

  const ps = rec(state.park_status);
  const parkStatus: ParkStatusRecord | null = ps
    ? {
        park_class: str(ps.park_class),
        label: str(ps.label),
        waiting_on: str(ps.waiting_on),
        needed: str(ps.needed),
        phase: str(ps.phase),
        since: str(ps.since),
        recorded_at: str(ps.recorded_at),
        auto_resume: bool(ps.auto_resume),
        attempts_used: num(ps.attempts_used),
        attempts_cap: num(ps.attempts_cap),
        by: str(ps.by),
      }
    : null;

  const cp = rec(state.configuration_pending);
  const configurationPending = cp
    ? {
        owner: str(cp.owner),
        nextAction: str(cp.next_action),
        phase: str(cp.phase),
        at: str(cp.at),
      }
    : null;

  return {
    jobId: str(state.job_id),
    terminal,
    blocked,
    parkStatus,
    configurationPending,
    resumeHistoryCount: Array.isArray(state.resume_history)
      ? state.resume_history.length
      : 0,
    updatedAt: str(state.updated_at),
  };
}

/**
 * Is this run parked, per the engine's own record? Parked = a blocked
 * record is present or the terminal value is BLOCKED. park_status alone
 * does NOT prove a park: the record describes the LAST park the resume
 * system evaluated, and the engine's resume reset clears `blocked` and
 * `terminal` when the park ends — a record that outlives its park must
 * never re-park the run on the board. park_status ENRICHES the view of a
 * run that is parked by the primary signals; it is never the signal.
 */
export function engineStateIsParked(state: EngineRunState): boolean {
  return state.blocked != null || state.terminal === 'BLOCKED';
}

/**
 * The plain-words park view for the card. Priority: Item 10's park_status
 * record (written for exactly this surface); then the configuration_pending
 * stamp (plain-words owner / next action by construction); then the bare
 * blocked record (phase + since only — the raw reason never crosses).
 * Null when the run is not parked.
 */
export function parkViewFromEngineState(state: EngineRunState): ParkView | null {
  if (!engineStateIsParked(state)) return null;

  const ps = state.parkStatus;
  if (ps && (ps.label || ps.needed || ps.waiting_on)) {
    return {
      label: ps.label ?? 'Parked',
      waiting_on:
        ps.waiting_on === 'client' || ps.waiting_on === 'operator' || ps.waiting_on === 'system'
          ? ps.waiting_on
          : null,
      needed: ps.needed,
      phase: ps.phase ?? state.blocked?.phase ?? null,
      since: ps.since ?? ps.recorded_at ?? state.blocked?.at ?? null,
      park_class: ps.park_class,
      auto_resume: ps.auto_resume,
      attempts_used: ps.attempts_used,
      attempts_cap: ps.attempts_cap,
      source: 'park_status',
    };
  }

  const cp = state.configurationPending;
  if (cp && (cp.nextAction || cp.owner)) {
    return {
      label: 'Waiting for a configuration answer',
      waiting_on: cp.owner?.includes('client')
        ? 'client'
        : cp.owner
          ? 'operator'
          : null,
      needed: cp.nextAction,
      phase: cp.phase ?? state.blocked?.phase ?? null,
      since: cp.at ?? state.blocked?.at ?? null,
      park_class: null,
      auto_resume: false,
      attempts_used: null,
      attempts_cap: null,
      source: 'configuration_pending',
    };
  }

  return {
    label: 'Parked',
    waiting_on: null,
    needed: null,
    phase: state.blocked?.phase ?? ps?.phase ?? null,
    since: state.blocked?.at ?? ps?.since ?? ps?.recorded_at ?? null,
    park_class: ps?.park_class ?? null,
    auto_resume: ps?.auto_resume ?? null,
    attempts_used: ps?.attempts_used ?? null,
    attempts_cap: ps?.attempts_cap ?? null,
    source: 'blocked',
  };
}

// ── Elections ────────────────────────────────────────────────────────────────

/**
 * Canonicalize an intake answer the way the engine's defers.py does:
 * explicit booleanish values reduce to yes/no; anything else is no answer.
 */
function canonYesNo(v: unknown): 'yes' | 'no' | null {
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number') return v === 1 ? 'yes' : v === 0 ? 'no' : null;
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (['yes', 'true', '1', 'y', 'on'].includes(s)) return 'yes';
  if (['no', 'false', '0', 'n', 'off'].includes(s)) return 'no';
  return null;
}

/**
 * The run's upsell elections from its sealed intake record
 * (working/copy/intake.json), resolved in the engine's OWN order
 * (presentation_job/defers.py):
 *   1. pre_presentation_capture.<UPPER_KEY>  2. pre_presentation_capture.<key>
 *   3. intake.<key>                          4. a waivers[] record for the
 *   branch (a recorded client decline)       5. the question's declared
 *   default (want_sales_checkout: "yes"; want_vsl_page: "no").
 * Null when the record is absent or unreadable: UNDETERMINED, never guessed.
 */
export function resolveElectionsFromIntake(runDir: string): UpsellElections | null {
  const intakePath = path.join(runDir, 'working', 'copy', 'intake.json');
  let raw: unknown;
  try {
    if (!existsSync(intakePath)) return null;
    raw = JSON.parse(readFileSync(intakePath, 'utf8'));
  } catch {
    return null;
  }
  const intake = rec(raw);
  if (!intake) return null;
  const capture = rec(intake.pre_presentation_capture) ?? {};
  const waivers = Array.isArray(intake.waivers) ? intake.waivers : [];

  const resolveOne = (
    key: 'want_sales_checkout' | 'want_vsl_page',
    upper: string,
    waiverRule: string,
    declaredDefault: 'yes' | 'no',
  ): boolean => {
    for (const candidate of [capture[upper], capture[key], intake[key]]) {
      const v = canonYesNo(candidate);
      if (v != null) return v === 'yes';
    }
    const waived = waivers.some(
      (w) => rec(w)?.rule === waiverRule,
    );
    if (waived) return false;
    return declaredDefault === 'yes';
  };

  return {
    salesCheckout: resolveOne('want_sales_checkout', 'WANT_SALES_CHECKOUT', 'sales_checkout', 'yes'),
    vsl: resolveOne('want_vsl_page', 'WANT_VSL_PAGE', 'vsl_page', 'no'),
  };
}

// ── The combined per-task view ───────────────────────────────────────────────

export interface TaskEngineView {
  resolution: RunResolution;
  runDir: string | null;
  state: EngineRunState | null;
  terminal: EngineTerminal | null;
  park: ParkView | null;
  elections: UpsellElections | null;
}

/**
 * Everything Item 19's surfaces need about a task's engine run, in one
 * read: the bound run's terminal vocabulary, its plain-words park view,
 * and its upsell elections.
 *
 * Resolution order for the run dir: the PRES-010 binding registry (the
 * sanctioned channel). Operator-delegated runs without a binding fall back
 * to the ONE operator run-dir definition (presentation-run-roots) when
 * that directory actually carries a state.json — the same directory the
 * launcher creates and the recovery probe reads.
 *
 * Elections order: the sealed intake record first (the engine's own
 * constitutional record); the operator contract second (the elections the
 * operator recorded at delegation, readable before the bridge writes the
 * run's intake). Absent both: null (UNDETERMINED).
 */
export function getTaskEngineView(taskId: string): TaskEngineView {
  const resolution = resolveRunDirForTask(taskId);
  let runDir: string | null = resolution.kind === 'bound' ? resolution.runDir : null;

  // The operator-dir fallback applies only to the no-binding case. An
  // 'unavailable' resolution (stale root, foreign marker) is a verdict
  // about a REGISTERED run; a same-named operator directory must never
  // mask it.
  if (!runDir && resolution.kind === 'unbound') {
    const operatorDir = operatorPresentationRunDir(taskId);
    if (existsSync(path.join(operatorDir, 'state.json'))) {
      runDir = operatorDir;
    }
  }

  if (!runDir) {
    return {
      resolution,
      runDir: null,
      state: null,
      terminal: null,
      park: null,
      elections: electionsFromContract(taskId),
    };
  }

  const state = readEngineRunState(runDir);
  return {
    resolution,
    runDir,
    state,
    terminal: state?.terminal ?? null,
    park: state ? parkViewFromEngineState(state) : null,
    elections: resolveElectionsFromIntake(runDir) ?? electionsFromContract(taskId),
  };
}

function electionsFromContract(taskId: string): UpsellElections | null {
  try {
    const contract = loadOperatorPresentationContract(taskId);
    if (!contract) return null;
    return {
      salesCheckout: contract.want_sales_checkout === 'yes',
      vsl: contract.want_vsl_page === 'yes',
    };
  } catch {
    return null;
  }
}

/**
 * The cheap gate for row-level enrichment (task-row projection): only
 * presentation engine parents can have engine state worth reading. A row
 * that fails the gate costs one string check; a row that passes it pays
 * one binding lookup plus at most two small file reads, fail-soft.
 */
export function taskRowMayHaveEngineState(row: {
  parent_task_id?: string | null;
  source?: string | null;
  department?: string | null;
}): boolean {
  if (row.parent_task_id != null) return false;
  if (row.source === 'build_deck') return true;
  const dept = (row.department ?? '').toLowerCase();
  return dept.includes('presentation');
}
