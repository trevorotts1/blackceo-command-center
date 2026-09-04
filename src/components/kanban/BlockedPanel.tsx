'use client';

/**
 * BlockedPanel — FIX 51a (W18b-B1) — extracted from MissionQueue.tsx.
 *
 * The "block transparency panel" on the card face: audience badge, block
 * reason, QC gaps list, next-step line, and the U061 heal-attempts indicator.
 * FIX 51 (master Part 8) gives the presentation parent card the same face, so
 * the panel is shared instead of duplicated.
 *
 * Renders NOTHING (null) unless the task is blocked AND carries at least one
 * block field — identical gating to the original inline block.
 */

import type { Task } from '@/lib/types';

/**
 * FIX 51b — the panel reads exactly these fields, so the prop is the
 * structural subset instead of the full Task: a presentation parent card
 * (PresentationParentCard.tsx) renders the SAME panel from its narrower
 * face row without fabricating a complete Task. Every full Task still
 * satisfies this type unchanged.
 */
export type BlockedPanelTask = Pick<
  Task,
  'status' | 'block_reason' | 'block_gaps' | 'block_needs' | 'block_audience' | 'dispatch_attempts'
>;

export function BlockedPanel({ task }: { task: BlockedPanelTask }) {
  if (!(task.status === 'blocked' && (task.block_reason || task.block_needs || task.block_audience))) {
    return null;
  }

  return (
    <div className="mb-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs space-y-1"
      data-testid="card-face-blocked-panel">
      {/* Audience badge */}
      {task.block_audience && (
        <div className="flex items-center gap-1.5">
          <span
            className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide ${
              task.block_audience === 'SYSTEM'
                ? 'bg-purple-100 text-purple-700'
                : 'bg-red-100 text-red-700'
            }`}
          >
            {task.block_audience === 'SYSTEM' ? 'System fix needed' : 'Owner action needed'}
          </span>
        </div>
      )}
      {/* Block reason */}
      {task.block_reason && (
        <p className="text-red-700 font-medium leading-snug line-clamp-2">
          {task.block_reason}
        </p>
      )}
      {/* Gaps */}
      {task.block_gaps && (() => {
        try {
          const gaps: string[] = JSON.parse(task.block_gaps as string);
          if (gaps.length > 0) {
            return (
              <ul className="list-disc list-inside text-red-600 space-y-0.5 pl-0.5">
                {gaps.slice(0, 3).map((g, i) => (
                  <li key={i} className="line-clamp-1">{g}</li>
                ))}
              </ul>
            );
          }
        } catch { /* malformed JSON — skip */ }
        return null;
      })()}
      {/* Needs / resolution action */}
      {task.block_needs && (
        <p className="text-red-600 italic leading-snug line-clamp-2">
          Next step: {task.block_needs}
        </p>
      )}
      {/* U061 — compact heal indicator on the card face only (detail in the modal) */}
      {typeof task.dispatch_attempts === 'number' && task.dispatch_attempts > 0 && (
        <p className="text-red-600 font-medium" data-testid="card-face-heal-attempts">
          retrying — attempt {task.dispatch_attempts}
        </p>
      )}
    </div>
  );
}

export default BlockedPanel;
