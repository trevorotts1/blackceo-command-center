'use client';

import { useEffect, useState } from 'react';
import { iv, ivcx, ivState, ivTokens } from './interview-theme';

/**
 * ProgressRail (P1-3, v4.63 refresh) — always-visible stepper showing the
 * interview phases in plain English.
 *
 * Driven ENTIRELY by server truth from GET /api/interview/state:
 *   • `percent` is the server-derived completion percent (one formula, one
 *     place — the client no longer re-computes its own copy);
 *   • `answersSaved` is the live transcript block count, so the autosave line
 *     tells the truth ("7 answers saved") instead of a static promise;
 *   • `lastSavedAt` flashes a "Saved just now" confirmation after each save.
 *
 * Accessibility: the steps render as an ordered list with aria-current on the
 * active phase, and the bar is a real progressbar with value semantics. The
 * autosave line is polite-live so screen readers hear saves land.
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

/** How long the "Saved just now" flash stays up after a save. */
const SAVED_FLASH_MS = 4_000;

export interface ProgressRailProps {
  /**
   * Completed phase array (from interviewProgress.phasesComplete).
   * All phases with index < length are marked done; the phase at
   * index = length is active (or the last phase if all complete).
   */
  phasesComplete?: string[];

  /** Server-derived completion percent (progress.percent). */
  percent?: number;

  /** Live saved-answer count (transcript.qBlockCount). */
  answersSaved?: number;

  /** Epoch ms of the most recent successful save (flashes "Saved just now"). */
  lastSavedAt?: number | null;
}

export default function ProgressRail({
  phasesComplete = [],
  percent = 0,
  answersSaved = 0,
  lastSavedAt = null,
}: ProgressRailProps) {
  const [mounted, setMounted] = useState(false);
  const [flash, setFlash] = useState(false);

  // Hydration guard — the percent bar animates, so render empty until client-side.
  useEffect(() => {
    setMounted(true);
  }, []);

  // Flash the save confirmation briefly whenever a new save lands.
  useEffect(() => {
    if (!lastSavedAt) return;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), SAVED_FLASH_MS);
    return () => clearTimeout(t);
  }, [lastSavedAt]);

  const shownPercent = mounted ? Math.max(0, Math.min(100, Math.round(percent))) : 0;

  const completedCount = phasesComplete.length;
  const activePhaseIndex = Math.min(completedCount, PHASE_LABELS.length - 1);

  const savedLine = flash
    ? 'Saved just now ✓'
    : answersSaved > 0
      ? `${answersSaved} answer${answersSaved === 1 ? '' : 's'} saved — you can leave anytime`
      : 'Every answer saves automatically';

  return (
    <div className="space-y-3">
      {/* Autosave truth line (live region so saves are announced). */}
      <div
        className="text-xs font-medium"
        style={{ color: ivTokens.accent }}
        aria-live="polite"
      >
        {savedLine}
      </div>

      {/* Phase steps rail */}
      <ol className={iv.rail} style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {PHASE_LABELS.map((label, idx) => {
          const isDone = idx < completedCount;
          const isActive = idx === activePhaseIndex;

          return (
            <li
              key={idx}
              className={ivcx(
                iv.railStep,
                isDone && ivState.done,
                isActive && ivState.active,
              )}
              aria-current={isActive ? 'step' : undefined}
            >
              <div className={iv.railDot} />
              <span>{label}</span>
            </li>
          );
        })}
      </ol>

      {/* Progress bar (server-derived percent) */}
      <div className="mt-4">
        <div
          className={iv.progressTrack}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={shownPercent}
          aria-label="Interview progress"
        >
          <div className={iv.progressFill} style={{ width: `${shownPercent}%` }} />
        </div>
        <div className="text-xs mt-1" style={{ color: ivTokens.accentStrong }}>
          {shownPercent}% complete
        </div>
      </div>
    </div>
  );
}
