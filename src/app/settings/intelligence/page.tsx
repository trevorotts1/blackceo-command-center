'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  Brain, Cpu, ChevronDown, ChevronRight, RotateCcw, Sparkles,
  Save, Check, Loader2, ArrowLeft, Wand2
} from 'lucide-react';

interface ModelOption {
  id: string;
  label: string;
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

export default function IntelligenceSettingsPage() {
  const router = useRouter();
  const [data, setData] = useState<IntelligenceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedDepts, setExpandedDepts] = useState<Set<string>>(new Set());
  const [expandedDeptsPersona, setExpandedDeptsPersona] = useState<Set<string>>(new Set());

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

  const toggleDeptPersona = (deptId: string) => {
    setExpandedDeptsPersona(prev => {
      const next = new Set(prev);
      if (next.has(deptId)) next.delete(deptId);
      else next.add(deptId);
      return next;
    });
  };

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
        // keys like "deptId:dept:model" or "deptId:roleId:model"
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
              onClick={() => router.push('/')}
              className="p-2 hover:bg-gray-100 rounded-lg text-gray-500 transition-colors"
              title="Back to Command Center"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <Brain className="w-6 h-6 text-indigo-600" />
            <h1 className="text-2xl font-bold text-gray-900">Intelligence Settings</h1>
          </div>

          <button
            onClick={handleSave}
            disabled={!hasChanges || saving}
            className={`px-4 py-2 rounded-lg flex items-center gap-2 font-medium transition-colors ${
              hasChanges
                ? 'bg-indigo-600 text-white hover:bg-indigo-700'
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

        {/* CARD 1: Department Model Settings */}
        <section className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
          <div className="p-6 border-b border-gray-100">
            <div className="flex items-center gap-3 mb-1">
              <Cpu className="w-5 h-5 text-indigo-600" />
              <h2 className="text-xl font-bold text-gray-900">Department Model Settings</h2>
            </div>
            <p className="text-sm text-gray-500 ml-8">
              Choose which AI model powers each department and role
            </p>
          </div>

          {/* Apply to All */}
          <div className="px-6 py-4 bg-indigo-50/50 border-b border-indigo-100 flex items-center gap-3">
            <Wand2 className="w-4 h-4 text-indigo-600 flex-shrink-0" />
            <span className="text-sm font-medium text-indigo-700 whitespace-nowrap">Apply to all:</span>
            <select
              onChange={(e) => {
                if (e.target.value) handleApplyModelToAll(e.target.value);
                e.target.value = '';
              }}
              defaultValue=""
              className="px-3 py-1.5 bg-white border border-indigo-200 rounded-lg text-sm text-gray-700 focus:ring-2 focus:ring-indigo-500 focus:border-transparent focus:outline-none"
            >
              <option value="" disabled>Select a model...</option>
              {data.models.map(m => (
                <option key={m.id} value={m.id}>{m.label} ({m.id})</option>
              ))}
            </select>
          </div>

          {/* Department List */}
          <div className="divide-y divide-gray-100">
            {data.departments.map(dept => {
              const isExpanded = expandedDepts.has(dept.id);
              const effectiveModel = getEffectiveModel(dept);

              return (
                <div key={dept.id}>
                  {/* Department Row */}
                  <button
                    onClick={() => toggleDept(dept.id)}
                    className="w-full px-6 py-4 flex items-center gap-3 hover:bg-gray-50 transition-colors text-left"
                  >
                    {isExpanded ? (
                      <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0" />
                    )}
                    <span className="text-lg">{dept.icon}</span>
                    <span className="font-semibold text-gray-900 flex-1">{dept.name}</span>
                    <span className="text-xs font-mono text-gray-400 bg-gray-100 px-2 py-1 rounded">
                      {effectiveModel}
                    </span>
                  </button>

                  {/* Expanded Roles */}
                  {isExpanded && (
                    <div className="bg-gray-50/50 border-l-4 border-indigo-200 ml-6 mr-4 mb-3 rounded-r-lg">
                      {dept.roles.length === 0 ? (
                        <div className="px-4 py-3 text-sm text-gray-400 italic">No agents in this department</div>
                      ) : (
                        dept.roles.map(role => {
                          const inherited = isModelInherited(dept, role);
                          const model = getEffectiveModel(dept, role);

                          return (
                            <div key={role.id} className="px-4 py-3 flex items-center gap-3 border-b border-gray-100 last:border-b-0">
                              <span className="text-base">{role.emoji}</span>
                              <div className="flex-1 min-w-0">
                                <div className="text-sm font-medium text-gray-900 truncate">
                                  {role.agentName}
                                </div>
                                <div className="text-xs text-gray-500">{role.name}</div>
                              </div>
                              <select
                                value={model}
                                onChange={(e) => setModel(`${dept.id}:${role.id}:model`, e.target.value)}
                                className="px-2 py-1.5 bg-white border border-gray-200 rounded-lg text-sm text-gray-700 focus:ring-2 focus:ring-indigo-500 focus:border-transparent focus:outline-none max-w-[260px]"
                              >
                                {data.models.map(m => (
                                  <option key={m.id} value={m.id}>{m.label}</option>
                                ))}
                              </select>
                              {inherited && (
                                <span className="text-xs text-gray-400 italic whitespace-nowrap">(inherited)</span>
                              )}
                              {!inherited && (
                                <button
                                  onClick={() => handleResetRoleModel(dept.id, role.id)}
                                  className="p-1.5 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
                                  title="Reset to department default"
                                >
                                  <RotateCcw className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </div>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {/* CARD 2: Persona Assignment */}
        <section className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
          <div className="p-6 border-b border-gray-100">
            <div className="flex items-center gap-3 mb-1">
              <Sparkles className="w-5 h-5 text-amber-500" />
              <h2 className="text-xl font-bold text-gray-900">Persona Assignment</h2>
            </div>
            <p className="text-sm text-gray-500 ml-8">
              Auto-assign uses 5-layer alignment to pick the best persona for each task based on your company mission, goals, department objectives, and the specific task. You can manually lock a persona to any role if you prefer.
            </p>
          </div>

          {/* Department List */}
          <div className="divide-y divide-gray-100">
            {data.departments.map(dept => {
              const isExpanded = expandedDeptsPersona.has(dept.id);
              const effectivePersona = getEffectivePersona(dept);
              const personaLabel = data.personas.find(p => p.id === effectivePersona)?.label || effectivePersona;

              return (
                <div key={dept.id}>
                  {/* Department Row */}
                  <button
                    onClick={() => toggleDeptPersona(dept.id)}
                    className="w-full px-6 py-4 flex items-center gap-3 hover:bg-gray-50 transition-colors text-left"
                  >
                    {isExpanded ? (
                      <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0" />
                    )}
                    <span className="text-lg">{dept.icon}</span>
                    <span className="font-semibold text-gray-900 flex-1">{dept.name}</span>
                    <span className="text-xs text-gray-400 bg-gray-100 px-2 py-1 rounded flex items-center gap-1">
                      {effectivePersona === 'auto' && <Sparkles className="w-3 h-3 text-amber-400" />}
                      {personaLabel}
                    </span>
                  </button>

                  {/* Expanded Roles */}
                  {isExpanded && (
                    <div className="bg-gray-50/50 border-l-4 border-amber-200 ml-6 mr-4 mb-3 rounded-r-lg">
                      {dept.roles.length === 0 ? (
                        <div className="px-4 py-3 text-sm text-gray-400 italic">No agents in this department</div>
                      ) : (
                        dept.roles.map(role => {
                          const inherited = isPersonaInherited(dept, role);
                          const persona = getEffectivePersona(dept, role);
                          const personaLabel = data.personas.find(p => p.id === persona)?.label || persona;

                          return (
                            <div key={role.id} className="px-4 py-3 flex items-center gap-3 border-b border-gray-100 last:border-b-0">
                              <span className="text-base">{role.emoji}</span>
                              <div className="flex-1 min-w-0">
                                <div className="text-sm font-medium text-gray-900 truncate">
                                  {role.agentName}
                                </div>
                                <div className="text-xs text-gray-500">{role.name}</div>
                              </div>
                              <select
                                value={persona}
                                onChange={(e) => setPersona(`${dept.id}:${role.id}:persona`, e.target.value)}
                                className="px-2 py-1.5 bg-white border border-gray-200 rounded-lg text-sm text-gray-700 focus:ring-2 focus:ring-amber-500 focus:border-transparent focus:outline-none max-w-[260px]"
                              >
                                {data.personas.map(p => (
                                  <option key={p.id} value={p.id}>
                                    {p.id === 'auto' ? '✨ ' : ''}{p.label}
                                  </option>
                                ))}
                              </select>
                              {inherited && (
                                <span className="text-xs text-gray-400 italic whitespace-nowrap">(inherited)</span>
                              )}
                              {!inherited && (
                                <button
                                  onClick={() => handleResetRolePersona(dept.id, role.id)}
                                  className="p-1.5 text-gray-400 hover:text-amber-600 hover:bg-amber-50 rounded-lg transition-colors"
                                  title="Reset to auto-assign"
                                >
                                  <RotateCcw className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </div>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
