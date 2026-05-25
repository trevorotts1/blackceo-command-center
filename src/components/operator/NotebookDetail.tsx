'use client';

/**
 * NotebookDetail - single-notebook view for the Operator Console.
 *
 * Track B5 (PRD Section 4.6). Renders sources, lets the operator add or
 * remove them, and exposes a Q&A box that pings the (Depth 2 stubbed)
 * notebooklm-client. When the backend reports `ok: false`, the answer pane
 * surfaces the reason verbatim so the operator knows what's missing.
 */

import { useCallback, useEffect, useState, FormEvent } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  ChevronRight,
  FileText,
  Link as LinkIcon,
  Send,
  Trash2,
  RefreshCw,
} from 'lucide-react';
import NotebookSourceUploader from './NotebookSourceUploader';

interface SourceRow {
  id: string;
  notebook_id: string;
  source_type: 'pdf' | 'text' | 'markdown' | 'url' | 'audio' | 'video';
  title: string | null;
  path: string | null;
  url: string | null;
  remote_id: string | null;
  byte_size: number | null;
  created_at: string;
}

interface NotebookRow {
  id: string;
  title: string;
  description: string | null;
  backend: 'notebooklm' | 'gemini-local';
  remote_id: string | null;
  created_at: string;
  updated_at: string;
  sources: SourceRow[];
}

interface AskResponse {
  ok: boolean;
  answer?: string;
  reason?: string;
  backend?: string;
}

interface Props {
  notebookId: string;
}

export default function NotebookDetail({ notebookId }: Props) {
  const [notebook, setNotebook] = useState<NotebookRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [askResult, setAskResult] = useState<AskResponse | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/operator/notebook/${notebookId}`, { cache: 'no-store' });
      if (!res.ok) {
        if (res.status === 404) {
          setNotebook(null);
          return;
        }
        throw new Error(`load failed (${res.status})`);
      }
      const json = (await res.json()) as NotebookRow;
      setNotebook(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown error');
    } finally {
      setLoading(false);
    }
  }, [notebookId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleRemoveSource(sourceId: string) {
    if (!confirm('Remove this source?')) return;
    try {
      const res = await fetch(
        `/api/operator/notebook/${notebookId}/sources?source_id=${encodeURIComponent(sourceId)}`,
        { method: 'DELETE' }
      );
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`delete failed (${res.status}): ${txt.slice(0, 200)}`);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown error');
    }
  }

  async function handleAsk(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const q = question.trim();
    if (!q || asking) return;
    setAsking(true);
    setAskResult(null);

    // Depth 2 has no /ask endpoint yet (separate track). Hit the client adapter
    // through a lightweight inline POST to /api/operator/notebook/[id] PATCH?
    // No - simpler: render a soft "backend not wired at this depth" message
    // using the backends status we have. The actual ask wire-path is a later
    // depth's responsibility.
    try {
      const res = await fetch('/api/operator/notebook', { cache: 'no-store' });
      const backendsJson = (await res.json()) as {
        backends: { backend: string; available: boolean; reason?: string }[];
      };
      const available = backendsJson.backends?.find((b) => b.available);
      if (!available) {
        setAskResult({
          ok: false,
          reason:
            'No notebook backend is configured. Set AGENTIC_OS_NLM_MCP_BIN or GOOGLE_API_KEY.',
        });
      } else {
        setAskResult({
          ok: false,
          backend: available.backend,
          reason: `Backend "${available.backend}" detected. Q&A wire path activates at the next build depth.`,
        });
      }
    } catch (err) {
      setAskResult({
        ok: false,
        reason: err instanceof Error ? err.message : 'unknown error',
      });
    } finally {
      setAsking(false);
    }
  }

  if (loading && !notebook) {
    return <div className="text-[13px] text-bcc-text-muted">Loading notebook...</div>;
  }
  if (!notebook) {
    return (
      <div className="space-y-3">
        <Link
          href="/operator/notebook"
          className="inline-flex items-center gap-1 text-[12px] uppercase tracking-[0.18em] text-bcc-text-muted hover:text-bcc-text"
        >
          <ArrowLeft size={14} />
          Back to notebooks
        </Link>
        <div className="rounded-xl border border-bcc-border bg-bcc-bg p-6 text-[14px] text-bcc-text-secondary">
          Notebook not found.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Link
          href="/operator/notebook"
          className="inline-flex items-center gap-1 text-[12px] uppercase tracking-[0.18em] text-bcc-text-muted hover:text-bcc-text"
        >
          <ArrowLeft size={14} />
          Back
        </Link>
        <button
          type="button"
          onClick={() => void refresh()}
          className="flex items-center gap-2 text-[12px] uppercase tracking-[0.18em] text-bcc-text-muted hover:text-bcc-text"
          aria-label="Refresh notebook"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      <header className="space-y-1">
        <h1 className="text-[22px] font-medium text-bcc-text">{notebook.title}</h1>
        {notebook.description && (
          <p className="text-[14px] text-bcc-text-secondary">{notebook.description}</p>
        )}
        <div className="flex items-center gap-3 text-[11px] uppercase tracking-[0.18em] text-bcc-text-muted">
          <span>Backend: {notebook.backend}</span>
          <span>{notebook.sources.length} sources</span>
        </div>
      </header>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
          {error}
        </div>
      )}

      <section className="space-y-3">
        <h2 className="text-[12px] uppercase tracking-[0.18em] text-bcc-text-muted">
          Sources
        </h2>
        {notebook.sources.length === 0 ? (
          <div className="rounded-xl border border-dashed border-bcc-border bg-bcc-bg px-4 py-6 text-center text-[13px] text-bcc-text-muted">
            No sources yet. Add one below.
          </div>
        ) : (
          <ul className="space-y-2">
            {notebook.sources.map((s) => (
              <li
                key={s.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-bcc-border bg-bcc-white px-3 py-2"
              >
                <div className="flex min-w-0 items-center gap-2">
                  {s.source_type === 'url' ? (
                    <LinkIcon size={14} className="shrink-0 text-bcc-text-muted" />
                  ) : (
                    <FileText size={14} className="shrink-0 text-bcc-text-muted" />
                  )}
                  <div className="min-w-0">
                    <div className="truncate text-[14px] text-bcc-text">
                      {s.title || s.url || s.path || s.id}
                    </div>
                    <div className="text-[11px] uppercase tracking-[0.16em] text-bcc-text-muted">
                      {s.source_type}
                      {typeof s.byte_size === 'number' && s.byte_size > 0
                        ? ` / ${s.byte_size} b`
                        : ''}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void handleRemoveSource(s.id)}
                  className="text-bcc-text-muted hover:text-red-600"
                  aria-label={`Remove source ${s.title || s.id}`}
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}

        <NotebookSourceUploader notebookId={notebook.id} onCreated={() => void refresh()} />
      </section>

      <section className="space-y-3">
        <h2 className="text-[12px] uppercase tracking-[0.18em] text-bcc-text-muted">
          Ask
        </h2>
        <form
          onSubmit={handleAsk}
          className="space-y-3 rounded-xl border border-bcc-border bg-bcc-white p-4"
          aria-label="Ask the notebook"
        >
          <div className="flex items-center gap-2 rounded-lg border border-bcc-border bg-bcc-bg px-3 py-2">
            <ChevronRight size={16} className="text-bcc-text-muted" />
            <input
              type="text"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Ask a question grounded in your sources..."
              aria-label="Question"
              disabled={asking}
              className="flex-1 bg-transparent outline-none text-[14px] text-bcc-text placeholder:text-bcc-text-muted disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={asking || question.trim().length === 0}
              className="inline-flex items-center gap-1 rounded-md bg-bcc-text px-2 py-1 text-[11px] uppercase tracking-[0.18em] text-bcc-white hover:opacity-90 disabled:opacity-50"
            >
              <Send size={12} />
              {asking ? 'Asking' : 'Ask'}
            </button>
          </div>
          {askResult && (
            <div
              className={`rounded-md border px-3 py-2 text-[13px] ${
                askResult.ok
                  ? 'border-bcc-border bg-bcc-bg text-bcc-text'
                  : 'border-amber-200 bg-amber-50 text-amber-800'
              }`}
            >
              {askResult.ok ? askResult.answer : askResult.reason}
            </div>
          )}
        </form>
      </section>
    </div>
  );
}
