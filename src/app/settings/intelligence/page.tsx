'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  Brain, Cpu, ChevronDown, ChevronRight, RotateCcw, Sparkles,
  Save, Check, Loader2, ArrowLeft, Wand2, Info, Users, Bot, UserCheck,
  ChevronsUpDown, ChevronsDownUp
} from 'lucide-react';
import { Breadcrumb } from '@/components/Breadcrumb';

interface ModelOption {
  id: string;
  label: string;
  description?: string;
}

interface PersonaOption {
  id: string;
  label: string;
}

interface Role {
  id: string;
  name: string;
  agentName: string;
  emoji: string;
  model: string;
  modelInherited: boolean;
  persona: string;
  personaInherited: boolean;
  agentType: 'persistent' | 'specialist';
  specialistType: 'permanent' | 'on-call' | null;
}

interface Department {
  id: string;
  name: string;
  slug: string;
  icon: string;
  model: string;
  persona: string;
  roles: Role[];
}

interface IntelligenceData {
  departments: Department[];
  models: ModelOption[];
  personas: PersonaOption[];
  defaults: { model: string; persona: string };
}

/* ── Model label + description map ── */
const MODEL_DESCRIPTIONS: Record<string, string> = {
  'openrouter/xiaomi/mimo-v2-pro': 'MiMo V2 Pro — 1M context, best for code and orchestration',
  'openrouter/xiaomi/mimo-v2-omni': 'MiMo V2 Omni — 262K context, handles images, video, and audio',
  'anthropic/claude-opus-4-6': 'Claude Opus 4.6 — 1M context, deepest reasoning and analysis',
  'anthropic/claude-sonnet-4-6': 'Claude Sonnet 4.6 — 1M context, fast and versatile',
  'openai-codex/gpt-5.4': 'GPT-5.4 — 1M context, strong general-purpose model',
  'openrouter/minimax/minimax-m2.7': 'MiniMax M2.7 — 204K context, 131K output, long-form writing',
  'moonshot/kimi-k2.5': 'Kimi K2.5 — 262K context, built-in reasoning',
  'google/gemini-3-flash-preview': 'Gemini 3 Flash — fast and cheap, good for bulk tasks',
  'google/gemini-3.1-pro-preview': 'Gemini 3.1 Pro — smartest Gemini, best for complex analysis',
  'openrouter/perplexity/sonar-pro-search': 'Perplexity Sonar Pro — deep web research with citations',
};

function getModelDescription(modelId: string): string {
  return MODEL_DESCRIPTIONS[modelId] || modelId;
}

/* ── Agent Type Badge ── */
function AgentTypeBadge({ role }: { role: Role }) {
  if (role.agentType === 'persistent') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-badge font-semibold bg-brand-50 text-brand-700 border border-brand-200">
        <Bot className="w-3 h-3" />
        Persistent
      </span>
    );
  }
  if (role.specialistType === 'permanent') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-badge font-semibold bg-emerald-100 text-emerald-700 border border-emerald-200">
        <UserCheck className="w-3 h-3" />
        Full-time Specialist
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-badge font-semibold bg-amber-100 text-amber-700 border border-amber-200">
      <Users className="w-3 h-3" />
      On-call Specialist
    </span>
  );
}

/* ── Info Tooltip ── */
function InfoTip({ children }: { children: React.ReactNode }) {
  const [show, setShow] = useState(false);
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setShow(!show); }}
        className="text-gray-400 hover:text-gray-600 transition-colors"
      >
        <Info className="w-4 h-4" />
      </button>
      {show && (
        <div className="absolute z-50 left-6 top-0 w-72 p-3 bg-gray-900 text-white text-badge leading-relaxed rounded-lg shadow-xl">
          {children}
          <div className="absolute -left-1.5 top-1.5 w-3 h-3 bg-gray-900 rotate-45 rounded-sm" />
        </div>
      )}
    </span>
  );
}

export default function IntelligenceSettingsPage() {
  const router = useRouter();
  const [data, setData] = useState<IntelligenceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedDepts, setExpandedDepts] = useState<Set<string>>(new Set());

  // Local state for pending changes
  const [pendingChanges, setPendingChanges] = useState<Record<string, { model?: string; persona?: string }>>({});

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/intelligence', { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to load settings');
      const json = await res.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const toggleDept = (deptId: string) => {
    setExpandedDepts(prev => {
      const next = new Set(prev);
      if (next.has(deptId)) next.delete(deptId);
      else next.add(deptId);
      return next;
    });
  };

  const expandAll = () => {
    if (!data) return;
    setExpandedDepts(new Set(data.departments.map(d => d.id)));
  };

  const collapseAll = () => {
    setExpandedDepts(new Set());
  };

  const allExpanded = data ? data.departments.every(d => expandedDepts.has(d.id)) : false;

  const getEffectiveModel = (dept: Department, role?: Role): string => {
    if (role) {
      const pending = pendingChanges[`${dept.id}:${role.id}:model`];
      if (pending?.model !== undefined) return pending.model;
      return role.model;
    }
    const pending = pendingChanges[`${dept.id}:dept:model`];
    if (pending?.model !== undefined) return pending.model;
    return dept.model;
  };

  const getEffectivePersona = (dept: Department, role?: Role): string => {
    if (role) {
      const pending = pendingChanges[`${dept.id}:${role.id}:persona`];
      if (pending?.persona !== undefined) return pending.persona;
      return role.persona;
    }
    const pending = pendingChanges[`${dept.id}:dept:persona`];
    if (pending?.persona !== undefined) return pending.persona;
    return dept.persona;
  };

  const isModelInherited = (dept: Department, role: Role): boolean => {
    const pending = pendingChanges[`${dept.id}:${role.id}:model`];
    if (pending !== undefined) return false;
    return role.modelInherited;
  };

  const isPersonaInherited = (dept: Department, role: Role): boolean => {
    const pending = pendingChanges[`${dept.id}:${role.id}:persona`];
    if (pending !== undefined) return false;
    return role.personaInherited;
  };

  const setModel = (key: string, value: string) => {
    setPendingChanges(prev => ({
      ...prev,
      [key]: { ...prev[key], model: value },
    }));
    setSaved(false);
  };

  const setPersona = (key: string, value: string) => {
    setPendingChanges(prev => ({
      ...prev,
      [key]: { ...prev[key], persona: value },
    }));
    setSaved(false);
  };

  const handleApplyModelToAll = (modelId: string) => {
    if (!data) return;
    const modelLabel = data.models.find(m => m.id === modelId)?.label || modelId;
    const confirmed = window.confirm(
      `Apply "${modelLabel}" to ALL ${data.departments.length} departments?\n\nThis will override every department's current model setting. You can still review changes before saving.`
    );
    if (!confirmed) return;
    const updates: Record<string, { model?: string; persona?: string }> = {};
    for (const dept of data.departments) {
      updates[`${dept.id}:dept:model`] = { model: modelId };
    }
    setPendingChanges(prev => ({ ...prev, ...updates }));
    setSaved(false);
  };

  const handleResetRoleModel = (deptId: string, roleId: string) => {
    setPendingChanges(prev => {
      const key = `${deptId}:${roleId}:model`;
      const { [key]: _, ...rest } = prev;
      return rest;
    });
  };

  const handleResetRolePersona = (deptId: string, roleId: string) => {
    setPendingChanges(prev => {
      const key = `${deptId}:${roleId}:persona`;
      const { [key]: _, ...rest } = prev;
      return rest;
    });
  };

  const handleSave = async () => {
    if (!data || Object.keys(pendingChanges).length === 0) return;

    setSaving(true);
    setError(null);

    try {
      const assignments: Array<{
        department_id: string;
        role_id: string | null;
        setting_type: 'model' | 'persona';
        value: string;
      }> = [];

      for (const [key, changes] of Object.entries(pendingChanges)) {
        const parts = key.split(':');
        const settingType = parts[parts.length - 1] as 'model' | 'persona';
        const isDept = parts[1] === 'dept';
        const deptId = parts[0];
        const roleId = isDept ? null : parts[1];

        if (changes.model && settingType === 'model') {
          assignments.push({
            department_id: deptId,
            role_id: roleId,
            setting_type: 'model',
            value: changes.model,
          });
        }
        if (changes.persona && settingType === 'persona') {
          assignments.push({
            department_id: deptId,
            role_id: roleId,
            setting_type: 'persona',
            value: changes.persona,
          });
        }
      }

      const res = await fetch('/api/settings/intelligence', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignments }),
      });

      if (!res.ok) throw new Error('Failed to save');

      setSaved(true);
      setPendingChanges({});
      await fetchData();
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#F8F9FB] flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-gray-500">
          <Loader2 className="h-8 w-8 animate-spin" />
          <span className="text-sm font-medium">Loading intelligence settings...</span>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="min-h-screen bg-[#F8F9FB] flex items-center justify-center">
        <div className="text-red-500">{error || 'Failed to load settings'}</div>
      </div>
    );
  }

  const hasChanges = Object.keys(pendingChanges).length > 0;

  return (
    <div className="min-h-screen bg-[#F8F9FB]">
      {/* Header */}
      <div className="border-b border-gray-200 bg-white">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push('/settings')}
              className="p-2 hover:bg-gray-100 rounded-lg text-gray-500 transition-colors"
              title="Back to Settings"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <Brain className="w-6 h-6 text-brand-600" />
            <h1 className="text-2xl font-bold text-gray-900">Intelligence Settings</h1>
          </div>

          <button
            onClick={handleSave}
            disabled={!hasChanges || saving}
            className={`px-4 py-2 rounded-lg flex items-center gap-2 font-medium transition-colors ${
              hasChanges
                ? 'bg-brand-600 text-white hover:bg-brand-700'
                : 'bg-gray-100 text-gray-400 cursor-not-allowed'
            }`}
          >
            {saving ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : saved ? (
              <Check className="w-4 h-4" />
            ) : (
              <Save className="w-4 h-4" />
            )}
            {saving ? 'Saving...' : saved ? 'Saved!' : hasChanges ? 'Save Changes' : 'No Changes'}
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-5xl mx-auto px-6 py-8 space-y-8">
        <Breadcrumb
          items={[
            { label: 'Home', href: '/' },
            { label: 'Settings', href: '/settings' },
            { label: 'Intelligence' },
          ]}
        />

        {/* Success/Error */}
        {saved && !hasChanges && (
          <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-lg text-emerald-700 text-sm font-medium">
            Settings saved successfully
          </div>
        )}
        {error && (
          <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm">
            {error}
          </div>
        )}

        {/* ── How This Works ── */}
        <section className="bg-brand-50/60 border border-brand-100 rounded-xl px-5 py-4">
          <div className="flex items-start gap-3">
            <Info className="w-5 h-5 text-brand-500 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-brand-800 leading-relaxed space-y-1.5">
              <p className="font-semibold">How Intelligence Settings Work</p>
              <ul className="space-y-1 text-brand-700">
                <li className="flex items-start gap-2">
                  <span className="text-brand-400 mt-1">1.</span>
                  <span><strong>Department defaults</strong> set the model and persona for the whole department. These apply to all agents unless overridden.</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-brand-400 mt-1">2.</span>
                  <span><strong>Role overrides</strong> let you lock a specific agent to a different model or persona than the department default.</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-brand-400 mt-1">3.</span>
                  <span><strong>Auto-assign persona</strong> uses 5-layer alignment (company mission, goals, department objectives, task context, and agent role) to pick the best persona automatically.</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-brand-400 mt-1">4.</span>
                  <span><strong>Model enforcement:</strong> When a task is dispatched to a persistent agent, the model selected here is used. On-call specialists use the model set in their OpenClaw config. This setting is stored and available to the routing layer.</span>
                </li>
              </ul>
            </div>
          </div>
        </section>

        {/* Apply to All + Expand/Collapse All */}
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm px-5 py-4 flex items-center gap-3 flex-wrap">
          <Wand2 className="w-4 h-4 text-brand-600 flex-shrink-0" />
          <span className="text-sm font-medium text-gray-700 whitespace-nowrap">Set all departments to:</span>
          <select
            onChange={(e) => {
              if (e.target.value) handleApplyModelToAll(e.target.value);
              e.target.value = '';
            }}
            defaultValue=""
            className="px-3 py-1.5 bg-white border border-gray-200 rounded-lg text-sm text-gray-700 focus:ring-2 focus:ring-brand-500 focus:border-transparent focus:outline-none"
          >
            <option value="" disabled>Select a model...</option>
            {data.models.map(m => (
              <option key={m.id} value={m.id}>{getModelDescription(m.id)}</option>
            ))}
          </select>

          <div className="ml-auto">
            <button
              onClick={allExpanded ? collapseAll : expandAll}
              className="px-3 py-1.5 text-sm font-medium text-brand-700 bg-brand-50 hover:bg-brand-100 border border-brand-200 rounded-lg transition-colors flex items-center gap-1.5"
            >
              {allExpanded ? (
                <>
                  <ChevronsDownUp className="w-4 h-4" />
                  Collapse All
                </>
              ) : (
                <>
                  <ChevronsUpDown className="w-4 h-4" />
                  Expand All
                </>
              )}
            </button>
          </div>
        </div>

        {/* ── Unified Department Cards ── */}
        <div className="space-y-4">
          {data.departments.map(dept => {
            const isExpanded = expandedDepts.has(dept.id);
            const effectiveModel = getEffectiveModel(dept);
            const effectivePersona = getEffectivePersona(dept);
            const personaLabel = data.personas.find(p => p.id === effectivePersona)?.label || effectivePersona;

            return (
              <section
                key={dept.id}
                className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden"
              >
                {/* Department Header Row */}
                <button
                  onClick={() => toggleDept(dept.id)}
                  className="w-full px-6 py-5 flex items-center gap-4 hover:bg-gray-50/80 transition-colors text-left group"
                >
                  {/* Chevron with hint */}
                  <div className="flex-shrink-0 flex items-center gap-1.5">
                    {isExpanded ? (
                      <ChevronDown className="w-5 h-5 text-brand-500" />
                    ) : (
                      <ChevronRight className="w-5 h-5 text-gray-400 group-hover:text-brand-500 transition-colors" />
                    )}
                    {!isExpanded && (
                      <span className="text-badge text-gray-400 group-hover:text-brand-500 transition-colors hidden sm:inline">
                        Click to expand
                      </span>
                    )}
                  </div>

                  <span className="text-2xl">{dept.icon}</span>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-gray-900 text-lg">{dept.name}</span>
                      <span className="text-badge text-gray-400 font-mono">/{dept.slug}</span>
                    </div>
                    {/* Summary chips when collapsed */}
                    {!isExpanded && (
                      <div className="flex items-center gap-2 mt-1.5">
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-badge font-medium bg-gray-100 text-gray-600">
                          <Cpu className="w-3 h-3" />
                          {getModelDescription(effectiveModel)}
                        </span>
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-badge font-medium bg-gray-100 text-gray-600">
                          {effectivePersona === 'auto' && <Sparkles className="w-3 h-3 text-amber-400" />}
                          {personaLabel}
                        </span>
                        {dept.roles.length > 0 && (
                          <span className="text-badge text-gray-400">
                            {dept.roles.length} agent{dept.roles.length !== 1 ? 's' : ''}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </button>

                {/* Expanded Content */}
                {isExpanded && (
                  <div className="border-t border-gray-100">
                    {/* ── Department Defaults ── */}
                    <div className="px-6 py-4 bg-gray-50/60">
                      <div className="flex items-center gap-2 mb-3">
                        <span className="text-badge font-bold text-gray-500 uppercase tracking-wider">Department Defaults</span>
                        <InfoTip>
                          These settings apply to every agent in {dept.name} unless an agent has its own override below.
                        </InfoTip>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        {/* Dept Model */}
                        <div>
                          <label className="block text-label font-medium text-gray-500 mb-1.5">
                            Default Model
                          </label>
                          <select
                            value={effectiveModel}
                            onChange={(e) => setModel(`${dept.id}:dept:model`, e.target.value)}
                            className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm text-gray-700 focus:ring-2 focus:ring-brand-500 focus:border-transparent focus:outline-none"
                          >
                            {data.models.map(m => (
                              <option key={m.id} value={m.id}>{getModelDescription(m.id)}</option>
                            ))}
                          </select>
                        </div>
                        {/* Dept Persona */}
                        <div>
                          <label className="block text-label font-medium text-gray-500 mb-1.5">
                            Default Persona
                          </label>
                          <select
                            value={effectivePersona}
                            onChange={(e) => setPersona(`${dept.id}:dept:persona`, e.target.value)}
                            className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm text-gray-700 focus:ring-2 focus:ring-amber-500 focus:border-transparent focus:outline-none"
                          >
                            {data.personas.map(p => (
                              <option key={p.id} value={p.id}>
                                {p.id === 'auto' ? 'Auto-assign (recommended)' : p.label}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                    </div>

                    {/* ── Agent Roles ── */}
                    <div className="px-6 py-3">
                      <div className="flex items-center gap-2 mb-3">
                        <span className="text-badge font-bold text-gray-500 uppercase tracking-wider">Agent Overrides</span>
                        <InfoTip>
                          Override the department default for a specific agent. Changes here only affect that agent. Click the reset arrow to go back to the department default.
                        </InfoTip>
                      </div>

                      {dept.roles.length === 0 ? (
                        <div className="py-4 text-sm text-gray-400 italic text-center">
                          No agents in this department yet
                        </div>
                      ) : (
                        <div className="space-y-3">
                          {dept.roles.map(role => {
                            const modelInherited = isModelInherited(dept, role);
                            const personaInherited = isPersonaInherited(dept, role);
                            const model = getEffectiveModel(dept, role);
                            const persona = getEffectivePersona(dept, role);

                            return (
                              <div
                                key={role.id}
                                className="border border-gray-100 rounded-xl px-4 py-3 bg-gray-50/80"
                              >
                                {/* Agent Name + Type Badge */}
                                <div className="flex items-center gap-3 mb-3">
                                  <span className="text-xl"><span className="emoji">{role.emoji}</span></span>
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <span className="text-base font-semibold text-gray-900">
                                        {role.agentName}
                                      </span>
                                      <AgentTypeBadge role={role} />
                                    </div>
                                    <div className="text-sm text-gray-500 mt-0.5">{role.name}</div>
                                  </div>
                                </div>

                                {/* Model + Persona Controls */}
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                  {/* Model Override */}
                                  <div>
                                    <label className="block text-badge font-medium text-gray-500 mb-1">
                                      Model {modelInherited && <span className="text-gray-400">(inherited)</span>}
                                    </label>
                                    <div className="flex items-center gap-1.5">
                                      <select
                                        value={model}
                                        onChange={(e) => setModel(`${dept.id}:${role.id}:model`, e.target.value)}
                                        className="flex-1 px-2 py-1.5 bg-white border border-gray-200 rounded-lg text-sm text-gray-700 focus:ring-2 focus:ring-brand-500 focus:border-transparent focus:outline-none"
                                      >
                                        {data.models.map(m => (
                                          <option key={m.id} value={m.id}>{getModelDescription(m.id)}</option>
                                        ))}
                                      </select>
                                      {!modelInherited && (
                                        <button
                                          onClick={() => handleResetRoleModel(dept.id, role.id)}
                                          className="p-1.5 text-gray-400 hover:text-brand-600 hover:bg-brand-50 rounded-lg transition-colors flex-shrink-0"
                                          title="Reset to department default"
                                        >
                                          <RotateCcw className="w-3.5 h-3.5" />
                                        </button>
                                      )}
                                    </div>
                                  </div>

                                  {/* Persona Override */}
                                  <div>
                                    <label className="block text-badge font-medium text-gray-500 mb-1">
                                      Persona {personaInherited && <span className="text-gray-400">(inherited)</span>}
                                    </label>
                                    <div className="flex items-center gap-1.5">
                                      <select
                                        value={persona}
                                        onChange={(e) => setPersona(`${dept.id}:${role.id}:persona`, e.target.value)}
                                        className="flex-1 px-2 py-1.5 bg-white border border-gray-200 rounded-lg text-sm text-gray-700 focus:ring-2 focus:ring-amber-500 focus:border-transparent focus:outline-none"
                                      >
                                        {data.personas.map(p => (
                                          <option key={p.id} value={p.id}>
                                            {p.id === 'auto' ? 'Auto-assign' : p.label}
                                          </option>
                                        ))}
                                      </select>
                                      {!personaInherited && (
                                        <button
                                          onClick={() => handleResetRolePersona(dept.id, role.id)}
                                          className="p-1.5 text-gray-400 hover:text-amber-600 hover:bg-amber-50 rounded-lg transition-colors flex-shrink-0"
                                          title="Reset to department default"
                                        >
                                          <RotateCcw className="w-3.5 h-3.5" />
                                        </button>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </section>
            );
          })}
        </div>

        {/* ── Legend ── */}
        <section className="bg-white border border-gray-200 rounded-xl shadow-sm px-5 py-4">
          <p className="text-badge font-bold text-gray-500 uppercase tracking-wider mb-3">Agent Type Legend</p>
          <div className="flex flex-wrap gap-4">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-badge font-semibold bg-brand-50 text-brand-700 border border-brand-200">
                <Bot className="w-3 h-3" />
                Persistent
              </span>
              <span className="text-sm text-gray-500">Always running, handles department workflows</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-badge font-semibold bg-emerald-100 text-emerald-700 border border-emerald-200">
                <UserCheck className="w-3 h-3" />
                Full-time Specialist
              </span>
              <span className="text-sm text-gray-500">Dedicated team member, always available</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-badge font-semibold bg-amber-100 text-amber-700 border border-amber-200">
                <Users className="w-3 h-3" />
                On-call Specialist
              </span>
              <span className="text-sm text-gray-500">Spawned when a task needs their skill</span>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
