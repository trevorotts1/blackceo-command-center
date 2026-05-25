'use client';

/**
 * NotebookList - library view for the Operator Console Notebook sub-module.
 *
 * Track B5 (PRD Section 4.6). Fetches `/api/operator/notebook`, renders the
 * library grid, and exposes a small "new notebook" form. Selecting a row
 * routes to `/operator/notebook/[id]` (handled by the parent page).
 */

import { useCallback, useEffect, useState, FormEvent } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import {
  BookOpen,
  Plus,
  RefreshCw,
  AlertCircle,
  Library,
} from 'lucide-react';

interface NotebookListItem {
  id: string;
  title: string;
  description: string | null;
  backend: 'notebooklm' | 'gemini-local';
  remote_id: string | null;
  created_at: string;
  updated_at: string;
  source_count: number;
}

interface BackendStatus {
  backend: 'notebooklm' | 'gemini-local';
  available: boolean;
  reason?: string;
}

interface ListResponse {
  items: NotebookListItem[];
  backends: BackendStatus[];
}

function fmtAgo(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export default function NotebookList() {
  const [items, setItems] = useState<NotebookListItem[]>([]);
  const [backends, setBackends] = useState<BackendStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDescription, setNewDescription] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/operator/notebook', { cache: 'no-store' });
      if (!res.ok) throw new Error(`list failed (${res.status})`);
      const json = (await res.json()) as ListResponse;
      setItems(json.items || []);
      setBackends(json.backends || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const title = newTitle.trim();
    if (!title || creating) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch('/api/operator/notebook', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title,
          description: newDescription.trim() || null,
        }),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`create failed (${res.status}): ${txt.slice(0, 200)}`);
      }
      setNewTitle('');
      setNewDescription('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown error');
    } finally {
      setCreating(false);
    }
  }

  const noBackend = backends.length > 0 && backends.every((b) => !b.available);

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Library size={20} className="text-bcc-text-muted" />
          <h1 className="text-[22px] font-medium text-bcc-text">Notebook</h1>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="flex items-center gap-2 text-[12px] uppercase tracking-[0.18em] text-bcc-text-muted hover:text-bcc-text"
          aria-label="Refresh notebooks"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </header>

      {noBackend && (
        <div className="flex items-start gap-2 rounded-xl border border-bcc-border bg-bcc-bg px-4 py-3 text-[13px] text-bcc-text-secondary">
          <AlertCircle size={16} className="mt-0.5 text-amber-500" />
          <div>
            No NotebookLM credentials and no <code>GOOGLE_API_KEY</code> in the
            environment. You can still create notebooks and attach sources, but
            Q&amp;A will return an unavailable status until a backend is wired.
          </div>
        </div>
      )}

      <form
        onSubmit={handleCreate}
        className="space-y-3 rounded-xl border border-bcc-border bg-bcc-white p-4"
        aria-label="Create new notebook"
      >
        <div className="text-[12px] uppercase tracking-[0.18em] text-bcc-text-muted">
          New notebook
        </div>
        <input
          type="text"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          placeholder="Title"
          aria-label="Notebook title"
          disabled={creating}
          className="w-full bg-transparent outline-none text-[15px] text-bcc-text placeholder:text-bcc-text-muted border-b border-bcc-border focus:border-bcc-text pb-2"
        />
        <input
          type="text"
          value={newDescription}
          onChange={(e) => setNewDescription(e.target.value)}
          placeholder="Optional description"
          aria-label="Notebook description"
          disabled={creating}
          className="w-full bg-transparent outline-none text-[14px] text-bcc-text-secondary placeholder:text-bcc-text-muted border-b border-bcc-border focus:border-bcc-text pb-2"
        />
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={creating || newTitle.trim().length === 0}
            className="inline-flex items-center gap-2 rounded-md bg-bcc-text px-3 py-1.5 text-[12px] uppercase tracking-[0.18em] text-bcc-white hover:opacity-90 disabled:opacity-50"
          >
            <Plus size={14} />
            {creating ? 'Creating' : 'Create'}
          </button>
        </div>
      </form>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
          {error}
        </div>
      )}

      {loading && items.length === 0 ? (
        <div className="text-[13px] text-bcc-text-muted">Loading notebooks...</div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-bcc-border bg-bcc-bg px-4 py-10 text-center text-[13px] text-bcc-text-muted">
          No notebooks yet. Create one above to get started.
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((n) => (
            <motion.li
              key={n.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-xl border border-bcc-border bg-bcc-white p-4 hover:border-bcc-text"
            >
              <Link href={`/operator/notebook/${n.id}`} className="block space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <BookOpen size={16} className="text-bcc-text-muted" />
                    <span className="font-medium text-bcc-text">{n.title}</span>
                  </div>
                  <span className="rounded-md bg-bcc-bg px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-bcc-text-muted">
                    {n.backend}
                  </span>
                </div>
                {n.description && (
                  <div className="text-[13px] text-bcc-text-secondary line-clamp-2">
                    {n.description}
                  </div>
                )}
                <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.18em] text-bcc-text-muted">
                  <span>{n.source_count} {n.source_count === 1 ? 'source' : 'sources'}</span>
                  <span>{fmtAgo(n.updated_at)}</span>
                </div>
              </Link>
            </motion.li>
          ))}
        </ul>
      )}
    </div>
  );
}
