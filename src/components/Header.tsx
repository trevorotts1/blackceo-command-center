'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Settings, ChevronLeft, LayoutGrid, Home, Sparkles, ChevronDown } from 'lucide-react';
import { useMissionControl } from '@/lib/store';
import { LogoConfig } from '@/lib/logo';
import { useLogoUrl } from '@/hooks/useLogoUrl';
import { format } from 'date-fns';
import type { Workspace } from '@/lib/types';

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
  const [currentTime, setCurrentTime] = useState(new Date());
  const [activeSubAgents, setActiveSubAgents] = useState(0);
  const logoUrl = useLogoUrl();

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
        <span className="text-gray-500 text-sm font-mono">
          {format(currentTime, 'HH:mm:ss')}
        </span>
        <div
          className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium ${
            isOnline
              ? 'bg-emerald-50 border border-emerald-200 text-emerald-700'
              : 'bg-red-50 border border-red-200 text-red-700'
          }`}
        >
          <span
            className={`w-2 h-2 rounded-full ${
              isOnline ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'
            }`}
          />
          {isOnline ? 'ONLINE' : 'OFFLINE'}
        </div>

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
