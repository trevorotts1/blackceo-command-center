'use client';

/**
 * CouncilFollowUp (CWE-034, Skill 77) - the one-seat follow-up.
 *
 * A follow-up asks ONE seat a follow-up question and, through the
 * follow-up contract, creates a NEW linked consult record (T104).
 * It can never retroactively rewrite the parent session's
 * recommendation: this component holds no handle on the verdict
 * rendering at all, and its only write is the follow-up request.
 *
 * The follow-up coordination service is owned by CWE-050 and is not
 * wired in this build. The endpoint's typed FEATURE_NOT_READY answer
 * renders as an explicit not-ready state; a consult is never
 * simulated, and no success is claimed that the service did not
 * return.
 */

import { useState } from 'react';
import { council, councilcx } from './council-theme';
import {
  CouncilApiClientError,
  type CouncilFollowUpRequest,
} from './council-session-client';
import { COUNCIL_SEAT_ROSTER } from './council-room-types';

type FollowUpState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'created'; note: string }
  | { kind: 'not_ready'; message: string }
  | { kind: 'failed'; message: string };

export interface CouncilFollowUpProps {
  sessionId: string;
  postFollowUp: (
    sessionId: string,
    body: CouncilFollowUpRequest,
    idempotencyKey: string,
  ) => Promise<Record<string, unknown>>;
  makeIdempotencyKey?: () => string;
}

export function CouncilFollowUp({
  sessionId,
  postFollowUp,
  makeIdempotencyKey,
}: CouncilFollowUpProps) {
  const [seatId, setSeatId] = useState<string>(COUNCIL_SEAT_ROSTER[0].seatId);
  const [question, setQuestion] = useState('');
  const [state, setState] = useState<FollowUpState>({ kind: 'idle' });

  const submit = async () => {
    if (question.trim().length === 0) {
      setState({
        kind: 'failed',
        message: 'Write the follow-up question first. Nothing was sent.',
      });
      return;
    }
    setState({ kind: 'submitting' });
    const key =
      makeIdempotencyKey?.() ??
      `council-follow-up-${sessionId}-${seatId}-${Date.now()}`;
    try {
      const record = await postFollowUp(
        sessionId,
        { seat_id: seatId, question: question.trim() },
        key,
      );
      const consultId =
        typeof record.consult_session_id === 'string'
          ? record.consult_session_id
          : typeof record.session_id === 'string' && record.session_id !== sessionId
            ? record.session_id
            : null;
      setState({
        kind: 'created',
        note: consultId
          ? `A linked consultation was created: ${consultId}. It is a separate record; the verdict above is unchanged.`
          : 'The follow-up was recorded as a separate linked consultation. The verdict above is unchanged.',
      });
    } catch (error) {
      if (error instanceof CouncilApiClientError && error.isFeatureNotReady) {
        setState({ kind: 'not_ready', message: error.message });
      } else {
        setState({
          kind: 'failed',
          message:
            error instanceof Error ? error.message : 'The follow-up request failed.',
        });
      }
    }
  };

  return (
    <section data-testid="council-follow-up" aria-label="Follow up with one seat">
      <h3 className={council.heading}>Follow up with one seat</h3>
      <p className={council.meta}>
        A follow-up creates a new linked consultation with the seat you
        choose. It never edits or reopens this session's verdict.
      </p>
      <label>
        Seat{' '}
        <select
          value={seatId}
          onChange={(event) => setSeatId(event.target.value)}
          data-testid="follow-up-seat"
        >
          {COUNCIL_SEAT_ROSTER.map((seat) => (
            <option key={seat.seatId} value={seat.seatId}>
              {seat.displayName}
            </option>
          ))}
        </select>
      </label>{' '}
      <label>
        Your question{' '}
        <textarea
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          data-testid="follow-up-question"
          rows={3}
          cols={48}
        />
      </label>{' '}
      <button
        type="button"
        className={councilcx(council.btn, council.btnSecondary)}
        data-testid="follow-up-submit"
        disabled={state.kind === 'submitting'}
        onClick={() => void submit()}
      >
        Ask this seat
      </button>
      {state.kind === 'created' ? (
        <p data-testid="follow-up-created" role="status">
          {state.note}
        </p>
      ) : null}
      {state.kind === 'not_ready' ? (
        <p data-testid="follow-up-not-ready" role="status">
          Follow-up consultations are not available yet: the coordination
          service that creates them is owned by CWE-050 and is not wired in
          this build. No consultation was created, and the verdict above is
          unchanged.
        </p>
      ) : null}
      {state.kind === 'failed' ? (
        <p data-testid="follow-up-failed" role="alert">
          {state.message}
        </p>
      ) : null}
    </section>
  );
}
