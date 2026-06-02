'use client';

/**
 * OperatorOnboarding — element-anchored coach-mark walkthrough (E10 / B3).
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
 * Coach-mark positioning (E10/B3):
 *   - Each onboarding card carries an optional `target` field that names a
 *     `[data-walkthrough="<target>"]` element in the sidebar (OperatorSidebar.tsx
 *     adds data-walkthrough to every nav link).
 *   - When a target element exists, the popover is positioned adjacent to it
 *     (below/above/right/left, whichever fits on screen) with a CSS arrow
 *     pointing at the element, and the element gets a highlight ring.
 *   - When no target element exists (element not in DOM) the popover falls back
 *     to the centered-modal layout so the walkthrough still works everywhere.
 *
 * No new dependencies. Positioning uses getBoundingClientRect + React state.
 * Framer-motion (already a dep) handles enter/exit animations.
 *
 * Accessibility (WCAG 2.1 AA):
 *   - role="dialog" aria-modal="true" with aria-labelledby/aria-describedby.
 *   - Focus moves into dialog on open; Tab/Shift+Tab stay inside (focus trap).
 *   - Esc closes; Left/Right arrows step through cards.
 *   - All controls are ≥44px tap targets; text ≥14px.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronLeft, ChevronRight, X, Sparkles } from 'lucide-react';
import type { Platform } from '@/lib/platform';
import { ONBOARDING_CARDS, memoryPlatformNote } from './onboarding-content';

export const ONBOARDING_SEEN_KEY = 'bcc-operator-onboarding-seen';
export const ONBOARDING_OPEN_EVENT = 'bcc:operator-onboarding';

interface OpenDetail {
  card?: string;
}

/** Placement of the popover relative to the anchor element. */
type Placement = 'below' | 'above' | 'left' | 'right';

interface PopoverPosition {
  top: number;
  left: number;
  placement: Placement;
}

const HIGHLIGHT_CLASS = 'bcc-walkthrough-highlight';
const POPOVER_W = 400;
const POPOVER_MARGIN = 16;
const ANCHOR_GAP = 14;

function computePosition(
  anchorRect: DOMRect,
  popoverH: number,
  vw: number,
  vh: number,
): PopoverPosition {
  // Operator sidebar is on the left — prefer 'right' then 'below' so the
  // popover opens to the right of the highlighted sidebar nav item.
  const candidates: Placement[] = ['right', 'below', 'above', 'left'];

  for (const placement of candidates) {
    let top = 0;
    let left = 0;

    if (placement === 'below') {
      top = anchorRect.bottom + ANCHOR_GAP;
      left = anchorRect.left + anchorRect.width / 2 - POPOVER_W / 2;
    } else if (placement === 'above') {
      top = anchorRect.top - ANCHOR_GAP - popoverH;
      left = anchorRect.left + anchorRect.width / 2 - POPOVER_W / 2;
    } else if (placement === 'right') {
      top = anchorRect.top + anchorRect.height / 2 - popoverH / 2;
      left = anchorRect.right + ANCHOR_GAP;
    } else {
      top = anchorRect.top + anchorRect.height / 2 - popoverH / 2;
      left = anchorRect.left - ANCHOR_GAP - POPOVER_W;
    }

    left = Math.max(POPOVER_MARGIN, Math.min(left, vw - POPOVER_W - POPOVER_MARGIN));
    top = Math.max(POPOVER_MARGIN, Math.min(top, vh - popoverH - POPOVER_MARGIN));

    const fits =
      top + popoverH <= vh - POPOVER_MARGIN &&
      top >= POPOVER_MARGIN &&
      left + POPOVER_W <= vw - POPOVER_MARGIN &&
      left >= POPOVER_MARGIN;

    if (fits) return { top, left, placement };
  }

  return {
    top: Math.max(POPOVER_MARGIN, (vh - popoverH) / 2),
    left: Math.max(POPOVER_MARGIN, (vw - POPOVER_W) / 2),
    placement: 'right',
  };
}

export default function OperatorOnboarding({ platform }: { platform: Platform }) {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const [hasTarget, setHasTarget] = useState(false);
  const [popoverPos, setPopoverPos] = useState<PopoverPosition | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const highlightedEl = useRef<HTMLElement | null>(null);
  const positionRafRef = useRef<number | null>(null);

  const cards = ONBOARDING_CARDS;
  const total = cards.length;

  // ---- popover positioning -------------------------------------------------
  const updatePosition = useCallback(() => {
    const el = highlightedEl.current;
    const dialog = dialogRef.current;
    if (!el || !dialog) return;
    const anchorRect = el.getBoundingClientRect();
    const popoverH = dialog.offsetHeight || 320;
    setPopoverPos(computePosition(anchorRect, popoverH, window.innerWidth, window.innerHeight));
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
      const el = document.querySelector<HTMLElement>(`[data-walkthrough="${target}"]`);
      if (!el) return; // element not in DOM — fall back to centered modal
      el.classList.add(HIGHLIGHT_CLASS);
      highlightedEl.current = el;
      setHasTarget(true);
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
      setTimeout(schedulePositionUpdate, 200);
    },
    [clearHighlight, schedulePositionUpdate],
  );

  // ---- open / close --------------------------------------------------------
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
    [cards],
  );

  const close = useCallback(() => {
    setOpen(false);
    clearHighlight();
    try {
      localStorage.setItem(ONBOARDING_SEEN_KEY, '1');
    } catch {
      /* private mode — non-fatal */
    }
    const el = previouslyFocused.current;
    if (el && typeof el.focus === 'function') {
      requestAnimationFrame(() => el.focus());
    }
  }, [clearHighlight]);

  // ---- first-run auto-open -------------------------------------------------
  useEffect(() => {
    let seen = false;
    try {
      seen = localStorage.getItem(ONBOARDING_SEEN_KEY) === '1';
    } catch {
      seen = false;
    }
    if (!seen) {
      const t = setTimeout(() => openAt(), 350);
      return () => clearTimeout(t);
    }
  }, [openAt]);

  // ---- re-open via window event --------------------------------------------
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<OpenDetail>).detail;
      openAt(detail?.card);
    };
    window.addEventListener(ONBOARDING_OPEN_EVENT, handler as EventListener);
    return () => window.removeEventListener(ONBOARDING_OPEN_EVENT, handler as EventListener);
  }, [openAt]);

  // ---- highlight the current card's target whenever index changes ----------
  const card = cards[index];
  useEffect(() => {
    if (!open || !card) return;
    highlightTarget(card.target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, index]);

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

  // ---- recompute after card body repaint -----------------------------------
  useEffect(() => {
    if (!open || !hasTarget) return;
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

  // ---- move initial focus into the dialog on open --------------------------
  useEffect(() => {
    if (!open) return;
    const root = dialogRef.current;
    if (!root) return;
    const focusable = root.querySelector<HTMLElement>(
      'button:not([disabled]), [href], input, [tabindex]:not([tabindex="-1"])',
    );
    requestAnimationFrame(() => focusable?.focus());
  }, [open, index]);

  // ---- clean up on unmount -------------------------------------------------
  useEffect(
    () => () => {
      clearHighlight();
      if (positionRafRef.current !== null) cancelAnimationFrame(positionRafRef.current);
    },
    [clearHighlight],
  );

  const isFirst = index === 0;
  const isLast = index === total - 1;

  // Arrow for the coach-mark (CSS border triangle)
  const arrowStyle = (placement: Placement): CSSProperties => {
    const base: CSSProperties = { position: 'absolute', width: 0, height: 0, pointerEvents: 'none' };
    const sz = 8;
    const fill = 'var(--bcc-white, #ffffff)';
    const t = 'transparent';
    if (placement === 'below') return { ...base, top: -sz * 2, left: '50%', transform: 'translateX(-50%)', borderLeft: `${sz}px solid ${t}`, borderRight: `${sz}px solid ${t}`, borderBottom: `${sz * 2}px solid ${fill}` };
    if (placement === 'above') return { ...base, bottom: -sz * 2, left: '50%', transform: 'translateX(-50%)', borderLeft: `${sz}px solid ${t}`, borderRight: `${sz}px solid ${t}`, borderTop: `${sz * 2}px solid ${fill}` };
    if (placement === 'right') return { ...base, left: -sz * 2, top: '50%', transform: 'translateY(-50%)', borderTop: `${sz}px solid ${t}`, borderBottom: `${sz}px solid ${t}`, borderRight: `${sz * 2}px solid ${fill}` };
    return { ...base, right: -sz * 2, top: '50%', transform: 'translateY(-50%)', borderTop: `${sz}px solid ${t}`, borderBottom: `${sz}px solid ${t}`, borderLeft: `${sz * 2}px solid ${fill}` };
  };

  return (
    <AnimatePresence>
      {open && card && (
        <>
          {/* Scrim — dims page; highlighted element (z-61) shows through */}
          <motion.div
            key="scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] bg-black/40 backdrop-blur-sm"
            onClick={close}
            aria-hidden="true"
          />

          {/* Coach-mark popover */}
          <motion.div
            key={`panel-${index}`}
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="operator-onboarding-title"
            aria-describedby="operator-onboarding-body"
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
                    width: POPOVER_W,
                    zIndex: 62,
                  }
                : {
                    position: 'fixed',
                    top: '50%',
                    left: '50%',
                    transform: 'translate(-50%, -50%)',
                    width: `min(${POPOVER_W}px, 94vw)`,
                    zIndex: 62,
                  }
            }
            className="max-h-[88vh] overflow-y-auto rounded-xl border border-bcc-border bg-bcc-white shadow-xl"
          >
            {/* Arrow pointing at the highlighted sidebar item */}
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
