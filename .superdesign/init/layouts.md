# Layouts - BlackCEO Command Center

## Root Layout
**File:** `src/app/layout.tsx`

```tsx
import type { Metadata } from 'next';
import './globals.css';
import { JetBrains_Mono } from 'next/font/google';
import DemoBanner from '@/components/DemoBanner';

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains-mono',
  weight: ['400', '500', '600', '700'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'BlackCEO Command Center',
  description: 'AI Agent Orchestration Dashboard',
  icons: {
    icon: '/favicon.svg',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={jetbrainsMono.variable}>
      <body className={`${jetbrainsMono.className} bg-mc-bg text-mc-text min-h-screen`}>
        <DemoBanner />
        {children}
      </body>
    </html>
  );
}
```

## Header Component
**File:** `src/components/Header.tsx`
**Description:** Top navigation bar with logo, workspace indicator, stats, time, and online status.

```tsx
'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Settings, ChevronLeft, LayoutGrid } from 'lucide-react';
import { useMissionControl } from '@/lib/store';
import { format } from 'date-fns';
import type { Workspace } from '@/lib/types';

interface HeaderProps {
  workspace?: Workspace;
}

export function Header({ workspace }: HeaderProps) {
  const router = useRouter();
  const { agents, tasks, isOnline } = useMissionControl();
  const [currentTime, setCurrentTime] = useState(new Date());
  const [activeSubAgents, setActiveSubAgents] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

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
    const interval = setInterval(loadSubAgentCount, 30000);
    return () => clearInterval(interval);
  }, []);

  const workingAgents = agents.filter((a) => a.status === 'working').length;
  const activeAgents = workingAgents + activeSubAgents;
  const tasksInQueue = tasks.filter((t) => t.status !== 'done' && t.status !== 'review').length;

  return (
    <header className="h-14 bg-mc-bg-secondary border-b border-mc-border flex items-center justify-between px-4">
      {/* Left: Logo & Title */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <img 
            src="https://storage.googleapis.com/msgsndr/Mct54Bwi1KlNouGXQcDX/media/bbda8c9f-425b-45cd-a081-797689289593.png" 
            alt="BlackCEO Command Center" 
            className="h-8 w-auto"
          />
        </div>

        {workspace ? (
          <div className="flex items-center gap-2">
            <Link
              href="/"
              className="flex items-center gap-1 text-mc-text-secondary hover:text-mc-accent transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
              <LayoutGrid className="w-4 h-4" />
            </Link>
            <span className="text-mc-text-secondary">/</span>
            <div className="flex items-center gap-2 px-3 py-1 bg-mc-bg-tertiary rounded">
              <span className="text-lg">{workspace.icon}</span>
              <span className="font-medium">{workspace.name}</span>
            </div>
          </div>
        ) : (
          <Link
            href="/"
            className="flex items-center gap-2 px-3 py-1 bg-mc-bg-tertiary rounded hover:bg-mc-bg transition-colors"
          >
            <LayoutGrid className="w-4 h-4" />
            <span className="text-sm">All Workspaces</span>
          </Link>
        )}
      </div>

      {/* Center: Stats */}
      {workspace && (
        <div className="flex items-center gap-8">
          <div className="text-center">
            <div className="text-2xl font-bold text-mc-accent-cyan">{activeAgents}</div>
            <div className="text-xs text-mc-text-secondary uppercase">Agents Active</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-mc-accent-purple">{tasksInQueue}</div>
            <div className="text-xs text-mc-text-secondary uppercase">Tasks in Queue</div>
          </div>
        </div>
      )}

      {/* Right: Time & Status */}
      <div className="flex items-center gap-4">
        <span className="text-mc-text-secondary text-sm font-mono">
          {format(currentTime, 'HH:mm:ss')}
        </span>
        <div
          className={`flex items-center gap-2 px-3 py-1 rounded border text-sm font-medium ${
            isOnline
              ? 'bg-mc-accent-green/20 border-mc-accent-green text-mc-accent-green'
              : 'bg-mc-accent-red/20 border-mc-accent-red text-mc-accent-red'
          }`}
        >
          <span
            className={`w-2 h-2 rounded-full ${
              isOnline ? 'bg-mc-accent-green animate-pulse' : 'bg-mc-accent-red'
            }`}
          />
          {isOnline ? 'ONLINE' : 'OFFLINE'}
        </div>
        <button
          onClick={() => router.push('/settings')}
          className="p-2 hover:bg-mc-bg-tertiary rounded text-mc-text-secondary"
          title="Settings"
        >
          <Settings className="w-5 h-5" />
        </button>
      </div>
    </header>
  );
}
```

## Demo Banner
**File:** `src/components/DemoBanner.tsx`
**Description:** Top banner shown in demo mode.

```tsx
'use client';

import { useEffect, useState } from 'react';

export default function DemoBanner() {
  const [isDemo, setIsDemo] = useState(false);

  useEffect(() => {
    fetch('/api/demo')
      .then(r => r.json())
      .then(data => setIsDemo(data.demo))
      .catch(() => {});
  }, []);

  if (!isDemo) return null;

  return (
    <div className="bg-gradient-to-r from-blue-600 via-purple-600 to-blue-600 text-white text-center py-2 px-4 text-sm font-medium z-50 relative">
      <span className="mr-2">DEMO</span>
      <span>Live Demo - AI agents are working in real-time. This is a read-only simulation.</span>
      <a
        href="https://github.com/crshdn/mission-control"
        target="_blank"
        rel="noopener noreferrer"
        className="ml-3 underline hover:text-blue-200 transition-colors"
      >
        Get BlackCEO Command Center
      </a>
    </div>
  );
}
```
