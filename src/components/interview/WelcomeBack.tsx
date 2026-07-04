'use client';

/**
 * WelcomeBack — the save / pause / resume landing screen (Wave 5 · P1-5).
 *
 * DOCTRINE: the interview is never lost and never restarts. The canonical files
 * (interview-handoff.md, workforce-interview-answers.md, .workforce-build-state.json)
 * are the single source of truth, written the same way whether the owner answered
 * on Telegram or here on the web. So when the owner comes back — even to a brand
 * new browser, even after starting on Telegram — GET /api/interview/state reads the
 * handoff, sees status="in_progress", and this screen greets them with exactly
 * where they stand and drops them back at their NEXT unanswered question. There is
 * deliberately no "start over" button: resume is the only forward path.
 *
 * What it shows (all derived from /api/interview/state → resume + progress):
 *   • "Welcome back — you're X% done, N answer(s) saved"   (percent + count)
 *   • the pick-up point (next_question_number) so it's clear nothing is redone
 *   • a CIRCLE-BACK QUEUE of any skipped_questions — each a chip the owner can
 *     jump straight to (the agent re-asks it as a normal follow-up)
 *   • a calm autosave reassurance ("every answer is saved — you can leave anytime")
 *
 * Presentational only: it renders the resume facts and calls back to
 * InterviewClient, which owns the turn/session logic and the persistence flush.
 * Styled to match the ConsentScreen / ConversationScreen already in
 * InterviewClient (slate→indigo canvas) so the three interview screens read as
 * one product. No jargon in any owner-facing string.
 */

import { motion } from 'framer-motion';
import { ArrowRight, CheckCircle2, RotateCcw, Sparkles } from 'lucide-react';

export interface WelcomeBackProps {
  /** Derived completion percent (q/30, capped 100) from /api/interview/state. */
  percent: number;
  /** How many answers are already saved (handoff.totalQuestionsAnswered). */
  answersSaved: number;
  /** The next unanswered question the owner resumes at (handoff.nextQuestionNumber). */
  nextQuestionNumber: number | null;
  /** Question numbers the owner skipped and can circle back to. */
  skippedQuestions: number[];
  /** Resume the conversation where it left off (never restarts). */
  onContinue: () => void;
  /** Jump straight to a specific skipped question (optional circle-back). */
  onReviewSkipped?: (questionNumber: number) => void;
}

export default function WelcomeBack({
  percent,
  answersSaved,
  nextQuestionNumber,
  skippedQuestions,
  onContinue,
  onReviewSkipped,
}: WelcomeBackProps) {
  const answerLabel = `${answersSaved} answer${answersSaved === 1 ? '' : 's'} saved`;
  const hasSkipped = skippedQuestions.length > 0;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-indigo-50 p-6 sm:p-8">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28, ease: [0.22, 0.61, 0.36, 1] }}
        className="max-w-2xl mx-auto"
      >
        {/* ── Header ─────────────────────────────────────────────────────────── */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center h-16 w-16 rounded-2xl bg-indigo-100 mb-4">
            <Sparkles className="h-9 w-9 text-indigo-600" />
          </div>
          <p className="text-xs font-semibold uppercase tracking-wide text-indigo-500 mb-1">
            Welcome back
          </p>
          <h1 className="text-3xl font-bold text-gray-900 mb-2">
            You&apos;re {percent}% done
          </h1>
          <p className="text-gray-600">
            {answerLabel} — right where you left them. Let&apos;s pick up from here.
          </p>
        </div>

        {/* ── Progress + pick-up point ───────────────────────────────────────── */}
        <div className="bg-white rounded-2xl shadow-sm border p-5 mb-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-700">Your progress</span>
            <span className="text-sm font-semibold text-indigo-600">{percent}%</span>
          </div>
          <div className="w-full h-2.5 bg-gray-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-indigo-500 to-emerald-500 rounded-full transition-all duration-500"
              style={{ width: `${percent}%` }}
            />
          </div>
          <div className="flex items-center gap-2 mt-3 text-sm text-emerald-700">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            <span>Every answer is saved — you can leave anytime.</span>
          </div>
          {nextQuestionNumber != null && (
            <p className="text-xs text-gray-500 mt-2">
              You&apos;ll pick up at question {nextQuestionNumber} — nothing you&apos;ve
              already answered is redone.
            </p>
          )}
        </div>

        {/* ── Circle-back queue (skipped questions) ──────────────────────────── */}
        {hasSkipped && (
          <div className="bg-white rounded-2xl shadow-sm border p-5 mb-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-700 mb-1">
              <RotateCcw className="h-4 w-4 text-indigo-600" />
              Come back to these
            </h3>
            <p className="text-xs text-gray-500 mb-3">
              You skipped {skippedQuestions.length} question
              {skippedQuestions.length === 1 ? '' : 's'} earlier. Tap one to answer it
              now, or keep going and we&apos;ll bring them back later.
            </p>
            <div className="flex flex-wrap gap-2">
              {skippedQuestions.map((qn) => (
                <button
                  key={qn}
                  type="button"
                  onClick={() => onReviewSkipped?.(qn)}
                  disabled={!onReviewSkipped}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                    onReviewSkipped
                      ? 'border-indigo-200 bg-indigo-50 text-indigo-700 hover:border-indigo-300 hover:bg-indigo-100'
                      : 'border-gray-200 bg-gray-50 text-gray-500 cursor-default'
                  }`}
                >
                  <RotateCcw className="h-3 w-3" />
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
          className="w-full inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl font-semibold bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
        >
          Continue where I left off
          <ArrowRight className="h-5 w-5" />
        </button>
      </motion.div>
    </div>
  );
}
