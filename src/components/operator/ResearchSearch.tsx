'use client';

/**
 * ResearchSearch — search box for the Operator Console Research sub-module.
 *
 * Track B7 (SCOPE-ADDITION Section 5).
 *
 * Submits to POST /api/operator/research/search. On success the parent page
 * receives the new search via `onResult` so it can route to the detail view
 * and refresh the history sidebar.
 */

import { useState, FormEvent } from 'react';
import { Search, Loader2 } from 'lucide-react';

export interface ResearchSearchResult {
  search_id: string;
  markdown_result: string;
  model: string;
  created_at: string;
  search_metadata?: Record<string, unknown>;
}

export interface ResearchSearchProps {
  onResult?: (result: ResearchSearchResult) => void;
  defaultDepth?: 'shallow' | 'deep';
}

export default function ResearchSearch({ onResult, defaultDepth = 'shallow' }: ResearchSearchProps) {
  const [query, setQuery] = useState('');
  const [depth, setDepth] = useState<'shallow' | 'deep'>(defaultDepth);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const q = query.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/operator/research/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: q, depth }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Search failed (${res.status}): ${text.slice(0, 200)}`);
      }
      const json = (await res.json()) as ResearchSearchResult & {
        empty_state?: boolean;
        message?: string;
      };
      // Honest empty-state: the box has no search-provider key. Surface the
      // message rather than routing to an empty result.
      if (json.empty_state) {
        setError(json.message || 'Research is not enabled. Add a Perplexity, OpenAI, Ollama, or xAI key.');
        return;
      }
      onResult?.(json);
      setQuery('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3" aria-label="Research search form">
      <div className="flex items-center gap-2 rounded-xl border border-bcc-border bg-bcc-white px-3 py-2 focus-within:border-bcc-text">
        <Search size={18} className="text-bcc-text-muted" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Ask anything. Your search provider will search the live web."
          aria-label="Research query"
          disabled={busy}
          className="flex-1 bg-transparent outline-none text-[15px] text-bcc-text placeholder:text-bcc-text-muted disabled:opacity-60"
        />
        <select
          value={depth}
          onChange={(e) => setDepth(e.target.value as 'shallow' | 'deep')}
          aria-label="Search depth"
          disabled={busy}
          className="text-[12px] uppercase tracking-[0.18em] bg-bcc-bg border border-bcc-border rounded-md px-2 py-1 text-bcc-text-secondary"
        >
          <option value="shallow">Shallow</option>
          <option value="deep">Deep</option>
        </select>
        <button
          type="submit"
          disabled={busy || !query.trim()}
          className="inline-flex items-center gap-2 rounded-lg bg-bcc-text px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
          {busy ? 'Searching...' : 'Search'}
        </button>
      </div>
      {error ? (
        <div className="text-[12px] text-red-600" role="alert">
          {error}
        </div>
      ) : null}
      <p className="text-[11px] text-bcc-text-muted">
        Shallow targets a 30 second SLA. Deep searches return more sources and may take longer.
      </p>
    </form>
  );
}
