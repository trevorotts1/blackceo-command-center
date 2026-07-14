'use client';

/**
 * BottomSheet (U60 / JM-U63a shared primitive)
 *
 * Mobile/tablet "sheets, not popovers" chrome (spec (g)): the Tune sheet, the
 * Delegate sheet, and any picker's mobile presentation all render their
 * content through this one component instead of a floating popover that
 * would clip or overflow under 768px. Full-width, slides from the bottom,
 * dismissible by backdrop tap / Escape / the close button, and every
 * interactive row inside a sheet gets a 44x44 minimum tap target by the
 * caller's own spacing (this shell just gets out of the way).
 */
import { useEffect } from 'react';
import { X } from 'lucide-react';

interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  'data-testid'?: string;
}

export default function BottomSheet({ open, onClose, title, children, 'data-testid': testId }: BottomSheetProps) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    // Lock body scroll while the sheet is open.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" data-testid={testId}>
      <div
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative w-full sm:max-w-md bg-bcc-white rounded-t-2xl sm:rounded-2xl shadow-card max-h-[85dvh] flex flex-col"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-bcc-border shrink-0">
          <h2 className="text-card-title text-bcc-text">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="w-11 h-11 -mr-2 flex items-center justify-center text-bcc-text-muted hover:text-bcc-text rounded-xl"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">{children}</div>
      </div>
    </div>
  );
}
