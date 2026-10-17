'use client';

/**
 * ConsultPanel (CWE-033, Skill 77)
 *
 * The linked-consult entry (Section 20): from a session, ask ONE
 * advisor or a department ONE bounded question. Creating a consult is
 * a distinct act from reading an objection: this panel creates; the
 * verdict's strongest-concern section is where an objection is read,
 * and the panel says so with a link. Submission calls the registered
 * follow-up endpoint through the typed bindings; until CWE-050 wires
 * follow-up coordination the foundation answers FEATURE_NOT_READY,
 * and the panel renders that typed readiness state with its owning
 * unit. No consult is ever shown as created from a failed call.
 */

import { useState } from 'react';
import {
  createFollowUp,
  featureNotReadyState,
  isCouncilClientError,
  newIdempotencyKey,
  type FeatureNotReadyState,
} from '@/lib/council/journey-client';
import { council } from './council-theme';
import { COUNCIL_SEAT_ROSTER } from './council-room-types';

export function ConsultPanel({ sessionId }: { sessionId: string }) {
  const [target, setTarget] = useState<string>('simon-sinek');
  const [departmentId, setDepartmentId] = useState('');
  const [question, setQuestion] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [notReady, setNotReady] = useState<FeatureNotReadyState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setSubmitting(true);
    setNotReady(null);
    setError(null);
    try {
      const parsed =
        target === 'department'
          ? ({ kind: 'department', departmentId: departmentId.trim() } as const)
          : ({ kind: 'advisor', seatId: target } as const);
      await createFollowUp(sessionId, question.trim(), parsed, newIdempotencyKey());
    } catch (caught) {
      const state = featureNotReadyState(caught, 'council.sessions.follow_up');
      if (state) {
        setNotReady(state);
      } else {
        setError(
          isCouncilClientError(caught)
            ? `${caught.code}: ${caught.message}`
            : 'The consult could not be created.',
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="council-journey-kind" data-testid="consult-panel">
      <h3 className={council.heading} style={{ marginTop: 0 }}>
        Ask a bounded question
      </h3>
      <p className={council.meta}>
        A consult asks one advisor, or a department, one bounded question linked to this
        session. Creating a consult is a new act with its own record. It is different from
        reading an objection: the council’s strongest concern is on the verdict above, under
        “Strongest concern”.
      </p>
      <div className="council-journey-field">
        <label htmlFor="consult-target">Ask</label>
        <select
          id="consult-target"
          className="council-journey-select"
          value={target}
          onChange={(event) => setTarget(event.target.value)}
        >
          {COUNCIL_SEAT_ROSTER.map((seat) => (
            <option key={seat.seatId} value={seat.seatId}>
              {seat.displayName} (one advisor)
            </option>
          ))}
          <option value="department">A department</option>
        </select>
      </div>
      {target === 'department' ? (
        <div className="council-journey-field">
          <label htmlFor="consult-department">Department</label>
          <input
            id="consult-department"
            className="council-journey-input"
            value={departmentId}
            onChange={(event) => setDepartmentId(event.target.value)}
            placeholder="The department to ask, by name"
          />
        </div>
      ) : null}
      <div className="council-journey-field">
        <label htmlFor="consult-question">Your bounded question</label>
        <textarea
          id="consult-question"
          className="council-journey-textarea"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="One question, with the bounds that matter (by when, within what limit)."
        />
      </div>
      <button
        type="button"
        className={council.btnPrimary}
        onClick={submit}
        disabled={
          submitting ||
          question.trim().length === 0 ||
          (target === 'department' && departmentId.trim().length === 0)
        }
        data-testid="consult-submit"
      >
        {submitting ? 'Asking…' : 'Create consult'}
      </button>
      {notReady ? (
        <div
          className="council-journey-notice"
          data-testid="consult-not-ready"
          style={{ marginTop: '1rem' }}
        >
          <p style={{ margin: 0 }}>
            <strong>Not ready yet.</strong> {notReady.surface} is registered but not wired.
          </p>
          <p className={council.meta} style={{ margin: '0.25rem 0 0' }}>
            {notReady.message} Owning unit: {notReady.owningUnit}. No consult was created.
          </p>
        </div>
      ) : null}
      {error ? (
        <div className="council-journey-notice council-journey-notice-error" role="alert">
          {error}
        </div>
      ) : null}
    </section>
  );
}
