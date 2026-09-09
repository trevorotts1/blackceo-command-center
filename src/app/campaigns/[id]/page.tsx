'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, Loader2, AlertCircle, Target, RefreshCw, WifiOff } from 'lucide-react';
import { Breadcrumb } from '@/components/Breadcrumb';
import { KANBAN_COLUMNS, STATUS_TO_COLUMN, columnForStatus, type KanbanColumn } from '@/lib/social/board-columns';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TaskStatus =
  | 'inbox' | 'backlog' | 'planning' | 'assigned' | 'pending_dispatch'
  | 'in_progress' | 'testing' | 'review' | 'blocked' | 'done';
type TaskPriority = 'critical' | 'high' | 'medium' | 'low';

interface Campaign {
  id: string;
  name: string;
  description: string;
  status: string;
  department_ids: string;
  start_date: string | null;
  target_date: string | null;
}

interface PublishOverlay {
  id: string;
  task_id: string | null;
  status: string;
  error: string | null;
  retry_at: string | null;
  attempt_count?: number | null;
}

interface CampaignTask {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  department_id: string | null;
  persona_id: string | null;
  persona_name: string | null;
  persona_mode: 'leadership' | 'coaching' | null;
  persona_score: number | null;
  secondary_persona_id: string | null;
  secondary_persona_name: string | null;
  assignedAgent?: { id: string; name: string; avatar_emoji: string } | null;
  // F36 — canonical-task-derived board truth (no forked board state).
  dispatch_attempts?: number | null;
  block_reason?: string | null;
  block_needs?: string | null;
  parent_task_id?: string | null;
  publish?: PublishOverlay | null;
}

// Polling fallback cadence while the page is visible (F36: 15–30s band).
const POLL_INTERVAL_MS = 20_000;
// A last-sync older than this shows the stale banner.
const STALE_AFTER_MS = 60_000;

// ---------------------------------------------------------------------------
// Live sync hook — company-scoped task/publish events + polling fallback
// ---------------------------------------------------------------------------

interface LiveSyncState {
  lastSyncedAt: number | null;
  connected: boolean;
  stale: boolean;
}

/**
 * F36 live refresh: an SSE subscription to /api/events/stream filtered to the
 * board-relevant event types, a refetch on every genuine (re)connect, and a
 * visible-only polling fallback (~20s) so a worker transition appears without
 * a browser refresh and missed deltas are reconciled on reconnect or by the
 * next poll. `refresh` is a stable callback from the page.
 */
function useBoardLiveSync(refresh: () => Promise<void>, enabled: boolean): LiveSyncState {
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [connected, setConnected] = useState(false);
  const [nowTick, setNowTick] = useState(() => Date.now());
  // Keep the latest refresh callback WITHOUT touching it during render: the
  // effect below reads it from the ref, and the ref is refreshed in an effect
  // (the react-hooks/refs rule forbids ref writes during render).
  const refreshRef = useRef(refresh);
  useEffect(() => { refreshRef.current = refresh; }, [refresh]);

  const markSynced = useCallback(() => setLastSyncedAt(Date.now()), []);

  // SSE subscription with reconnect refetch.
  useEffect(() => {
    if (!enabled) return;
    let hasConnected = false;
    const es = new EventSource('/api/events/stream');

    const isBoardEvent = (type: string, payload: unknown): boolean => {
      if (
        type === 'task_created' || type === 'task_updated' || type === 'task_deleted'
      ) return true;
      // F01-D3 per-company publish events carry company_id in the TYPE; the
      // board shows every publish row the company-scoped overlay fetch returns,
      // so any publish_state event triggers a refetch (the refetch itself is
      // company-scoped — no cross-company data can land).
      if (type.startsWith('publish_state:') || type.startsWith('publish_queued:')) return true;
      void payload;
      return false;
    };

    es.onopen = () => {
      setConnected(true);
      // Refetch on EVERY open (first + genuine reconnects): the refetch is a
      // cheap company-scoped query and reconciles any deltas missed while down.
      if (hasConnected) void refreshRef.current();
      hasConnected = true;
      void refreshRef.current().then(markSynced);
    };
    es.onmessage = (event) => {
      try {
        if (!event.data || event.data.startsWith(':')) return;
        const sse = JSON.parse(event.data) as { type: string; payload?: unknown };
        if (!isBoardEvent(sse.type, sse.payload)) return;
        void refreshRef.current().then(markSynced);
      } catch {
        // malformed event — ignore; the poll reconciles.
      }
    };
    es.onerror = () => {
      // Native EventSource auto-reconnects; mark offline until it does.
      setConnected(false);
    };
    return () => {
      es.close();
      setConnected(false);
    };
  }, [enabled, markSynced]);

  // Polling fallback: fetch while the tab is visible, pause when hidden.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const poll = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        await refreshRef.current();
        if (!cancelled) markSynced();
      } catch {
        // fetch failure → stale banner via lastSyncedAt age; next poll retries.
      }
    };
    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') void poll(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, markSynced]);

  // Staleness ticker + offline detection from lastSyncedAt age.
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);

  const stale = lastSyncedAt !== null && nowTick - lastSyncedAt > STALE_AFTER_MS;
  const offline = connected === false && (lastSyncedAt === null || nowTick - lastSyncedAt > POLL_INTERVAL_MS * 2);
  return { lastSyncedAt, connected, stale: stale || offline };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function CampaignKanbanPage() {
  const router = useRouter();
  const params = useParams();
  const campaignId = params.id as string;

  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [tasks, setTasks]       = useState<CampaignTask[]>([]);
  const [publishRows, setPublishRows] = useState<PublishOverlay[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [deptFilter, setDeptFilter] = useState<string>('all');

  const fetchTasks = useCallback(async () => {
    if (!campaignId) return;
    try {
      setError(null);
      const res = await fetch(`/api/tasks?campaign_id=${campaignId}`, { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to fetch tasks');
      const data: any = await res.json();
      const list: any[] = Array.isArray(data) ? data : (data.tasks || []);
      setTasks(list.map((t: any) => ({
        id: t.id, title: t.title, status: t.status, priority: t.priority,
        department_id: t.department_id,
        persona_id: t.persona_id, persona_name: t.persona_name,
        persona_mode: t.persona_mode, persona_score: t.persona_score,
        secondary_persona_id: t.secondary_persona_id,
        secondary_persona_name: t.secondary_persona_name,
        dispatch_attempts: t.dispatch_attempts,
        block_reason: t.block_reason,
        block_needs: t.block_needs,
        parent_task_id: t.parent_task_id,
        assignedAgent: t.assigned_agent
          ? { id: t.assigned_agent.id, name: t.assigned_agent.name, avatar_emoji: t.assigned_agent.avatar_emoji }
          : null,
      })));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  }, [campaignId]);

  // Company-scoped publish overlay (F03/F36): canonical publish_queue rows for
  // this company, joined onto cards by task linkage — derived board state,
  // never a fork.
  const fetchPublishRows = useCallback(async () => {
    try {
      const res = await fetch('/api/skill-35/publish?limit=100', { cache: 'no-store' });
      if (!res.ok) return;
      const data: any = await res.json();
      const rows: any[] = Array.isArray(data?.publishes) ? data.publishes : [];
      setPublishRows(rows.map((r) => ({
        id: r.id,
        task_id: r.task_id ?? r.cc_task_id ?? null,
        status: r.status,
        error: r.error ?? null,
        retry_at: r.retry_at ?? null,
        attempt_count: r.attempt_count ?? null,
      })));
    } catch {
      // Overlay is best-effort; board cards still render from canonical tasks.
    }
  }, []);

  const refresh = useCallback(async () => {
    await Promise.all([fetchTasks(), fetchPublishRows()]);
    setLoading(false);
  }, [fetchTasks, fetchPublishRows]);

  useEffect(() => {
    if (!campaignId) return;
    fetch(`/api/campaigns/${campaignId}`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('Failed to load campaign'))))
      .then(data => setCampaign(data.campaign))
      .catch(() => setError('Failed to load campaign'));
  }, [campaignId]);

  // Defer the initial refetch one tick so setLoading during the effect body
  // never fires a cascading synchronous setState (react-hooks rule); the poll
  // fallback inside useBoardLiveSync also refetches immediately on mount.
  useEffect(() => {
    const t = setTimeout(() => { void refresh(); }, 0);
    return () => clearTimeout(t);
  }, [refresh]);

  const live = useBoardLiveSync(refresh, Boolean(campaignId));

  const publishByTask = useMemo(() => {
    const map = new Map<string, PublishOverlay>();
    for (const p of publishRows) {
      if (p.task_id && !map.has(p.task_id)) map.set(p.task_id, p);
    }
    return map;
  }, [publishRows]);

  const departments = useMemo(() => {
    const seen = new Set<string>();
    tasks.forEach(t => { if (t.department_id) seen.add(t.department_id); });
    return Array.from(seen);
  }, [tasks]);

  const filteredTasks = useMemo(() =>
    deptFilter === 'all' ? tasks : tasks.filter(t => t.department_id === deptFilter),
    [tasks, deptFilter]
  );

  const columns = useMemo(() => {
    const result: Record<KanbanColumn, CampaignTask[]> = {
      new: [], queued: [], in_progress: [], attention: [], review: [], done: [],
    };
    for (const card of filteredTasks) {
      const col = columnForStatus(card.status);
      result[col].push(card);
    }
    return result;
  }, [filteredTasks]);

  const progress = useMemo(() => {
    if (tasks.length === 0) return 0;
    const done = tasks.filter(t => columnForStatus(t.status) === 'done').length;
    return Math.round((done / tasks.length) * 100);
  }, [tasks]);

  // The "Synced Ns ago" label: computed in an EFFECT (Date.now is impure and
  // cannot run during render); renderPulse's 5s tick recomputes it.
  const [lastSyncLabel, setLastSyncLabel] = useState<string | null>(null);
  useEffect(() => {
    const compute = () => {
      if (!live.lastSyncedAt) { setLastSyncLabel(null); return; }
      const secs = Math.max(0, Math.round((Date.now() - live.lastSyncedAt) / 1000));
      setLastSyncLabel(secs < 5 ? 'just now' : `${secs}s ago`);
    };
    compute();
    const t = setInterval(compute, 5_000);
    return () => clearInterval(t);
  }, [live.lastSyncedAt]);

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="sticky top-0 z-50 bg-white border-b border-gray-200 px-6 py-3 flex items-center gap-4">
        <button
          onClick={() => router.push('/ceo-board')}
          className="flex items-center gap-2 px-5 py-2.5 bg-gray-900 text-white text-base font-semibold rounded-lg hover:bg-gray-800 transition-colors"
        >
          <ArrowLeft className="h-5 w-5" />
          Back
        </button>

        <div className="h-8 w-px bg-gray-200" />

        <Breadcrumb
          items={[
            { label: 'Home', href: '/' },
            { label: 'CEO Board', href: '/ceo-board' },
            { label: campaign?.name || 'Campaign' },
          ]}
        />

        <div className="flex items-center gap-3 ml-auto">
          <Target className="h-5 w-5 text-indigo-500" />
          <h1 className="text-xl font-bold text-gray-900">
            {campaign?.name || 'Campaign'}
          </h1>
          <span className="text-sm text-gray-500">
            {tasks.length} task{tasks.length !== 1 ? 's' : ''}
          </span>
        </div>
      </header>

      {/* F36 — sync status strip: live/polling, last sync, stale/offline warning */}
      <div className="bg-white border-b border-gray-100 px-6 py-2 flex items-center gap-3 text-xs">
        {live.stale ? (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-red-50 text-red-700 font-medium">
            <WifiOff className="h-3.5 w-3.5" /> Offline or stale — showing last known board
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 font-medium">
            <span className={`h-2 w-2 rounded-full ${live.connected ? 'bg-emerald-500' : 'bg-amber-400'}`} />
            {live.connected ? 'Live' : 'Polling'}
          </span>
        )}
        <span className="text-gray-400">
          Synced {lastSyncLabel || 'never'}
        </span>
        <button
          onClick={() => void refresh()}
          className="ml-auto inline-flex items-center gap-1 text-gray-500 hover:text-gray-800"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </button>
      </div>

      <div className="bg-white border-b border-gray-100 px-6 py-3 flex items-center gap-6">
        <div className="flex items-center gap-3 flex-1 max-w-sm">
          <span className="text-xs text-gray-500 font-medium whitespace-nowrap">
            {progress}% complete
          </span>
          <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-emerald-500 rounded-full transition-all duration-500"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>

        <div className="flex items-center gap-2 ml-auto flex-wrap">
          <span className="text-xs text-gray-400">Filter:</span>
          <button
            onClick={() => setDeptFilter('all')}
            className={`text-xs px-3 py-1 rounded-full font-medium transition-colors ${
              deptFilter === 'all'
                ? 'bg-gray-900 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            All Departments
          </button>
          {departments.map(dept => (
            <button
              key={dept}
              onClick={() => setDeptFilter(dept)}
              className={`text-xs px-3 py-1 rounded-full font-medium capitalize transition-colors ${
                deptFilter === dept
                  ? 'bg-indigo-600 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {dept}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="mx-6 mt-4 flex items-center gap-2 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          {error}
        </div>
      )}

      <main className="p-6">
        {loading ? (
          <div className="flex items-center justify-center h-96">
            <Loader2 className="h-10 w-10 animate-spin text-gray-400" />
          </div>
        ) : (
          <div className="flex gap-4 h-[calc(100vh-11rem)] overflow-x-auto">
            {KANBAN_COLUMNS.map(col => {
              const cards = columns[col.key];
              return (
                <div
                  key={col.key}
                  className={`flex flex-col flex-1 min-w-[14rem] rounded-xl ${col.color} border border-gray-200`}
                >
                  <div className="px-4 py-3 border-b border-gray-200/80 flex items-center justify-between">
                    <span className="text-sm font-semibold text-gray-700">{col.label}</span>
                    <span className="text-xs font-medium text-gray-500 bg-white/80 px-2.5 py-0.5 rounded-full">
                      {cards.length}
                    </span>
                  </div>
                  <div className="flex-1 overflow-y-auto p-3 space-y-2">
                    <AnimatePresence mode="popLayout">
                      {cards.length === 0 ? (
                        <div className="text-xs text-gray-400 text-center py-6">No tasks</div>
                      ) : (
                        cards.map(card => (
                          <CampaignTaskCard
                            key={card.id}
                            card={card}
                            publish={publishByTask.get(card.id) ?? null}
                          />
                        ))
                      )}
                    </AnimatePresence>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}

function CampaignTaskCard({ card, publish }: { card: CampaignTask; publish: PublishOverlay | null }) {
  const priorityStyle = PRIORITY_STYLES[card.priority];
  const isBlocked = card.status === 'blocked';

  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.2 }}
      className="bg-white rounded-lg border border-gray-200 p-4 shadow-sm hover:shadow-md hover:border-gray-300 transition-shadow"
    >
      <p className="text-sm font-medium text-gray-900 leading-snug mb-2.5">{card.title}</p>

      <div className="flex items-center gap-1.5 flex-wrap">
        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ${priorityStyle.bg} ${priorityStyle.text}`}>
          {priorityStyle.label}
        </span>

        {card.department_id && (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-indigo-50 text-indigo-700 capitalize">
            {card.department_id}
          </span>
        )}

        {/* F36 — blocked cards show WHY + who must act, never a bare review lane */}
        {isBlocked && card.block_reason && (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">
            {card.block_reason}
          </span>
        )}

        {(card.dispatch_attempts ?? 0) > 0 && (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-orange-50 text-orange-700">
            retries: {card.dispatch_attempts}
          </span>
        )}

        {card.persona_id ? (
          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${
            card.persona_mode === 'coaching'
              ? 'bg-purple-100 text-purple-700 border-purple-200'
              : 'bg-blue-100 text-blue-700 border-blue-200'
          }`}>
            {card.persona_mode === 'coaching' ? '🗣' : '🎯'}{' '}{card.persona_name || card.persona_id}
          </span>
        ) : card.status === 'in_progress' ? (
          <span className="text-xs text-gray-300 italic">selecting persona...</span>
        ) : null}

        {card.secondary_persona_id && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border bg-purple-100 text-purple-700 border-purple-200">
            🗣 {card.secondary_persona_name || card.secondary_persona_id}
          </span>
        )}
        {card.secondary_persona_id && (
          <span className="text-xs text-gray-400">hybrid</span>
        )}
      </div>

      {/* F36 — canonical publish overlay (per-account/delivery result), derived
          from the company-scoped publish_queue rows, never a forked state. */}
      {publish && (
        <div className="mt-2 flex items-center gap-1.5 flex-wrap">
          <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ${
            publish.status === 'published' || publish.status === 'done'
              ? 'bg-emerald-100 text-emerald-700'
              : publish.status === 'failed'
                ? 'bg-red-100 text-red-700'
                : 'bg-blue-50 text-blue-700'
          }`}>
            publish: {publish.status}
          </span>
          {publish.attempt_count ? (
            <span className="text-xs text-gray-400">attempt {publish.attempt_count}</span>
          ) : null}
          {publish.retry_at && publish.status === 'retrying' ? (
            <span className="text-xs text-gray-400">retry by {new Date(publish.retry_at).toLocaleTimeString()}</span>
          ) : null}
          {publish.error && publish.status === 'failed' ? (
            <span className="text-xs text-red-500 truncate max-w-[12rem]" title={publish.error}>{publish.error}</span>
          ) : null}
        </div>
      )}

      {card.assignedAgent && (
        <div className="flex items-center gap-2 mt-3 pt-2.5 border-t border-gray-100">
          <span className="text-base">{card.assignedAgent.avatar_emoji}</span>
          <span className="text-xs text-gray-600 font-medium">{card.assignedAgent.name}</span>
        </div>
      )}
    </motion.div>
  );
}

const PRIORITY_STYLES: Record<TaskPriority, { bg: string; text: string; label: string }> = {
  critical: { bg: 'bg-red-100',    text: 'text-red-700',    label: 'Critical' },
  high:     { bg: 'bg-orange-100', text: 'text-orange-700', label: 'High'     },
  medium:   { bg: 'bg-yellow-100', text: 'text-yellow-700', label: 'Medium'   },
  low:      { bg: 'bg-gray-100',   text: 'text-gray-600',   label: 'Low'      },
};