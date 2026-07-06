/**
 * POST /api/interview/send-link — OPERATOR-TRIGGERED interview link delivery.
 *
 * The one sanctioned way to hand the owner their AI Workforce Interview link
 * over Telegram: "when you're ready, start here". It exists so the operator
 * can trigger the invitation deliberately (from the box: curl with the
 * MC_API_TOKEN bearer) instead of the client ever being auto-spammed.
 *
 *   • START mode  — nothing answered yet → link to /interview with
 *                   "when you're ready, start here" copy.
 *   • RESUME mode — an interview is underway → the P0-7 slug-contract resume
 *                   link (/onboarding/resume/<sessionId>) with "pick up where
 *                   you left off" copy.
 *
 * DOCTRINE (do not violate):
 *   • OPERATOR-TRIGGERED ONLY. No cron calls this; nothing auto-fires it. The
 *     re-engagement cadence lives in the (separately gated) nudge sweep.
 *   • GATEWAY-ONLY. Delivery goes through notifyOwner → `openclaw message
 *     send` (the OpenClaw gateway). Never the Telegram Bot API directly.
 *   • NO SECRETS, NO CHAT IDS. The response and the ledger carry the link and
 *     the mode — never the resolved chat id, never any token.
 *   • FILES ARE THE SOURCE OF TRUTH. Interview state is read through the P0-1
 *     seam's pure fs readers; this route writes NO canonical artifact. Its only
 *     write is the `interview_link_sent` audit/cooldown row in `events`.
 *   • ANTI-SPAM. A confirmed send within the cooldown window (default 30 min)
 *     409s unless `force: true` — a double-pressed trigger never double-texts
 *     the owner.
 *
 * Auth: bearer MC_API_TOKEN (same gate as /api/system/converge|bootstrap).
 * When MC_API_TOKEN is unset (local dev) the gate is open, matching those
 * routes; the P0-5 middleware still rejects external callers fail-closed.
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { queryOne, run } from '@/lib/db';
import { getMissionControlUrl } from '@/lib/config';
import { readBuildState, readHandoff, readInterviewProgress } from '@/lib/interview/seam';
import { buildResumeLink } from '@/lib/jobs/interview-nudge-sweep';
import { notifyOwner } from '@/lib/notify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const LEDGER_EVENT_TYPE = 'interview_link_sent';
/** Minimum minutes between confirmed sends (double-press / double-operator guard). */
const COOLDOWN_MINUTES = 30;

const requestSchema = z
  .object({
    /** Bypass the cooldown (a deliberate operator re-send). */
    force: z.boolean().optional(),
  })
  .strict()
  .optional();

/** The public dashboard base (per-client URL when set), no trailing slash. */
function dashboardBase(): string {
  const base = process.env.OPENCLAW_DASHBOARD_URL || getMissionControlUrl();
  return base.replace(/\/+$/, '');
}

/** Jargon-free owner copy. The link must be the only "instruction". */
function startMessage(link: string): string {
  return (
    'Your AI Workforce Interview is ready — a short conversation in your own ' +
    'words, and we build your company from what you tell us. When you are ' +
    `ready, start here: ${link}\n\n` +
    'It works great on your phone. Every answer is saved as you go, so you ' +
    'can pause anytime and pick up right where you left off.'
  );
}

function resumeMessage(link: string): string {
  return (
    'Welcome back — your interview is saved exactly where you left off. ' +
    `Continue here: ${link}\n\n` +
    'It works great on your phone, and you can pause again anytime.'
  );
}

/** Minutes since the last confirmed send, or null when never sent. */
function minutesSinceLastSend(): number | null {
  try {
    const row = queryOne<{ last: string | null }>(
      `SELECT MAX(created_at) AS last FROM events WHERE type = ?`,
      [LEDGER_EVENT_TYPE],
    );
    if (!row?.last) return null;
    const t = Date.parse(`${row.last}Z`) || Date.parse(row.last);
    if (!Number.isFinite(t)) return null;
    return (Date.now() - t) / 60_000;
  } catch {
    // Unreadable ledger → fail-closed (treat as just-sent) so a broken ledger
    // can never turn into a spam vector.
    return 0;
  }
}

/** Record a confirmed delivery (audit + cooldown). Best-effort. */
function recordSend(mode: 'start' | 'resume', link: string): void {
  try {
    run(
      `INSERT INTO events (id, type, task_id, message, metadata, created_at)
       VALUES (?, ?, NULL, ?, ?, datetime('now'))`,
      [
        randomUUID(),
        LEDGER_EVENT_TYPE,
        `Interview ${mode} link sent to owner (operator-triggered)`,
        JSON.stringify({ mode, link }),
      ],
    );
  } catch (err) {
    console.warn('[interview-send-link] ledger write failed (non-fatal):', (err as Error).message);
  }
}

// ── Auth gate (mirrors system/converge + system/bootstrap) ───────────────────
function checkAuth(req: NextRequest): NextResponse | null {
  const expectedToken = process.env.MC_API_TOKEN;
  if (!expectedToken) {
    console.warn(
      '[/api/interview/send-link] MC_API_TOKEN not set, bearer auth disabled (local dev mode)',
    );
    return null;
  }
  const authHeader = req.headers.get('authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : '';
  if (token !== expectedToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}

export async function POST(req: NextRequest) {
  const authError = checkAuth(req);
  if (authError) return authError;

  let body: z.infer<typeof requestSchema>;
  try {
    const text = await req.text();
    body = text.trim() ? requestSchema.parse(JSON.parse(text)) : undefined;
  } catch (err) {
    return NextResponse.json(
      { error: 'invalid_request', detail: err instanceof Error ? err.message : 'bad body' },
      { status: 400 },
    );
  }

  // ── Read canonical interview state (pure fs; no scripts, no writes) ────────
  const state = readBuildState();
  if (state?.interviewComplete === true || state?.buildCompletedAt) {
    return NextResponse.json(
      {
        ok: false,
        error: 'interview_complete',
        message: 'The interview is already complete — there is nothing to invite the owner to.',
      },
      { status: 409 },
    );
  }

  // Started = a handoff exists or a question has been stamped. The stable
  // interviewSessionId gives the resume link its slug.
  const handoff = readHandoff();
  const progress = readInterviewProgress(state);
  const sessionId =
    state?.interviewSessionId && String(state.interviewSessionId).trim()
      ? String(state.interviewSessionId).trim()
      : '';
  const started =
    !!sessionId &&
    (handoff.exists ||
      (typeof progress.lastQuestionNumber === 'number' && progress.lastQuestionNumber > 0));

  const mode: 'start' | 'resume' = started ? 'resume' : 'start';
  const link = started ? buildResumeLink(sessionId) : `${dashboardBase()}/interview`;

  // ── Cooldown (double-press guard) ───────────────────────────────────────────
  if (body?.force !== true) {
    const mins = minutesSinceLastSend();
    if (mins !== null && mins < COOLDOWN_MINUTES) {
      return NextResponse.json(
        {
          ok: false,
          error: 'cooldown',
          message: `An interview link was already sent ${Math.round(mins)} minute(s) ago. Pass { "force": true } to re-send deliberately.`,
          link,
          mode,
        },
        { status: 409 },
      );
    }
  }

  // ── Deliver via the gateway (notifyOwner resolves the owner chat id and
  //    rejects operator ids; we never see or return the chat id here). ────────
  const message = mode === 'resume' ? resumeMessage(link) : startMessage(link);
  const delivered = notifyOwner(message);
  if (!delivered) {
    return NextResponse.json(
      {
        ok: false,
        error: 'owner_not_reachable',
        message:
          'The owner has no reachable Telegram chat yet (not paired / not in allowFrom), or the gateway send failed. Nothing was recorded — safe to retry.',
        link,
        mode,
      },
      { status: 502 },
    );
  }

  recordSend(mode, link);
  return NextResponse.json({ ok: true, link, mode });
}
