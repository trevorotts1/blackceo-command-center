'use client';

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Brain, AlertCircle, CheckCircle2, RefreshCw } from 'lucide-react';

/**
 * PersonaGovernanceBoard — Wave 4 of the post-analysis remediation.
 *
 * Surfaces the live persona_assignment table on the CEO board: which
 * coaching persona is governing each (department, task category) pair
 * right now, with the most recent adherence score where available.
 *
 * Reads from GET /api/persona-assignment?include_verification=true.
 *
 * Empty state means either no tasks have been dispatched yet OR the
 * persona-selector isn't writing to the table (Wave 4.1 sub-task — should
 * not happen after the v2.py write_persona_assignment_db change).
 */

interface Assignment {
  id: string;
  department_id: string;
  task_category: string;
  persona_id: string;
  persona_name: string | null;
  persona_mode: string | null;
  persona_version: number | null;
  last_score: number | null;
  last_assigned_at: string;
  switch_count: number | null;
  verification_last_score?: number | null;
  verification_count?: number | null;
  verification?: {
    adherence_score: number;
    applied_standards?: string[];
    deviations?: string[];
    notes?: string;
  } | null;
}

interface ApiResponse {
  success: boolean;
  assignments: Assignment[];
  count: number;
  verification_available: boolean;
  message?: string;
  error?: string;
}

function scoreColor(score: number | null | undefined): string {
  if (score == null) return 'text-gray-400';
  if (score >= 0.85) return 'text-green-600';
  if (score >= 0.7)  return 'text-emerald-600';
  if (score >= 0.5)  return 'text-amber-600';
  return 'text-red-600';
}

function scoreBg(score: number | null | undefined): string {
  if (score == null) return 'bg-gray-50';
  if (score >= 0.85) return 'bg-green-50';
  if (score >= 0.7)  return 'bg-emerald-50';
  if (score >= 0.5)  return 'bg-amber-50';
  return 'bg-red-50';
}

function relativeTime(iso: string): string {
  try {
    const ms = Date.now() - new Date(iso).getTime();
    const min = Math.floor(ms / 60000);
    if (min < 1)   return 'just now';
    if (min < 60)  return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24)   return `${hr}h ago`;
    const d = Math.floor(hr / 24);
    return `${d}d ago`;
  } catch {
    return iso;
  }
}

function formatPersonaName(persona_id: string, persona_name: string | null): string {
  if (persona_name) return persona_name;
  return persona_id
    .split('-')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

export function PersonaGovernanceBoard() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/persona-assignment?include_verification=true', {
        cache: 'no-store',
      });
      const json: ApiResponse = await res.json();
      if (!json.success) throw new Error(json.error || 'unknown error');
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 30_000); // refresh every 30s
    return () => clearInterval(id);
  }, []);

  const assignments = data?.assignments ?? [];
  const groupedByDept = assignments.reduce<Record<string, Assignment[]>>((acc, a) => {
    const key = a.department_id;
    if (!acc[key]) acc[key] = [];
    acc[key].push(a);
    return acc;
  }, {});

  const sortedDepts = Object.keys(groupedByDept).sort();
  const totalAdherence = assignments
    .map((a) => a.verification_last_score)
    .filter((v): v is number => v != null);
  const avgAdherence = totalAdherence.length > 0
    ? totalAdherence.reduce((s, v) => s + v, 0) / totalAdherence.length
    : null;

  return (
    <motion.section
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm"
    >
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <Brain className="w-5 h-5 text-indigo-600" />
          <h2 className="text-lg font-semibold text-gray-900">Persona Governance</h2>
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className="text-gray-400 hover:text-gray-700 transition-colors disabled:opacity-50"
          aria-label="Refresh"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {avgAdherence != null && (
        <div className="mb-4 flex items-center gap-3 text-sm">
          <span className="text-gray-500">Avg post-task adherence:</span>
          <span className={`font-semibold ${scoreColor(avgAdherence)}`}>
            {(avgAdherence * 100).toFixed(0)}%
          </span>
          <span className="text-gray-400">({totalAdherence.length} verified)</span>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          <AlertCircle className="w-4 h-4" />
          {error}
        </div>
      )}

      {!error && !loading && assignments.length === 0 && (
        <div className="p-4 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-600">
          <div className="font-medium">No persona assignments yet.</div>
          <div className="mt-1 text-gray-500">
            {data?.message ||
              'Dispatch a task through the persona-selector to populate this board. The selector auto-writes to persona_assignment on every dispatch (Wave 4.1).'}
          </div>
        </div>
      )}

      {!error && assignments.length > 0 && (
        <div className="space-y-4">
          {sortedDepts.map((dept) => {
            const rows = groupedByDept[dept];
            return (
              <div key={dept} className="border border-gray-100 rounded-lg p-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
                  {dept.replace(/^dept-/, '').replace(/-/g, ' ')}
                </div>
                <div className="space-y-2">
                  {rows.map((a) => (
                    <div
                      key={a.id}
                      className={`flex items-center justify-between gap-3 p-2 rounded-md ${scoreBg(a.last_score)}`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-gray-900 truncate">
                            {formatPersonaName(a.persona_id, a.persona_name)}
                          </span>
                          {a.persona_mode && (
                            <span className="text-xs px-1.5 py-0.5 bg-white border border-gray-200 rounded text-gray-600">
                              {a.persona_mode}
                            </span>
                          )}
                          {(a.switch_count ?? 0) >= 5 && (
                            <span
                              className="text-xs px-1.5 py-0.5 bg-amber-100 border border-amber-200 rounded text-amber-700"
                              title="Stale assignment — persona has rotated 5+ times here"
                            >
                              high churn
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-gray-500 mt-0.5">
                          {a.task_category} · {relativeTime(a.last_assigned_at)}
                          {a.verification_count != null && a.verification_count > 0 && (
                            <span className="ml-2">
                              · verified {a.verification_count}×
                            </span>
                          )}
                        </div>
                        {a.verification?.notes && (
                          <div className="text-xs text-gray-600 mt-1 italic">
                            {a.verification.notes}
                          </div>
                        )}
                      </div>
                      <div className="flex flex-col items-end">
                        <div className={`text-sm font-semibold ${scoreColor(a.last_score)}`}>
                          {a.last_score != null ? a.last_score.toFixed(2) : '—'}
                        </div>
                        {a.verification_last_score != null && (
                          <div
                            className={`text-xs flex items-center gap-1 mt-0.5 ${scoreColor(a.verification_last_score)}`}
                          >
                            <CheckCircle2 className="w-3 h-3" />
                            {(a.verification_last_score * 100).toFixed(0)}%
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </motion.section>
  );
}

export default PersonaGovernanceBoard;
