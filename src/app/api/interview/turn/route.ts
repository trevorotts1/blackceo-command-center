import { ensureTenantInterview } from '@/lib/interview/remote-store';
import { queryOne, run, timeNow } from '@/lib/db';
import { randomUUID } from 'crypto';
/**
 * POST /api/interview/turn
 *
 * The conversational spine of the /interview surface. Relays the owner's
 * message to the client's OWN OpenClaw agent (running the existing Skill-23
 * interview brain) over the local gateway, then returns the agent's next
 * reply so the UI can render it as an interviewer bubble.
 *
 * This route is a PURE RELAY:
 *   - It sends via getOpenClawClient().sendMessage(sessionId, content).
 *   - It NEVER shells out and it NEVER writes the interview state files
 *     (workforce-interview-answers.md / interview-handoff.md /
 *     .workforce-build-state.json). The agent owns every per-answer file
 *     write (answers -> handoff -> MEMORY.md -> update-interview-state.sh),
 *     so a genuine transcript + provenance trail is produced by the brain,
 *     not fabricated here. The structured-card / decision writers live in
 *     their own routes (/api/interview/answer, /api/interview/decision).
 *
 * Recipe copied from src/app/api/openclaw/sessions/route.ts
 * (dynamic='force-dynamic', getOpenClawClient() + connect()-or-503,
 * sendMessage). The reply is read back with the documented
 * getSessionHistory (sessions.history) RPC — the same one the
 * /api/openclaw/sessions/[id]/history route uses — so we never guess an
 * undocumented gateway event name.
 *
 * Gateway coupling is tolerated by design: on an unreachable gateway this
 * returns 503 and the UI falls back to structured cards (branding +
 * department board), which do not need the conversational agent.
 *
 * Two shapes over the same relay:
 *   - Default: buffered JSON — { sessionId, reply, pending }.
 *   - ?stream=1 (or { stream: true }): SSE (session -> delta* -> done),
 *     modeled on src/app/api/operator/bridge/send/route.ts, for streamed
 *     turns.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getOpenClawClient, type OpenClawClient } from '@/lib/openclaw/client';
import { resolveInterviewTenant, refuseUnverifiedTenant } from '@/lib/interview/tenant';
import {
  getClientInterviewState,
  setClientInterviewSessionId,
} from '@/lib/interview/client-interview-state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** How long we wait for the Skill-23 agent to produce its next reply before
 *  returning a `pending` result the UI can poll on. Bounded well under the
 *  gateway RPC's own 30s call timeout. Overridable per box. */
const REPLY_TIMEOUT_MS = Number(process.env.INTERVIEW_TURN_TIMEOUT_MS) || 20_000;
/** How often we re-read session history while waiting for the reply. */
const REPLY_POLL_INTERVAL_MS = Number(process.env.INTERVIEW_TURN_POLL_MS) || 1_200;

const requestSchema = z.object({
  // The owner's typed message. Empty is rejected — a turn must carry text.
  content: z.string().min(1).max(64_000),
  // Resume an existing gateway session; when absent we mint one (channel=web).
  sessionId: z.string().min(1).max(128).optional(),
  // Opt into the SSE variant from the body (query ?stream=1 also works).
  stream: z.boolean().optional(),
});

/* -------------------------------------------------------------------------- */
/* history parsing helpers                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Defensively reduce one gateway history entry to a { role, text } turn.
 * The gateway's sessions.history payload shape is not strictly documented
 * (the history route types it as `unknown[]`), so we tolerate the common
 * shapes: { role, content }, { role, text }, or a content-parts array
 * ({ content: [{ type:'text', text }] }). Returns null when no text is found.
 */
function extractTurn(entry: unknown): { role: string | null; text: string } | null {
  if (!entry || typeof entry !== 'object') return null;
  const o = entry as Record<string, unknown>;

  const role =
    typeof o.role === 'string'
      ? o.role
      : typeof o.author === 'string'
        ? o.author
        : typeof o.sender === 'string'
          ? o.sender
          : null;

  // Direct string fields first.
  for (const key of ['content', 'text', 'message', 'body']) {
    const v = o[key];
    if (typeof v === 'string' && v.trim()) return { role, text: v };
  }

  // Anthropic-style content-parts array: [{ type:'text', text:'...' }, ...].
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

/**
 * True when a history turn is FROM the agent (the interviewer), not the owner.
 * Explicit owner/human roles are excluded; everything else (assistant, agent,
 * model, or an unlabelled turn) is treated as the interviewer's voice.
 */
function isAgentTurn(role: string | null): boolean {
  if (!role) return true; // unlabelled -> assume agent output
  const r = role.toLowerCase();
  return r !== 'user' && r !== 'owner' && r !== 'human' && r !== 'client';
}

/** Ordered list of agent-voice texts currently in the session history. */
async function agentTexts(client: OpenClawClient, sessionId: string): Promise<string[]> {
  const history = await client.getSessionHistory(sessionId);
  if (!Array.isArray(history)) return [];
  const out: string[] = [];
  for (const entry of history) {
    const turn = extractTurn(entry);
    if (turn && isAgentTurn(turn.role)) out.push(turn.text);
  }
  return out;
}

/**
 * Poll session history until a NEW agent turn appears beyond `baselineCount`
 * (the number of agent turns present before we sent), or the timeout elapses.
 * Returns the newly-appended agent text (joined) or null on timeout. Never
 * throws: a history RPC error resolves to null so the caller degrades to a
 * `pending` result rather than a 500.
 */
async function waitForAgentReply(
  client: OpenClawClient,
  sessionId: string,
  baselineCount: number,
  deadlineMs: number,
  signal?: AbortSignal,
): Promise<string | null> {
  while (Date.now() < deadlineMs && !signal?.aborted) {
    await sleep(REPLY_POLL_INTERVAL_MS);
    if(signal?.aborted)return null;
    let texts: string[];
    try {
      texts = await agentTexts(client, sessionId);
    } catch {
      // Older gateway without sessions.history, or a transient error: stop
      // polling and let the caller return a pending result.
      return null;
    }
    if (texts.length > baselineCount) {
      return texts.slice(baselineCount).join('\n\n');
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* -------------------------------------------------------------------------- */
/* session + connection helpers                                                */
/* -------------------------------------------------------------------------- */

/**
 * Connect to the LOCAL gateway using the exact recipe from
 * src/app/api/openclaw/sessions/route.ts. Returns the connected client, or a
 * 503 NextResponse when the gateway is unreachable.
 */
async function connectOr503(req?: NextRequest): Promise<
  { ok: true; client: OpenClawClient } | { ok: false; response: NextResponse }
> {
  // JANET-INTERVIEW-FIX: a remote client's hostname relays the conversation to
  // THAT client's own gateway (its row's gateway_url + token), so the
  // interview runs on her box. Self keeps the historical local singleton.
  if (req) {
    const tenant = await resolveInterviewTenant(req);
    if (tenant.kind === 'unverified') return {ok:false,response:NextResponse.json({error:'forbidden'},{status:403})};
    if (tenant.kind === 'client' && !tenant.client?.gateway_url) return {ok:false,response:NextResponse.json({error:'client_gateway_not_configured'},{status:503})};
    if (tenant.kind === 'client' && tenant.client?.gateway_url) {
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
          return {
            ok: false,
            response: NextResponse.json(
              {
                error: 'gateway_unreachable',
                message:
                  'Your interviewer is reconnecting. You can keep answering the branding and department cards — they save without the chat.',
              },
              { status: 503 },
            ),
          };
        }
      }
      return { ok: true, client };
    }
  }
  const client = getOpenClawClient();
  if (!client.isConnected()) {
    try {
      await client.connect();
    } catch {
      return {
        ok: false,
        response: NextResponse.json(
          {
            error: 'gateway_unreachable',
            message:
              'Your interviewer is reconnecting. You can keep answering the branding and department cards — they save without the chat.',
          },
          { status: 503 },
        ),
      };
    }
  }
  return { ok: true, client };
}

/**
 * Resolve the gateway session for this turn: reuse the provided sessionId, or
 * mint a fresh web-channel session (peer = the Cloudflare-Access owner email
 * when present, so the agent can attribute the turn). The agent — not this
 * route — owns everything that happens inside the session.
 */
async function resolveSessionId(
  client: OpenClawClient,
  req: NextRequest,
  provided?: string,
): Promise<string> {
  // JANET-INTERVIEW-FIX phase 2: for a client tenant, prefer the session we
  // already persisted for that client. Without this the browser had nowhere to
  // read a prior session id from (/api/interview/state returned null for
  // clients), so every visit minted a NEW gateway session and the client met a
  // blank-slate interviewer that had forgotten the whole conversation.
  const tenant = await resolveInterviewTenant(req);
  if (!tenant.context) throw new Error('Verified interview context required');
  const tenantId=tenant.context.tenantId;
  const stored=ensureTenantInterview(tenantId);
  if(stored.gateway_session_id) {
    if(provided && provided!==stored.gateway_session_id)throw new Error('Foreign interview session');
    return stored.gateway_session_id;
  }
  if(req.signal.aborted)throw new Error('Interview request was cancelled');
  const reservation=randomUUID();
  const cutoff=new Date(Date.now()-60_000).toISOString();
  const claimed=run(`UPDATE tenant_interviews SET session_reservation=?,session_reserved_at=? WHERE tenant_id=? AND gateway_session_id IS NULL AND (session_reservation IS NULL OR session_reserved_at<?)`,[reservation,timeNow(),tenantId,cutoff]);
  if(!claimed.changes)throw new Error('Interview session is being established; retry shortly');
  try {
    const session=await client.createSession('web',tenant.context.subject);
    if(req.signal.aborted)throw new Error('Interview request was cancelled');
    const saved=run(`UPDATE tenant_interviews SET gateway_session_id=?,session_reservation=NULL,session_reserved_at=NULL,updated_at=? WHERE tenant_id=? AND session_reservation=? AND gateway_session_id IS NULL`,[session.id,timeNow(),tenantId,reservation]);
    if(!saved.changes)throw new Error('Session reservation expired; retry using the committed session');
    return session.id;
  } catch(err) {
    run('UPDATE tenant_interviews SET session_reservation=NULL,session_reserved_at=NULL WHERE tenant_id=? AND session_reservation=?',[tenantId,reservation]);
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/* SSE helpers (modeled on the bridge/send route)                              */
/* -------------------------------------------------------------------------- */

function sseEvent(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Stream the turn as Server-Sent Events. Emits the session id first (so the
 * client can pin subsequent turns), sends the message, then streams each new
 * agent turn as a `delta` as it appears in history, and closes with `done`.
 * The gateway is already connected by the caller (connect-or-503) before this
 * stream opens, so we only surface in-turn failures as `error` events here.
 */
function streamTurn(
  client: OpenClawClient,
  sessionId: string,
  content: string,
  signal?: AbortSignal,
): Response {
  let cancelled=false;
  const enqueue=(controller:ReadableStreamDefaultController<Uint8Array>,chunk:Uint8Array)=>{if(!cancelled&&!signal?.aborted)controller.enqueue(chunk);};
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      enqueue(controller,sseEvent('session', { sessionId }));

      let baseline: number;
      try {
        baseline = (await agentTexts(client, sessionId)).length;
      } catch {
        baseline = 0;
      }

      try {
        if(cancelled||signal?.aborted)return;
        await client.sendMessage(sessionId, content);
      } catch (err) {
        enqueue(controller,
          sseEvent('error', {
            message: `Failed to reach the interviewer: ${
              err instanceof Error ? err.message : String(err)
            }`,
          }),
        );
        enqueue(controller,sseEvent('done', { sessionId, pending: true }));
        if(!cancelled&&!signal?.aborted)controller.close();
        return;
      }

      const deadline = Date.now() + REPLY_TIMEOUT_MS;
      let emitted = baseline;
      while (Date.now() < deadline && !cancelled && !signal?.aborted) {
        await sleep(REPLY_POLL_INTERVAL_MS);
        if(cancelled||signal?.aborted)break;
        let texts: string[];
        try {
          texts = await agentTexts(client, sessionId);
        } catch {
          break; // history unavailable — end the stream as pending
        }
        if (texts.length > emitted) {
          for (const text of texts.slice(emitted)) {
            enqueue(controller,sseEvent('delta', { text }));
          }
          emitted = texts.length;
          break; // one interviewer turn per owner turn
        }
      }

      enqueue(controller,
        sseEvent('done', { sessionId, pending: emitted === baseline }),
      );
      if(!cancelled&&!signal?.aborted)controller.close();
    },
    cancel(){cancelled=true;},
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    },
  });
}

/* -------------------------------------------------------------------------- */
/* handler                                                                     */
/* -------------------------------------------------------------------------- */

export async function POST(req: NextRequest) {
  // Fail closed BEFORE any work: a forged Host must never reach the relay,
  // the session store, or a client's gateway. Covers the nested
  // resolveInterviewTenant() calls in connectOr503() and resolveSessionId().
  const refusedTenant = refuseUnverifiedTenant(await resolveInterviewTenant(req));
  if (refusedTenant) return refusedTenant;

  let body: z.infer<typeof requestSchema>;
  try {
    body = requestSchema.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      {
        error: 'invalid_request',
        detail: err instanceof Error ? err.message : 'bad body',
      },
      { status: 400 },
    );
  }

  const wantsStream =
    body.stream === true || new URL(req.url).searchParams.get('stream') === '1';

  const conn = await connectOr503(req);
  if (!conn.ok) return conn.response;
  const { client } = conn;

  let sessionId: string;
  try {
    sessionId = await resolveSessionId(client, req, body.sessionId);
  } catch (err) {
    return NextResponse.json(
      {
        error: 'session_unavailable',
        message: `Could not open an interview session on the gateway: ${
          err instanceof Error ? err.message : String(err)
        }`,
      },
      { status: 503 },
    );
  }

  if(req.signal.aborted)return NextResponse.json({error:'request_cancelled'},{status:499});

  if (wantsStream) {
    return streamTurn(client, sessionId, body.content, req.signal);
  }

  // Buffered JSON turn: snapshot the agent turns present, relay the message,
  // then wait (bounded) for the agent's next reply.
  let baselineCount: number;
  try {
    baselineCount = (await agentTexts(client, sessionId)).length;
  } catch {
    baselineCount = 0;
  }

  if(req.signal.aborted)return NextResponse.json({error:'request_cancelled'},{status:499});
  try {
    await client.sendMessage(sessionId, body.content);
  } catch (err) {
    return NextResponse.json(
      {
        error: 'send_failed',
        sessionId,
        message: `Failed to reach the interviewer: ${
          err instanceof Error ? err.message : String(err)
        }`,
      },
      { status: 503 },
    );
  }

  const reply = await waitForAgentReply(
    client,
    sessionId,
    baselineCount,
    Date.now() + REPLY_TIMEOUT_MS,
    req.signal,
  );

  return NextResponse.json({
    sessionId,
    reply: reply ?? null,
    // pending=true means the message was delivered but the interviewer's reply
    // had not landed within the window — the UI polls GET /api/interview/turn
    // (below) to fetch it when it lands, instead of forcing a resend.
    pending: reply === null,
    // Baseline agent-turn count for the recovery poll (?after=<agentCount>).
    agentCount: baselineCount + (reply === null ? 0 : 1),
  });
}

/* -------------------------------------------------------------------------- */
/* GET — pending-reply recovery (read-only)                                    */
/* -------------------------------------------------------------------------- */

/**
 * GET /api/interview/turn?sessionId=<id>&after=<agentCount>
 *
 * The recovery read for a `pending` POST: when the interviewer's reply had not
 * landed within the POST's bounded wait, the UI polls THIS endpoint until the
 * next agent turn appears in session history. Pure read — it sends nothing,
 * writes nothing, and reuses the exact same history parser as the POST path, so
 * a slow model turn is no longer a dead-end that forces the owner to re-send.
 *
 * Response: { sessionId, reply: string|null, agentCount } — reply carries any
 * agent text beyond `after` (joined), or null when nothing new has landed yet.
 */
export async function GET(req: NextRequest) {
  // Same fail-closed gate as POST: polling a client's gateway session is
  // reading client data and must not be reachable via a forged Host.
  const refusedTenant = refuseUnverifiedTenant(await resolveInterviewTenant(req));
  if (refusedTenant) return refusedTenant;

  const url = new URL(req.url);
  const sessionId = (url.searchParams.get('sessionId') ?? '').trim();
  const after = Math.max(0, parseInt(url.searchParams.get('after') ?? '0', 10) || 0);
  if (!sessionId) {
    return NextResponse.json(
      { error: 'invalid_request', detail: 'sessionId is required' },
      { status: 400 },
    );
  }

  const tenant=await resolveInterviewTenant(req);
  if(!tenant.context) return NextResponse.json({error:'forbidden'},{status:403});
  const owned=queryOne<{gateway_session_id:string}>('SELECT gateway_session_id FROM tenant_interviews WHERE tenant_id=?',[tenant.context.tenantId]);
  if(owned?.gateway_session_id!==sessionId)return NextResponse.json({error:'foreign_interview_session'},{status:403});

  const conn = await connectOr503(req);
  if (!conn.ok) return conn.response;

  let texts: string[];
  try {
    texts = await agentTexts(conn.client, sessionId);
  } catch {
    // Older gateway without sessions.history — report "nothing yet" rather than
    // a crash; the UI keeps its calm waiting state.
    return NextResponse.json({ error:'interview_history_unavailable', sessionId, retryable:true },{status:503});
  }

  const fresh = texts.length > after ? texts.slice(after).join('\n\n') : null;
  return NextResponse.json({
    sessionId,
    reply: fresh,
    agentCount: texts.length,
  });
}
