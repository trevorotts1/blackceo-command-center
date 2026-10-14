'use client';

/**
 * CouncilHistory + CouncilRerunComparison (CWE-034, Skill 77).
 *
 * Searchable session history over the CWE-029 session list read, and
 * the parent/child rerun comparison (T024): the changed-input diff
 * between the two frozen briefs, with BOTH verdicts preserved side
 * by side. A rerun never rewrites the parent: the parent's verdict
 * renders from its own committed record, exactly as saved, next to
 * the child's.
 *
 * The list renders only what the scope-partitioned read returned for
 * the current company (T081): this component holds no cache of its
 * own, so a company switch, which swaps the input, cannot leave a
 * prior company's row on screen.
 */

import { useMemo, useState } from 'react';
import { council, councilcx } from './council-theme';
import type {
  BriefDiffEntry,
  CouncilSessionSummaryView,
} from './council-session-types';

export interface CouncilHistoryProps {
  sessions: readonly CouncilSessionSummaryView[];
  loadState: 'loading' | 'ready' | 'error';
  errorMessage?: string | null;
  onOpenSession?: (sessionId: string) => void;
}

export function CouncilHistory({
  sessions,
  loadState,
  errorMessage,
  onOpenSession,
}: CouncilHistoryProps) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) =>
      [s.session_id, s.mode, s.state, s.visibility]
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }, [query, sessions]);

  return (
    <section data-testid="council-history" aria-label="Council session history">
      <h2 className={council.heading}>Decision history</h2>
      <label>
        Search history{' '}
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          data-testid="council-history-search"
          placeholder="Search by session, mode, state, or visibility"
        />
      </label>

      {loadState === 'loading' ? (
        <p data-testid="council-history-loading" aria-live="polite">
          Loading the recorded sessions for this company...
        </p>
      ) : null}
      {loadState === 'error' ? (
        <p data-testid="council-history-error" role="alert">
          The session history could not be loaded
          {errorMessage ? `: ${errorMessage}` : ''}. No history is shown
          rather than guessed.
        </p>
      ) : null}
      {loadState === 'ready' && sessions.length === 0 ? (
        <p data-testid="council-history-empty">
          No council sessions are recorded in this company scope yet. When a
          session is created, its record appears here.
        </p>
      ) : null}
      {loadState === 'ready' && sessions.length > 0 && filtered.length === 0 ? (
        <p data-testid="council-history-no-match">
          No recorded sessions match your search.
        </p>
      ) : null}
      {loadState === 'ready' && filtered.length > 0 ? (
        <ul>
          {filtered.map((session) => (
            <li key={session.session_id} data-testid={`history-row-${session.session_id}`}>
              <strong>{session.session_id}</strong>{' '}
              <span>
                {session.mode} session, state {session.state}, visibility{' '}
                {session.visibility}
                {session.archived ? ', archived' : ''}. Brief revision{' '}
                {session.brief_revision}. Last updated {session.updated_at}.
              </span>{' '}
              {onOpenSession ? (
                <button
                  type="button"
                  className={councilcx(council.btn, council.btnQuiet)}
                  data-testid={`history-open-${session.session_id}`}
                  onClick={() => onOpenSession(session.session_id)}
                >
                  Open session
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/* ── Rerun comparison (T024) ─────────────────────────────────────────── */

export interface RerunVerdictSummary {
  /** The verdict label exactly as recorded, or null when no verdict exists. */
  label: string | null;
  recommendedOptionLabel: string | null;
  verdictRevision: number | null;
}

export interface CouncilRerunComparisonProps {
  parentTitle: string;
  childTitle: string;
  parentVerdict: RerunVerdictSummary;
  childVerdict: RerunVerdictSummary;
  diff: readonly BriefDiffEntry[];
}

function verdictText(summary: RerunVerdictSummary): string {
  if (summary.label === null) return 'No verdict was recorded for this session.';
  return `Verdict (revision ${summary.verdictRevision}): ${summary.label}, recommending ${summary.recommendedOptionLabel ?? 'no option'}.`;
}

export function CouncilRerunComparison({
  parentTitle,
  childTitle,
  parentVerdict,
  childVerdict,
  diff,
}: CouncilRerunComparisonProps) {
  return (
    <section data-testid="council-rerun-comparison" aria-label="Rerun comparison">
      <h3 className={council.heading}>Rerun comparison</h3>
      <div data-testid="rerun-parent-verdict">
        <h4 className={council.heading}>Original session: {parentTitle}</h4>
        <p>{verdictText(parentVerdict)}</p>
      </div>
      <div data-testid="rerun-child-verdict">
        <h4 className={council.heading}>Rerun with changed facts: {childTitle}</h4>
        <p>{verdictText(childVerdict)}</p>
      </div>
      <h4 className={council.heading}>What changed in the inputs</h4>
      {diff.length === 0 ? (
        <p data-testid="rerun-diff-empty">
          The rerun used identical recorded inputs: no fact, option, or
          constraint differs between the two frozen briefs.
        </p>
      ) : (
        <ul data-testid="rerun-diff">
          {diff.map((entry, i) => (
            <li key={i}>
              <strong>{entry.field}:</strong>{' '}
              {entry.before !== null ? `before: ${entry.before}. ` : ''}
              {entry.after !== null ? `after: ${entry.after}.` : 'removed.'}
            </li>
          ))}
        </ul>
      )}
      <p className={council.meta}>
        The original verdict above is preserved exactly as recorded. Running
        a session again with changed facts creates a linked new session; it
        never edits the original decision.
      </p>
    </section>
  );
}
