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

export interface InterviewState {
  /** True only when we have positive evidence the interview is complete. */
  complete: boolean;
  /** Which signal proved completion (for transparency in the UI/debug). */
  signal:
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

  if (configSignal()) {
    return {
      complete: true,
      signal: 'company-config-kpis',
      detail: 'company-config.json has interview-derived KPIs and a specific industry.',
      checkedAt,
    };
  }
  if (interviewFileSignal()) {
    return {
      complete: true,
      signal: 'interview-answers-file',
      detail: 'workforce-interview-answers.md present in the OpenClaw workspace.',
      checkedAt,
    };
  }
  if (buildStateSignal()) {
    return {
      complete: true,
      signal: 'build-state-complete',
      detail: 'AI Workforce build reported complete; interview precedes the build.',
      checkedAt,
    };
  }

  return {
    complete: false,
    signal: 'none',
    detail:
      'No interview evidence found yet. Showing universal Layer-1 analytics; complete the AI Workforce interview to unlock persona-tuned Layer-2 views.',
    checkedAt,
  };
}
