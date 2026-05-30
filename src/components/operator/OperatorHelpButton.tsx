'use client';

/**
 * OperatorHelpButton — re-opens the Operator Console walkthrough (Feature 1).
 *
 * A tiny client affordance that dispatches the
 * `bcc:operator-onboarding` window event consumed by OperatorOnboarding.tsx.
 * Optionally jumps straight to a specific module's card via `card`.
 *
 * Used in two places:
 *   - Per sub-module page header: a small "What is this?" button that opens
 *     that module's card (e.g. <OperatorHelpButton card="goals" />). Sub-module
 *     pages are server components; this is the one client child they add.
 *   - The sidebar footer: a "Show walkthrough" / "?" control that opens the
 *     full walkthrough from the start.
 *
 * Accessibility: real <button> with aria-label, ≥44px tap target, visible focus
 * ring, icon + text label (never icon-only without an accessible name).
 */

import { HelpCircle } from 'lucide-react';
import { ONBOARDING_OPEN_EVENT } from './OperatorOnboarding';

interface OperatorHelpButtonProps {
  /** Module card id to jump to (e.g. 'goals'); omit to start at the beginning. */
  card?: string;
  /** Visible label text. Defaults to "What is this?". */
  label?: string;
  /** 'inline' (page header pill) | 'sidebar' (footer link). */
  variant?: 'inline' | 'sidebar';
  className?: string;
}

export default function OperatorHelpButton({
  card,
  label = 'What is this?',
  variant = 'inline',
  className,
}: OperatorHelpButtonProps) {
  function open() {
    window.dispatchEvent(
      new CustomEvent(ONBOARDING_OPEN_EVENT, { detail: card ? { card } : {} })
    );
  }

  if (variant === 'sidebar') {
    return (
      <button
        type="button"
        onClick={open}
        aria-label="Open the Operator Console walkthrough"
        className={`inline-flex items-center gap-1.5 min-h-[44px] text-[12px] text-bcc-text-secondary hover:text-bcc-text transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bcc-primary rounded ${className ?? ''}`}
      >
        <HelpCircle size={14} aria-hidden="true" />
        {label}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={open}
      aria-label={card ? `What is this? Explain the ${card} module` : 'Open the walkthrough'}
      className={`inline-flex items-center gap-1.5 min-h-[36px] px-3 py-1.5 rounded-lg border border-bcc-border bg-bcc-white text-[14px] font-medium text-bcc-text-secondary hover:text-bcc-text hover:border-bcc-text-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bcc-primary ${className ?? ''}`}
    >
      <HelpCircle size={15} aria-hidden="true" />
      {label}
    </button>
  );
}
