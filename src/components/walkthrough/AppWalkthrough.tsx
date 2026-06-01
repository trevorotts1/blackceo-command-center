'use client';

/**
 * AppWalkthrough — app-wide, INTERACTIVE guided tour (B3).
 *
 * Generalizes the Operator-Console-only OperatorOnboarding overlay into a
 * root-mounted, per-route walkthrough. Mounted ONCE in the root layout; it
 * selects the deck for the current pathname (getDeckForPath) and runs it.
 *
 * What makes it interactive (vs the old static modal):
 *   - As each card is shown it NAVIGATES to the card's route (if different) and
 *     SCROLLS the named `[data-walkthrough="<target>"]` element into view, then
 *     paints a highlight ring + dim around it so the user sees exactly what the
 *     card describes. The old overlay just showed text in a centered box.
 *   - The dialog re-positions to a corner while a target is highlighted so it
 *     does not cover the thing it is pointing at.
 *
 * Behavior carried over from OperatorOnboarding:
 *   - First-run auto-open per deck (localStorage `bcc-<deckId>-walkthrough-seen`).
 *   - Re-openable via window CustomEvent(WALKTHROUGH_OPEN_EVENT,{detail:{deck?,card?}}).
 *   - Esc / arrows / focus trap / WCAG AA controls.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronLeft, ChevronRight, X, Sparkles } from 'lucide-react';
import {
  getDeckForPath,
  getDeckById,
  WALKTHROUGH_OPEN_EVENT,
  walkthroughSeenKey,
  type WalkthroughDeck,
} from './walkthrough-content';

interface OpenDetail {
  deck?: string;
  card?: string;
}

const HIGHLIGHT_CLASS = 'bcc-walkthrough-highlight';

export default function AppWalkthrough() {
  const pathname = usePathname() || '/';
  const router = useRouter();

  const routeDeck = useMemo(() => getDeckForPath(pathname), [pathname]);

  const [open, setOpen] = useState(false);
  const [deck, setDeck] = useState<WalkthroughDeck | undefined>(routeDeck);
  const [index, setIndex] = useState(0);
  const [hasTarget, setHasTarget] = useState(false);

  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const highlightedEl = useRef<HTMLElement | null>(null);

  const cards = deck?.cards ?? [];
  const total = cards.length;

  // ---- highlight helpers -------------------------------------------------
  const clearHighlight = useCallback(() => {
    if (highlightedEl.current) {
      highlightedEl.current.classList.remove(HIGHLIGHT_CLASS);
      highlightedEl.current = null;
    }
    setHasTarget(false);
  }, []);

  const highlightTarget = useCallback((target?: string) => {
    clearHighlight();
    if (!target) return;
    // Element may not exist yet right after navigation — retry briefly.
    let tries = 0;
    const tryHighlight = () => {
      const el = document.querySelector<HTMLElement>(`[data-walkthrough="${target}"]`);
      if (el) {
        el.classList.add(HIGHLIGHT_CLASS);
        highlightedEl.current = el;
        setHasTarget(true);
        el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
        return;
      }
      if (tries++ < 12) setTimeout(tryHighlight, 120);
    };
    tryHighlight();
  }, [clearHighlight]);

  // ---- open / close ------------------------------------------------------
  const openDeck = useCallback(
    (targetDeck: WalkthroughDeck | undefined, cardId?: string) => {
      if (!targetDeck || targetDeck.cards.length === 0) return;
      previouslyFocused.current = (document.activeElement as HTMLElement) ?? null;
      setDeck(targetDeck);
      const i = cardId ? targetDeck.cards.findIndex((c) => c.id === cardId) : 0;
      setIndex(i >= 0 ? i : 0);
      setOpen(true);
    },
    []
  );

  const close = useCallback(() => {
    setOpen(false);
    clearHighlight();
    if (deck) {
      try {
        localStorage.setItem(walkthroughSeenKey(deck.id), '1');
      } catch {
        /* private mode — non-fatal */
      }
    }
    const el = previouslyFocused.current;
    if (el && typeof el.focus === 'function') {
      requestAnimationFrame(() => el.focus());
    }
  }, [clearHighlight, deck]);

  // ---- first-run auto-open (per route deck) ------------------------------
  useEffect(() => {
    if (!routeDeck) return;
    let seen = false;
    try {
      seen = localStorage.getItem(walkthroughSeenKey(routeDeck.id)) === '1';
    } catch {
      seen = false;
    }
    if (!seen) {
      const t = setTimeout(() => openDeck(routeDeck), 450);
      return () => clearTimeout(t);
    }
  }, [routeDeck, openDeck]);

  // ---- re-open via window event ------------------------------------------
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<OpenDetail>).detail || {};
      const target = detail.deck ? getDeckById(detail.deck) : routeDeck;
      openDeck(target, detail.card);
    };
    window.addEventListener(WALKTHROUGH_OPEN_EVENT, handler as EventListener);
    return () => window.removeEventListener(WALKTHROUGH_OPEN_EVENT, handler as EventListener);
  }, [routeDeck, openDeck]);

  // ---- drive interactivity: navigate + highlight on each card ------------
  const card = cards[index];
  useEffect(() => {
    if (!open || !card) return;
    const targetRoute = card.route;
    if (targetRoute && pathname !== targetRoute) {
      router.push(targetRoute);
      // Give the route a moment to mount before scrolling to the anchor.
      const t = setTimeout(() => highlightTarget(card.target), 300);
      return () => clearTimeout(t);
    }
    highlightTarget(card.target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, index, card?.route, card?.target]);

  // ---- keyboard: Esc / arrows + focus trap -------------------------------
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

  // ---- move focus into dialog on open ------------------------------------
  useEffect(() => {
    if (!open) return;
    const root = dialogRef.current;
    if (!root) return;
    const focusable = root.querySelector<HTMLElement>(
      'button:not([disabled]), [href], input, [tabindex]:not([tabindex="-1"])'
    );
    requestAnimationFrame(() => focusable?.focus());
  }, [open, index]);

  // ---- clean up highlight on unmount -------------------------------------
  useEffect(() => () => clearHighlight(), [clearHighlight]);

  const isFirst = index === 0;
  const isLast = index === total - 1;

  return (
    <AnimatePresence>
      {open && card && deck && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          // When pointing at a target, dim the page but DON'T block clicks on
          // the highlighted area visually covering it; keep the scrim light.
          className={`fixed inset-0 z-[60] p-4 ${
            hasTarget
              ? 'bg-black/30 flex items-end justify-end'
              : 'grid place-items-center bg-black/40 backdrop-blur-sm'
          }`}
          onClick={close}
        >
          <motion.div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="app-walkthrough-title"
            aria-describedby="app-walkthrough-body"
            initial={{ y: 16, opacity: 0, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 8, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 28 }}
            onClick={(e) => e.stopPropagation()}
            className={`${
              hasTarget ? 'm-2' : ''
            } w-[min(460px,94vw)] max-h-[88vh] overflow-y-auto rounded-xl border border-bcc-border bg-bcc-white shadow-xl`}
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
                    {deck.label} · {index + 1} of {total}
                  </div>
                  <h2
                    id="app-walkthrough-title"
                    className="mt-0.5 text-card-title text-bcc-text"
                  >
                    {card.title}
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
              <p id="app-walkthrough-body" className="mt-3 text-body text-bcc-text-secondary">
                {card.body}
              </p>
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
