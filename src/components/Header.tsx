'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Settings, ChevronLeft, LayoutGrid, Home, Sparkles, ChevronDown, Terminal, Check, Building2 } from 'lucide-react';
import { useMissionControl } from '@/lib/store';
import { LogoConfig } from '@/lib/logo';
import { useLogoUrl } from '@/hooks/useLogoUrl';
import { format } from 'date-fns';
import type { Workspace } from '@/lib/types';
import { SystemStatusPill } from './SystemStatusPill';

// --- AI Settings model & persona options ---
const MODEL_OPTIONS = [
  { value: 'openrouter/free', label: 'Free Models Router' },
  { value: 'moonshot/kimi-k2.5', label: 'Kimi K2.5' },
  { value: 'openrouter/xiaomi/mimo-v2-pro', label: 'MiMo V2 Pro' },
  { value: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet' },
  { value: 'openai-codex/gpt-5.4', label: 'GPT 5.4' },
  { value: 'google/gemini-3-flash-preview', label: 'Gemini 3 Flash' },
];

// Persona options are loaded dynamically from the API

interface HeaderProps {
  workspace?: Workspace;
  onMenuClick?: () => void;
  sidebarOpen?: boolean;
}

export function Header({ workspace, onMenuClick, sidebarOpen }: HeaderProps) {
  const router = useRouter();
  const { agents, tasks, isOnline } = useMissionControl();
  // Bug 4 (v4.0.2): mount-gate the live clock. Initial render must be the
  // same on server and client (null), then useEffect populates it after
  // hydration so a fresh Date() does not cause React #418/#423 mismatch.
  const [currentTime, setCurrentTime] = useState<Date | null>(null);
  const [activeSubAgents, setActiveSubAgents] = useState(0);
  // Baseline logo (logo-config.json → NEXT_PUBLIC_LOGO_URL → BlackCEO fallback).
  const baselineLogoUrl = useLogoUrl();
  // D3: per-client logo. When the selected client has a logo_url it takes
  // priority over the baseline; otherwise we fall back to the BlackCEO logo.
  const [clientLogoUrl, setClientLogoUrl] = useState<string | null>(null);
  const logoUrl = clientLogoUrl || baselineLogoUrl;

  // --- AI Settings panel state ---
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [aiModel, setAiModel] = useState('openrouter/free');
  const [aiPersona, setAiPersona] = useState('auto');
  const [aiSaving, setAiSaving] = useState(false);
  const [aiSaved, setAiSaved] = useState(false);
  const [aiLoaded, setAiLoaded] = useState(false);
  const [personaOptions, setPersonaOptions] = useState<{value: string; label: string}[]>([{ value: 'auto', label: 'Auto-assign' }]);
  const aiPanelRef = useRef<HTMLDivElement>(null);
  const aiButtonRef = useRef<HTMLButtonElement>(null);

  // --- Client (tenant) picker state ---
  interface PublicClient {
    id: string;
    name: string;
    is_self: boolean;
    logo_url?: string | null;
  }
  const [clients, setClients] = useState<PublicClient[]>([]);
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const [clientMenuOpen, setClientMenuOpen] = useState(false);
  const [switchingClient, setSwitchingClient] = useState(false);
  const clientMenuRef = useRef<HTMLDivElement>(null);
  const clientButtonRef = useRef<HTMLButtonElement>(null);

  // Load the client roster + which one is currently selected.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/api/clients', { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        const list: PublicClient[] = Array.isArray(data.clients) ? data.clients : [];
        setClients(list);
        // Resolve which client is selected. The API echoes the cookie-derived
        // selection in `selected_id`; fall back to self / first.
        const resolvedId: string | null =
          (typeof data.selected_id === 'string' ? data.selected_id : null) ??
          list.find((c) => c.is_self)?.id ??
          list[0]?.id ??
          null;
        setSelectedClientId((prev) => prev ?? resolvedId);
        // D3: pick up the selected client's logo (if any) so the Header swaps
        // the BlackCEO logo for the client's brand logo.
        const selected = list.find((c) => c.id === resolvedId) ?? null;
        setClientLogoUrl(selected?.logo_url ?? null);
      } catch (err) {
        console.error('Failed to load clients:', err);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Close the client menu on outside click.
  useEffect(() => {
    if (!clientMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        clientMenuRef.current &&
        !clientMenuRef.current.contains(target) &&
        clientButtonRef.current &&
        !clientButtonRef.current.contains(target)
      ) {
        setClientMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [clientMenuOpen]);

  const selectClient = useCallback(async (id: string) => {
    if (id === selectedClientId) {
      setClientMenuOpen(false);
      return;
    }
    setSwitchingClient(true);
    try {
      const res = await fetch('/api/clients/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (res.ok) {
        setSelectedClientId(id);
        setClientMenuOpen(false);
        // Selecting a client changes every downstream data source (OpenClaw,
        // keys, memory, analytics). A full refresh re-reads them against the
        // newly selected box.
        router.refresh();
        window.location.reload();
      }
    } catch (err) {
      console.error('Failed to switch client:', err);
    } finally {
      setSwitchingClient(false);
    }
  }, [selectedClientId, router]);

  const selectedClient = clients.find((c) => c.id === selectedClientId) ?? null;

  // Load current intelligence settings when panel opens
  useEffect(() => {
    if (!aiPanelOpen || !workspace || aiLoaded) return;
    const loadSettings = async () => {
      try {
        const res = await fetch('/api/settings/intelligence', { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          // API returns { departments: [...], models: [...], personas: [...], defaults: {...} }
          // Find the matching department by slug
          const dept = data.departments?.find(
            (d: { slug: string; model: string; persona: string }) => d.slug === workspace.slug
          );
          if (dept) {
            setAiModel(dept.model || data.defaults?.model || 'openrouter/free');
            setAiPersona(dept.persona || data.defaults?.persona || 'auto');
          }
          // Load dynamic persona list from API
          if (data.personas) {
            setPersonaOptions(data.personas.map((p: {id: string; label: string}) => ({ value: p.id, label: p.label })));
          }
        }
      } catch (err) {
        console.error('Failed to load AI settings:', err);
      }
      setAiLoaded(true);
    };
    loadSettings();
  }, [aiPanelOpen, workspace, aiLoaded]);

  // Close panel on click outside
  useEffect(() => {
    if (!aiPanelOpen) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        aiPanelRef.current &&
        !aiPanelRef.current.contains(target) &&
        aiButtonRef.current &&
        !aiButtonRef.current.contains(target)
      ) {
        setAiPanelOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [aiPanelOpen]);

  const handleAiSave = useCallback(async () => {
    if (!workspace) return;
    setAiSaving(true);
    setAiSaved(false);
    try {
      // API expects: { assignments: [{ department_id, role_id?, setting_type, value }] }
      const res = await fetch('/api/settings/intelligence', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assignments: [
            {
              department_id: workspace.id,
              role_id: null,
              setting_type: 'model',
              value: aiModel,
            },
            {
              department_id: workspace.id,
              role_id: null,
              setting_type: 'persona',
              value: aiPersona,
            },
          ],
        }),
      });
      if (res.ok) {
        setAiSaved(true);
        setTimeout(() => {
          setAiSaved(false);
          setAiPanelOpen(false);
        }, 1200);
      }
    } catch (err) {
      console.error('Failed to save AI settings:', err);
    } finally {
      setAiSaving(false);
    }
  }, [workspace, aiModel, aiPersona]);

  useEffect(() => {
    // Mount-gated: set the initial Date AFTER hydration, then tick.
    setCurrentTime(new Date());
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Load active sub-agent count
  useEffect(() => {
    const loadSubAgentCount = async () => {
      try {
        const res = await fetch('/api/openclaw/sessions?session_type=subagent&status=active');
        if (res.ok) {
          const sessions = await res.json();
          setActiveSubAgents(sessions.length);
        }
      } catch (error) {
        console.error('Failed to load sub-agent count:', error);
      }
    };

    loadSubAgentCount();

    // Poll every 30 seconds (reduced from 10s to reduce load)
    const interval = setInterval(loadSubAgentCount, 30000);
    return () => clearInterval(interval);
  }, []);

  const workingAgents = agents.filter((a) => a.status === 'working').length;
  const activeAgents = workingAgents + activeSubAgents;
  const tasksInQueue = tasks.filter((t) => t.status !== 'done' && t.status !== 'review').length;

  return (
    <header className="h-14 bg-white border-b border-gray-200 flex items-center justify-between px-4">
      {/* Left: Logo & Title */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <img
            src={logoUrl}
            alt={LogoConfig.alt}
            className="h-8 w-auto"
          />
        </div>

        {/* Workspace indicator or back to dashboard */}
        {workspace ? (
          <div className="flex items-center gap-2">
            <Link
              href="/"
              className="flex items-center gap-2 px-3 py-1.5 bg-white border border-gray-200 rounded-lg text-gray-700 hover:bg-gray-50 hover:border-gray-300 text-sm font-medium transition-colors"
            >
              <Home className="w-4 h-4" />
              <span>Home</span>
            </Link>
            <span className="text-gray-300">/</span>
            <Link
              href="/workspace"
              className="flex items-center gap-2 px-3 py-1.5 bg-white border border-gray-200 rounded-lg text-gray-700 hover:bg-gray-50 hover:border-gray-300 text-sm font-medium transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
              <span>All Departments</span>
            </Link>
            <span className="text-gray-300">/</span>
            <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-50 border border-gray-200 rounded-lg">
              <span className="text-lg">{workspace.icon}</span>
              <span className="font-semibold text-gray-900">{workspace.name}</span>
            </div>
          </div>
        ) : (
          <Link
            href="/"
            className="flex items-center gap-2 px-3 py-1.5 bg-gray-50 border border-gray-200 rounded-lg hover:bg-gray-100 hover:border-gray-300 transition-colors"
          >
            <LayoutGrid className="w-4 h-4 text-gray-500" />
            <span className="text-sm font-medium text-gray-700">All Departments</span>
          </Link>
        )}
      </div>

      {/* Center: Stats - only show in workspace view */}
      {workspace && (
        <div className="flex items-center gap-8">
          <div className="text-center">
            <div className="text-2xl font-bold text-brand-600">{activeAgents}</div>
            <div className="text-sm text-gray-500 uppercase tracking-wide">Agents Active</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-brand-700">{tasksInQueue}</div>
            <div className="text-sm text-gray-500 uppercase tracking-wide">Tasks in Queue</div>
          </div>
        </div>
      )}

      {/* Right: Time & Status */}
      <div className="flex items-center gap-4">
        <Link
          href="/operator"
          aria-label="Operator Console"
          title="Operator Console"
          className="flex items-center gap-2 px-3 py-1.5 bg-white border border-gray-200 rounded-lg text-gray-700 hover:bg-gray-50 hover:border-gray-300 text-sm font-medium transition-colors"
        >
          <Terminal className="w-4 h-4" />
          <span className="hidden sm:inline">Operator Console</span>
        </Link>
        <span className="text-gray-500 text-sm font-mono">
          {currentTime ? (
            format(currentTime, 'HH:mm:ss')
          ) : (
            <span className="inline-block w-20 h-4 bg-gray-100 rounded animate-pulse" aria-hidden />
          )}
        </span>
        {/* System status pill (PRD 3.12). Reflects the worst-case component
         *  status across probes. */}
        <SystemStatusPill />

        {/* E24 fix: ONE unambiguous connection status pill for the SELECTED
         *  client (replaces the two adjacent bright ONLINE/OFFLINE buttons that
         *  could both look "lit"). A single dot+label with no competing
         *  affordance. For the operator's own box we drive it from the live
         *  store; remote-client live status is wired by the connection feature
         *  cluster — until then we show the neutral connected/offline state. */}
        {(() => {
          // Selected client's connection state. The live store flag (isOnline)
          // is the only connection signal available in this foundation; the
          // connection feature cluster swaps in a per-client probe later. We
          // reference selectedClient so the pill is explicitly scoped to it.
          void selectedClient;
          const online = isOnline;
          return (
            <div
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium border ${
                online
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                  : 'bg-gray-50 border-gray-200 text-gray-600'
              }`}
              role="status"
              aria-label={`Connection status: ${online ? 'Online' : 'Offline'}`}
              title={online ? 'Connected to the selected client gateway' : 'Not connected to the selected client gateway'}
            >
              <span className={`w-2 h-2 rounded-full ${online ? 'bg-emerald-500 animate-pulse' : 'bg-gray-400'}`} />
              <span>{online ? 'Online' : 'Offline'}</span>
            </div>
          );
        })()}

        {/* Client (tenant) picker — selects which managed box the whole
         *  dashboard reads. Hidden when only the operator's own box exists. */}
        {clients.length > 1 && (
          <div className="relative">
            <button
              ref={clientButtonRef}
              onClick={() => setClientMenuOpen((p) => !p)}
              disabled={switchingClient}
              className="flex items-center gap-2 px-3 py-1.5 bg-white border border-gray-200 rounded-lg text-gray-700 hover:bg-gray-50 hover:border-gray-300 text-sm font-medium transition-colors disabled:opacity-60"
              title="Switch client"
              aria-haspopup="listbox"
              aria-expanded={clientMenuOpen}
            >
              <Building2 className="w-4 h-4 text-gray-500" />
              <span className="max-w-[10rem] truncate">
                {selectedClient ? selectedClient.name : 'Select client'}
              </span>
              <ChevronDown className={`w-3 h-3 transition-transform ${clientMenuOpen ? 'rotate-180' : ''}`} />
            </button>

            {clientMenuOpen && (
              <div
                ref={clientMenuRef}
                role="listbox"
                className="absolute right-0 top-full mt-2 w-64 bg-white border border-gray-200 rounded-xl shadow-lg z-50 py-2 max-h-80 overflow-auto"
              >
                <div className="px-3 pb-2 mb-1 border-b border-gray-100 text-xs font-semibold uppercase tracking-wide text-gray-400">
                  Clients
                </div>
                {clients.map((c) => {
                  const active = c.id === selectedClientId;
                  return (
                    <button
                      key={c.id}
                      role="option"
                      aria-selected={active}
                      onClick={() => selectClient(c.id)}
                      className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-left transition-colors ${
                        active ? 'bg-brand-50 text-brand-700' : 'text-gray-700 hover:bg-gray-50'
                      }`}
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <span className="truncate">{c.name}</span>
                        {c.is_self && (
                          <span className="shrink-0 text-[10px] uppercase tracking-wide text-gray-400 border border-gray-200 rounded px-1 py-0.5">
                            This box
                          </span>
                        )}
                      </span>
                      {active && <Check className="w-4 h-4 shrink-0" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* AI Settings - only visible in department view */}
        {workspace && (
          <div className="relative">
            <button
              ref={aiButtonRef}
              onClick={() => {
                setAiPanelOpen((prev) => !prev);
                if (!aiPanelOpen) setAiLoaded(false);
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-brand-200 text-brand-700 text-sm font-medium rounded-lg hover:bg-brand-50 hover:border-brand-300 transition-all duration-200"
              title="AI Settings for this department"
            >
              <Sparkles className="w-4 h-4" />
              <span className="hidden sm:inline">AI Settings</span>
              <ChevronDown className={`w-3 h-3 transition-transform ${aiPanelOpen ? 'rotate-180' : ''}`} />
            </button>

            {/* Popover panel */}
            {aiPanelOpen && (
              <div
                ref={aiPanelRef}
                className="absolute right-0 top-full mt-2 w-72 bg-white border border-gray-200 rounded-xl shadow-lg z-50 p-4"
              >
                {/* Department name */}
                <div className="flex items-center gap-2 mb-3 pb-3 border-b border-gray-100">
                  <span className="text-lg">{workspace.icon}</span>
                  <span className="font-semibold text-gray-900 text-sm">{workspace.name}</span>
                </div>

                {/* Model selector */}
                <div className="mb-3">
                  <label className="block text-sm font-medium text-gray-500 uppercase tracking-wide mb-1">
                    Model
                  </label>
                  <div className="relative">
                    <select
                      value={aiModel}
                      onChange={(e) => setAiModel(e.target.value)}
                      className="w-full appearance-none bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 pr-8 focus:outline-none focus:ring-2 focus:ring-brand-300 focus:border-brand-400 transition-colors"
                    >
                      {MODEL_OPTIONS.map((m) => (
                        <option key={m.value} value={m.value}>
                          {m.label} ({m.value})
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
                  </div>
                </div>

                {/* Persona selector */}
                <div className="mb-4">
                  <label className="block text-sm font-medium text-gray-500 uppercase tracking-wide mb-1">
                    Persona
                  </label>
                  <div className="relative">
                    <select
                      value={aiPersona}
                      onChange={(e) => setAiPersona(e.target.value)}
                      className="w-full appearance-none bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 pr-8 focus:outline-none focus:ring-2 focus:ring-brand-300 focus:border-brand-400 transition-colors"
                    >
                      {personaOptions.map((p) => (
                        <option key={p.value} value={p.value}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
                  </div>
                </div>

                {/* Save button */}
                <button
                  onClick={handleAiSave}
                  disabled={aiSaving}
                  className={`w-full py-2 rounded-lg text-sm font-medium transition-all duration-200 ${
                    aiSaved
                      ? 'bg-emerald-100 text-emerald-700 border border-emerald-200'
                      : 'bg-gradient-to-r from-brand-500 to-brand-700 text-white hover:shadow-md'
                  }`}
                >
                  {aiSaving ? 'Saving...' : aiSaved ? 'Saved' : 'Save'}
                </button>
              </div>
            )}
          </div>
        )}

        <button
          onClick={() => router.push('/settings')}
          className="p-2 hover:bg-gray-100 rounded-lg text-gray-500 hover:text-gray-700 transition-colors"
          title="Settings"
        >
          <Settings className="w-5 h-5" />
        </button>
      </div>
    </header>
  );
}
