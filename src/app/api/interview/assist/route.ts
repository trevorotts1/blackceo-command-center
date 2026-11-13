/**
 * POST /api/interview/assist  (BU-17)
 *
 * "I am not sure" — the ONLY thing the conversational agent is allowed to do
 * during the required interview path: offer three example answers to tap.
 *
 * It never asks a question, never starts an interview and never creates a task:
 * the message it sends says so, and this route sends exactly ONE message per
 * call into the interview session that /api/interview/turn already owns. No
 * session is minted here — a helper the owner asks for must not be the thing
 * that opens a conversation.
 *
 * The owner ALWAYS gets something to tap. A gateway that is slow, unreachable
 * or refuses the message degrades to the question's own registry suggestions
 * (or its worked example), still with HTTP 200 and still `ok: true`. No error
 * detail is ever returned: failure text belongs in the server log.
 *
 * Response: { ok: true, suggestions: string[], pending: false }.
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getOpenClawClient, type OpenClawClient } from '@/lib/openclaw/client';
import { queryOne } from '@/lib/db';
import { resolveInterviewTenant, refuseUnverifiedTenant } from '@/lib/interview/tenant';
import { gateStateDir } from '@/lib/interview/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** How long the helper turn may take before the registry examples are used. */
const ASSIST_TIMEOUT_MS = 25_000;
/** How often the session history is re-read while the helper composes. */
const ASSIST_POLL_INTERVAL_MS = Number(process.env.INTERVIEW_ASSIST_POLL_MS) || 1_200;
/** A suggestion longer than this is not tappable copy. */
const MAX_SUGGESTION_CHARS = 200;
/** How many example answers the owner is offered. */
const MAX_SUGGESTIONS = 3;

const requestSchema = z.object({
  /** Registry question id the owner is stuck on. */
  questionId: z.string().min(1).max(128),
});

interface RegistryQuestion {
  id: string;
  prompt?: string;
  suggestions?: string[];
  example?: string;
}

const _require = createRequire(import.meta.url);
const registry = _require('../../../../lib/interview-questions.v2.json') as {
  questions?: RegistryQuestion[];
};

/** One registry question by id, or null when the deck does not know it. */
function findQuestion(questionId: string): RegistryQuestion | null {
  const questions = Array.isArray(registry.questions) ? registry.questions : [];
  return questions.find((q) => q && q.id === questionId) ?? null;
}

/** The question's prompt as a plain sentence (the gate's {team} placeholder is
 *  filled by the page, never by the agent). */
function plainPrompt(q: RegistryQuestion): string {
  return String(q.prompt ?? '')
    .replace(/\{team\}\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The examples the registry itself carries: its suggestions, else its example. */
function registrySuggestions(q: RegistryQuestion): string[] {
  const suggestions = Array.isArray(q.suggestions)
    ? q.suggestions.filter((s): s is string => typeof s === 'string' && !!s.trim())
    : [];
  if (suggestions.length) return suggestions;
  const example = typeof q.example === 'string' ? q.example.trim() : '';
  return example ? [example] : [];
}

/**
 * Values the step gate has ACCEPTED, from its own state file. A field is only
 * ever offered to the helper when the gate reports it as answered — a known
 * fact, a draft or a client record is never treated as an answer.
 */
function answeredValues(): Record<string, string> {
  try {
    const raw = fs.readFileSync(
      path.join(gateStateDir(), 'interview-gate-state.json'),
      'utf-8',
    );
    const parsed = JSON.parse(raw) as { answers?: Record<string, unknown> };
    const out: Record<string, string> = {};
    for (const [qid, entry] of Object.entries(parsed.answers ?? {})) {
      const value = entry && typeof entry === 'object' ? (entry as { value?: unknown }).value : null;
      if (typeof value === 'string' && value.trim()) out[qid] = value.trim();
    }
    return out;
  } catch {
    return {};
  }
}

/** The one message the helper receives (frozen wording — 01-BUILD-SPEC 2.x). */
function helperMessage(prompt: string, answered: Record<string, string>): string {
  const known: string[] = [];
  if (answered.company_name) known.push(`company "${answered.company_name}"`);
  if (answered.industry) known.push(`business "${answered.industry}"`);
  if (answered.what_you_sell) known.push(`sells "${answered.what_you_sell}"`);
  const lines = [
    '[INTERVIEW-HELPER] You are helping a business owner answer one setup question. ' +
      'Do not ask them anything. Do not start an interview. Do not create tasks. ' +
      'Reply with exactly three short example answers, one per line, no numbering, no other text.',
    `Question: ${prompt}`,
  ];
  if (known.length) lines.push(`What we know: ${known.join(', ')}.`);
  return lines.join('\n');
}

/** First three non-empty reply lines that are short enough to tap. */
function suggestionsFromReply(reply: string): string[] {
  return reply
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.length <= MAX_SUGGESTION_CHARS)
    .slice(0, MAX_SUGGESTIONS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True when a history turn is the agent's voice (never the owner's, never tool output). */
function isAgentRole(role: string | null): boolean {
  if (!role) return true; // unlabelled -> agent output
  const r = role.toLowerCase();
  if (r.startsWith('tool') || r === 'function' || r === 'system') return false;
  return r !== 'user' && r !== 'owner' && r !== 'human' && r !== 'client';
}

/** One history entry reduced to { role, text }, or null when it carries no text. */
function extractTurn(entry: unknown): { role: string | null; text: string } | null {
  if (!entry || typeof entry !== 'object') return null;
  const o = entry as Record<string, unknown>;
  const role =
    typeof o.role === 'string' ? o.role : typeof o.author === 'string' ? o.author : null;
  for (const key of ['content', 'text', 'message', 'body']) {
    const v = o[key];
    if (typeof v === 'string' && v.trim()) return { role, text: v };
  }
  const content = o.content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (part && typeof part === 'object') {
        const t = (part as Record<string, unknown>).text;
        if (typeof t === 'string' && t.trim()) parts.push(t);
      } else if (typeof part === 'string' && part.trim()) {
        parts.push(part);
      }
    }
    if (parts.length) return { role, text: parts.join('') };
  }
  return null;
}

/** The agent-voice texts in one history array (same reading as turn/route.ts). */
function agentTexts(history: unknown[]): string[] {
  const out: string[] = [];
  for (const entry of history) {
    const turn = extractTurn(entry);
    if (turn && isAgentRole(turn.role)) out.push(turn.text);
  }
  return out;
}

/**
 * Wait for the helper's turn to settle and return its LAST assistant text, or
 * null on timeout. Settled = the newest entry is the agent's and two
 * consecutive polls saw the same number of entries, so a narration line that
 * lands first is never mistaken for the three example answers.
 */
async function waitForHelperReply(
  client: OpenClawClient,
  sessionId: string,
  baselineCount: number,
  deadlineMs: number,
): Promise<string | null> {
  let previousCount = -1;
  while (Date.now() < deadlineMs) {
    await sleep(ASSIST_POLL_INTERVAL_MS);
    let history: unknown[];
    try {
      history = await client.getSessionHistory(sessionId);
    } catch {
      return null;
    }
    if (!Array.isArray(history)) return null;
    const newest = history.length ? extractTurn(history[history.length - 1]) : null;
    if (
      history.length > baselineCount &&
      history.length === previousCount &&
      !!newest &&
      isAgentRole(newest.role)
    ) {
      const texts = agentTexts(history);
      return texts.length ? texts[texts.length - 1] : null;
    }
    previousCount = history.length;
  }
  return null;
}

/** The connected client for this caller's own interview, or null. */
async function interviewClient(req: NextRequest): Promise<OpenClawClient | null> {
  const tenant = await resolveInterviewTenant(req);
  if (tenant.kind === 'client' && tenant.client) {
    if (!tenant.client.gateway_url) return null;
    const client = getOpenClawClient({
      id: tenant.client.id,
      url: tenant.client.gateway_url,
      token: tenant.client.gateway_token ?? null,
      cfAccessClientId: tenant.client.cf_access_client_id ?? null,
      cfAccessClientSecret: tenant.client.cf_access_client_secret ?? null,
    });
    if (!client.isConnected()) {
      try {
        await client.connect();
      } catch {
        return null;
      }
    }
    return client;
  }
  const client = getOpenClawClient();
  if (!client.isConnected()) {
    try {
      await client.connect();
    } catch {
      return null;
    }
  }
  return client;
}

export async function POST(req: NextRequest) {
  const tenant = await resolveInterviewTenant(req);
  const refusedTenant = refuseUnverifiedTenant(tenant);
  if (refusedTenant) return refusedTenant;

  let body: z.infer<typeof requestSchema>;
  try {
    body = requestSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_request' }, { status: 400 });
  }

  const question = findQuestion(body.questionId);
  if (!question) {
    return NextResponse.json({ ok: false, error: 'unknown_question' }, { status: 400 });
  }

  const fallback = registrySuggestions(question);
  const giveSomethingToTap = () =>
    NextResponse.json({ ok: true, suggestions: fallback, pending: false });

  if (!tenant.context) return giveSomethingToTap();

  // The session /api/interview/turn already owns for this interview. A helper
  // never opens a conversation of its own.
  const sessionId = queryOne<{ gateway_session_id: string | null }>(
    'SELECT gateway_session_id FROM tenant_interviews WHERE tenant_id=?',
    [tenant.context.tenantId],
  )?.gateway_session_id;
  if (!sessionId) return giveSomethingToTap();

  const client = await interviewClient(req);
  if (!client) return giveSomethingToTap();

  let baselineCount: number;
  try {
    const history = await client.getSessionHistory(sessionId);
    baselineCount = Array.isArray(history) ? history.length : 0;
  } catch {
    return giveSomethingToTap();
  }

  try {
    await client.sendMessage(sessionId, helperMessage(plainPrompt(question), answeredValues()));
  } catch (err) {
    // Never the raw reason: it belongs in the log, not on the owner's screen.
    console.error('[interview/assist] the gateway did not accept the helper message', err);
    return giveSomethingToTap();
  }

  const reply = await waitForHelperReply(
    client,
    sessionId,
    baselineCount,
    Date.now() + ASSIST_TIMEOUT_MS,
  );
  const suggestions = reply ? suggestionsFromReply(reply) : [];
  return NextResponse.json({
    ok: true,
    suggestions: suggestions.length ? suggestions : fallback,
    pending: false,
  });
}
