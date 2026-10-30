'use client';

/**
 * DecisionComposer (CWE-033, Skill 77)
 *
 * The guided intake journey (Section 9) over CWE-023's semantics:
 * one question at a time in the canonical order, progress persisted
 * after every answer, resume computed from the saved draft so an
 * interrupted intake lands on the exact unanswered question and never
 * re-issues an answered one (T016). Explicit unknown is a first-class
 * answer wherever CWE-023 allows it. Facts already known through
 * authorized retrieval arrive prefilled, are marked with their
 * source, and are never asked for again. The mode and panel step
 * shows the required critical responsibilities and every
 * not_assessed consequence BEFORE start; the route step pins the
 * route snapshot; the private preference is its own final step and
 * never enters the brief. Review shows the composed brief (T017) and
 * the freeze action, which creates the session through the CWE-029
 * foundation and states plainly what freezing means.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  createSession,
  getModels,
  isCouncilClientError,
  newIdempotencyKey,
  type CouncilStoredSession,
} from '@/lib/council/journey-client';
import type { RouteCatalogEntry } from '@/lib/council/providers';
import { council, councilcx } from './council-theme';
import { COUNCIL_SEAT_ROSTER, type CouncilSeatId } from './council-room-types';
import { COUNCIL_MEDALLION_SMALL_SRC } from './medallions';
import { ModelRoutePicker, RouteSnapshot } from './ModelRoutePicker';
import { BriefReview } from './BriefReview';
import {
  CONSTRAINT_KINDS,
  DECISION_FLAG_LABELS,
  INTAKE_QUESTIONS,
  QUICK_MODE_PREREQUISITES,
  QUICK_MODE_RATIFICATION_WHEN_SKIPPED,
  assessJourneyPanel,
  classifyJourneyDomains,
  clearJourneyDraft,
  clearJourneyPreference,
  composeSessionInput,
  emptyDecisionFlags,
  emptyJourneyDraft,
  isQuestionAnswered,
  loadJourneyDraft,
  loadJourneyPreference,
  missingMaterialQuestions,
  normalizeChamberQuestion,
  panelSizeProblem,
  previewBriefFromDraft,
  recommendQuickPanel,
  resumeQuestionIndex,
  saveJourneyDraft,
  saveJourneyPreference,
  seatDisplayName,
  type ConstraintKind,
  type DecisionFlag,
  type IntakeConstraint,
  type IntakeFact,
  type JourneyDraft,
} from './council-journey-types';

const MODE_OPTIONS: { id: JourneyDraft['mode']; label: string; note: string }[] = [
  { id: 'full', label: 'Full council', note: 'All nine seats deliberate.' },
  { id: 'selected', label: 'Selected seats', note: 'You choose 2 to 8 seats.' },
  {
    id: 'quick',
    label: 'Quick council',
    note: 'Exactly four seats; Round 3 ratification is skipped under the quick-mode policy.',
  },
  { id: 'consult', label: 'One-seat consult', note: 'One advisor answers a bounded question.' },
];

/**
 * The draft the composer opens with. The chamber question never bypasses
 * the decision step: its text is SEEDED into the decision field so the
 * client confirms it (and its structured flags) instead of the answer
 * being silently skipped. A saved draft that already answers a decision
 * always wins (T016: an interrupted intake is never re-asked); the
 * chamber question then offers an explicit restart instead of silently
 * discarding that work.
 */
function initialDraftFor(knownFacts: IntakeFact[]): JourneyDraft {
  const stored = loadJourneyDraft();
  if (stored) return stored;
  return emptyJourneyDraft(knownFacts);
}

/**
 * The chamber question becomes the decision answer, in the initial state
 * (never via an effect). It is applied only when the draft carries no
 * decision, so a resumed draft is never overwritten.
 *
 * This seeded answer is NOT persisted until the client acts on it (see
 * seedConfirmed): otherwise merely landing here would write an answered
 * decision with all flags false to the device, and a later visit to
 * /council/new would resume PAST the decision step, silently skipping the
 * structured flags the panel assessment depends on.
 */
function withChamberDecision(
  draft: JourneyDraft,
  chamberQuestion: string | null,
): JourneyDraft {
  if (!chamberQuestion || draft.answers.decision !== null) return draft;
  return {
    ...draft,
    answers: {
      ...draft.answers,
      decision: { text: chamberQuestion, flags: emptyDecisionFlags() },
    },
  };
}

export function DecisionComposer({
  knownFacts = [],
  initialQuestion,
}: {
  knownFacts?: IntakeFact[];
  /**
   * The question typed in the visual chamber entry (/council). It seeds
   * the decision text; see initialDraftFor.
   */
  initialQuestion?: string | string[] | null;
}) {
  const chamberQuestion = normalizeChamberQuestion(initialQuestion);
  const [seedDecision, setSeedDecision] = useState<string | null>(chamberQuestion);
  const [draft, setDraft] = useState<JourneyDraft>(() =>
    withChamberDecision(initialDraftFor(knownFacts), chamberQuestion),
  );
  /**
   * A chamber seed counts as confirmed the moment the client does anything
   * with it (types, toggles a flag, continues, skips). A saved draft is NOT
   * confirmation: when the draft carries no decision the seed is memory-only,
   * and when it carries a different decision the client must still choose the
   * explicit restart before anything is rewritten. Until then nothing is
   * written to the device, so an abandoned visit cannot leave a decision the
   * client never saw marked as answered.
   */
  const [seedConfirmed, setSeedConfirmed] = useState<boolean>(
    () => chamberQuestion === null,
  );
  const [preference, setPreference] = useState<string>(() => loadJourneyPreference());
  const [preferenceVisited, setPreferenceVisited] = useState<boolean>(
    () => loadJourneyPreference().length > 0,
  );
  // Resume index is computed from the UNSEEDED draft on purpose: a chamber
  // question must not skip the decision step, because that step also collects
  // the structured flags the panel assessment depends on.
  const [step, setStep] = useState<number>(() => {
    const initial = initialDraftFor(knownFacts);
    return resumeQuestionIndex(initial, loadJourneyPreference().length > 0);
  });
  /**
   * Explicit restart: a saved draft holds a different decision, so the
   * chamber question cannot ride the resume path. Clearing the draft is a
   * client-side action on the client's own device, and the new question is
   * seeded into the decision step (flags still confirmed by the client).
   *
   * The private preference lives in its own storage slot and is untouched by
   * the restart: it was written by the client and only the client's own edit
   * of that field clears it.
   */
  const restartWithChamberQuestion = () => {
    clearJourneyDraft();
    const fresh = emptyJourneyDraft(knownFacts);
    setDraft(
      chamberQuestion
        ? {
            ...fresh,
            answers: {
              ...fresh.answers,
              decision: { text: chamberQuestion, flags: emptyDecisionFlags() },
            },
          }
        : fresh,
    );
    setSeedDecision(chamberQuestion);
    setSeedConfirmed(false);
    setStep(0);
  };
  const [routes, setRoutes] = useState<RouteCatalogEntry[] | null>(null);
  const [routesError, setRoutesError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [created, setCreated] = useState<CouncilStoredSession | null>(null);

  useEffect(() => {
    if (!seedConfirmed) return;
    saveJourneyDraft(draft);
  }, [draft, seedConfirmed]);

  useEffect(() => {
    let cancelled = false;
    getModels()
      .then((data) => {
        if (!cancelled) setRoutes(data.routes);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setRoutes([]);
          setRoutesError(
            isCouncilClientError(error)
              ? `${error.code}: ${error.message}`
              : 'The route catalog could not be loaded.',
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const requirements = useMemo(() => classifyJourneyDomains(draft), [draft]);
  const assessment = useMemo(
    () => assessJourneyPanel(draft, requirements),
    [draft, requirements],
  );

  const question = INTAKE_QUESTIONS[step] ?? null;
  const isReview = step >= INTAKE_QUESTIONS.length;

  const update = (patch: Partial<JourneyDraft>) => {
    setSeedConfirmed(true);
    setDraft((current) => ({ ...current, ...patch }));
  };
  const updateAnswers = (patch: Partial<JourneyDraft['answers']>) => {
    setSeedConfirmed(true);
    setDraft((current) => ({ ...current, answers: { ...current.answers, ...patch } }));
  };

  const goTo = (index: number) => {
    if (INTAKE_QUESTIONS[index]?.id === 'preference') setPreferenceVisited(true);
    setStep(index);
  };

  const canContinue = (): boolean => {
    if (!question) return false;
    switch (question.id) {
      case 'mode_panel': {
        if (draft.mode === null || draft.panelSeatIds === null) return false;
        return panelSizeProblem(draft.mode, draft.panelSeatIds.length) === null;
      }
      case 'route':
        return draft.routeChoice !== null;
      case 'preference':
        return true;
      case 'assumptions':
      case 'stakeholders':
        return true;
      default:
        return isQuestionAnswered(draft, question.id);
    }
  };

  const handleContinue = () => {
    if (!question) return;
    // Continuing is the client confirming what is on screen, seed included.
    setSeedConfirmed(true);
    if (
      (question.id === 'assumptions' || question.id === 'stakeholders') &&
      !isQuestionAnswered(draft, question.id) &&
      !draft.skippedQuestionIds.includes(question.id)
    ) {
      update({ skippedQuestionIds: [...draft.skippedQuestionIds, question.id] });
    }
    if (question.id === 'preference') setPreferenceVisited(true);
    goTo(step + 1);
  };

  const handleSkip = () => {
    if (!question) return;
    setSeedConfirmed(true);
    if (!draft.skippedQuestionIds.includes(question.id)) {
      update({ skippedQuestionIds: [...draft.skippedQuestionIds, question.id] });
    }
    goTo(step + 1);
  };

  const freezeBrief = async () => {
    const choice = draft.routeChoice;
    const selectedRoute =
      choice?.kind === 'explicit'
        ? (routes ?? []).find((r) => r.routeId === choice.routeId) ?? null
        : null;
    const composed = composeSessionInput(
      draft,
      selectedRoute
        ? { routeId: selectedRoute.routeId, modelId: selectedRoute.modelId }
        : null,
    );
    if (!composed.ok) {
      setSubmitError(composed.reason);
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const session = await createSession(composed.input, newIdempotencyKey());
      clearJourneyDraft();
      clearJourneyPreference();
      setCreated(session);
    } catch (error) {
      setSubmitError(
        isCouncilClientError(error)
          ? `${error.code}: ${error.message}`
          : 'The session could not be created. Your draft is still saved on this device.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (created) {
    return (
      <div className="council-journey-stack" data-testid="intake-created">
        <div className="council-journey-notice">
          <h2 className={council.heading}>Brief frozen; session created</h2>
          <p>
            The brief is locked at revision {created.spec.brief_revision}. Its content hash is{' '}
            <span className="council-journey-hash">{created.spec.brief_sha256}</span>. Later
            facts do not rewrite this revision; they are recorded as amendments.
          </p>
          <p className={council.meta}>
            The council run has not started. Starting is a separate action on the session page.
          </p>
          <p>
            <Link
              className={council.btnPrimary}
              href={`/council/${created.spec.session_id}`}
              data-testid="intake-open-session"
            >
              Open the session
            </Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="decision-composer">
      {chamberQuestion ? (
        <div className="council-journey-notice" data-testid="chamber-question-notice">
          <p className={council.meta} style={{ margin: 0 }}>
            From the chamber:{' '}
            <strong data-testid="chamber-question-echo">{chamberQuestion}</strong>.{' '}
            {draft.answers.decision && draft.answers.decision.text !== chamberQuestion ? (
              <>
                Your saved draft answers a different decision, so it stays as it is.{' '}
                <button
                  type="button"
                  className={council.btn}
                  data-testid="chamber-question-restart"
                  onClick={restartWithChamberQuestion}
                >
                  Start a new intake with this question
                </button>{' '}
                or{' '}
                <Link href="/council">return to the chamber</Link>.
              </>
            ) : (
              <>
                It is filled in below; confirm the flags and continue.{' '}
                <Link href="/council">Back to the chamber</Link>.
              </>
            )}
          </p>
        </div>
      ) : null}
      <ol className="council-journey-progress" aria-label="Intake progress">
        {INTAKE_QUESTIONS.map((q, index) => {
          const state =
            index === step
              ? 'current'
              : isQuestionAnswered(draft, q.id) ||
                  draft.skippedQuestionIds.includes(q.id) ||
                  (q.id === 'preference' && preferenceVisited)
                ? 'done'
                : 'todo';
          return (
            <li key={q.id} data-state={state} data-testid={`intake-progress-${q.id}`}>
              {q.title}
            </li>
          );
        })}
        <li data-state={isReview ? 'current' : 'todo'} data-testid="intake-progress-review">
          Review and freeze
        </li>
      </ol>

      {!isReview && question ? (
        <section
          className="council-journey-kind"
          data-testid={`intake-step-${question.id}`}
          aria-labelledby="intake-question-title"
        >
          <p className={council.meta}>
            Question {step + 1} of {INTAKE_QUESTIONS.length}
            {question.material ? ' · required' : ' · optional'}
          </p>
          <h2 id="intake-question-title" className={council.heading}>
            {question.title}
          </h2>
          <p className={council.meta}>{question.guidance}</p>

          {question.id === 'decision' ? (
            <DecisionStep
              draft={draft}
              updateAnswers={updateAnswers}
              seedText={seedDecision}
              onSeedConsumed={() => setSeedDecision(null)}
            />
          ) : null}
          {question.id === 'options' ? (
            <OptionsStep draft={draft} updateAnswers={updateAnswers} />
          ) : null}
          {question.id === 'success' ? (
            <SuccessStep draft={draft} updateAnswers={updateAnswers} />
          ) : null}
          {question.id === 'constraints' ? (
            <ConstraintsStep draft={draft} updateAnswers={updateAnswers} />
          ) : null}
          {question.id === 'facts' ? <FactsStep draft={draft} updateAnswers={updateAnswers} /> : null}
          {question.id === 'unknowns' ? (
            <ListStep
              label="Unknowns"
              values={draft.answers.unknowns}
              emptyAnswerLabel="Nothing material is unknown"
              onChange={(values) => updateAnswers({ unknowns: values })}
              testId="unknowns-editor"
            />
          ) : null}
          {question.id === 'assumptions' ? (
            <ListStep
              label="Assumptions"
              values={draft.answers.assumptions}
              onChange={(values) => updateAnswers({ assumptions: values })}
              testId="assumptions-editor"
            />
          ) : null}
          {question.id === 'stakeholders' ? (
            <ListStep
              label="People or groups affected"
              values={draft.answers.stakeholders}
              onChange={(values) => updateAnswers({ stakeholders: values })}
              testId="stakeholders-editor"
            />
          ) : null}
          {question.id === 'mode_panel' ? (
            <PanelStep
              draft={draft}
              update={update}
              assessment={assessment}
              requirements={requirements}
            />
          ) : null}
          {question.id === 'route' ? (
            <div>
              {routesError ? (
                <div className="council-journey-notice council-journey-notice-error" role="alert">
                  {routesError}
                </div>
              ) : null}
              <ModelRoutePicker
                routes={routes ?? []}
                choice={draft.routeChoice}
                onChange={(choice) => update({ routeChoice: choice })}
              />
              <RouteSnapshot choice={draft.routeChoice} routes={routes ?? []} />
            </div>
          ) : null}
          {question.id === 'preference' ? (
            <div data-testid="preference-step">
              <div className="council-journey-field">
                <label htmlFor="intake-preference">Your private preference</label>
                <textarea
                  id="intake-preference"
                  className="council-journey-textarea"
                  value={preference}
                  onChange={(event) => {
                    setPreference(event.target.value);
                    saveJourneyPreference(event.target.value);
                  }}
                  placeholder="The option you are leaning toward, in your own words."
                />
              </div>
              <p className={council.meta}>
                This is stored separately from the brief, under its own private record. It
                never appears inside the brief, never reaches Round 1, and is not shown to the
                council. You may leave it empty.
              </p>
            </div>
          ) : null}

          <div className="council-journey-row" style={{ marginTop: '1rem' }}>
            <button
              type="button"
              className={council.btnSecondary}
              onClick={() => goTo(step - 1)}
              disabled={step === 0}
            >
              Back
            </button>
            <button
              type="button"
              className={council.btnPrimary}
              onClick={handleContinue}
              disabled={!canContinue()}
              data-testid="intake-continue"
            >
              Continue
            </button>
            {!question.material ? (
              <button
                type="button"
                className={council.btnQuiet}
                onClick={handleSkip}
                data-testid="intake-skip"
              >
                Skip this question
              </button>
            ) : null}
          </div>
          {!canContinue() && question.material ? (
            <p className={council.meta}>Answer this question to continue.</p>
          ) : null}
        </section>
      ) : null}

      {isReview ? (
        <ReviewStep
          draft={draft}
          routes={routes ?? []}
          submitting={submitting}
          submitError={submitError}
          onBack={() => goTo(INTAKE_QUESTIONS.length - 1)}
          onFreeze={freezeBrief}
        />
      ) : null}
    </div>
  );
}


// ---------------------------------------------------------------- steps

type AnswersPatch = (patch: Partial<JourneyDraft['answers']>) => void;

function DecisionStep({
  draft,
  updateAnswers,
  seedText = null,
  onSeedConsumed,
}: {
  draft: JourneyDraft;
  updateAnswers: AnswersPatch;
  /** Chamber question carried into the entry, filled in but not answered. */
  seedText?: string | null;
  /** The seed is single-use: the client's first edit replaces it for good. */
  onSeedConsumed?: () => void;
}) {
  const current = draft.answers.decision;
  // A seeded chamber question fills the field; it stays UNANSWERED until
  // the client confirms it (its structured flags still need a decision).
  //
  // The seed is shown, never stored, so clearing the field must not bring it
  // back: the parent drops the seed on the client's first edit.
  const text = current?.text ?? seedText ?? '';
  const flags = current?.flags ?? emptyDecisionFlags();
  const consumeSeed = () => {
    if (seedText !== null) onSeedConsumed?.();
  };
  const setText = (value: string) => {
    consumeSeed();
    updateAnswers({ decision: value.trim() ? { text: value, flags } : null });
  };
  const setFlag = (flag: DecisionFlag, value: boolean) => {
    consumeSeed();
    updateAnswers({
      decision: text.trim() ? { text, flags: { ...flags, [flag]: value } } : null,
    });
  };
  return (
    <div>
      <div className="council-journey-field">
        <label htmlFor="intake-decision">Your decision</label>
        <textarea
          id="intake-decision"
          className="council-journey-textarea"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="For example: Should we pilot the revised offer before a broad launch?"
        />
      </div>
      <fieldset className="council-journey-field">
        <legend className="council-journey-legend">Does this decision involve any of these?</legend>
        {(Object.keys(DECISION_FLAG_LABELS) as DecisionFlag[]).map((flag) => (
          <label key={flag} className="council-journey-check">
            <input
              type="checkbox"
              checked={flags[flag]}
              onChange={(event) => setFlag(flag, event.target.checked)}
            />
            <span>{DECISION_FLAG_LABELS[flag]}</span>
          </label>
        ))}
      </fieldset>
    </div>
  );
}

function OptionsStep({
  draft,
  updateAnswers,
}: {
  draft: JourneyDraft;
  updateAnswers: AnswersPatch;
}) {
  const [rows, setRows] = useState<string[]>(() =>
    draft.answers.options && draft.answers.options.length > 0
      ? [...draft.answers.options]
      : ['', ''],
  );
  const commit = (next: string[]) => {
    setRows(next);
    const cleaned = next.map((v) => v.trim()).filter(Boolean);
    updateAnswers({ options: cleaned.length >= 2 ? cleaned : null });
  };
  return (
    <div data-testid="options-editor">
      {rows.map((value, index) => (
        <div className="council-journey-field" key={index}>
          <label htmlFor={`intake-option-${index}`}>Option {String.fromCharCode(65 + index)}</label>
          <input
            id={`intake-option-${index}`}
            className="council-journey-input"
            value={value}
            onChange={(event) => {
              const next = [...rows];
              next[index] = event.target.value;
              commit(next);
            }}
          />
        </div>
      ))}
      <button
        type="button"
        className={council.btnSecondary}
        onClick={() => commit([...rows, ''])}
        disabled={rows.length >= 5}
      >
        Add an option
      </button>
      <p className={council.meta}>Name at least two options to continue.</p>
    </div>
  );
}

function SuccessStep({
  draft,
  updateAnswers,
}: {
  draft: JourneyDraft;
  updateAnswers: AnswersPatch;
}) {
  const current = draft.answers.success;
  const isUnknown = current !== null && 'explicitUnknown' in current;
  const text = current !== null && 'text' in current ? current.text : '';
  return (
    <div>
      <div className="council-journey-field">
        <label htmlFor="intake-success">What success looks like</label>
        <textarea
          id="intake-success"
          className="council-journey-textarea"
          value={text}
          disabled={isUnknown}
          onChange={(event) =>
            updateAnswers({
              success: event.target.value.trim() ? { text: event.target.value } : null,
            })
          }
        />
      </div>
      <button
        type="button"
        className={councilcx(council.btn, council.btnSecondary)}
        aria-pressed={isUnknown}
        data-testid="explicit-unknown-success"
        onClick={() =>
          updateAnswers({ success: isUnknown ? null : { explicitUnknown: true } })
        }
      >
        {isUnknown ? 'Known: undo "I don’t know yet"' : 'I don’t know yet'}
      </button>
      {isUnknown ? (
        <p className={council.meta}>
          Recorded as an explicit unknown. It will appear in the brief under Explicit unknowns.
        </p>
      ) : null}
    </div>
  );
}

function ConstraintsStep({
  draft,
  updateAnswers,
}: {
  draft: JourneyDraft;
  updateAnswers: AnswersPatch;
}) {
  const [rows, setRows] = useState<IntakeConstraint[]>(() =>
    draft.answers.constraints ? [...draft.answers.constraints] : [],
  );
  const unknown = draft.answers.constraintsExplicitUnknown;
  const commit = (next: IntakeConstraint[]) => {
    setRows(next);
    updateAnswers({ constraints: next.some((r) => r.text.trim()) ? next : null });
  };
  return (
    <div data-testid="constraints-editor">
      {rows.map((row, index) => (
        <div className="council-journey-row" key={row.id}>
          <input
            className="council-journey-input"
            style={{ flex: '1 1 12rem' }}
            aria-label={`Limit ${index + 1}`}
            value={row.text}
            disabled={unknown}
            onChange={(event) => {
              const next = [...rows];
              next[index] = { ...row, text: event.target.value };
              commit(next);
            }}
          />
          <select
            className="council-journey-select"
            style={{ flex: '0 1 12rem' }}
            aria-label={`Limit ${index + 1} kind`}
            value={row.kind}
            disabled={unknown}
            onChange={(event) => {
              const next = [...rows];
              next[index] = { ...row, kind: event.target.value as ConstraintKind };
              commit(next);
            }}
          >
            {CONSTRAINT_KINDS.map((kind) => (
              <option key={kind.id} value={kind.id}>
                {kind.label}
              </option>
            ))}
          </select>
        </div>
      ))}
      <div className="council-journey-row" style={{ marginTop: '0.5rem' }}>
        <button
          type="button"
          className={council.btnSecondary}
          disabled={unknown}
          onClick={() =>
            commit([...rows, { id: `con-${rows.length + 1}`, text: '', kind: 'other' }])
          }
        >
          Add a limit
        </button>
        <button
          type="button"
          className={council.btnSecondary}
          aria-pressed={unknown}
          data-testid="explicit-unknown-constraints"
          onClick={() =>
            updateAnswers({
              constraintsExplicitUnknown: !unknown,
              constraints: unknown ? draft.answers.constraints : null,
            })
          }
        >
          {unknown ? 'Undo "I don’t know yet"' : 'I don’t know the limits yet'}
        </button>
      </div>
      {unknown ? (
        <p className={council.meta}>
          Recorded as an explicit unknown and composed into the brief under Explicit unknowns.
        </p>
      ) : null}
    </div>
  );
}

function FactsStep({
  draft,
  updateAnswers,
}: {
  draft: JourneyDraft;
  updateAnswers: AnswersPatch;
}) {
  const [clientFacts, setClientFacts] = useState<IntakeFact[]>(() =>
    draft.answers.facts ? [...draft.answers.facts.clientFacts] : [],
  );
  const unknown = draft.answers.factsExplicitUnknown;
  const commit = (next: IntakeFact[]) => {
    setClientFacts(next);
    updateAnswers({
      facts: next.some((f) => f.statement.trim()) ? { clientFacts: next } : null,
    });
  };
  return (
    <div data-testid="facts-step">
      {draft.knownFacts.length > 0 ? (
        <div className="council-journey-notice" data-testid="prefilled-facts">
          <h3 className={council.heading} style={{ marginTop: 0 }}>
            Already known
          </h3>
          <p className={council.meta}>
            These confirmed facts were supplied with authorization before the questions began.
            They are part of your brief and are not asked again.
          </p>
          <ul>
            {draft.knownFacts.map((fact) => (
              <li key={fact.id} data-testid={`prefilled-fact-${fact.id}`}>
                {fact.statement}
                <span className="council-journey-source">Source: {fact.source}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div style={{ marginTop: '1rem' }}>
        {clientFacts.map((fact, index) => (
          <div className="council-journey-field" key={fact.id}>
            <label htmlFor={`intake-fact-${fact.id}`}>Fact {index + 1}</label>
            <input
              id={`intake-fact-${fact.id}`}
              className="council-journey-input"
              value={fact.statement}
              disabled={unknown}
              onChange={(event) => {
                const next = [...clientFacts];
                next[index] = { ...fact, statement: event.target.value };
                commit(next);
              }}
            />
          </div>
        ))}
        <div className="council-journey-row">
          <button
            type="button"
            className={council.btnSecondary}
            disabled={unknown}
            onClick={() =>
              commit([
                ...clientFacts,
                {
                  id: `client-fact-${clientFacts.length + 1}`,
                  statement: '',
                  source: 'Stated by you in this intake',
                  origin: 'client',
                },
              ])
            }
          >
            Add a fact
          </button>
          {draft.knownFacts.length === 0 ? (
            <button
              type="button"
              className={council.btnSecondary}
              aria-pressed={unknown}
              data-testid="explicit-unknown-facts"
              onClick={() =>
                updateAnswers({ factsExplicitUnknown: !unknown, facts: null })
              }
            >
              {unknown ? 'Undo "I don’t know yet"' : 'I don’t know any facts yet'}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ListStep({
  label,
  values,
  emptyAnswerLabel,
  onChange,
  testId,
}: {
  label: string;
  values: string[] | null;
  emptyAnswerLabel?: string;
  onChange: (values: string[] | null) => void;
  testId: string;
}) {
  const [rows, setRows] = useState<string[]>(() => (values ? [...values] : []));
  const [emptyChosen, setEmptyChosen] = useState<boolean>(
    () => values !== null && values.length === 0,
  );
  const commit = (next: string[]) => {
    setRows(next);
    const cleaned = next.map((v) => v.trim()).filter(Boolean);
    onChange(cleaned.length > 0 ? cleaned : emptyChosen ? [] : null);
  };
  return (
    <div data-testid={testId}>
      {rows.map((value, index) => (
        <div className="council-journey-field" key={index}>
          <label htmlFor={`${testId}-${index}`}>
            {label} {index + 1}
          </label>
          <input
            id={`${testId}-${index}`}
            className="council-journey-input"
            value={value}
            onChange={(event) => {
              const next = [...rows];
              next[index] = event.target.value;
              commit(next);
            }}
          />
        </div>
      ))}
      <div className="council-journey-row">
        <button
          type="button"
          className={council.btnSecondary}
          onClick={() => commit([...rows, ''])}
        >
          Add
        </button>
        {emptyAnswerLabel && !emptyChosen ? (
          <button
            type="button"
            className={council.btnSecondary}
            data-testid={`${testId}-empty-answer`}
            onClick={() => {
              setEmptyChosen(true);
              onChange([]);
            }}
          >
            {emptyAnswerLabel}
          </button>
        ) : null}
        {emptyChosen ? (
          <span className={council.meta}>Recorded: {emptyAnswerLabel}.</span>
        ) : null}
      </div>
    </div>
  );
}


function PanelStep({
  draft,
  update,
  assessment,
  requirements,
}: {
  draft: JourneyDraft;
  update: (patch: Partial<JourneyDraft>) => void;
  assessment: ReturnType<typeof assessJourneyPanel>;
  requirements: ReturnType<typeof classifyJourneyDomains>;
}) {
  const mode = draft.mode;
  const selected = draft.panelSeatIds ?? [];
  const sizeProblem = mode ? panelSizeProblem(mode, selected.length) : null;
  const professionalTriggered = requirements.some(
    (r) => r.domain === 'qualified_professional_review',
  );

  const chooseMode = (nextMode: JourneyDraft['mode']) => {
    if (nextMode === 'full') {
      update({ mode: nextMode, panelSeatIds: COUNCIL_SEAT_ROSTER.map((s) => s.seatId) });
    } else if (nextMode === 'quick') {
      update({ mode: nextMode, panelSeatIds: recommendQuickPanel(draft) });
    } else if (nextMode === 'consult') {
      update({ mode: nextMode, panelSeatIds: selected.length === 1 ? selected : ['simon-sinek'] });
    } else {
      update({ mode: nextMode, panelSeatIds: selected });
    }
  };

  const toggleSeat = (seatId: CouncilSeatId) => {
    if (mode === 'consult') {
      update({ panelSeatIds: [seatId] });
      return;
    }
    const next = selected.includes(seatId)
      ? selected.filter((s) => s !== seatId)
      : [...selected, seatId];
    update({ panelSeatIds: next });
  };

  return (
    <div data-testid="panel-step">
      <fieldset className="council-journey-field">
        <legend className="council-journey-legend">Council mode</legend>
        {MODE_OPTIONS.map((option) => (
          <label key={option.id ?? 'none'} className="council-journey-check">
            <input
              type="radio"
              name="council-mode"
              checked={mode === option.id}
              onChange={() => chooseMode(option.id)}
            />
            <span>
              <strong>{option.label}.</strong>{' '}
              <span className={council.meta}>{option.note}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {mode === 'quick' ? (
        <div className="council-journey-notice" data-testid="quick-mode-policy">
          <h3 className={council.heading} style={{ marginTop: 0 }}>
            Quick mode skips Round 3 ratification
          </h3>
          <p className={council.meta}>
            When Round 3 is skipped, the ratification status is recorded as{' '}
            <strong>{QUICK_MODE_RATIFICATION_WHEN_SKIPPED}</strong>. Five prerequisites are
            recorded now with status pending_run and evaluated by CWE-025 against the run’s
            actual cards:
          </p>
          <ol>
            {QUICK_MODE_PREREQUISITES.map((prerequisite) => (
              <li key={prerequisite.id}>
                {prerequisite.text}{' '}
                <span className={council.meta}>(status: {prerequisite.status})</span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {mode ? (
        <fieldset className="council-journey-field" style={{ marginTop: '1rem' }}>
          <legend className="council-journey-legend">
            Panel seats {mode === 'full' ? '(full council: all nine)' : ''}
          </legend>
          <div className="council-journey-grid">
            {COUNCIL_SEAT_ROSTER.map((seat) => {
              const checked = selected.includes(seat.seatId);
              return (
                <label key={seat.seatId} className="council-journey-seat-option">
                  <input
                    type={mode === 'consult' ? 'radio' : 'checkbox'}
                    name="council-panel"
                    checked={checked}
                    disabled={mode === 'full'}
                    onChange={() => toggleSeat(seat.seatId)}
                    aria-label={seat.displayName}
                  />
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={COUNCIL_MEDALLION_SMALL_SRC[seat.seatId]} alt="" />
                  <span>
                    <strong>{seat.displayName}</strong>
                    <br />
                    <span className={council.meta}>{seat.responsibility}</span>
                    <br />
                    <span className={council.meta}>{seat.profileLabel}</span>
                  </span>
                </label>
              );
            })}
          </div>
          {sizeProblem ? (
            <p className={council.meta} data-testid="panel-size-problem">
              {sizeProblem} Selected: {selected.length}.
            </p>
          ) : null}
        </fieldset>
      ) : null}

      {professionalTriggered ? (
        <fieldset className="council-journey-field">
          <legend className="council-journey-legend">Qualified professional review</legend>
          <p className={council.meta}>
            This decision touches a professional domain. No council seat substitutes for a
            qualified professional.
          </p>
          <label className="council-journey-check">
            <input
              type="radio"
              name="professional-review"
              checked={draft.professionalReviewArranged === true}
              onChange={() => update({ professionalReviewArranged: true })}
            />
            <span>I have arranged review by a qualified professional.</span>
          </label>
          <label className="council-journey-check">
            <input
              type="radio"
              name="professional-review"
              checked={draft.professionalReviewArranged === false}
              onChange={() => update({ professionalReviewArranged: false })}
            />
            <span>Not arranged yet.</span>
          </label>
        </fieldset>
      ) : null}

      <div style={{ marginTop: '1rem' }} data-testid="panel-assessment">
        <h3 className={council.heading}>Required responsibilities, before you start</h3>
        {assessment.responsibilities.length === 0 ? (
          <p className={council.meta}>
            No critical responsibilities were triggered by the material so far.
          </p>
        ) : (
          <ul>
            {assessment.responsibilities.map((responsibility) => (
              <li key={responsibility.domain}>
                <strong>
                  {responsibility.domain.replace(/_/g, ' ')}:
                </strong>{' '}
                {responsibility.requiredChecker === 'qualified_professional'
                  ? 'a qualified professional must review (no seat substitutes)'
                  : `${seatDisplayName(responsibility.requiredSeatId ?? '')} is responsible`}{' '}
                · status:{' '}
                <span data-testid={`responsibility-status-${responsibility.domain}`}>
                  {responsibility.status}
                </span>
                <br />
                <span className={council.meta}>{responsibility.reviewerNote}</span>
              </li>
            ))}
          </ul>
        )}
        {assessment.blocksGoStyleEndorsement ? (
          <div
            className="council-journey-notice council-journey-notice-warn"
            role="alert"
            data-testid="not-assessed-consequence"
          >
            <strong>Before you start:</strong> the{' '}
            {assessment.missingDomains.map((d) => d.replace(/_/g, ' ')).join(', ')}{' '}
            {assessment.missingDomains.length === 1 ? 'domain stays' : 'domains stay'}{' '}
            not_assessed with this panel. In scored modes the council cannot give a GO-style
            endorsement while a critical domain is not_assessed, no matter how the other
            seats score the options.
          </div>
        ) : null}
        {assessment.recommendations.map((recommendation) => (
          <div
            key={recommendation.domain}
            className="council-journey-notice"
            data-testid={`panel-recommendation-${recommendation.domain}`}
            style={{ marginTop: '0.5rem' }}
          >
            <p style={{ margin: 0 }}>{recommendation.message}</p>
            {mode === 'selected' ? (
              <button
                type="button"
                className={council.btnSecondary}
                style={{ marginTop: '0.5rem' }}
                onClick={() =>
                  update({
                    panelSeatIds: [...selected, recommendation.seatId],
                  })
                }
              >
                Add {seatDisplayName(recommendation.seatId)}
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function ReviewStep({
  draft,
  routes,
  submitting,
  submitError,
  onBack,
  onFreeze,
}: {
  draft: JourneyDraft;
  routes: RouteCatalogEntry[];
  submitting: boolean;
  submitError: string | null;
  onBack: () => void;
  onFreeze: () => void;
}) {
  const preview = useMemo(() => previewBriefFromDraft(draft), [draft]);
  const composed = useMemo(() => {
    const choice = draft.routeChoice;
    const entry =
      choice?.kind === 'explicit'
        ? (routes.find((r) => r.routeId === choice.routeId) ?? null)
        : null;
    return composeSessionInput(
      draft,
      entry ? { routeId: entry.routeId, modelId: entry.modelId } : null,
    );
  }, [draft, routes]);
  const missing = missingMaterialQuestions(draft);
  const manifestHash = composed.ok ? composed.evidenceManifestHash : null;

  return (
    <section data-testid="intake-review">
      <h2 className={council.heading}>Review the brief</h2>
      <p className={council.meta}>
        This is the exact brief the council will receive. Check that facts are facts,
        assumptions are labeled as assumptions, and unknowns are stated plainly.
      </p>
      <RouteSnapshot choice={draft.routeChoice} routes={routes} />
      <div style={{ marginTop: '1rem' }}>
        <BriefReview brief={preview} />
      </div>

      <div
        className="council-journey-notice"
        data-testid="freeze-explanation"
        style={{ marginTop: '1rem' }}
      >
        <h3 className={council.heading} style={{ marginTop: 0 }}>
          What freezing means
        </h3>
        <p>
          Freezing locks this brief as revision 1. The evidence manifest hash for this brief
          is{' '}
          {manifestHash ? (
            <span className="council-journey-hash" data-testid="evidence-manifest-hash">
              {manifestHash}
            </span>
          ) : (
            'shown once the brief can be composed'
          )}
          . After freezing, the revision cannot be edited in place: later facts are recorded
          as amendments against the frozen revision, and any change composes a new revision.
          Freezing does not start the council run; starting is a separate action on the
          session page, and it needs its own authorization.
        </p>
        {missing.length > 0 ? (
          <p className={council.meta}>
            Still missing: {missing.join(', ')}. Go back to finish those questions.
          </p>
        ) : null}
        {!composed.ok ? (
          <p className={council.meta} data-testid="freeze-blocked-reason">
            {composed.reason}
          </p>
        ) : null}
        {submitError ? (
          <div className="council-journey-notice council-journey-notice-error" role="alert">
            {submitError}
          </div>
        ) : null}
        <div className="council-journey-row">
          <button type="button" className={council.btnSecondary} onClick={onBack}>
            Back
          </button>
          <button
            type="button"
            className={council.btnPrimary}
            onClick={onFreeze}
            disabled={submitting || !composed.ok}
            data-testid="freeze-brief"
          >
            {submitting ? 'Freezing…' : 'Freeze brief and create session'}
          </button>
        </div>
      </div>
    </section>
  );
}
