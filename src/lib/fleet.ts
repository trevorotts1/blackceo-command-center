/**
 * Per-client fleet status aggregation — the data layer behind the /fleet page
 * (U009). Reads canonical interview files + probes gateway liveness for every
 * managed client CONCURRENTLY, degrading per-client on error so one failing box
 * never blanks the whole fleet.
 *
 * ── Interview state (per Requirement 2) ──────────────────────────────
 * Derived from the SAME canonical files as /api/interview/state:
 *   • <workspace_root>/.workforce-build-state.json  → interviewComplete, progress
 *   • <workspace_root>/company-discovery/interview-handoff.md  → answer counts
 * For the SELF client, the same seam functions the route calls are reused
 * directly so the two surfaces can never disagree.
 * NEVER reads the interview_sessions table (grep this file: zero hits).
 *
 * ── Liveness (per Requirement 3) ────────────────────────────────────
 * Pings each client's gateway over HTTP (converting ws://→http://) with a ~4s
 * AbortController timeout per endpoint. Honors the client's gateway token +
 * CF-Access service-token headers where configured — mirrors the OpenClaw
 * client's own connection shape.
 *
 * ── Health (per Requirement 4) ──────────────────────────────────────
 * Simple, documented derivation — never a "computed" synthesis:
 *   live gateway    → 'ok'      (box is reachable)
 *   offline gateway → 'error'   (box is unreachable)
 *   unknown         → 'unknown' (no gateway configured — cannot assess)
 *
 * ── Pipeline stage (per Requirement 5) ──────────────────────────────
 *   not-started  → 'onboarding'
 *   in-progress  → 'interview'
 *   complete     → 'active'
 * 'setup' is reserved for a canonical post-interview pre-build gate — not yet
 * represented in the files the interview writes; when a build-in-progress signal
 * lands in build-state, map it here.
 *
 * ── Security (per Requirement 6) ────────────────────────────────────
 * FleetClientStatus carries ZERO secrets. gateway_token, cf_access_client_id,
 * and cf_access_client_secret are read from the Client record to build liveness
 * headers IN-MEMORY ONLY and are never reflected in the returned shape.
 *
 * SERVER-ONLY — imports fs + client secrets. UI files must use
 * `import type { FleetClientStatus, … } from '@/lib/fleet'` only — never a
 * runtime import of this module.
 */

import fs from 'fs';
import path from 'path';
import { listClients, type Client } from '@/lib/clients';
import { readBuildState, readHandoff, readInterviewProgress } from '@/lib/interview/seam';

// ── Types (exported — UI imports these via `import type`) ────────────

export type InterviewBadgeState = 'complete' | 'in-progress' | 'not-started';
export type LivenessState = 'live' | 'offline' | 'unknown';
export type HealthState = 'ok' | 'error' | 'unknown';
export type PipelineStage = 'onboarding' | 'interview' | 'setup' | 'active' | 'unknown';

export interface FleetClientStatus {
  id: string;
  name: string;
  isSelf: boolean;
  interview: InterviewBadgeState;
  interviewDetail: string;   // short human text, e.g. '7/12 answers' or 'Complete'
  liveness: LivenessState;
  health: HealthState;
  pipelineStage: PipelineStage;
}

// ── Liveness probe (per-client gateway ping) ─────────────────────────

const LIVENESS_TIMEOUT_MS = 4_000;

/** Convert ws://→http://, wss://→https:// for a plain-HTTP probe. */
function gatewayHttpBase(gatewayUrl: string): string {
  if (gatewayUrl.startsWith('wss://')) return `https://${gatewayUrl.slice('wss://'.length)}`;
  if (gatewayUrl.startsWith('ws://')) return `http://${gatewayUrl.slice('ws://'.length)}`;
  return gatewayUrl;
}

/**
 * Ping the client's gateway over HTTP. Tries the root WS port (which returns
 * 426 for a real OpenClaw), then /health, then /api/status — the first
 * reachable endpoint wins. Honors gateway_token (as Bearer) and CF-Access
 * service-token headers when the client record supplies them. Never throws.
 */
async function probeClientLiveness(client: Client): Promise<LivenessState> {
  const url = (client.gateway_url ?? '').trim();
  if (!url) return 'unknown';

  const httpBase = gatewayHttpBase(url);
  const headers: Record<string, string> = {};
  if (client.cf_access_client_id)
    headers['CF-Access-Client-Id'] = client.cf_access_client_id;
  if (client.cf_access_client_secret)
    headers['CF-Access-Client-Secret'] = client.cf_access_client_secret;
  if (client.gateway_token) headers['Authorization'] = `Bearer ${client.gateway_token}`;

  const endpoints = [httpBase, `${httpBase}/health`, `${httpBase}/api/status`];

  for (const endpoint of endpoints) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), LIVENESS_TIMEOUT_MS);
      const res = await fetch(endpoint, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      clearTimeout(t);
      // Any reachable response from a known endpoint is "live".
      // We do NOT gate on OpenClaw-specific identity markers here:
      // (a) a remote client's gateway may sit behind a reverse proxy that
      //     transforms the response body, and
      // (b) the fleet-level liveness question is "is the box reachable?",
      //     not "is this definitely OpenClaw?" — the per-box System Status
      //     panel answers the latter.
      return 'live';
    } catch {
      // timeout or network error — try the next endpoint
      continue;
    }
  }

  return 'offline';
}

// ── Interview state (file-derived, per-client) ──────────────────────

/**
 * Read a client's .workforce-build-state.json from its configured
 * workspace_root. Returns null when the root is unset or the file is
 * absent/unreadable — callers degrade gracefully.
 */
function readClientBuildState(
  workspaceRoot: string | null | undefined,
): Record<string, unknown> | null {
  if (!workspaceRoot) return null;
  try {
    const p = path.join(workspaceRoot, '.workforce-build-state.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Parse a `key: value` frontmatter line from interview-handoff.md.
 *  Byte-identical to the seam's matchFrontmatter(). */
function matchFrontmatter(content: string, key: string): string | null {
  const re = new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, 'm');
  const m = re.exec(content);
  return m ? m[1].trim() : null;
}

function handoffToInt(v: string | null): number | null {
  if (v == null) return null;
  const n = parseInt(v.replace(/[^0-9-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Read interview-handoff.md from a client's workspace_root. Probes
 * company-discovery/ first (canonical), then the workspace root (flat fallback)
 * — exactly mirroring the seam's handoffFilePath() resolution.
 */
function readClientHandoff(workspaceRoot: string | null | undefined): {
  exists: boolean;
  totalQuestionsAnswered: number | null;
} {
  const base = { exists: false, totalQuestionsAnswered: null as number | null };
  if (!workspaceRoot) return base;
  const candidates = [
    path.join(workspaceRoot, 'company-discovery', 'interview-handoff.md'),
    path.join(workspaceRoot, 'interview-handoff.md'),
  ];
  let content = '';
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        content = fs.readFileSync(c, 'utf-8');
        break;
      }
    } catch {
      /* try next candidate */
    }
  }
  if (!content) return base;
  return {
    exists: true,
    totalQuestionsAnswered: handoffToInt(matchFrontmatter(content, 'total_questions_answered')),
  };
}

/** Builder-friendly helper: construct the interview result tuple. */
function interviewResult(
  badge: InterviewBadgeState,
  detail: string,
): { interview: InterviewBadgeState; interviewDetail: string } {
  return { interview: badge, interviewDetail: detail };
}

/**
 * Build the interview badge + human detail string from canonical files.
 *
 * Maps to the three-state badge:
 *   'complete'   — buildState.interviewComplete === true
 *   'in-progress' — handoff.totalQuestionsAnswered > 0 (some progress, not done)
 *   'not-started' — no progress detected
 *
 * Detail string: 'Complete' or 'N/Planned answers' or 'Not started'.
 */
function deriveInterview(client: Client): {
  interview: InterviewBadgeState;
  interviewDetail: string;
} {
  // ── SELF client: use the seam's host-local readers so the fleet result and
  //    /api/interview/state can never disagree (same functions, same files).
  if (client.is_self) {
    const buildState = readBuildState();
    const interviewComplete = buildState?.interviewComplete === true;
    if (interviewComplete) return interviewResult('complete', 'Complete');

    const handoff = readHandoff();
    const totalAnswered = handoff.totalQuestionsAnswered ?? 0;
    if (totalAnswered > 0) {
      const progress = readInterviewProgress(buildState);
      const planned =
        typeof progress.questionCountPlanned === 'number' && progress.questionCountPlanned > 0
          ? progress.questionCountPlanned
          : 30;
      return interviewResult('in-progress', `${totalAnswered}/${planned} answers`);
    }
    // Also check the progress stamp (lastQuestionNumber) — the handoff file
    // may not exist yet in very early-stage interviews but the progress block
    // was written by update-interview-state.sh.
    const progress = readInterviewProgress(buildState);
    const progLastQ =
      typeof progress.lastQuestionNumber === 'number' ? progress.lastQuestionNumber : 0;
    if (progLastQ > 0) {
      const planned =
        typeof progress.questionCountPlanned === 'number' && progress.questionCountPlanned > 0
          ? progress.questionCountPlanned
          : 30;
      return interviewResult('in-progress', `${progLastQ}/${planned} answers`);
    }
    return interviewResult('not-started', 'Not started');
  }

  // ── NON-SELF client: read directly from the client's configured workspace.
  if (!client.workspace_root) {
    return interviewResult('not-started', 'Unknown');
  }

  const buildState = readClientBuildState(client.workspace_root);
  const handoff = readClientHandoff(client.workspace_root);

  const interviewComplete = buildState?.interviewComplete === true;
  if (interviewComplete) return interviewResult('complete', 'Complete');

  const totalAnswered = handoff.totalQuestionsAnswered ?? 0;
  if (totalAnswered > 0) {
    const progress = (buildState?.interviewProgress ?? {}) as Record<string, unknown>;
    const planned =
      typeof progress.questionCountPlanned === 'number' && progress.questionCountPlanned > 0
        ? progress.questionCountPlanned
        : null;
    if (planned) return interviewResult('in-progress', `${totalAnswered}/${planned} answers`);
    return interviewResult('in-progress', `${totalAnswered} answers`);
  }

  return interviewResult('not-started', 'Not started');
}

/** Pipeline stage derived purely from interview badge (see module doc-comment). */
function derivePipelineStage(interview: InterviewBadgeState): PipelineStage {
  switch (interview) {
    case 'not-started':
      return 'onboarding';
    case 'in-progress':
      return 'interview';
    case 'complete':
      return 'active';
    // 'setup' reserved — see module doc-comment above.
  }
}

/** Health derived purely from liveness (see module doc-comment). */
function deriveHealth(liveness: LivenessState): HealthState {
  switch (liveness) {
    case 'live':
      return 'ok';
    case 'offline':
      return 'error';
    case 'unknown':
      return 'unknown';
  }
}

// ── Main export ──────────────────────────────────────────────────────

export async function getFleetStatus(): Promise<FleetClientStatus[]> {
  const clients = listClients();

  const results = await Promise.all(
    clients.map(async (client): Promise<FleetClientStatus> => {
      // Degraded fallback — always safe to return (no secrets, every field set).
      const degraded = (): FleetClientStatus => ({
        id: client.id,
        name: client.name,
        isSelf: client.is_self,
        interview: 'not-started',
        interviewDetail: 'Unknown',
        liveness: 'unknown',
        health: 'unknown',
        pipelineStage: 'onboarding',
      });

      try {
        // Interview (sync file reads) + liveness (async fetch) run concurrently
        // per client so a slow gateway never blocks the fast file read.
        const [interviewResult, liveness] = await Promise.all([
          Promise.resolve().then(() => deriveInterview(client)),
          probeClientLiveness(client),
        ]);

        return {
          id: client.id,
          name: client.name,
          isSelf: client.is_self,
          interview: interviewResult.interview,
          interviewDetail: interviewResult.interviewDetail,
          liveness,
          health: deriveHealth(liveness),
          pipelineStage: derivePipelineStage(interviewResult.interview),
        };
      } catch (err) {
        console.error(
          `[fleet] Failed to aggregate status for client ${client.id} (${client.name}):`,
          err instanceof Error ? err.message : err,
        );
        return degraded();
      }
    }),
  );

  return results;
}
