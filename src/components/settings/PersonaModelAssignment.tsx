'use client';

import { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  RotateCcw,
  Sparkles,
  Cpu,
  Info,
  Users,
  Bot,
  UserCheck,
} from 'lucide-react';

/**
 * PersonaModelAssignment - per-department persona + model assignment card.
 *
 * Extracted from the legacy intelligence page so the model browser refresh
 * (filter chips, capability badges, model catalog) can sit above this and
 * leave the assignment surface untouched. Per PRD line 750 the persona
 * system must not change behavior: this component preserves the exact
 * inherit/override mechanics, the auto-assign option, and the 5-layer
 * persona note copy.
 */

export interface AssignmentModelOption {
  id: string;
  label: string;
}

export interface AssignmentPersonaOption {
  id: string;
  label: string;
}

export interface AssignmentRole {
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

export interface AssignmentDepartment {
  id: string;
  name: string;
  slug: string;
  icon: string;
  model: string;
  persona: string;
  roles: AssignmentRole[];
}

interface PersonaModelAssignmentProps {
  department: AssignmentDepartment;
  models: AssignmentModelOption[];
  personas: AssignmentPersonaOption[];
  effectiveModel: string;
  effectivePersona: string;
  getModelForRole: (role: AssignmentRole) => string;
  getPersonaForRole: (role: AssignmentRole) => string;
  isModelInherited: (role: AssignmentRole) => boolean;
  isPersonaInherited: (role: AssignmentRole) => boolean;
  onSetModel: (key: string, value: string) => void;
  onSetPersona: (key: string, value: string) => void;
  onResetModel: (deptId: string, roleId: string) => void;
  onResetPersona: (deptId: string, roleId: string) => void;
  modelDescription: (modelId: string) => string;
  expanded: boolean;
  onToggle: () => void;
}

function AgentTypeBadge({ role }: { role: AssignmentRole }) {
  if (role.agentType === 'persistent') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-brand-50 text-brand-700 border border-brand-200">
        <Bot className="w-3 h-3" />
        Persistent
      </span>
    );
  }
  if (role.specialistType === 'permanent') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-100 text-emerald-700 border border-emerald-200">
        <UserCheck className="w-3 h-3" />
        Full-time Specialist
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-700 border border-amber-200">
      <Users className="w-3 h-3" />
      On-call Specialist
    </span>
  );
}

function InfoTip({ children }: { children: React.ReactNode }) {
  const [show, setShow] = useState(false);
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setShow(!show);
        }}
        className="text-gray-400 hover:text-gray-600 transition-colors"
      >
        <Info className="w-4 h-4" />
      </button>
      {show && (
        <div className="absolute z-50 left-6 top-0 w-72 p-3 bg-gray-900 text-white text-[11px] leading-relaxed rounded-lg shadow-xl">
          {children}
          <div className="absolute -left-1.5 top-1.5 w-3 h-3 bg-gray-900 rotate-45 rounded-sm" />
        </div>
      )}
    </span>
  );
}

export function PersonaModelAssignment({
  department: dept,
  models,
  personas,
  effectiveModel,
  effectivePersona,
  getModelForRole,
  getPersonaForRole,
  isModelInherited,
  isPersonaInherited,
  onSetModel,
  onSetPersona,
  onResetModel,
  onResetPersona,
  modelDescription,
  expanded,
  onToggle,
}: PersonaModelAssignmentProps) {
  const personaLabel =
    personas.find((p) => p.id === effectivePersona)?.label || effectivePersona;

  return (
    <section className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full px-6 py-5 flex items-center gap-4 hover:bg-gray-50/80 transition-colors text-left group"
      >
        <div className="flex-shrink-0 flex items-center gap-1.5">
          {expanded ? (
            <ChevronDown className="w-5 h-5 text-brand-500" />
          ) : (
            <ChevronRight className="w-5 h-5 text-gray-400 group-hover:text-brand-500 transition-colors" />
          )}
          {!expanded && (
            <span className="text-[11px] text-gray-400 group-hover:text-brand-500 transition-colors hidden sm:inline">
              Click to expand
            </span>
          )}
        </div>

        <span className="text-2xl">{dept.icon}</span>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-bold text-gray-900 text-lg">{dept.name}</span>
            <span className="text-[11px] text-gray-400 font-mono">/{dept.slug}</span>
          </div>
          {!expanded && (
            <div className="flex items-center gap-2 mt-1.5">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-gray-100 text-gray-600">
                <Cpu className="w-3 h-3" />
                {modelDescription(effectiveModel)}
              </span>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-gray-100 text-gray-600">
                {effectivePersona === 'auto' && (
                  <Sparkles className="w-3 h-3 text-amber-400" />
                )}
                {personaLabel}
              </span>
              {dept.roles.length > 0 && (
                <span className="text-[11px] text-gray-400">
                  {dept.roles.length} agent{dept.roles.length !== 1 ? 's' : ''}
                </span>
              )}
            </div>
          )}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-gray-100">
          <div className="px-6 py-4 bg-gray-50/60">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-[11px] font-bold text-gray-500 uppercase tracking-wider">
                Department Defaults
              </span>
              <InfoTip>
                These settings apply to every agent in {dept.name} unless an agent has its
                own override below.
              </InfoTip>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1.5">
                  Default Model
                </label>
                <select
                  value={effectiveModel}
                  onChange={(e) => onSetModel(`${dept.id}:dept:model`, e.target.value)}
                  className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm text-gray-700 focus:ring-2 focus:ring-brand-500 focus:border-transparent focus:outline-none"
                >
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {modelDescription(m.id)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1.5">
                  Default Persona
                </label>
                <select
                  value={effectivePersona}
                  onChange={(e) => onSetPersona(`${dept.id}:dept:persona`, e.target.value)}
                  className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm text-gray-700 focus:ring-2 focus:ring-amber-500 focus:border-transparent focus:outline-none"
                >
                  {personas.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.id === 'auto' ? 'Auto-assign (recommended)' : p.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <div className="px-6 py-3">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-[11px] font-bold text-gray-500 uppercase tracking-wider">
                Agent Overrides
              </span>
              <InfoTip>
                Override the department default for a specific agent. Changes here only
                affect that agent. Click the reset arrow to go back to the department
                default.
              </InfoTip>
            </div>

            {dept.roles.length === 0 ? (
              <div className="py-4 text-sm text-gray-400 italic text-center">
                No agents in this department yet
              </div>
            ) : (
              <div className="space-y-3">
                {dept.roles.map((role) => {
                  const modelInherited = isModelInherited(role);
                  const personaInherited = isPersonaInherited(role);
                  const model = getModelForRole(role);
                  const persona = getPersonaForRole(role);

                  return (
                    <div
                      key={role.id}
                      className="border border-gray-100 rounded-xl px-4 py-3 bg-gray-50/80"
                    >
                      <div className="flex items-center gap-3 mb-3">
                        <span className="text-xl">{role.emoji}</span>
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

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-[11px] font-medium text-gray-500 mb-1">
                            Model{' '}
                            {modelInherited && (
                              <span className="text-gray-400">(inherited)</span>
                            )}
                          </label>
                          <div className="flex items-center gap-1.5">
                            <select
                              value={model}
                              onChange={(e) =>
                                onSetModel(`${dept.id}:${role.id}:model`, e.target.value)
                              }
                              className="flex-1 px-2 py-1.5 bg-white border border-gray-200 rounded-lg text-sm text-gray-700 focus:ring-2 focus:ring-brand-500 focus:border-transparent focus:outline-none"
                            >
                              {models.map((m) => (
                                <option key={m.id} value={m.id}>
                                  {modelDescription(m.id)}
                                </option>
                              ))}
                            </select>
                            {!modelInherited && (
                              <button
                                onClick={() => onResetModel(dept.id, role.id)}
                                className="p-1.5 text-gray-400 hover:text-brand-600 hover:bg-brand-50 rounded-lg transition-colors flex-shrink-0"
                                title="Reset to department default"
                              >
                                <RotateCcw className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </div>

                        <div>
                          <label className="block text-[11px] font-medium text-gray-500 mb-1">
                            Persona{' '}
                            {personaInherited && (
                              <span className="text-gray-400">(inherited)</span>
                            )}
                          </label>
                          <div className="flex items-center gap-1.5">
                            <select
                              value={persona}
                              onChange={(e) =>
                                onSetPersona(`${dept.id}:${role.id}:persona`, e.target.value)
                              }
                              className="flex-1 px-2 py-1.5 bg-white border border-gray-200 rounded-lg text-sm text-gray-700 focus:ring-2 focus:ring-amber-500 focus:border-transparent focus:outline-none"
                            >
                              {personas.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.id === 'auto' ? 'Auto-assign' : p.label}
                                </option>
                              ))}
                            </select>
                            {!personaInherited && (
                              <button
                                onClick={() => onResetPersona(dept.id, role.id)}
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
}
