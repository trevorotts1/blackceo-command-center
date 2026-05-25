'use client';

/**
 * ResearchHistory — history sidebar for the Operator Console Research sub-module.
 *
 * Track B7 (SCOPE-ADDITION Section 5).
 *
 * Polls GET /api/operator/research/history and renders a list of past searches
 * newest first. Clicking a row navigates to /operator/research/[id].
 */

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Clock, RefreshCw } from 'lucide-react';

interface HistoryItem {
  id: string;
  query: string;
  model: string;
  preview: string;
  created_at: string;
  depth: string | null;
  citation_count: number | null;
}

interface HistoryResponse {
  items: HistoryItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface ResearchHistoryProps {
  refreshKey?: number;
  activeId?: string;
  limit?: number;
}

function relativeTime(iso: string): string {
  try {
    const then = new Date(iso).getTime();
    const now = Date.now();
    const diff = Math.max(0, now - then);
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

export default function ResearchHistory({
  refreshKey = 0,
  activeId,
  limit = 25,
}: ResearchHistoryProps) {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/operator/research/history?limit=${limit}`, {
        cache: 'no-store',
      });
      if (!res.ok) {
        throw new Error(`History fetch failed (${res.status})`);
      }
      const json = (await res.json()) as HistoryResponse;
      setItems(json.items || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown error');
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  return (
    <aside
      className="w-full md:w-[300px] shrink-0 border-r border-bcc-border bg-bcc-white"
      aria-label="Research history"
    >
      <div className="flex items-center justify-between border-b border-bcc-border px-4 py-3">
        <div className="text-[12px] uppercase tracking-[0.22em] text-bcc-text-muted font-semibold">
          History
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="text-bcc-text-muted hover:text-bcc-text"
          aria-label="Refresh history"
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
            No searches yet. Run your first query above.
          </div>
        ) : null}
        <ul className="divide-y divide-bcc-border">
          {items.map((item) => {
            const active = item.id === activeId;
            return (
              <li key={item.id}>
                <Link
                  href={`/operator/research/${item.id}`}
                  className={`block px-4 py-3 transition-colors ${
                    active ? 'bg-bcc-bg' : 'hover:bg-bcc-bg'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="line-clamp-2 text-[13px] font-medium text-bcc-text">
                      {item.query}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-[11px] text-bcc-text-muted">
                    <Clock size={11} />
                    <span>{relativeTime(item.created_at)}</span>
                    {item.depth ? (
                      <span className="uppercase tracking-[0.16em]">{item.depth}</span>
                    ) : null}
                    {typeof item.citation_count === 'number' ? (
                      <span>{item.citation_count} sources</span>
                    ) : null}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}
