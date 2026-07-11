'use client';

/**
 * ReviewScreen — Phase 6 of the AI Workforce Interview (P2-6).
 *
 * The last screen before the build fires: the owner reads back everything they
 * told us, fixes anything that came out wrong, clears the questions they skipped,
 * and only THEN presses the one gated "Build my company" button. It is the human
 * mirror of every build-side anti-fabrication gate — the button here can no more
 * arm on an unfinished interview than the enforcer can.
 *
 * ── What it shows (top → bottom) ──────────────────────────────────────────────
 *   1. SYNTHESIS — a warm, plain-English read-back of who the owner is and what
 *      we heard, so review feels like being understood, not filling a form. Comes
 *      from the agent's handoff synthesis (passed in as `synthesis`).
 *   2. GROUPED ANSWER LIST — every recorded answer, grouped by phase, scannable
 *      and editable side-by-side. Each row can flip into an inline editor.
 *   3. SKIPPED-QUESTION CIRCLE-BACK QUEUE — the questions the owner passed on
 *      (from GET /api/interview/state → resume.skippedQuestions), each with a
 *      "answer this now" affordance that hands control back to the conversation
 *      (via `onCircleBack`).
 *   4. THE GATED BUILD — "Build my company", disabled until ALL THREE gate flags
 *      are true, exactly as in InterviewClient/DepartmentBoard. On click it POSTs
 *      /api/interview/complete (the same script the Telegram agent presses) and
 *      routes: pass → /onboarding/building, needs-review → calm holding screen,
 *      fail → drill-back list.
 *
 * ── Inline edit → genuine provenance (SKILL.md edge case) ─────────────────────
 * An edit does NOT rewrite history. It POSTs /api/interview/answer, which APPENDS
 * a fresh, genuine Q/A block to workforce-interview-answers.md (files are the
 * single source of truth; the transcript only ever grows). The new block carries
 * an "Updated on <date> — previous answer was: <X>" note in its answer body, so
 * the file records exactly what changed and when — the provenance the SKILL.md
 * edge case requires. We never hand-write the file, never touch build-state with
 * TS/jq, and never send a color/logo answer through here (those keep their strict
 * storeOn validation on the conversational path); free-text answers only.
 *
 * ── Data & doctrine ───────────────────────────────────────────────────────────
 *   • Gate flags + skipped queue + coverage are read LIVE from GET
 *     /api/interview/state (files, not a divergent DB copy). Fail-closed: any read
 *     error leaves the flags all-false and the Build button locked.
 *   • The answer list is passed in (`answers`) by the host, which sources it from
 *     the read-mirror index; this screen renders and edits it but is not its
 *     write authority.
 *   • Imports NOTHING from the Node-only seam — it talks only to API routes and a
 *     server action, mirroring their JSON with local types, so it stays a clean
 *     client bundle (same posture as InterviewClient/DepartmentBoard).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Pencil,
  Check,
  X,
  Loader2,
  Building2,
  Lock,
  ShieldCheck,
  CheckCircle2,
  AlertTriangle,
  ClipboardList,
  Sparkles,
  CornerUpLeft,
  RotateCcw,
} from 'lucide-react';
import {
  iv,
  ivcx,
  ivScreenVariants,
  ivStaggerParent,
  ivStaggerChild,
} from './interview-theme';
import { refreshInterviewGate } from '@/components/interview/gate-actions';

/* -------------------------------------------------------------------------- */
/* public shapes                                                               */
/* -------------------------------------------------------------------------- */

/** One recorded answer, as the host hands it to the review screen. */
export interface ReviewAnswer {
  /** Stable row key (the mirror row id, or any unique string). */
  id: string;
  /** The exact question that was asked — recorded verbatim on edit. */
  question: string;
  /** The current answer text. */
  answer: string;
  /** The numeric slot, when the answer has one (drives the circle-back match). */
  questionNumber?: number | null;
  /** Phase this answer belongs to (used only to group the list). */
  phase?: string | null;
  /** Any provenance note already on the block (confirmed-from-context / updated-on). */
  provenance?: string | null;
  /** The interview-questions.ts id, when known (passed straight through on write). */
  questionId?: string | null;
  /**
   * Editable inline? Defaults to true. Set false for structured branding answers
   * (color/logo) so they keep their strict storeOn validation on the card path
   * instead of being re-typed as free text here.
   */
  editable?: boolean;
}

export interface ReviewScreenProps {
  /** The grouped answer list to render (from the read-mirror index). */
  answers?: ReviewAnswer[];
  /** The agent's plain-English read-back paragraph shown at the top. */
  synthesis?: string;
  /** Pin writes to an existing interview session; else the seam resolves one. */
  sessionId?: string;
  /** Skip the initial /state auto-load (tests / storybook). */
  autoLoad?: boolean;
  /**
   * Hand control back to the conversation to answer a skipped question. Receives
   * the question number (or null) so the host can resume the interview there.
   */
  onCircleBack?: (questionNumber: number | null) => void;
  /** Notified after a successful inline edit, with the updated row. */
  onEdited?: (updated: ReviewAnswer) => void;
  className?: string;
}

/* -------------------------------------------------------------------------- */
/* JSON shapes (mirror /api/interview/state; no Node import leaks into bundle) */
/* -------------------------------------------------------------------------- */

interface GateFlags {
  genuineTranscriptReady: boolean;
  decisionCoverageComplete: boolean;
  noUnprovenancedDeclines: boolean;
}

interface StateResponse {
  ok: boolean;
  flags: GateFlags;
  resume: {
    status: string | null;
    nextQuestionNumber: number | null;
    skippedQuestions: number[];
    totalQuestionsAnswered: number | null;
    handoffExists: boolean;
  };
  decisionCoverage: {
    complete: boolean;
    missing: string[];
    rejections: string[];
  };
  progress: {
    lastQuestionNumber: number | null;
    phasesComplete: string[];
    percent: number;
  };
}

/** GET /api/interview/answers — the grouped read-back this screen renders. */
interface AnswersResponseAnswer {
  id: string;
  questionId?: string;
  question: string;
  answer: string;
  loggedAt?: string;
  provenance?: string;
  editable: boolean;
}

interface AnswersResponseGroup {
  phase: string;
  label: string;
  answers: AnswersResponseAnswer[];
}

interface AnswersResponse {
  groups: AnswersResponseGroup[];
  synthesis?: string;
  skipped: number[];
}

interface CompleteMissingItem {
  gate: 'transcript' | 'decision_coverage' | 'unprovenanced_declines';
  reason: string;
  departments?: string[];
  rejections?: string[];
}

interface CompleteResponse {
  ok?: boolean;
  status?: 'pass' | 'needs-review' | 'fail';
  redirect?: string;
  reasons?: string[];
  message?: string;
  error?: string;
  missing?: CompleteMissingItem[];
}

/* -------------------------------------------------------------------------- */
/* constants                                                                   */
/* -------------------------------------------------------------------------- */

const ALL_GATES_FALSE: GateFlags = {
  genuineTranscriptReady: false,
  decisionCoverageComplete: false,
  noUnprovenancedDeclines: false,
};

/** Terminal screens the /complete verdict can route us to (pass redirects away). */
type Outcome =
  | { kind: 'needs-review'; message: string }
  | { kind: 'fail'; reasons: string[] };

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** Human date in the transcript's own style (matches the answer route's stamp). */
function humanDate(): string {
  return new Date().toLocaleString('en-US', {
    month: 'long',
    day: '2-digit',
    year: 'numeric',
  });
}

/**
 * Build the answer body an inline edit appends. Keeps the new answer first, then
 * an "Updated on <date> — previous answer was: <X>" provenance note, so the
 * canonical file records exactly what changed (SKILL.md edge case) without ever
 * rewriting an earlier block.
 */
function withUpdateNote(next: string, previous: string): string {
  const prev = previous.trim();
  const note = `Updated on ${humanDate()} — previous answer was: ${prev ? `"${prev}"` : '(blank)'}`;
  return `${next.trim()}\n\n${note}`;
}

/** Group answers by phase, preserving first-seen order (falls back to one group). */
function groupByPhase(answers: ReviewAnswer[]): Array<{ phase: string; rows: ReviewAnswer[] }> {
  const order: string[] = [];
  const buckets = new Map<string, ReviewAnswer[]>();
  for (const a of answers) {
    const key = (a.phase && a.phase.trim()) || 'Your answers';
    if (!buckets.has(key)) {
      buckets.set(key, []);
      order.push(key);
    }
    buckets.get(key)!.push(a);
  }
  return order.map((phase) => ({ phase, rows: buckets.get(phase)! }));
}

/**
 * Flatten the grouped GET /api/interview/answers payload into the flat
 * ReviewAnswer[] this screen edits and re-groups. The group's display `label`
 * becomes each row's `phase` so the screen's own groupByPhase reproduces the same
 * groups. loggedAt is folded into the visible provenance line when the block
 * carries no explicit provenance note of its own.
 */
function flattenAnswers(resp: AnswersResponse): ReviewAnswer[] {
  const out: ReviewAnswer[] = [];
  for (const group of resp.groups ?? []) {
    for (const a of group.answers ?? []) {
      out.push({
        id: a.id,
        question: a.question,
        answer: a.answer,
        phase: group.label,
        questionId: a.questionId ?? null,
        provenance: a.provenance ?? (a.loggedAt ? `Recorded ${a.loggedAt}` : null),
        editable: a.editable,
      });
    }
  }
  return out;
}

/** Turn a 409 /complete body into one human sentence (mirrors InterviewClient). */
function formatMissing(data: CompleteResponse): string {
  const items = data.missing ?? [];
  if (items.length === 0) {
    return (
      data.message ??
      'A few things still need finishing before we can build. Clear the list above and the button will light up.'
    );
  }
  return items
    .map((m) =>
      m.gate === 'decision_coverage' && m.departments?.length
        ? `${m.reason} (${m.departments.length} left)`
        : m.reason,
    )
    .join(' ');
}

/* -------------------------------------------------------------------------- */
/* component                                                                   */
/* -------------------------------------------------------------------------- */

export default function ReviewScreen({
  answers = [],
  synthesis,
  sessionId,
  autoLoad = true,
  onCircleBack,
  onEdited,
  className,
}: ReviewScreenProps) {
  const router = useRouter();

  // Live server truth (gate flags + skipped queue + coverage).
  const [state, setState] = useState<StateResponse | null>(null);

  // The host may pass a synthesis prop; otherwise we load it from the answers
  // route. A host-provided synthesis always wins over the fetched one.
  const [loadedSynthesis, setLoadedSynthesis] = useState<string | null>(null);
  const displaySynthesis = synthesis ?? loadedSynthesis ?? undefined;

  // Did the host hand us an answer list? When it did, we render that and never
  // clobber it with the self-fetch (the fetch is the empty-state replacement).
  const hostProvidedAnswers = answers.length > 0;

  // Local, editable copy of the answer list (seeded from props, updated on save).
  const [rows, setRows] = useState<ReviewAnswer[]>(answers);
  // Re-seed if the host swaps the answer set (e.g. after a re-fetch).
  const answersKey = answers.map((a) => `${a.id}:${a.answer}`).join('|');
  useEffect(() => {
    setRows(answers);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answersKey]);

  // Build trigger.
  const [submitting, setSubmitting] = useState(false);
  const [completeError, setCompleteError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const flags = state?.flags ?? ALL_GATES_FALSE;
  const allGatesPass =
    flags.genuineTranscriptReady &&
    flags.decisionCoverageComplete &&
    flags.noUnprovenancedDeclines;

  const skipped = state?.resume?.skippedQuestions ?? [];
  const missingDepts = state?.decisionCoverage?.missing?.length ?? 0;

  /* ---- live state (flags + skipped queue + coverage) ---- */

  const loadState = useCallback(async () => {
    try {
      const res = await fetch('/api/interview/state', { cache: 'no-store' });
      const data = (await res.json()) as StateResponse;
      setState(data);
    } catch {
      // Fail-closed: keep the last known state; the Build button stays honest.
    }
  }, []);

  useEffect(() => {
    if (!autoLoad) return;
    void loadState();
  }, [autoLoad, loadState]);

  /* ---- live answer list (grouped read-back from the canonical files) ---- */

  const loadAnswers = useCallback(async () => {
    try {
      const res = await fetch('/api/interview/answers', { cache: 'no-store' });
      if (!res.ok) return; // fail-soft: keep the empty state, never throw
      const data = (await res.json()) as AnswersResponse;
      setRows(flattenAnswers(data));
      if (data.synthesis && data.synthesis.trim()) {
        setLoadedSynthesis(data.synthesis.trim());
      }
    } catch {
      // Fail-soft: the built-in empty state stays; the Build gate is unaffected.
    }
  }, []);

  useEffect(() => {
    // Self-load the read-back only when the host did not supply one (it renders
    // props.answers in that case). This is the replacement for the empty state.
    if (!autoLoad || hostProvidedAnswers) return;
    void loadAnswers();
  }, [autoLoad, hostProvidedAnswers, loadAnswers]);

  /* ---- inline edit (append genuine block + updated-on note) ---- */

  const saveEdit = useCallback(
    async (row: ReviewAnswer, nextValue: string): Promise<boolean> => {
      const trimmed = nextValue.trim();
      if (!trimmed || trimmed === row.answer.trim()) return true; // no-op

      const res = await fetch('/api/interview/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          // Record the real question verbatim so the appended block is genuine.
          prompt: row.question,
          // New answer first, then the "Updated on … — previous answer was …" note.
          answer: withUpdateNote(trimmed, row.answer),
          phase: row.phase ?? undefined,
          questionNumber:
            typeof row.questionNumber === 'number' ? row.questionNumber : undefined,
          sessionId: sessionId ?? undefined,
        }),
      });

      if (!res.ok) return false;

      // Reflect the edit locally: new answer + a visible updated-on provenance.
      const provenance = `Updated on ${humanDate()}`;
      const updated: ReviewAnswer = { ...row, answer: trimmed, provenance };
      setRows((prev) => prev.map((r) => (r.id === row.id ? updated : r)));
      onEdited?.(updated);
      // Re-read gate flags — an edit can flip genuineTranscriptReady.
      void loadState();
      return true;
    },
    [loadState, onEdited, sessionId],
  );

  /* ---- the gated build trigger (same three flags as everywhere) ---- */

  const submitComplete = useCallback(async () => {
    if (!allGatesPass || submitting) return; // belt-and-suspenders
    setSubmitting(true);
    setCompleteError(null);
    try {
      // NOTE: the complete route's schema is STRICT ({customDeptIds?,
      // implicitYesCustomIds?} only) — posting any other key (the old
      // `sessionId`) failed validation with a 400 whenever a conversational
      // session existed, killing the Build button. The trigger needs no body.
      const res = await fetch('/api/interview/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = (await res.json().catch(() => ({}))) as CompleteResponse;

      if (res.ok && data.status === 'pass') {
        try {
          await refreshInterviewGate();
        } catch {
          /* non-fatal — the layout's InterviewGateSync refreshes it too */
        }
        router.push(data.redirect || '/onboarding/building');
        return;
      }
      if (res.ok && data.status === 'needs-review') {
        setOutcome({
          kind: 'needs-review',
          message:
            data.message ??
            "Thanks — we're reviewing your answers. Your workforce will start building shortly; no action is needed from you.",
        });
        return;
      }
      if (res.ok && data.status === 'fail') {
        setOutcome({ kind: 'fail', reasons: data.reasons ?? [] });
        return;
      }
      if (res.status === 409) {
        setCompleteError(formatMissing(data));
        void loadState();
        return;
      }
      setCompleteError(
        data.message ?? "We couldn't start the build just yet. Please try again.",
      );
    } catch {
      setCompleteError('Network error — please try again.');
    } finally {
      setSubmitting(false);
    }
  }, [allGatesPass, loadState, router, submitting]);

  /* ---- renders: terminal screens first ---- */

  if (outcome?.kind === 'fail') {
    return (
      <FailScreen
        reasons={outcome.reasons}
        onReview={() => {
          setOutcome(null);
          void loadState();
        }}
      />
    );
  }
  if (outcome?.kind === 'needs-review') {
    return <NeedsReviewScreen message={outcome.message} />;
  }

  // Plain computation (not a hook) — it sits after the conditional terminal
  // returns above, so it must not be a useMemo (rules of hooks).
  const grouped = groupByPhase(rows);

  return (
    <div className={ivcx(iv.root, className)}>
      <div className={iv.stage} style={{ maxWidth: '52rem' }}>
        {/* ── synthesis ─────────────────────────────────────────────────── */}
        <motion.header variants={ivScreenVariants} initial="initial" animate="animate">
          <p className={iv.eyebrow}>Review</p>
          <h1 className={iv.question} style={{ fontSize: 'clamp(1.6rem, 1.1rem + 2vw, 2.4rem)' }}>
            Here&apos;s everything you told us
          </h1>
          {displaySynthesis ? (
            <div
              className={iv.card}
              style={{ marginTop: '0.9rem', display: 'flex', gap: '0.7rem', alignItems: 'flex-start' }}
            >
              <Sparkles
                className="h-5 w-5"
                aria-hidden
                style={{ color: 'var(--iv-accent-strong)', flexShrink: 0, marginTop: '0.15rem' }}
              />
              <p style={{ margin: 0, fontSize: '0.95rem', lineHeight: 1.6, color: 'var(--iv-ink-soft)', whiteSpace: 'pre-wrap' }}>
                {displaySynthesis}
              </p>
            </div>
          ) : (
            <p className={iv.lede} style={{ marginTop: '0.5rem' }}>
              Read it over, fix anything that isn&apos;t quite right, then build your company.
            </p>
          )}
        </motion.header>

        {/* ── grouped, editable answer list ─────────────────────────────── */}
        {rows.length === 0 ? (
          <div className={iv.card} style={{ textAlign: 'center', color: 'var(--iv-ink-faint)' }}>
            <ClipboardList className="h-6 w-6" aria-hidden style={{ margin: '0 auto 0.5rem' }} />
            <p style={{ margin: 0, fontSize: '0.9rem' }}>
              Your answers will appear here as you go through the interview.
            </p>
          </div>
        ) : (
          grouped.map((group) => (
            <motion.section
              key={group.phase}
              variants={ivStaggerParent}
              initial="initial"
              animate="animate"
              style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}
            >
              <h2
                style={{
                  margin: 0,
                  fontSize: '0.8rem',
                  fontWeight: 700,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  color: 'var(--iv-ink-faint)',
                }}
              >
                {group.phase}
              </h2>
              {group.rows.map((row) => (
                <AnswerRow
                  key={row.id}
                  row={row}
                  onSave={(next) => saveEdit(row, next)}
                />
              ))}
            </motion.section>
          ))
        )}

        {/* ── keep a copy: the durable questions-and-answers document ──────
            A byte-faithful download of the canonical answers file (every
            question asked + every answer given), served read-only by
            /api/interview/answers/export. */}
        {rows.length > 0 && (
          <p style={{ margin: 0, textAlign: 'right' }}>
            <a
              href="/api/interview/answers/export?download=1"
              className={iv.btnQuiet}
              download
              style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}
            >
              <ClipboardList className="h-4 w-4" aria-hidden />
              Download a copy of your answers
            </a>
          </p>
        )}

        {/* ── skipped-question circle-back queue ────────────────────────── */}
        {skipped.length > 0 && (
          <SkippedQueue skipped={skipped} onCircleBack={onCircleBack} />
        )}

        {/* ── the gate checklist + gated build ──────────────────────────── */}
        <BuildGate
          flags={flags}
          allGatesPass={allGatesPass}
          missingDepts={missingDepts}
          submitting={submitting}
          completeError={completeError}
          onBuild={() => void submitComplete()}
        />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* answer row (scannable + inline editor side-by-side)                         */
/* -------------------------------------------------------------------------- */

function AnswerRow({
  row,
  onSave,
}: {
  row: ReviewAnswer;
  onSave: (next: string) => Promise<boolean>;
}) {
  const editable = row.editable !== false;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(row.answer);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  const begin = useCallback(() => {
    setDraft(row.answer);
    setError(null);
    setEditing(true);
  }, [row.answer]);

  useEffect(() => {
    if (editing) taRef.current?.focus();
  }, [editing]);

  const cancel = useCallback(() => {
    setEditing(false);
    setError(null);
  }, []);

  const commit = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    const ok = await onSave(draft);
    setSaving(false);
    if (ok) setEditing(false);
    else setError("That didn't save — please try again.");
  }, [draft, onSave, saving]);

  return (
    <motion.div variants={ivStaggerChild} className={iv.card} style={{ padding: '0.9rem 1rem' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: '0.85rem', fontWeight: 600, color: 'var(--iv-ink)' }}>
            {row.question}
          </p>

          {!editing ? (
            <p
              style={{
                margin: '0.35rem 0 0',
                fontSize: '0.95rem',
                lineHeight: 1.5,
                color: 'var(--iv-ink-soft)',
                whiteSpace: 'pre-wrap',
              }}
            >
              {row.answer}
            </p>
          ) : (
            <div style={{ marginTop: '0.5rem' }}>
              <textarea
                ref={taRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void commit();
                  }
                  if (e.key === 'Escape') cancel();
                }}
                rows={3}
                className={iv.input}
                style={{
                  width: '100%',
                  resize: 'vertical',
                  background: 'var(--iv-surface-2)',
                  border: '1px solid var(--iv-line-strong)',
                  borderRadius: 'var(--iv-radius-sm)',
                  padding: '0.55rem 0.7rem',
                  color: 'var(--iv-ink)',
                  fontSize: '0.95rem',
                  lineHeight: 1.5,
                }}
              />
              {error && (
                <p style={{ margin: '0.4rem 0 0', fontSize: '0.8rem', color: '#b42318' }}>{error}</p>
              )}
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.55rem' }}>
                <button
                  type="button"
                  onClick={() => void commit()}
                  disabled={saving || !draft.trim()}
                  className={iv.btnPrimary}
                >
                  {saving ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <Check className="h-4 w-4" aria-hidden />
                  )}
                  Save
                </button>
                <button type="button" onClick={cancel} disabled={saving} className={iv.btnGhost}>
                  <X className="h-4 w-4" aria-hidden />
                  Cancel
                </button>
              </div>
            </div>
          )}

          {!editing && row.provenance && (
            <p style={{ margin: '0.3rem 0 0', fontSize: '0.72rem', color: 'var(--iv-ink-faint)' }}>
              {row.provenance}
            </p>
          )}
        </div>

        {!editing && editable && (
          <button
            type="button"
            onClick={begin}
            aria-label={`Edit answer: ${row.question}`}
            className={iv.btnQuiet}
            style={{ flexShrink: 0, padding: '0.35rem 0.6rem', fontSize: '0.8rem' }}
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden />
            Edit
          </button>
        )}
      </div>
    </motion.div>
  );
}

/* -------------------------------------------------------------------------- */
/* skipped-question circle-back queue                                          */
/* -------------------------------------------------------------------------- */

function SkippedQueue({
  skipped,
  onCircleBack,
}: {
  skipped: number[];
  onCircleBack?: (questionNumber: number | null) => void;
}) {
  return (
    <motion.section
      variants={ivScreenVariants}
      initial="initial"
      animate="animate"
      className={iv.card}
      style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.55rem' }}>
        <CornerUpLeft className="h-4 w-4" aria-hidden style={{ color: 'var(--iv-accent-strong)' }} />
        <h2 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600, color: 'var(--iv-ink)' }}>
          Questions to circle back to
        </h2>
      </div>
      <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--iv-ink-faint)' }}>
        You skipped {skipped.length} question{skipped.length === 1 ? '' : 's'}. Answer them now for a
        richer workforce, or leave them — they won&apos;t block your build.
      </p>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
        {skipped.map((n) => (
          <li
            key={n}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '0.75rem',
              padding: '0.5rem 0.6rem',
              borderRadius: 'var(--iv-radius-sm)',
              background: 'var(--iv-surface-2)',
            }}
          >
            <span style={{ fontSize: '0.9rem', color: 'var(--iv-ink-soft)' }}>Question {n}</span>
            <button
              type="button"
              onClick={() => onCircleBack?.(n)}
              disabled={!onCircleBack}
              className={iv.btnGhost}
              style={{ padding: '0.3rem 0.6rem', fontSize: '0.8rem' }}
            >
              Answer this now
            </button>
          </li>
        ))}
      </ul>
    </motion.section>
  );
}

/* -------------------------------------------------------------------------- */
/* gate checklist + gated build button                                         */
/* -------------------------------------------------------------------------- */

function BuildGate({
  flags,
  allGatesPass,
  missingDepts,
  submitting,
  completeError,
  onBuild,
}: {
  flags: GateFlags;
  allGatesPass: boolean;
  missingDepts: number;
  submitting: boolean;
  completeError: string | null;
  onBuild: () => void;
}) {
  return (
    <motion.section
      variants={ivScreenVariants}
      initial="initial"
      animate="animate"
      className={iv.card}
      style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}
    >
      <h2 className="flex items-center" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.95rem', fontWeight: 600, color: 'var(--iv-ink)' }}>
        <ShieldCheck className="h-4 w-4" aria-hidden style={{ color: 'var(--iv-accent-strong)' }} />
        Before we can build
      </h2>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '0.55rem' }}>
        <GateRow done={flags.genuineTranscriptReady} label="Interview recorded" />
        <GateRow
          done={flags.decisionCoverageComplete}
          label={
            flags.decisionCoverageComplete
              ? 'Departments decided'
              : `Departments decided${missingDepts ? ` (${missingDepts} left)` : ''}`
          }
        />
        <GateRow done={flags.noUnprovenancedDeclines} label="Choices confirmed" />
      </ul>

      {completeError && (
        <div
          role="alert"
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: '0.5rem',
            borderRadius: 'var(--iv-radius-sm)',
            border: '1px solid #e5c07a',
            background: '#fdf6e3',
            padding: '0.7rem 0.8rem',
            fontSize: '0.85rem',
            color: '#8a6d1f',
          }}
        >
          <AlertTriangle className="h-4 w-4" aria-hidden style={{ flexShrink: 0, marginTop: '0.1rem' }} />
          <p style={{ margin: 0 }}>{completeError}</p>
        </div>
      )}

      <button
        type="button"
        onClick={onBuild}
        disabled={!allGatesPass || submitting}
        aria-disabled={!allGatesPass || submitting}
        className={ivcx(iv.btnPrimary, (!allGatesPass || submitting) && 'is-busy')}
        style={{
          width: '100%',
          justifyContent: 'center',
          opacity: !allGatesPass || submitting ? 0.55 : 1,
          cursor: !allGatesPass || submitting ? 'not-allowed' : 'pointer',
        }}
      >
        {submitting ? (
          <>
            <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
            Building…
          </>
        ) : allGatesPass ? (
          <>
            <Building2 className="h-5 w-5" aria-hidden />
            Build my company
          </>
        ) : (
          <>
            <Lock className="h-4 w-4" aria-hidden />
            Build my company
          </>
        )}
      </button>
      {!allGatesPass && (
        <p style={{ margin: 0, textAlign: 'center', fontSize: '0.78rem', color: 'var(--iv-ink-faint)' }}>
          Finish the checklist above to unlock.
        </p>
      )}
    </motion.section>
  );
}

function GateRow({ done, label }: { done: boolean; label: string }) {
  return (
    <li style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', fontSize: '0.9rem' }}>
      {done ? (
        <CheckCircle2 className="h-4 w-4" aria-hidden style={{ color: 'var(--iv-accent-strong)', flexShrink: 0 }} />
      ) : (
        <Lock className="h-4 w-4" aria-hidden style={{ color: 'var(--iv-ink-faint)', flexShrink: 0 }} />
      )}
      <span style={{ color: done ? 'var(--iv-ink)' : 'var(--iv-ink-faint)' }}>{label}</span>
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/* terminal screens: needs-review + fail (distinct renders)                    */
/* -------------------------------------------------------------------------- */

function NeedsReviewScreen({ message }: { message: string }) {
  return (
    <div className={iv.root}>
      <div className={iv.stage} style={{ alignItems: 'center', textAlign: 'center', maxWidth: '32rem' }}>
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '4rem',
            width: '4rem',
            borderRadius: 'var(--iv-radius)',
            background: 'var(--iv-accent-wash)',
            marginBottom: '0.5rem',
          }}
        >
          <ClipboardList className="h-8 w-8" aria-hidden style={{ color: 'var(--iv-accent-strong)' }} />
        </div>
        <h1 className={iv.question} style={{ fontSize: '1.6rem' }}>
          Thanks — we&apos;re reviewing your answers
        </h1>
        <p className={iv.lede}>{message}</p>
        <p style={{ fontSize: '0.82rem', color: 'var(--iv-ink-faint)', marginTop: '0.5rem' }}>
          You can close this tab. We&apos;ll be in touch shortly — no action needed.
        </p>
      </div>
    </div>
  );
}

function FailScreen({ reasons, onReview }: { reasons: string[]; onReview: () => void }) {
  return (
    <div className={iv.root}>
      <div className={iv.stage} style={{ maxWidth: '34rem' }}>
        <div style={{ textAlign: 'center' }}>
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '4rem',
              width: '4rem',
              borderRadius: 'var(--iv-radius)',
              background: '#fdecec',
              marginBottom: '0.5rem',
            }}
          >
            <AlertTriangle className="h-8 w-8" aria-hidden style={{ color: '#b42318' }} />
          </div>
          <h1 className={iv.question} style={{ fontSize: '1.6rem' }}>
            A few answers need another look
          </h1>
          <p className={iv.lede}>
            We couldn&apos;t start the build yet. Here&apos;s what to revisit, then try again.
          </p>
        </div>

        {reasons.length > 0 && (
          <div className={iv.card}>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
              {reasons.map((r, i) => (
                <li key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: '0.55rem', fontSize: '0.9rem', color: 'var(--iv-ink-soft)' }}>
                  <AlertTriangle className="h-4 w-4" aria-hidden style={{ color: '#b42318', flexShrink: 0, marginTop: '0.1rem' }} />
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <button type="button" onClick={onReview} className={iv.btnPrimary} style={{ width: '100%', justifyContent: 'center' }}>
          <RotateCcw className="h-5 w-5" aria-hidden />
          Review my answers
        </button>
      </div>
    </div>
  );
}
