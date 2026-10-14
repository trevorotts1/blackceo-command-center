'use client';

/**
 * Council advisors page (CWE-034, Skill 77): /council/advisors
 *
 * The nine seats from the CWE-029 advisors read, each with its
 * Section 7 profile label verbatim and its recorded source
 * qualification. Every pack in this build stands at
 * bibliographic_only; the page renders that per seat rather than
 * presenting any seat as source-verified.
 */

import { useEffect, useMemo, useState } from 'react';
import { council } from '../../../components/council/council-theme';
import '../../../components/council/council-theme.css';
import '../../../components/council/council-room.css';
import {
  CouncilAdvisors,
  type CouncilAdvisorSeatView,
} from '../../../components/council/CouncilAdvisors';
import { CouncilApiClient } from '../../../components/council/council-session-client';

export default function CouncilAdvisorsPage() {
  const client = useMemo(() => new CouncilApiClient(), []);
  const [seats, setSeats] = useState<CouncilAdvisorSeatView[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    client
      .getAdvisors()
      .then((data) => {
        if (cancelled) return;
        setSeats(data.seats);
        setLoadState('ready');
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadState('error');
        setErrorMessage(
          error instanceof Error ? error.message : 'The advisor roster could not be loaded.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  return (
    <main className={council.theme}>
      <h1 className={council.heading}>Council of Wise Elders: the advisors</h1>
      <CouncilAdvisors seats={seats} loadState={loadState} errorMessage={errorMessage} />
    </main>
  );
}
