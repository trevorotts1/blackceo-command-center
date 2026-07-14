'use client';

/**
 * useCeoChatSession (U60 / JM-U63a — decomposed from the 437-line monolith)
 *
 * Owns everything the old `/my-ai-ceo/page.tsx` owned directly: the
 * persisted session id, the feature-flag + gateway-status poll, transcript +
 * spawned-task history (15s poll — the "silent fallback" spec (c) keeps
 * alongside the new SSE rail), the streaming send, and the upload pipeline.
 * Preserved verbatim (spec (h)): beta gating (redirect), degrade banner
 * source data, persist-before-forward (the route does this; this hook just
 * reflects the result), upload pipeline, session restore.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage, SpawnedTask } from './types';

const SESSION_KEY = 'my-ai-ceo-session-id';
const HISTORY_POLL_MS = 15000;
const STATUS_POLL_MS = 30000;

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
        body: JSON.stringify({ sessionId, message: text }),
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
  }, [input, streaming, sessionId, loadHistory]);

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
   *  under its own id; a fresh session id becomes the active one. */
  const startFreshSession = useCallback(() => {
    const fresh = globalThis.crypto?.randomUUID?.() ?? `sess-${Date.now()}`;
    try {
      localStorage.setItem(SESSION_KEY, fresh);
    } catch {}
    setSessionId(fresh);
    setMessages([]);
    setTasks([]);
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
