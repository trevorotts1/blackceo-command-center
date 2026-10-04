'use client';

/**
 * HeadChat (B28, SPEC S9 "Head conversations and work requests").
 *
 * The one honest conversation surface: **Talk to head**, never a fake
 * read-only Ask mode. The help line is SPEC S9 verbatim, because it is the
 * contract that tells the owner work requested here can create tasks.
 *
 * Fully controlled by props. Every turn rendered is the persisted server view
 * (`HqChatTurn` from `src/lib/hq/types.ts`), so a reload can only ever show
 * what the API actually stored — this component never invents a reply, never
 * optimistically echoes the draft, and holds no transcript of its own. A
 * `failed_unsent` turn is already durable server-side (S9 persists before
 * network), so clearing the composer on submit loses nothing.
 *
 * The wire, the wall clock and the reconciliation job are NOT here: turns
 * arrive via props (B09/B10 own the durable turn protocol, B21/B30 the
 * session state). No gateway key, no transport, no provider choice.
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, Clock, ExternalLink, Plus, RotateCcw, Send, X } from 'lucide-react';
import type { HqChatTurn, HqChatTurnState } from '@/lib/hq/types';

/** SPEC S9: trim surrounding whitespace, then the 32,000-character cap — reject, never truncate. */
const MESSAGE_MAX = 32000;

/** SPEC S9 retry rule: the retry endpoint accepts only `failed_unsent` with attempts < 3. */
const RETRY_MAX_ATTEMPTS = 3;

/** SPEC S9 verbatim help text (S11: state/meaning carries a label, not color alone). */
export const HEAD_CHAT_HELP =
  "Messages go to this department head under the company's existing rules. Work requested here can create or update tasks; progress links appear in this conversation.";

/** SPEC S9 verbatim uncertainty wording — shown while delivery is uncertain or unresolved. */
export const HEAD_CHAT_UNCERTAIN =
  'Delivery uncertain; inspect conversation before sending again';

const STATE_LABEL: Record<HqChatTurnState, string> = {
  queued: 'Queued',
  sending: 'Sending',
  awaiting_reply: 'Awaiting reply',
  replied: 'Replied',
  failed_unsent: 'Not sent',
  refused: 'Refused',
  reconciling: 'Reconciling',
  unresolved: 'Unresolved',
};

const STATE_TONE: Record<HqChatTurnState, string> = {
  queued: 'bg-bcc-border-light text-bcc-text-secondary border-bcc-border',
  sending: 'bg-semantic-infoLight text-blue-700 border-blue-200',
  awaiting_reply: 'bg-semantic-infoLight text-blue-700 border-blue-200',
  replied: 'bg-semantic-successLight text-emerald-700 border-emerald-200',
  failed_unsent: 'bg-semantic-warningLight text-amber-700 border-amber-200',
  refused: 'bg-semantic-dangerLight text-red-700 border-red-200',
  reconciling: 'bg-semantic-warningLight text-amber-700 border-amber-200',
  unresolved: 'bg-semantic-warningLight text-amber-700 border-amber-200',
};

export interface HeadChatProps {
  /** Roster label of the bound head — the session's fixed target (S9). */
  headName: string;
  /** Authorized department prefilled into existing task creation. */
  departmentLabel: string;
  /** Persisted turns, oldest first. Partial text before reload is the same text after it. */
  turns: HqChatTurn[];
  /** A send/retry is in flight; the composer is disabled, the draft is kept. */
  busy?: boolean;
  /** Transport-level failure text (never a fabricated success). */
  sendError?: string | null;
  /** S9: set when the logical session was closed, e.g. `head_binding_changed`. */
  sessionClosedReason?: string | null;
  /** S9: the bounded context envelope dropped older messages; say so instead of implying full history. */
  historyTruncated?: boolean;
  onSend: (message: string, clientRequestId: string) => void;
  /** S9: offered only for `failed_unsent` under the attempt ceiling. */
  onRetry?: (turnId: string) => void;
  /** S9 recovery path after `unresolved` — a new request ID, never an automatic resend. */
  onSendAsNewMessage?: (turnId: string) => void;
  /** Hands the canonical task ID to the existing board (no new board route). */
  onOpenTask?: (taskId: string) => void;
  /** Opens the existing task creation UI, department prefilled (S9). */
  onCreateTask?: () => void;
  /** Escape and the header close control (S11). Trigger focus restore is the shell's job. */
  onClose?: () => void;
}

export default function HeadChat({
  headName,
  departmentLabel,
  turns,
  busy = false,
  sendError = null,
  sessionClosedReason = null,
  historyTruncated = false,
  onSend,
  onRetry,
  onSendAsNewMessage,
  onOpenTask,
  onCreateTask,
  onClose,
}: HeadChatProps) {
  const [draft, setDraft] = useState('');

  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const trimmed = draft.trim();
  const oversize = trimmed.length > MESSAGE_MAX;
  const canSend = trimmed.length > 0 && !oversize && !busy && !sessionClosedReason;

  const submit = () => {
    if (!canSend) return;
    // Per-attempt idempotency key (S9). A duplicate submit must not become a second send.
    onSend(trimmed, crypto.randomUUID());
    setDraft('');
  };

  return (
    <section
      data-testid="hq-head-chat"
      aria-label={`Talk to head — ${headName}`}
      className="flex flex-col h-full min-h-0 bg-bcc-white border border-bcc-border rounded-2xl shadow-card"
    >
      <header className="flex items-start justify-between gap-3 px-4 py-3 border-b border-bcc-border shrink-0">
        <div className="min-w-0">
          <h2 className="text-card-title text-bcc-text truncate">Talk to head — {headName}</h2>
          <p className="text-caption text-bcc-text-secondary truncate">{departmentLabel}</p>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close conversation"
            className="shrink-0 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl border border-bcc-border text-bcc-text-secondary hover:text-bcc-text hover:border-brand-300"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        )}
      </header>

      {/* SPEC S9: the honest surface statement. Never "read-only", never "Ask". */}
      <p data-testid="hq-head-chat-help" className="px-4 py-2 text-caption text-bcc-text-secondary border-b border-bcc-border shrink-0">
        {HEAD_CHAT_HELP}
      </p>

      {sessionClosedReason && (
        <p
          data-testid="hq-head-chat-closed"
          role="status"
          className="px-4 py-2 text-caption text-amber-700 bg-semantic-warningLight border-b border-amber-200 shrink-0"
        >
          This conversation is closed for new messages ({sessionClosedReason}). Earlier messages stay available.
        </p>
      )}

      {historyTruncated && (
        <p data-testid="hq-head-chat-truncated" className="px-4 py-2 text-caption text-bcc-text-secondary border-b border-bcc-border shrink-0">
          Older messages are not sent as context to this head.
        </p>
      )}

      <ol data-testid="hq-head-chat-turns" className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3">
        {turns.length === 0 && (
          <li className="text-body text-bcc-text-secondary">No messages yet in this private conversation.</li>
        )}
        {turns.map((turn) => {
          const canRetry = turn.state === 'failed_unsent' && turn.attempts < RETRY_MAX_ATTEMPTS;
          const uncertain = turn.state === 'reconciling' || turn.state === 'unresolved';
          return (
            <li key={turn.id} data-testid={`hq-chat-turn-${turn.id}`} data-state={turn.state} className="space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-label text-bcc-text">You</span>
                <span
                  data-testid={`hq-chat-state-${turn.id}`}
                  aria-live="polite"
                  className={`inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide rounded border px-1.5 py-0.5 ${STATE_TONE[turn.state]}`}
                >
                  <Clock className="w-3 h-3" aria-hidden="true" />
                  {STATE_LABEL[turn.state]}
                </span>
                {turn.partial && (
                  <span
                    data-testid={`hq-chat-partial-${turn.id}`}
                    className="text-[10px] font-semibold uppercase tracking-wide rounded border px-1.5 py-0.5 bg-bcc-border-light text-bcc-text-secondary border-bcc-border"
                  >
                    Partial
                  </span>
                )}
              </div>
              <p className="text-body text-bcc-text whitespace-pre-wrap break-words">{turn.message}</p>

              {turn.reply !== null && (
                <div className="rounded-xl bg-bcc-bg border border-bcc-border px-3 py-2">
                  <span className="text-label text-bcc-text-secondary">{headName}</span>
                  <p data-testid={`hq-chat-reply-${turn.id}`} className="text-body text-bcc-text whitespace-pre-wrap break-words">
                    {turn.reply}
                  </p>
                </div>
              )}

              {turn.errorCode && (
                <p data-testid={`hq-chat-error-${turn.id}`} className="text-caption text-bcc-text-secondary">
                  {turn.errorCode}
                </p>
              )}

              {uncertain && (
                <p data-testid={`hq-chat-uncertain-${turn.id}`} className="text-caption text-amber-700 flex items-start gap-1">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />
                  {HEAD_CHAT_UNCERTAIN}
                </p>
              )}

              <div className="flex items-center gap-2 flex-wrap pt-1">
                {canRetry && onRetry && (
                  <button
                    type="button"
                    data-testid={`hq-chat-retry-${turn.id}`}
                    onClick={() => onRetry(turn.id)}
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 min-h-[44px] px-3 rounded-xl border border-bcc-border text-label text-bcc-text hover:border-brand-300 disabled:opacity-40"
                  >
                    <RotateCcw className="w-4 h-4" aria-hidden="true" />
                    Retry send
                  </button>
                )}
                {turn.state === 'unresolved' && onSendAsNewMessage && (
                  <button
                    type="button"
                    data-testid={`hq-chat-new-${turn.id}`}
                    onClick={() => onSendAsNewMessage(turn.id)}
                    className="inline-flex items-center gap-1.5 min-h-[44px] px-3 rounded-xl border border-amber-300 bg-semantic-warningLight text-label text-amber-800"
                  >
                    <Send className="w-4 h-4" aria-hidden="true" />
                    Send as new message (may duplicate)
                  </button>
                )}
                {turn.taskId && onOpenTask && (
                  <button
                    type="button"
                    data-testid={`hq-chat-task-${turn.id}`}
                    onClick={() => onOpenTask(turn.taskId as string)}
                    className="inline-flex items-center gap-1.5 min-h-[44px] px-3 rounded-xl border border-bcc-border text-label text-bcc-text hover:border-brand-300"
                  >
                    <ExternalLink className="w-4 h-4" aria-hidden="true" />
                    Open task {turn.taskId}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {sendError && (
        <p data-testid="hq-head-chat-send-error" role="alert" className="px-4 py-2 text-caption text-red-700 bg-semantic-dangerLight shrink-0">
          {sendError}
        </p>
      )}

      <form
        className="border-t border-bcc-border px-3 py-3 shrink-0"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="sr-only" htmlFor="hq-head-chat-composer">
          Message {headName}
        </label>
        <textarea
          id="hq-head-chat-composer"
          data-testid="hq-head-chat-composer"
          value={draft}
          rows={1}
          disabled={!!sessionClosedReason}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={`Message ${headName}…`}
          className="w-full resize-none max-h-40 min-h-[44px] rounded-xl border border-bcc-border px-3 py-2.5 text-body text-bcc-text focus:outline-none focus:ring-2 focus:ring-brand-300"
        />
        {oversize && (
          <p data-testid="hq-head-chat-oversize" className="text-caption text-red-700 pt-1">
            {trimmed.length.toLocaleString()} characters — the limit is {MESSAGE_MAX.toLocaleString()}. Nothing is sent and nothing is truncated; shorten it.
          </p>
        )}
        <div className="flex items-center justify-between gap-2 pt-2">
          {onCreateTask ? (
            <button
              type="button"
              data-testid="hq-head-chat-create-task"
              onClick={onCreateTask}
              className="inline-flex items-center gap-1.5 min-h-[44px] px-3 rounded-xl border border-bcc-border text-label text-bcc-text hover:border-brand-300"
            >
              <Plus className="w-4 h-4" aria-hidden="true" />
              Create task for {departmentLabel}
            </button>
          ) : (
            <span />
          )}
          <button
            type="submit"
            data-testid="hq-head-chat-send"
            disabled={!canSend}
            className="inline-flex items-center gap-2 min-h-[44px] px-4 rounded-xl bg-brand-600 text-white font-medium hover:bg-brand-700 disabled:opacity-40"
          >
            <Send className="w-4 h-4" aria-hidden="true" />
            {busy ? 'Sending…' : 'Send'}
          </button>
        </div>
      </form>
    </section>
  );
}
