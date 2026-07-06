'use client';

/**
 * Small non-blocking toast stack for the task board.
 *
 * Before this existed, a failed drag-drop PATCH (403/422/500 — anything that
 * wasn't res.ok or the special 400 "Triad incomplete" case) silently left the
 * optimistic move in place with no explanation, so the board would desync
 * from the server with zero user-visible signal. handleDrop now reverts the
 * optimistic move on ANY non-ok response and pushes a toast here so the user
 * sees WHY the card snapped back.
 *
 * Styling matches the existing card language (white, bordered, rounded-lg)
 * with a red left-accent for errors. Auto-dismisses after ~6s; also
 * dismissable via the close button (keyboard accessible).
 */

import { useEffect } from 'react';
import { AlertCircle, X } from 'lucide-react';

export interface BoardToastMessage {
  id: string;
  tone: 'error' | 'info';
  title: string;
  detail?: string;
}

interface BoardToastStackProps {
  toasts: BoardToastMessage[];
  onDismiss: (id: string) => void;
}

export function BoardToastStack({ toasts, onDismiss }: BoardToastStackProps) {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 w-full max-w-sm pointer-events-none">
      {toasts.map((toast) => (
        <BoardToast key={toast.id} toast={toast} onDismiss={() => onDismiss(toast.id)} />
      ))}
    </div>
  );
}

function BoardToast({ toast, onDismiss }: { toast: BoardToastMessage; onDismiss: () => void }) {
  // Auto-dismiss ~6s after mount — re-fires only if this exact toast instance
  // changes (it won't, `toast` is stable for the toast's lifetime).
  useEffect(() => {
    const timer = setTimeout(onDismiss, 6000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast.id]);

  return (
    <div
      role="alert"
      className={`pointer-events-auto bg-white rounded-lg border shadow-lg p-3 flex items-start gap-2 ${
        toast.tone === 'error' ? 'border-red-100 border-l-4 border-l-red-500' : 'border-gray-100'
      }`}
    >
      <AlertCircle
        className={`w-4 h-4 mt-0.5 shrink-0 ${toast.tone === 'error' ? 'text-red-500' : 'text-gray-400'}`}
        aria-hidden="true"
      />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-gray-900 break-words">{toast.title}</p>
        {toast.detail && <p className="text-xs text-gray-500 mt-0.5 break-words">{toast.detail}</p>}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notification"
        className="p-1 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors shrink-0"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
