'use client';

/**
 * Persona selection log (PRD section 6, gap E).
 *
 * History of persona assignments with the per-layer reasoning, filterable by
 * department, task type, date and mode. Reads GET /api/persona-selection-log, which
 * already existed with no UI caller. Honest states only: loading, error, and
 * an empty table say so; nothing is invented.
 */

import { useEffect, useMemo, useState } from 'react';

interface LogEntry {
  id: string;
  task_id: string;
  task_title?: string | null;
  persona_id: string;
  persona_name: string | null;
  mode: string | null;
  score: number | null;
  layer_scores: Record<string, unknown> | null;
  department_id: string | null;
  selected_at: string;
}

interface Props {
  /** id -> display name, so the table shows "Marketing" rather than a raw id. */
  departments?: { id: string; name: string }[];
}

const humanize = (key: string) => key.replace(/_/g, ' ');

/** The selector records the task's category inside layer_scores.task_category. */
const taskTypeOf = (e: LogEntry): string | null => {
  const c = e.layer_scores?.task_category;
  return typeof c === 'string' && c ? c : null;
};

const layerRows = (e: LogEntry): [string, unknown][] =>
  Object.entries(e.layer_scores ?? {}).filter(([k]) => k !== 'task_category');

function formatLayer(value: unknown): string {
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2);
  return String(value);
}

export function PersonaSelectionLog({ departments = [] }: Props) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dept, setDept] = useState('');
  const [mode, setMode] = useState('');
  const [taskType, setTaskType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch('/api/persona-selection-log?limit=200', { cache: 'no-store' });
        if (!res.ok) throw new Error(`Failed to load the selection log (${res.status})`);
        const data = await res.json();
        if (live) setEntries(Array.isArray(data.entries) ? data.entries : []);
      } catch (err) {
        if (live) setError(err instanceof Error ? err.message : 'Failed to load the selection log');
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const deptName = (id: string | null) =>
    id ? departments.find((d) => d.id === id)?.name ?? id : 'Unassigned';

  const deptOptions = useMemo(
    () => Array.from(new Set(entries.map((e) => e.department_id).filter(Boolean))) as string[],
    [entries],
  );
  const modeOptions = useMemo(
    () => Array.from(new Set(entries.map((e) => e.mode).filter(Boolean))) as string[],
    [entries],
  );

  const typeOptions = useMemo(
    () => Array.from(new Set(entries.map(taskTypeOf).filter(Boolean))) as string[],
    [entries],
  );

  const shown = entries.filter((e) => {
    if (dept && e.department_id !== dept) return false;
    if (mode && e.mode !== mode) return false;
    if (taskType && taskTypeOf(e) !== taskType) return false;
    const day = (e.selected_at || '').slice(0, 10);
    if (from && day < from) return false;
    if (to && day > to) return false;
    return true;
  });

  return (
    <section className="space-y-3" data-testid="persona-selection-log">
      <div>
        <h2 className="text-lg font-bold text-gray-900">Persona selection log</h2>
        <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">
          Which persona was picked for each task, and the reasoning scores behind it.
        </p>
      </div>

      <div className="flex flex-wrap gap-3 text-sm">
        <label className="flex flex-col gap-1 text-xs text-gray-500">
          Department
          <select
            value={dept}
            onChange={(e) => setDept(e.target.value)}
            className="px-2 py-1.5 bg-white border border-gray-200 rounded-lg text-sm text-gray-700"
          >
            <option value="">All departments</option>
            {deptOptions.map((id) => (
              <option key={id} value={id}>
                {deptName(id)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-500">
          Mode
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value)}
            className="px-2 py-1.5 bg-white border border-gray-200 rounded-lg text-sm text-gray-700"
          >
            <option value="">All modes</option>
            {modeOptions.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-500">
          Task type
          <select
            value={taskType}
            onChange={(e) => setTaskType(e.target.value)}
            className="px-2 py-1.5 bg-white border border-gray-200 rounded-lg text-sm text-gray-700"
          >
            <option value="">All task types</option>
            {typeOptions.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-500">
          From
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="px-2 py-1.5 bg-white border border-gray-200 rounded-lg text-sm text-gray-700"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-500">
          To
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="px-2 py-1.5 bg-white border border-gray-200 rounded-lg text-sm text-gray-700"
          />
        </label>
      </div>

      {loading ? (
        <div className="bg-white border border-gray-200 rounded-xl px-5 py-6 text-sm text-gray-500">
          Loading the selection log...
        </div>
      ) : error ? (
        <div role="alert" className="bg-red-50 border border-red-200 rounded-xl px-5 py-4 text-sm text-red-600">
          {error}
        </div>
      ) : shown.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-xl px-5 py-6 text-sm text-gray-500">
          {entries.length === 0
            ? 'No persona selections have been recorded yet.'
            : 'No selections match these filters.'}
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="text-xs text-gray-500 border-b border-gray-200">
              <tr>
                <th className="px-4 py-2 font-medium">When</th>
                <th className="px-4 py-2 font-medium">Task</th>
                <th className="px-4 py-2 font-medium">Department</th>
                <th className="px-4 py-2 font-medium">Persona</th>
                <th className="px-4 py-2 font-medium">Task type</th>
                <th className="px-4 py-2 font-medium">Mode</th>
                <th className="px-4 py-2 font-medium">Score</th>
                <th className="px-4 py-2 font-medium">Layer reasoning</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((e) => (
                <tr key={e.id} data-testid="persona-log-row" className="border-b border-gray-100 align-top">
                  <td className="px-4 py-2 whitespace-nowrap text-gray-600">
                    {new Date(e.selected_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-2 text-gray-900">{e.task_title || e.task_id}</td>
                  <td className="px-4 py-2 text-gray-700">{deptName(e.department_id)}</td>
                  <td className="px-4 py-2 text-gray-900">{e.persona_name || e.persona_id}</td>
                  <td className="px-4 py-2 text-gray-700">{taskTypeOf(e) ?? '-'}</td>
                  <td className="px-4 py-2 text-gray-700">{e.mode ?? '-'}</td>
                  <td className="px-4 py-2 text-gray-700">
                    {e.score === null || e.score === undefined ? '-' : formatLayer(e.score)}
                  </td>
                  <td className="px-4 py-2 text-gray-600">
                    {layerRows(e).length > 0 ? (
                      <ul className="space-y-0.5">
                        {layerRows(e).map(([k, v]) => (
                          <li key={k}>
                            <span className="text-gray-500">{humanize(k)}:</span> {formatLayer(v)}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      'None recorded'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
