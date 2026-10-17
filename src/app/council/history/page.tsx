'use client';

/**
 * Council history page (CWE-034, Skill 77): /council/history
 *
 * Searchable decision history over the CWE-029 session list read,
 * plus the parent/child rerun comparison (T024). The list is held
 * in a CouncilScopeCache partitioned by the trusted scope key read
 * from the capabilities endpoint (tenant, company, principal):
 * switching company calls setScope before any render, which drops
 * the prior company's partition synchronously, so no prior
 * company's session, source, or model data can render after a
 * switch, even briefly from cache (T081, Section 28).
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { council } from '../../../components/council/council-theme';
import '../../../components/council/council-theme.css';
import '../../../components/council/council-room.css';
import {
  CouncilHistory,
  CouncilRerunComparison,
  type RerunVerdictSummary,
} from '../../../components/council/CouncilHistory';
import { CouncilApiClient } from '../../../components/council/council-session-client';
import {
  CouncilScopeCache,
  classifyVerdictRead,
  councilScopeKey,
  diffBriefs,
  type CouncilSessionSummaryView,
} from '../../../components/council/council-session-types';
import type { DecisionBrief } from '@/lib/council/contracts';

/** One browser-session cache; partitions are keyed by trusted scope. */
const historyCache = new CouncilScopeCache();

interface ComparisonState {
  parentTitle: string;
  childTitle: string;
  parentVerdict: RerunVerdictSummary;
  childVerdict: RerunVerdictSummary;
  diff: ReturnType<typeof diffBriefs>;
}

function verdictSummary(
  read: unknown,
  brief: DecisionBrief,
): RerunVerdictSummary {
  const classification = classifyVerdictRead(read);
  if (classification.kind !== 'valid' || classification.verdict.result_kind !== 'scored') {
    return { label: null, recommendedOptionLabel: null, verdictRevision: null };
  }
  const verdict = classification.verdict;
  const recommended =
    verdict.recommended_option_id !== null
      ? (brief.options.find((o) => o.id === verdict.recommended_option_id)?.label ??
        verdict.recommended_option_id)
      : null;
  return {
    label: verdict.label,
    recommendedOptionLabel: recommended,
    verdictRevision: verdict.verdict_revision,
  };
}

export default function CouncilHistoryPage() {
  const client = useMemo(() => new CouncilApiClient(), []);
  const [sessions, setSessions] = useState<CouncilSessionSummaryView[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [parentId, setParentId] = useState('');
  const [childId, setChildId] = useState('');
  const [comparison, setComparison] = useState<ComparisonState | null>(null);
  const [comparisonError, setComparisonError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Resolve the trusted scope first; the cache partition is
        // set from it before any list data is read or rendered.
        const capabilities = await client.getCapabilities();
        const principal = capabilities.principal;
        const scopeKey = councilScopeKey({
          tenant_id: principal?.tenant_id ?? '',
          company_id: principal?.company_id ?? '',
          principal_subject: principal?.subject ?? '',
        });
        historyCache.setScope(scopeKey);
        const cached = historyCache.get<CouncilSessionSummaryView[]>('sessions');
        if (cached) {
          if (!cancelled) {
            setSessions(cached);
            setLoadState('ready');
          }
          return;
        }
        const data = await client.listSessions();
        if (cancelled) return;
        historyCache.set('sessions', data.sessions);
        setSessions(data.sessions);
        setLoadState('ready');
      } catch (error) {
        if (!cancelled) {
          setLoadState('error');
          setErrorMessage(
            error instanceof Error ? error.message : 'The session history could not be loaded.',
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  const loadComparison = async () => {
    setComparisonError(null);
    setComparison(null);
    if (!parentId || !childId || parentId === childId) {
      setComparisonError('Choose two different sessions: the original and its rerun.');
      return;
    }
    try {
      const [parentDetail, childDetail, parentVerdictRead, childVerdictRead] =
        await Promise.all([
          client.getSession(parentId),
          client.getSession(childId),
          client.getVerdict(parentId),
          client.getVerdict(childId),
        ]);
      const parentBrief = (parentDetail as { brief?: DecisionBrief }).brief;
      const childBrief = (childDetail as { brief?: DecisionBrief }).brief;
      if (!parentBrief || !childBrief) {
        setComparisonError('One of the chosen sessions carries no frozen brief to compare.');
        return;
      }
      setComparison({
        parentTitle: parentBrief.question,
        childTitle: childBrief.question,
        parentVerdict: verdictSummary(parentVerdictRead, parentBrief),
        childVerdict: verdictSummary(childVerdictRead, childBrief),
        diff: diffBriefs(parentBrief, childBrief),
      });
    } catch (error) {
      setComparisonError(
        error instanceof Error ? error.message : 'The comparison could not be loaded.',
      );
    }
  };

  return (
    <main className={council.theme}>
      <h1 className={council.heading}>Council decision history</h1>
      <CouncilHistory
        sessions={sessions}
        loadState={loadState}
        errorMessage={errorMessage}
        onOpenSession={(sessionId) => {
          window.location.href = `/council/${sessionId}`;
        }}
      />
      <p className={council.meta}>
        Open a session to see its room, verdict, sources, follow-up, and
        outcome record. <Link href="/council/advisors">Meet the nine seats</Link>.
      </p>

      <section aria-label="Compare a rerun with its original">
        <h2 className={council.heading}>Compare a rerun</h2>
        <label>
          Original session{' '}
          <select
            value={parentId}
            onChange={(event) => setParentId(event.target.value)}
            data-testid="compare-parent"
          >
            <option value="">Choose...</option>
            {sessions.map((s) => (
              <option key={s.session_id} value={s.session_id}>
                {s.session_id}
              </option>
            ))}
          </select>
        </label>{' '}
        <label>
          Rerun session{' '}
          <select
            value={childId}
            onChange={(event) => setChildId(event.target.value)}
            data-testid="compare-child"
          >
            <option value="">Choose...</option>
            {sessions.map((s) => (
              <option key={s.session_id} value={s.session_id}>
                {s.session_id}
              </option>
            ))}
          </select>
        </label>{' '}
        <button type="button" onClick={() => void loadComparison()}>
          Compare
        </button>
        {comparisonError ? (
          <p role="alert" data-testid="compare-error">
            {comparisonError}
          </p>
        ) : null}
        {comparison ? <CouncilRerunComparison {...comparison} /> : null}
      </section>
    </main>
  );
}
