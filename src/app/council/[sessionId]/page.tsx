'use client';

/**
 * Council session page (CWE-034, Skill 77): /council/[sessionId]
 *
 * Composes the CWE-034 screens for one session inside the CWE-031
 * scoped theme: the live room (CWE-032 shell over the CWE-030
 * reducer and the real events contract), the verdict screen
 * (Section 21 order), the one-seat follow-up, and outcome entry.
 * With ?replay=1 the room reads the committed record as a labeled
 * replay instead of opening the live stream (T101).
 *
 * Data comes only from the CWE-029 safe reads (session detail,
 * verdict read) and the CWE-030 events surface. Follow-up and
 * outcome mutations post to their registered contracts; both
 * services land at CWE-050, so their typed FEATURE_NOT_READY state
 * is what this page honestly renders today. Card-level reads are
 * likewise bound at CWE-050 assembly: until then the verdict's
 * detailed section shows the frozen brief's evidence manifest, and
 * the per-seat source drawer opens once committed cards are in the
 * read.
 */

import { use, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { council } from '../../../components/council/council-theme';
import '../../../components/council/council-theme.css';
import '../../../components/council/council-room.css';
import { CouncilLiveSession } from '../../../components/council/CouncilLiveSession';
import { CouncilRunStartPanel } from '../../../components/council/CouncilRunStartPanel';
import { getSession as readStoredCouncilSession } from '@/lib/council/journey-client';
import type { CouncilStoredSession } from '@/lib/council/store';
import { CouncilVerdict } from '../../../components/council/CouncilVerdict';
import { CouncilFollowUp } from '../../../components/council/CouncilFollowUp';
import { CouncilOutcomeForm } from '../../../components/council/CouncilOutcomeForm';
import { CouncilSourceDrawer } from '../../../components/council/CouncilSourceDrawer';
import { COUNCIL_MEDALLION_LARGE_SRC, COUNCIL_MEDALLION_SMALL_SRC } from '../../../components/council/medallions';
import {
  CouncilApiClient,
  FetchCouncilSessionTransport,
} from '../../../components/council/council-session-client';
import {
  buildSeatSources,
  classifyVerdictRead,
  type SeatSources,
} from '../../../components/council/council-session-types';
import type { CouncilCard, DecisionBrief } from '@/lib/council/contracts';

interface SessionDetailState {
  brief: DecisionBrief;
  title: string;
  session: CouncilStoredSession;
  accessVia: string | null;
}

export default function CouncilSessionPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = use(params);
  const searchParams = useSearchParams();
  const replay = searchParams.get('replay') === '1';

  const client = useMemo(() => new CouncilApiClient(), []);
  const transport = useMemo(
    () => new FetchCouncilSessionTransport(client),
    [client],
  );

  const [detail, setDetail] = useState<SessionDetailState | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [verdictRead, setVerdictRead] = useState<unknown>(null);
  // Committed cards join this read at CWE-050 assembly; the screens
  // render their explicit no-card-detail state until then.
  const [cards] = useState<readonly CouncilCard[]>([]);
  const [sourceSeat, setSourceSeat] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    readStoredCouncilSession(sessionId)
      .then(({ session, accessVia }) => {
        if (cancelled) return;
        const brief = session.brief ?? null;
        if (brief) {
          setDetail({ brief, title: brief.question, session, accessVia });
        } else {
          setDetailError('The session record carried no frozen brief.');
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setDetailError(
            error instanceof Error ? error.message : 'The session record could not be loaded.',
          );
        }
      });
    client
      .getVerdict(sessionId)
      .then((data) => {
        if (!cancelled) setVerdictRead(data);
      })
      .catch(() => {
        if (!cancelled) setVerdictRead(null);
      });
    return () => {
      cancelled = true;
    };
  }, [client, sessionId]);

  const optionLabels = useMemo(() => {
    const labels: Record<string, string> = {};
    for (const option of detail?.brief.options ?? []) labels[option.id] = option.label;
    return labels;
  }, [detail]);

  const classification = useMemo(
    () => (verdictRead ? classifyVerdictRead(verdictRead) : null),
    [verdictRead],
  );

  const prediction = useMemo(() => {
    if (!classification || classification.kind !== 'valid') return null;
    const verdict = classification.verdict;
    if (verdict.result_kind !== 'scored') return null;
    const recommended =
      verdict.recommended_option_id !== null
        ? (optionLabels[verdict.recommended_option_id] ?? verdict.recommended_option_id)
        : 'No option was recommended';
    return {
      recommendationText: `${verdict.label}: ${recommended}`,
      verdictRevision: verdict.verdict_revision,
      verdictContentSha256: verdict.content_sha256,
      briefSha256: verdict.brief_sha256,
    };
  }, [classification, optionLabels]);

  const sources: SeatSources | null = useMemo(() => {
    if (!sourceSeat || !detail || cards.length === 0) return null;
    return buildSeatSources(sourceSeat, cards, detail.brief, 'bibliographic_only');
  }, [cards, detail, sourceSeat]);

  return (
    <main className={council.theme}>
      {!replay && detail ? (
        <CouncilRunStartPanel
          key={sessionId}
          sessionId={sessionId}
          session={detail.session}
          accessVia={detail.accessVia}
          onQueued={(receipt) => {
            setDetail((previous) => previous ? {
              ...previous,
              session: {
                ...previous.session,
                state: {
                  ...previous.session.state,
                  state: receipt.state,
                  state_version: receipt.state_version,
                },
              },
            } : null);
          }}
        />
      ) : null}
      <CouncilLiveSession
        sessionId={sessionId}
        transport={transport}
        decisionTitle={detail?.title ?? 'Council session'}
        replay={replay}
        medallionSrcBySeat={COUNCIL_MEDALLION_SMALL_SRC}
        medallionLargeSrcBySeat={COUNCIL_MEDALLION_LARGE_SRC}
      />

      {detailError ? (
        <p role="alert" data-testid="session-detail-error">
          The session detail could not be loaded: {detailError}. The verdict,
          follow-up, and outcome sections stay empty rather than guessed.
        </p>
      ) : null}

      {detail && verdictRead ? (
        <>
          <CouncilVerdict
            verdictRead={verdictRead}
            optionLabels={optionLabels}
            cards={cards}
            brief={detail.brief}
            mode={replay ? 'replay' : 'live'}
            sessionId={sessionId}
            createExport={(body, key) => client.createExport(body, key)}
            onOpenSources={cards.length > 0 ? setSourceSeat : undefined}
          />
          <CouncilFollowUp
            sessionId={sessionId}
            postFollowUp={(id, body, key) => client.postFollowUp(id, body, key)}
          />
          <CouncilOutcomeForm
            sessionId={sessionId}
            prediction={prediction}
            postOutcome={(id, body, key) => client.postOutcome(id, body, key)}
          />
        </>
      ) : null}

      <CouncilSourceDrawer sources={sources} onClose={() => setSourceSeat(null)} />
    </main>
  );
}
