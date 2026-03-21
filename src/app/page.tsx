'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLogoUrl } from '@/hooks/useLogoUrl';

interface WorkspaceStats {
  id: string;
  name: string;
  slug: string;
  icon?: string;
  taskCounts: {
    backlog: number;
    in_progress: number;
    review: number;
    blocked: number;
    done: number;
    total: number;
  };
  agentCount: number;
}

export default function HomePage() {
  const router = useRouter();
  const logoUrl = useLogoUrl();
  const [workspaces, setWorkspaces] = useState<WorkspaceStats[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/workspaces?stats=true')
      .then(r => r.json())
      .then(data => {
        setWorkspaces(data);
        setLoading(false);
      })
      .catch(() => {
        setLoading(false);
      });
  }, [router]);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#F8F9FB] flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-10 h-10 border-2 border-gray-200 border-t-indigo-500 rounded-full animate-spin" />
          <p className="text-gray-400 text-sm">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F8F9FB] flex flex-col">
      {/* Header */}
      <header className="h-14 bg-white border-b border-gray-200 px-4 sm:px-8 flex items-center gap-4">
        {logoUrl ? (
          <img src={logoUrl} alt="Logo" className="h-8 object-contain" />
        ) : (
          <span className="text-gray-900 font-bold text-xl tracking-tight">Command Center</span>
        )}
      </header>

      {/* Main */}
      <main className="flex-1 flex flex-col items-center justify-start sm:justify-center px-4 sm:px-8 py-8 sm:py-16 overflow-y-auto">
        <div className="max-w-3xl w-full">
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 mb-2">Select a Workspace</h1>
          <p className="text-gray-400 mb-6 sm:mb-10 text-sm sm:text-base">Choose the company you want to manage today.</p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {workspaces.map(ws => (
              <button
                key={ws.id}
                onClick={() => router.push(`/workspace/${ws.slug}`)}
                className="group relative bg-white hover:bg-gray-50 border border-gray-200 hover:border-indigo-300 hover:shadow-md rounded-2xl p-4 sm:p-6 text-left transition-all duration-200"
              >
                {/* Icon + Name */}
                <div className="flex items-center gap-3 mb-4">
                  <span className="text-xl sm:text-2xl">{ws.icon || '🏢'}</span>
                  <span className="text-gray-900 font-semibold text-base sm:text-lg leading-tight">{ws.name}</span>
                </div>

                {/* Stats */}
                <div className="grid grid-cols-3 gap-2 sm:gap-3">
                  <div className="bg-indigo-50 rounded-xl p-2 sm:p-3">
                    <div className="text-indigo-700 font-bold text-lg sm:text-xl">{ws.taskCounts.in_progress}</div>
                    <div className="text-gray-400 text-[10px] sm:text-xs mt-0.5">In Progress</div>
                  </div>
                  <div className="bg-amber-50 rounded-xl p-2 sm:p-3">
                    <div className="text-amber-700 font-bold text-lg sm:text-xl">{ws.taskCounts.review}</div>
                    <div className="text-gray-400 text-[10px] sm:text-xs mt-0.5">In Review</div>
                  </div>
                  <div className="bg-emerald-50 rounded-xl p-2 sm:p-3">
                    <div className="text-emerald-700 font-bold text-lg sm:text-xl">{ws.agentCount}</div>
                    <div className="text-gray-400 text-[10px] sm:text-xs mt-0.5">Agents</div>
                  </div>
                </div>

                {/* Total tasks */}
                <div className="mt-3 sm:mt-4 flex items-center justify-between">
                  <span className="text-gray-400 text-[10px] sm:text-xs">{ws.taskCounts.total} total tasks</span>
                  <span className="text-gray-300 text-[10px] sm:text-xs group-hover:text-indigo-500 transition-colors">Open →</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
