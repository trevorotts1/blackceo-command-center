'use client';

/**
 * QuestionCard — the structured-card renderer for the /interview surface (P1-1).
 *
 * When the CURRENT interview question carries a structured definition
 * (src/lib/interview-questions.ts → InterviewQuestion), the web surface renders a
 * rich control instead of a bare chat line:
 *
 *   • kind 'color' → <ColorPickerCard>  (validated with resolveBrandColor())
 *   • kind 'url'   → <LogoDropCard>      (paste a public link OR drop a file)
 *   • kind 'text'  → an inline validated input (required flag enforced)
 *   • kind 'choice'→ inline input fallback (no option set is defined in D1 yet)
 *
 * ONE question at a time: this component renders exactly the question it is given,
 * wrapped in the shared `ivQuestionVariants` motion language so a swap reads as
 * "the next thing", not a flicker. Place it inside an <AnimatePresence> keyed by
 * question id to get the enter/exit crossfade for free.
 *
 * On submit every control POSTs to /api/interview/answer (built by P1-2, the ONLY
 * sanctioned structured-write path — it appends a genuine Q/A block, stamps
 * update-interview-state.sh, and mirrors branding answers onto the clients row so
 * <BrandTheme/> re-themes live). This file NEVER writes a file or touches the DB
 * itself; it imports nothing from the Node-only seam, so it stays a clean client
 * bundle and talks only to the API route.
 *
 * Validation is belt-and-suspenders: the same rule runs CLIENT-side (block a bad
 * submit before the network) and SERVER-side (the route re-validates; a 400 is
 * surfaced inline). Drill-down quality — "is this answer specific enough?" —
 * remains the interviewer agent's job, not this card's.
 */

import { useCallback, useState } from 'react';
import { motion } from 'framer-motion';
import { HelpCircle } from 'lucide-react';
import {
  iv,
  ivcx,
  ivQuestionVariants,
} from '@/components/interview/interview-theme';
import type {
  InterviewAnswerKind,
  InterviewQuestion,
} from '@/lib/interview-questions';
import ColorPickerCard from '@/components/interview/ColorPickerCard';
import LogoDropCard from '@/components/interview/LogoDropCard';

/* -------------------------------------------------------------------------- */
/* /api/interview/answer contract (mirrors the P1-2 route — kept local so no   */
/* Node import leaks into the client bundle)                                    */
/* -------------------------------------------------------------------------- */

export interface AnswerRequest {
  /** Stable question id from interview-questions.ts (persisted with the answer). */
  questionId: string;
  /** The tenant/company column this answer lands on (from the question's storeOn). */
  storeOn: InterviewQuestion['storeOn'];
  kind: InterviewAnswerKind;
  /** The final, client-validated value (for color: the resolved #rrggbb hex). */
  value: string;
  /** Optional interview session to attribute the write to. */
  sessionId?: string;
}

export interface AnswerResponse {
  ok?: boolean;
  questionId?: string;
  storeOn?: string;
  storedValue?: string;
  /** Present for color answers — the hex the route persisted. */
  resolvedHex?: string | null;
  colorSource?: 'hex' | 'name' | 'unknown';
  error?: string;
  message?: string;
}

export type SubmitResult =
  | { ok: true; data: AnswerResponse }
  | { ok: false; message: string; status?: number };

/**
 * POST one structured answer to /api/interview/answer. The single network path
 * every card shares, so the request/response shape lives in exactly one place.
 * Returns a discriminated result; the caller renders `message` inline on failure.
 */
export async function submitInterviewAnswer(
  req: AnswerRequest,
): Promise<SubmitResult> {
  let res: Response;
  try {
    res = await fetch('/api/interview/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    });
  } catch {
    return {
      ok: false,
      message: 'Network hiccup — that answer did not save. Please try again.',
    };
  }

  if (res.status === 503) {
    const data = (await res.json().catch(() => ({}))) as AnswerResponse;
    return {
      ok: false,
      status: 503,
      message:
        data.message ??
        'Your interviewer is reconnecting. Your answers are safe — try again in a moment.',
    };
  }

  const data = (await res.json().catch(() => ({}))) as AnswerResponse;

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      message:
        data.message ??
        data.error ??
        'Something went wrong saving that. Please try again.',
    };
  }

  return { ok: true, data };
}

/* -------------------------------------------------------------------------- */
/* shared props for every structured control                                   */
/* -------------------------------------------------------------------------- */

export interface StructuredCardProps {
  /** The single question this card renders. */
  question: InterviewQuestion;
  /** Interview session to attribute the write to (optional). */
  sessionId?: string;
  /** Called after a successful save so the parent can advance to the next Q. */
  onAnswered: (result: {
    question: InterviewQuestion;
    value: string;
    data: AnswerResponse;
  }) => void;
  /**
   * Called when the owner skips a NON-required question. When omitted, no skip
   * affordance is shown. Required questions never surface a skip.
   */
  onSkip?: (question: InterviewQuestion) => void;
  /** Focus the primary control on mount (used when auto-advancing). */
  autoFocus?: boolean;
}

/* -------------------------------------------------------------------------- */
/* card header — eyebrow (section) + question + help                           */
/* -------------------------------------------------------------------------- */

/** Jargon-free label for the section chip above the question. */
const SECTION_LABEL: Record<InterviewQuestion['section'], string> = {
  identity: 'Your company',
  branding: 'Your brand',
  operations: 'How you run',
};

export function QuestionHeader({ question }: { question: InterviewQuestion }) {
  return (
    <header>
      <p className={iv.eyebrow}>{SECTION_LABEL[question.section]}</p>
      <h1 className={iv.question}>{question.prompt}</h1>
      {question.help && (
        <p className={ivcx(iv.lede, 'iv-help')}>
          <HelpCircle
            aria-hidden
            style={{
              width: '1em',
              height: '1em',
              display: 'inline',
              verticalAlign: '-0.15em',
              marginRight: '0.4em',
              opacity: 0.7,
            }}
          />
          {question.help}
        </p>
      )}
    </header>
  );
}

/* -------------------------------------------------------------------------- */
/* text control (kind 'text' and the 'choice' fallback)                        */
/* -------------------------------------------------------------------------- */

/** True when a text answer clears the required-field bar (non-empty trimmed). */
function textIsValid(value: string, required: boolean): boolean {
  return required ? value.trim().length > 0 : true;
}

function TextControl({
  question,
  sessionId,
  onAnswered,
  onSkip,
  autoFocus,
}: StructuredCardProps) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const required = question.required === true;
  // Longer, reflective branding prompts read better as a small textarea.
  const multiline = question.section === 'branding';

  const submit = useCallback(async () => {
    setError(null);
    const trimmed = value.trim();
    // Client-side gate — a required field blocks an empty submit before the wire.
    if (!textIsValid(trimmed, required)) {
      setError('Please share a short answer before continuing.');
      return;
    }
    if (busy) return;
    setBusy(true);
    const result = await submitInterviewAnswer({
      questionId: question.id,
      storeOn: question.storeOn,
      kind: question.kind,
      value: trimmed,
      sessionId,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onAnswered({ question, value: trimmed, data: result.data });
  }, [busy, onAnswered, question, required, sessionId, value]);

  const canSubmit = !busy && textIsValid(value, required);

  return (
    <div className="iv-field-block">
      {multiline ? (
        <textarea
          className={iv.field}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
          rows={3}
          autoFocus={autoFocus}
          placeholder="Type your answer…"
          aria-label={question.prompt}
          aria-invalid={error ? true : undefined}
        />
      ) : (
        <input
          type="text"
          className={iv.input}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (canSubmit) void submit();
            }
          }}
          autoFocus={autoFocus}
          placeholder="Type your answer…"
          aria-label={question.prompt}
          aria-invalid={error ? true : undefined}
        />
      )}

      {error && (
        <p className="iv-error" role="alert">
          {error}
        </p>
      )}

      <CardActions
        onSubmit={submit}
        canSubmit={canSubmit}
        busy={busy}
        required={required}
        onSkip={onSkip ? () => onSkip(question) : undefined}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* shared action row (Continue + optional Skip) — reused by every control      */
/* -------------------------------------------------------------------------- */

export function CardActions({
  onSubmit,
  canSubmit,
  busy,
  required,
  onSkip,
  submitLabel = 'Continue',
}: {
  onSubmit: () => void;
  canSubmit: boolean;
  busy: boolean;
  required: boolean;
  onSkip?: () => void;
  submitLabel?: string;
}) {
  return (
    <div className="iv-actions">
      <button
        type="button"
        className={ivcx(iv.btnPrimary, busy && 'is-busy')}
        onClick={onSubmit}
        disabled={!canSubmit}
        aria-disabled={!canSubmit}
      >
        {busy ? 'Saving…' : submitLabel}
      </button>
      {/* A skip is only ever offered for a NON-required question. */}
      {!required && onSkip && (
        <button
          type="button"
          className={iv.btnQuiet}
          onClick={onSkip}
          disabled={busy}
        >
          Skip for now
        </button>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* the renderer: pick the rich control for the current question's kind         */
/* -------------------------------------------------------------------------- */

export default function QuestionCard(props: StructuredCardProps) {
  const { question } = props;

  return (
    <motion.div
      key={question.id}
      className={iv.card}
      variants={ivQuestionVariants}
      initial="initial"
      animate="animate"
      exit="exit"
    >
      <QuestionHeader question={question} />

      {question.kind === 'color' ? (
        <ColorPickerCard {...props} />
      ) : question.kind === 'url' ? (
        <LogoDropCard {...props} />
      ) : (
        // 'text' and the 'choice' fallback share the validated text control.
        <TextControl {...props} />
      )}
    </motion.div>
  );
}
