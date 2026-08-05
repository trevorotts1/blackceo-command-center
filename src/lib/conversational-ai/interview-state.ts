/**
 * Interview-completion detection for Feature 52 Layer-2 gating.
 *
 * Layer 2 (persona-aligned funnels, business-specific KPIs, industry
 * benchmarks, recommended-actions) UNLOCKS only when the client's AI Workforce
 * interview is complete. This module is the single checkpoint that decides
 * complete vs not-complete, with a clean default of NOT complete when no
 * evidence exists yet.
 *
 * Evidence, in priority order:
 *   1. config/company-config.json has a non-empty companyKPIs[] AND a real
 *      industry (the post-interview build writes these) -> strongest signal,
 *      lives inside the deployed app so it works on any host.
 *   2. A workforce-interview-answers.md file exists in the OpenClaw workspace
 *      (Skill 23 writes it at interview completion).
 *   3. A build-progress.json / .workforce-build-state.json reporting a
 *      completed build implies the interview that precedes it is done.
 *
 * Any positive signal -> complete. No signal -> NOT complete (Layer 1 only).
 *
 * AI Workforce standard-first (PHASE 6 item 10) — the STANDARD_READY state:
 * a box can be standard-PREBUILT (build-state carries
 * `standardPrebuild.status === "done"`) while the interview is still
 * incomplete. This is a THIRD interview-progress state — the foundation is
 * materialized but nothing is personalized, no agents are registered, and
 * Layer 2 must stay LOCKED (there is no interview content to gate on yet).
 * It is detected and surfaced as `standardReady: true` with `complete: false`
 * + `known: true` so callers can distinguish "prebuilt, awaiting interview"
 * from "nothing yet" — never treated as completion evidence.
 */

import path from 'path';
import { loadCompanyConfig } from '@/lib/company-config';
import { safeReadFileUtf8, safeReaddirNames } from '@/lib/fs/safe-fs';
import { candidateWorkspaceRoots, resolveLogFile } from './sources';
import { getClientContext } from '@/lib/clients';

/**
 * AI Workforce standard-first (PHASE 6 item 10): the third interview-progress
 * state. A standard-prebuilt box — `standardPrebuild.status === "done"` in
 * build-state, interview NOT yet complete — is STANDARD_READY: the canonical
 * foundation exists on disk + board, but the interview has not happened, so
 * this state must NEVER be treated as completion. Surfaced via
 * `InterviewState.standardReady` (complete stays false).
 */
export const STANDARD_READY = 'STANDARD_READY' as const;
export type StandardReadyState = typeof STANDARD_READY;

/**
 * The per-client interview flag (E3). Returns the selected client's DB-backed
 * `interview_complete` boolean, or null when it cannot be read (no clients
 * table yet / outside a request scope). null = unknown → caller defaults the
 * banner to HIDDEN. Never throws.
 */
function clientFlagSignal(): boolean | null {
  try {
    const client = getClientContext();
    if (!client) return null;
    return client.interview_complete;
  } catch {
    return null;
  }
}

export interface InterviewState {
  /** True only when we have positive evidence the interview is complete. */
  complete: boolean;
  /**
   * True when we have a DEFINITIVE answer either way (the per-client DB flag,
   * or a positive filesystem signal). False means "unknown" — no per-client
   * flag and no positive evidence. Callers should treat unknown as: do NOT
   * nag the operator (E3: the "complete your interview" banner defaults to
   * HIDDEN when status is unknown).
   */
  known: boolean;
  /** Which signal proved completion (for transparency in the UI/debug).
   *  STANDARD_READY is the one non-completion signal: it marks the prebuilt-
   *  foundation state while `complete` stays false. */
  signal:
    | 'client-flag'
    | 'company-config-kpis'
    | 'interview-answers-file'
    | 'build-state-complete'
    | StandardReadyState
    | 'none';
  /** Optional human-readable detail. */
  detail: string;
  /** ISO timestamp this check ran. */
  checkedAt: string;
  /**
   * AI Workforce standard-first (PHASE 6 item 10): true when the box is in the
   * STANDARD_READY state — `standardPrebuild.status === "done"` in build-state
   * while the interview is NOT yet complete. This is a prebuilt-foundation
   * marker, NEVER completion evidence: `complete` stays false when only this
   * signal fires (it merely makes `known` true so callers stop treating the
   * box as "nothing yet").
   */
  standardReady: boolean;
}

function configSignal(): boolean {
  try {
    const cfg = loadCompanyConfig();
    const hasKpis = Array.isArray(cfg.companyKPIs) && cfg.companyKPIs.length > 0;
    const hasIndustry = !!cfg.industry && cfg.industry !== 'general';
    return hasKpis && hasIndustry;
  } catch {
    return false;
  }
}

function interviewFileSignal(): boolean {
  // Probe the same locations migrations.ts / seed-workspaces.py use.
  // U048: check both the plaintext .md and the encrypted .enc file.
  return (
    resolveLogFile('workforce-interview-answers.md') !== null ||
    resolveLogFile('workforce-interview-answers.md.enc') !== null
  );
}

function buildStateSignal(): boolean {
  for (const root of candidateWorkspaceRoots()) {
    // .workforce-build-state.json at the workspace level
    const buildState = path.join(root, '.workforce-build-state.json');
    const completed = readBuildComplete(buildState);
    if (completed) return true;

    // build-progress.json under any company subdir. safeReaddirNames never
    // blocks on a TCC-gated workspace root (~/Downloads is a candidate); [] on
    // absent/blocked.
    for (const entry of safeReaddirNames(root)) {
      const progressFile = path.join(root, entry, 'build-progress.json');
      if (readBuildComplete(progressFile)) return true;
    }
  }
  return false;
}

function readBuildComplete(file: string): boolean {
  // safeReadFileUtf8 never blocks on a TCC-gated workspace root; null on absent/
  // unreadable/blocked.
  const rawStr = safeReadFileUtf8(file);
  if (rawStr == null) return false;
  try {
    const data = JSON.parse(rawStr) as Record<string, unknown>;
    const stage = String(data.stage ?? '').toLowerCase();
    const status = String(data.status ?? '').toLowerCase();
    if (stage === 'complete' || stage === 'done' || stage === 'finished') return true;
    if (status === 'complete' || status === 'done' || status === 'finished') return true;
    // documents_complete >= documents_total (and total > 0) implies done
    const total = Number(data.documents_total ?? 0);
    const done = Number(data.documents_complete ?? 0);
    if (total > 0 && done >= total) return true;
    if (data.interview_complete === true || data.interviewComplete === true) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * AI Workforce standard-first (PHASE 6 item 10): the STANDARD_READY detector.
 * True when some workspace-root .workforce-build-state.json carries
 * `standardPrebuild.status === "done"` while its `interviewComplete` is NOT
 * true — the prebuild driver's terminal record on a box whose interview has
 * not happened yet. Probes the same roots buildStateSignal uses (which honors
 * OPENCLAW_WORKSPACE_ROOT, so the e2e fixture is reachable). Never throws.
 *
 * This is NOT completion evidence: getInterviewState reports it as
 * `standardReady: true` with `complete: false` (known: true).
 */
function standardReadySignal(): boolean {
  for (const root of candidateWorkspaceRoots()) {
    const rawStr = safeReadFileUtf8(path.join(root, '.workforce-build-state.json'));
    if (rawStr == null) continue;
    try {
      const data = JSON.parse(rawStr) as Record<string, unknown>;
      if (data.interview_complete === true || data.interviewComplete === true) continue;
      const block = data.standardPrebuild;
      if (
        block &&
        typeof block === 'object' &&
        (block as Record<string, unknown>).status === 'done'
      ) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * Auto-upgrade helper: when filesystem signals confirm completion but the DB
 * row still shows interview_complete=0, backfill the flag so subsequent calls
 * take the fast path. Called only when clientFlag === false AND a positive
 * filesystem signal fires. Never throws.
 */
function tryBackfillClientFlag(clientId: string | null): void {
  if (!clientId) return;
  try {
    // Import at call-time to avoid a module-level circular dep.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { setInterviewComplete } = require('@/lib/clients') as typeof import('@/lib/clients');
    setInterviewComplete(clientId, true);
  } catch {
    // Non-fatal: the UI will re-check on the next status poll.
  }
}

/**
 * Resolve interview-completion state. Defaults to NOT complete unless a
 * positive signal is found. Never throws.
 *
 * Priority order:
 *   1. Per-client DB flag (E3) — truest source; true → done, false → check FS
 *   2. Filesystem signals (company-config, interview-answers-file, build-state)
 *      — when any fires AND the DB flag is false, we auto-backfill the DB flag
 *      so subsequent calls take the fast path without re-scanning the FS.
 *   3. No signal → UNKNOWN; banner hidden (E3) so a completed client is never
 *      nagged due to a missing DB flag.
 *
 * The key change from the pre-fix behaviour: `clientFlag === false` no longer
 * short-circuits before the filesystem check. A client whose interview IS
 * complete (evidenced by filesystem artifacts) but whose DB row still has
 * interview_complete=0 (common for clients onboarded before migration 048
 * seeded the self row, or for clients imported without the flag) will now
 * correctly be detected as complete. The DB flag is backfilled automatically
 * so the false-gating disappears on the next status poll.
 */
export function getInterviewState(): InterviewState {
  const checkedAt = new Date().toISOString();

  // 1. Per-client DB flag (E3).
  const clientFlag = clientFlagSignal();
  if (clientFlag === true) {
    return {
      complete: true,
      known: true,
      signal: 'client-flag',
      detail: 'Selected client is marked interview_complete in the tenant record.',
      checkedAt,
      standardReady: false,
    };
  }

  // Capture the client id for potential backfill below regardless of whether
  // clientFlag is false or null.
  let selectedClientId: string | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getSelectedClientId } = require('@/lib/clients') as typeof import('@/lib/clients');
    selectedClientId = getSelectedClientId();
  } catch {
    // non-fatal
  }

  // 2. Filesystem signals. These run regardless of whether clientFlag is false
  //    (DB says not complete) or null (no client row yet). A positive filesystem
  //    signal is authoritative: the interview DID happen; the DB flag is stale.
  if (configSignal()) {
    if (clientFlag === false) tryBackfillClientFlag(selectedClientId);
    return {
      complete: true,
      known: true,
      signal: 'company-config-kpis',
      detail: 'company-config.json has interview-derived KPIs and a specific industry.',
      checkedAt,
      standardReady: false,
    };
  }
  if (interviewFileSignal()) {
    if (clientFlag === false) tryBackfillClientFlag(selectedClientId);
    return {
      complete: true,
      known: true,
      signal: 'interview-answers-file',
      detail: 'workforce-interview-answers.md present in the OpenClaw workspace.',
      checkedAt,
      standardReady: false,
    };
  }
  if (buildStateSignal()) {
    if (clientFlag === false) tryBackfillClientFlag(selectedClientId);
    return {
      complete: true,
      known: true,
      signal: 'build-state-complete',
      detail: 'AI Workforce build reported complete; interview precedes the build.',
      checkedAt,
      standardReady: false,
    };
  }

  // 2b. AI Workforce standard-first (PHASE 6 item 10) — STANDARD_READY: the
  //     foundation is prebuilt (standardPrebuild.status === "done") but the
  //     interview has NOT completed. Known-but-incomplete: callers may surface
  //     "your company foundation is ready, let's tailor it", and must NOT treat
  //     this as completion (Layer 2 stays locked; no backfill of the DB flag).
  if (standardReadySignal()) {
    return {
      complete: false,
      known: true,
      signal: STANDARD_READY,
      detail:
        'The standard company foundation is prebuilt (STANDARD_READY), but the AI Workforce interview has not been completed — Layer-2 views stay locked until it is.',
      checkedAt,
      standardReady: true,
    };
  }

  // 3. DB says definitively false AND no filesystem evidence → known incomplete.
  if (clientFlag === false) {
    return {
      complete: false,
      known: true,
      signal: 'client-flag',
      detail:
        'Selected client is not yet marked interview_complete, and no filesystem completion evidence found. Complete the AI Workforce interview to unlock persona-tuned Layer-2 views.',
      checkedAt,
      standardReady: false,
    };
  }

  // 4. No DB flag, no filesystem signal → UNKNOWN. complete=false but known=false,
  //    so the banner defaults to HIDDEN (E3) rather than nagging an already-
  //    onboarded client.
  return {
    complete: false,
    known: false,
    signal: 'none',
    detail:
      'No interview evidence found yet. Showing universal Layer-1 analytics; complete the AI Workforce interview to unlock persona-tuned Layer-2 views.',
    checkedAt,
    standardReady: false,
  };
}
