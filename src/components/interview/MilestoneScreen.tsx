'use client';

/**
 * MilestoneScreen (P3-1) — Phase-complete celebration screens.
 *
 * Renders a brief, celebratory message when an interview phase completes.
 * Uses framer-motion for entrance animation and displays WORDS ONLY (never
 * deliverables or side-effects), honoring the No-Work-During-Interview gate.
 *
 * Example: "That's marketing done — 3 of 16 departments."
 *
 * Structure:
 *   • Dark-panel scope (iv.dark) for closeout continuity
 *   • Centered, single-focus layout (iv.stage)
 *   • Serif question face (iv.question) for the headline
 *   • Framer entrance animation + brief pause
 *   • Motion-driven exit when dismissed or auto-advancing
 *
 * Props:
 *   phase      - The phase name being celebrated (e.g., 'Marketing')
 *   totalDepts - Total departments in the expected set (denominator)
 *   completed  - Number of departments completed (numerator)
 *   onDismiss  - Called when the user advances or the auto-advance timer fires
 */

import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { iv, ivcx, ivTokens, ivScreenVariants, ivDurations, ivEase } from './interview-theme';

export interface MilestoneScreenProps {
  /** The department/phase name being celebrated. */
  phase: string;
  /** Total expected departments (denominator for the progress stat). */
  totalDepts: number;
  /** Number of departments completed so far (numerator). */
  completed: number;
  /** Called when the user dismisses the screen or the auto-advance timer fires. */
  onDismiss?: () => void;
  /** Optional: auto-advance after this many milliseconds. Null = no auto-advance. */
  autoAdvanceMs?: number | null;
}

export default function MilestoneScreen({
  phase,
  totalDepts,
  completed,
  onDismiss,
  autoAdvanceMs = 3500,
}: MilestoneScreenProps) {
  const [dismissed, setDismissed] = useState(false);

  // Auto-advance timer.
  useEffect(() => {
    if (!autoAdvanceMs || autoAdvanceMs <= 0) return;
    const timer = setTimeout(() => {
      handleDismiss();
    }, autoAdvanceMs);
    return () => clearTimeout(timer);
  }, [autoAdvanceMs]);

  const handleDismiss = () => {
    setDismissed(true);
    // Brief delay for exit animation to complete before calling onDismiss.
    setTimeout(() => {
      onDismiss?.();
    }, ivDurations.base * 1000 + 100);
  };

  return (
    <AnimatePresence mode="wait">
      {!dismissed && (
        <motion.div
          key="milestone"
          variants={ivScreenVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          className={iv.dark}
        >
          <div className="min-h-screen flex items-center justify-center p-6">
            <div className={iv.stage}>
              {/* ────── celebratory icon + copy ────── */}
              <div className="text-center">
                {/* Animated completion mark. */}
                <motion.div
                  initial={{ scale: 0, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{
                    duration: ivDurations.base,
                    ease: ivEase,
                    delay: 0.1,
                  }}
                  className="inline-flex items-center justify-center h-20 w-20 rounded-full mb-6"
                  style={{
                    background: `radial-gradient(circle, ${ivTokens.accent} 0%, ${ivTokens.accentWash} 100%)`,
                  }}
                >
                  <svg
                    className="h-10 w-10 stroke-white"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth={2.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <motion.polyline
                      points="20 6 9 17 4 12"
                      initial={{ pathLength: 0 }}
                      animate={{ pathLength: 1 }}
                      transition={{
                        duration: ivDurations.base,
                        ease: ivEase,
                        delay: 0.2,
                      }}
                    />
                  </svg>
                </motion.div>

                {/* Headline: "That's [phase] done" */}
                <motion.h1
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{
                    duration: ivDurations.base,
                    ease: ivEase,
                    delay: 0.15,
                  }}
                  className={iv.question}
                >
                  That&apos;s {phase} done
                </motion.h1>

                {/* Progress stat: "3 of 16 departments" */}
                <motion.p
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{
                    duration: ivDurations.base,
                    ease: ivEase,
                    delay: 0.25,
                  }}
                  className={ivcx(iv.lede, 'mt-3')}
                  style={{ color: ivTokens.ink }}
                >
                  {completed} of {totalDepts} department{totalDepts === 1 ? '' : 's'}
                </motion.p>

                {/* CTA: Continue or auto-advance hint */}
                <motion.button
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{
                    duration: ivDurations.base,
                    ease: ivEase,
                    delay: 0.35,
                  }}
                  onClick={handleDismiss}
                  type="button"
                  className={ivcx(iv.btnPrimary, 'mt-8')}
                >
                  Continue
                </motion.button>

                {/* Subtle auto-advance hint */}
                <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 0.6 }}
                  transition={{
                    duration: ivDurations.base * 2,
                    ease: ivEase,
                    delay: 0.5,
                  }}
                  className="text-xs mt-4"
                  style={{ color: ivTokens.inkFaint }}
                >
                  Continue in a moment…
                </motion.p>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
