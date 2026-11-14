'use client';

/**
 * QuestionCard — renders ONE question from the step gate's `next` payload.
 *
 * The registry decides the control; the page never does:
 *   • kind 'text'   → input, or a textarea when minChars >= 10
 *   • kind 'choice' → choice buttons (plus an "Other" text field when allowOther)
 *   • kind 'multi'  → toggle buttons; the value is joined with "|"
 *   • kind 'color'  → <ColorPickerCard> (the existing resolver-backed control)
 *   • kind 'url'    → <LogoDropCard> (paste a link or drop a picture)
 *   • kind 'board'  → <DepartmentBoard> (the existing team screen)
 *
 * Under every card: "I am not sure" when the registry allows it (asks the helper
 * for up to three ideas — nothing is saved until the owner presses Continue) and
 * "Skip" when the question is optional.
 *
 * An answer the gate asks to expand (accepted:false) keeps the typed text and
 * shows the gate's own follow-up line under it.
 *
 * Every write goes through POST /api/interview/answer, shaped by
 * buildAnswerPayload() — the shared client/route body. This file never touches
 * a file, a database or the Node-only seam.
 */

import { useInterviewDraft } from './useInterviewDraft';
import { INTERVIEW_SIGN_IN_HELP } from '@/lib/interview/browser-recovery';
import { useCallback, useMemo, useState } from 'react';
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
import ColorPickerCard from '@/components/interview/ColorPickerCard';
import LogoDropCard from '@/components/interview/LogoDropCard';
import DictateAnswerButton from '@/components/interview/DictateAnswerButton';
import IDontKnowButton, { RecommendationCard } from '@/components/interview/IDontKnowButton';
import DepartmentBoard from '@/components/interview/DepartmentBoard';

/* -------------------------------------------------------------------------- */
/* the gate's `next` payload (GET /api/interview/next)                         */
/* -------------------------------------------------------------------------- */

/** One question, exactly as the step gate publishes it. */
export interface NextQuestion {
  id: string;
  prompt: string;
  section?: string;
  kind?: string;
  required?: boolean;
  help?: string | null;
  example?: string | null;
  choices?: string[] | null;
  suggestions?: string[] | null;
  allowSkip?: boolean;
  allowUnsure?: boolean;
  allowOther?: boolean;
  minChars?: number | null;
  minWords?: number | null;
  knownValue?: string | null;
  knownSource?: string | null;
  attempt?: number;
  requiredTotal?: number;
  requiredAnswered?: number;
  answeredTotal?: number;
  percent?: number;
}

/** The gate's "no more required questions" answer. */
export interface GateDone {
  done: true;
  missingRequired?: string[];
  skippedOpen?: string[];
  requiredTotal?: number;
  requiredAnswered?: number;
  answeredTotal?: number;
  percent?: number;
  next?: null;
}

export type GateNext = NextQuestion | GateDone;

export function isDone(next: GateNext | null): next is GateDone {
  return !!next && (next as GateDone).done === true;
}

/* -------------------------------------------------------------------------- */
/* /api/interview/answer contract                                              */
/* -------------------------------------------------------------------------- */

export type AnswerRequest = BuildAnswerPayloadArgs;

export interface AnswerResponse {
  ok?: boolean;
  questionId?: string;
  storeOn?: string;
  appended?: boolean;
  stateStamped?: boolean;
  /** false = the gate asked for ONE follow-up; nothing was written. */
  accepted?: boolean;
  shortAccepted?: boolean;
  followUp?: string | null;
  expected?: string | null;
  reason?: string | null;
  /** The gate's own position after this write (null when it could not answer). */
  next?: GateNext | null;
  error?: string;
  message?: string;
}

export type SubmitResult =
  | { ok: true; data: AnswerResponse }
  | { ok: false; message: string; status?: number; expected?: string | null };

/** Uniform "we cannot reach your system" wording — never "not answered". */
const GATE_UNAVAILABLE =
  'We cannot reach your system right now. Your answers are saved. Please try again in a few minutes.';

/**
 * POST one answer to /api/interview/answer. The single network path every card
 * shares; the body is shaped by buildAnswerPayload().
 */
const pendingAnswerIds = new Map<string, string>();

export async function submitInterviewAnswer(
  req: AnswerRequest,
): Promise<SubmitResult> {
  const payload = JSON.stringify(buildAnswerPayload(req));
  const identity = pendingAnswerIds.get(payload) || crypto.randomUUID();
  pendingAnswerIds.set(payload, identity);

  const postAnswer = async (): Promise<Response | null> => {
    try {
      return await fetch('/api/interview/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': identity },
        body: payload,
      });
    } catch {
      return null;
    }
  };

  const readData = async (res: Response): Promise<AnswerResponse> =>
    (await res.json().catch(() => ({}))) as AnswerResponse;

  const toFailure = (res: Response, data: AnswerResponse): SubmitResult => {
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: res.status, message: INTERVIEW_SIGN_IN_HELP };
    }
    // SOFT success: the transcript append landed (`appended: true`) but the
    // progress stamp failed. The answer is SAVED, so the owner advances.
    if (data.appended === true) {
      return { ok: true, data };
    }
    if (res.status === 409) {
      return {
        ok: false,
        status: 409,
        expected: data.expected ?? null,
        message: 'That question is not the one we are on. Bringing it up now…',
      };
    }
    if (res.status === 503) {
      return { ok: false, status: 503, message: GATE_UNAVAILABLE };
    }
    return {
      ok: false,
      status: res.status,
      message:
        data.message ??
        data.error ??
        'Something went wrong saving that. Please try again.',
    };
  };

  const succeed = (res: Response, data: AnswerResponse): SubmitResult => {
    pendingAnswerIds.delete(payload);
    return { ok: true, data };
  };

  const first = await postAnswer();
  if (!first) {
    return {
      ok: false,
      message: 'Network hiccup — that answer did not save. Please try again.',
    };
  }
  if (first.ok) return succeed(first, await readData(first));
  if (first.status !== 401) return toFailure(first, await readData(first));

  // A 401 here is CSRF-expiry class: heal the cookie with the auth-bypassed
  // gate-status ping, then retry EXACTLY ONCE with the SAME idempotency key.
  try {
    await fetch('/api/interview/gate-status', {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    /* best-effort; the single bounded retry below is still safe */
  }

  const second = await postAnswer();
  if (!second) {
    return {
      ok: false,
      message: 'Network hiccup — that answer did not save. Please try again.',
    };
  }
  if (second.ok) return succeed(second, await readData(second));
  return toFailure(second, await readData(second));
}

/* -------------------------------------------------------------------------- */
/* shared props for the two rich controls (color / logo)                       */
/* -------------------------------------------------------------------------- */

export interface StructuredCardProps {
  /** Verified company/installation/interview scope; never the gateway session. */
  draftScope?: string | null;
  /** The single question this card renders. */
  question: InterviewQuestion;
  /** Interview session to attribute the write to (optional). */
  sessionId?: string;
  /** 1-based position of this question (kept for API compatibility). */
  questionNumber?: number;
  /** A value already on file for this question (known-context). */
  knownValue?: string;
  /** Where the known value came from. */
  knownSource?: string;
  /** Company name from an earlier answer — on-screen copy only. */
  companyName?: string | null;
  /** Called after a successful save. */
  onAnswered: (result: {
    question: InterviewQuestion;
    value: string;
    data: AnswerResponse;
  }) => void;
  /** Called when the owner skips a NON-required question. */
  onSkip?: (question: InterviewQuestion) => void;
  /** Focus the primary control on mount. */
  autoFocus?: boolean;
}

/* -------------------------------------------------------------------------- */
/* the card                                                                    */
/* -------------------------------------------------------------------------- */

export interface QuestionCardProps {
  /** The gate's current question. */
  question: NextQuestion;
  draftScope?: string | null;
  sessionId?: string;
  /** Standard-first box: the team board shows its keep / remove / tune state. */
  standardReady?: boolean;
  /** An accepted answer landed; `data.next` is the gate's new position. */
  onAnswered: (data: AnswerResponse) => void;
  /** A skip landed; `next` is the gate's new position (null when unknown). */
  onSkipped?: (next: GateNext | null) => void;
  /** The gate says this is not the current question — refresh it. */
  onOutOfOrder?: () => void;
  autoFocus?: boolean;
}

export default function QuestionCard({
  question,
  draftScope,
  sessionId,
  standardReady = false,
  onAnswered,
  onSkipped = () => {},
  onOutOfOrder = () => {},
  autoFocus,
}: QuestionCardProps) {
  const kind = question.kind ?? 'text';
  const required = question.required === true;

  /* ---- colour / logo reuse the existing rich controls --------------------- */

  if (kind === 'color' || kind === 'url') {
    const legacy = question as unknown as InterviewQuestion;
    const shared = {
      question: legacy,
      draftScope,
      sessionId,
      knownValue: question.knownValue ?? undefined,
      knownSource: question.knownSource ?? undefined,
      autoFocus,
      onAnswered: (result: { question: InterviewQuestion; value: string; data: AnswerResponse }) => {
        onAnswered(result.data);
      },
      onSkip: () => void skipQuestion(question.id, onSkipped),
    };
    return (
      <motion.div
        key={question.id}
        className={iv.card}
        variants={ivQuestionVariants}
        initial="initial"
        animate="animate"
        exit="exit"
      >
        <Header question={question} />
        {kind === 'color' ? <ColorPickerCard {...shared} /> : <LogoDropCard {...shared} />}
      </motion.div>
    );
  }

  return (
    <motion.div
      key={question.id}
      className={iv.card}
      variants={ivQuestionVariants}
      initial="initial"
      animate="animate"
      exit="exit"
    >
      <Header question={question} />
      {kind === 'board' ? (
        <BoardControl
          question={question}
          sessionId={sessionId}
          standardReady={standardReady}
          onAccepted={onAnswered}
          onOutOfOrder={onOutOfOrder}
        />
      ) : kind === 'choice' ? (
        <ChoiceControl
          question={question}
          onAccepted={onAnswered}
          onSkipped={onSkipped}
          onOutOfOrder={onOutOfOrder}
        />
      ) : kind === 'multi' ? (
        <MultiControl
          question={question}
          onAccepted={onAnswered}
          onSkipped={onSkipped}
          onOutOfOrder={onOutOfOrder}
        />
      ) : (
        <TextControl
          question={question}
          draftScope={draftScope}
          sessionId={sessionId}
          required={required}
          autoFocus={autoFocus}
          onAccepted={onAnswered}
          onSkipped={onSkipped}
          onOutOfOrder={onOutOfOrder}
        />
      )}
    </motion.div>
  );
}

/* -------------------------------------------------------------------------- */
/* card header — question + help + example                                     */
/* -------------------------------------------------------------------------- */

function Header({ question }: { question: NextQuestion }) {
  return (
    <header>
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
      {question.example && (
        <p className={ivcx(iv.lede, 'iv-help')} style={{ fontStyle: 'italic' }}>
          For example: {question.example}
        </p>
      )}
    </header>
  );
}

/* -------------------------------------------------------------------------- */
/* skip helper (the gate owns the decision)                                    */
/* -------------------------------------------------------------------------- */

export async function skipQuestion(
  questionId: string,
  onSkipped: (next: GateNext | null) => void,
): Promise<void> {
  try {
    const res = await fetch('/api/interview/skip', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ questionId }),
    });
    const data = (await res.json().catch(() => ({}))) as { next?: GateNext | null };
    onSkipped(data.next ?? null);
  } catch {
    /* offline — the question simply stays on screen */
  }
}

/* -------------------------------------------------------------------------- */
/* the "I am not sure" helper (three ideas, nothing saved)                     */
/* -------------------------------------------------------------------------- */

function SureNotSure({
  question,
  onPick,
}: {
  question: NextQuestion;
  onPick: (value: string) => void;
}) {
  const [ideas, setIdeas] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const ask = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      await fetch('/api/interview/skip', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ questionId: question.id, unsure: true }),
      });
      const res = await fetch('/api/interview/assist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ questionId: question.id }),
      });
      const data = (await res.json().catch(() => ({}))) as { suggestions?: unknown };
      const list = Array.isArray(data.suggestions)
        ? data.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 3)
        : [];
      if (list.length === 0) {
        setNote('Still working on ideas for you. You can keep waiting, or type your own answer below.');
        return;
      }
      setIdeas(list);
    } catch {
      setNote('Still working on ideas for you. You can keep waiting, or type your own answer below.');
    } finally {
      setBusy(false);
    }
  }, [busy, question.id]);

  return (
    <div className="mt-4">
      <IDontKnowButton onSuggest={() => void ask()} disabled={busy} />
      {note && (
        <p className="mt-2 text-sm" style={{ color: 'var(--iv-ink-soft)' }} role="status">
          {note}
        </p>
      )}
      {ideas && ideas.length > 0 && (
        <div className="mt-3 space-y-2">
          <p className="text-sm" style={{ color: 'var(--iv-ink-soft)' }}>
            Here are three ideas. Tap one, change it, or write your own.
          </p>
          {ideas.map((idea) => (
            <RecommendationCard
              key={idea}
              label={idea}
              description="Tap to put this in the box — you can change it before you continue."
              onSelect={() => onPick(idea)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* shared action row (Continue + optional Skip)                                */
/* -------------------------------------------------------------------------- */

export function CardActions({
  onSubmit,
  canSubmit,
  busy,
  required,
  onSkip,
  submitLabel = 'Continue',
  submitName,
}: {
  onSubmit: () => void;
  canSubmit: boolean;
  busy: boolean;
  required: boolean;
  onSkip?: () => void;
  submitLabel?: string;
  submitName?: string;
}) {
  return (
    <div className="iv-actions">
      <button
        type="button"
        className={ivcx(iv.btnPrimary, busy && 'is-busy')}
        onClick={onSubmit}
        disabled={!canSubmit}
        aria-disabled={!canSubmit}
        aria-label={submitName ?? submitLabel}
      >
        {busy ? 'Saving…' : submitLabel}
      </button>
      {!required && onSkip && (
        <button type="button" className={iv.btnQuiet} onClick={onSkip} disabled={busy}>
          Skip
        </button>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* text control                                                                */
/* -------------------------------------------------------------------------- */

function textIsValid(value: string, required: boolean): boolean {
  return required ? value.trim().length > 0 : true;
}

function TextControl({
  question,
  draftScope,
  sessionId,
  required,
  autoFocus,
  onAccepted,
  onSkipped,
  onOutOfOrder,
}: {
  question: NextQuestion;
  draftScope?: string | null;
  sessionId?: string;
  required: boolean;
  autoFocus?: boolean;
  onAccepted: (data: AnswerResponse) => void;
  onSkipped: (next: GateNext | null) => void;
  onOutOfOrder: () => void;
}) {
  const [value, setValue, clearDraft] = useInterviewDraft(
    draftScope,
    question.id,
    question.knownValue ?? '',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [followUp, setFollowUp] = useState<string | null>(null);
  const multiline = (question.minChars ?? 0) >= 10;
  const hasKnown = !!(question.knownValue && question.knownValue.trim());

  const submit = useCallback(async () => {
    setError(null);
    const trimmed = value.trim();
    if (!textIsValid(trimmed, required)) {
      setError('Please type an answer, or tap I am not sure.');
      return;
    }
    if (busy) return;
    setBusy(true);
    setFollowUp(null);
    const confirmsKnown =
      hasKnown && trimmed === (question.knownValue ?? '').trim() && !!question.knownSource;
    const result = await submitInterviewAnswer({
      question: { id: question.id, prompt: question.prompt, section: question.section },
      value: trimmed,
      sessionId,
      confirmedFromContext: confirmsKnown ? (question.knownSource ?? undefined) : undefined,
    });
    setBusy(false);
    if (!result.ok) {
      if (result.status === 409) {
        onOutOfOrder();
        return;
      }
      setError(result.message);
      return;
    }
    if (result.data.accepted === false) {
      // The gate asked for ONE expansion; nothing was written. Keep the text.
      setFollowUp(result.data.followUp ?? null);
      return;
    }
    clearDraft();
    onAccepted(result.data);
  }, [
    busy,
    clearDraft,
    hasKnown,
    onAccepted,
    onOutOfOrder,
    question,
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
          We already have this on file — is it still right? Confirm it below, or change it.
        </p>
      )}
      <div className="flex items-end gap-2">
        {multiline ? (
          <textarea
            className={ivcx(iv.field, 'flex-1')}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError(null);
            }}
            rows={3}
            autoFocus={autoFocus}
            placeholder="Type or speak your answer…"
            aria-label={question.prompt}
            aria-invalid={error ? true : undefined}
          />
        ) : (
          <input
            type="text"
            className={ivcx(iv.input, 'flex-1')}
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
            placeholder="Type or speak your answer…"
            aria-label={question.prompt}
            aria-invalid={error ? true : undefined}
          />
        )}
        <DictateAnswerButton
          value={value}
          onChange={(next) => {
            setValue(next);
            if (error) setError(null);
          }}
          disabled={busy}
          className="mb-1 h-10 w-10 shrink-0"
        />
      </div>

      {followUp && (
        <p className="iv-help" role="status">
          {followUp}
        </p>
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
        onSkip={
          question.allowSkip || !required
            ? () => void skipQuestion(question.id, onSkipped)
            : undefined
        }
        submitLabel="Continue"
      />

      {question.allowUnsure && (
        <SureNotSure question={question} onPick={(idea) => setValue(idea)} />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* choice control                                                              */
/* -------------------------------------------------------------------------- */

function ChoiceControl({
  question,
  onAccepted,
  onSkipped,
  onOutOfOrder,
}: {
  question: NextQuestion;
  onAccepted: (data: AnswerResponse) => void;
  onSkipped: (next: GateNext | null) => void;
  onOutOfOrder: () => void;
}) {
  const [picked, setPicked] = useState<string>('');
  const [other, setOther] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [followUp, setFollowUp] = useState<string | null>(null);
  const choices = useMemo(() => question.choices ?? [], [question.choices]);
  const required = question.required === true;
  const useOther = picked === '__other__';
  const value = useOther
    ? other.trim()
      ? `Other: ${other.trim()}`
      : ''
    : picked;

  const submit = useCallback(async () => {
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    setFollowUp(null);
    const result = await submitInterviewAnswer({
      question: { id: question.id, prompt: question.prompt, section: question.section },
      value,
    });
    setBusy(false);
    if (!result.ok) {
      if (result.status === 409) {
        onOutOfOrder();
        return;
      }
      setError(result.message);
      return;
    }
    if (result.data.accepted === false) {
      setFollowUp(result.data.followUp ?? null);
      return;
    }
    onAccepted(result.data);
  }, [busy, onAccepted, onOutOfOrder, question, value]);

  return (
    <div className="iv-field-block">
      <div className="iv-choice-grid" style={{ display: 'grid', gap: '0.5rem' }}>
        {choices.map((c) => (
          <button
            key={c}
            type="button"
            className={ivcx(iv.choice, picked === c && 'is-selected')}
            aria-pressed={picked === c}
            onClick={() => {
              setPicked(c);
              setError(null);
            }}
          >
            {c}
          </button>
        ))}
        {question.allowOther && (
          <button
            type="button"
            className={ivcx(iv.choice, useOther && 'is-selected')}
            aria-pressed={useOther}
            onClick={() => setPicked('__other__')}
          >
            Other
          </button>
        )}
      </div>

      {useOther && (
        <input
          type="text"
          className={ivcx(iv.input, 'mt-3')}
          value={other}
          onChange={(e) => setOther(e.target.value)}
          placeholder="Type your answer"
          aria-label="Other answer"
          autoFocus
        />
      )}

      {followUp && (
        <p className="iv-help" role="status">
          {followUp}
        </p>
      )}
      {error && (
        <p className="iv-error" role="alert">
          {error}
        </p>
      )}

      <CardActions
        onSubmit={submit}
        canSubmit={!busy && !!value}
        busy={busy}
        required={required}
        onSkip={
          question.allowSkip || !required
            ? () => void skipQuestion(question.id, onSkipped)
            : undefined
        }
      />

      {question.allowUnsure && (
        <SureNotSure
          question={question}
          onPick={(idea) => {
            if (choices.includes(idea)) {
              setPicked(idea);
            } else {
              setPicked('__other__');
              setOther(idea);
            }
          }}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* multi control                                                               */
/* -------------------------------------------------------------------------- */

function MultiControl({
  question,
  onAccepted,
  onSkipped,
  onOutOfOrder,
}: {
  question: NextQuestion;
  onAccepted: (data: AnswerResponse) => void;
  onSkipped: (next: GateNext | null) => void;
  onOutOfOrder: () => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [other, setOther] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [followUp, setFollowUp] = useState<string | null>(null);
  const choices = useMemo(() => question.choices ?? [], [question.choices]);
  const required = question.required === true;

  const toggle = (c: string) =>
    setPicked((prev) => (prev.includes(c) ? prev.filter((p) => p !== c) : [...prev, c]));

  const value = useMemo(() => {
    const parts = [...picked];
    const extra = other.trim();
    if (extra) parts.push(`Other: ${extra}`);
    return parts.join('|');
  }, [other, picked]);

  const submit = useCallback(async () => {
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    setFollowUp(null);
    const result = await submitInterviewAnswer({
      question: { id: question.id, prompt: question.prompt, section: question.section },
      value,
    });
    setBusy(false);
    if (!result.ok) {
      if (result.status === 409) {
        onOutOfOrder();
        return;
      }
      setError(result.message);
      return;
    }
    if (result.data.accepted === false) {
      setFollowUp(result.data.followUp ?? null);
      return;
    }
    onAccepted(result.data);
  }, [busy, onAccepted, onOutOfOrder, question, value]);

  return (
    <div className="iv-field-block">
      <div style={{ display: 'grid', gap: '0.5rem' }}>
        {choices.map((c) => (
          <button
            key={c}
            type="button"
            className={ivcx(iv.choice, picked.includes(c) && 'is-selected')}
            aria-pressed={picked.includes(c)}
            onClick={() => toggle(c)}
          >
            {c}
          </button>
        ))}
      </div>

      {question.allowOther && (
        <input
          type="text"
          className={ivcx(iv.input, 'mt-3')}
          value={other}
          onChange={(e) => setOther(e.target.value)}
          placeholder="Anything missing? Type it here"
          aria-label="Other answer"
        />
      )}

      {followUp && (
        <p className="iv-help" role="status">
          {followUp}
        </p>
      )}
      {error && (
        <p className="iv-error" role="alert">
          {error}
        </p>
      )}

      <CardActions
        onSubmit={submit}
        canSubmit={!busy && !!value}
        busy={busy}
        required={required}
        onSkip={
          question.allowSkip || !required
            ? () => void skipQuestion(question.id, onSkipped)
            : undefined
        }
      />

      {question.allowUnsure && (
        <SureNotSure
          question={question}
          onPick={(idea) => {
            if (choices.includes(idea)) {
              if (!picked.includes(idea)) toggle(idea);
            } else {
              setOther(idea);
            }
          }}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* board control — the existing team screen, then one Continue                 */
/* -------------------------------------------------------------------------- */

function BoardControl({
  question,
  sessionId,
  standardReady,
  onAccepted,
  onOutOfOrder,
}: {
  question: NextQuestion;
  sessionId?: string;
  standardReady: boolean;
  onAccepted: (data: AnswerResponse) => void;
  onOutOfOrder: () => void;
}) {
  const [complete, setComplete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await submitInterviewAnswer({
      question: { id: question.id, prompt: question.prompt, section: question.section },
      value: 'edited',
    });
    setBusy(false);
    if (!result.ok) {
      if (result.status === 409) {
        onOutOfOrder();
        return;
      }
      setError(result.message);
      return;
    }
    if (result.data.accepted === false) {
      setError(result.data.followUp ?? 'Please change a team, then continue.');
      return;
    }
    onAccepted(result.data);
  }, [busy, onAccepted, onOutOfOrder, question]);

  return (
    <div>
      <DepartmentBoard
        sessionId={sessionId}
        onCoverageChange={setComplete}
        standardReady={standardReady}
      />
      {error && (
        <p className="iv-error" role="alert">
          {error}
        </p>
      )}
      <div className="iv-actions" style={{ justifyContent: 'center' }}>
        <button
          type="button"
          className={ivcx(iv.btnPrimary, !complete && 'is-busy')}
          onClick={() => void submit()}
          disabled={!complete || busy}
          aria-disabled={!complete || busy}
          style={{ opacity: complete ? 1 : 0.55 }}
        >
          {busy ? 'Saving…' : 'Continue'}
        </button>
      </div>
    </div>
  );
}
