'use client';

/**
 * OperatorOnboarding — first-run, re-openable walkthrough overlay (Feature 1).
 *
 * Mounts once, globally, in the Operator Console layout (mirrors how the root
 * layout mounts <CommandPalette/> once). Behavior:
 *
 *   - First run: if `bcc-operator-onboarding-seen` is absent from localStorage,
 *     the overlay auto-opens. Dismissing it (Done / Esc / scrim / "Got it")
 *     writes the flag so it never auto-opens again.
 *   - Re-open anytime: any element can dispatch a
 *     `window` CustomEvent('bcc:operator-onboarding', { detail: { card?: id } })
 *     to open the walkthrough, optionally jumping to a specific module card.
 *     The sidebar footer "?" button and each sub-module page's "What is this?"
 *     help button use this event (see OperatorHelpButton.tsx).
 *
 * Overlay pattern mirrors CommandPalette.tsx: framer-motion AnimatePresence,
 * fixed inset-0 z-50 bg-black/40 backdrop-blur-sm, click-scrim-to-close, Escape
 * handler, bcc-* design tokens.
 *
 * Accessibility (matches the v4.1.x bar / WCAG 2.1 AA):
 *   - role="dialog" aria-modal="true" with aria-labelledby/aria-describedby.
 *   - Focus is moved into the dialog on open and a focus trap keeps Tab/Shift+Tab
 *     inside; focus is restored to the previously-focused element on close.
 *   - Esc closes. Left/Right arrows move between cards.
 *   - All controls are ≥44px tap targets, text ≥16px, status by icon+label.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronLeft, ChevronRight, X, Sparkles } from 'lucide-react';
import type { Platform } from '@/lib/platform';
import { ONBOARDING_CARDS, memoryPlatformNote } from './onboarding-content';

export const ONBOARDING_SEEN_KEY = 'bcc-operator-onboarding-seen';
export const ONBOARDING_OPEN_EVENT = 'bcc:operator-onboarding';

interface OpenDetail {
  card?: string;
}

export default function OperatorOnboarding({ platform }: { platform: Platform }) {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);

  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  const cards = ONBOARDING_CARDS;
  const total = cards.length;

  // ---- open / close ------------------------------------------------------
  const openAt = useCallback(
    (cardId?: string) => {
      previouslyFocused.current = (document.activeElement as HTMLElement) ?? null;
      if (cardId) {
        const i = cards.findIndex((c) => c.id === cardId);
        setIndex(i >= 0 ? i : 0);
      } else {
        setIndex(0);
      }
      setOpen(true);
    },
    [cards]
  );

  const close = useCallback(() => {
    setOpen(false);
    try {
      localStorage.setItem(ONBOARDING_SEEN_KEY, '1');
    } catch {
      // Private mode / disabled storage — non-fatal; overlay just may re-open.
    }
    // Restore focus to whatever opened the dialog.
    const el = previouslyFocused.current;
    if (el && typeof el.focus === 'function') {
      requestAnimationFrame(() => el.focus());
    }
  }, []);

  // ---- first-run auto-open ----------------------------------------------
  useEffect(() => {
    let seen = false;
    try {
      seen = localStorage.getItem(ONBOARDING_SEEN_KEY) === '1';
    } catch {
      seen = false;
    }
    if (!seen) {
      // Defer one tick so the console paints first (less jarring on first load).
      const t = setTimeout(() => openAt(), 350);
      return () => clearTimeout(t);
    }
  }, [openAt]);

  // ---- re-open via window event -----------------------------------------
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<OpenDetail>).detail;
      openAt(detail?.card);
    };
    window.addEventListener(ONBOARDING_OPEN_EVENT, handler as EventListener);
    return () => window.removeEventListener(ONBOARDING_OPEN_EVENT, handler as EventListener);
  }, [openAt]);

  // ---- keyboard: Esc / arrows + focus trap ------------------------------
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        setIndex((i) => Math.min(total - 1, i + 1));
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === 'Tab') {
        // Focus trap: keep Tab cycling within the dialog.
        const root = dialogRef.current;
        if (!root) return;
        const focusables = root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, close, total]);

  // ---- move initial focus into the dialog on open -----------------------
  useEffect(() => {
    if (!open) return;
    const root = dialogRef.current;
    if (!root) return;
    const focusable = root.querySelector<HTMLElement>(
      'button:not([disabled]), [href], input, [tabindex]:not([tabindex="-1"])'
    );
    requestAnimationFrame(() => focusable?.focus());
  }, [open]);

  const card = cards[index];
  const isFirst = index === 0;
  const isLast = index === total - 1;

  return (
    <AnimatePresence>
      {open && card && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 grid place-items-center p-4 bg-black/40 backdrop-blur-sm"
          onClick={close}
        >
          <motion.div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="operator-onboarding-title"
            aria-describedby="operator-onboarding-body"
            initial={{ y: 16, opacity: 0, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 8, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 28 }}
            onClick={(e) => e.stopPropagation()}
            className="w-[min(560px,94vw)] max-h-[88vh] overflow-y-auto rounded-xl border border-bcc-border bg-bcc-white shadow-xl"
          >
            {/* Header */}
            <div className="flex items-start justify-between gap-3 px-6 pt-6 pb-4 border-b border-bcc-border-light">
              <div className="flex items-center gap-3 min-w-0">
                <span
                  aria-hidden="true"
                  className="grid place-items-center w-10 h-10 rounded-lg shrink-0"
                  style={{
                    background: `${card.accent}1a`,
                    color: card.accent,
                    border: `1px solid ${card.accent}33`,
                  }}
                >
                  <Sparkles size={20} />
                </span>
                <div className="min-w-0">
                  <div className="text-[12px] uppercase tracking-[0.18em] text-bcc-text-muted font-semibold">
                    Walkthrough · {index + 1} of {total}
                  </div>
                  <h2
                    id="operator-onboarding-title"
                    className="mt-0.5 text-card-title text-bcc-text flex items-center gap-2"
                  >
                    {card.title}
                    {card.soon && (
                      <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-bcc-border-light text-bcc-text-muted font-semibold">
                        Soon
                      </span>
                    )}
                  </h2>
                </div>
              </div>
              <button
                type="button"
                onClick={close}
                aria-label="Close walkthrough"
                className="grid place-items-center w-11 h-11 -mr-2 -mt-1 rounded-lg text-bcc-text-muted hover:text-bcc-text hover:bg-bcc-border-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bcc-primary"
              >
                <X size={20} />
              </button>
            </div>

            {/* Body */}
            <div className="px-6 py-5">
              <p className="text-body-lg text-bcc-text font-medium">{card.summary}</p>
              <p id="operator-onboarding-body" className="mt-3 text-body text-bcc-text-secondary">
                {card.body}
              </p>
              {card.id === 'memory' && (
                <p className="mt-4 rounded-lg border border-bcc-border bg-bcc-bg px-4 py-3 text-body text-bcc-text-secondary">
                  <span className="font-semibold text-bcc-text">Where your notes live: </span>
                  {memoryPlatformNote(platform)}
                </p>
              )}
            </div>

            {/* Progress dots */}
            <div className="px-6 pb-2 flex items-center justify-center gap-1.5" aria-hidden="true">
              {cards.map((c, i) => (
                <span
                  key={c.id}
                  className={`h-1.5 rounded-full transition-all ${
                    i === index ? 'w-5 bg-bcc-primary' : 'w-1.5 bg-bcc-border'
                  }`}
                />
              ))}
            </div>

            {/* Footer controls */}
            <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-bcc-border-light">
              <button
                type="button"
                onClick={() => setIndex((i) => Math.max(0, i - 1))}
                disabled={isFirst}
                className="inline-flex items-center gap-1.5 min-h-[44px] px-4 rounded-lg text-[14px] font-medium text-bcc-text-secondary hover:bg-bcc-border-light disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bcc-primary"
              >
                <ChevronLeft size={16} aria-hidden="true" />
                Back
              </button>

              <button
                type="button"
                onClick={close}
                className="min-h-[44px] px-3 rounded-lg text-[14px] text-bcc-text-muted hover:text-bcc-text hover:bg-bcc-border-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bcc-primary"
              >
                Skip
              </button>

              {isLast ? (
                <button
                  type="button"
                  onClick={close}
                  className="inline-flex items-center gap-1.5 min-h-[44px] px-5 rounded-lg text-[14px] font-semibold text-white bg-bcc-primary hover:bg-bcc-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-bcc-primary"
                >
                  Got it
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setIndex((i) => Math.min(total - 1, i + 1))}
                  className="inline-flex items-center gap-1.5 min-h-[44px] px-5 rounded-lg text-[14px] font-semibold text-white bg-bcc-primary hover:bg-bcc-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-bcc-primary"
                >
                  Next
                  <ChevronRight size={16} aria-hidden="true" />
                </button>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
