'use client';

/**
 * ConversationPane — P1-4 polished conversational UI component
 *
 * Responsibilities:
 *   1. Display interviewer bubbles with warm reactions (Oprah/Couric voice)
 *   2. One-question-at-a-time layout with framer-motion 250ms slide/fade transitions
 *   3. Text input field for owner to type their answer
 *   4. "I don't know" button for research protocol (integrated via IDontKnowButton)
 *   5. Clear visual hierarchy with the question as the focal point
 *
 * This component receives the interview state (current question, session history,
 * messages) from the parent InterviewClient and focuses purely on rendering the
 * conversational flow with polish and warmth. The actual turn logic (sendTurn,
 * "I don't know" research) remains in the parent for state management.
 *
 * Design tokens from interview-theme.ts ensure one aesthetic across all screens.
 */

import { useRef, useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Send, Loader2, HelpCircle } from 'lucide-react';
import { iv, ivcx, ivTransition, ivDurations, ivEase } from './interview-theme';
import IDontKnowButton from './IDontKnowButton';

export interface ConversationPaneProps {
  /** The current interviewer reaction or question intro. Empty string = no bubble yet. */
  currentReaction: string;
  /** The current question text shown to the owner (empty = waiting for first question). */
  currentQuestion: string;
  /** Owner's typed input (controlled by parent). */
  input: string;
  /** Called when owner types in the input field. */
  onInput: (v: string) => void;
  /** Called when owner submits via Send button or Enter. */
  onSend: () => void;
  /** Called when owner clicks "I don't know" to trigger research protocol. */
  onIDontKnow: (msg: string) => void;
  /** True while a turn is in flight. */
  sending: boolean;
  /** Session ID for continued conversations (needed by IDontKnowButton). */
  sessionId: string | null;
  /** Ref to the scroll container for auto-scroll. */
  scrollRef: React.RefObject<HTMLDivElement>;
  /** Optional: custom className for the root. */
  className?: string;
}

export default function ConversationPane({
  currentReaction,
  currentQuestion,
  input,
  onInput,
  onSend,
  onIDontKnow,
  sending,
  sessionId,
  scrollRef,
  className,
}: ConversationPaneProps) {
  const canSend = input.trim().length > 0 && !sending;

  // Auto-scroll when reactions or questions change.
  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [currentReaction, currentQuestion, scrollRef]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (canSend) onSend();
    }
  };

  return (
    // aria-live: interviewer reactions + questions are announced to screen
    // readers as they land (polite — never interrupts the owner mid-typing).
    <div className={ivcx('flex flex-col gap-6', className)} aria-live="polite">
      {/* ── Warm Reaction Bubble ─────────────────────────────────────────────── */}
      <AnimatePresence mode="wait">
        {currentReaction && (
          <motion.div
            key={`reaction-${currentReaction}`}
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{
              duration: ivDurations.fast,
              ease: ivEase,
            }}
            className="flex justify-start"
          >
            <div className={ivcx(iv.bubbleAgent, 'text-sm max-w-md')}>
              {currentReaction}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── The Question (One at a Time, 250ms Slide) ───────────────────────── */}
      <AnimatePresence mode="wait">
        {currentQuestion && (
          <motion.div
            key={`question-${currentQuestion}`}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{
              duration: 0.25, // 250ms as per spec
              ease: ivEase,
            }}
            className="space-y-4"
          >
            {/* Question with serif display face for focal point */}
            <div>
              <h2 className={ivcx(iv.question, 'text-2xl sm:text-3xl')}>
                {currentQuestion}
              </h2>
            </div>

            {/* Input Field + Send Button */}
            <div className="flex flex-col gap-3">
              <div className="flex items-end gap-2">
                <textarea
                  value={input}
                  onChange={(e) => onInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  rows={3}
                  placeholder="Type your answer…"
                  className={ivcx(
                    iv.input,
                    'flex-1 resize-none max-h-40 focus:outline-none',
                  )}
                  disabled={sending}
                />
                <button
                  type="button"
                  onClick={onSend}
                  disabled={!canSend}
                  aria-label="Send answer"
                  className={ivcx(
                    iv.btn,
                    iv.btnPrimary,
                    'shrink-0 h-11 w-11 inline-flex items-center justify-center',
                    !canSend && 'opacity-50 cursor-not-allowed',
                  )}
                >
                  {sending ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : (
                    <Send className="h-5 w-5" />
                  )}
                </button>
              </div>

              {/* "I Don't Know" Button */}
              <IDontKnowButton
                onIDontKnow={onIDontKnow}
                disabled={sending}
                sessionId={sessionId}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Waiting State ────────────────────────────────────────────────────── */}
      {!currentQuestion && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3 }}
          className="text-center py-12"
        >
          <Loader2 className="h-5 w-5 text-slate-400 animate-spin mx-auto mb-2" />
          <p className="text-sm text-slate-500">
            Your interviewer is getting ready…
          </p>
        </motion.div>
      )}

      {/* Scroll anchor */}
      <div ref={scrollRef} className="h-0" />
    </div>
  );
}
