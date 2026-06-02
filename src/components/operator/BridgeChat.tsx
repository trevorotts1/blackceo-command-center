'use client';

/**
 * BridgeChat
 *
 * The full Bridge sub-module chat surface (PRD 4.3):
 *   - Top bar: AgentSelector pill strip + session info + clear button
 *   - Main: message list with user/assistant bubbles, scrolling to bottom
 *           as new deltas arrive
 *   - Footer: MessageInput composer (textarea, mic, send/stop)
 *
 * Streaming protocol:
 *   - POST `/api/operator/bridge/send` keeps a single HTTP response open
 *     and emits Server-Sent Events. The route emits in this order:
 *       event: session   data: { session_id, agent_id, scratch_dir }
 *       event: delta     data: { text }         (zero or more)
 *       event: error     data: { message }      (zero or one)
 *       event: done      data: { session_id, elapsed_ms, aborted }
 *   - We parse the SSE bytes manually because the route is opened with
 *     `fetch` POST (EventSource cannot do POST). The parser handles
 *     fragmented frames across chunk boundaries.
 *
 * Session lifecycle:
 *   - Each agent has its own most-recent session, resolved on agent switch
 *     by GET `/api/operator/bridge/stream?agent_id=...`. If no session
 *     exists yet, the message list renders empty and the next send creates
 *     one server-side.
 *   - Switching agent mid-stream is forbidden (the AgentSelector reads
 *     `disabled={streaming}`).
 *
 * Call Mode handoff: the phone button lives next to the mic inside
 * `MessageInput.tsx` (link to `/operator/call`), so this file owns only
 * the message thread and exposes no extra hooks for Call Mode. The donor
 * pattern showed the integration can ride the same SSE stream without
 * coupling, so the composer-level link is enough.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Trash2 } from 'lucide-react';
import AgentSelector from './AgentSelector';
import MessageInput, { type PendingAttachment } from './MessageInput';
import {
  BRIDGE_AGENTS,
  getBridgeAgent,
  type BridgeAgent,
} from '@/lib/bridge/agents';

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  created_at: string;
  metadata?: Record<string, unknown>;
}

interface SSEFrame {
  event: string;
  data: string;
}

interface Props {
  /**
   * The agents visible on this install, computed server-side by the page from
   * the platform (VPS hides the Mac-desktop CLIs). When omitted, falls back to
   * the full catalogue so older callers / tests keep working.
   */
  agents?: BridgeAgent[];
  initialAgentId?: string;
}

const STORAGE_KEY = 'bcc-bridge:active-agent';

function loadInitialAgent(visible: BridgeAgent[], initial?: string): string {
  const isVisible = (id: string) => visible.some((a) => a.id === id);
  if (initial && isVisible(initial)) return initial;
  if (typeof window !== 'undefined') {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored && isVisible(stored)) return stored;
    } catch {
      // ignore
    }
  }
  return visible[0]?.id ?? BRIDGE_AGENTS[0].id;
}

/**
 * Parse a chunk of SSE bytes into discrete frames. Maintains a buffer of
 * leftover bytes across calls so a frame split across HTTP chunks is still
 * delivered intact.
 */
function makeSseParser(): (chunk: string) => SSEFrame[] {
  let buf = '';
  return (chunk: string): SSEFrame[] => {
    buf += chunk;
    const frames: SSEFrame[] = [];
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const lines = raw.split('\n');
      let event = 'message';
      const dataParts: string[] = [];
      for (const line of lines) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataParts.push(line.slice(5).trim());
      }
      frames.push({ event, data: dataParts.join('\n') });
    }
    return frames;
  };
}

export default function BridgeChat({ agents, initialAgentId }: Props) {
  // The visible agent set for this install. Defaults to the full catalogue so
  // the component still works if rendered without the server-computed prop.
  const visibleAgents: BridgeAgent[] =
    agents && agents.length > 0 ? agents : (BRIDGE_AGENTS as readonly BridgeAgent[]).slice();

  const [agentId, setAgentId] = useState<string>(() => loadInitialAgent(visibleAgents, initialAgentId));
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [partial, setPartial] = useState<string>('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const ctrlRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const startMsRef = useRef<number>(0);

  // Resolve the active agent within the visible set first; only fall back to
  // the global catalogue (then the first visible pill) if the id is unknown.
  const agent: BridgeAgent =
    visibleAgents.find((a) => a.id === agentId) ??
    getBridgeAgent(agentId) ??
    visibleAgents[0] ??
    (BRIDGE_AGENTS[0] as BridgeAgent);

  // Persist agent choice so a refresh keeps the operator on the same CLI.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, agentId);
    } catch {
      // ignore
    }
  }, [agentId]);

  // Replay the most recent session whenever the agent changes.
  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    setMessages([]);
    setSessionId(null);
    setPartial('');
    setError(null);

    async function load() {
      try {
        const r = await fetch(
          `/api/operator/bridge/stream?agent_id=${encodeURIComponent(agentId)}&limit=200`,
          { signal: ctrl.signal },
        );
        if (r.status === 404) return; // no prior session, blank thread is correct
        if (!r.ok || !r.body) return;
        const parse = makeSseParser();
        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const frames = parse(decoder.decode(value, { stream: true }));
          for (const f of frames) {
            if (cancelled) return;
            let payload: unknown;
            try {
              payload = JSON.parse(f.data);
            } catch {
              continue;
            }
            const obj = payload as Record<string, unknown>;
            if (f.event === 'session' && typeof obj.session_id === 'string') {
              setSessionId(obj.session_id);
            } else if (f.event === 'message') {
              setMessages((prev) => [...prev, payload as Message]);
            }
          }
        }
      } catch {
        // network/aborted, fine
      }
    }
    load();
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [agentId]);

  // Auto-scroll to the bottom on new content.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages, partial]);

  // Elapsed-time counter for non-streaming agents.
  useEffect(() => {
    if (!streaming) return;
    const t = setInterval(() => {
      setElapsedMs(Date.now() - startMsRef.current);
    }, 250);
    return () => clearInterval(t);
  }, [streaming]);

  const send = useCallback(
    async (text: string, attachment: PendingAttachment | null = null) => {
      if (streaming) return;
      // Show the attachment inline on the user's bubble so the operator can see
      // what they sent even before the agent acknowledges the file.
      const displayContent = attachment
        ? `${text}${text ? '\n\n' : ''}📎 ${attachment.filename}`
        : text;
      const userMsg: Message = {
        id: `u-${Date.now()}`,
        role: 'user',
        content: displayContent,
        created_at: new Date().toISOString(),
      };
      setMessages((m) => [...m, userMsg]);
      setPartial('');
      setError(null);
      setStreaming(true);
      startMsRef.current = Date.now();
      setElapsedMs(0);

      const ctrl = new AbortController();
      ctrlRef.current = ctrl;

      let acc = '';
      let resolvedSession = sessionId;

      try {
        const r = await fetch('/api/operator/bridge/send', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            agent_id: agentId,
            session_id: sessionId ?? undefined,
            content: text,
            attachment: attachment
              ? {
                  filename: attachment.filename,
                  content_type: attachment.contentType,
                  data_base64: attachment.base64,
                }
              : undefined,
          }),
          signal: ctrl.signal,
        });
        if (!r.ok || !r.body) {
          throw new Error(`HTTP ${r.status}`);
        }
        const parse = makeSseParser();
        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const frames = parse(decoder.decode(value, { stream: true }));
          for (const f of frames) {
            let payload: unknown = null;
            try {
              payload = JSON.parse(f.data);
            } catch {
              continue;
            }
            const obj = payload as Record<string, unknown>;
            if (f.event === 'session' && typeof obj.session_id === 'string') {
              resolvedSession = obj.session_id;
              setSessionId(obj.session_id);
            } else if (f.event === 'delta' && typeof obj.text === 'string') {
              acc += obj.text;
              setPartial(acc);
            } else if (f.event === 'error' && typeof obj.message === 'string') {
              setError(obj.message);
            } else if (f.event === 'done') {
              // closing handled below
            }
          }
        }
      } catch (err) {
        if ((err as { name?: string }).name !== 'AbortError') {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (acc.trim()) {
          setMessages((m) => [
            ...m,
            {
              id: `a-${Date.now()}`,
              role: 'assistant',
              content: acc,
              created_at: new Date().toISOString(),
              metadata: { agent_id: agentId, session_id: resolvedSession },
            },
          ]);
        }
        setPartial('');
        setStreaming(false);
        ctrlRef.current = null;
      }
    },
    [agentId, sessionId, streaming],
  );

  function stop() {
    ctrlRef.current?.abort();
    setStreaming(false);
    setPartial('');
  }

  function clearThread() {
    if (streaming) return;
    if (!confirm(`Clear visible ${agent.label} messages from this view?`)) return;
    setMessages([]);
    setPartial('');
    setError(null);
    // The session row itself stays in SQLite. Use a future Sessions list to
    // archive or delete sessions permanently.
  }

  const accent = agent.accent;

  return (
    <div className="flex flex-col h-[calc(100vh-160px)] min-h-[520px] rounded-xl border border-bcc-border bg-bcc-white overflow-hidden">
      {/* Top bar */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-bcc-border bg-bcc-white">
        <AgentSelector
          agents={visibleAgents}
          activeId={agentId}
          onSelect={(id) => {
            if (streaming) return;
            setAgentId(id);
          }}
          disabled={streaming}
        />
        <div className="flex items-center gap-3 shrink-0">
          {sessionId && (
            <span className="text-[10px] uppercase tracking-widest text-bcc-text-muted font-mono">
              session {sessionId.slice(0, 8)}
            </span>
          )}
          {messages.length > 0 && !streaming && (
            <button
              type="button"
              onClick={clearThread}
              className="flex items-center gap-1 text-[11px] uppercase tracking-widest text-bcc-text-muted hover:text-rose-500 transition"
              aria-label="Clear visible messages"
            >
              <Trash2 size={12} /> Clear
            </button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-3 bg-bcc-bg"
      >
        <AnimatePresence initial={false}>
          {messages.length === 0 && !streaming && (
            <motion.div
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="h-full grid place-items-center text-center py-12"
            >
              <div className="max-w-md">
                <div
                  className="mx-auto mb-3 w-12 h-12 rounded-2xl grid place-items-center"
                  style={{
                    background: `${accent}1a`,
                    border: `1px solid ${accent}33`,
                    color: accent,
                  }}
                >
                  <span className="text-[20px] font-bold">
                    {agent.label.slice(0, 1)}
                  </span>
                </div>
                <h3 className="text-card-title text-bcc-text">
                  Chat with {agent.label}
                </h3>
                <p className="mt-2 text-[14px] text-bcc-text-secondary leading-relaxed">
                  {agent.description}
                </p>
                <p className="mt-3 text-[12px] text-bcc-text-muted">
                  Latency: {agent.expectedLatency}
                </p>
              </div>
            </motion.div>
          )}

          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} accent={accent} />
          ))}

          {streaming && (
            <motion.div
              key="partial"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex gap-3"
            >
              <div
                className="w-8 h-8 rounded-full grid place-items-center shrink-0 text-[11px] font-bold"
                style={{
                  background: `${accent}1a`,
                  border: `1px solid ${accent}55`,
                  color: accent,
                }}
              >
                {agent.label.slice(0, 1)}
              </div>
              <div
                className="max-w-[78%] rounded-2xl rounded-tl-md px-4 py-2.5 text-[13.5px] leading-relaxed whitespace-pre-wrap border bg-bcc-white"
                style={{ borderColor: `${accent}55`, color: '#1A1D26' }}
              >
                {partial ? (
                  partial
                ) : (
                  <span className="inline-flex items-center gap-2 text-bcc-text-muted">
                    <span className="flex gap-1">
                      <span
                        className="w-1.5 h-1.5 rounded-full animate-pulse"
                        style={{ background: accent }}
                      />
                      <span
                        className="w-1.5 h-1.5 rounded-full animate-pulse"
                        style={{ background: accent, animationDelay: '0.15s' }}
                      />
                      <span
                        className="w-1.5 h-1.5 rounded-full animate-pulse"
                        style={{ background: accent, animationDelay: '0.3s' }}
                      />
                    </span>
                    <span>
                      {agent.label} thinking
                      {!agent.streams && elapsedMs > 0 && (
                        <span
                          className="ml-2 font-mono text-[12px]"
                          style={{ color: accent }}
                        >
                          {Math.floor(elapsedMs / 1000)}s
                        </span>
                      )}
                    </span>
                  </span>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {error && (
          <div
            role="alert"
            className="rounded-lg border border-rose-200 bg-rose-50 text-rose-700 text-[12.5px] px-3 py-2"
          >
            {error}
          </div>
        )}
      </div>

      {/* Composer */}
      <MessageInput
        agentLabel={agent.label}
        accent={accent}
        streaming={streaming}
        onSend={send}
        onStop={stop}
      />
    </div>
  );
}

function MessageBubble({ message, accent }: { message: Message; accent: string }) {
  const isUser = message.role === 'user';
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className={`flex gap-3 ${isUser ? 'flex-row-reverse' : ''}`}
    >
      {isUser ? (
        <div
          className="w-8 h-8 rounded-full grid place-items-center shrink-0 text-[10px] uppercase tracking-widest text-bcc-text-muted border border-bcc-border bg-bcc-white"
          aria-hidden="true"
        >
          you
        </div>
      ) : (
        <div
          className="w-8 h-8 rounded-full grid place-items-center shrink-0 text-[11px] font-bold"
          style={{
            background: `${accent}1a`,
            border: `1px solid ${accent}55`,
            color: accent,
          }}
          aria-hidden="true"
        >
          AI
        </div>
      )}
      <div
        className={`max-w-[78%] rounded-2xl px-4 py-2.5 text-[13.5px] leading-relaxed whitespace-pre-wrap ${
          isUser
            ? 'rounded-tr-md bg-bcc-white border border-bcc-border text-bcc-text'
            : 'rounded-tl-md border bg-bcc-white text-bcc-text'
        }`}
        style={isUser ? undefined : { borderColor: `${accent}55` }}
      >
        {message.content}
      </div>
    </motion.div>
  );
}
