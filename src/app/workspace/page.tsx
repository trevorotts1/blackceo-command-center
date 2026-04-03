'use client';

import { useEffect, useState, Suspense, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { motion } from 'framer-motion';
import { Building2, Users, BarChart3, ArrowRight, Activity, Loader2, Home, GripVertical, ListTodo } from 'lucide-react';
import { useCompanyBrand } from '@/hooks/useCompanyBrand';
import { DragDropContext, Droppable, Draggable, DropResult } from '@hello-pangea/dnd';

interface Workspace {
  id: string;
  name: string;
  description: string;
  slug?: string;
  icon?: string;
  sort_order?: number;
  taskCounts?: { total: number };
  agentCount?: number;
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
  const brand = useCompanyBrand();
  const companyFilter = searchParams.get('company');
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [companyName, setCompanyName] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    async function fetchData() {
      try {
        const [wsRes, companyRes] = await Promise.all([
          fetch('/api/workspaces?stats=true', { cache: 'no-store' }),
          fetch('/api/company', { cache: 'no-store' }),
        ]);
        const wsData = await wsRes.json();
        const companyData = await companyRes.json();

        let allWorkspaces: Workspace[] = Array.isArray(wsData) ? wsData : wsData.workspaces || [];

        // Filter out demo workspaces, utility workspaces, and empty/blank entries
        allWorkspaces = allWorkspaces.filter((w) => {
          const slug = (w as any).slug || w.id;
          if (!w.name || w.name.trim() === '') return false;
          return !slug.startsWith('acme-') &&
                 !slug.startsWith('zhw-') &&
                 slug !== 'default';
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

  const onDragEnd = useCallback(async (result: DropResult) => {
    if (!result.destination) return;
    const from = result.source.index;
    const to = result.destination.index;
    if (from === to) return;

    // Reorder locally
    const reordered = Array.from(workspaces);
    const [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved);
    setWorkspaces(reordered);

    // Persist to DB
    setSaving(true);
    try {
      const order = reordered.map((w) => w.id);
      await fetch('/api/workspaces', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order }),
      });
    } catch (err) {
      console.error('Failed to persist workspace order:', err);
    } finally {
      setSaving(false);
    }
  }, [workspaces]);

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

  const hasBrand = brand.primaryColor && brand.secondaryColor;
  const cardBackground = hasBrand
    ? { background: `linear-gradient(135deg, ${brand.primaryLight}, ${brand.secondaryLight})` }
    : null;

  return (
    <div className="min-h-screen bg-[#F8F9FB] flex flex-col">
      {/* Header */}
      <header className="border-b border-gray-200 bg-white px-4 py-3 sm:flex sm:min-h-16 sm:items-center sm:justify-between sm:px-6 sm:py-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2 sm:gap-4">
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-lg flex items-center justify-center">
              <Building2 className="w-5 h-5 text-white" />
            </div>
            <span className="max-w-[11rem] truncate text-lg font-bold tracking-tight text-gray-900 sm:max-w-none sm:text-xl">{companyName}</span>
          </div>
          <div className="mx-2 hidden h-6 w-px bg-gray-200 sm:block" />
          <h1 className="text-gray-900 font-semibold text-lg">Workspaces</h1>
          {saving && (
            <span className="text-xs text-indigo-500 font-medium animate-pulse ml-2">Saving order...</span>
          )}
        </div>

        {/* Nav buttons */}
        <div className="mt-3 flex items-center gap-2 sm:mt-0 sm:gap-3">
          <motion.button
            onClick={() => router.push('/')}
            className="flex min-h-[44px] items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition-all hover:bg-gray-50 sm:px-4"
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
          >
            <Home className="w-4 h-4" />
            Home
          </motion.button>
          <motion.button
            onClick={() => router.push('/ceo-board')}
            className="flex min-h-[44px] items-center gap-2 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 px-3 py-2 text-sm font-medium text-white shadow-sm transition-all hover:shadow-md sm:px-4"
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
          >
            <BarChart3 className="w-4 h-4" />
            CEO Performance Board
          </motion.button>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex flex-col items-center px-4 py-8 sm:px-6 sm:py-12">
        <motion.div
          className="max-w-6xl w-full"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <div className="mb-8 text-center sm:mb-12">
            <h2 className="mb-4 text-3xl font-bold text-gray-900 sm:text-4xl lg:text-5xl">
              Select a Department
            </h2>
            <p className="mx-auto max-w-xl px-2 text-base text-gray-500 sm:px-0 sm:text-lg">
              Click any department to open its Kanban board. Drag to reorder.
            </p>
          </div>

          {workspaces.length === 0 ? (
            <div className="text-center py-20">
              <p className="text-gray-500 text-lg">No departments found.</p>
              <p className="text-gray-400 text-sm mt-2">Create your first department to get started.</p>
            </div>
          ) : (
            <DragDropContext onDragEnd={onDragEnd}>
              <Droppable droppableId="workspaces-grid">
                {(provided) => (
                  <div
                    ref={provided.innerRef}
                    {...provided.droppableProps}
                    className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6"
                  >
                    {workspaces.map((workspace, index) => (
                      <Draggable
                        key={workspace.id}
                        draggableId={workspace.id}
                        index={index}
                      >
                        {(dragProvided, snapshot) => (
                          <div
                            ref={dragProvided.innerRef}
                            {...dragProvided.draggableProps}
                            style={{
                              ...dragProvided.draggableProps.style,
                            }}
                          >
                            <motion.button
                              onClick={() => router.push(`/workspace/${workspace.slug || workspace.id}`)}
                              className={`group relative w-full text-left ${snapshot.isDragging ? 'z-50' : ''}`}
                              initial={{ opacity: 0, y: 20 }}
                              animate={{ opacity: 1, y: 0 }}
                              transition={{ delay: index * 0.05 }}
                              whileHover={{ scale: snapshot.isDragging ? 1.0 : 1.03 }}
                              whileTap={{ scale: 0.98 }}
                            >
                              <div
                                className={`relative overflow-hidden rounded-3xl ${cardBackground ? '' : `bg-gradient-to-br ${gradients[index % gradients.length]}`} p-6 sm:p-8 min-h-[180px] flex flex-col shadow-xl shadow-gray-200/50 group-hover:shadow-2xl group-hover:shadow-gray-300/50 transition-shadow duration-300 ${snapshot.isDragging ? 'ring-2 ring-indigo-400 shadow-2xl shadow-indigo-200/50' : ''}`}
                                style={cardBackground || undefined}
                              >
                                {/* Drag handle */}
                                <div
                                  {...dragProvided.dragHandleProps}
                                  className="absolute top-3 right-3 z-20 rounded-lg bg-white/20 p-2 backdrop-blur-sm opacity-100 transition-opacity cursor-grab active:cursor-grabbing sm:opacity-0 sm:group-hover:opacity-100"
                                  title="Drag to reorder"
                                >
                                  <GripVertical className="w-4 h-4 text-white/80" />
                                </div>

                                <div className="absolute -top-10 -right-10 w-40 h-40 bg-white/10 rounded-full blur-2xl" />
                                <div className="absolute -bottom-10 -left-10 w-32 h-32 bg-black/5 rounded-full blur-xl" />

                                <div className="relative z-10 flex flex-col h-full">
                                  <div className="flex items-center justify-between mb-4">
                                    <div className="flex items-center gap-2 px-3 py-1.5 bg-white/20 backdrop-blur-sm rounded-full">
                                      <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                                      <span className="text-white text-xs font-medium uppercase tracking-wider">Active</span>
                                    </div>
                                    <Users className="w-6 h-6 text-white" />
                                  </div>

                                  <h3 className="text-white font-bold text-2xl mb-2 leading-tight">
                                    {workspace.icon ? `${workspace.icon} ` : ''}{workspace.name}
                                  </h3>

                                  {workspace.description && (
                                    <p className="text-white text-sm line-clamp-2 mt-auto">
                                      {workspace.description}
                                    </p>
                                  )}

                                  {(workspace.taskCounts || workspace.agentCount !== undefined) && (
                                    <div className="flex items-center gap-4 mt-2 text-white text-sm">
                                      {workspace.taskCounts && (
                                        <span className="flex items-center gap-1"><ListTodo className="w-3.5 h-3.5" /> {workspace.taskCounts.total} tasks</span>
                                      )}
                                      {workspace.agentCount !== undefined && (
                                        <span className="flex items-center gap-1"><Users className="w-3.5 h-3.5" /> {workspace.agentCount} agents</span>
                                      )}
                                    </div>
                                  )}

                                  <div className="mt-4 flex items-center gap-2 text-white font-medium">
                                    <span className="text-sm">Open Department</span>
                                    <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform duration-200" />
                                  </div>
                                </div>
                              </div>
                            </motion.button>
                          </div>
                        )}
                      </Draggable>
                    ))}
                    {provided.placeholder}
                  </div>
                )}
              </Droppable>
            </DragDropContext>
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
