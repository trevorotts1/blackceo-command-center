'use client';

/**
 * SOPFeedbackModal — the one-line "did the SOP serve you well?" prompt that
 * appears when a task moves to `done`.
 *
 * Designed to feel like a notification, not an interrogation. The default
 * state is "nothing" — no required fields, three buttons, dismiss = skip.
 * Notes box only opens after thumbs-down (where they actually matter).
 *
 * Usage: render once at the top of any kanban/dashboard that observes task
 * transitions; pass it the (sop, task) of the just-completed task and an
 * onClose callback. It self-fetches whether feedback already exists for
 * that pair so it never re-prompts.
 */
import { useEffect, useState } from 'react';
import { ThumbsUp, ThumbsDown, X } from 'lucide-react';

interface Props {
  sopId: string;
  sopName?: string;
  taskId: string;
  taskTitle?: string;
  agentId?: string | null;
  onClose: (submitted: boolean) => void;
}

export function SOPFeedbackModal({ sopId, sopName, taskId, taskTitle, agentId, onClose }: Props) {
  const [showNotes, setShowNotes] = useState(false);
  const [pendingRating, setPendingRating] = useState<1 | -1 | null>(null);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [alreadyDone, setAlreadyDone] = useState<boolean | null>(null);

  // Don't re-prompt if feedback already exists for this (sop, task) pair.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/sops/feedback?sop_id=${encodeURIComponent(sopId)}&task_id=${encodeURIComponent(taskId)}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => {
        if (!cancelled) setAlreadyDone(Array.isArray(rows) && rows.length > 0);
      })
      .catch(() => !cancelled && setAlreadyDone(false));
    return () => {
      cancelled = true;
    };
  }, [sopId, taskId]);

  // Auto-close if dupe — silent, no flash.
  useEffect(() => {
    if (alreadyDone === true) onClose(false);
  }, [alreadyDone, onClose]);

  if (alreadyDone !== false) return null;

  async function submit(rating: 1 | -1 | 0, finalNotes: string) {
    setSubmitting(true);
    try {
      await fetch('/api/sops/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sop_id: sopId, task_id: taskId, rating, notes: finalNotes || null, agent_id: agentId }),
      });
      onClose(true);
    } catch (err) {
      console.error('[SOPFeedbackModal] submit failed', err);
      onClose(false);
    } finally {
      setSubmitting(false);
    }
  }

  function handleThumbs(rating: 1 | -1) {
    if (rating === 1) {
      // Thumbs-up is silent fire-and-forget — no notes prompt, minimum friction.
      submit(1, '');
    } else {
      // Thumbs-down opens notes; the WHY is the highest-value signal.
      setPendingRating(-1);
      setShowNotes(true);
    }
  }

  function handleSkip() {
    submit(0, '');
  }

  function handleNotesSubmit() {
    if (pendingRating === null) return;
    submit(pendingRating, notes.trim());
  }

  return (
    <div
      className="fixed bottom-6 right-6 z-50 w-[420px] max-w-[90vw] rounded-lg border border-zinc-700 bg-zinc-900 p-4 shadow-2xl"
      role="dialog"
      aria-label="SOP feedback"
    >
      <button
        type="button"
        onClick={handleSkip}
        className="absolute right-2 top-2 rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
        aria-label="Dismiss"
        disabled={submitting}
      >
        <X size={16} />
      </button>

      {!showNotes ? (
        <>
          <div className="mb-3 text-sm text-zinc-200">
            Did the SOP {sopName ? <span className="font-medium text-white">&ldquo;{sopName}&rdquo;</span> : null} serve you well for{' '}
            <span className="font-medium text-white">{taskTitle ? `"${taskTitle}"` : 'this task'}</span>?
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => handleThumbs(1)}
              disabled={submitting}
              className="flex items-center gap-1 rounded bg-emerald-900/40 px-3 py-2 text-emerald-200 hover:bg-emerald-900/60 disabled:opacity-50"
            >
              <ThumbsUp size={16} /> Yes
            </button>
            <button
              type="button"
              onClick={() => handleThumbs(-1)}
              disabled={submitting}
              className="flex items-center gap-1 rounded bg-red-900/40 px-3 py-2 text-red-200 hover:bg-red-900/60 disabled:opacity-50"
            >
              <ThumbsDown size={16} /> No
            </button>
            <button
              type="button"
              onClick={handleSkip}
              disabled={submitting}
              className="ml-auto rounded px-3 py-2 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-50"
            >
              Skip
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="mb-2 text-sm text-zinc-200">What broke down? (optional, helps refine the SOP)</div>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="mb-2 h-20 w-full resize-none rounded bg-zinc-800 p-2 text-sm text-zinc-100 outline-none focus:ring-1 focus:ring-zinc-500"
            placeholder="Step 3 didn't apply because…"
            maxLength={2000}
            autoFocus
          />
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => submit(-1, '')}
              disabled={submitting}
              className="rounded px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-50"
            >
              Skip notes
            </button>
            <button
              type="button"
              onClick={handleNotesSubmit}
              disabled={submitting}
              className="rounded bg-zinc-700 px-3 py-1.5 text-xs text-white hover:bg-zinc-600 disabled:opacity-50"
            >
              {submitting ? 'Saving…' : 'Submit'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
