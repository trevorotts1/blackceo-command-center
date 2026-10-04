'use client';

/**
 * HeadquartersShell — B29 (WF-BUILD-C slot 9). Owner of the global Headquarters
 * chrome: responsive header, Floor | List control, searchable department picker,
 * connection status, the semantic list alternative, the detail panel and the
 * shared `headquarters.css` styling.
 *
 * Authority: SPEC.md rev 4 S4 (desktop shell, keyboard/list alternatives perform
 * identical actions, Board link), S11 (>=44 CSS px controls, 16 px gutters, no
 * page horizontal overflow, no hover-only action, Escape closes panel and focus
 * returns to the trigger, state carries label/icon not colour alone, reduced
 * motion supported) and qc.md Q11 (375 px + 1280 px, one coherent review).
 *
 * Scope boundary — this file owns chrome and nothing else:
 *   - the floor canvas is a slot (`floor`) owned by B23
 *   - activity feed / inspector / head chat / task actions are B26/B27/B28
 *   - route state, scope and Board-return filters are B30 then A02
 *   - the app-wide navigation files are A02 alone (@CC_NAV_ENTRY)
 * The shell renders whatever slot it is given; it never fetches company data
 * itself and never invents a roster.
 *
 * Theme: no component-local palette. Colours come from `headquarters.css`,
 * which reads the `--bcc-*` / `--brand-*` tokens BrandTheme already publishes on
 * :root, so a client re-theme cascades through this shell unchanged.
 */
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { Building2, Check, Map as MapIcon, RefreshCw, Search, Users, Wifi, WifiOff, X } from 'lucide-react';
import type { HqAgent, HqAgentStatus, HqDepartment } from '@/lib/hq/types';
import './headquarters.css';

export type HqView = 'floor' | 'list';
export type HqConnection = 'live' | 'reconnecting' | 'disconnected';

export interface HeadquartersShellProps {
  /** Department scope title (existing company branding/title; never invented here). */
  companyName: string;
  departments: HqDepartment[];
  /** Floor canvas slot — B23's composition. Rendered only in the Floor view. */
  floor?: React.ReactNode;

  view?: HqView;
  defaultView?: HqView;
  onViewChange?: (view: HqView) => void;

  selectedDepartmentId?: string | null;
  selectedAgentId?: string | null;
  /** Identical effect whether reached by clicking a room or from the list (S4). */
  onSelectDepartment?: (departmentId: string) => void;
  onSelectAgent?: (departmentId: string, agentId: string) => void;

  /** Canonical board route. Route-state/filter carrying belongs to the page owner. */
  boardHref: string;

  connection: HqConnection;
  connectionNote?: string;
  onRetryConnection?: () => void;

  /** Detail panel content (Inspector / head chat / task detail …). */
  panel?: React.ReactNode;
  panelTitle?: string;
  onClosePanel?: () => void;
}

/**
 * Phone breakpoint as an external store (S11). Kept out of an effect so the
 * first client render can already be `list` without a cascading re-render, and
 * so rotating a phone or resizing a desktop re-evaluates the default.
 */
const PHONE_QUERY = '(max-width: 767px)';

function subscribePhoneViewport(onChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => {};
  const mql = window.matchMedia(PHONE_QUERY);
  mql.addEventListener?.('change', onChange);
  window.addEventListener?.('resize', onChange);
  return () => {
    mql.removeEventListener?.('change', onChange);
    window.removeEventListener?.('resize', onChange);
  };
}

function isPhoneViewport(): boolean {
  if (typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(PHONE_QUERY).matches;
}

const STATUS_LABELS: Record<HqAgentStatus, string> = {
  standby: 'Standby',
  working: 'Working',
  busy: 'Busy',
  degraded: 'Degraded',
  offline: 'Offline',
  unknown: 'Status not observed',
};

const CONNECTION_LABELS: Record<HqConnection, string> = {
  live: 'Live',
  reconnecting: 'Reconnecting',
  disconnected: 'Disconnected',
};

/** Icon + label, never colour alone (S11). */
function StatusMark({ status }: { status: HqAgentStatus }) {
  // Shell-owned tones from headquarters.css, never a Tailwind colour utility:
  // the mark's ink has to be reachable by the stylesheet's contrast rules and
  // by the stylesheet-side contrast test (a utility it does not name is not).
  const tone =
    status === 'working' || status === 'busy'
      ? 'hq-status-strong'
      : status === 'standby'
        ? 'hq-status-secondary'
        : null;
  return (
    <span className={['inline-flex items-center gap-1', tone].filter(Boolean).join(' ')}>
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
      <span>{STATUS_LABELS[status] ?? STATUS_LABELS.unknown}</span>
    </span>
  );
}

/** Trimmed real-world branch of S3: what a seat can honestly show. */
function bindingNote(agent: HqAgent): string | null {
  if (agent.bindingKind === 'unbound') return 'Runtime binding unavailable — talk disabled';
  if (agent.bindingKind === 'department-shared') return 'Shared department executor';
  if (!agent.runtimeBound) return 'Runtime binding unavailable';
  return null;
}

function AgentRow({
  agent,
  departmentId,
  selected,
  onSelectAgent,
}: {
  agent: HqAgent;
  departmentId: string;
  selected: boolean;
  onSelectAgent?: (departmentId: string, agentId: string) => void;
}) {
  const note = bindingNote(agent);
  return (
    <li className="hq-list-item">
      <button
        type="button"
        className="hq-row"
        aria-current={selected ? 'true' : undefined}
        onClick={() => onSelectAgent?.(departmentId, agent.id)}
        data-testid={`hq-list-agent-${agent.id}`}
      >
        <span className="hq-row-main">
          <span className="hq-row-name">{agent.displayName}</span>
          <span className="hq-row-meta">
            {agent.role}
            {note ? ` · ${note}` : ''}
          </span>
        </span>
        <span className="hq-row-state">
          <StatusMark status={agent.status} />
        </span>
      </button>
    </li>
  );
}

export default function HeadquartersShell({
  companyName,
  departments,
  floor,
  view,
  defaultView,
  onViewChange,
  selectedDepartmentId = null,
  selectedAgentId = null,
  onSelectDepartment,
  onSelectAgent,
  boardHref,
  connection,
  connectionNote,
  onRetryConnection,
  panel,
  panelTitle,
  onClosePanel,
}: HeadquartersShellProps) {
  // S11: phone below 768px is List default with the Floor tab still available.
  // Read as an external store rather than synced in an effect: the server
  // snapshot is `false` (so hydration matches), the client snapshot re-reads
  // on rotate/resize, and an explicit choice by the user always wins.
  const phone = useSyncExternalStore(subscribePhoneViewport, isPhoneViewport, () => false);
  const [pickedView, setPickedView] = useState<HqView | null>(defaultView ?? null);
  const activeView: HqView = view ?? pickedView ?? (phone ? 'list' : 'floor');

  const changeView = (next: HqView) => {
    if (view === undefined) setPickedView(next);
    onViewChange?.(next);
  };

  // ── searchable department picker ────────────────────────────────────────
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState('');
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const pickerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const pickerId = useId();

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return departments;
    return departments.filter(
      (d) => d.name.toLowerCase().includes(q) || d.slug.toLowerCase().includes(q),
    );
  }, [departments, query]);

  useEffect(() => {
    if (!pickerOpen) return;
    function onDocPointer(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPickerOpen(false);
    }
    document.addEventListener('mousedown', onDocPointer);
    return () => document.removeEventListener('mousedown', onDocPointer);
  }, [pickerOpen]);

  const closePicker = (restoreFocus: boolean) => {
    setPickerOpen(false);
    if (restoreFocus) pickerTriggerRef.current?.focus();
  };

  const chooseDepartment = (departmentId: string) => {
    onSelectDepartment?.(departmentId);
    closePicker(true);
  };

  // ── detail panel: focus moves in on open, Escape closes, focus returns ──
  const panelRef = useRef<HTMLDivElement | null>(null);
  const panelOpen = Boolean(panel);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (panelOpen && !wasOpen.current) {
      previouslyFocused.current = document.activeElement as HTMLElement | null;
      panelRef.current?.focus();
    } else if (!panelOpen && wasOpen.current) {
      previouslyFocused.current?.focus?.();
    }
    wasOpen.current = panelOpen;
  }, [panelOpen]);

  const closePanel = () => {
    onClosePanel?.();
  };

  // One Escape handler for the shell: closes the picker first (innermost), then
  // the panel. Ordinary dismissal — no keyboard trap, no prevented scrolling.
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    if (pickerOpen) {
      event.stopPropagation();
      closePicker(true);
      return;
    }
    if (panelOpen) {
      event.stopPropagation();
      closePanel();
    }
  };

  const ConnectionIcon = connection === 'live' ? Wifi : connection === 'disconnected' ? WifiOff : RefreshCw;
  const onCall = departments.flatMap((d) =>
    d.agents.filter((a) => a.staffing === 'on-call').map((a) => ({ department: d, agent: a })),
  );

  return (
    <div className="hq-shell" data-view={activeView} onKeyDown={onKeyDown}>
      <header className="hq-header">
        <div className="hq-header-row">
          <h1 className="hq-title">{companyName} Headquarters</h1>

          <nav className="hq-nav" aria-label="Headquarters or Board">
            <span className="hq-nav-item" aria-current="page">
              <Building2 aria-hidden="true" className="h-4 w-4" />
              Headquarters
            </span>
            <Link className="hq-nav-item" href={boardHref} data-testid="hq-board-link">
              <Users aria-hidden="true" className="h-4 w-4" />
              Board
            </Link>
          </nav>

          <span className="hq-spacer" />

          <span className="hq-status" role="status" aria-live="polite" data-testid="hq-connection">
            <ConnectionIcon aria-hidden="true" className="hq-status-icon h-4 w-4" />
            <span>
              {CONNECTION_LABELS[connection]}
              {connectionNote ? ` — ${connectionNote}` : ''}
            </span>
          </span>
          {onRetryConnection && connection !== 'live' && (
            <button type="button" className="hq-nav-item" onClick={onRetryConnection}>
              <RefreshCw aria-hidden="true" className="h-4 w-4" />
              Retry
            </button>
          )}
        </div>

        <div className="hq-controls">
          <div className="hq-picker" ref={pickerRef}>
            <label className="hq-picker-label" htmlFor={`${pickerId}-input`}>
              Department
            </label>
            <button
              type="button"
              ref={pickerTriggerRef}
              className="hq-picker-input"
              style={{ textAlign: 'left' }}
              aria-expanded={pickerOpen}
              aria-controls={`${pickerId}-list`}
              onClick={() => setPickerOpen((open) => !open)}
              data-testid="hq-picker-trigger"
            >
              <span className="inline-flex items-center gap-2">
                <Search aria-hidden="true" className="h-4 w-4" />
                {departments.find((d) => d.id === selectedDepartmentId)?.name ?? 'All departments'}
              </span>
            </button>
            {pickerOpen && (
              <div>
                <input
                  id={`${pickerId}-input`}
                  className="hq-picker-input"
                  style={{ marginTop: 4 }}
                  type="search"
                  value={query}
                  placeholder="Search departments"
                  aria-label="Search departments"
                  aria-controls={`${pickerId}-list`}
                  onChange={(e) => setQuery(e.target.value)}
                />
                {/* A listbox must own its options: each option renders as a
                    direct child of the ul (an <li> between them strips the
                    option's valid listbox parent), and the no-match note stays
                    a plain list item — so the ul only carries the listbox role
                    while it actually holds options. */}
                <ul
                  className="hq-picker-list"
                  id={`${pickerId}-list`}
                  role={matches.length === 0 ? undefined : 'listbox'}
                  aria-label="Departments"
                >
                  {matches.length === 0 && <li className="hq-picker-empty">No department matches “{query.trim()}”.</li>}
                  {matches.map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      role="option"
                      aria-selected={d.id === selectedDepartmentId}
                      className="hq-picker-option"
                      onClick={() => chooseDepartment(d.id)}
                      data-testid={`hq-picker-option-${d.id}`}
                    >
                      <span className="hq-row-name">{d.name}</span>
                      <span className="hq-row-meta">
                        {d.agents.length} {d.agents.length === 1 ? 'agent' : 'agents'}
                        {d.provisioning !== 'ready' ? ` · Setup ${d.provisioning}` : ''}
                      </span>
                    </button>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <span className="hq-spacer" />

          <div className="hq-tabs" role="tablist" aria-label="Headquarters view" data-testid="hq-view-tabs">
            {(
              [
                { id: 'floor' as const, label: 'Floor', Icon: MapIcon },
                { id: 'list' as const, label: 'List', Icon: Users },
              ]
            ).map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                role="tab"
                className="hq-tab"
                aria-selected={activeView === id}
                onClick={() => changeView(id)}
                data-testid={`hq-view-tab-${id}`}
              >
                <Icon aria-hidden="true" className="h-4 w-4" />
                {label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="hq-body" data-panel={panelOpen ? 'open' : 'closed'}>
        <main className="hq-main">
          {activeView === 'floor' ? (
            <div className="hq-card" data-testid="hq-floor-slot">
              {floor ?? <p className="hq-empty">Floor view is not composed yet.</p>}
            </div>
          ) : (
            <section className="hq-card" aria-label="Departments list" data-testid="hq-list">
              <ul className="hq-list">
                {departments.map((department) => {
                  const head = department.headAgentId
                    ? department.agents.find((a) => a.id === department.headAgentId) ?? null
                    : null;
                  const others = department.agents.filter((a) => a.id !== department.headAgentId);
                  return (
                    <li key={department.id} className="hq-list-item">
                      <button
                        type="button"
                        className="hq-row"
                        aria-current={department.id === selectedDepartmentId ? 'true' : undefined}
                        onClick={() => onSelectDepartment?.(department.id)}
                        data-testid={`hq-list-department-${department.id}`}
                      >
                        <span className="hq-row-main">
                          <span className="hq-row-name">{department.name}</span>
                          <span className="hq-row-meta">
                            {department.agents.length} {department.agents.length === 1 ? 'agent' : 'agents'}
                            {department.provisioning !== 'ready' ? ` · Setup ${department.provisioning}` : ''}
                          </span>
                        </span>
                        <span className="hq-row-state">
                          {head ? `Head: ${head.displayName}` : 'No head bound'}
                        </span>
                      </button>
                      {department.id === selectedDepartmentId && (
                        <ul className="hq-list hq-nested">
                          {head && (
                            <AgentRow
                              agent={head}
                              departmentId={department.id}
                              selected={head.id === selectedAgentId}
                              onSelectAgent={onSelectAgent}
                            />
                          )}
                          {others.map((agent) => (
                            <AgentRow
                              key={agent.id}
                              agent={agent}
                              departmentId={department.id}
                              selected={agent.id === selectedAgentId}
                              onSelectAgent={onSelectAgent}
                            />
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
              {departments.length === 0 && <p className="hq-empty">No departments in scope for this company.</p>}
              {onCall.length > 0 && (
                <p className="hq-live">
                  On-call team: {onCall.map(({ agent }) => agent.displayName).join(', ')} — available, not
                  necessarily running.
                </p>
              )}
            </section>
          )}
        </main>

        {panelOpen && (
          <div
            className="hq-panel"
            role="region"
            aria-label={panelTitle ?? 'Details'}
            tabIndex={-1}
            ref={panelRef}
            data-testid="hq-panel"
          >
            <div className="hq-panel-header">
              <h2 className="hq-panel-title">{panelTitle ?? 'Details'}</h2>
              <button
                type="button"
                className="hq-panel-close"
                aria-label="Close details"
                onClick={closePanel}
                data-testid="hq-panel-close"
              >
                <X aria-hidden="true" className="h-4 w-4" />
              </button>
            </div>
            <div className="hq-panel-body">{panel}</div>
          </div>
        )}
      </div>

      {/* Aggregate, polite: one line per change, not per token (S11). */}
      <p className="hq-live" role="status" aria-live="polite" data-testid="hq-view-announce">
        <Check aria-hidden="true" className="mr-1 inline h-3 w-3" />
        Showing {activeView === 'floor' ? 'floor' : 'list'} view
        {selectedAgentId ? ` · selected agent` : selectedDepartmentId ? ' · department selected' : ''}.
      </p>
    </div>
  );
}
