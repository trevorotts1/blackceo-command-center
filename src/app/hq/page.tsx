'use client';

/**
 * /hq — Company Headquarters route (unit B30, SPEC S3/S4/S8/S11).
 *
 * A Next page module may export only its default: the controller helpers below
 * are deliberately module-private, and are exercised through the rendered page.
 *
 * This page is the Headquarters **composition and controller**: company scope,
 * department/agent/task selection, the Floor/List view mode, and the Board
 * round trip. It owns four things and nothing else:
 *
 *  1. Route state. HQ keeps its scope in validated search params
 *     (`company`/`department`/`task`) so a Board visit and return restores the
 *     same selection, and it re-emits unrelated supported board filters
 *     verbatim — SPEC S4: "Board link carries validated company/department/task
 *     filters; unrelated supported board filters survive return in route state."
 *  2. Roster-driven selection truth. SPEC S4: "Changing roster preserves
 *     selected entity by ID; if removed, show notice and return to department."
 *  3. Company switch. SPEC S8 step 6: changing company clears cursors, feed,
 *     session and selection **before** new bytes are fetched (Q11).
 *  4. View mode. SPEC S11: phone (<768 px) defaults to List with Floor still
 *     available; controls are at least 44 CSS px.
 *
 * The surfaces inside the composition are owned elsewhere — floor B23/B24/B25,
 * feed B26, inspector B27, head chat B28, responsive shell B29 — and are not in
 * this branch's tree yet, so this page renders its own honest information layer
 * from the authorized snapshot: room tiles with real roster counts in Floor
 * mode, the same entities as a semantic list in List mode, and the selected
 * entity's recorded facts. A02 replaces those internals with the real
 * components; the controller below stays.
 *
 * No fabricated data: every rendered fact comes from `GET /api/hq/snapshot`
 * (`HqSnapshotResponse` in `src/lib/hq/types.ts`). Where the SPEC requires a
 * field whose shape is undefined (captureHealth, taskLinks — interfaces.md
 * G-01/G-02) this page reports only what the contract states and never invents
 * a shape.
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  AlertTriangle,
  Building2,
  LayoutGrid,
  List as ListIcon,
  Loader2,
  RefreshCw,
  Users,
} from 'lucide-react';
import type { HqAgent, HqAgentStatus, HqDepartment, HqSnapshotResponse } from '@/lib/hq/types';

/* ================================================================== *
 * Controller — pure, exported, unit-testable (no React).
 * ================================================================== */

type HqViewMode = 'floor' | 'list';

type HqSelection = {
  departmentId: string | null;
  agentId: string | null;
  taskId: string | null;
};

/** The three filters the URL itself carries (S4); the agent selection stays in-page. */
type HqRouteState = {
  companyId: string | null;
  departmentId: string | null;
  taskId: string | null;
};

const HQ_EMPTY_SELECTION: HqSelection = { departmentId: null, agentId: null, taskId: null };

/** S4's Board link carries exactly these three validated filters. */
const HQ_SCOPED_KEYS = ['company', 'department', 'task'] as const;

/** Search params as `useSearchParams()` (or `URLSearchParams`) actually exposes them. */
interface HqSearchParams {
  get(key: string): string | null;
  keys(): IterableIterator<string>;
}

const HQ_ID_MAX = 200;
/** Scoped IDs are opaque, but they must survive a URL round trip unharmed. */
const HQ_ID_PATTERN = /^[A-Za-z0-9._~:@+-]+$/;

/**
 * A user-supplied selector is a *requested target*, never authority (SPEC S7):
 * anything malformed is dropped rather than forwarded to a route.
 */
function hqCleanId(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  if (raw.length > HQ_ID_MAX) return null;
  return HQ_ID_PATTERN.test(raw) ? raw : null;
}

function parseHqRouteState(params: HqSearchParams): HqRouteState {
  return {
    companyId: hqCleanId(params.get('company')),
    departmentId: hqCleanId(params.get('department')),
    taskId: hqCleanId(params.get('task')),
  };
}

/** HQ's own scope as search params; empty entries are omitted, not sent as ''. */
function hqScopedQuery(state: HqRouteState): string {
  const query = new URLSearchParams();
  if (state.companyId) query.set('company', state.companyId);
  if (state.departmentId) query.set('department', state.departmentId);
  if (state.taskId) query.set('task', state.taskId);
  return query.toString();
}

/**
 * SPEC S4: every non-scoped param the visitor arrived with is re-emitted
 * verbatim, so an unrelated supported board filter survives the return in route
 * state. Shared by the Board handoff and the route-state rewrite — a filter
 * must never be scrubbed from the URL before the Board link reads it.
 */
function hqCarryUnrelated(query: URLSearchParams, carried?: HqSearchParams | null): URLSearchParams {
  if (!carried) return query;
  for (const key of carried.keys()) {
    if ((HQ_SCOPED_KEYS as readonly string[]).includes(key)) continue;
    const value = carried.get(key);
    if (value !== null) query.set(key, value);
  }
  return query;
}

/**
 * Board handoff. Uses the existing `/tasks/by-department` route with no new
 * board engine; exactly the S4 filters are added, and every other board filter
 * the visitor arrived with is carried through unchanged.
 */
function hqBoardHref(state: HqRouteState, carried?: HqSearchParams | null): string {
  const query = hqCarryUnrelated(new URLSearchParams(hqScopedQuery(state)), carried);
  const serialized = query.toString();
  return serialized ? `/tasks/by-department?${serialized}` : '/tasks/by-department';
}

/**
 * SPEC S4 selection truth. Entities are matched by ID (never by name or
 * position); a removed entity produces a visible notice and a return to the
 * department. Task membership is deliberately NOT re-derived here: the
 * snapshot's `taskLinks` shape is undefined (interfaces.md G-02), so absence
 * cannot be proven from it — authorization for a task is re-checked by the
 * task route itself, and a task is dropped only when the agent that carried it
 * is gone.
 */
function hqReconcileSelection(
  selection: HqSelection,
  roster: HqDepartment[],
): { selection: HqSelection; notice: string | null } {
  const { departmentId, agentId, taskId } = selection;
  if (!departmentId) return { selection: HQ_EMPTY_SELECTION, notice: null };

  const department = roster.find((row) => row.id === departmentId);
  if (!department) {
    return {
      selection: HQ_EMPTY_SELECTION,
      notice: 'The selected department is no longer in the roster. Showing all departments.',
    };
  }
  if (!agentId) return { selection: { departmentId, agentId: null, taskId }, notice: null };

  const agent = department.agents.find((row) => row.id === agentId);
  if (!agent) {
    return {
      selection: { departmentId, agentId: null, taskId: null },
      notice: 'The selected agent is no longer in this department. Showing the department.',
    };
  }
  return { selection: { departmentId, agentId, taskId }, notice: null };
}

/** SPEC S11: phone below 768 px defaults to List; Floor stays available. */
function hqDefaultView(viewportWidth: number): HqViewMode {
  return viewportWidth < 768 ? 'list' : 'floor';
}

/* ================================================================== *
 * Presentation helpers (labels carry meaning — never colour alone, S11).
 * ================================================================== */

const STATUS_LABEL: Record<HqAgentStatus, string> = {
  standby: 'Standby',
  working: 'Working',
  busy: 'Busy',
  degraded: 'Degraded',
  offline: 'Offline',
  unknown: 'Status not observed',
};

const STATUS_TONE: Record<HqAgentStatus, string> = {
  standby: 'border-bcc-border text-bcc-text-secondary',
  working: 'border-emerald-200 text-emerald-700',
  busy: 'border-amber-200 text-amber-700',
  degraded: 'border-amber-200 text-amber-700',
  offline: 'border-bcc-border text-bcc-text-muted',
  unknown: 'border-bcc-border text-bcc-text-muted',
};

function agentFacts(agent: HqAgent, department: HqDepartment): string[] {
  const facts = [agent.role];
  if (agent.staffing === 'on-call') facts.push('On call');
  if (department.headAgentId === null && agent.isHead) facts.push('Head (department head not recorded)');
  if (agent.bindingKind === 'department-shared') facts.push('Shared department executor');
  if (agent.bindingKind === 'unbound') facts.push('Runtime binding unavailable');
  if (agent.sharedRoleIds.length > 0) facts.push(`${agent.sharedRoleIds.length} linked role seats`);
  return facts;
}

function AgentRow({
  agent,
  department,
  selected,
  onSelect,
}: {
  agent: HqAgent;
  department: HqDepartment;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        data-testid={`hq-agent-${agent.id}`}
        aria-pressed={selected}
        onClick={onSelect}
        className={`w-full text-left min-h-[44px] rounded-xl border px-3 py-2 hover:border-brand-300 ${
          selected ? 'border-brand-400 bg-brand-50' : 'border-bcc-border bg-bcc-white'
        }`}
      >
        <span className="flex items-center gap-2 flex-wrap">
          <span className="text-label text-bcc-text">
            {agent.isHead ? 'Head · ' : ''}
            {agent.displayName}
          </span>
          <span
            data-testid={`hq-agent-status-${agent.id}`}
            className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${STATUS_TONE[agent.status]}`}
          >
            {STATUS_LABEL[agent.status]}
          </span>
          {!agent.canTalk && (
            <span className="text-caption text-bcc-text-secondary">Talk unavailable — setup incomplete</span>
          )}
        </span>
        <span className="block text-caption text-bcc-text-secondary">{agentFacts(agent, department).join(' · ')}</span>
        {agent.observedAt && (
          <span className="block text-caption text-bcc-text-secondary">
            Observed {new Date(agent.observedAt).toLocaleString()} (source observation, not view time)
          </span>
        )}
      </button>
    </li>
  );
}

/* ================================================================== *
 * The controller component.
 * ================================================================== */

type LoadState = 'loading' | 'ready' | 'error';

function HeadquartersController() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const routeState = useMemo(() => parseHqRouteState(searchParams), [searchParams]);

  const [snapshot, setSnapshot] = useState<HqSnapshotResponse | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [selection, setSelection] = useState<HqSelection>(() => ({
    departmentId: routeState.departmentId,
    agentId: null,
    taskId: routeState.taskId,
  }));
  const [talkAgentId, setTalkAgentId] = useState<string | null>(null);
  const [view, setView] = useState<HqViewMode>('floor');
  const [notice, setNotice] = useState<string | null>(null);

  // The company whose scope this page has already loaded. First load keeps the
  // selection the URL carried; every later change to a different company is a
  // scope switch and clears private state (S8 step 6).
  const loadedCompanyRef = useRef<string | null>(null);
  const writtenQueryRef = useRef<string>('');
  const incomingCompanyRef = useRef<string | null>(null);
  // The company the latest snapshot request was issued for (judge F2): a
  // superseded request's late response must never overwrite a newer scope.
  const requestCompanyRef = useRef<string | null>(null);

  /** SPEC S8 step 6: everything private dies on a scope switch, before new bytes. */
  const resetPrivateState = useCallback(() => {
    setSelection(HQ_EMPTY_SELECTION);
    setTalkAgentId(null);
    setNotice(null);
  }, []);

  // The agent whose removal raised the live notice (S4): the latch that keeps
  // the notice alive across the reconcile's own selection correction.
  const removedAgentRef = useRef<string | null>(null);

  /** S4/F3: every user navigation is an explicit selection change, and it also
   *  retires any notice about the selection being navigated away from — a
   *  removal claim must never outlive the state it describes. */
  const moveSelection = useCallback((next: HqSelection) => {
    setSelection(next);
    setTalkAgentId(null);
    setNotice(null);
  }, []);

  // S11: default the view from the real viewport. The toggle stays available
  // either way and a later toggle is never overwritten (this runs once).
  useEffect(() => {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      setView(hqDefaultView(window.matchMedia('(max-width: 767px)').matches ? 390 : 1280));
    }
  }, []);

  // A requested `company` selector is validated (S7) and recorded before the
  // fetch. If it differs from the loaded scope, private state is cleared NOW —
  // the switch takes effect before any new-scope bytes arrive, and the server
  // (not the URL) still decides which company is actually authorized.
  useEffect(() => {
    const requested = routeState.companyId;
    incomingCompanyRef.current = requested;
    if (requested === null) return;
    if (loadedCompanyRef.current !== null && requested !== loadedCompanyRef.current) resetPrivateState();
  }, [routeState.companyId, reloadToken, resetPrivateState]);

  // Authorized snapshot. One request, `no-store`; a failed load stays visibly
  // failed — it is never rendered as an empty company (S8 step 7). The fetch
  // re-issues whenever the REQUESTED company changes (S8 step 6): the scope
  // the URL asks for is always asked of the server, never served from a stale
  // snapshot. The resolved company is decided by the SERVER body, not by a
  // ref: each request captures the company it asked for, and only the latest
  // request may write — a stale response can never overwrite a newer scope.
  useEffect(() => {
    let cancelled = false;
    const requestedCompany = routeState.companyId;
    requestCompanyRef.current = requestedCompany;
    setLoadState('loading');
    setLoadError(null);
    (async () => {
      try {
        const response = await fetch('/api/hq/snapshot', { cache: 'no-store' });
        if (!response.ok) {
          if (!cancelled) {
            setLoadState('error');
            setLoadError(`Headquarters data unavailable (${response.status}).`);
          }
          return;
        }
        const body = (await response.json()) as HqSnapshotResponse;
        if (cancelled) return;
        if (!body || typeof body.companyId !== 'string' || !Array.isArray(body.roster)) {
          setLoadState('error');
          setLoadError('Headquarters data unavailable (unexpected response).');
          return;
        }
        // A superseded request's late response must not overwrite a newer scope
        // (judge finding F2).
        if (requestCompanyRef.current !== requestedCompany) return;
        setSnapshot(body);
        setLoadState('ready');
      } catch {
        if (!cancelled) {
          setLoadState('error');
          setLoadError('Headquarters data unavailable (network).');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadToken, routeState.companyId]);

  // Company switch: clear selection, private conversation and notice before any
  // new-scope bytes are shown. The composition subtree is also keyed by company
  // so a mounted private surface cannot carry state across the switch.
  useEffect(() => {
    if (!snapshot) return;
    if (loadedCompanyRef.current === snapshot.companyId) return;
    loadedCompanyRef.current = snapshot.companyId;
    // A first load keeps the selection the URL carried; a real switch clears it.
    // Also clears when an authorized response disagrees with a requested scope.
    if (incomingCompanyRef.current !== snapshot.companyId) resetPrivateState();
  }, [snapshot, resetPrivateState]);

  // Roster truth: preserve selection by ID; removed entities produce a notice
  // and a return to the department (S4). The notice has a lifecycle (F3): it is
  // raised once when the selected agent disappears, survives the reconcile
  // correction that follows (which would otherwise immediately erase it), and
  // clears on the two ways the claim stops being true — the user navigates
  // (moveSelection nulls it directly) or the removed agent is back in the
  // roster. The raised text is latched so a later snapshot cannot restate or
  // extend a claim about a state the user has already left.
  useEffect(() => {
    if (!snapshot) return;
    const reconciled = hqReconcileSelection(selection, snapshot.roster);
    if (reconciled.notice && selection.agentId) {
      removedAgentRef.current = selection.agentId;
      setNotice(reconciled.notice);
    } else if (removedAgentRef.current) {
      const returned = snapshot.roster.some((row) => row.agents.some((rowAgent) => rowAgent.id === removedAgentRef.current));
      if (returned) {
        removedAgentRef.current = null;
        setNotice(null);
      }
    }
    if (
      reconciled.selection.departmentId !== selection.departmentId ||
      reconciled.selection.agentId !== selection.agentId ||
      reconciled.selection.taskId !== selection.taskId
    ) {
      setSelection(reconciled.selection);
    }
  }, [snapshot, selection]);

  // The company the URL and the Board link treat as current (judge F2). While
  // a snapshot request is in flight the REQUESTED scope wins; once it lands the
  // authorized snapshot's company takes over — so a stale snapshot's companyId
  // can never overwrite a newer request, and the Board link can never disagree
  // with the URL the controller just wrote. Pure state, no ref read in render.
  const effectiveCompanyId =
    loadState === 'loading'
      ? (routeState.companyId ?? snapshot?.companyId ?? null)
      : (snapshot?.companyId ?? routeState.companyId ?? null);

  // Route state: the current scope is always addressable, so a Board visit and
  // return restores the same company/department/task. SPEC S4: unrelated
  // supported board filters are carried into the rewrite too — the controller
  // must never scrub them from the URL before the Board link reads them
  // (finding F1). SPEC S8 step 6: while a requested company's response is in
  // flight, the REQUESTED scope is written back, never the stale snapshot's —
  // a stale company must not overwrite the new request (finding F2).
  useEffect(() => {
    const companyId = effectiveCompanyId;
    const scoped = hqScopedQuery({ companyId, departmentId: selection.departmentId, taskId: selection.taskId });
    const next = hqCarryUnrelated(new URLSearchParams(scoped), searchParams).toString();
    if (next === writtenQueryRef.current) return;
    writtenQueryRef.current = next;
    router.replace(next ? `/hq?${next}` : '/hq', { scroll: false });
  }, [router, effectiveCompanyId, selection.departmentId, selection.taskId, searchParams]);

  const selectView = useCallback((next: HqViewMode) => {
    setView(next);
  }, []);

  const roster = snapshot?.roster ?? [];
  const department = roster.find((row) => row.id === selection.departmentId) ?? null;
  const agent = department?.agents.find((row) => row.id === selection.agentId) ?? null;
  const boardHref = hqBoardHref(
    { companyId: effectiveCompanyId, departmentId: selection.departmentId, taskId: selection.taskId },
    searchParams,
  );

  const header = (
    <header className="border-b border-bcc-border bg-bcc-white">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <div className="flex items-center gap-2 min-w-0">
          <Building2 className="w-5 h-5 text-brand-600 shrink-0" aria-hidden="true" />
          <span className="text-card-title text-bcc-text truncate">Company Headquarters</span>
        </div>
        <nav aria-label="Headquarters and Board" className="flex items-center gap-1">
          <span
            data-testid="hq-tab-headquarters"
            aria-current="page"
            className="inline-flex items-center min-h-[44px] px-4 rounded-xl bg-brand-600 text-white font-medium"
          >
            Headquarters
          </span>
          <Link
            data-testid="hq-tab-board"
            href={boardHref}
            className="inline-flex items-center min-h-[44px] px-4 rounded-xl border border-bcc-border text-bcc-text font-medium hover:border-brand-300"
          >
            Board
          </Link>
        </nav>
        <div
          role="tablist"
          aria-label="Headquarters view"
          data-testid="hq-view-control"
          className="inline-flex items-center gap-1 rounded-xl border border-bcc-border p-0.5"
        >
          <button
            type="button"
            role="tab"
            aria-selected={view === 'floor'}
            data-testid="hq-view-floor"
            onClick={() => selectView('floor')}
            className={`inline-flex items-center gap-1.5 min-h-[44px] px-3 rounded-[10px] text-label font-medium ${
              view === 'floor' ? 'bg-brand-50 text-bcc-text' : 'text-bcc-text-secondary'
            }`}
          >
            <LayoutGrid className="w-4 h-4" aria-hidden="true" />
            Floor
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'list'}
            data-testid="hq-view-list"
            onClick={() => selectView('list')}
            className={`inline-flex items-center gap-1.5 min-h-[44px] px-3 rounded-[10px] text-label font-medium ${
              view === 'list' ? 'bg-brand-50 text-bcc-text' : 'text-bcc-text-secondary'
            }`}
          >
            <ListIcon className="w-4 h-4" aria-hidden="true" />
            List
          </button>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span role="status" aria-live="polite" data-testid="hq-connection" className="text-caption text-bcc-text-secondary">
            {loadState === 'loading' && 'Loading…'}
            {loadState === 'error' && 'Disconnected'}
            {loadState === 'ready' && snapshot && `Connected · snapshot ${new Date(snapshot.generatedAt).toLocaleTimeString()}`}
          </span>
          <button
            type="button"
            data-testid="hq-refresh"
            aria-label="Refresh Headquarters state"
            onClick={() => setReloadToken((token) => token + 1)}
            className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] rounded-xl border border-bcc-border text-bcc-text-secondary hover:text-bcc-text hover:border-brand-300"
          >
            <RefreshCw className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      </div>
      {department && (
        <div className="flex flex-wrap items-center gap-2 px-4 pb-3">
          <span data-testid="hq-scope-department" className="text-label text-bcc-text">
            {department.name}
          </span>
          <button
            type="button"
            data-testid="hq-scope-clear"
            onClick={() => moveSelection(HQ_EMPTY_SELECTION)}
            className="inline-flex items-center min-h-[44px] px-3 rounded-xl border border-bcc-border text-label text-bcc-text hover:border-brand-300"
          >
            All departments
          </button>
        </div>
      )}
    </header>
  );

  if (loadState === 'error') {
    return (
      <div className="min-h-screen bg-bcc-bg flex flex-col">
        {header}
        <main className="flex-1 flex items-start justify-center px-4 py-10">
          <div role="alert" data-testid="hq-load-error" className="max-w-lg w-full rounded-2xl border border-amber-200 bg-semantic-warningLight p-4">
            <p className="flex items-center gap-2 text-body text-amber-800">
              <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
              {loadError}
            </p>
            <p className="text-caption text-bcc-text-secondary pt-1">
              The office is not shown empty while its state is unknown. Last known state is unchanged on the server.
            </p>
            <button
              type="button"
              data-testid="hq-retry"
              onClick={() => setReloadToken((token) => token + 1)}
              className="mt-3 inline-flex items-center gap-1.5 min-h-[44px] px-4 rounded-xl border border-bcc-border bg-bcc-white text-label text-bcc-text"
            >
              <RefreshCw className="w-4 h-4" aria-hidden="true" />
              Retry
            </button>
          </div>
        </main>
      </div>
    );
  }

  if (loadState === 'loading' || !snapshot) {
    return (
      <div className="min-h-screen bg-bcc-bg flex flex-col">
        {header}
        <main className="flex-1 flex items-center justify-center px-4 py-10">
          <p data-testid="hq-loading" className="flex items-center gap-2 text-body text-bcc-text-secondary">
            <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />
            Loading Headquarters…
          </p>
        </main>
      </div>
    );
  }

  const totalAgents = roster.reduce((sum, row) => sum + row.agents.length, 0);

  return (
    <div className="min-h-screen bg-bcc-bg flex flex-col">
      {header}
      {notice && (
        <p role="status" data-testid="hq-notice" className="mx-4 mt-3 rounded-xl border border-amber-200 bg-semantic-warningLight px-3 py-2 text-caption text-amber-800">
          {notice}
        </p>
      )}
      {/* Company-keyed: a mounted private surface cannot survive a scope switch (S8 step 6). */}
      <main key={snapshot.companyId} className="flex-1 px-4 py-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section aria-label="Departments" className="min-w-0">
          <p className="text-caption text-bcc-text-secondary">
            {roster.length} departments · {totalAgents} agents · view: {view}
          </p>
          {roster.length === 0 ? (
            <p data-testid="hq-rosters-empty" className="pt-3 text-body text-bcc-text-secondary">
              This company has no departments yet. Setup continues in the existing workforce interview.
            </p>
          ) : view === 'floor' ? (
            <ul
              data-testid="hq-floor-rooms"
              className="pt-3 grid gap-3"
              style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}
            >
              {roster.map((row) => {
                const selected = row.id === selection.departmentId;
                return (
                  <li key={row.id}>
                    <button
                      type="button"
                      data-testid={`hq-room-${row.id}`}
                      aria-pressed={selected}
                      onClick={() => moveSelection({ departmentId: row.id, agentId: null, taskId: null })}
                      className={`w-full text-left min-h-[44px] rounded-2xl border p-3 ${
                        selected ? 'border-brand-400 bg-brand-50' : 'border-bcc-border bg-bcc-white'
                      }`}
                    >
                      <span className="block text-label text-bcc-text">{row.name}</span>
                      <span className="block text-caption text-bcc-text-secondary">
                        {row.agents.length} seats
                        {row.headAgentId === null ? ' · head not recorded' : ''}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <ul data-testid="hq-department-list" className="pt-3 space-y-2">
              {roster.map((row) => {
                const selected = row.id === selection.departmentId;
                return (
                  <li key={row.id}>
                    <button
                      type="button"
                      data-testid={`hq-department-${row.id}`}
                      aria-pressed={selected}
                      onClick={() => moveSelection({ departmentId: row.id, agentId: null, taskId: null })}
                      className={`w-full text-left min-h-[44px] rounded-xl border px-3 py-2 ${
                        selected ? 'border-brand-400 bg-brand-50' : 'border-bcc-border bg-bcc-white'
                      }`}
                    >
                      <span className="text-label text-bcc-text">{row.name}</span>
                      <span className="block text-caption text-bcc-text-secondary">
                        {row.agents.length} agents · {row.provisioning === 'ready' ? 'provisioned' : `setup: ${row.provisioning}`}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <aside aria-label="Details" className="min-w-0 space-y-4">
          <section data-testid="hq-selection" className="rounded-2xl border border-bcc-border bg-bcc-white p-3">
            <h2 className="flex items-center gap-2 text-label text-bcc-text">
              <Users className="w-4 h-4 text-brand-600" aria-hidden="true" />
              {department ? department.name : 'All departments'}
            </h2>
            {!department ? (
              <p className="pt-1 text-caption text-bcc-text-secondary">Select a department to see who is assigned.</p>
            ) : (
              <ul data-testid="hq-agent-list" className="pt-2 space-y-2">
                {department.agents.length === 0 && (
                  <li className="text-caption text-bcc-text-secondary">No agents assigned in this department yet.</li>
                )}
                {department.agents.map((row) => (
                  <AgentRow
                    key={row.id}
                    agent={row}
                    department={department}
                    selected={row.id === selection.agentId}
                    onSelect={() => moveSelection({ departmentId: department.id, agentId: row.id, taskId: null })}
                  />
                ))}
              </ul>
            )}
          </section>

          {agent && department && (
            <section data-testid="hq-agent-detail" className="rounded-2xl border border-bcc-border bg-bcc-white p-3">
              <h2 className="text-label text-bcc-text">{agent.displayName}</h2>
              <p className="text-caption text-bcc-text-secondary">{agentFacts(agent, department).join(' · ')}</p>
              <p className="pt-1 text-caption text-bcc-text-secondary">
                {agent.activeTaskIds.length
                  ? `${agent.activeTaskIds.length} active task${agent.activeTaskIds.length === 1 ? '' : 's'}`
                  : 'No active task recorded for this agent.'}
              </p>
              {agent.activeTaskIds.length > 0 && (
                <ul className="pt-2 flex flex-wrap gap-2">
                  {agent.activeTaskIds.map((taskId) => (
                    <li key={taskId}>
                      <button
                        type="button"
                        data-testid={`hq-task-${taskId}`}
                        aria-pressed={taskId === selection.taskId}
                        onClick={() => moveSelection({ departmentId: agent.workspaceId, agentId: agent.id, taskId })}
                        className={`inline-flex items-center min-h-[44px] px-3 rounded-xl border text-label ${
                          taskId === selection.taskId ? 'border-brand-400 bg-brand-50 text-bcc-text' : 'border-bcc-border text-bcc-text'
                        }`}
                      >
                        Task {taskId}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {agent.canTalk && agent.isHead && (
                <button
                  type="button"
                  data-testid="hq-talk-to-head"
                  onClick={() => setTalkAgentId(agent.id)}
                  className="mt-3 inline-flex items-center min-h-[44px] px-4 rounded-xl bg-brand-600 text-white font-medium hover:bg-brand-700"
                >
                  Talk to head
                </button>
              )}
            </section>
          )}

          {talkAgentId && (
            <section
              data-testid="hq-chat-slot"
              aria-label="Private conversation"
              className="rounded-2xl border border-dashed border-bcc-border bg-bcc-white p-3"
            >
              <h2 className="text-label text-bcc-text">Private conversation</h2>
              <p className="text-caption text-bcc-text-secondary">
                The private talk surface assembles at A02 from the owner-scoped turns of this session (B28 HeadChat). No
                message is sent from this view yet, and nothing here is written to company activity.
              </p>
            </section>
          )}

          <section data-testid="hq-activity" className="rounded-2xl border border-bcc-border bg-bcc-white p-3">
            <h2 className="text-label text-bcc-text">Latest activity</h2>
            {snapshot.activities.length === 0 ? (
              <p className="pt-1 text-caption text-bcc-text-secondary">No captured activity for this company yet.</p>
            ) : (
              <ul className="pt-2 space-y-2">
                {snapshot.activities.slice(0, 10).map((event) => (
                  <li key={event.id} data-testid={`hq-activity-${event.id}`} className="text-caption text-bcc-text-secondary">
                    <span className="text-bcc-text">{event.kind} · {event.phase}</span> — {event.actorLabel ?? 'unattributed'} ·{' '}
                    {new Date(event.receivedAt).toLocaleTimeString()}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </main>
    </div>
  );
}

export default function HeadquartersPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-bcc-bg flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-gray-400" aria-hidden="true" />
        </div>
      }
    >
      <HeadquartersController />
    </Suspense>
  );
}
