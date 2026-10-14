'use client';

/**
 * CouncilOutcomeForm (CWE-034, Skill 77) - outcome entry (T107).
 *
 * Outcome entry records what actually happened SEPARATELY from what
 * the council predicted. The prediction side of this form is the
 * committed verdict, shown read-only with its recorded content and
 * brief hashes: that is the preserved original evidence snapshot,
 * and this form never edits it. The actual side is a separate field
 * the owner fills in.
 *
 * The outcomes coordination service is owned by CWE-050 and is not
 * wired in this build; its typed FEATURE_NOT_READY answer renders as
 * an explicit not-ready state. No outcome is simulated as saved.
 */

import { useState } from 'react';
import { council, councilcx } from './council-theme';
import {
  CouncilApiClientError,
  type CouncilOutcomeRequest,
} from './council-session-client';

export interface CouncilOutcomePrediction {
  recommendationText: string;
  verdictRevision: number;
  verdictContentSha256: string;
  briefSha256: string;
}

type OutcomeState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'recorded'; note: string }
  | { kind: 'not_ready'; message: string }
  | { kind: 'failed'; message: string };

export interface CouncilOutcomeFormProps {
  sessionId: string;
  /** The preserved prediction snapshot, or null when no valid verdict exists. */
  prediction: CouncilOutcomePrediction | null;
  postOutcome: (
    sessionId: string,
    body: CouncilOutcomeRequest,
    idempotencyKey: string,
  ) => Promise<Record<string, unknown>>;
  makeIdempotencyKey?: () => string;
}

export function CouncilOutcomeForm({
  sessionId,
  prediction,
  postOutcome,
  makeIdempotencyKey,
}: CouncilOutcomeFormProps) {
  const [observed, setObserved] = useState('');
  const [observedAt, setObservedAt] = useState('');
  const [state, setState] = useState<OutcomeState>({ kind: 'idle' });

  if (!prediction) {
    return (
      <section data-testid="council-outcome" aria-label="Record the outcome">
        <h3 className={council.heading}>Record the outcome</h3>
        <p data-testid="outcome-no-prediction">
          No validated verdict is recorded for this session, so there is no
          prediction to record an outcome against. An outcome is never
          recorded against a verdict that does not exist.
        </p>
      </section>
    );
  }

  const submit = async () => {
    if (observed.trim().length === 0 || observedAt.trim().length === 0) {
      setState({
        kind: 'failed',
        message:
          'Describe what actually happened and when it was observed. Nothing was sent.',
      });
      return;
    }
    setState({ kind: 'submitting' });
    const key = makeIdempotencyKey?.() ?? `council-outcome-${sessionId}-${Date.now()}`;
    try {
      await postOutcome(
        sessionId,
        {
          observed_outcome: observed.trim(),
          observed_at: observedAt.trim(),
          verdict_revision: prediction.verdictRevision,
          verdict_content_sha256: prediction.verdictContentSha256,
        },
        key,
      );
      setState({
        kind: 'recorded',
        note: 'The outcome was recorded against the preserved prediction snapshot. The verdict itself is unchanged.',
      });
    } catch (error) {
      if (error instanceof CouncilApiClientError && error.isFeatureNotReady) {
        setState({ kind: 'not_ready', message: error.message });
      } else {
        setState({
          kind: 'failed',
          message:
            error instanceof Error ? error.message : 'The outcome request failed.',
        });
      }
    }
  };

  return (
    <section data-testid="council-outcome" aria-label="Record the outcome">
      <h3 className={council.heading}>Record the outcome</h3>
      <div data-testid="outcome-predicted">
        <h4 className={council.heading}>What the council predicted (preserved)</h4>
        <p>{prediction.recommendationText}</p>
        <p className={council.meta}>
          Verdict revision {prediction.verdictRevision}. Verdict content hash{' '}
          {prediction.verdictContentSha256}. Brief hash {prediction.briefSha256}.
          This snapshot is the original evidence record and is never edited by
          outcome entry.
        </p>
      </div>
      <div data-testid="outcome-actual">
        <h4 className={council.heading}>What actually happened</h4>
        <label>
          Observed outcome{' '}
          <textarea
            value={observed}
            onChange={(event) => setObserved(event.target.value)}
            data-testid="outcome-observed"
            rows={3}
            cols={48}
          />
        </label>{' '}
        <label>
          Observed on{' '}
          <input
            type="date"
            value={observedAt}
            onChange={(event) => setObservedAt(event.target.value)}
            data-testid="outcome-observed-at"
          />
        </label>{' '}
        <button
          type="button"
          className={councilcx(council.btn, council.btnSecondary)}
          data-testid="outcome-submit"
          disabled={state.kind === 'submitting'}
          onClick={() => void submit()}
        >
          Record outcome
        </button>
      </div>
      {state.kind === 'recorded' ? (
        <p data-testid="outcome-recorded" role="status">
          {state.note}
        </p>
      ) : null}
      {state.kind === 'not_ready' ? (
        <p data-testid="outcome-not-ready" role="status">
          Outcome recording is not available yet: the outcomes coordination
          service is owned by CWE-050 and is not wired in this build. Nothing
          was saved, and the prediction snapshot above is untouched.
        </p>
      ) : null}
      {state.kind === 'failed' ? (
        <p data-testid="outcome-failed" role="alert">
          {state.message}
        </p>
      ) : null}
    </section>
  );
}
