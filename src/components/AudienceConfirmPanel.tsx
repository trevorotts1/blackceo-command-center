'use client';

/**
 * D3 — Audience-confirm Kanban UI (persona-blend / W7 --blend).
 *
 * A content task the matcher ran through --blend (D1) carries a persona bundle
 * with `confirm_required: true`. Per the ALWAYS-confirm rule, the resolved ICP
 * audience is NEVER written without operator sign-off — the write is HELD
 * until this panel's confirm action calls POST /api/tasks/[id]/audience, or
 * the 30-minute never-naked deadline releases it under house-voice governance
 * (audience still unconfirmed). Without this panel, the only way a gated task
 * ever moved was waiting out that 30-minute timeout.
 *
 * Self-contained + fail-quiet: GETs its own gate status on mount and renders
 * NOTHING for a non-gated / already-confirmed task, so it is safe to always
 * mount (mirrors GatePanel's own early-return-to-null pattern, gated one level
 * up in TaskModal by the cheap `task.blend_directive` presence check so a plain
 * non-content task never even fires the fetch).
 */

import { useCallback, useEffect, useState } from 'react';
import { Users, Loader2, CheckCircle2 } from 'lucide-react';

interface AudienceGateStatus {
  hold: boolean;
  state: 'no_bundle' | 'not_required' | 'confirmed' | 'pending' | 'deadline_fallback';
  reason: string;
  audienceLabel: string | null;
  candidates: string[];
  prompt: string | null;
  firstHold: boolean;
}

interface AudienceConfirmPanelProps {
  taskId: string;
  /** Called after a successful confirm so the modal/board can refresh. */
  onConfirmed?: () => void;
}

export function AudienceConfirmPanel({ taskId, onConfirmed }: AudienceConfirmPanelProps) {
  const [status, setStatus] = useState<AudienceGateStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [customLabel, setCustomLabel] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/tasks/${taskId}/audience`);
      setStatus(res.ok ? await res.json() : null);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    load();
  }, [load]);

  const confirm = useCallback(
    async (label: string) => {
      const trimmed = label.trim();
      if (!trimmed) return;
      setSubmitting(true);
      setError(null);
      try {
        const res = await fetch(`/api/tasks/${taskId}/audience`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audienceLabel: trimmed }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}) as { error?: string });
          setError(body.error || 'Failed to confirm audience');
          return;
        }
        setCustomLabel('');
        await load();
        onConfirmed?.();
      } catch {
        setError('Failed to confirm audience');
      } finally {
        setSubmitting(false);
      }
    },
    [taskId, load, onConfirmed],
  );

  // Nothing to show: still loading, no gate data, or the task isn't currently
  // held for confirmation (not_required / already confirmed / no bundle /
  // released past the deadline all render nothing here).
  if (loading || !status || !status.hold) return null;

  return (
    <div className="mb-4 rounded-xl border border-indigo-300 bg-indigo-50 p-4">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-full bg-indigo-100 p-1.5">
          <Users className="h-4 w-4 text-indigo-700" />
        </div>
        <div className="flex-1">
          <h4 className="text-sm font-semibold text-indigo-900">Confirm audience before dispatch</h4>
          {status.prompt && <p className="mt-1 text-xs text-indigo-800">{status.prompt}</p>}

          {error && <p className="mt-2 text-xs font-medium text-red-700">{error}</p>}

          {status.candidates.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {status.candidates.map((c) => (
                <button
                  key={c}
                  type="button"
                  disabled={submitting}
                  onClick={() => confirm(c)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700 disabled:opacity-60"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  {c}
                </button>
              ))}
            </div>
          )}

          <div className="mt-3 flex items-center gap-2">
            <input
              type="text"
              value={customLabel}
              onChange={(e) => setCustomLabel(e.target.value)}
              placeholder="Name the audience..."
              className="flex-1 rounded-lg border border-indigo-200 bg-white px-3 py-1.5 text-xs text-gray-900 focus:border-indigo-500 focus:outline-none"
            />
            <button
              type="button"
              disabled={submitting || !customLabel.trim()}
              onClick={() => confirm(customLabel)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-300 bg-white px-3 py-1.5 text-xs font-medium text-indigo-700 transition-colors hover:bg-indigo-100 disabled:opacity-60"
            >
              {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Confirm'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
