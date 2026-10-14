'use client';

/**
 * PresentationEnginePanel — Item 19 (FIX-PLAN): the card-face surface for
 * the presentation engine's OWN run record, as opposed to the board's
 * posted status.
 *
 * Two truths the board's task row cannot express, rendered distinctly:
 *
 *   ABANDONED — the engine's terminal vocabulary for a retired run. The
 *   producer posts every terminal run as `review`, so without this an
 *   abandoned run sits in review-limbo forever, looking like work that
 *   awaits QC. The pill and panel say ABANDONED in so many words: not
 *   failed (nothing is being retried), not parked (nothing will resume).
 *
 *   PARKED — Item 10's plain-words park record (waiting on whom, what is
 *   needed, since when), rendered verbatim from the engine's record. The
 *   raw blocked reason never renders here: it is an engine diagnostic,
 *   and this panel is the client-safe surface the record was built for.
 *
 * The Resume action POSTs /api/presentations/[taskId]/resume, which calls
 * the engine's own launcher resume path and answers with the engine's
 * RESULTING state. This component never flips a status locally: it shows
 * the server's outcome text (accepted / dispatched-pending / refused,
 * verbatim) and asks the parent card to refetch, so what the operator
 * sees next is the engine state, not a UI claim.
 */

import { useState } from 'react';
import { Ban, PauseCircle, RotateCw } from 'lucide-react';

/**
 * The plain-words park view, mirroring the wire shape served by the
 * children/phases routes and the task-row projection (Item 10's
 * park_status record, or its pre-Item-10 fallbacks).
 */
export interface EngineParkView {
  label: string;
  waiting_on: 'client' | 'operator' | 'system' | null;
  needed: string | null;
  phase: string | null;
  since: string | null;
  park_class: string | null;
  auto_resume: boolean | null;
  attempts_used: number | null;
  attempts_cap: number | null;
  source: 'park_status' | 'configuration_pending' | 'blocked';
}

const WAITING_ON_WORDS: Record<string, string> = {
  client: 'the client',
  operator: 'our team',
  system: 'an automatic retry',
};

function formatSince(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** The ABANDONED pill: deliberately unlike every status pill on the board. */
export function AbandonedPill() {
  return (
    <span
      data-testid="engine-abandoned-pill"
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-zinc-700 text-white"
    >
      <Ban className="w-3 h-3" />
      Abandoned
    </span>
  );
}

type ResumeMessage = { kind: 'resumed' | 'pending' | 'refused'; text: string };

export function PresentationEnginePanel({
  taskId,
  park,
  terminal,
  onAfterResume,
}: {
  taskId: string;
  park: EngineParkView | null;
  terminal: string | null;
  /** Called after any resume outcome so the parent refetches engine state. */
  onAfterResume?: () => void;
}) {
  const [resuming, setResuming] = useState(false);
  const [message, setMessage] = useState<ResumeMessage | null>(null);

  if (terminal === 'ABANDONED') {
    return (
      <div
        className="mb-3 rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-2 text-xs space-y-1"
        data-testid="presentation-engine-abandoned"
      >
        <p className="flex items-center gap-1.5 font-semibold text-zinc-800">
          <Ban className="w-3.5 h-3.5" />
          This run was abandoned
        </p>
        <p className="text-zinc-600 leading-snug">
          The presentation engine recorded this run as ABANDONED, its
          terminal state for a retired run. It is not waiting on review,
          it is not parked, and it will not resume on its own.
        </p>
      </div>
    );
  }

  if (!park) return null;

  const handleResume = async () => {
    if (resuming) return;
    setResuming(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/presentations/${taskId}/resume`, {
        method: 'POST',
      });
      const body = (await res.json().catch(() => ({}))) as {
        resumed?: boolean;
        dispatched?: boolean;
        detail?: string;
        error?: string;
      };
      if (res.status === 200 && body.resumed) {
        setMessage({
          kind: 'resumed',
          text: body.detail ?? 'The engine consumed the resume.',
        });
      } else if (res.status === 202) {
        setMessage({
          kind: 'pending',
          text: body.detail ?? 'Resume dispatched; the engine state has not caught up yet.',
        });
      } else {
        setMessage({
          kind: 'refused',
          text: body.error ?? `Resume refused (status ${res.status})`,
        });
      }
    } catch (e: unknown) {
      setMessage({
        kind: 'refused',
        text: e instanceof Error ? e.message : 'Resume request failed',
      });
    } finally {
      setResuming(false);
      // Whatever the outcome, the card re-reads the engine's state; the
      // message above is the server's words, not a local status claim.
      onAfterResume?.();
    }
  };

  return (
    <div
      className="mb-3 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs space-y-1"
      data-testid="presentation-park-panel"
    >
      <p className="flex items-center gap-1.5 font-semibold text-sky-900">
        <PauseCircle className="w-3.5 h-3.5" />
        <span data-testid="presentation-park-label">{park.label}</span>
      </p>
      {park.waiting_on && (
        <p className="text-sky-800" data-testid="presentation-park-waiting-on">
          Waiting on: {WAITING_ON_WORDS[park.waiting_on] ?? park.waiting_on}
        </p>
      )}
      {park.needed && (
        <p className="text-sky-800 leading-snug" data-testid="presentation-park-needed">
          Needed: {park.needed}
        </p>
      )}
      {park.phase && (
        <p className="text-sky-700" data-testid="presentation-park-phase">
          Parked at phase {park.phase}
        </p>
      )}
      {park.since && (
        <p className="text-sky-700" data-testid="presentation-park-since">
          Since {formatSince(park.since)}
        </p>
      )}
      {park.auto_resume === true && (
        <p className="text-sky-700" data-testid="presentation-park-auto-resume">
          This park retries on its own
          {park.attempts_used != null && park.attempts_cap != null
            ? ` (attempt ${park.attempts_used} of ${park.attempts_cap})`
            : ''}
          .
        </p>
      )}
      {park.auto_resume === false && (
        <p className="text-sky-700" data-testid="presentation-park-no-auto-resume">
          This park does not resume on its own.
        </p>
      )}

      {/* Item 19 — the resume action: the engine's own launcher path via
          the resume route; the outcome text is the server's, verbatim. */}
      <div className="pt-1.5 mt-1 border-t border-sky-200/70" data-testid="presentation-resume-area">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void handleResume();
          }}
          disabled={resuming}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-sky-700 text-white hover:bg-sky-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          data-testid="presentation-resume-btn"
        >
          <RotateCw className={`h-3 w-3 ${resuming ? 'animate-spin' : ''}`} />
          {resuming ? 'Resuming...' : 'Resume this run'}
        </button>
        {message && (
          <p
            className={`mt-1.5 leading-snug ${
              message.kind === 'resumed'
                ? 'text-emerald-700 font-medium'
                : message.kind === 'pending'
                  ? 'text-amber-700'
                  : 'text-red-600'
            }`}
            data-testid="presentation-resume-message"
            data-kind={message.kind}
          >
            {message.text}
          </p>
        )}
      </div>
    </div>
  );
}

export default PresentationEnginePanel;
