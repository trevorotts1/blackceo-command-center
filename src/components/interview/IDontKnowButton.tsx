'use client';

/**
 * IDontKnowButton — the "I am not sure" affordance on every question that
 * allows it.
 *
 * It asks the PAGE HELPER for up to three suggestions (POST
 * /api/interview/assist, after marking the question unsure through
 * /api/interview/skip). Nothing is written for the owner and no sentence is
 * ever sent in the owner's name: the owner picks an idea, edits it, or writes
 * their own, and nothing is saved until they press Continue.
 */

import { motion } from 'framer-motion';
import { HelpCircle } from 'lucide-react';
import { iv, ivcx, ivTransition } from './interview-theme';

export interface IDontKnowButtonProps {
  /** Ask the helper for suggestions. Called on click. */
  onSuggest?: () => void;
  /** @deprecated legacy turn caller kept so older callers still compile. */
  onIDontKnow?: (msg: string) => void;
  /** Disable the button while a request is in flight. */
  disabled?: boolean;
  /** Session ID (passed through for context, unused by this button). */
  sessionId?: string | null;
  /** Optional: custom className. */
  className?: string;
}

export default function IDontKnowButton({
  onSuggest,
  onIDontKnow,
  disabled = false,
  sessionId,
  className,
}: IDontKnowButtonProps) {
  const handleClick = () => {
    if (onSuggest) {
      onSuggest();
      return;
    }
    // Legacy callers only. No sentence is written for the owner here.
    onIDontKnow?.('');
  };

  return (
    <motion.button
      type="button"
      onClick={handleClick}
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
      data-walkthrough="interview-not-sure"
    >
      <HelpCircle className="h-4 w-4" />
      <span>I am not sure</span>
    </motion.button>
  );
}

/**
 * RecommendationCard — one of the up-to-three ideas the helper returns.
 * Tapping it fills the answer box; it never saves.
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
