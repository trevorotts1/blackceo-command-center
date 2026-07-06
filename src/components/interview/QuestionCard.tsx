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
import { HelpCircle, ShieldCheck } from 'lucide-react';
import {
  iv,
  ivcx,
  ivQuestionVariants,
} from '@/components/interview/interview-theme';
import type { InterviewQuestion } from '@/lib/interview-questions';
import {
  buildAnswerPayload,
  type BuildAnswerPayloadArgs,
} from '@/lib/interview/answer-payload';
import { personalizePrompt } from '@/lib/interview/structured-progress';
import ColorPickerCard from '@/components/interview/ColorPickerCard';
import LogoDropCard from '@/components/interview/LogoDropCard';

/* -------------------------------------------------------------------------- */
/* /api/interview/answer contract — built EXCLUSIVELY through                  */
/* buildAnswerPayload() (src/lib/interview/answer-payload.ts), the shared      */
/* client/route shape that tests/unit/interview-answer-contract.test.ts pins   */
/* against the route's own zod schema. Never hand-shape this body again: the   */
/* pre-v4.63 local shape ({value, storeOn, kind}) failed route validation and  */
/* 400'd every structured card submit.                                         */
/* -------------------------------------------------------------------------- */

export type AnswerRequest = BuildAnswerPayloadArgs;

export interface AnswerResponse {
  ok?: boolean;
  questionId?: string;
  storeOn?: string;
  appended?: boolean;
  stateStamped?: boolean;
  error?: string;
  message?: string;
}

export type SubmitResult =
  | { ok: true; data: AnswerResponse }
  | { ok: false; message: string; status?: number };

/**
 * POST one structured answer to /api/interview/answer. The single network path
 * every card shares; the body is shaped by buildAnswerPayload() so it can never
 * drift from the route schema again (the contract test pins both sides).
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
      body: JSON.stringify(buildAnswerPayload(req)),
    });
  } catch {
    return {
      ok: false,
      message: 'Network hiccup — that answer did not save. Please try again.',
    };
  }

  const data = (await res.json().catch(() => ({}))) as AnswerResponse;

  if (!res.ok) {
    // SOFT success: the transcript append landed (`appended: true`) but the
    // progress stamp failed (script missing / non-zero exit → 502/503). The
    // answer is SAVED, so the owner advances instead of being dead-ended on a
    // card they can never "fix"; the stamp self-heals on the next good save.
    if (data.appended === true) {
      return { ok: true, data };
    }
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
  /** 1-based position of this question in the owner's journey (progress stamp). */
  questionNumber?: number;
  /** A value already on file for this question (memory/known-context). The card
   *  prefills it and offers "confirm or correct"; confirming records
   *  confirmed-from-context provenance instead of a fresh fabrication vector. */
  knownValue?: string;
  /** Where the known value came from (e.g. 'client-record') — sent as the
   *  confirmed-from-context source when the owner confirms it unchanged. */
  knownSource?: string;
  /** Company name from an earlier answer — personalizes the ON-SCREEN prompt
   *  copy only (the canonical prompt is always what gets recorded). */
  companyName?: string | null;
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

export function QuestionHeader({
  question,
  companyName,
}: {
  question: InterviewQuestion;
  companyName?: string | null;
}) {
  return (
    <header>
      <p className={iv.eyebrow}>{SECTION_LABEL[question.section]}</p>
      {/* Personalized copy is PRESENTATION only — the canonical question.prompt
          is what buildAnswerPayload records, so matching/QC stay exact. */}
      <h1 className={iv.question}>{personalizePrompt(question.prompt, companyName)}</h1>
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
  questionNumber,
  knownValue,
  knownSource,
  onAnswered,
  onSkip,
  autoFocus,
}: StructuredCardProps) {
  // Memory: prefill with the value already on file so the owner confirms
  // instead of re-typing. An untouched confirm records confirmed-from-context.
  const [value, setValue] = useState(knownValue ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const required = question.required === true;
  // Longer, reflective branding prompts read better as a small textarea.
  const multiline = question.section === 'branding';
  const hasKnown = !!(knownValue && knownValue.trim());

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
    const confirmsKnown =
      hasKnown && trimmed === (knownValue ?? '').trim() && !!knownSource;
    const result = await submitInterviewAnswer({
      question,
      value: trimmed,
      questionNumber,
      sessionId,
      confirmedFromContext: confirmsKnown ? knownSource : undefined,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onAnswered({ question, value: trimmed, data: result.data });
  }, [
    busy,
    hasKnown,
    knownSource,
    knownValue,
    onAnswered,
    question,
    questionNumber,
    required,
    sessionId,
    value,
  ]);

  const canSubmit = !busy && textIsValid(value, required);

  return (
    <div className="iv-field-block">
      {hasKnown && (
        <p className="iv-known-note">
          <ShieldCheck
            aria-hidden
            style={{
              width: '1em',
              height: '1em',
              display: 'inline',
              verticalAlign: '-0.15em',
              marginRight: '0.4em',
            }}
          />
          We already have this on file — confirm it below, or change it to
          whatever&apos;s right.
        </p>
      )}
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
        submitLabel={
          hasKnown && value.trim() === (knownValue ?? '').trim()
            ? 'Confirm & continue'
            : 'Continue'
        }
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
      <QuestionHeader question={question} companyName={props.companyName} />

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
