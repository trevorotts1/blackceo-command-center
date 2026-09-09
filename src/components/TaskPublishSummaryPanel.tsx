'use client';

/**
 * TaskPublishSummaryPanel — F30 client completion + exception summary in the
 * task detail (TaskModal overview). Self-contained + fail-quiet (the same
 * pattern as AudienceConfirmPanel/PersonaPickerPanel):
 *
 *   GETs /api/tasks/{taskId}/publish-summary — a read-only endpoint that
 *   derives the summary from PERSISTED state only (the canonical task row,
 *   its task_events transitions, and the company-scoped publish_queue rows
 *   linked to it). Renders NOTHING when the endpoint errors or there is no
 *   publish intent: a plain task never sees a fabricated "working on it".
 *
 * The message itself is built server-side by buildTaskSummary
 * (src/lib/social/summary.ts) — this component is display-only.
 */

import { useEffect, useState } from 'react';
import type { SocialSummaryMessage } from '@/lib/social/summary';

export function TaskPublishSummaryPanel({ taskId }: { taskId: string }) {
  const [summary, setSummary] = useState<SocialSummaryMessage | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/tasks/${taskId}/publish-summary`, { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { summary?: SocialSummaryMessage | null } | null) => {
        if (!cancelled && data?.summary) setSummary(data.summary);
      })
      .catch(() => {
        // fail-quiet: no summary is better than a fabricated one
      });
    return () => { cancelled = true; };
  }, [taskId]);

  if (!summary) return null;

  const tone =
    summary.stage === 'failed' || summary.stage === 'overdue'
      ? 'border-red-200 bg-red-50 text-red-700'
      : summary.owner === 'client'
        ? 'border-amber-200 bg-amber-50 text-amber-800'
        : 'border-gray-200 bg-gray-50 text-gray-600';

  return (
    <div
      data-testid="task-publish-summary"
      className={`rounded-lg border p-3 text-sm ${tone}`}
    >
      <div className="font-semibold capitalize mb-0.5">
        Publish status: {summary.stage}
      </div>
      <div>{summary.nextAction}</div>
      <div className="mt-1 text-xs opacity-70">
        {summary.owner === 'client' ? 'Your move' : 'System-owned'}
        {summary.retryDeadline
          ? ` · retry by ${new Date(summary.retryDeadline).toLocaleString()}`
          : ''}
        {summary.lastVerified ? ` · last verified: ${summary.lastVerified}` : ''}
      </div>
      {summary.failures.length > 0 && (
        <div className="mt-1 text-xs">{summary.failures.join('; ')}</div>
      )}
    </div>
  );
}

export default TaskPublishSummaryPanel;