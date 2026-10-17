'use client';

/**
 * WER-016: actual mounted Council Start control for /council/[sessionId].
 * Does not create grants, spend provider tokens, fake progress or bypass
 * support read-only access. Only the authentic CWE-027 QUEUED run receipt
 * from the existing authorized server route confirms admission.
 */
import { useRef, useState } from 'react';
import {
  featureNotReadyState,
  isCouncilClientError,
  newIdempotencyKey,
  startSession,
  type CouncilStartReceipt,
} from '@/lib/council/journey-client';
import type { CouncilStoredSession } from '@/lib/council/store';
import { council } from './council-theme';

export function CouncilRunStartPanel({
  sessionId,
  session,
  accessVia,
  onQueued,
}: {
  sessionId: string;
  session: CouncilStoredSession;
  accessVia: string | null;
  onQueued: (receipt: CouncilStartReceipt) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [receipt, setReceipt] = useState<CouncilStartReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notReady, setNotReady] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const idempotencyRef = useRef<string | null>(null);
  const state = session.state.state;
  const permitted = accessVia !== 'support'
    && !receipt && (state === 'DRAFT' || state === 'READY');

  const handleStart = async () => {
    if (!permitted || pendingRef.current) return;
    pendingRef.current = true;
    setLoading(true);
    setError(null);
    setNotReady(null);
    if (!idempotencyRef.current) {
      idempotencyRef.current = newIdempotencyKey();
    }
    try {
      const actual = await startSession(sessionId, idempotencyRef.current, {
        expectedVersion: session.state.state_version,
      });
      setReceipt(actual);
      onQueued(actual);
    } catch (cause) {
      const missingFeature = featureNotReadyState(cause, 'council.sessions.start');
      if (missingFeature) {
        setNotReady(missingFeature.message);
      } else {
        setError(isCouncilClientError(cause)
          ? cause.code + ': ' + cause.message
          : 'The Start request could not be verified. No new job is being claimed. Retry safely or reload this session.');
      }
    } finally {
      pendingRef.current = false;
      setLoading(false);
    }
  };

  return (
    <section className="council-journey-kind" data-testid="mounted-council-start-panel"
      aria-label="Council run controls">
      <h2 className={council.heading}>Run the Council</h2>
      <p className={council.meta}>
        Starting requires a valid Council-run grant. A saved brief or an
        advisory vote is not a payment authorization.
      </p>
      {permitted ? (
        <button type="button" className={council.btnPrimary}
          data-testid="mounted-council-start"
          disabled={loading} onClick={() => void handleStart()}>
          {loading ? 'Contacting Council service…' : 'Start council run'}
        </button>
      ) : (
        <p className={council.meta} data-testid="mounted-council-start-blocked">
          {accessVia === 'support'
            ? 'Read-only support access cannot start this Council.'
            : receipt
              ? 'The Council run was queued; a second Start is not permitted.'
              : state === 'QUEUED'
                ? 'A Council run is already queued.'
                : 'This session is not in a startable Draft or Ready state.'}
        </p>
      )}
      {receipt ? (
        <p data-testid="mounted-council-start-receipt" role="status">
          Council run queued. Job {receipt.job_id}; attempt {receipt.attempt}.
          {receipt.idempotent_replay ? ' Existing queued operation reused.' : ''}
          This receipt does not mean the advisors have finished.
        </p>
      ) : null}
      {notReady ? (
        <p role="status" data-testid="mounted-council-start-not-ready">
          Council Start is not available: {notReady} No new job is being claimed.
        </p>
      ) : null}
      {error ? <p role="alert" data-testid="mounted-council-start-error">{error}</p> : null}
    </section>
  );
}
