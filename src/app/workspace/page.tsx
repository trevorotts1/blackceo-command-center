'use client';

import { useEffect, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { motion } from 'framer-motion';
import { Building2, Users, BarChart3, ArrowRight, Activity, Loader2, Home } from 'lucide-react';

interface Workspace {
  id: string;
  name: string;
  description: string;
}

const gradients = [
  'from-indigo-500 to-purple-600',
  'from-emerald-500 to-teal-600',
  'from-rose-500 to-pink-600',
  'from-amber-500 to-orange-600',
  'from-sky-500 to-blue-600',
  'from-violet-500 to-fuchsia-600',
  'from-lime-500 to-green-600',
  'from-red-500 to-rose-600',
];

function WorkspaceSelectorInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const companyFilter = searchParams.get('company');
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [companyName, setCompanyName] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        const [wsRes, companyRes] = await Promise.all([
          fetch('/api/workspaces', { cache: 'no-store' }),
          fetch('/api/company', { cache: 'no-store' }),
        ]);
        const wsData = await wsRes.json();
        const companyData = await companyRes.json();

        let allWorkspaces: Workspace[] = Array.isArray(wsData) ? wsData : wsData.workspaces || [];

        // Filter out demo workspaces and utility workspaces
        allWorkspaces = allWorkspaces.filter((w) => {
          const slug = (w as any).slug || w.id;
          return !slug.startsWith('acme-') &&
                 !slug.startsWith('zhw-') &&
                 slug !== 'default' &&
                 slug !== 'ceo';
        });

        // If a company filter is passed, show only that company's workspaces
        if (companyFilter) {
          allWorkspaces = allWorkspaces.filter(
            (w) => (w as any).company_id === companyFilter
          );
        }

        setWorkspaces(allWorkspaces);
        setCompanyName(companyData.name || companyData.company?.name || 'Command Center');
      } catch (err) {
        console.error('Failed to fetch workspaces:', err);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [companyFilter]);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#F8F9FB] flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-gray-500">
          <Loader2 className="h-8 w-8 animate-spin" />
          <span className="text-sm font-medium">Loading departments...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F8F9FB] flex flex-col">
      {/* Header */}
      <header className="h-16 bg-white border-b border-gray-200 px-6 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-lg flex items-center justify-center">
              <Building2 className="w-5 h-5 text-white" />
            </div>
            <span className="text-gray-900 font-bold text-xl tracking-tight">{companyName}</span>
          </div>
          <div className="h-6 w-px bg-gray-200 mx-2" />
          <h1 className="text-gray-900 font-semibold text-lg">Departments</h1>
        </div>

        {/* Nav buttons */}
        <div className="flex items-center gap-3">
          <motion.button
            onClick={() => router.push('/')}
            className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 text-gray-700 rounded-xl font-medium text-sm hover:bg-gray-50 transition-all"
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
          >
            <Home className="w-4 h-4" />
            Home
          </motion.button>
          <motion.button
            onClick={() => router.push('/ceo-board')}
            className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-indigo-600 to-purple-600 text-white rounded-xl font-medium text-sm shadow-sm hover:shadow-md transition-all"
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
          >
            <BarChart3 className="w-4 h-4" />
            CEO Performance Board
          </motion.button>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex flex-col items-center px-6 py-12">
        <motion.div
          className="max-w-6xl w-full"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <div className="text-center mb-12">
            <h2 className="text-4xl sm:text-5xl font-bold text-gray-900 mb-4">
              Select a Department
            </h2>
            <p className="text-gray-500 text-lg max-w-xl mx-auto">
              Click any department to open its Kanban board with tasks, live feed, and agents
            </p>
          </div>

          {workspaces.length === 0 ? (
            <div className="text-center py-20">
              <p className="text-gray-500 text-lg">No departments found.</p>
              <p className="text-gray-400 text-sm mt-2">Run Skill 23 (AI Workforce Blueprint) to set up your departments.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {workspaces.map((workspace, index) => (
                <motion.button
                  key={workspace.id}
                  onClick={() => router.push(`/workspace/${workspace.id}`)}
                  className="group relative w-full text-left"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.05 }}
                  whileHover={{ scale: 1.03 }}
                  whileTap={{ scale: 0.98 }}
                >
                  <div className={`relative overflow-hidden rounded-3xl bg-gradient-to-br ${gradients[index % gradients.length]} p-6 sm:p-8 min-h-[180px] flex flex-col shadow-xl shadow-gray-200/50 group-hover:shadow-2xl group-hover:shadow-gray-300/50 transition-shadow duration-300`}>
                    <div className="absolute -top-10 -right-10 w-40 h-40 bg-white/10 rounded-full blur-2xl" />
                    <div className="absolute -bottom-10 -left-10 w-32 h-32 bg-black/5 rounded-full blur-xl" />

                    <div className="relative z-10 flex flex-col h-full">
                      <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-2 px-3 py-1.5 bg-white/20 backdrop-blur-sm rounded-full">
                          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                          <span className="text-white/90 text-xs font-medium uppercase tracking-wider">Active</span>
                        </div>
                        <Users className="w-6 h-6 text-white/60" />
                      </div>

                      <h3 className="text-white font-bold text-2xl mb-2 leading-tight">
                        {workspace.name}
                      </h3>

                      {workspace.description && (
                        <p className="text-white/80 text-sm line-clamp-2 mt-auto">
                          {workspace.description}
                        </p>
                      )}

                      <div className="mt-4 flex items-center gap-2 text-white font-medium">
                        <span className="text-sm">Open Kanban Board</span>
                        <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform duration-200" />
                      </div>
                    </div>
                  </div>
                </motion.button>
              ))}
            </div>
          )}

          <div className="mt-12 text-center">
            <div className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-full text-gray-500 text-sm">
              <Activity className="w-4 h-4 text-indigo-500" />
              <span>{workspaces.length} departments</span>
              <span className="w-1 h-1 bg-gray-300 rounded-full" />
              <span>All systems operational</span>
            </div>
          </div>
        </motion.div>
      </main>
    </div>
  );
}

export default function WorkspaceSelector() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-[#F8F9FB] flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
      </div>
    }>
      <WorkspaceSelectorInner />
    </Suspense>
  );
}
