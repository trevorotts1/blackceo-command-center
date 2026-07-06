'use client';

/**
 * AppWalkthrough — app-wide, INTERACTIVE guided tour (E10 / B3).
 *
 * Generalizes the Operator-Console-only OperatorOnboarding overlay into a
 * root-mounted, per-route walkthrough. Mounted ONCE in the root layout; it
 * selects the deck for the current pathname (getDeckForPath) and runs it.
 *
 * What makes it interactive (vs the old static modal):
 *   - As each card is shown it NAVIGATES to the card's route (if different) and
 *     finds the named `[data-walkthrough="<target>"]` element.
 *   - The element gets a highlight ring + the page is dimmed around it.
 *   - The popover panel is ANCHORED to the highlighted element: it reads the
 *     element's getBoundingClientRect and positions itself above/below/left/right
 *     based on available viewport space, with a small arrow pointing at the
 *     element. This is a genuine coach-mark, not a corner-placed modal.
 *   - When no target is present (intro / summary cards) the panel falls back to
 *     the centered-modal layout so the UX stays clean for targetless cards.
 *   - Position is recalculated on scroll and resize so it stays attached.
 *
 * No new dependencies added. Positioning is done with vanilla DOM
 * getBoundingClientRect + React state. Framer-motion (already in deps) handles
 * enter/exit. Arrow is a CSS border-trick div injected inline.
 *
 * Behavior carried over from OperatorOnboarding:
 *   - First-run auto-open per deck (localStorage `bcc-<deckId>-walkthrough-seen`).
 *   - Re-openable via window CustomEvent(WALKTHROUGH_OPEN_EVENT,{detail:{deck?,card?}}).
 *   - Esc / arrows / focus trap / WCAG AA controls.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
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

/** Placement of the popover relative to the anchor element. */
type Placement = 'below' | 'above' | 'left' | 'right';

interface PopoverPosition {
  top: number;
  left: number;
  placement: Placement;
}

const POPOVER_W = 420; // px — kept narrow so it never obscures the anchor
const POPOVER_MARGIN = 16; // min gap between popover edge and viewport edge
const ANCHOR_GAP = 14; // gap between anchor rect and popover box (+ arrow height)

/**
 * The popover's EFFECTIVE width: capped to the viewport so a phone screen
 * (e.g. 375px) never gets a 420px card whose close/Next controls hang off the
 * right edge with no way to dismiss it (there is no Escape key on a phone).
 */
function popoverWidth(vw: number): number {
  return Math.min(POPOVER_W, vw - 2 * POPOVER_MARGIN);
}

/**
 * Compute where to place the popover so it stays on-screen and doesn't
 * overlap the anchor element. Preference order: below → above → right → left.
 */
function computePosition(
  anchorRect: DOMRect,
  popoverH: number,
  vw: number,
  vh: number,
): PopoverPosition {
  const candidates: Placement[] = ['below', 'above', 'right', 'left'];
  const w = popoverWidth(vw);

  for (const placement of candidates) {
    let top = 0;
    let left = 0;

    if (placement === 'below') {
      top = anchorRect.bottom + ANCHOR_GAP;
      left = anchorRect.left + anchorRect.width / 2 - w / 2;
    } else if (placement === 'above') {
      top = anchorRect.top - ANCHOR_GAP - popoverH;
      left = anchorRect.left + anchorRect.width / 2 - w / 2;
    } else if (placement === 'right') {
      top = anchorRect.top + anchorRect.height / 2 - popoverH / 2;
      left = anchorRect.right + ANCHOR_GAP;
    } else {
      // left
      top = anchorRect.top + anchorRect.height / 2 - popoverH / 2;
      left = anchorRect.left - ANCHOR_GAP - w;
    }

    // Clamp horizontally
    left = Math.max(POPOVER_MARGIN, Math.min(left, vw - w - POPOVER_MARGIN));
    // Clamp vertically
    top = Math.max(POPOVER_MARGIN, Math.min(top, vh - popoverH - POPOVER_MARGIN));

    // Check it doesn't overlap the anchor rect (rough check)
    const fits =
      top + popoverH <= vh - POPOVER_MARGIN &&
      top >= POPOVER_MARGIN &&
      left + w <= vw - POPOVER_MARGIN &&
      left >= POPOVER_MARGIN;

    if (fits) return { top, left, placement };
  }

  // Fallback: center on screen
  return {
    top: Math.max(POPOVER_MARGIN, (vh - popoverH) / 2),
    left: Math.max(POPOVER_MARGIN, (vw - w) / 2),
    placement: 'below',
  };
}

export default function AppWalkthrough() {
  const pathname = usePathname() || '/';
  const router = useRouter();

  const routeDeck = useMemo(() => getDeckForPath(pathname), [pathname]);

  const [open, setOpen] = useState(false);
  const [deck, setDeck] = useState<WalkthroughDeck | undefined>(routeDeck);
  const [index, setIndex] = useState(0);
  const [hasTarget, setHasTarget] = useState(false);
  const [popoverPos, setPopoverPos] = useState<PopoverPosition | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const highlightedEl = useRef<HTMLElement | null>(null);
  const positionRafRef = useRef<number | null>(null);

  const cards = deck?.cards ?? [];
  const total = cards.length;

  // ---- popover positioning -------------------------------------------------
  const updatePosition = useCallback(() => {
    const el = highlightedEl.current;
    const dialog = dialogRef.current;
    if (!el || !dialog) return;

    const anchorRect = el.getBoundingClientRect();
    const popoverH = dialog.offsetHeight || 340;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    setPopoverPos(computePosition(anchorRect, popoverH, vw, vh));
  }, []);

  const schedulePositionUpdate = useCallback(() => {
    if (positionRafRef.current !== null) cancelAnimationFrame(positionRafRef.current);
    positionRafRef.current = requestAnimationFrame(() => {
      updatePosition();
      positionRafRef.current = null;
    });
  }, [updatePosition]);

  // ---- highlight helpers ---------------------------------------------------
  const clearHighlight = useCallback(() => {
    if (highlightedEl.current) {
      highlightedEl.current.classList.remove(HIGHLIGHT_CLASS);
      highlightedEl.current = null;
    }
    setHasTarget(false);
    setPopoverPos(null);
  }, []);

  const highlightTarget = useCallback(
    (target?: string) => {
      clearHighlight();
      if (!target) return;

      let tries = 0;
      const tryHighlight = () => {
        const el = document.querySelector<HTMLElement>(`[data-walkthrough="${target}"]`);
        if (el) {
          el.classList.add(HIGHLIGHT_CLASS);
          highlightedEl.current = el;
          setHasTarget(true);
          el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
          // Wait for scroll to settle, then compute position.
          setTimeout(schedulePositionUpdate, 350);
          return;
        }
        if (tries++ < 12) setTimeout(tryHighlight, 120);
      };
      tryHighlight();
    },
    [clearHighlight, schedulePositionUpdate],
  );

  // ---- open / close --------------------------------------------------------
  const openDeck = useCallback(
    (targetDeck: WalkthroughDeck | undefined, cardId?: string) => {
      if (!targetDeck || targetDeck.cards.length === 0) return;
      previouslyFocused.current = (document.activeElement as HTMLElement) ?? null;
      setDeck(targetDeck);
      const i = cardId ? targetDeck.cards.findIndex((c) => c.id === cardId) : 0;
      setIndex(i >= 0 ? i : 0);
      setOpen(true);
    },
    [],
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

  // ---- first-run auto-open (per route deck) --------------------------------
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

  // ---- re-open via window event --------------------------------------------
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<OpenDetail>).detail || {};
      const target = detail.deck ? getDeckById(detail.deck) : routeDeck;
      openDeck(target, detail.card);
    };
    window.addEventListener(WALKTHROUGH_OPEN_EVENT, handler as EventListener);
    return () => window.removeEventListener(WALKTHROUGH_OPEN_EVENT, handler as EventListener);
  }, [routeDeck, openDeck]);

  // ---- drive interactivity: navigate + highlight on each card --------------
  const card = cards[index];
  useEffect(() => {
    if (!open || !card) return;
    const targetRoute = card.route;
    if (targetRoute && pathname !== targetRoute) {
      router.push(targetRoute);
      const t = setTimeout(() => highlightTarget(card.target), 300);
      return () => clearTimeout(t);
    }
    highlightTarget(card.target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, index, card?.route, card?.target]);

  // ---- reposition on scroll / resize ---------------------------------------
  useEffect(() => {
    if (!open || !hasTarget) return;
    const onEvent = () => schedulePositionUpdate();
    window.addEventListener('resize', onEvent, { passive: true });
    window.addEventListener('scroll', onEvent, { passive: true, capture: true });
    return () => {
      window.removeEventListener('resize', onEvent);
      window.removeEventListener('scroll', onEvent, { capture: true });
    };
  }, [open, hasTarget, schedulePositionUpdate]);

  // ---- recompute after dialog height changes (e.g. card body length) -------
  useEffect(() => {
    if (!open || !hasTarget) return;
    // Wait for the popover to paint at its new content height, then reposition.
    const t = setTimeout(schedulePositionUpdate, 50);
    return () => clearTimeout(t);
  }, [open, index, hasTarget, schedulePositionUpdate]);

  // ---- keyboard: Esc / arrows + focus trap ---------------------------------
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
          'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
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

  // ---- move focus into dialog on open --------------------------------------
  useEffect(() => {
    if (!open) return;
    const root = dialogRef.current;
    if (!root) return;
    const focusable = root.querySelector<HTMLElement>(
      'button:not([disabled]), [href], input, [tabindex]:not([tabindex="-1"])',
    );
    requestAnimationFrame(() => focusable?.focus());
  }, [open, index]);

  // ---- clean up highlight + pending RAF on unmount -------------------------
  useEffect(
    () => () => {
      clearHighlight();
      if (positionRafRef.current !== null) cancelAnimationFrame(positionRafRef.current);
    },
    [clearHighlight],
  );

  const isFirst = index === 0;
  const isLast = index === total - 1;

  // Arrow style for the coach-mark pointer
  const arrowStyle = (placement: Placement): CSSProperties => {
    const base: CSSProperties = {
      position: 'absolute',
      width: 0,
      height: 0,
      pointerEvents: 'none',
    };
    const arrowSize = 8; // px, half-width of triangle
    const borderColor = 'var(--bcc-white, #ffffff)';
    const borderTransparent = 'transparent';

    if (placement === 'below') {
      // Arrow points UP (out of the top of the popover)
      return {
        ...base,
        top: -arrowSize * 2,
        left: '50%',
        transform: 'translateX(-50%)',
        borderLeft: `${arrowSize}px solid ${borderTransparent}`,
        borderRight: `${arrowSize}px solid ${borderTransparent}`,
        borderBottom: `${arrowSize * 2}px solid ${borderColor}`,
      };
    }
    if (placement === 'above') {
      // Arrow points DOWN (out of the bottom of the popover)
      return {
        ...base,
        bottom: -arrowSize * 2,
        left: '50%',
        transform: 'translateX(-50%)',
        borderLeft: `${arrowSize}px solid ${borderTransparent}`,
        borderRight: `${arrowSize}px solid ${borderTransparent}`,
        borderTop: `${arrowSize * 2}px solid ${borderColor}`,
      };
    }
    if (placement === 'right') {
      // Arrow points LEFT (out of the left side of the popover)
      return {
        ...base,
        left: -arrowSize * 2,
        top: '50%',
        transform: 'translateY(-50%)',
        borderTop: `${arrowSize}px solid ${borderTransparent}`,
        borderBottom: `${arrowSize}px solid ${borderTransparent}`,
        borderRight: `${arrowSize * 2}px solid ${borderColor}`,
      };
    }
    // left — Arrow points RIGHT (out of the right side of the popover)
    return {
      ...base,
      right: -arrowSize * 2,
      top: '50%',
      transform: 'translateY(-50%)',
      borderTop: `${arrowSize}px solid ${borderTransparent}`,
      borderBottom: `${arrowSize}px solid ${borderTransparent}`,
      borderLeft: `${arrowSize * 2}px solid ${borderColor}`,
    };
  };

  // ---- render --------------------------------------------------------------
  return (
    <AnimatePresence>
      {open && card && deck && (
        <>
          {/* Scrim — dims page; does NOT block clicks on the highlighted element
              because the element's z-index (61) sits above the scrim (z-60). */}
          <motion.div
            key="scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] bg-black/40"
            onClick={close}
            aria-hidden="true"
          />

          {/* Popover panel — positioned absolutely when anchored, centered when not */}
          <motion.div
            key={`panel-${index}`}
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="app-walkthrough-title"
            aria-describedby="app-walkthrough-body"
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.97 }}
            transition={{ type: 'spring', stiffness: 320, damping: 28 }}
            onClick={(e) => e.stopPropagation()}
            style={
              hasTarget && popoverPos
                ? {
                    position: 'fixed',
                    top: popoverPos.top,
                    left: popoverPos.left,
                    // Same viewport cap as computePosition (popoverWidth): a
                    // fixed 420px card off a 375px phone screen left the
                    // close/Next controls unreachable.
                    width: `min(${POPOVER_W}px, calc(100vw - ${2 * POPOVER_MARGIN}px))`,
                    zIndex: 62,
                  }
                : {
                    // Centered WITHOUT a CSS transform: framer-motion's scale
                    // animation owns the `transform` property and silently
                    // dropped the old translate(-50%,-50%), so the card hung
                    // off the right/bottom edge of small screens (its Close /
                    // Next controls unreachable on a phone). inset+margin:auto
                    // centers a fixed, fit-content box on both axes instead.
                    position: 'fixed',
                    inset: 0,
                    margin: 'auto',
                    height: 'fit-content',
                    width: `min(${POPOVER_W}px, calc(100vw - ${2 * POPOVER_MARGIN}px))`,
                    zIndex: 62,
                  }
            }
            className="max-h-[88vh] overflow-y-auto rounded-xl border border-bcc-border bg-bcc-white shadow-xl"
          >
            {/* Arrow pointing at the anchor element */}
            {hasTarget && popoverPos && (
              <div aria-hidden="true" style={arrowStyle(popoverPos.placement)} />
            )}

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
            <div
              className="px-6 pb-2 flex items-center justify-center gap-1.5"
              aria-label={`Step ${index + 1} of ${total}`}
            >
              {cards.map((c, i) => (
                <span
                  key={c.id}
                  aria-hidden="true"
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
        </>
      )}
    </AnimatePresence>
  );
}
