/**
 * Interview re-engagement nudge sweep (Wave 5, P3-5).
 *
 * The Command-Center-native counterpart to the box-side
 * shared-utils/nudge-incomplete-interviews.py builder: it re-engages an owner
 * who STARTED the Skill-23 AI-Workforce interview and then went quiet, by
 * sending them a single Telegram message carrying a working resume link that
 * matches the P0-7 slug contract:
 *
 *     ${OPENCLAW_DASHBOARD_URL}/onboarding/resume/<slug>
 *
 * (the exact route src/app/onboarding/resume/[slug]/page.tsx redirects to
 * /interview, which resumes at next_question_number from the handoff file).
 *
 * DOCTRINE (do not violate):
 *   • FILES ARE THE SOURCE OF TRUTH. Interview progress is read ONLY through the
 *     P0-1 seam's pure-fs readers (readBuildState / readHandoff /
 *     readInterviewProgress). This job NEVER writes a canonical artifact, NEVER
 *     writes interviewComplete, NEVER records a decision, and shells to NO
 *     Skill-23 script. Its only write is a benign audit/idempotency row in the
 *     `events` table.
 *   • IDEMPOTENT / NO SPAM. Each (interviewSessionId, tier) pair is nudged at
 *     most once, tracked by an `interview_nudge_sent` event ledger row. Only the
 *     single HIGHEST crossed tier is ever sent per sweep, so a box that was down
 *     across several tiers sends ONE catch-up nudge, not a backlog.
 *   • SILENT / OPERATOR-SAFE. The message goes ONLY to the resolved client owner
 *     chat id (notifyOwner already skips Trevor's operator id). Nothing is sent
 *     to the operator and no client-visible Live Feed event is broadcast. The
 *     ledger row is a quiet audit trail, not an SSE push.
 *   • OPT-IN until fleet rollout is released. The sweep is a no-op unless
 *     INTERVIEW_NUDGE_SWEEP_ENABLED=1 (repo-only until Trevor releases).
 *
 * Fail-safe by construction: every branch that cannot PROVE a nudge is due skips
 * (fail-closed → no message), the ledger row is written ONLY after a confirmed
 * send (a failed send retries next sweep instead of being silently swallowed),
 * and nothing here ever throws to the scheduler.
 *
 * Disable entirely with DISABLE_INTERVIEW_NUDGE_SWEEP=1. Enable with
 * INTERVIEW_NUDGE_SWEEP_ENABLED=1. Tune tiers with INTERVIEW_NUDGE_TIER_HOURS
 * (comma list, default "24,72,168"). Override the resume base with
 * OPENCLAW_DASHBOARD_URL (falls back to the Command Center URL).
 */

import { randomUUID } from 'crypto';
import { queryOne, run } from '@/lib/db';
import { getMissionControlUrl } from '@/lib/config';
import { readBuildState, readHandoff, readInterviewProgress } from '@/lib/interview/seam';
import { getSession } from '@/lib/interview/store';
import { notifyOwner } from '@/lib/notify';

/** Hourly, offset off the top of the hour so it never piles onto the :00 jobs. */
export const INTERVIEW_NUDGE_SWEEP_CRON = '23 * * * *';

const LEDGER_EVENT_TYPE = 'interview_nudge_sent';
const DEFAULT_TIER_HOURS = [24, 72, 168] as const;

export interface InterviewNudgeSweepResult {
  /** 1 when an in-progress interview was inspected, else 0. */
  scanned: number;
  /** 1 when a nudge was actually sent this run, else 0. */
  nudged: number;
  /** The tier (idle-hours threshold) that was sent, when one was. */
  tier?: number;
  /** The resume link that was sent, for logging. */
  link?: string;
  /** Set when the sweep intentionally did nothing. */
  skippedReason?: string;
}

/** Optional injected dependencies (testing seam). Production uses the defaults. */
export interface InterviewNudgeDeps {
  /** Send the owner message; returns true on a confirmed send. Defaults to notifyOwner. */
  sendOwner?: (message: string) => boolean;
  /** Current time in ms (defaults to Date.now()) — lets tests drive idle windows. */
  now?: number;
}

/** Parse the configured tier list (env override → default), sorted ascending, deduped, positive. */
function tierHours(): number[] {
  const raw = process.env.INTERVIEW_NUDGE_TIER_HOURS;
  const parsed = raw
    ? raw
        .split(',')
        .map((s) => parseFloat(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0)
    : [...DEFAULT_TIER_HOURS];
  const uniqueSorted = Array.from(new Set(parsed)).sort((a, b) => a - b);
  return uniqueSorted.length ? uniqueSorted : [...DEFAULT_TIER_HOURS];
}

/** Parse a timestamp string to epoch ms, or null when unparseable/empty. */
function parseTs(v: unknown): number | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const t = Date.parse(v.trim());
  return Number.isFinite(t) ? t : null;
}

/** The resume-link base: the per-client public dashboard URL, else the CC URL. No trailing slash. */
function resumeBase(): string {
  const base = process.env.OPENCLAW_DASHBOARD_URL || getMissionControlUrl();
  return base.replace(/\/+$/, '');
}

/** Build the P0-7 slug-contract resume link for a session. */
export function buildResumeLink(sessionId: string): string {
  return `${resumeBase()}/onboarding/resume/${encodeURIComponent(sessionId)}`;
}

/** Gentle, non-accusatory, jargon-free owner copy per tier. */
function messageForTier(tier: number, link: string): string {
  if (tier >= 168) {
    return (
      'Your AI company is ready to finish whenever you are. ' +
      `Pick up your setup right where you left off: ${link}`
    );
  }
  if (tier >= 72) {
    return (
      'Your AI company setup is still waiting for you — it only takes a few more minutes. ' +
      `Continue here: ${link}`
    );
  }
  return (
    "You're partway through setting up your AI company. " +
    `Pick up where you left off whenever you're ready: ${link}`
  );
}

/** True when this exact (session, tier) nudge has already been recorded. Idempotency ledger. */
function alreadyNudged(sessionId: string, tier: number): boolean {
  try {
    const row = queryOne<{ c: number }>(
      `SELECT COUNT(*) AS c FROM events
       WHERE type = ?
         AND json_extract(metadata, '$.sessionId') = ?
         AND json_extract(metadata, '$.tier') = ?`,
      [LEDGER_EVENT_TYPE, sessionId, tier],
    );
    return (row?.c ?? 0) > 0;
  } catch {
    // If we cannot READ the ledger we fail-closed (treat as already-sent) so a
    // broken ledger can never turn into a spam loop.
    return true;
  }
}

/** Record a delivered nudge in the audit/idempotency ledger. Best-effort. */
function recordNudge(sessionId: string, tier: number, link: string, ownerId: string | null): void {
  try {
    run(
      `INSERT INTO events (id, type, task_id, message, metadata, created_at)
       VALUES (?, ?, NULL, ?, ?, datetime('now'))`,
      [
        randomUUID(),
        LEDGER_EVENT_TYPE,
        `Interview resume nudge sent (tier ${tier}h)`,
        JSON.stringify({ sessionId, tier, link, ownerId }),
      ],
    );
  } catch (err) {
    console.warn('[interview-nudge] ledger write failed (non-fatal):', (err as Error).message);
  }
}

/**
 * Run one nudge sweep. Reads canonical interview state (files-first), decides
 * whether a paused-interview owner is due for exactly one re-engagement nudge,
 * sends it, and records it. Never throws.
 */
export async function runInterviewNudgeSweep(
  deps: InterviewNudgeDeps = {},
): Promise<InterviewNudgeSweepResult> {
  const now = deps.now ?? Date.now();
  const send = deps.sendOwner ?? notifyOwner;

  if (
    process.env.DISABLE_INTERVIEW_NUDGE_SWEEP === '1' ||
    process.env.DISABLE_INTERVIEW_NUDGE_SWEEP === 'true'
  ) {
    return { scanned: 0, nudged: 0, skippedReason: 'DISABLE_INTERVIEW_NUDGE_SWEEP set' };
  }
  if (
    process.env.INTERVIEW_NUDGE_SWEEP_ENABLED !== '1' &&
    process.env.INTERVIEW_NUDGE_SWEEP_ENABLED !== 'true'
  ) {
    // Repo-only until fleet rollout is released — dormant by default.
    return { scanned: 0, nudged: 0, skippedReason: 'INTERVIEW_NUDGE_SWEEP_ENABLED not set' };
  }

  // ── Read canonical state (pure fs, no scripts, no writes) ──────────────────
  const buildState = readBuildState();

  // An interview must be genuinely started AND not finished to be nudgeable.
  if (buildState?.interviewComplete === true || buildState?.buildCompletedAt) {
    return { scanned: 1, nudged: 0, skippedReason: 'interview already complete' };
  }

  // The slug IS the stable interviewSessionId. It is minted by the first
  // answer/decision write (mirror-on-write), so any owner who has actually
  // engaged the interview has one; its absence means nothing to resume.
  const sessionId =
    buildState?.interviewSessionId && String(buildState.interviewSessionId).trim()
      ? String(buildState.interviewSessionId).trim()
      : '';
  if (!sessionId) {
    return { scanned: 0, nudged: 0, skippedReason: 'no interviewSessionId — nothing started' };
  }

  const handoff = readHandoff();
  const progress = readInterviewProgress(buildState);

  const started =
    handoff.exists ||
    (typeof progress.lastQuestionNumber === 'number' && progress.lastQuestionNumber > 0);
  if (!started) {
    return { scanned: 1, nudged: 0, skippedReason: 'interview not started' };
  }

  // ── Reuse the client/session mirror row (owner id + a fallback activity ts) ──
  let sessionRow;
  try {
    sessionRow = getSession(sessionId);
  } catch {
    sessionRow = undefined;
  }
  const ownerId = sessionRow?.owner_id ?? null;

  // Last activity = the MOST RECENT canonical progress signal, mirror ts as a
  // last resort. Without any parseable timestamp we cannot prove idleness → skip.
  const activityCandidates = [
    parseTs(handoff.lastUpdated),
    parseTs(progress.lastQuestionAt),
    parseTs(sessionRow?.updated_at),
  ].filter((n): n is number => n !== null);
  if (activityCandidates.length === 0) {
    return { scanned: 1, nudged: 0, skippedReason: 'no parseable last-activity timestamp' };
  }
  const lastActivity = Math.max(...activityCandidates);
  const idleHours = (now - lastActivity) / (1000 * 60 * 60);

  // Highest crossed tier only (single catch-up nudge, never a backlog).
  const crossed = tierHours().filter((t) => idleHours >= t);
  if (crossed.length === 0) {
    return { scanned: 1, nudged: 0, skippedReason: `not idle enough (${idleHours.toFixed(1)}h)` };
  }
  const tier = crossed[crossed.length - 1];

  if (alreadyNudged(sessionId, tier)) {
    return { scanned: 1, nudged: 0, tier, skippedReason: `tier ${tier}h already nudged` };
  }

  // ── Send exactly one owner nudge, record ONLY on confirmed delivery ────────
  const link = buildResumeLink(sessionId);
  let delivered = false;
  try {
    delivered = send(messageForTier(tier, link));
  } catch (err) {
    console.warn('[interview-nudge] send failed (non-fatal):', (err as Error).message);
    delivered = false;
  }
  if (!delivered) {
    // No owner chat id / send failed / Telegram disabled — do NOT record, so the
    // next sweep retries. No spam risk: nothing was sent.
    return { scanned: 1, nudged: 0, tier, link, skippedReason: 'owner not reachable — will retry' };
  }

  recordNudge(sessionId, tier, link, ownerId);
  return { scanned: 1, nudged: 1, tier, link };
}
