'use client';

import { useState, useEffect } from 'react';
import { Plus, ArrowRight, Folder, Users, CheckSquare, Trash2, AlertTriangle, Sparkles, Zap } from 'lucide-react';
import Link from 'next/link';
import { LogoConfig } from '@/lib/logo';
import type { WorkspaceStats } from '@/lib/types';

export function WorkspaceDashboard() {
  const [workspaces, setWorkspaces] = useState<WorkspaceStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);

  useEffect(() => {
    loadWorkspaces();
  }, []);

  const loadWorkspaces = async () => {
    try {
      const res = await fetch('/api/workspaces?stats=true');
      if (res.ok) {
        const data = await res.json();
        setWorkspaces(data);
      }
    } catch (error) {
      console.error('Failed to load workspaces:', error);
    } finally {
      setLoading(false);
    }
  };

  // Calculate total stats (defensive for demo)
  const totalTasks = workspaces.reduce((sum, w) => sum + (w.taskCounts?.total || 0), 0);
  const totalAgents = workspaces.reduce((sum, w) => sum + (w.agentCount || 0), 0);
  const activeTasks = workspaces.reduce((sum, w) => sum + (w.taskCounts?.in_progress || 0), 0);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#F8F9FB] flex items-center justify-center">
        <div className="text-center">
          <img
            src={LogoConfig.url}
            alt="Loading"
            className="h-12 w-auto mb-4 animate-pulse"
          />
          <p className="text-gray-500">Loading workspaces...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F8F9FB]">
      {/* Header */}
      <header className="bg-white border-b border-gray-100">
        <div className="max-w-7xl mx-auto px-6 py-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="relative">
                <img
                  src={LogoConfig.url}
                  alt={LogoConfig.alt}
                  className="h-10 w-auto"
                />
                <span className="absolute -top-1 -right-3 flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                </span>
              </div>
              {/* Live Demo Badge */}
              <span className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-gradient-to-r from-amber-400 to-orange-500 text-white text-xs font-bold uppercase tracking-wide shadow-sm">
                <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse"></span>
                Live Demo
              </span>
            </div>
            <button
              onClick={() => setShowCreateModal(true)}
              className="flex items-center gap-2 px-5 py-2.5 bg-indigo-600 text-white rounded-xl font-medium hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-200 hover:shadow-xl hover:shadow-indigo-200"
            >
              <Plus className="w-4 h-4" />
              New Workspace
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-6 py-10">
        {/* Welcome Section */}
        <div className="mb-10">
          <div className="flex items-center gap-2 mb-2">
            <Sparkles className="w-5 h-5 text-amber-500" />
            <span className="text-sm font-medium text-amber-600 uppercase tracking-wide">Command Center</span>
          </div>
          <h1 className="text-3xl font-bold text-gray-900 mb-3">
            Welcome back, Trevor
          </h1>
          <p className="text-gray-500 text-lg max-w-2xl">
            Manage your AI workforce across all workspaces. Dispatch tasks, monitor progress, and review deliverables from one central hub.
          </p>
        </div>

        {/* Stats Overview */}
        {workspaces.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-10">
            <StatCard 
              icon={<Folder className="w-5 h-5 text-indigo-600" />}
              label="Workspaces"
              value={workspaces.length}
              color="indigo"
            />
            <StatCard 
              icon={<CheckSquare className="w-5 h-5 text-emerald-600" />}
              label="Total Tasks"
              value={totalTasks}
              subValue={activeTasks > 0 ? `${activeTasks} active` : undefined}
              color="emerald"
            />
            <StatCard 
              icon={<Users className="w-5 h-5 text-violet-600" />}
              label="AI Agents"
              value={totalAgents}
              color="violet"
            />
          </div>
        )}

        {/* Section Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-xl font-bold text-gray-900">Your Workspaces</h2>
            <p className="text-gray-500 text-sm mt-0.5">
              {workspaces.length === 0 
                ? 'Get started by creating your first workspace'
                : `Select a workspace to view tasks and agents`
              }
            </p>
          </div>
          {workspaces.length > 0 && (
            <div className="flex items-center gap-2 text-sm text-gray-400">
              <span>Sorted by:</span>
              <span className="font-medium text-gray-600">Recently updated</span>
            </div>
          )}
        </div>

        {workspaces.length === 0 ? (
          <EmptyState onCreate={() => setShowCreateModal(true)} />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {workspaces.map((workspace, index) => (
              <WorkspaceCard 
                key={workspace.id} 
                workspace={workspace} 
                onDelete={(id) => setWorkspaces(workspaces.filter(w => w.id !== id))}
                index={index}
              />
            ))}
            
            {/* Add workspace card */}
            <button
              onClick={() => setShowCreateModal(true)}
              className="group border-2 border-dashed border-gray-300 rounded-2xl p-6 hover:border-indigo-400 hover:bg-indigo-50/30 transition-all flex flex-col items-center justify-center gap-4 min-h-[220px]"
            >
              <div className="w-14 h-14 rounded-2xl bg-gray-100 group-hover:bg-indigo-100 flex items-center justify-center transition-colors">
                <Plus className="w-7 h-7 text-gray-400 group-hover:text-indigo-600 transition-colors" />
              </div>
              <div className="text-center">
                <span className="block text-gray-900 font-medium mb-1">Create Workspace</span>
                <span className="text-gray-400 text-sm">Add a new project area</span>
              </div>
            </button>
          </div>
        )}
      </main>

      {/* Create Modal */}
      {showCreateModal && (
        <CreateWorkspaceModal 
          onClose={() => setShowCreateModal(false)}
          onCreated={() => {
            setShowCreateModal(false);
            loadWorkspaces();
          }}
        />
      )}
    </div>
  );
}

function StatCard({ icon, label, value, subValue, color }: { 
  icon: React.ReactNode; 
  label: string; 
  value: number;
  subValue?: string;
  color: 'indigo' | 'emerald' | 'violet';
}) {
  const colorClasses = {
    indigo: 'bg-indigo-50 border-indigo-100',
    emerald: 'bg-emerald-50 border-emerald-100',
    violet: 'bg-violet-50 border-violet-100',
  };

  return (
    <div className={`${colorClasses[color]} border rounded-2xl p-5 flex items-center gap-4`}>
      <div className="w-12 h-12 rounded-xl bg-white flex items-center justify-center shadow-sm">
        {icon}
      </div>
      <div>
        <p className="text-gray-500 text-sm font-medium">{label}</p>
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-bold text-gray-900">{value}</span>
          {subValue && (
            <span className="text-sm text-emerald-600 font-medium">{subValue}</span>
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="bg-white border border-gray-200 rounded-2xl p-12 text-center">
      <div className="w-20 h-20 rounded-2xl bg-indigo-50 flex items-center justify-center mx-auto mb-6">
        <Zap className="w-10 h-10 text-indigo-500" />
      </div>
      <h3 className="text-xl font-bold text-gray-900 mb-2">Launch Your First Workspace</h3>
      <p className="text-gray-500 mb-8 max-w-md mx-auto">
        Workspaces are dedicated areas for managing AI agents and tasks. Create one for each project, department, or client.
      </p>
      <button
        onClick={onCreate}
        className="inline-flex items-center gap-2 px-6 py-3 bg-indigo-600 text-white rounded-xl font-medium hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-200"
      >
        <Plus className="w-5 h-5" />
        Create Workspace
      </button>
    </div>
  );
}

function WorkspaceCard({ workspace, onDelete, index }: { workspace: WorkspaceStats; onDelete: (id: string) => void; index: number }) {
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDeleting(true);
    try {
      const res = await fetch(`/api/workspaces/${workspace.id}`, { method: 'DELETE' });
      if (res.ok) {
        onDelete(workspace.id);
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to delete workspace');
      }
    } catch {
      alert('Failed to delete workspace');
    } finally {
      setDeleting(false);
      setShowDeleteConfirm(false);
    }
  };

  // Calculate task distribution for mini progress bar (defensive for demo)
  const safeTaskCounts = workspace.taskCounts || { total: 0, done: 0, in_progress: 0 };
  const completedPercent = safeTaskCounts.total > 0 
    ? (safeTaskCounts.done / safeTaskCounts.total) * 100 
    : 0;

  // Card accent colors based on index
  const accentColors = [
    'from-indigo-500 to-violet-500',
    'from-emerald-500 to-teal-500',
    'from-amber-500 to-orange-500',
    'from-rose-500 to-pink-500',
    'from-cyan-500 to-blue-500',
    'from-fuchsia-500 to-purple-500',
  ];
  const accentColor = accentColors[index % accentColors.length];

  return (
    <>
    <Link href={`/workspace/${workspace.slug}`}>
      <div className="bg-white border border-gray-200 rounded-2xl p-6 hover:border-indigo-300 hover:shadow-xl transition-all cursor-pointer group relative overflow-hidden">
        {/* Top accent bar */}
        <div className={`absolute top-0 left-0 right-0 h-1 bg-gradient-to-r ${accentColor}`} />
        
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-gray-50 flex items-center justify-center text-2xl">
              {workspace.icon}
            </div>
            <div>
              <h3 className="font-semibold text-lg text-gray-900 group-hover:text-indigo-600 transition-colors">
                {workspace.name}
              </h3>
              <span className="text-xs text-gray-400 font-medium">/{workspace.slug}</span>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {workspace.id !== 'default' && (
              <button
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setShowDeleteConfirm(true);
                }}
                className="p-2 rounded-lg hover:bg-red-50 text-gray-300 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100"
                title="Delete workspace"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
            <div className="w-8 h-8 rounded-lg bg-gray-50 group-hover:bg-indigo-50 flex items-center justify-center transition-colors">
              <ArrowRight className="w-4 h-4 text-gray-400 group-hover:text-indigo-600 transition-colors" />
            </div>
          </div>
        </div>

        {/* Task stats with pills */}
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-gray-100 text-gray-600">
            <CheckSquare className="w-3.5 h-3.5" />
            {safeTaskCounts.total} tasks
          </span>
          {safeTaskCounts.in_progress > 0 && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-amber-100 text-amber-700">
              <Zap className="w-3.5 h-3.5" />
              {safeTaskCounts.in_progress} active
            </span>
          )}
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-indigo-100 text-indigo-700">
            <Users className="w-3.5 h-3.5" />
            {workspace.agentCount || 0} agents
          </span>
        </div>

        {/* Progress bar */}
        {safeTaskCounts.total > 0 && (
          <div className="mt-4 pt-4 border-t border-gray-100">
            <div className="flex items-center justify-between text-xs mb-2">
              <span className="text-gray-500 font-medium">Progress</span>
              <span className="text-gray-900 font-semibold">{Math.round(completedPercent)}%</span>
            </div>
            <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
              <div 
                className={`h-full bg-gradient-to-r ${accentColor} rounded-full transition-all duration-500`}
                style={{ width: `${completedPercent}%` }}
              />
            </div>
          </div>
        )}
      </div>
    </Link>

    {/* Delete Confirmation Modal */}
    {showDeleteConfirm && (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setShowDeleteConfirm(false)}>
        <div className="bg-white border border-gray-200 rounded-2xl w-full max-w-md p-6 shadow-xl" onClick={e => e.stopPropagation()}>
          <div className="flex items-center gap-3 mb-4">
            <div className="p-3 bg-red-100 rounded-full">
              <AlertTriangle className="w-6 h-6 text-red-600" />
            </div>
            <div>
              <h3 className="font-semibold text-lg text-gray-900">Delete Workspace</h3>
              <p className="text-sm text-gray-500">This action cannot be undone</p>
            </div>
          </div>
          
          <p className="text-gray-600 mb-6">
            Are you sure you want to delete <strong className="text-gray-900">{workspace.name}</strong>? 
            {safeTaskCounts.total > 0 && (
              <span className="block mt-2 text-red-600">
                This workspace has {safeTaskCounts.total} task(s). Delete them first.
              </span>
            )}
          </p>
          
          <div className="flex justify-end gap-3">
            <button
              onClick={() => setShowDeleteConfirm(false)}
              className="px-4 py-2 text-gray-600 hover:text-gray-900 font-medium transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleDelete}
              disabled={deleting || safeTaskCounts.total > 0 || (workspace.agentCount || 0) > 0}
              className="px-4 py-2 bg-red-600 text-white rounded-lg font-medium hover:bg-red-700 disabled:opacity-50 transition-colors"
            >
              {deleting ? 'Deleting...' : 'Delete Workspace'}
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}

function CreateWorkspaceModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('📁');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const icons = ['📁', '💼', '🏢', '🚀', '💡', '🎯', '📊', '🔧', '🌟', '🏠'];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    setIsSubmitting(true);
    setError(null);

    try {
      const res = await fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), icon }),
      });

      if (res.ok) {
        onCreated();
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to create workspace');
      }
    } catch {
      setError('Failed to create workspace');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white border border-gray-200 rounded-xl w-full max-w-md shadow-xl">
        <div className="p-6 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Create New Workspace</h2>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {/* Icon selector */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Icon</label>
            <div className="flex flex-wrap gap-2">
              {icons.map((i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setIcon(i)}
                  className={`w-10 h-10 rounded-lg text-xl flex items-center justify-center transition-colors ${
                    icon === i 
                      ? 'bg-indigo-100 border-2 border-indigo-500' 
                      : 'bg-gray-50 border border-gray-200 hover:border-indigo-300'
                  }`}
                >
                  {i}
                </button>
              ))}
            </div>
          </div>

          {/* Name input */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Acme Corp"
              className="w-full bg-white border border-gray-300 rounded-lg px-4 py-2.5 text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              autoFocus
            />
          </div>

          {error && (
            <div className="text-red-600 text-sm">{error}</div>
          )}

          <div className="flex justify-end gap-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-gray-600 hover:text-gray-900 font-medium transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!name.trim() || isSubmitting}
              className="px-6 py-2 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              {isSubmitting ? 'Creating...' : 'Create Workspace'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
