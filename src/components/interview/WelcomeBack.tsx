'use client';

/**
 * WelcomeBack — the resume landing screen.
 *
 * One true count, from the step gate: "Welcome back. You are N of M done.
 * Next: {question}" with one "Continue" button. Questions the owner set aside
 * are listed by their own wording — never as "Question 7" — and they come only
 * from the gate's own skipped list.
 */

import { motion } from 'framer-motion';
import { ArrowRight, CheckCircle2, RotateCcw, Sparkles } from 'lucide-react';
import { iv, ivcx, ivScreenVariants } from './interview-theme';

export interface WelcomeBackProps {
  /** Required questions already answered, from the gate. */
  requiredAnswered: number;
  /** Required questions in the registry, from the gate. */
  requiredTotal: number;
  /** The gate's next question, verbatim. Null once every required one is done. */
  nextPrompt?: string | null;
  /** Questions the gate still holds as skipped, shown by their own wording. */
  skipped?: Array<{ id: string; prompt: string }>;
  /** Resume the interview where it left off (never restarts). */
  onContinue: () => void;
}

export default function WelcomeBack({
  requiredAnswered,
  requiredTotal,
  nextPrompt = null,
  skipped = [],
  onContinue,
}: WelcomeBackProps) {
  const shownPercent =
    requiredTotal > 0 ? Math.max(0, Math.min(100, Math.round((requiredAnswered / requiredTotal) * 100))) : 0;

  return (
    <div className={iv.root}>
      <motion.div
        variants={ivScreenVariants}
        initial="initial"
        animate="animate"
        className={iv.stage}
      >
        <div className="text-center mb-8">
          <div
            className="inline-flex items-center justify-center h-16 w-16 mb-4"
            style={{
              borderRadius: 'var(--iv-radius)',
              background: 'var(--iv-accent-wash)',
            }}
          >
            <Sparkles aria-hidden className="h-9 w-9" style={{ color: 'var(--iv-accent-strong)' }} />
          </div>
          <p className={iv.eyebrow}>Welcome back</p>
          <h1 className={iv.question}>
            You are {requiredAnswered} of {requiredTotal} done
          </h1>
          <p className={ivcx(iv.lede, 'mt-2')}>
            Your answers are saved. Let&apos;s pick up from here.
          </p>
        </div>

        <div className={iv.card} style={{ marginBottom: '1rem' }}>
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
          <div
            className="flex items-center gap-2 mt-3 text-sm"
            style={{ color: 'var(--iv-accent-strong)' }}
          >
            <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
            <span>Your submitted answers are saved. Return to this page to continue.</span>
          </div>
          {nextPrompt ? (
            <p className="text-sm mt-3" style={{ color: 'var(--iv-ink-soft)' }}>
              Next:{' '}
              <span style={{ color: 'var(--iv-ink)', fontWeight: 600 }}>{nextPrompt}</span>
            </p>
          ) : null}
        </div>

        {skipped.length > 0 && (
          <div className={iv.card} style={{ marginBottom: '1rem' }}>
            <h3
              className="flex items-center gap-2 text-sm font-semibold mb-1"
              style={{ color: 'var(--iv-ink)' }}
            >
              <RotateCcw className="h-4 w-4" aria-hidden style={{ color: 'var(--iv-accent-strong)' }} />
              Come back to these
            </h3>
            <p className="text-xs mb-3" style={{ color: 'var(--iv-ink-faint)' }}>
              You set {skipped.length === 1 ? 'one question' : `${skipped.length} questions`} aside
              earlier. They stay here until you answer them, and you can keep going now.
            </p>
            <ul className="space-y-1">
              {skipped.map((q) => (
                <li key={q.id} className="text-sm" style={{ color: 'var(--iv-ink-soft)' }}>
                  {q.prompt}
                </li>
              ))}
            </ul>
          </div>
        )}

        <button
          type="button"
          onClick={onContinue}
          className={iv.btnPrimary}
          style={{ width: '100%', justifyContent: 'center' }}
        >
          Continue
          <ArrowRight className="h-5 w-5" aria-hidden />
        </button>
      </motion.div>
    </div>
  );
}
