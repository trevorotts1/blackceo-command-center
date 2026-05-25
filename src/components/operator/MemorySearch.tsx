'use client';

/**
 * MemorySearch — full-text search UI for the Operator Console Memory
 * sub-module.
 *
 * Track B6 (PRD Section 4.7).
 *
 * Hits are returned grouped by source. Source facets work as include filters.
 * Clicking a hit follows its `href` (deep links to Journal, Workspace, Bridge,
 * Goals, Research, Tasks, Agents).
 */
import { useCallback, useMemo, useState, FormEvent, useEffect } from 'react';
import { Search, Loader2, FileText, FolderOpen, BookOpen, MessageSquare, Target, Search as SearchIcon, ListTodo, User } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

type SourceType = 'vault' | 'scratch' | 'journal' | 'chat' | 'goal' | 'research' | 'task' | 'persona';

interface Hit {
  id: string;
  source: SourceType;
  title: string;
  excerpt: string;
  score: number;
  updated_at: string;
  href?: string;
  path?: string;
  meta?: Record<string, unknown>;
}

interface SearchResult {
  query: string;
  total: number;
  hits: Hit[];
  by_source: Record<SourceType, number>;
  errors: Array<{ source: SourceType; message: string }>;
  elapsed_ms: number;
}

const SOURCE_META: Record<SourceType, { label: string; icon: ReactNode; accent: string }> = {
  vault: { label: 'Vault', icon: <FileText size={14} />, accent: '#A3E635' },
  scratch: { label: 'Scratch', icon: <FolderOpen size={14} />, accent: '#8B5CF6' },
  journal: { label: 'Journal', icon: <BookOpen size={14} />, accent: '#A3E635' },
  chat: { label: 'Chat', icon: <MessageSquare size={14} />, accent: '#3B82F6' },
  goal: { label: 'Goals', icon: <Target size={14} />, accent: '#FBBF24' },
  research: { label: 'Research', icon: <SearchIcon size={14} />, accent: '#06B6D4' },
  task: { label: 'Tasks', icon: <ListTodo size={14} />, accent: '#F59E0B' },
  persona: { label: 'Personas', icon: <User size={14} />, accent: '#EC4899' },
};

const ALL_SOURCES: SourceType[] = ['vault', 'scratch', 'journal', 'chat', 'goal', 'research', 'task', 'persona'];

interface MemorySearchProps {
  initialQuery?: string;
}

export default function MemorySearch({ initialQuery = '' }: MemorySearchProps) {
  const [query, setQuery] = useState(initialQuery);
  const [activeSources, setActiveSources] = useState<Set<SourceType>>(new Set(ALL_SOURCES));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SearchResult | null>(null);

  const runSearch = useCallback(
    async (q: string, sources: Set<SourceType>) => {
      const trimmed = q.trim();
      if (!trimmed) {
        setResult(null);
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const url = new URL('/api/operator/memory/search', window.location.origin);
        url.searchParams.set('q', trimmed);
        if (sources.size > 0 && sources.size < ALL_SOURCES.length) {
          url.searchParams.set('sources', Array.from(sources).join(','));
        }
        const res = await fetch(url.toString());
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Search failed (${res.status}): ${text.slice(0, 200)}`);
        }
        const json = (await res.json()) as SearchResult;
        setResult(json);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'unknown error');
      } finally {
        setBusy(false);
      }
    },
    []
  );

  // Auto-fire once if initialQuery is supplied so deep links from Command
  // Palette land on a populated page.
  useEffect(() => {
    if (initialQuery && initialQuery.trim()) {
      void runSearch(initialQuery, activeSources);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void runSearch(query, activeSources);
  }

  function toggleSource(s: SourceType) {
    const next = new Set(activeSources);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    if (next.size === 0) {
      // Disallow zero sources — interpret as "everything".
      for (const k of ALL_SOURCES) next.add(k);
    }
    setActiveSources(next);
    if (result) {
      void runSearch(query, next);
    }
  }

  const grouped = useMemo(() => {
    if (!result) return null;
    const map = new Map<SourceType, Hit[]>();
    for (const hit of result.hits) {
      const arr = map.get(hit.source) || [];
      arr.push(hit);
      map.set(hit.source, arr);
    }
    return map;
  }, [result]);

  return (
    <div className="space-y-5">
      <form onSubmit={handleSubmit} aria-label="Memory search form">
        <div className="flex items-center gap-2 rounded-xl border border-bcc-border bg-bcc-white px-3 py-2 focus-within:border-bcc-text">
          <Search size={18} className="text-bcc-text-muted" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search vault, journal, chats, goals, research, tasks, personas..."
            aria-label="Memory query"
            disabled={busy}
            className="flex-1 bg-transparent outline-none text-[15px] text-bcc-text placeholder:text-bcc-text-muted disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={busy || !query.trim()}
            className="inline-flex items-center gap-2 rounded-lg bg-bcc-text px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
            {busy ? 'Searching...' : 'Search'}
          </button>
        </div>
      </form>

      <div className="flex flex-wrap items-center gap-2">
        {ALL_SOURCES.map((s) => {
          const meta = SOURCE_META[s];
          const active = activeSources.has(s);
          const count = result?.by_source?.[s] ?? 0;
          return (
            <button
              key={s}
              type="button"
              onClick={() => toggleSource(s)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] transition-colors ${
                active
                  ? 'border-bcc-text text-bcc-text bg-bcc-white'
                  : 'border-bcc-border-light text-bcc-text-muted bg-bcc-bg'
              }`}
              style={{ color: active ? meta.accent : undefined }}
              aria-pressed={active}
            >
              {meta.icon}
              {meta.label}
              {count > 0 ? <span className="opacity-70">({count})</span> : null}
            </button>
          );
        })}
      </div>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700" role="alert">
          {error}
        </div>
      ) : null}

      {result && result.errors.length > 0 ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
          Partial results. Some sources reported errors:
          <ul className="mt-1 list-disc list-inside">
            {result.errors.map((e, i) => (
              <li key={i}>
                <span className="font-semibold">{e.source}:</span> {e.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {result ? (
        <div className="text-[12px] text-bcc-text-muted">
          {result.total} hit{result.total === 1 ? '' : 's'} in {result.elapsed_ms} ms
        </div>
      ) : null}

      {grouped ? (
        grouped.size === 0 ? (
          <div className="rounded-xl border border-dashed border-bcc-border bg-bcc-white p-8 text-center text-bcc-text-muted text-[14px]">
            No hits for &ldquo;{result?.query}&rdquo;.
          </div>
        ) : (
          <div className="space-y-6">
            {ALL_SOURCES.filter((s) => grouped.has(s)).map((s) => {
              const meta = SOURCE_META[s];
              const hits = grouped.get(s)!;
              return (
                <section key={s} aria-label={`${meta.label} results`}>
                  <header className="flex items-center gap-2 mb-2">
                    <span style={{ color: meta.accent }} className="grid place-items-center">
                      {meta.icon}
                    </span>
                    <h3 className="text-[14px] font-semibold uppercase tracking-[0.18em] text-bcc-text-secondary">
                      {meta.label}
                    </h3>
                    <span className="text-[11px] text-bcc-text-muted">{hits.length}</span>
                  </header>
                  <ul className="space-y-2">
                    {hits.map((hit) => (
                      <li key={hit.id}>
                        <HitCard hit={hit} />
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        )
      ) : null}
    </div>
  );
}

function HitCard({ hit }: { hit: Hit }) {
  const inner = (
    <div className="rounded-xl border border-bcc-border bg-bcc-white p-3 transition-shadow hover:shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold text-bcc-text truncate">{hit.title}</div>
          <div className="mt-1 text-[12px] text-bcc-text-secondary line-clamp-3">{hit.excerpt}</div>
          <div className="mt-1 text-[11px] text-bcc-text-muted">
            {hit.path ? <span className="font-mono">{hit.path}</span> : null}
            {hit.path ? <span> · </span> : null}
            <span>{new Date(hit.updated_at).toLocaleString()}</span>
            <span> · score {hit.score}</span>
          </div>
        </div>
      </div>
    </div>
  );
  if (hit.href) {
    return (
      <Link href={hit.href} className="block">
        {inner}
      </Link>
    );
  }
  return inner;
}
