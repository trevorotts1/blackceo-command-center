/**
 * POST /api/operator/bridge/send
 *
 * Bridge sub-module turn endpoint. The client posts:
 *
 *   { agent_id: string, session_id?: string, content: string, title?: string }
 *
 * The route:
 *   1. Resolves the agent in `BRIDGE_AGENTS`. Returns 400 if unknown.
 *   2. Creates a new `operator_chat_sessions` row when no `session_id` is
 *      provided. The session pins a per-agent scratch directory so the CLI
 *      writes files to the right place (PRD 4.3 + 4.4).
 *   3. Persists the user message to `operator_chat_messages`.
 *   4. Spawns the CLI (or calls the OpenClaw gateway), streaming output to
 *      the client as Server-Sent Events. The first event always carries the
 *      session id so the client can reconnect later via the stream route.
 *   5. On completion persists the assistant message to the same table.
 *
 * The route INTENTIONALLY keeps the request open for the full agent turn.
 * SSE over a POST is unconventional but works because the client uses
 * `fetch` + reader; we do not need EventSource here.
 *
 * Error handling:
 *   - Missing CLI binary: emit a `error` SSE event with install hint, then
 *     close. We do NOT 500 because the client already opened a reader.
 *   - Spawn error mid-stream: emit `error` SSE and persist the partial
 *     reply with metadata `{ aborted: true }`.
 *   - OpenClaw gateway disconnected: same treatment.
 *
 * Operator security: this route runs behind Cloudflare Access (Section 2.3).
 * The Next.js process does not re-authenticate.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { getDb } from '@/lib/db';
import { operatorScratchRoot } from '@/lib/platform';
import {
  getBridgeAgent,
  resolveAgentBin,
  fccProxyEnv,
  type BridgeAgent,
} from '@/lib/bridge/agents';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { bridgeOpenClawTarget, withClientContext } from '@/lib/bridge/dispatch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const requestSchema = z.object({
  agent_id: z.string().min(1).max(64),
  session_id: z.string().min(1).max(128).optional(),
  content: z.string().min(1).max(64_000),
  title: z.string().max(200).optional(),
});

interface SessionRow {
  id: string;
  agent_id: string;
  title: string | null;
  scratch_dir: string | null;
}

function ensureSession(args: {
  sessionId?: string;
  agentId: string;
  title?: string;
}): SessionRow {
  const db = getDb();
  if (args.sessionId) {
    const existing = db
      .prepare(
        'SELECT id, agent_id, title, scratch_dir FROM operator_chat_sessions WHERE id = ?',
      )
      .get(args.sessionId) as SessionRow | undefined;
    if (existing) return existing;
  }

  // New session: pin a per-agent scratch directory so the CLI's cwd lands
  // where the Workspace sub-module (B3) expects it. The directory is
  // created lazily because some agents (gateway) never need it.
  const id = randomUUID();
  const scratchDir = path.join(operatorScratchRoot(), args.agentId, id);
  db.prepare(
    `INSERT INTO operator_chat_sessions (id, agent_id, title, scratch_dir)
     VALUES (?, ?, ?, ?)`,
  ).run(id, args.agentId, args.title ?? null, scratchDir);

  return {
    id,
    agent_id: args.agentId,
    title: args.title ?? null,
    scratch_dir: scratchDir,
  };
}

function persistMessage(args: {
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  metadata?: Record<string, unknown>;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO operator_chat_messages (id, session_id, role, content, metadata)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    args.sessionId,
    args.role,
    args.content,
    JSON.stringify(args.metadata ?? {}),
  );
  db.prepare(
    `UPDATE operator_chat_sessions SET updated_at = datetime('now') WHERE id = ?`,
  ).run(args.sessionId);
}

/**
 * Build the env passed to a spawned CLI. The Next.js dev server's own
 * process.env can be missing SHELL or have a stripped PATH, which causes
 * agents to crash when they shell out. Force a baseline PATH that covers
 * the standard macOS bin dirs, Homebrew, and the user's local bin.
 */
function buildAgentEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const base = process.env;
  const ensurePath = [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    `${process.env.HOME ?? os.homedir()}/.local/bin`,
  ];
  const existing = (base.PATH ?? '').split(':').filter(Boolean);
  const merged = Array.from(new Set([...existing, ...ensurePath])).join(':');
  return {
    ...base,
    PATH: merged,
    SHELL: base.SHELL || '/bin/zsh',
    HOME: base.HOME || os.homedir(),
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    ...extra,
  };
}

/**
 * Build the argv for each agent. Each CLI has its own conventions; the
 * mapping below is what each agent's published 1.x CLI documents. Where
 * a CLI supports streaming JSON we ask for it; where it does not we let
 * it return the final text in one shot.
 */
function buildArgv(agent: BridgeAgent, prompt: string): string[] {
  switch (agent.id) {
    case 'claude':
    case 'fcc':
      // claude --print "..." --output-format=stream-json
      return ['--print', prompt, '--output-format', 'stream-json'];
    case 'codex':
      // codex exec --json "..."
      return ['exec', '--json', prompt];
    case 'gemini':
      // gemini --prompt "..." --json
      return ['--prompt', prompt, '--json'];
    case 'antigravity':
      // agy task "..."
      return ['task', prompt];
    case 'hermes':
      // hermes chat "..."
      return ['chat', prompt];
    default:
      return [prompt];
  }
}

/**
 * Parse one NDJSON line from a streaming CLI and return the delta text
 * the user should see. Claude and FCC use the Anthropic-style envelope;
 * Codex and Gemini have their own shapes. Unknown shapes are ignored
 * silently; the final assistant message reconstructed from all deltas.
 */
function parseDelta(agent: BridgeAgent, line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let evt: unknown;
  try {
    evt = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!evt || typeof evt !== 'object') return null;
  const o = evt as Record<string, unknown>;

  if (agent.id === 'claude' || agent.id === 'fcc') {
    // { type: 'stream_event', event: { delta: { text } } }
    const evtType = o.type;
    const inner = (o.event ?? {}) as Record<string, unknown>;
    const delta = (inner.delta ?? {}) as Record<string, unknown>;
    if (evtType === 'stream_event' && typeof delta.text === 'string') {
      return delta.text;
    }
    if (evtType === 'result' && typeof o.result === 'string') {
      return o.result;
    }
    return null;
  }

  if (agent.id === 'codex') {
    // Codex exec --json emits { type: 'message', content: '...' } or
    // { type: 'item.completed', text: '...' }. Be lenient.
    if (typeof o.content === 'string') return o.content;
    if (typeof o.text === 'string') return o.text;
    if (typeof o.delta === 'string') return o.delta;
    return null;
  }

  if (agent.id === 'gemini') {
    // { type: 'message', role: 'assistant', content: '...', delta: bool }
    if (
      o.type === 'message' &&
      o.role === 'assistant' &&
      typeof o.content === 'string'
    ) {
      return o.content;
    }
    if (o.type === 'result' && typeof o.text === 'string') {
      return o.text;
    }
    return null;
  }

  // antigravity / hermes do not stream NDJSON; their full text arrives on
  // close as raw stdout.
  return null;
}

function sseEvent(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
  );
}

async function runCli(args: {
  agent: BridgeAgent;
  prompt: string;
  session: SessionRow;
  controller: ReadableStreamDefaultController<Uint8Array>;
}): Promise<{ reply: string; aborted: boolean; errorText: string | null }> {
  const { agent, prompt, session, controller } = args;
  const bin = resolveAgentBin(agent);
  if (!bin) {
    const msg = `Agent ${agent.label} is not configured. Set ${agent.envBin} or install the CLI.`;
    controller.enqueue(sseEvent('error', { message: msg }));
    return { reply: '', aborted: true, errorText: msg };
  }

  // Pin the session's scratch dir as cwd so files land where Workspace
  // expects them. Create it on first use to keep gateway sessions cheap.
  if (session.scratch_dir) {
    try {
      fs.mkdirSync(session.scratch_dir, { recursive: true });
    } catch {
      // best effort
    }
  }

  const argv = buildArgv(agent, prompt);
  const extraEnv = agent.id === 'fcc' ? fccProxyEnv() : {};

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, argv, {
        cwd: session.scratch_dir ?? process.env.HOME,
        env: buildAgentEnv(extraEnv),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      const msg = `Failed to spawn ${bin}: ${err instanceof Error ? err.message : String(err)}`;
      controller.enqueue(sseEvent('error', { message: msg }));
      resolve({ reply: '', aborted: true, errorText: msg });
      return;
    }

    let reply = '';
    let stderrText = '';
    let buf = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (agent.streams) {
        // Streaming agents: parse NDJSON line by line.
        buf += text;
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const delta = parseDelta(agent, line);
          if (delta) {
            reply += delta;
            controller.enqueue(sseEvent('delta', { text: delta }));
          }
        }
      } else {
        // Single-shot agents: accumulate stdout as plain text.
        reply += text;
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrText += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      const msg = `${agent.label} crashed: ${err.message}`;
      controller.enqueue(sseEvent('error', { message: msg }));
      resolve({ reply, aborted: true, errorText: msg });
    });

    child.on('close', (code) => {
      // For non-streaming agents, push the whole reply now.
      if (!agent.streams && reply) {
        controller.enqueue(sseEvent('delta', { text: reply }));
      }
      if (code !== 0 && !reply) {
        const msg = stderrText.trim() || `${agent.label} exited with code ${code}`;
        controller.enqueue(sseEvent('error', { message: msg }));
        resolve({ reply, aborted: true, errorText: msg });
        return;
      }
      resolve({ reply, aborted: false, errorText: null });
    });

    // Write the prompt on stdin for agents that prefer it (none currently
    // require it, but harmless to close stdin promptly).
    try {
      child.stdin?.end();
    } catch {
      // ignore
    }
  });
}

async function runGateway(args: {
  prompt: string;
  session: SessionRow;
  controller: ReadableStreamDefaultController<Uint8Array>;
}): Promise<{ reply: string; aborted: boolean; errorText: string | null }> {
  // OpenClaw transport does NOT shell out. The PRD pins this: the chat
  // panel calls `getOpenClawClient().sendMessage(sessionId, content)`.
  // The gateway emits replies on its own event channel. Until the
  // streaming bridge for gateway events lands as a dedicated subscription
  // we emit a single delta carrying the reply (or a friendly placeholder
  // when the gateway has not yet acknowledged).
  // E21: target the SELECTED client's gateway (token + CF-Access headers),
  // NOT the loopback singleton, so the dispatch lands on the real per-client
  // box and its reply streams from there. Resolve the target ONCE so the catch
  // block reports the same client's device id.
  const target = bridgeOpenClawTarget();
  try {
    const client = getOpenClawClient(target);
    // Establish the operator.admin session before dispatching. This makes the
    // connect/pairing failure surface here (with an actionable message) rather
    // than only as the generic "Not connected" thrown by call().
    if (!client.isConnected()) {
      await client.connect();
    }
    // E12: prepend the operator's active goals so the client agent always has
    // them in context for this turn (no-op when there are no active goals).
    const dispatchPrompt = withClientContext(args.prompt);
    // The OpenClaw client expects a sessionId that the gateway minted via
    // sessions.create. We map the operator chat session 1:1 onto a gateway
    // session here. If the mapping has not been built yet a friendly
    // message is returned and the operator can wire it up later from the
    // System Status panel.
    await client.sendMessage(args.session.id, dispatchPrompt);
    const ack = 'Message dispatched to OpenClaw Gateway. The reply will arrive in the activity log when the agent completes the task.';
    args.controller.enqueue(sseEvent('delta', { text: ack }));
    return { reply: ack, aborted: false, errorText: null };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const deviceId = getOpenClawClient(target).getDeviceId();
    // A rejected handshake = the device is not approved on the gateway yet.
    const pairingPending = /pairing|Authentication failed|device/i.test(raw);
    const msg = pairingPending
      ? `OpenClaw Gateway pairing pending: device ${deviceId ?? 'unknown'} is not approved. On the gateway host run \`openclaw devices list\` then \`openclaw devices approve <requestId>\` (see docs/OPENCLAW_BRIDGE_PAIRING.md), then retry. (${raw})`
      : `OpenClaw Gateway unavailable: ${raw}`;
    args.controller.enqueue(sseEvent('error', { message: msg }));
    return { reply: '', aborted: true, errorText: msg };
  }
}

export async function POST(req: NextRequest) {
  let body: z.infer<typeof requestSchema>;
  try {
    const json = await req.json();
    body = requestSchema.parse(json);
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: 'invalid_request',
        detail: err instanceof Error ? err.message : 'bad body',
      }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  }

  const agent = getBridgeAgent(body.agent_id);
  if (!agent) {
    return new Response(
      JSON.stringify({ error: 'unknown_agent', agent_id: body.agent_id }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  }

  const session = ensureSession({
    sessionId: body.session_id,
    agentId: agent.id,
    title: body.title,
  });

  persistMessage({
    sessionId: session.id,
    role: 'user',
    content: body.content,
  });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(
        sseEvent('session', {
          session_id: session.id,
          agent_id: agent.id,
          scratch_dir: session.scratch_dir,
        }),
      );

      const started = Date.now();
      const result =
        agent.transport === 'gateway'
          ? await runGateway({ prompt: body.content, session, controller })
          : await runCli({ agent, prompt: body.content, session, controller });

      const elapsedMs = Date.now() - started;
      const metadata = {
        agent_id: agent.id,
        elapsed_ms: elapsedMs,
        aborted: result.aborted,
        error: result.errorText,
      };

      if (result.reply.trim()) {
        persistMessage({
          sessionId: session.id,
          role: 'assistant',
          content: result.reply,
          metadata,
        });
      }

      controller.enqueue(
        sseEvent('done', {
          session_id: session.id,
          elapsed_ms: elapsedMs,
          aborted: result.aborted,
        }),
      );
      controller.close();
    },
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
