'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Settings, ChevronLeft, LayoutGrid, Menu, X, BarChart3 } from 'lucide-react';
import { useMissionControl } from '@/lib/store';
import { LogoConfig } from '@/lib/logo';
import { useLogoUrl } from '@/hooks/useLogoUrl';
import { format } from 'date-fns';
import type { Workspace } from '@/lib/types';

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
            <span className="text-sm font-medium text-gray-700">All Workspaces</span>
          </Link>
        )}
      </div>

      {/* Center: Stats - only show in workspace view */}
      {workspace && (
        <div className="flex items-center gap-8">
          <div className="text-center">
            <div className="text-2xl font-bold text-indigo-600">{activeAgents}</div>
            <div className="text-xs text-gray-500 uppercase tracking-wide">Agents Active</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-purple-600">{tasksInQueue}</div>
            <div className="text-xs text-gray-500 uppercase tracking-wide">Tasks in Queue</div>
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
        <button
          onClick={() => router.push('/ceo-board')}
          className="flex items-center gap-2 px-3 py-1.5 bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-sm font-medium rounded-lg hover:shadow-md transition-all duration-200"
          title="CEO Performance Board"
        >
          <BarChart3 className="w-4 h-4" />
          <span className="hidden sm:inline">Performance Board</span>
        </button>
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
