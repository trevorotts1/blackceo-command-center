'use client';

/**
 * ArchiveBrowser — MR-42 archive transparency.
 *
 * Lists soft-archived tasks (done tasks that hit the 30-day rule, Sunday sweeps,
 * or were manually archived). The operator can see what was removed from the
 * visible board and restore any card with a single click.
 *
 * Fetches via GET /api/tasks?includeArchived=true&status=done.
 * Restore fires DELETE /api/tasks/[id]/archive.
 *
 * Deliberately omitted: per-card info bells (phase, persona, etc). This page is
 * a transparency surface for the archival system, not a second board.
 */

import { useCallback, useEffect, useState } from 'react';
import { Archive, ArrowUpRight, RefreshCw, RotateCcw, Search, AlertCircle } from 'lucide-react';
import type { Task } from '@/lib/types';

type ArchiveTask = Pick<
  Task,
  'id' | 'title' | 'status' | 'department' | 'archived_at' | 'updated_at' | 'created_at'
>;

interface ArchiveBrowserProps {
  initialTasks?: ArchiveTask[];
  initialError?: string;
}

function ageLabel(iso: string | null | undefined): string {
  if (!iso) return 'unknown';
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  if (days < 1) return 'today';
  if (days === 1) return '1 day ago';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months === 1) return '1 month ago';
  return `${months} months ago`;
}

export default function ArchiveBrowser({ initialTasks, initialError }: ArchiveBrowserProps) {
  const [tasks, setTasks] = useState<ArchiveTask[]>(initialTasks ?? []);
  const [loading, setLoading] = useState(!initialTasks);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [restoring, setRestoring] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');

  const fetchArchived = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/tasks?includeArchived=true&limit=200');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      // Filter client-side to only archived tasks (belt + suspenders: the API
      // returns everything when includeArchived is set).
      const archived = ((json.data ?? json) as ArchiveTask[]).filter(
        (t) => t.archived_at != null,
      );
      setTasks(archived);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!initialTasks) fetchArchived();
  }, [initialTasks, fetchArchived]);

  const restoreTask = useCallback(async (id: string) => {
    setRestoring((prev) => new Set(prev).add(id));
    try {
      const res = await fetch(`/api/tasks/${id}/archive`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setTasks((prev) => prev.filter((t) => t.id !== id));
    } catch (err) {
      setError(`Failed to restore task ${id}: ${(err as Error).message}`);
    } finally {
      setRestoring((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, []);

  const filtered = search.trim()
    ? tasks.filter(
        (t) =>
          t.title.toLowerCase().includes(search.toLowerCase()) ||
          (t.department ?? '').toLowerCase().includes(search.toLowerCase()) ||
          t.id.toLowerCase().includes(search.toLowerCase()),
      )
    : tasks;

  return (
    <div className="space-y-6">
      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-[400px]">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-bcc-text-muted"
          />
          <input
            type="text"
            placeholder="Search archived tasks..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-4 py-2 rounded-lg border border-bcc-border bg-bcc-white text-[14px] text-bcc-text placeholder:text-bcc-text-muted focus:outline-none focus:ring-2 focus:ring-bcc-accent/20"
          />
        </div>

        <button
          onClick={fetchArchived}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-bcc-border bg-bcc-white text-[13px] text-bcc-text-secondary hover:bg-bcc-border-light transition-colors disabled:opacity-50"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-[14px]">
          <AlertCircle size={16} />
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="py-16 text-center text-bcc-text-muted text-[14px]">
          Loading archived tasks…
        </div>
      )}

      {/* Empty */}
      {!loading && !error && tasks.length === 0 && (
        <div className="py-16 text-center space-y-2">
          <Archive size={40} className="mx-auto text-bcc-text-muted opacity-30" />
          <p className="text-[15px] text-bcc-text-secondary">No archived tasks.</p>
          <p className="text-[13px] text-bcc-text-muted max-w-[400px] mx-auto">
            Done tasks are soft-archived after 30 days (rule 4 in board-hygiene)
            and on the Sunday sweep. When that happens, they will appear here.
          </p>
        </div>
      )}

      {/* Filtered-empty */}
      {!loading && !error && tasks.length > 0 && filtered.length === 0 && (
        <div className="py-16 text-center space-y-2">
          <p className="text-[15px] text-bcc-text-secondary">No tasks match &quot;{search}&quot;.</p>
          <button
            onClick={() => setSearch('')}
            className="text-[13px] text-bcc-accent hover:underline"
          >
            Clear search
          </button>
        </div>
      )}

      {/* Table */}
      {!loading && filtered.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-bcc-border bg-bcc-white">
          <table className="w-full text-[14px]">
            <thead>
              <tr className="border-b border-bcc-border bg-bcc-border-light/50 text-bcc-text-muted text-[12px] uppercase tracking-[0.1em]">
                <th className="text-left font-semibold px-4 py-3">Task</th>
                <th className="text-left font-semibold px-4 py-3 hidden sm:table-cell">
                  Department
                </th>
                <th className="text-left font-semibold px-4 py-3 hidden md:table-cell">
                  Archived
                </th>
                <th className="text-right font-semibold px-4 py-3">Action</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((task) => (
                <tr
                  key={task.id}
                  className="border-b border-bcc-border last:border-0 hover:bg-bcc-border-light/30 transition-colors"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-start gap-2">
                      <Archive
                        size={14}
                        className="mt-0.5 shrink-0 text-bcc-text-muted opacity-50"
                      />
                      <div className="min-w-0">
                        <p className="text-bcc-text font-medium truncate max-w-[320px]">
                          {task.title}
                        </p>
                        <p className="text-[11px] text-bcc-text-muted font-mono mt-0.5">
                          {task.id.slice(0, 12)}…
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 hidden sm:table-cell">
                    <span className="inline-flex px-2 py-0.5 rounded-full bg-bcc-border-light text-[12px] text-bcc-text-secondary">
                      {task.department || '(unassigned)'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-bcc-text-muted hidden md:table-cell">
                    {ageLabel(task.archived_at)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => restoreTask(task.id)}
                      disabled={restoring.has(task.id)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-bcc-accent/10 text-bcc-accent text-[13px] font-medium hover:bg-bcc-accent/20 transition-colors disabled:opacity-50"
                    >
                      <RotateCcw
                        size={14}
                        className={restoring.has(task.id) ? 'animate-spin' : ''}
                      />
                      {restoring.has(task.id) ? 'Restoring…' : 'Restore'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Footer */}
      {!loading && filtered.length > 0 && (
        <p className="text-[12px] text-bcc-text-muted">
          Showing {filtered.length} of {tasks.length} archived task{tasks.length !== 1 ? 's' : ''}.
          {' '}Restored tasks reappear on the board immediately.
        </p>
      )}
    </div>
  );
}
