'use client';

/**
 * /operator/web-agent - Web Agent sub-module landing page.
 *
 * Track B9 (SCOPE-ADDITION Section 7).
 *
 * Layout: history sidebar on the left, task form at the top of the main
 * panel, and a brief explainer underneath. Submitting a task immediately
 * navigates to /operator/web-agent/session/[id] where the live SSE view
 * takes over.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Clock, Globe, RefreshCw } from 'lucide-react';
import WebAgentForm, {
  type WebAgentRunResponse,
} from '@/components/operator/WebAgentForm';

interface HistoryItem {
  id: string;
  task: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  preview: string;
  started_at: string;
  ended_at: string | null;
  action_count: number;
  created_at: string;
}

interface HistoryResponse {
  items: HistoryItem[];
  total: number;
  limit: number;
  offset: number;
}

function relativeTime(iso: string): string {
  try {
    const then = new Date(iso).getTime();
    const diff = Math.max(0, Date.now() - then);
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    return `${day}d ago`;
  } catch {
    return iso;
  }
}

export default function WebAgentLandingPage() {
  const router = useRouter();
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/operator/web-agent/sessions?limit=25', {
        cache: 'no-store',
      });
      if (!res.ok) {
        throw new Error(`Sessions fetch failed (${res.status})`);
      }
      const json = (await res.json()) as HistoryResponse;
      setItems(json.items || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function handleStarted(response: WebAgentRunResponse) {
    try {
      router.push(`/operator/web-agent/session/${response.session_id}`);
    } catch {
      // Fallback for environments without next/navigation (tests).
      void load();
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <div className="text-[12px] uppercase tracking-[0.22em] text-bcc-text-muted font-semibold">
          Operator Console
        </div>
        <h1 className="mt-2 text-page-title text-bcc-text">Web Agent</h1>
        <p className="mt-2 text-body text-bcc-text-secondary max-w-[680px]">
          Describe a task in plain English. The agent drives a headless
          browser via Claude Computer Use, returns a Markdown report, and
          saves it to your vault so it appears in Memory and the All Searches
          bucket.
        </p>
      </header>

      <div className="flex flex-col md:flex-row gap-6">
        <aside
          className="w-full md:w-[300px] shrink-0 border-r border-bcc-border bg-bcc-white"
          aria-label="Web Agent history"
        >
          <div className="flex items-center justify-between border-b border-bcc-border px-4 py-3">
            <div className="text-[12px] uppercase tracking-[0.22em] text-bcc-text-muted font-semibold">
              Sessions
            </div>
            <button
              type="button"
              onClick={() => void load()}
              className="text-bcc-text-muted hover:text-bcc-text"
              aria-label="Refresh sessions"
              disabled={loading}
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
          <div className="max-h-[calc(100vh-200px)] overflow-y-auto">
            {error ? (
              <div className="p-4 text-[12px] text-red-600" role="alert">
                {error}
              </div>
            ) : null}
            {!error && !loading && items.length === 0 ? (
              <div className="p-4 text-[13px] text-bcc-text-muted">
                No sessions yet. Run your first task on the right.
              </div>
            ) : null}
            <ul className="divide-y divide-bcc-border">
              {items.map((item) => (
                <li key={item.id}>
                  <Link
                    href={`/operator/web-agent/session/${item.id}`}
                    className="block px-4 py-3 transition-colors hover:bg-bcc-bg"
                  >
                    <div className="flex items-center gap-2">
                      <Globe size={12} className="shrink-0 text-bcc-text-muted" />
                      <span className="line-clamp-2 text-[13px] font-medium text-bcc-text">
                        {item.task}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-[11px] text-bcc-text-muted">
                      <Clock size={11} />
                      <span>{relativeTime(item.created_at)}</span>
                      <span className="uppercase tracking-[0.16em]">{item.status}</span>
                      {item.action_count > 0 ? <span>{item.action_count} actions</span> : null}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </aside>

        <div className="flex-1 min-w-0 space-y-6">
          <WebAgentForm onStarted={handleStarted} />
          <div className="rounded-xl border border-bcc-border bg-bcc-bg p-4 text-[12.5px] text-bcc-text-secondary leading-relaxed">
            <p className="font-semibold text-bcc-text">How it works</p>
            <ul className="mt-2 list-disc pl-5 space-y-1">
              <li>An isolated Chromium context launches per session. No cookies, no credentials.</li>
              <li>Claude Sonnet 4.6 plans actions; Playwright executes click, type, scroll, navigate.</li>
              <li>Every action publishes a screenshot over Server-Sent Events to the session view.</li>
              <li>The final Markdown report mirrors to your vault under <code>web-agent/YYYY/MM/</code>.</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
