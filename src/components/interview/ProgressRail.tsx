'use client';

import { useEffect, useState } from 'react';
import { iv, ivcx, ivState, ivTokens } from './interview-theme';

/**
 * ProgressRail (P1-3) — always-visible stepper showing phases 0-6 in plain English.
 *
 * Driven by interviewProgress.phasesComplete + lastQuestionNumber from
 * GET /api/interview/state. Percent derived client-side (no stored field).
 * Autosave indicator ('Saved — you can leave anytime') renders at the top.
 *
 * DESIGN: calm, minimal left/top rail; phases marked as done/active; a derived
 * percent bar below the steps. No jargon in labels.
 */

/** Plain-English phase labels (0-6 = 7 phases). */
const PHASE_LABELS = [
  'Welcome',
  'Your story',
  'Your brand',
  'Your team',
  'Your departments',
  'Review',
  'Build',
] as const;

export interface ProgressRailProps {
  /**
   * Completed phase array (from interviewProgress.phasesComplete).
   * The length of this array determines which phases are marked as done:
   * all phases with index < length are marked `is-done`. The phase at
   * index = length is marked `is-active` (or the last phase if all complete).
   * @example
   *   phasesComplete = [] → phase 0 is active
   *   phasesComplete = ['a', 'b'] → phases 0-1 are done, phase 2 is active
   *   phasesComplete = ['a', ..., 'g'] → all done, phase 6 stays active
   */
  phasesComplete?: string[];

  /**
   * Last question number answered (from progress.lastQuestionNumber).
   * Used only to derive the percent bar via q/30 formula;
   * not used for phase logic.
   */
  lastQuestionNumber?: number | null;
}

export default function ProgressRail({
  phasesComplete = [],
  lastQuestionNumber = null,
}: ProgressRailProps) {
  const [mounted, setMounted] = useState(false);

  // Hydration guard — the percent bar animates, so render empty until client-side.
  useEffect(() => {
    setMounted(true);
  }, []);

  /**
   * Derive percent: q/30 denominator, capped 100 (mirrors derivedPercent in seam).
   * Same calculation the server uses so both read/agree.
   */
  const percent = mounted
    ? Math.min(100, Math.round(((lastQuestionNumber ?? 0) / 30) * 100))
    : 0;

  /**
   * Determine which phase is active: the one after all completed phases.
   * If phasesComplete has N items, phase N is active (0-indexed).
   * If all phases are complete, the last phase stays active.
   */
  const completedCount = phasesComplete.length;
  const activePhaseIndex = Math.min(completedCount, PHASE_LABELS.length - 1);

  return (
    <div className="space-y-3">
      {/* Autosave indicator */}
      <div
        className="text-xs font-medium"
        style={{ color: ivTokens.accent }}
      >
        Saved — you can leave anytime
      </div>

      {/* Phase steps rail */}
      <div className={iv.rail}>
        {PHASE_LABELS.map((label, idx) => {
          const isDone = idx < completedCount;
          const isActive = idx === activePhaseIndex;

          return (
            <div
              key={idx}
              className={ivcx(
                iv.railStep,
                isDone && ivState.done,
                isActive && ivState.active,
              )}
            >
              <div className={iv.railDot} />
              <span>{label}</span>
            </div>
          );
        })}
      </div>

      {/* Progress bar (derived percent) */}
      <div className="mt-4">
        <div className={iv.progressTrack}>
          <div
            className={iv.progressFill}
            style={{ width: `${percent}%` }}
          />
        </div>
        <div
          className="text-xs mt-1"
          style={{ color: ivTokens.accentStrong }}
        >
          {percent}% complete
        </div>
      </div>
    </div>
  );
}
