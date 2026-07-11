'use client';

/**
 * WelcomeBack — the save / pause / resume landing screen (Wave 5 · P1-5,
 * v4.63 continuity + design-system refresh).
 *
 * DOCTRINE: the interview is never lost and never restarts. The canonical files
 * (interview-handoff.md, workforce-interview-answers.md, .workforce-build-state.json)
 * are the single source of truth, written the same way whether the owner answered
 * on Telegram or here on the web. So when the owner comes back — even to a brand
 * new browser, even after starting on Telegram — GET /api/interview/state reads
 * the transcript + handoff and this screen greets them with exactly where they
 * stand and drops them back at their NEXT unanswered question. There is
 * deliberately no "start over" button: resume is the only forward path.
 *
 * What it shows (all derived from /api/interview/state):
 *   • "Welcome back — you're X% done, N answer(s) saved"
 *   • the exact pick-up point: the next unanswered card's own words
 *     (`nextUpPrompt`), or the conversational question number
 *   • a CIRCLE-BACK QUEUE of skipped questions — structured ones re-open their
 *     exact card; conversational ones hand back to the interviewer
 *   • a calm autosave reassurance
 *
 * v4.63: restyled from the hardcoded slate/indigo palette onto the shared iv-*
 * design tokens, so this screen re-themes to the client's brand like every
 * other interview screen (the old palette pre-dated interview-theme.ts).
 */

import { motion } from 'framer-motion';
import { ArrowRight, CheckCircle2, RotateCcw, Sparkles } from 'lucide-react';
import { iv, ivcx, ivScreenVariants } from './interview-theme';

export interface WelcomeBackProps {
  /** Derived completion percent from /api/interview/state. */
  percent: number;
  /** How many answers are already saved (transcript block count). */
  answersSaved: number;
  /** The next conversational question number (handoff), when known. */
  nextQuestionNumber: number | null;
  /** The next unanswered STRUCTURED card's prompt — shown verbatim so the owner
   *  sees exactly what they'll pick up on. Null once the cards are done. */
  nextUpPrompt?: string | null;
  /** Conversational question numbers the owner skipped (agent-owned queue). */
  skippedQuestions: number[];
  /** Structured questions the owner skipped — each chip re-opens its card. */
  skippedStructured?: Array<{ id: string; prompt: string }>;
  /** Resume the interview where it left off (never restarts). */
  onContinue: () => void;
  /** Jump straight to a specific skipped conversational question. */
  onReviewSkipped?: (questionNumber: number) => void;
  /** Jump straight to a specific skipped structured card. */
  onReviewSkippedStructured?: (questionId: string) => void;
}

export default function WelcomeBack({
  percent,
  answersSaved,
  nextQuestionNumber,
  nextUpPrompt = null,
  skippedQuestions,
  skippedStructured = [],
  onContinue,
  onReviewSkipped,
  onReviewSkippedStructured,
}: WelcomeBackProps) {
  const answerLabel = `${answersSaved} answer${answersSaved === 1 ? '' : 's'} saved`;
  const hasSkipped = skippedQuestions.length > 0 || skippedStructured.length > 0;
  const shownPercent = Math.max(0, Math.min(100, Math.round(percent)));

  return (
    <div className={iv.root}>
      <motion.div
        variants={ivScreenVariants}
        initial="initial"
        animate="animate"
        className={iv.stage}
      >
        {/* ── Header ─────────────────────────────────────────────────────────── */}
        <div className="text-center mb-8">
          <div
            className="inline-flex items-center justify-center h-16 w-16 mb-4"
            style={{
              borderRadius: 'var(--iv-radius)',
              background: 'var(--iv-accent-wash)',
            }}
          >
            <Sparkles
              aria-hidden
              className="h-9 w-9"
              style={{ color: 'var(--iv-accent-strong)' }}
            />
          </div>
          <p className={iv.eyebrow}>Welcome back</p>
          <h1 className={iv.question}>You&apos;re {shownPercent}% done</h1>
          <p className={ivcx(iv.lede, 'mt-2')}>
            {answerLabel} — right where you left them. Let&apos;s pick up from here.
          </p>
        </div>

        {/* ── Progress + pick-up point ───────────────────────────────────────── */}
        <div className={iv.card} style={{ marginBottom: '1rem' }}>
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium" style={{ color: 'var(--iv-ink)' }}>
              Your progress
            </span>
            <span
              className="text-sm font-semibold"
              style={{ color: 'var(--iv-accent-strong)' }}
            >
              {shownPercent}%
            </span>
          </div>
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
            <span>Every answer is saved — you can leave anytime.</span>
          </div>
          {nextUpPrompt ? (
            <p className="text-sm mt-3" style={{ color: 'var(--iv-ink-soft)' }}>
              Next up:{' '}
              <span style={{ color: 'var(--iv-ink)', fontWeight: 600 }}>
                &ldquo;{nextUpPrompt}&rdquo;
              </span>{' '}
              — nothing you&apos;ve already answered is redone.
            </p>
          ) : nextQuestionNumber != null ? (
            <p className="text-xs mt-2" style={{ color: 'var(--iv-ink-faint)' }}>
              You&apos;ll pick up at question {nextQuestionNumber} — nothing you&apos;ve
              already answered is redone.
            </p>
          ) : null}
        </div>

        {/* ── Circle-back queue (skipped questions) ──────────────────────────── */}
        {hasSkipped && (
          <div className={iv.card} style={{ marginBottom: '1rem' }}>
            <h3
              className="flex items-center gap-2 text-sm font-semibold mb-1"
              style={{ color: 'var(--iv-ink)' }}
            >
              <RotateCcw
                className="h-4 w-4"
                aria-hidden
                style={{ color: 'var(--iv-accent-strong)' }}
              />
              Come back to these
            </h3>
            <p className="text-xs mb-3" style={{ color: 'var(--iv-ink-faint)' }}>
              You set{' '}
              {skippedQuestions.length + skippedStructured.length === 1
                ? 'one question'
                : `${skippedQuestions.length + skippedStructured.length} questions`}{' '}
              aside earlier. Tap one to answer it now, or keep going and come back later.
            </p>
            <div className="flex flex-wrap gap-2">
              {skippedStructured.map((q) => (
                <button
                  key={q.id}
                  type="button"
                  onClick={() => onReviewSkippedStructured?.(q.id)}
                  disabled={!onReviewSkippedStructured}
                  className="iv-chip"
                  title={q.prompt}
                >
                  <RotateCcw className="h-3 w-3" aria-hidden />
                  {q.prompt.length > 44 ? `${q.prompt.slice(0, 44)}…` : q.prompt}
                </button>
              ))}
              {skippedQuestions.map((qn) => (
                <button
                  key={qn}
                  type="button"
                  onClick={() => onReviewSkipped?.(qn)}
                  disabled={!onReviewSkipped}
                  className="iv-chip"
                >
                  <RotateCcw className="h-3 w-3" aria-hidden />
                  Question {qn}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ── Continue (the only forward path — never restarts) ──────────────── */}
        <button
          type="button"
          onClick={onContinue}
          className={iv.btnPrimary}
          style={{ width: '100%', justifyContent: 'center' }}
        >
          Continue where I left off
          <ArrowRight className="h-5 w-5" aria-hidden />
        </button>
      </motion.div>
    </div>
  );
}
