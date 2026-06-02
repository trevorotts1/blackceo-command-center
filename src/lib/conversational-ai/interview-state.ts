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
 */

import fs from 'fs';
import path from 'path';
import { loadCompanyConfig } from '@/lib/company-config';
import { candidateWorkspaceRoots, resolveLogFile } from './sources';
import { getClientContext } from '@/lib/clients';

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
  /** Which signal proved completion (for transparency in the UI/debug). */
  signal:
    | 'client-flag'
    | 'company-config-kpis'
    | 'interview-answers-file'
    | 'build-state-complete'
    | 'none';
  /** Optional human-readable detail. */
  detail: string;
  /** ISO timestamp this check ran. */
  checkedAt: string;
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
  return resolveLogFile('workforce-interview-answers.md') !== null;
}

function buildStateSignal(): boolean {
  for (const root of candidateWorkspaceRoots()) {
    // .workforce-build-state.json at the workspace level
    const buildState = path.join(root, '.workforce-build-state.json');
    const completed = readBuildComplete(buildState);
    if (completed) return true;

    // build-progress.json under any company subdir
    let entries: string[] = [];
    try {
      if (!fs.existsSync(root)) continue;
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const progressFile = path.join(root, entry, 'build-progress.json');
      if (readBuildComplete(progressFile)) return true;
    }
  }
  return false;
}

function readBuildComplete(file: string): boolean {
  try {
    if (!fs.existsSync(file)) return false;
    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
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
 * Resolve interview-completion state. Defaults to NOT complete unless a
 * positive signal is found. Never throws.
 */
export function getInterviewState(): InterviewState {
  const checkedAt = new Date().toISOString();

  // 1. Per-client DB flag (E3) is the authoritative, client-scoped answer.
  //    A definitive true OR false here is `known` — we trust the tenant record
  //    over any host-wide filesystem heuristic.
  const clientFlag = clientFlagSignal();
  if (clientFlag === true) {
    return {
      complete: true,
      known: true,
      signal: 'client-flag',
      detail: 'Selected client is marked interview_complete in the tenant record.',
      checkedAt,
    };
  }
  if (clientFlag === false) {
    return {
      complete: false,
      known: true,
      signal: 'client-flag',
      detail:
        'Selected client is not yet marked interview_complete. Complete the AI Workforce interview to unlock persona-tuned Layer-2 views.',
      checkedAt,
    };
  }

  // 2. clientFlag is null (unknown) — fall back to the host-wide filesystem
  //    signals. Any positive signal is `known: true`.
  if (configSignal()) {
    return {
      complete: true,
      known: true,
      signal: 'company-config-kpis',
      detail: 'company-config.json has interview-derived KPIs and a specific industry.',
      checkedAt,
    };
  }
  if (interviewFileSignal()) {
    return {
      complete: true,
      known: true,
      signal: 'interview-answers-file',
      detail: 'workforce-interview-answers.md present in the OpenClaw workspace.',
      checkedAt,
    };
  }
  if (buildStateSignal()) {
    return {
      complete: true,
      known: true,
      signal: 'build-state-complete',
      detail: 'AI Workforce build reported complete; interview precedes the build.',
      checkedAt,
    };
  }

  // 3. No flag, no signal → UNKNOWN. complete stays false but known is false,
  //    so the banner defaults to HIDDEN (E3) rather than nagging.
  return {
    complete: false,
    known: false,
    signal: 'none',
    detail:
      'No interview evidence found yet. Showing universal Layer-1 analytics; complete the AI Workforce interview to unlock persona-tuned Layer-2 views.',
    checkedAt,
  };
}
