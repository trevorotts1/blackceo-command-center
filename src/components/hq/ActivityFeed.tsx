'use client';

/**
 * ActivityFeed — Headquarters public activity feed (unit B26, milestone V10).
 *
 * Authority: SPEC.md rev 4 — S5 (what is visible / safe content), S6 (storage
 * retention and source tombstones), S8 (forward + older pages, `resetRequired`,
 * “Recent activity” on first visit) and S11 (44 CSS px controls, state carried
 * by label/icon rather than color alone). The event shape is the frozen P01
 * contract in `src/lib/hq/types.ts`; this file declares no wire shape of its
 * own and adds no dependency.
 *
 * Presentational by design: it never fetches, never synthesizes a row, and
 * never renders a field it was not handed. Every producer string reaches the
 * DOM as React text, so hostile markup stays inert (no raw HTML path, no
 * `dangerouslySetInnerHTML` anywhere in this file). Unknown runtime keys that
 * arrive on an event object are structurally unable to render, because each
 * row reads named fields only — never a spread, never a JSON dump.
 *
 * The frozen contract is imported RELATIVELY rather than through the `@/`
 * alias: this component is covered by the repo's plain Node test runner
 * (`node --import tsx --test tests/unit/hq/B26/activity-feed.test.ts`, the same
 * command shape P01 uses), and the `@/` tsconfig alias does not resolve there.
 * Components that are not direct-imported by a Node-runner suite keep the alias.
 */
import type { ReactNode } from 'react';
import { AlertTriangle, ClipboardList, MessageSquare, Newspaper, Route, StickyNote } from 'lucide-react';
import type {
  HqActivityEvent,
  HqActivityKind,
  HqPublicActivityPayload,
  HqPublicDecisionPayload,
  HqPublicExchangePayload,
  HqPublicOwnerNotePayload,
  HqPublicTaskPayload,
} from '../../lib/hq/types';

/* ================================================================== *
 * Props — the seam the Headquarters shell/state layer fills (S8, S5)
 * ================================================================== */

/** SPEC S8 older-history page controls. Absent means the caller offers none. */
export type HqActivityFeedOlderPage = {
  hasMore: boolean;
  loading?: boolean;
  error?: string | null;
  onLoad?: () => void;
};

export type HqActivityFeedProps = {
  events: readonly HqActivityEvent[];
  /**
   * Event IDs whose source record is gone (SPEC S6: physical source deletion
   * does not cascade-delete the activity; removed targets yield tombstones).
   * The wire shape of a tombstone is owned by B05/B07 (gap G-15), so the feed
   * takes the one fact it needs — which rows are tombstones — and nothing more.
   */
  tombstones?: ReadonlySet<string>;
  /**
   * SPEC S8 `captureHealth` (shape owned by B08, gap G-01). Read tolerantly by
   * `hqCaptureCoverage`; a degraded or unrecognized value is surfaced honestly
   * and never silently rendered as complete.
   */
  captureHealth?: unknown;
  /** First load in flight with no rows yet. */
  pending?: boolean;
  /** Honest load-failure label. A failed load is never shown as an empty company (SPEC S8.7). */
  error?: string | null;
  /** SPEC S8.2: first visit / retention reset is “Recent activity”, not full history. */
  recentOnly?: boolean;
  /** SPEC S8.5: the cursor fell behind pruned history — older activity is gone. */
  resetRequired?: boolean;
  older?: HqActivityFeedOlderPage;
  className?: string;
};

/* ================================================================== *
 * Deliberately narrow readers over wire data (S5 safe content)
 * ================================================================== */

/** A non-empty string, or null. Anything else is absent, never coerced. */
function readText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** A finite non-negative integer, or null. Floats and negatives are not counts. */
function readCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export type HqCaptureCoverage = {
  state: 'ok' | 'degraded' | 'unavailable' | 'unknown';
  droppedCount: number | null;
  since: string | null;
};

const COVERAGE_OK = new Set(['ok', 'healthy', 'online', 'active', 'up', 'nominal', 'complete', 'capturing']);
const COVERAGE_DEGRADED = new Set(['degraded', 'degrade', 'overflow', 'partial', 'dropping', 'lagging']);
const COVERAGE_UNAVAILABLE = new Set(['unavailable', 'offline', 'down', 'failed', 'error', 'stopped', 'disabled', 'missing']);

/**
 * Reads the facts SPEC already names for capture health — a state, a dropped
 * count and a timestamp (S5: “Overflow sets captureHealth=degraded with
 * dropped-count and timestamps … never silently claims completeness”) — out of
 * a value whose encoding B08 still owns (gap G-01).
 *
 * ponytail: tolerates the two most likely spellings of each field instead of
 * freezing a shape that is not this unit's to freeze. Ceiling: a B08 shape that
 * spells them otherwise renders as `unknown`. Upgrade: when B08 freezes
 * `captureHealth`, collapse each alias pair to the frozen key.
 */
export function hqCaptureCoverage(value: unknown): HqCaptureCoverage | null {
  if (value === undefined || value === null) return null;
  const record = typeof value === 'object' ? (value as Record<string, unknown>) : null;
  const rawState = typeof value === 'string' ? value : (record?.state ?? record?.captureState ?? record?.status);
  const token = typeof rawState === 'string' ? rawState.trim().toLowerCase() : '';
  const state: HqCaptureCoverage['state'] = COVERAGE_DEGRADED.has(token)
    ? 'degraded'
    : COVERAGE_UNAVAILABLE.has(token)
      ? 'unavailable'
      : COVERAGE_OK.has(token)
        ? 'ok'
        : 'unknown';
  const droppedCount = readCount(record?.droppedCount ?? record?.dropped);
  const since = readText(record?.since ?? record?.updatedAt);
  return { state, droppedCount, since };
}

/** Deterministic, timezone-independent stamp. Unreadable input says so instead of guessing. */
function hqFeedStamp(iso: string | null): { dateTime: string; label: string } | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return { dateTime: iso, label: 'Timestamp unreadable' };
  const utc = new Date(ms).toISOString();
  return { dateTime: utc, label: `${utc.slice(0, 10)} ${utc.slice(11, 16)} UTC` };
}

/* ================================================================== *
 * Truthful labels — the SPEC's own vocabulary, no invented states
 * ================================================================== */

const KIND_LABEL: Record<HqActivityKind, string> = {
  task: 'Task',
  owner_note: 'Owner note',
  decision: 'Decision',
  exchange: 'Exchange',
};

const KIND_ICON: Record<HqActivityKind, typeof Newspaper> = {
  task: ClipboardList,
  owner_note: StickyNote,
  decision: Route,
  exchange: MessageSquare,
};

/**
 * Phase wording is SPEC S5/S7 (truthful phase, acceptance is not completion,
 * a generated reply is not a delivered one) rather than a rival vocabulary.
 */
const PHASE_LABEL: Record<string, string> = {
  created: 'Created',
  assigned: 'Assigned',
  status_changed: 'Status changed',
  recorded: 'Recorded',
  applied: 'Applied',
  shadow: 'Shadow — not applied',
  unavailable: 'Unavailable',
  requested: 'Requested',
  accepted: 'Accepted — not completion',
  replied: 'Reply generated',
  failed: 'Failed',
  uncertain: 'Delivery uncertain',
};

function phaseLabel(phase: string): string {
  return PHASE_LABEL[phase] ?? `Unrecognized phase: ${phase}`;
}

/* ================================================================== *
 * Small presentational pieces
 * ================================================================== */

function Chip({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'warning' }) {
  const styles =
    tone === 'warning'
      ? 'bg-semantic-warningLight text-amber-800 border-amber-200'
      : 'bg-bcc-border-light text-bcc-text-secondary border-bcc-border';
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${styles}`}>
      {children}
    </span>
  );
}

function DetailLine({ label, value }: { label: string; value: string }) {
  return (
    <p className="text-caption text-bcc-text-secondary">
      <span className="font-medium text-bcc-text">{label}:</span> <span className="break-words">{value}</span>
    </p>
  );
}

/** Absent or unrecognized detail is stated, never dressed up as a real value. */
function Unrecorded({ what }: { what: string }) {
  return <p className="text-caption italic text-bcc-text-muted">{what} not recorded</p>;
}

/* ================================================================== *
 * Row detail — one branch per kind, each reading named fields only
 * ================================================================== */

function PayloadDetail({ kind, payload }: { kind: HqActivityKind; payload: HqPublicActivityPayload }) {
  if (kind === 'owner_note') {
    const text = 'text' in payload ? readText((payload as HqPublicOwnerNotePayload).text) : null;
    return text === null ? (
      <Unrecorded what="Note text" />
    ) : (
      <p className="whitespace-pre-wrap break-words text-body text-bcc-text">{text}</p>
    );
  }

  if (kind === 'task') {
    const task = payload as HqPublicTaskPayload;
    const status = 'status' in payload ? readText(task.status) : null;
    const previous = 'previousStatus' in payload ? readText(task.previousStatus) : null;
    return (
      <div className="space-y-0.5">
        {status === null ? <Unrecorded what="Status" /> : <DetailLine label="Status" value={status} />}
        {previous !== null && <DetailLine label="Previous status" value={previous} />}
      </div>
    );
  }

  if (kind === 'decision') {
    const decision = payload as HqPublicDecisionPayload;
    const inPayload = 'mode' in payload;
    const intent = inPayload ? readText(decision.intent) : null;
    const routeAction = inPayload ? readText(decision.routeAction) : null;
    const department = inPayload ? readText(decision.departmentSlug) : null;
    const resolvedBy = inPayload ? readText(decision.resolvedBy) : null;
    const mode = inPayload ? readText(decision.mode) : null;
    // S5: a missing confidence is null, never 0, and off/legacy/unavailable does
    // not become a measured zero.
    const bps = inPayload && typeof decision.confidenceBps === 'number' && Number.isSafeInteger(decision.confidenceBps) ? decision.confidenceBps : null;
    const fallback = inPayload && typeof decision.fallback === 'boolean' ? decision.fallback : null;
    return (
      <div className="space-y-0.5">
        {intent === null ? <Unrecorded what="Selected intent" /> : <DetailLine label="Intent" value={intent} />}
        {routeAction === null ? <Unrecorded what="Route" /> : <DetailLine label="Route" value={routeAction} />}
        {department !== null && <DetailLine label="Department" value={department} />}
        {bps === null ? (
          <Unrecorded what="Confidence" />
        ) : (
          <DetailLine label="Confidence" value={bps % 100 === 0 ? `${bps / 100}%` : `${(bps / 100).toFixed(2)}%`} />
        )}
        {fallback !== null && <DetailLine label="Fallback" value={fallback ? 'true' : 'false'} />}
        {mode === null ? <Unrecorded what="Mode" /> : <DetailLine label="Mode" value={mode} />}
        {resolvedBy !== null && <DetailLine label="Resolved by" value={resolvedBy} />}
      </div>
    );
  }

  const summary = 'summary' in payload ? readText((payload as HqPublicExchangePayload).summary) : null;
  const message = 'message' in payload ? readText((payload as HqPublicExchangePayload).message) : null;
  return (
    <div className="space-y-0.5">
      {summary === null ? <Unrecorded what="Summary" /> : <p className="break-words text-body text-bcc-text">{summary}</p>}
      {message !== null && <p className="whitespace-pre-wrap break-words text-caption text-bcc-text-secondary">{message}</p>}
    </div>
  );
}

/* ================================================================== *
 * One row
 * ================================================================== */

function FeedRow({ event, tombstoned }: { event: HqActivityEvent; tombstoned: boolean }) {
  const Icon = KIND_ICON[event.kind] ?? Newspaper;
  const received = hqFeedStamp(event.receivedAt);
  const occurred = hqFeedStamp(event.occurredAt);
  const actor = tombstoned ? null : readText(event.actorLabel);
  const recipient = tombstoned ? null : readText(event.recipientLabel);
  const phase = tombstoned ? (PHASE_LABEL[event.phase] ?? `Unrecognized phase: ${event.phase}`) : phaseLabel(event.phase);

  return (
    <li
      data-testid="hq-activity-row"
      data-kind={event.kind}
      data-phase={event.phase}
      data-tombstone={tombstoned ? 'true' : 'false'}
      className="border-b border-bcc-border-light px-4 py-3 last:border-b-0"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Icon className="h-4 w-4 shrink-0 text-bcc-text-muted" aria-hidden="true" />
        <Chip>
          <span>{KIND_LABEL[event.kind] ?? event.kind}</span>
        </Chip>
        <Chip tone={tombstoned || event.phase === 'unavailable' || event.phase === 'uncertain' ? 'warning' : 'neutral'}>{phase}</Chip>
        <span className="font-mono text-[10px] text-bcc-text-muted break-all" title="Source reference">
          {tombstoned ? 'source removed' : event.reference}
        </span>
      </div>

      <div className="mt-1.5 space-y-1">
        {tombstoned ? (
          <p className="text-body text-bcc-text-secondary">
            Source record no longer exists — nothing about its contents is retained here.
          </p>
        ) : (
          <>
            <p className="break-words text-body text-bcc-text">
              {actor === null ? <span className="italic text-bcc-text-muted">Actor unavailable</span> : <span className="font-medium">{actor}</span>}
              <span className="text-bcc-text-muted"> to </span>
              {recipient === null ? <span className="italic text-bcc-text-muted">recipient unavailable</span> : <span className="font-medium">{recipient}</span>}
            </p>
            <PayloadDetail kind={event.kind} payload={event.payload} />
          </>
        )}
        <p className="flex flex-wrap gap-x-3 text-caption text-bcc-text-muted">
          <span>
            Received:{' '}
            {received === null ? (
              <span className="italic">not recorded</span>
            ) : (
              <time dateTime={received.dateTime}>{received.label}</time>
            )}
          </span>
          <span>
            Occurred:{' '}
            {occurred === null ? (
              <span className="italic">not recorded</span>
            ) : (
              <time dateTime={occurred.dateTime}>{occurred.label}</time>
            )}
          </span>
          {event.taskId !== null && (
            <span data-task-id={event.taskId} className="font-mono break-all">
              task {event.taskId}
            </span>
          )}
        </p>
      </div>
    </li>
  );
}

/* ================================================================== *
 * Coverage banner — capture truth, never a completeness claim
 * ================================================================== */

function CoverageBanner({ coverage }: { coverage: HqCaptureCoverage }) {
  if (coverage.state === 'ok') return null;
  const message =
    coverage.state === 'degraded'
      ? `Capture degraded — events may be missing${
          coverage.droppedCount === null ? ' (dropped count unavailable)' : ` (${coverage.droppedCount} dropped)`
        }${coverage.since === null ? '' : `, since ${coverage.since}`}.`
      : coverage.state === 'unavailable'
        ? 'Capture unavailable — no events are being recorded.'
        : 'Capture status is not in a recognized form — completeness is not claimed.';
  return (
    <div
      data-testid="hq-feed-coverage"
      data-coverage-state={coverage.state}
      role="status"
      className="flex items-start gap-2 border-b border-amber-200 bg-semantic-warningLight px-4 py-2 text-caption text-amber-900"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}

/* ================================================================== *
 * Feed
 * ================================================================== */

export default function ActivityFeed({
  events,
  tombstones,
  captureHealth,
  pending = false,
  error = null,
  recentOnly = false,
  resetRequired = false,
  older,
  className = '',
}: HqActivityFeedProps) {
  const coverage = hqCaptureCoverage(captureHealth);
  const hasRows = events.length > 0;

  return (
    <section
      data-testid="hq-activity-feed"
      aria-label={recentOnly ? 'Recent activity' : 'Company activity'}
      className={`overflow-hidden rounded-2xl border border-bcc-border bg-bcc-white shadow-card ${className}`}
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-bcc-border px-4 py-3">
        <h2 className="text-card-title text-bcc-text">{recentOnly ? 'Recent activity' : 'Activity'}</h2>
        <p className="text-caption text-bcc-text-secondary">
          {hasRows ? `${events.length} event${events.length === 1 ? '' : 's'} shown` : 'No events'}
          {recentOnly ? ' — the latest events, not full history' : ''}
        </p>
      </header>

      {coverage !== null && <CoverageBanner coverage={coverage} />}

      {error !== null && (
        <p data-testid="hq-feed-error" className="border-b border-bcc-border bg-semantic-dangerLight px-4 py-3 text-body text-red-800">
          {error}
        </p>
      )}

      {pending && !hasRows ? (
        <p data-testid="hq-feed-pending" role="status" className="px-4 py-8 text-center text-body text-bcc-text-secondary">
          Loading activity…
        </p>
      ) : hasRows ? (
        <ul className="m-0 list-none p-0">
          {events.map((event) => (
            <FeedRow key={event.id} event={event} tombstoned={tombstones?.has(event.id) ?? false} />
          ))}
        </ul>
      ) : error !== null ? (
        // SPEC S8.7: a failed load is never rendered as an empty company. The
        // error line above is the whole story; no "No activity yet." claim.
        <p data-testid="hq-feed-error-empty" className="px-4 py-8 text-center text-body text-bcc-text-secondary">
          No current activity to show — see the load failure above.
        </p>
      ) : (
        <p data-testid="hq-feed-empty" className="px-4 py-8 text-center text-body text-bcc-text-secondary">
          No activity yet.
        </p>
      )}

      {hasRows && (
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-bcc-border px-4 py-3">
          {resetRequired ? (
            <p data-testid="hq-feed-history-reset" className="text-caption text-bcc-text-secondary">
              Older activity unavailable — history was pruned before this cursor.
            </p>
          ) : older?.hasMore ? (
            <div className="flex flex-col gap-1">
              <button
                type="button"
                data-testid="hq-feed-older"
                onClick={older.onLoad}
                disabled={older.loading === true}
                aria-disabled={older.loading === true}
                className={`inline-flex min-h-[44px] items-center rounded-xl border px-4 text-label font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-300 ${
                  older.loading === true
                    ? 'cursor-not-allowed border-bcc-border bg-bcc-border-light text-bcc-text-muted'
                    : 'border-bcc-border bg-bcc-white text-bcc-text hover:border-brand-300 hover:shadow-pill'
                }`}
              >
                {older.loading === true ? 'Loading older activity…' : 'Load older activity'}
              </button>
              {older.error != null && (
                <p data-testid="hq-feed-older-error" className="text-caption text-red-700">
                  Older activity failed to load: {older.error}
                </p>
              )}
            </div>
          ) : (
            <p data-testid="hq-feed-history-start" className="text-caption text-bcc-text-secondary">
              Start of retained history.
            </p>
          )}
        </footer>
      )}
    </section>
  );
}
