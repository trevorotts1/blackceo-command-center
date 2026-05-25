'use client';

/**
 * JournalEntry — date-navigated markdown editor for the Operator Console
 * Journal sub-module.
 *
 * Track B6 (PRD Section 4.7).
 *
 * Behaviour:
 *   - Default to today's date in the operator's local timezone.
 *   - Previous / Next buttons walk by day.
 *   - Auto-save every 5 seconds while the body is dirty (PRD 4.7).
 *   - Server mirrors the entry to <vault>/journal/YYYY/MM/YYYY-MM-DD.md.
 *
 * Rich-text rendering uses a simple split between Edit and Preview tabs.
 * The Preview tab shows the markdown as a styled <pre> block until the
 * shared react-markdown pipeline (owned by Track B3) is wired into the app.
 * That swap is a one-line replacement of the Preview body.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Save, ChevronLeft, ChevronRight, Calendar, FileText, Eye } from 'lucide-react';

interface JournalEntry {
  id: string;
  entry_date: string;
  body: string;
  created_at: string;
  updated_at: string;
}

interface JournalEntryProps {
  /** Initial date in YYYY-MM-DD. Defaults to today (local). */
  initialDate?: string;
}

const AUTOSAVE_INTERVAL_MS = 5000;

function todayLocal(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function shiftDate(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

export default function JournalEntry({ initialDate }: JournalEntryProps) {
  const [date, setDate] = useState<string>(initialDate || todayLocal());
  const [body, setBody] = useState<string>('');
  const [savedBody, setSavedBody] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [tab, setTab] = useState<'edit' | 'preview'>('edit');

  const loadAbort = useRef<AbortController | null>(null);

  const load = useCallback(async (forDate: string) => {
    if (loadAbort.current) loadAbort.current.abort();
    const ac = new AbortController();
    loadAbort.current = ac;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/operator/journal/${encodeURIComponent(forDate)}`, {
        signal: ac.signal,
      });
      if (res.status === 404) {
        setBody('');
        setSavedBody('');
        setLastSavedAt(null);
        return;
      }
      if (!res.ok) throw new Error(`Load failed (${res.status})`);
      const data = (await res.json()) as JournalEntry;
      setBody(data.body || '');
      setSavedBody(data.body || '');
      setLastSavedAt(data.updated_at);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'unknown error');
    } finally {
      if (!ac.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(date);
  }, [date, load]);

  const save = useCallback(
    async (forDate: string, nextBody: string) => {
      setSaving(true);
      setError(null);
      try {
        const res = await fetch('/api/operator/journal', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ entry_date: forDate, body: nextBody }),
        });
        if (!res.ok) throw new Error(`Save failed (${res.status})`);
        const data = (await res.json()) as JournalEntry;
        setSavedBody(data.body);
        setLastSavedAt(data.updated_at);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'unknown error');
      } finally {
        setSaving(false);
      }
    },
    []
  );

  // Auto-save loop. Runs every 5s while the body differs from the last save.
  useEffect(() => {
    const interval = window.setInterval(() => {
      if (body !== savedBody && !saving && !loading) {
        void save(date, body);
      }
    }, AUTOSAVE_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [body, savedBody, saving, loading, date, save]);

  // Also save on date change.
  useEffect(() => {
    return () => {
      // On unmount, fire one last save if dirty.
      if (body !== savedBody) {
        void fetch('/api/operator/journal', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ entry_date: date, body }),
          keepalive: true,
        }).catch(() => {
          /* swallow */
        });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty = body !== savedBody;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setDate((d) => shiftDate(d, -1))}
            className="rounded-md border border-bcc-border bg-bcc-white p-2 text-bcc-text-secondary hover:text-bcc-text"
            aria-label="Previous day"
          >
            <ChevronLeft size={14} />
          </button>
          <div className="inline-flex items-center gap-2 rounded-md border border-bcc-border bg-bcc-white px-3 py-2">
            <Calendar size={14} className="text-bcc-text-muted" />
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="bg-transparent text-[13px] outline-none"
              aria-label="Journal entry date"
            />
          </div>
          <button
            type="button"
            onClick={() => setDate((d) => shiftDate(d, 1))}
            className="rounded-md border border-bcc-border bg-bcc-white p-2 text-bcc-text-secondary hover:text-bcc-text"
            aria-label="Next day"
          >
            <ChevronRight size={14} />
          </button>
          <button
            type="button"
            onClick={() => setDate(todayLocal())}
            className="rounded-md border border-bcc-border bg-bcc-white px-3 py-2 text-[12px] text-bcc-text-secondary hover:text-bcc-text"
          >
            Today
          </button>
        </div>
        <div className="flex items-center gap-2 text-[12px] text-bcc-text-muted">
          {saving ? (
            <span className="inline-flex items-center gap-1">
              <Loader2 size={12} className="animate-spin" /> Saving
            </span>
          ) : dirty ? (
            <span>Unsaved changes</span>
          ) : lastSavedAt ? (
            <span>Saved {new Date(lastSavedAt).toLocaleTimeString()}</span>
          ) : (
            // Bug 6 (v4.0.2): clearer empty-state copy.
            <span>No journal entry for today. Start writing to begin.</span>
          )}
          <button
            type="button"
            onClick={() => void save(date, body)}
            disabled={!dirty || saving}
            className="inline-flex items-center gap-1 rounded-md bg-bcc-text px-3 py-1 text-[12px] text-white disabled:opacity-50"
          >
            <Save size={12} /> Save now
          </button>
        </div>
      </div>

      <div
        className="rounded-xl border border-bcc-border bg-bcc-white overflow-hidden"
        aria-label="Journal entry editor"
      >
        <div className="flex items-center border-b border-bcc-border-light">
          <button
            type="button"
            onClick={() => setTab('edit')}
            className={`inline-flex items-center gap-1.5 px-4 py-2 text-[12px] uppercase tracking-[0.18em] ${
              tab === 'edit'
                ? 'bg-bcc-white text-bcc-text border-b-2 border-bcc-text'
                : 'text-bcc-text-muted'
            }`}
          >
            <FileText size={12} /> Edit
          </button>
          <button
            type="button"
            onClick={() => setTab('preview')}
            className={`inline-flex items-center gap-1.5 px-4 py-2 text-[12px] uppercase tracking-[0.18em] ${
              tab === 'preview'
                ? 'bg-bcc-white text-bcc-text border-b-2 border-bcc-text'
                : 'text-bcc-text-muted'
            }`}
          >
            <Eye size={12} /> Preview
          </button>
          <div className="flex-1" />
        </div>
        {loading ? (
          <div className="flex items-center gap-2 p-6 text-bcc-text-muted text-[13px]">
            <Loader2 size={14} className="animate-spin" /> Loading...
          </div>
        ) : tab === 'edit' ? (
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={`# ${date}\n\nWhat happened today? What is on your mind?`}
            rows={20}
            className="w-full px-4 py-3 bg-transparent outline-none text-[14px] leading-relaxed font-mono"
            aria-label="Journal body"
          />
        ) : (
          <pre className="px-4 py-3 text-[14px] leading-relaxed whitespace-pre-wrap font-sans">
            {body || (
              <span className="text-bcc-text-muted">
                No journal entry for today. Switch to the Edit tab to start writing.
              </span>
            )}
          </pre>
        )}
      </div>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
