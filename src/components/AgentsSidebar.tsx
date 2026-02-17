'use client';

import { useState, useEffect, useCallback } from 'react';
import { Plus, ChevronRight, ChevronLeft, Zap, ZapOff, Loader2 } from 'lucide-react';
import { useMissionControl } from '@/lib/store';
import type { Agent, AgentStatus, OpenClawSession } from '@/lib/types';
import { AgentModal } from './AgentModal';

type FilterTab = 'all' | 'working' | 'standby';

interface AgentsSidebarProps {
  workspaceId?: string;
}

export function AgentsSidebar({ workspaceId }: AgentsSidebarProps) {
  const { agents, selectedAgent, setSelectedAgent, agentOpenClawSessions, setAgentOpenClawSession } = useMissionControl();
  const [filter, setFilter] = useState<FilterTab>('all');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [connectingAgentId, setConnectingAgentId] = useState<string | null>(null);
  const [activeSubAgents, setActiveSubAgents] = useState(0);
  const [isMinimized, setIsMinimized] = useState(false);

  const toggleMinimize = () => setIsMinimized(!isMinimized);

  // Load OpenClaw session status for all agents on mount
  const loadOpenClawSessions = useCallback(async () => {
    for (const agent of agents) {
      try {
        const res = await fetch(`/api/agents/${agent.id}/openclaw`);
        if (res.ok) {
          const data = await res.json();
          if (data.linked && data.session) {
            setAgentOpenClawSession(agent.id, data.session as OpenClawSession);
          }
        }
      } catch (error) {
        console.error(`Failed to load OpenClaw session for ${agent.name}:`, error);
      }
    }
  }, [agents, setAgentOpenClawSession]);

  useEffect(() => {
    if (agents.length > 0) {
      loadOpenClawSessions();
    }
  }, [loadOpenClawSessions, agents.length]);

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

  const handleConnectToOpenClaw = async (agent: Agent, e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent selecting the agent
    setConnectingAgentId(agent.id);

    try {
      const existingSession = agentOpenClawSessions[agent.id];

      if (existingSession) {
        // Disconnect
        const res = await fetch(`/api/agents/${agent.id}/openclaw`, { method: 'DELETE' });
        if (res.ok) {
          setAgentOpenClawSession(agent.id, null);
        }
      } else {
        // Connect
        const res = await fetch(`/api/agents/${agent.id}/openclaw`, { method: 'POST' });
        if (res.ok) {
          const data = await res.json();
          setAgentOpenClawSession(agent.id, data.session as OpenClawSession);
        } else {
          const error = await res.json();
          console.error('Failed to connect to OpenClaw:', error);
          alert(`Failed to connect: ${error.error || 'Unknown error'}`);
        }
      }
    } catch (error) {
      console.error('OpenClaw connection error:', error);
    } finally {
      setConnectingAgentId(null);
    }
  };

  const filteredAgents = agents.filter((agent) => {
    if (filter === 'all') return true;
    return agent.status === filter;
  });

  const getStatusBadge = (status: AgentStatus) => {
    const styles = {
      standby: 'status-standby',
      working: 'status-working',
      offline: 'status-offline',
    };
    return styles[status] || styles.standby;
  };

  return (
    <aside
      className={`bg-white border-r border-gray-200 flex flex-col transition-all duration-300 ease-in-out ${
        isMinimized ? 'w-12' : 'w-64'
      }`}
    >
      {/* Header */}
      <div className="p-3 border-b border-gray-100">
        <div className="flex items-center">
          <button
            onClick={toggleMinimize}
            className="p-1 rounded hover:bg-gray-100 text-gray-500 hover:text-gray-700 transition-colors"
            aria-label={isMinimized ? 'Expand agents' : 'Minimize agents'}
          >
            {isMinimized ? (
              <ChevronRight className="w-4 h-4" />
            ) : (
              <ChevronLeft className="w-4 h-4" />
            )}
          </button>
          {!isMinimized && (
            <>
              <span className="text-sm font-semibold text-gray-900 ml-1">Agents</span>
              <span className="bg-gray-100 text-gray-600 text-xs px-2 py-0.5 rounded-full ml-2 font-medium">
                {agents.length}
              </span>
            </>
          )}
        </div>

        {!isMinimized && (
          <>
            {/* Active Sub-Agents Counter */}
            {activeSubAgents > 0 && (
              <div className="mb-3 mt-3 px-3 py-2 bg-emerald-50 border border-emerald-200 rounded-lg">
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-emerald-500">●</span>
                  <span className="text-gray-700">Active Sub-Agents:</span>
                  <span className="font-semibold text-emerald-600">{activeSubAgents}</span>
                </div>
              </div>
            )}

            {/* Filter Tabs */}
            <div className="flex gap-1 mt-3">
              {(['all', 'working', 'standby'] as FilterTab[]).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setFilter(tab)}
                  className={`px-3 py-1.5 text-xs rounded-md font-medium transition-colors ${
                    filter === tab
                      ? 'bg-indigo-600 text-white'
                      : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                  }`}
                >
                  {tab.toUpperCase()}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Agent List */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {filteredAgents.map((agent) => {
          const openclawSession = agentOpenClawSessions[agent.id];

          if (isMinimized) {
            // Minimized view - just avatar
            return (
              <div key={agent.id} className="flex justify-center py-3">
                <button
                  onClick={() => {
                    setSelectedAgent(agent);
                    setEditingAgent(agent);
                  }}
                  className="relative group"
                  title={`${agent.name} - ${agent.role}`}
                >
                  <span className="text-2xl">{agent.avatar_emoji}</span>
                  {openclawSession && (
                    <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 bg-emerald-500 rounded-full border-2 border-white" />
                  )}
                  {!!agent.is_master && (
                    <span className="absolute -top-1 -right-1 text-xs text-amber-500">★</span>
                  )}
                  {/* Status indicator */}
                  <span
                    className={`absolute -bottom-1 left-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full ${
                      agent.status === 'working' ? 'bg-emerald-500' :
                      agent.status === 'standby' ? 'bg-gray-400' :
                      'bg-gray-300'
                    }`}
                  />
                  {/* Tooltip */}
                  <div className="absolute left-full ml-2 top-1/2 -translate-y-1/2 px-2 py-1 bg-gray-900 text-white text-xs rounded opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-50 shadow-lg">
                    {agent.name}
                  </div>
                </button>
              </div>
            );
          }

          // Expanded view - full agent card
          const isConnecting = connectingAgentId === agent.id;
          return (
            <div
              key={agent.id}
              className={`w-full rounded-lg transition-colors ${
                selectedAgent?.id === agent.id ? 'bg-indigo-50 border border-indigo-200' : 'hover:bg-gray-50'
              }`}
            >
              <button
                onClick={() => {
                  setSelectedAgent(agent);
                  setEditingAgent(agent);
                }}
                className="w-full flex items-center gap-3 p-2.5 text-left"
              >
                {/* Avatar */}
                <div className="text-2xl relative">
                  {agent.avatar_emoji}
                  {openclawSession && (
                    <span className="absolute -bottom-1 -right-1 w-3 h-3 bg-emerald-500 rounded-full border-2 border-white" />
                  )}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm text-gray-900 truncate">{agent.name}</span>
                    {!!agent.is_master && (
                      <span className="text-xs text-amber-500">★</span>
                    )}
                  </div>
                  <div className="text-xs text-gray-500 truncate">
                    {agent.role}
                  </div>
                </div>

                {/* Status */}
                <span
                  className={`text-xs px-2 py-0.5 rounded-full font-medium uppercase ${getStatusBadge(
                    agent.status
                  )}`}
                >
                  {agent.status}
                </span>
              </button>

              {/* OpenClaw Connect Button - show for master agents */}
              {!!agent.is_master && (
                <div className="px-2.5 pb-2.5">
                  <button
                    onClick={(e) => handleConnectToOpenClaw(agent, e)}
                    disabled={isConnecting}
                    className={`w-full flex items-center justify-center gap-2 px-2 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      openclawSession
                        ? 'bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100'
                        : 'bg-gray-50 text-gray-600 border border-gray-200 hover:bg-gray-100 hover:text-gray-900'
                    }`}
                  >
                    {isConnecting ? (
                      <>
                        <Loader2 className="w-3 h-3 animate-spin" />
                        <span>Connecting...</span>
                      </>
                    ) : openclawSession ? (
                      <>
                        <Zap className="w-3 h-3" />
                        <span>BlackCEO Command Center Connected</span>
                      </>
                    ) : (
                      <>
                        <ZapOff className="w-3 h-3" />
                        <span>Connect to Command Center</span>
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Add Agent Button */}
      {!isMinimized && (
        <div className="p-3 border-t border-gray-100">
          <button
            onClick={() => setShowCreateModal(true)}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-gray-50 hover:bg-gray-100 border border-gray-200 rounded-lg text-sm text-gray-600 hover:text-gray-900 font-medium transition-colors"
          >
            <Plus className="w-4 h-4" />
            Add Agent
          </button>
        </div>
      )}

      {/* Modals */}
      {showCreateModal && (
        <AgentModal onClose={() => setShowCreateModal(false)} workspaceId={workspaceId} />
      )}
      {editingAgent && (
        <AgentModal
          agent={editingAgent}
          onClose={() => setEditingAgent(null)}
          workspaceId={workspaceId}
        />
      )}
    </aside>
  );
}
