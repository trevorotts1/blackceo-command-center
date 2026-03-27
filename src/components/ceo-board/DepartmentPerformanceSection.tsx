'use client';

import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { FilterTabs, FilterTab } from './FilterTabs';
import { DepartmentGrid } from './DepartmentGrid';
import { DepartmentPerformance } from './DepartmentCard';
import { Building2, TrendingUp } from 'lucide-react';
import type { WorkspaceStats, Task } from '@/lib/types';

const EXCLUDED_WORKSPACE_IDS = ['default'];

interface DepartmentPerformanceSectionProps {
  className?: string;
}

// Map database task status to department stats
function calculateDepartmentPerformance(
  workspaceStats: WorkspaceStats[],
  tasks: Task[]
): DepartmentPerformance[] {
  return workspaceStats.map((workspace) => {
    const workspaceTasks = tasks.filter((t) => t.workspace_id === workspace.id);
    
    // Count tasks by status
    const inProgress = workspaceTasks.filter(
      (t) => t.status === 'in_progress' || t.status === 'assigned'
    ).length;
    const done = workspaceTasks.filter((t) => t.status === 'done').length;
    const backlog = workspaceTasks.filter(
      (t) => t.status === 'backlog' || t.status === 'inbox' || t.status === 'planning'
    ).length;
    const blocked = workspaceTasks.filter((t) => t.status === 'blocked').length;
    const total = workspaceTasks.length;
    
    // Calculate completion percentage
    const progress = total > 0 ? Math.round((done / total) * 100) : 0;
    
    // Determine status based on task states
    let status: DepartmentPerformance['status'] = 'idle';
    if (blocked > 0) {
      status = 'blocked';
    } else if (inProgress > 0 || workspace.agentCount > 0) {
      status = 'active';
    }
    
    // Find most recent task activity
    const latestTask = workspaceTasks.sort(
      (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
    )[0];
    const lastActivity = latestTask?.updated_at || workspaceTasks[0]?.created_at || new Date().toISOString();
    
    // Get blockers from blocked tasks
    const blockers = workspaceTasks
      .filter((t) => t.status === 'blocked' && t.block_reason)
      .map((t) => t.block_reason!)
      .slice(0, 3);
    
    return {
      id: workspace.id,
      name: workspace.name,
      icon: workspace.icon || '📁',
      status,
      progress,
      stats: {
        inProgress,
        done,
        backlog,
      },
      agentCount: workspace.agentCount,
      lastActivity,
      blockers: blockers.length > 0 ? blockers : undefined,
    };
  });
}

export function DepartmentPerformanceSection({ className }: DepartmentPerformanceSectionProps) {
  const [activeFilter, setActiveFilter] = useState<FilterTab>('all');
  const [departments, setDepartments] = useState<DepartmentPerformance[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch real data from API
  useEffect(() => {
    async function loadData() {
      try {
        setIsLoading(true);
        setError(null);
        
        // Fetch workspaces with stats and all tasks in parallel
        const [workspacesRes, tasksRes] = await Promise.all([
          fetch('/api/workspaces?stats=true'),
          fetch('/api/tasks'),
        ]);
        
        if (!workspacesRes.ok) {
          throw new Error('Failed to fetch workspaces');
        }
        if (!tasksRes.ok) {
          throw new Error('Failed to fetch tasks');
        }
        
        const workspaces: WorkspaceStats[] = await workspacesRes.json();
        const tasks: Task[] = await tasksRes.json();
        
        // Filter out excluded workspaces (e.g., legacy 'default')
        const filteredWorkspaces = workspaces.filter(
          (w) => !EXCLUDED_WORKSPACE_IDS.includes(w.id)
        );
        
        // Calculate department performance from real data
        const performanceData = calculateDepartmentPerformance(filteredWorkspaces, tasks);
        setDepartments(performanceData);
      } catch (err) {
        console.error('Failed to load department data:', err);
        setError(err instanceof Error ? err.message : 'Failed to load data');
      } finally {
        setIsLoading(false);
      }
    }

    loadData();
    
    // Refresh data every 60 seconds
    const interval = setInterval(loadData, 60000);
    return () => clearInterval(interval);
  }, []);

  // Calculate filter counts
  const filterCounts = useMemo(() => {
    return {
      all: departments.length,
      active: departments.filter((d) => d.status === 'active').length,
      blocked: departments.filter((d) => d.status === 'blocked').length,
      idle: departments.filter((d) => d.status === 'idle').length,
    };
  }, [departments]);

  // Calculate overall metrics
  const metrics = useMemo(() => {
    if (departments.length === 0) return null;

    const avgProgress = Math.round(
      departments.reduce((sum, d) => sum + d.progress, 0) / departments.length
    );
    const totalAgents = departments.reduce((sum, d) => sum + d.agentCount, 0);
    const activeDepts = departments.filter((d) => d.status === 'active').length;
    const blockedDepts = departments.filter((d) => d.status === 'blocked').length;

    return { avgProgress, totalAgents, activeDepts, blockedDepts };
  }, [departments]);

  return (
    <motion.section
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className={`rounded-3xl border border-gray-200 bg-white p-6 shadow-sm sm:p-8 ${className || ''}`}
    >
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6 mb-8">
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-600">
            <Building2 className="h-6 w-6" />
          </div>
          <div>
            <h2 className="text-2xl font-bold text-gray-900">
              Department Performance
            </h2>
            <p className="mt-1 text-sm text-gray-500">
              Real-time visibility into all departments
            </p>
          </div>
        </div>

        {/* Metrics Summary */}
        {metrics && (
          <div className="flex items-center gap-4 lg:gap-6">
            <MetricItem
              label="Avg Completion"
              value={`${metrics.avgProgress}%`}
              icon={<TrendingUp className="h-4 w-4 text-emerald-600" />}
              trend={metrics.avgProgress >= 80 ? 'positive' : 'neutral'}
            />
            <div className="h-8 w-px bg-gray-200" />
            <MetricItem
              label="Active Depts"
              value={metrics.activeDepts.toString()}
              subValue={`/ ${departments.length}`}
              color="indigo"
            />
            <div className="h-8 w-px bg-gray-200" />
            <MetricItem
              label="Total Agents"
              value={metrics.totalAgents.toString()}
              color="emerald"
            />
            {metrics.blockedDepts > 0 && (
              <>
                <div className="h-8 w-px bg-gray-200" />
                <MetricItem
                  label="Blocked"
                  value={metrics.blockedDepts.toString()}
                  color="red"
                />
              </>
            )}
          </div>
        )}
      </div>

      {/* Filter Tabs */}
      <div className="mb-6">
        <FilterTabs
          activeFilter={activeFilter}
          onFilterChange={setActiveFilter}
          counts={filterCounts}
        />
      </div>

      {/* Department Grid */}
      <DepartmentGrid
        departments={departments}
        filter={activeFilter}
        isLoading={isLoading}
      />
    </motion.section>
  );
}

interface MetricItemProps {
  label: string;
  value: string;
  subValue?: string;
  icon?: React.ReactNode;
  trend?: 'positive' | 'negative' | 'neutral';
  color?: 'indigo' | 'emerald' | 'red';
}

function MetricItem({ label, value, subValue, icon, trend, color }: MetricItemProps) {
  const colorClasses = {
    indigo: 'text-indigo-600',
    emerald: 'text-emerald-600',
    red: 'text-red-600',
  };

  return (
    <div className="flex flex-col">
      <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">
        {label}
      </span>
      <div className="flex items-center gap-1.5 mt-1">
        {icon && <span className="flex-shrink-0">{icon}</span>}
        <span className={`text-lg font-bold ${color ? colorClasses[color] : 'text-gray-900'}`}>
          {value}
        </span>
        {subValue && (
          <span className="text-sm text-gray-400 font-medium">{subValue}</span>
        )}
      </div>
    </div>
  );
}

export { FilterTabs, DepartmentGrid };
export type { DepartmentPerformance };
