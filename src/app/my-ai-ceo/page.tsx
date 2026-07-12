'use client';

/**
 * /my-ai-ceo — the BETA "My AI CEO" surface (P5-01 (c) step 3).
 *
 * Talk DIRECTLY to your main agent: send requests, upload documents/images/
 * videos, and watch what's happening. Responsive at 360 / 768 / 1280 — the side
 * rail stacks under the chat on mobile, the composer stays reachable, and the
 * whole page never scrolls the body horizontally.
 *
 * BETA posture: clearly labeled, feature-flagged (redirects home when disabled),
 * and degrades to "use Telegram meanwhile" when the on-box gateway is down —
 * never a broken-looking dashboard.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Send, Paperclip, Sparkles, Bot, User, Activity, AlertTriangle, Loader2 } from 'lucide-react';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'trust';
  content: string;
  kind: string;
  created_at: string;
  attachment_name?: string | null;
}

interface SpawnedTask {
  id: string;
  title: string;
  status: string;
  department: string | null;
  updated_at: string;
}

const SESSION_KEY = 'my-ai-ceo-session-id';

function statusChip(status: string): string {
  const s = status.toLowerCase();
  if (s === 'done' || s === 'completed') return 'bg-emerald-100 text-emerald-700 border-emerald-200';
  if (s === 'in_progress' || s === 'in-progress') return 'bg-blue-100 text-blue-700 border-blue-200';
  if (s === 'blocked') return 'bg-amber-100 text-amber-700 border-amber-200';
  return 'bg-gray-100 text-gray-600 border-gray-200';
}

export default function MyAiCeoPage() {
  const router = useRouter();
  const [sessionId, setSessionId] = useState<string>('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [tasks, setTasks] = useState<SpawnedTask[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [liveReply, setLiveReply] = useState('');
  const [gatewayUp, setGatewayUp] = useState<boolean | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploadNote, setUploadNote] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Session id (persisted so a reload continues the same thread).
  useEffect(() => {
    let sid = '';
    try {
      sid = localStorage.getItem(SESSION_KEY) || '';
    } catch {}
    if (!sid) {
      sid = (globalThis.crypto?.randomUUID?.() ?? `sess-${Date.now()}`);
      try {
        localStorage.setItem(SESSION_KEY, sid);
      } catch {}
    }
    setSessionId(sid);
  }, []);

  // Feature-flag + gateway status poll (drives the degrade banner).
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
    const t = setInterval(poll, 30000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  // If the flag is off, leave the surface (BETA: never a broken card).
  useEffect(() => {
    if (enabled === false) router.replace('/');
  }, [enabled, router]);

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
    const t = setInterval(loadHistory, 15000);
    return () => clearInterval(t);
  }, [loadHistory]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, liveReply]);

  async function send() {
    const text = input.trim();
    if (!text || streaming || !sessionId) return;
    setInput('');
    setStreaming(true);
    setLiveReply('');
    // Optimistic user bubble.
    setMessages((m) => [
      ...m,
      { id: `local-${Date.now()}`, role: 'user', content: text, kind: 'message', created_at: new Date().toISOString() },
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
  }

  async function uploadFile(file: File) {
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
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) uploadFile(file);
  }

  const gatewayDown = gatewayUp === false;

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Header */}
      <header className="h-14 bg-white border-b border-gray-200 px-4 sm:px-6 flex items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <Link href="/" className="text-gray-500 hover:text-gray-900 shrink-0" aria-label="Back to dashboard">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shrink-0">
            <Sparkles className="w-4 h-4 text-white" />
          </div>
          <h1 className="font-semibold text-gray-900 truncate">My AI CEO</h1>
          <span className="text-[10px] font-bold uppercase tracking-wider text-purple-700 bg-purple-100 border border-purple-200 rounded px-1.5 py-0.5 shrink-0">
            Beta
          </span>
        </div>
        <div
          className={`flex items-center gap-2 px-2.5 py-1 rounded-lg text-xs font-medium shrink-0 ${
            gatewayUp === null
              ? 'bg-gray-50 border border-gray-200 text-gray-500'
              : gatewayUp
                ? 'bg-emerald-50 border border-emerald-200 text-emerald-700'
                : 'bg-amber-50 border border-amber-200 text-amber-700'
          }`}
        >
          <span
            className={`w-2 h-2 rounded-full ${
              gatewayUp === null ? 'bg-gray-400' : gatewayUp ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'
            }`}
          />
          {gatewayUp === null ? 'Checking' : gatewayUp ? 'Connected' : 'Restarting'}
        </div>
      </header>

      {/* Gateway-down degrade banner */}
      {gatewayDown && (
        <div className="bg-amber-50 border-b border-amber-200 px-4 sm:px-6 py-2.5 flex items-start gap-2 text-sm text-amber-800">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            Your AI CEO is restarting. Your messages are saved — <strong>Telegram still works</strong> in the meantime.
          </span>
        </div>
      )}

      {/* Body: chat + side rail. Stacks on mobile, splits on lg. */}
      <main className="flex-1 min-h-0 flex flex-col lg:flex-row max-w-7xl w-full mx-auto">
        {/* Chat column */}
        <section
          className="flex-1 min-h-0 flex flex-col relative"
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          {dragOver && (
            <div className="absolute inset-0 z-20 bg-indigo-500/10 border-2 border-dashed border-indigo-400 flex items-center justify-center pointer-events-none">
              <span className="text-indigo-700 font-semibold">Drop to share with your AI CEO</span>
            </div>
          )}

          <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 py-6 space-y-4">
            {messages.length === 0 && !liveReply && (
              <div className="text-center text-gray-400 mt-16 px-4">
                <Bot className="w-10 h-10 mx-auto mb-3 text-gray-300" />
                <p className="font-medium text-gray-500">Talk directly to your AI CEO</p>
                <p className="text-sm mt-1">Ask for anything, or drop a document, image, or video to get started.</p>
              </div>
            )}

            {messages.map((m) => (
              <MessageBubble key={m.id} m={m} />
            ))}

            {liveReply && (
              <MessageBubble
                m={{
                  id: 'live',
                  role: 'assistant',
                  content: liveReply,
                  kind: 'message',
                  created_at: new Date().toISOString(),
                }}
              />
            )}
            {streaming && !liveReply && (
              <div className="flex items-center gap-2 text-gray-400 text-sm">
                <Loader2 className="w-4 h-4 animate-spin" /> Your AI CEO is thinking…
              </div>
            )}
          </div>

          {/* Composer */}
          <div className="border-t border-gray-200 bg-white px-3 sm:px-6 py-3 shrink-0">
            {uploadNote && <div className="text-xs text-gray-500 mb-2">{uploadNote}</div>}
            <div className="flex items-end gap-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="shrink-0 h-11 w-11 rounded-xl border border-gray-200 text-gray-500 hover:text-gray-900 hover:border-gray-300 flex items-center justify-center"
                aria-label="Upload a file"
              >
                <Paperclip className="w-5 h-5" />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) uploadFile(f);
                  e.target.value = '';
                }}
              />
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                rows={1}
                placeholder="Message your AI CEO…"
                className="flex-1 resize-none max-h-40 min-h-[44px] rounded-xl border border-gray-200 px-3 py-2.5 text-[15px] focus:outline-none focus:ring-2 focus:ring-indigo-400"
              />
              <button
                type="button"
                onClick={send}
                disabled={streaming || !input.trim()}
                className="shrink-0 h-11 px-4 rounded-xl bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-40 flex items-center gap-2"
              >
                <Send className="w-4 h-4" />
                <span className="hidden sm:inline">Send</span>
              </button>
            </div>
          </div>
        </section>

        {/* "What's happening" side rail */}
        <aside className="lg:w-80 shrink-0 border-t lg:border-t-0 lg:border-l border-gray-200 bg-white/60 px-4 sm:px-5 py-4 lg:overflow-y-auto">
          <div className="flex items-center gap-2 mb-3 text-gray-700">
            <Activity className="w-4 h-4 text-indigo-500" />
            <h2 className="font-semibold text-sm">What&apos;s happening</h2>
          </div>
          {tasks.length === 0 ? (
            <p className="text-sm text-gray-400">
              Tasks your AI CEO starts from this chat show up here with live status.
            </p>
          ) : (
            <ul className="space-y-2">
              {tasks.map((t) => (
                <li key={t.id} className="rounded-lg border border-gray-200 bg-white p-3">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm font-medium text-gray-800 line-clamp-2">{t.title}</span>
                    <span
                      className={`shrink-0 text-[10px] font-semibold uppercase tracking-wide rounded border px-1.5 py-0.5 ${statusChip(
                        t.status,
                      )}`}
                    >
                      {t.status.replace(/_/g, ' ')}
                    </span>
                  </div>
                  {t.department && <p className="text-xs text-gray-400 mt-1">{t.department}</p>}
                </li>
              ))}
            </ul>
          )}
        </aside>
      </main>
    </div>
  );
}

function MessageBubble({ m }: { m: ChatMessage }) {
  const isUser = m.role === 'user';
  const isTrust = m.role === 'trust';
  const isSystem = m.role === 'system';

  if (isSystem || isTrust) {
    return (
      <div className="flex justify-center">
        <div
          className={`max-w-[85%] text-sm rounded-xl px-3 py-2 border ${
            isTrust ? 'bg-indigo-50 border-indigo-200 text-indigo-800' : 'bg-amber-50 border-amber-200 text-amber-800'
          }`}
        >
          {m.content}
        </div>
      </div>
    );
  }

  return (
    <div className={`flex gap-2 ${isUser ? 'justify-end' : 'justify-start'}`}>
      {!isUser && (
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shrink-0">
          <Bot className="w-4 h-4 text-white" />
        </div>
      )}
      <div
        className={`max-w-[85%] sm:max-w-[75%] rounded-2xl px-4 py-2.5 text-[15px] whitespace-pre-wrap break-words ${
          isUser ? 'bg-indigo-600 text-white' : 'bg-white border border-gray-200 text-gray-800'
        }`}
      >
        {m.kind === 'upload' && m.attachment_name ? (
          <span className="inline-flex items-center gap-1.5">
            <Paperclip className="w-3.5 h-3.5" /> {m.attachment_name}
          </span>
        ) : (
          m.content
        )}
      </div>
      {isUser && (
        <div className="w-8 h-8 rounded-lg bg-gray-200 flex items-center justify-center shrink-0">
          <User className="w-4 h-4 text-gray-600" />
        </div>
      )}
    </div>
  );
}
