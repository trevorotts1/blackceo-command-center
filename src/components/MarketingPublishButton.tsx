'use client';

import { useState } from 'react';
import { Megaphone, Check, Loader2, AlertCircle } from 'lucide-react';
import type { Task } from '@/lib/types';
import type { SocialSummaryMessage } from '@/lib/social/summary';

/**
 * F30 — client completion + exception summary props. When `summary` is
 * present (built from PERSISTED publish/task state by the caller), the status
 * area renders the truthful stage + next action + owner instead of a bare
 * "Queued" chip. Never an unsupported completion promise: the caller derives
 * the summary via buildPublishMessage/buildTaskSummary from persisted rows.
 */
export interface PublishSummaryAreaProps {
  summary?: SocialSummaryMessage | null;
}

/**
 * F06 — a connected-account row from the per-account plan (the Skill 57
 * preflight account_plan / discovered_account contract): the REAL accounts
 * the client has, each with its own health. `platform` is the channel label;
 * `health` is ready | skipped | needs_reconnect | retrying | failed.
 */
export interface ConnectedAccount {
  platform: string;
  account_id?: string;
  account_name?: string;
  health?: 'ready' | 'skipped' | 'needs_reconnect' | 'retrying' | 'failed' | string;
}

interface MarketingPublishButtonProps {
  task: Task;
  /**
   * F06: the per-account connected-accounts plan. Enabled platforms are
   * DERIVED from the ready accounts (platform-level, deduped, order
   * preserved) — never a hardcoded quartet. When absent, the button falls
   * back to an EMPTY platform list (documented no-hardcoded-defaults
   * posture): with no real plan the button still queues, but with no
   * assumed platforms.
   */
  accounts?: ConnectedAccount[];
  /**
   * Explicit platform override (wins over `accounts`). Preferred only when a
   * caller genuinely wants to pin the channel list.
   */
  platforms?: string[];
  /**
   * Optional class name for the wrapping <button>.
   */
  className?: string;
  /**
   * Called after a successful queue POST (passes the new publish id).
   */
  onQueued?: (publishId: string) => void;
  /**
   * F30: the persisted-state client summary for this task's publish intent.
   * Renders the truthful stage/next-action/owner line under the button when
   * present.
   */
  summary?: SocialSummaryMessage | null;
}

/**
 * F06: an EMPTY-ARRAY fallback — documented as such. The old hardcoded
 * ['linkedin','medium','x','wordpress'] quartet is GONE: a publish intent
 * without a real per-account plan must never silently assume channels the
 * client may not have connected.
 */
export const DEFAULT_PLATFORMS: string[] = [];

/** Derive the enabled platform list from the per-account plan: ready (and
 * retrying) accounts only, deduped, order preserved, lowercased. */
export function enabledPlatformsFromAccounts(accounts: ConnectedAccount[]): string[] {
  const seen: string[] = [];
  for (const a of accounts) {
    const p = String(a.platform || '').trim().toLowerCase();
    if (!p) continue;
    if (a.health === 'skipped' || a.health === 'needs_reconnect' || a.health === 'failed') continue;
    if (!seen.includes(p)) seen.push(p);
  }
  return seen;
}

function isMarketingTask(task: Task): boolean {
  const dept = (task.department || '').toLowerCase();
  return (
    dept === 'marketing' ||
    dept === 'marketing-dept' ||
    dept === 'social-media' ||
    dept === 'social'
  );
}

/**
 * MarketingPublishButton — visible on Marketing-department task cards.
 *
 * Clicking POSTs to /api/skill-35/publish with
 *   { task_id, topic, platforms[] }
 * The endpoint records the publish intent in the publish_queue table
 * (migration 022) and emits a `publish_queued` SSE event so the
 * dashboard shows "queued" state.
 *
 * F06: `platforms` are derived from the `accounts` per-account plan when
 * supplied (healthy accounts only — a needs_reconnect account is never
 * silently re-enabled); the hardcoded quartet default is gone.
 */
export function MarketingPublishButton({
  task,
  accounts,
  platforms,
  className,
  onQueued,
  summary,
}: MarketingPublishButtonProps) {
  const [state, setState] = useState<'idle' | 'queuing' | 'queued' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  // D-F06-01: the button fetches the per-account plan itself when the caller
  // passes none (MissionQueue renders it bare). useState initializer (not an
  // effect) so the value is set before first paint — no loading flash, no
  // extra render; the fetch only fires for marketing tasks with no plan.
  const [fetchedAccounts, setFetchedAccounts] = useState<ConnectedAccount[] | null>(null);
  const [planHint, setPlanHint] = useState<string | null>(null);
  const needsFetch =
    isMarketingTask(task) && !platforms && (!accounts || accounts.length === 0) && fetchedAccounts === null && planHint === null;
  if (needsFetch) {
    setFetchedAccounts([]); // mark started (sync guard — the async fill lands below)
    fetch('/api/company/config', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((config: { connectedSystems?: { social?: string } } | null) => {
        const social = String(config?.connectedSystems?.social || 'none').trim().toLowerCase();
        if (!social || social === 'none') {
          setPlanHint('No social accounts connected — connect one in Settings to publish.');
          return;
        }
        // Single connected system: one ready account row for its platform.
        setFetchedAccounts([{ platform: social, health: 'ready' }]);
      })
      .catch(() => {
        setPlanHint('Could not load the account plan — retry the publish.');
      });
  }

  if (!isMarketingTask(task)) return null;

  const effectiveAccounts =
    accounts && accounts.length ? accounts : (fetchedAccounts && fetchedAccounts.length ? fetchedAccounts : undefined);
  const planAccounts = effectiveAccounts ?? accounts ?? [];
  const resolvedPlatforms =
    // enabledPlatformsFromAccounts(accounts): platforms derive from the
    // per-account plan (caller-supplied or self-fetched) — never hardcoded.
    platforms ?? (planAccounts.length ? enabledPlatformsFromAccounts(planAccounts) : DEFAULT_PLATFORMS);
  const emptyPlanHint =
    planHint ?? ((!platforms && !effectiveAccounts) ? 'No account plan yet — platforms resolve when the plan loads.' : null);

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (state === 'queuing' || state === 'queued') return;
    // D-F06-01: never POST platforms:[] (the route 400s). Surface the hint
    // as the button error instead of an opaque route Retry.
    if (resolvedPlatforms.length === 0) {
      setError(emptyPlanHint || 'No healthy social accounts — nothing to publish to.');
      setState('error');
      return;
    }

    setState('queuing');
    setError(null);

    try {
      const resp = await fetch('/api/skill-35/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task_id: task.id,
          topic: task.title,
          platforms: resolvedPlatforms,
          schedule: 'auto',
          requested_by: 'dashboard:marketing-publish-button',
        }),
      });

      if (!resp.ok) {
        const data = (await resp.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `HTTP ${resp.status}`);
      }

      const data = (await resp.json()) as { publish: { id: string } };
      setState('queued');
      if (data.publish?.id && onQueued) onQueued(data.publish.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'failed to queue';
      setError(msg);
      setState('error');
    }
  };

  const base = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-colors';
  let styles = 'bg-pink-100 text-pink-700 hover:bg-pink-200';
  let label: React.ReactNode = (
    <>
      <Megaphone className="h-3.5 w-3.5" /> Publish
    </>
  );

  if (state === 'queuing') {
    styles = 'bg-pink-50 text-pink-500 cursor-wait';
    label = (
      <>
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Queuing…
      </>
    );
  } else if (state === 'queued') {
    styles = 'bg-emerald-100 text-emerald-700 cursor-default';
    label = (
      <>
        <Check className="h-3.5 w-3.5" /> Queued
      </>
    );
  } else if (state === 'error') {
    styles = 'bg-red-100 text-red-700 hover:bg-red-200';
    label = (
      <>
        <AlertCircle className="h-3.5 w-3.5" /> Retry
      </>
    );
  }

  return (
    <span className="inline-flex flex-col gap-1">
      <button
        type="button"
        onClick={handleClick}
        disabled={resolvedPlatforms.length === 0 && state !== 'error'}
        title={
          state === 'error' && error
            ? `Failed: ${error}`
            : emptyPlanHint ||
              `Queue this topic for the Skill 35 publishing pipeline (platforms: ${resolvedPlatforms.join(', ') || 'none derived from the account plan'})`
        }
        className={[base, styles, className || ''].join(' ').trim()}
      >
        {label}
      </button>
      {summary && <PublishSummaryArea summary={summary} />}
    </span>
  );
}

/**
 * F30 — the status area under the Publish button. Renders the persisted-state
 * summary verbatim: truthful stage, next action with owner, retry deadline
 * when one exists. A queued job says queued; an unanswered theme says
 * awaiting theme; scheduled posts say scheduled.
 */
export function PublishSummaryArea({ summary }: PublishSummaryAreaProps) {
  if (!summary) return null;
  const ownerLabel = summary.owner === 'client' ? 'Your move' : 'System';
  return (
    <span
      data-testid="publish-summary-area"
      className={`inline-flex flex-col text-xs leading-snug px-2 py-1 rounded ${
        summary.stage === 'failed' || summary.stage === 'overdue'
          ? 'bg-red-50 text-red-700'
          : summary.owner === 'client'
            ? 'bg-amber-50 text-amber-800'
            : 'bg-gray-50 text-gray-600'
      }`}
    >
      <span className="font-semibold capitalize">{summary.stage}</span>
      <span>{summary.nextAction}</span>
      <span className="opacity-70">
        {ownerLabel}
        {summary.retryDeadline ? ` · retry by ${new Date(summary.retryDeadline).toLocaleTimeString()}` : ''}
      </span>
      {summary.failures.length > 0 && (
        <span className="opacity-80">{summary.failures.join('; ')}</span>
      )}
    </span>
  );
}

export default MarketingPublishButton;