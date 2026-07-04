'use client';

/**
 * IDontKnowButton — P1-4 research protocol trigger
 *
 * Responsibilities:
 *   1. Render a prominent "I don't know" button under the question
 *   2. Trigger the agent's 6-step research protocol via a callback to the parent
 *
 * Design:
 *   - Button appears below the input field as a secondary action
 *   - On click, calls onIDontKnow() which the parent (ConversationPane/InterviewClient)
 *     handles by sending a turn via /api/interview/turn
 *   - The agent responds with a recommendation, which the parent's message history
 *     detects and renders as an option-card set or normal follow-up question
 *   - Drill-down follow-ups render as normal conversation messages (warm reactions + question)
 *
 * The parent (InterviewClient) is responsible for:
 *   - Detecting when the agent returns a "recommendation" response
 *   - Rendering recommendation cards (go with it / adjust / skip) via RecommendationCard
 *   - Managing the conversation flow and session state
 */

import { motion } from 'framer-motion';
import { HelpCircle } from 'lucide-react';
import { iv, ivcx, ivTransition } from './interview-theme';

export interface IDontKnowButtonProps {
  /** Called when user clicks the "I don't know" button. Parent handles turn dispatch. */
  onIDontKnow: (msg: string) => void;
  /** Disable the button while a turn is in flight. */
  disabled?: boolean;
  /** Session ID (passed through for context, unused by this button). */
  sessionId?: string | null;
  /** Optional: custom className. */
  className?: string;
}

export default function IDontKnowButton({
  onIDontKnow,
  disabled = false,
  sessionId,
  className,
}: IDontKnowButtonProps) {
  const handleIDontKnow = () => {
    // Trigger the research protocol. The parent (InterviewClient) will:
    // 1. Send this to /api/interview/turn
    // 2. Receive the agent's research recommendation
    // 3. Render it as either a recommendation card set or a drill-down question
    onIDontKnow("I don't know the answer to that. Can you suggest something based on what you know?");
  };

  return (
    <motion.button
      type="button"
      onClick={handleIDontKnow}
      disabled={disabled}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={ivTransition}
      className={ivcx(
        iv.btn,
        iv.btnGhost,
        'w-full flex items-center justify-center gap-2',
        disabled && 'opacity-50 cursor-not-allowed',
        className,
      )}
    >
      <HelpCircle className="h-4 w-4" />
      <span>I don't know</span>
    </motion.button>
  );
}

/**
 * RecommendationCard — renders a single option from the agent's research recommendation
 *
 * Used when the agent returns a structured recommendation with multiple options
 * (e.g., go with this / adjust / skip). The parent detects the recommendation
 * structure in the agent's message and renders these cards for each option.
 */
export function RecommendationCard({
  label,
  description,
  onSelect,
  disabled = false,
}: {
  label: string;
  description: string;
  onSelect: () => void;
  disabled?: boolean;
}) {
  return (
    <motion.button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={ivTransition}
      className={ivcx(
        iv.card,
        'text-left transition-colors hover:border-accent',
        disabled && 'opacity-50 cursor-not-allowed',
      )}
    >
      <div className="flex items-start gap-3">
        <div className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-slate-300 text-xs font-medium text-slate-500 shrink-0">
          →
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-medium text-gray-900">{label}</p>
          <p className="text-sm text-gray-600 mt-0.5">{description}</p>
        </div>
      </div>
    </motion.button>
  );
}
