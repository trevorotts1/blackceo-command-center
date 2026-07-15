'use client';

/**
 * FieldHelp (U105 / E4-8) — reusable "i" icon + click-to-open help popover.
 *
 * A small accessible disclosure: a button announces "Help: <label>" and
 * toggles a popover carrying `text`. Built as a standalone primitive (not
 * copied per call site) so every field in the task-detail modal — and any
 * future caller — gets identical keyboard/focus/ARIA/mobile behavior from
 * one place. Positioning is deliberately simple (anchored below-left of the
 * trigger, width-capped to the viewport) — this is a small inline help
 * popover, not the anchored coach-mark AppWalkthrough renders; that
 * component's viewport-fitting math is overkill for a few lines of copy
 * next to a form label.
 *
 * Accessibility:
 *   - Trigger is a real <button> (keyboard-focusable, Enter/Space activate
 *     it natively — no keydown handler needed for that part).
 *   - `aria-expanded` + `aria-controls` link the trigger to the popover so
 *     assistive tech announces open/closed state and can navigate to it.
 *   - The popover is `role="dialog"` with `aria-label` set to the field's
 *     label, carries its own visible + `aria-label`led close control, and
 *     Escape closes it and returns focus to the trigger (no keyboard trap,
 *     no lost focus).
 *   - A tap/click anywhere outside the popover (mobile or desktop) closes
 *     it — the "mobile tap-dismiss" behavior — via a `pointerdown` listener,
 *     which fires for touch, pen, and mouse alike.
 *   - The trigger meets the WCAG 2.2 AA minimum target size (24x24 CSS px).
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Info, X } from 'lucide-react';

export interface FieldHelpProps {
  /** Human label for the field this help is attached to (e.g. "Title").
   *  Used for the trigger's accessible name ("Help: <label>") and as the
   *  popover's `aria-label`/heading. */
  label: string;
  /** The help copy shown in the popover body. */
  text: string;
  /** Optional layout className passthrough for the outer trigger wrapper. */
  className?: string;
  /**
   * Optional suffix disambiguating multiple `FieldHelp` instances on one
   * page for tests/tooling (`field-help-trigger-<testId>` /
   * `field-help-popover-<testId>`). Falls back to a generic id when a page
   * only ever renders one instance.
   */
  testId?: string;
}

export function FieldHelp({ label, text, className, testId }: FieldHelpProps) {
  const [open, setOpen] = useState(false);
  const popoverId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const triggerTestId = testId ? `field-help-trigger-${testId}` : 'field-help-trigger';
  const popoverTestId = testId ? `field-help-popover-${testId}` : 'field-help-popover';

  const close = useCallback(() => {
    setOpen(false);
    // Keyboard users never lose their place — focus returns to the trigger.
    triggerRef.current?.focus();
  }, []);

  // Escape closes; a pointerdown outside the popover/trigger closes it too
  // (covers mobile tap-to-dismiss and desktop click-away alike). Listeners
  // are only attached while open, so a page with many closed FieldHelp
  // instances adds zero idle listeners.
  useEffect(() => {
    if (!open) return;

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    }

    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node | null;
      if (!target) return;
      if (popoverRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    }

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, close]);

  return (
    <span className={`relative inline-flex${className ? ` ${className}` : ''}`}>
      <button
        type="button"
        ref={triggerRef}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={popoverId}
        aria-label={`Help: ${label}`}
        data-testid={triggerTestId}
        className="inline-flex h-6 w-6 items-center justify-center rounded-full text-bcc-text-muted hover:text-bcc-primary hover:bg-bcc-border-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bcc-primary"
      >
        <Info className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      {open && (
        <div
          id={popoverId}
          ref={popoverRef}
          role="dialog"
          aria-label={label}
          data-testid={popoverTestId}
          className="absolute left-0 top-full z-50 mt-1.5 w-64 max-w-[calc(100vw-2rem)] rounded-lg border border-bcc-border bg-bcc-white p-3 text-left shadow-card"
        >
          <div className="flex items-start justify-between gap-2">
            <p className="text-xs leading-snug text-bcc-text-secondary">{text}</p>
            <button
              type="button"
              onClick={close}
              aria-label="Close help"
              data-testid="field-help-close"
              className="-mr-1 -mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-bcc-text-muted hover:bg-bcc-border-light hover:text-bcc-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bcc-primary"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>
      )}
    </span>
  );
}

export default FieldHelp;
