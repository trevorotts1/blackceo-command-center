'use client';

/**
 * useCeoChatSession (U60 / JM-U63a — decomposed from the 437-line monolith;
 * U62 / JM-U65 adds Phase-B state)
 *
 * Owns everything the old `/my-ai-ceo/page.tsx` owned directly: the
 * persisted session id, the feature-flag + gateway-status poll, transcript +
 * spawned-task history (15s poll — the "silent fallback" spec (c) keeps
 * alongside the new SSE rail), the streaming send, and the upload pipeline.
 * Preserved verbatim (spec (h)): beta gating (redirect), degrade banner
 * source data, persist-before-forward (the route does this; this hook just
 * reflects the result), upload pipeline, session restore.
 *
 * U62 additions: the resolved agent/model live HERE (not in the page) so the
 * `onXResolved` (mount-time, silent) vs `onXUserChange` (explicit pick,
 * inserts exactly one system chip) distinction can sit right next to
 * `setMessages` — the single source of transcript truth. `thinkingLevel`
 * persists per session via sessionStorage (survives reload, per BINARY
 * acceptance). `send()` threads all three into the POST body; the response
 * stream's new `usage`/`routed` SSE events update `exactUsageTokens` (feeds
 * ContextMeter's exact mode) and are otherwise silently accepted (no chip —
 * `routed` is a transport-confirmation signal, not a user-facing event).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage, SpawnedTask, AgentOption, ModelOption, ThinkingLevel } from './types';

const SESSION_KEY = 'my-ai-ceo-session-id';
const THINKING_LEVEL_KEY_PREFIX = 'my-ai-ceo-thinking-';
const HISTORY_POLL_MS = 15000;
const STATUS_POLL_MS = 30000;
const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'Balanced';

export function useCeoChatSession() {
  const [sessionId, setSessionId] = useState<string>('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [tasks, setTasks] = useState<SpawnedTask[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [liveReply, setLiveReply] = useState('');
  const [gatewayUp, setGatewayUp] = useState<boolean | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [uploadNote, setUploadNote] = useState<string | null>(null);

  // U62 (JM/U65) Phase-B state.
  const [agent, setAgent] = useState<AgentOption | null>(null);
  const [model, setModel] = useState<ModelOption | null>(null);
  const [thinkingLevel, setThinkingLevelState] = useState<ThinkingLevel>(DEFAULT_THINKING_LEVEL);
  /** The gateway's real total token count for the last completed turn (S3).
   *  Null = estimate mode (ContextMeter's default); set on the first `usage`
   *  SSE event, reset to null by startFreshSession(). */
  const [exactUsageTokens, setExactUsageTokens] = useState<number | null>(null);

  // Session id (persisted so a reload continues the same thread) — preserved verbatim.
  useEffect(() => {
    let sid = '';
    try {
      sid = localStorage.getItem(SESSION_KEY) || '';
    } catch {}
    if (!sid) {
      sid = globalThis.crypto?.randomUUID?.() ?? `sess-${Date.now()}`;
      try {
        localStorage.setItem(SESSION_KEY, sid);
      } catch {}
    }
    setSessionId(sid);
  }, []);

  // U62 (JM/U65) — restore this session's thinking level from sessionStorage
  // (BINARY acceptance: "thinking level persists per session"). Runs once
  // sessionId is known; falls back to DEFAULT_THINKING_LEVEL (already the
  // initial state) when nothing was saved for this exact session.
  useEffect(() => {
    if (!sessionId) return;
    try {
      const saved = sessionStorage.getItem(THINKING_LEVEL_KEY_PREFIX + sessionId);
      if (saved) setThinkingLevelState(saved as ThinkingLevel);
    } catch {}
  }, [sessionId]);

  const setThinkingLevel = useCallback(
    (level: ThinkingLevel) => {
      setThinkingLevelState(level);
      try {
        if (sessionId) sessionStorage.setItem(THINKING_LEVEL_KEY_PREFIX + sessionId, level);
      } catch {}
    },
    [sessionId],
  );

  // U62 — mount-time (or any re-)resolution: always updates the active
  // model, NEVER inserts a chip (fires on first load too).
  const onModelResolved = useCallback((m: ModelOption | null) => setModel(m), []);
  // U62 — an EXPLICIT user pick from the open dropdown: inserts exactly one
  // system chip (BINARY acceptance) in addition to updating the active model.
  const onModelUserChange = useCallback((m: ModelOption) => {
    setModel(m);
    setMessages((prev) => [
      ...prev,
      {
        id: `sys-model-${Date.now()}`,
        role: 'system',
        content: `Switched model to ${m.label}.`,
        kind: 'model_change',
        task_id: null,
        created_at: new Date().toISOString(),
      },
    ]);
  }, []);

  const onAgentResolved = useCallback((a: AgentOption | null) => setAgent(a), []);
  const onAgentUserChange = useCallback((a: AgentOption) => {
    setAgent(a);
    setMessages((prev) => [
      ...prev,
      {
        id: `sys-agent-${Date.now()}`,
        role: 'system',
        content: `Switched to ${a.name}.`,
        kind: 'agent_switch',
        task_id: null,
        created_at: new Date().toISOString(),
      },
    ]);
  }, []);

  // Feature-flag + gateway status poll — preserved verbatim.
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch('/api/ceo-chat/status', { cache: 'no-store' });
        const data = await res.json();
        if (cancelled) return;
        setEnabled(data.enabled !== false);
        setGatewayUp(!!data.gateway?.up);
      } catch {
        if (!cancelled) setGatewayUp(false);
      }
    }
    poll();
    const t = setInterval(poll, STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const loadHistory = useCallback(async () => {
    if (!sessionId) return;
    try {
      const res = await fetch(`/api/ceo-chat/history?sessionId=${encodeURIComponent(sessionId)}`, {
        cache: 'no-store',
      });
      if (!res.ok) return;
      const data = await res.json();
      setMessages(Array.isArray(data.messages) ? data.messages : []);
      setTasks(Array.isArray(data.tasks) ? data.tasks : []);
    } catch {}
  }, [sessionId]);

  useEffect(() => {
    loadHistory();
    // 15-second poll retained as silent fallback (spec (c)) alongside the SSE
    // rail — see useOperationsRailEvents, which triggers loadHistory early too.
    const t = setInterval(loadHistory, HISTORY_POLL_MS);
    return () => clearInterval(t);
  }, [loadHistory]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming || !sessionId) return;
    setInput('');
    setStreaming(true);
    setLiveReply('');
    setMessages((m) => [
      ...m,
      { id: `local-${Date.now()}`, role: 'user', content: text, kind: 'message', task_id: null, created_at: new Date().toISOString() },
    ]);

    try {
      const res = await fetch('/api/ceo-chat/message', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          message: text,
          // U62 (JM/U65) Phase-B passthrough — the route validates/translates
          // thinkingLevel server-side (never trusts this UI label alone).
          ...(model ? { model: model.model_id } : {}),
          thinkingLevel,
          ...(agent ? { agentId: agent.id } : {}),
        }),
      });
      if (!res.body) throw new Error('no stream');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let acc = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const events = buf.split('\n\n');
        buf = events.pop() || '';
        for (const evt of events) {
          const evLine = evt.split('\n').find((l) => l.startsWith('event: '));
          const dataLine = evt.split('\n').find((l) => l.startsWith('data: '));
          if (!dataLine) continue;
          const ev = evLine ? evLine.slice(7).trim() : 'message';
          let payload: Record<string, unknown> = {};
          try {
            payload = JSON.parse(dataLine.slice(6));
          } catch {}
          if (ev === 'token') {
            acc += String(payload.text || '');
            setLiveReply(acc);
          } else if (ev === 'gateway_down') {
            setGatewayUp(false);
          } else if (ev === 'usage') {
            // U62/U61-S3 — the gateway's real per-turn token total. Feeds
            // ContextMeter's exact mode; the meter drops its estimate `≈`
            // the instant this arrives.
            const usage = payload.usage as { total?: unknown } | undefined;
            const total = Number(usage?.total);
            if (Number.isFinite(total)) setExactUsageTokens(total);
          } else if (ev === 'routed') {
            // U62/U61-S2 — transport-confirmation only (which agent the
            // session actually addressed); no chip, no state change beyond
            // what onAgentUserChange already recorded when the user picked it.
          } else if (ev === 'done') {
            break;
          }
        }
      }
    } catch {
      setGatewayUp(false);
    } finally {
      setStreaming(false);
      setLiveReply('');
      loadHistory();
    }
  }, [input, streaming, sessionId, loadHistory, model, thinkingLevel, agent]);

  const uploadFile = useCallback(
    async (file: File) => {
      if (!sessionId) return;
      setUploadNote(`Uploading ${file.name}…`);
      try {
        const fd = new FormData();
        fd.append('sessionId', sessionId);
        fd.append('file', file);
        const res = await fetch('/api/ceo-chat/upload', { method: 'POST', body: fd });
        const data = await res.json();
        if (!res.ok) {
          setUploadNote(data.error || 'Upload failed');
        } else {
          setUploadNote(`Shared ${data.name} with your AI CEO`);
          loadHistory();
        }
      } catch {
        setUploadNote('Upload failed');
      } finally {
        setTimeout(() => setUploadNote(null), 5000);
      }
    },
    [sessionId, loadHistory],
  );

  /** New session (context-meter "Start fresh session"): old thread stays retrievable
   *  under its own id; a fresh session id becomes the active one. U62: the new
   *  thread has no usage yet, so exactUsageTokens resets to null (the meter
   *  correctly reverts to estimate mode) and thinkingLevel resets to the
   *  default (the per-session sessionStorage load effect will pick up a
   *  saved value for the fresh id if one somehow already exists, but a truly
   *  fresh session never has one). */
  const startFreshSession = useCallback(() => {
    const fresh = globalThis.crypto?.randomUUID?.() ?? `sess-${Date.now()}`;
    try {
      localStorage.setItem(SESSION_KEY, fresh);
    } catch {}
    setSessionId(fresh);
    setMessages([]);
    setTasks([]);
    setExactUsageTokens(null);
    setThinkingLevelState(DEFAULT_THINKING_LEVEL);
  }, []);

  return {
    sessionId,
    messages,
    tasks,
    input,
    setInput,
    streaming,
    liveReply,
    gatewayUp,
    enabled,
    uploadNote,
    send,
    uploadFile,
    loadHistory,
    startFreshSession,
    // U62 (JM/U65) Phase-B.
    agent,
    model,
    thinkingLevel,
    setThinkingLevel,
    onModelResolved,
    onModelUserChange,
    onAgentResolved,
    onAgentUserChange,
    exactUsageTokens,
  };
}

/** Ref-stable accessor so callers that only need the latest session id inside
 *  an effect (e.g. the SSE rail) don't have to re-subscribe on every render. */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}
