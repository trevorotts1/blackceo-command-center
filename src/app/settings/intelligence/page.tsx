'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  Brain,
  Sparkles,
  Save,
  Check,
  Loader2,
  ArrowLeft,
  Wand2,
  Info,
  Users,
  Bot,
  UserCheck,
  ChevronsUpDown,
  ChevronsDownUp,
} from 'lucide-react';
import { Breadcrumb } from '@/components/Breadcrumb';
import {
  PersonaModelAssignment,
  type AssignmentDepartment,
  type AssignmentRole,
  type AssignmentModelOption,
  type AssignmentPersonaOption,
} from '@/components/settings/PersonaModelAssignment';
import {
  ModelFilterBar,
  applyModelFilters,
  EMPTY_FILTER_STATE,
  type ModelFilterState,
} from '@/components/settings/ModelFilterBar';
import { ModelCard, type ModelCardData } from '@/components/settings/ModelCard';
import {
  IntelligenceProviderList,
  type ProviderRefreshEntry,
} from '@/components/settings/IntelligenceProviderList';
import { PERSONA_MATCH_NAME, PERSONA_MATCH_TAGLINE } from '@/components/settings/persona-match';

/* ── Data shapes returned by /api/settings/intelligence ── */

interface SettingsModelOption extends AssignmentModelOption {
  description?: string;
  provider?: string;
  family?: string;
  capabilities?: string[];
  cost_per_million_input?: number;
  cost_per_million_output?: number;
  status?: string;
}

interface IntelligenceData {
  departments: AssignmentDepartment[];
  models: SettingsModelOption[];
  personas: AssignmentPersonaOption[];
  defaults: { model: string; persona: string };
}

/* ── /api/models payload (PRD Section 5.1) ── */

interface RegistryModel {
  id: number;
  model_id: string;
  label: string;
  provider: string;
  family: string | null;
  context_window: number | null;
  input_cost_per_million: number | null;
  output_cost_per_million: number | null;
  capabilities: string[];
  status: string;
}

interface ModelsApiResponse {
  total: number;
  models: RegistryModel[];
  providers: string[];
  refresh_log?: ProviderRefreshEntry[];
}

function getModelDescription(
  modelId: string,
  models: SettingsModelOption[]
): string {
  const found = models.find((m) => m.id === modelId);
  if (!found) return modelId;
  const parts: string[] = [found.label];
  if (
    typeof found.cost_per_million_input === 'number' ||
    typeof found.cost_per_million_output === 'number'
  ) {
    const inCost = found.cost_per_million_input;
    const outCost = found.cost_per_million_output;
    if ((inCost ?? 0) === 0 && (outCost ?? 0) === 0) {
      parts.push('Free');
    } else {
      parts.push(`$${(inCost ?? 0).toFixed(2)} / $${(outCost ?? 0).toFixed(2)} per M`);
    }
  }
  return parts.join(' - ');
}

export default function IntelligenceSettingsPage() {
  const router = useRouter();
  const [data, setData] = useState<IntelligenceData | null>(null);
  const [modelsApi, setModelsApi] = useState<ModelsApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedDepts, setExpandedDepts] = useState<Set<string>>(new Set());

  // Filter state for the catalog browser. Independent of the assignment UI so
  // tweaking filters never disturbs unsaved persona/model changes below.
  const [filterState, setFilterState] = useState<ModelFilterState>(EMPTY_FILTER_STATE);

  // Local state for pending changes. `null` is an explicit "clear the saved
  // override" instruction (BUG 3) — distinct from `undefined`, which means
  // "no pending change at this key at all".
  const [pendingChanges, setPendingChanges] = useState<
    Record<string, { model?: string | null; persona?: string | null }>
  >({});

  const fetchData = useCallback(async () => {
    try {
      const [settingsRes, modelsRes] = await Promise.all([
        fetch('/api/settings/intelligence', { cache: 'no-store' }),
        fetch('/api/models?refresh=1', { cache: 'no-store' }),
      ]);
      if (!settingsRes.ok) throw new Error('Failed to load settings');
      const settingsJson = (await settingsRes.json()) as IntelligenceData;
      setData(settingsJson);

      // Models API is best-effort: a fresh install with no model_registry rows
      // still has to render the assignment surface above.
      if (modelsRes.ok) {
        const modelsJson = (await modelsRes.json()) as ModelsApiResponse;
        setModelsApi(modelsJson);
      } else {
        setModelsApi(null);
      }
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
    setExpandedDepts((prev) => {
      const next = new Set(prev);
      if (next.has(deptId)) next.delete(deptId);
      else next.add(deptId);
      return next;
    });
  };

  const expandAll = () => {
    if (!data) return;
    setExpandedDepts(new Set(data.departments.map((d) => d.id)));
  };

  const collapseAll = () => {
    setExpandedDepts(new Set());
  };

  const allExpanded = data
    ? data.departments.every((d) => expandedDepts.has(d.id))
    : false;

  const getEffectiveModel = (dept: AssignmentDepartment, role?: AssignmentRole): string => {
    const key = role ? `${dept.id}:${role.id}:model` : `${dept.id}:dept:model`;
    const pending = pendingChanges[key];
    if (pending && pending.model !== undefined) {
      if (pending.model !== null) return pending.model;
      // Staged clear (BUG 3) on a role override — preview what it will
      // revert to: the department's effective model (its own pending edit,
      // if any, else its saved value).
      if (role) {
        const deptPending = pendingChanges[`${dept.id}:dept:model`];
        return deptPending?.model ?? dept.model;
      }
      return dept.model;
    }
    return role ? role.model : dept.model;
  };

  const getEffectivePersona = (dept: AssignmentDepartment, role?: AssignmentRole): string => {
    const key = role ? `${dept.id}:${role.id}:persona` : `${dept.id}:dept:persona`;
    const pending = pendingChanges[key];
    if (pending && pending.persona !== undefined) {
      if (pending.persona !== null) return pending.persona;
      // Staged clear on a role override — preview the department's effective persona.
      if (role) {
        const deptPending = pendingChanges[`${dept.id}:dept:persona`];
        return deptPending?.persona ?? dept.persona;
      }
      return dept.persona;
    }
    return role ? role.persona : dept.persona;
  };

  const isModelInheritedFor = (dept: AssignmentDepartment, role: AssignmentRole): boolean => {
    const pending = pendingChanges[`${dept.id}:${role.id}:model`];
    if (pending && pending.model !== undefined) return pending.model === null;
    return role.modelInherited;
  };

  const isPersonaInheritedFor = (dept: AssignmentDepartment, role: AssignmentRole): boolean => {
    const pending = pendingChanges[`${dept.id}:${role.id}:persona`];
    if (pending && pending.persona !== undefined) return pending.persona === null;
    return role.personaInherited;
  };

  const setModel = (key: string, value: string | null) => {
    setPendingChanges((prev) => ({
      ...prev,
      [key]: { ...prev[key], model: value },
    }));
    setSaved(false);
  };

  const setPersona = (key: string, value: string | null) => {
    setPendingChanges((prev) => ({
      ...prev,
      [key]: { ...prev[key], persona: value },
    }));
    setSaved(false);
  };

  const handleApplyModelToAll = (modelId: string) => {
    if (!data) return;
    const modelLabel = data.models.find((m) => m.id === modelId)?.label || modelId;
    const confirmed = window.confirm(
      `Apply "${modelLabel}" to ALL ${data.departments.length} departments?\n\nThis will override every department's current model setting. You can still review changes before saving.`
    );
    if (!confirmed) return;
    const updates: Record<string, { model?: string | null; persona?: string | null }> = {};
    for (const dept of data.departments) {
      updates[`${dept.id}:dept:model`] = { model: modelId };
    }
    setPendingChanges((prev) => ({ ...prev, ...updates }));
    setSaved(false);
  };

  const handleAssignModelToDept = (modelId: string, departmentId: string) => {
    if (!data) return;
    setPendingChanges((prev) => ({
      ...prev,
      [`${departmentId}:dept:model`]: { ...prev[`${departmentId}:dept:model`], model: modelId },
    }));
    setSaved(false);
    // Surface the department whose model just changed so the operator can see it.
    setExpandedDepts((prev) => {
      const next = new Set(prev);
      next.add(departmentId);
      return next;
    });
  };

  // BUG 3 FIX: clicking "Reset to inherited" on a role override now
  // distinguishes two cases:
  //   - A persisted override exists on the server (role.modelInherited ===
  //     false) → stage an explicit clear (value=null) so Save sends a
  //     DELETE and the role actually reverts to inheriting the department
  //     default. Previously this was unreachable: dropping a nonexistent
  //     pending-change key was a silent no-op and the saved override could
  //     never be removed through the UI.
  //   - No persisted override, just an unsaved local edit → discard the
  //     pending edit (original behavior; nothing to clear on the server).
  const handleResetRoleModel = (deptId: string, roleId: string) => {
    const dept = data?.departments.find((d) => d.id === deptId);
    const role = dept?.roles.find((r) => r.id === roleId);
    const key = `${deptId}:${roleId}:model`;
    if (role && !role.modelInherited) {
      setModel(key, null);
    } else {
      setPendingChanges((prev) => {
        const { [key]: _omit, ...rest } = prev;
        return rest;
      });
    }
  };

  const handleResetRolePersona = (deptId: string, roleId: string) => {
    const dept = data?.departments.find((d) => d.id === deptId);
    const role = dept?.roles.find((r) => r.id === roleId);
    const key = `${deptId}:${roleId}:persona`;
    if (role && !role.personaInherited) {
      setPersona(key, null);
    } else {
      setPendingChanges((prev) => {
        const { [key]: _omit, ...rest } = prev;
        return rest;
      });
    }
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
        /** `null` clears (deletes) a saved override — BUG 3. */
        value: string | null;
      }> = [];

      for (const [key, changes] of Object.entries(pendingChanges)) {
        const parts = key.split(':');
        const settingType = parts[parts.length - 1] as 'model' | 'persona';
        const isDept = parts[1] === 'dept';
        const deptId = parts[0];
        const roleId = isDept ? null : parts[1];

        // BUG 3 FIX: check `!== undefined` (not truthy) so a staged clear
        // (value === null, from "Reset to inherited" on a saved override)
        // is actually sent to the server instead of being silently dropped.
        if (changes.model !== undefined && settingType === 'model') {
          assignments.push({
            department_id: deptId,
            role_id: roleId,
            setting_type: 'model',
            value: changes.model,
          });
        }
        if (changes.persona !== undefined && settingType === 'persona') {
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

      if (!res.ok) {
        // BUG 4 FIX: the PUT route 423s with { locked: [{ locked_by,
        // lock_reason, department_id, role_id, setting_type }] } when a
        // target setting is locked, but this previously always surfaced the
        // generic "Failed to save" — the operator had no idea WHO locked it
        // or WHY. Parse the body and build a message naming the lock holder.
        const body = (await res.json().catch(() => null)) as {
          error?: string;
          message?: string;
          locked?: Array<{
            department_id: string;
            role_id: string | null;
            setting_type: string;
            locked_by: string;
            lock_reason: string | null;
          }>;
        } | null;

        if (res.status === 423 && body?.locked && body.locked.length > 0) {
          const details = body.locked
            .map((l) => {
              const target = l.role_id ? `${l.setting_type} override for agent ${l.role_id}` : `${l.setting_type} default for ${l.department_id}`;
              return `${target} is locked by ${l.locked_by}${l.lock_reason ? ` (${l.lock_reason})` : ''}`;
            })
            .join('; ');
          throw new Error(`Save blocked — ${details}`);
        }
        throw new Error(body?.message || body?.error || 'Failed to save');
      }

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

  // Catalog browser data: prefer the live registry from /api/models, fall back
  // to the (already enriched) model list embedded in /api/settings/intelligence.
  const catalogModels: ModelCardData[] = useMemo(() => {
    if (modelsApi && modelsApi.models.length > 0) {
      return modelsApi.models.map((m) => ({
        id: m.model_id,
        label: m.label,
        provider: m.provider,
        family: m.family ?? undefined,
        capabilities: m.capabilities,
        cost_per_million_input: m.input_cost_per_million ?? undefined,
        cost_per_million_output: m.output_cost_per_million ?? undefined,
        status: m.status,
      }));
    }
    if (!data) return [];
    return data.models.map((m) => ({
      id: m.id,
      label: m.label,
      provider: m.provider,
      family: m.family,
      capabilities: m.capabilities,
      cost_per_million_input: m.cost_per_million_input,
      cost_per_million_output: m.cost_per_million_output,
      status: m.status,
    }));
  }, [modelsApi, data]);

  const filteredCatalog = useMemo(
    () => applyModelFilters(catalogModels, filterState),
    [catalogModels, filterState]
  );

  // Department options offered in each card's "Assign to a department…" picker.
  const departmentOptions = useMemo(
    () => (data ? data.departments.map((d) => ({ id: d.id, name: d.name })) : []),
    [data]
  );

  const modelDescription = useCallback(
    (modelId: string) => getModelDescription(modelId, data?.models ?? []),
    [data]
  );

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
                  <span>
                    <strong>Department defaults</strong> set the model and persona for the
                    whole department. These apply to all agents unless overridden.
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-brand-400 mt-1">2.</span>
                  <span>
                    <strong>Role overrides</strong> let you lock a specific agent to a
                    different model or persona than the department default.
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-brand-400 mt-1">3.</span>
                  <span>
                    <strong>{PERSONA_MATCH_NAME}</strong> uses 5-layer alignment (company
                    mission, goals, department objectives, task context, and agent role)
                    to pick the best persona automatically.
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-brand-400 mt-1">4.</span>
                  <span>
                    <strong>Model catalog</strong> is sourced live from the model
                    registry. Filter by provider, capability, or cost band to find the
                    right model for the job.
                  </span>
                </li>
              </ul>
            </div>
          </div>
        </section>

        {/* ── Provider freshness + manual refresh ── */}
        <IntelligenceProviderList
          refreshLog={modelsApi?.refresh_log ?? []}
          providers={modelsApi?.providers ?? []}
          onRefreshComplete={fetchData}
        />

        {/* ── Model catalog browser ── */}
        <section className="space-y-4">
          <div>
            <h2 className="text-lg font-bold text-gray-900">Available models</h2>
            <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">
              These are the models currently offered by every connected provider. Filter by
              provider, capability, or cost band to find the right one, then act on a card
              directly: <strong>Apply to all</strong> sets it as the default for every department,
              or <strong>Assign to dept…</strong> sets it for just one. Fine-grained per-agent
              overrides live in the department cards further down.
            </p>
          </div>

          <ModelFilterBar
            models={catalogModels}
            state={filterState}
            onChange={setFilterState}
            visibleCount={filteredCatalog.length}
          />

          {filteredCatalog.length === 0 ? (
            <div className="bg-white border border-gray-200 rounded-xl px-5 py-8 text-center text-sm text-gray-500">
              {catalogModels.length === 0
                ? 'No models in the registry yet. Use "Refresh now" above to pull each provider\'s catalog.'
                : 'No models match these filters. Try clearing one of the chips above.'}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {filteredCatalog.map((m) => (
                <ModelCard
                  key={m.id}
                  model={m}
                  onSetDefault={handleApplyModelToAll}
                  onAssignToDept={handleAssignModelToDept}
                  departments={departmentOptions}
                />
              ))}
            </div>
          )}
        </section>

        {/* ── E7: single "Apply model to ALL departments" control ── */}
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm px-5 py-4 flex items-center gap-3 flex-wrap">
          <Wand2 className="w-4 h-4 text-brand-600 flex-shrink-0" />
          <span className="text-sm font-medium text-gray-700 whitespace-nowrap">
            Apply one model to ALL departments:
          </span>
          <select
            onChange={(e) => {
              if (e.target.value) handleApplyModelToAll(e.target.value);
              e.target.value = '';
            }}
            defaultValue=""
            aria-label="Apply one model to all departments"
            className="w-full sm:flex-1 sm:min-w-[220px] px-3 py-1.5 bg-white border border-gray-200 rounded-lg text-sm text-gray-700 focus:ring-2 focus:ring-brand-500 focus:border-transparent focus:outline-none"
          >
            <option value="" disabled>
              Select a model…
            </option>
            {data.models.map((m) => (
              <option key={m.id} value={m.id}>
                {modelDescription(m.id)}
              </option>
            ))}
          </select>
          <span className="text-xs text-gray-400 whitespace-nowrap">
            Overrides every department default — review before saving.
          </span>

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

        {/* ── Department assignment cards ── */}
        <div className="space-y-4">
          {data.departments.map((dept) => {
            const isExpanded = expandedDepts.has(dept.id);
            const effectiveModel = getEffectiveModel(dept);
            const effectivePersona = getEffectivePersona(dept);

            return (
              <PersonaModelAssignment
                key={dept.id}
                department={dept}
                models={data.models}
                personas={data.personas}
                effectiveModel={effectiveModel}
                effectivePersona={effectivePersona}
                getModelForRole={(role) => getEffectiveModel(dept, role)}
                getPersonaForRole={(role) => getEffectivePersona(dept, role)}
                isModelInherited={(role) => isModelInheritedFor(dept, role)}
                isPersonaInherited={(role) => isPersonaInheritedFor(dept, role)}
                onSetModel={setModel}
                onSetPersona={setPersona}
                onResetModel={handleResetRoleModel}
                onResetPersona={handleResetRolePersona}
                modelDescription={modelDescription}
                expanded={isExpanded}
                onToggle={() => toggleDept(dept.id)}
              />
            );
          })}
        </div>

        {/* ── Legend ── */}
        <section className="bg-white border border-gray-200 rounded-xl shadow-sm px-5 py-4">
          <p className="text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-3">
            Agent Type Legend
          </p>
          <div className="flex flex-wrap gap-4">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-brand-50 text-brand-700 border border-brand-200">
                <Bot className="w-3 h-3" />
                Persistent
              </span>
              <span className="text-sm text-gray-500">
                Always running, handles department workflows
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-100 text-emerald-700 border border-emerald-200">
                <UserCheck className="w-3 h-3" />
                Full-time Specialist
              </span>
              <span className="text-sm text-gray-500">
                Dedicated team member, always available
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-700 border border-amber-200">
                <Users className="w-3 h-3" />
                On-call Specialist
              </span>
              <span className="text-sm text-gray-500">
                Spawned when a task needs their skill
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-violet-100 text-violet-700 border border-violet-200">
                <Sparkles className="w-3 h-3" />
                {PERSONA_MATCH_NAME}
              </span>
              <span className="text-sm text-gray-500" title={PERSONA_MATCH_TAGLINE}>
                5-layer alignment picks the best persona for each task
              </span>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
