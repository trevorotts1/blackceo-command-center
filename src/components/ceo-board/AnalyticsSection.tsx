'use client';

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { CompletionBarChart } from './CompletionBarChart';
import { UtilizationPieChart } from './UtilizationPieChart';
import { VelocityLineChart } from './VelocityLineChart';
import type { WorkspaceStats, Task } from '@/lib/types';

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.15,
      delayChildren: 0.1,
    },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.5,
      ease: [0.25, 0.1, 0.25, 1] as [number, number, number, number],
    },
  },
};

export interface AnalyticsData {
  completionData: Array<{
    department: string;
    completionRate: number;
    taskCount: number;
  }>;
  utilizationData: Array<{
    name: string;
    value: number;
    color: string;
  }>;
  velocityData: Array<{
    week: string;
    created: number;
    completed: number;
  }>;
}

interface AnalyticsSectionProps {
  data?: AnalyticsData;
}

// Generate velocity data from actual task creation dates
function generateVelocityData(tasks: Task[]): AnalyticsData['velocityData'] {
  const now = new Date();
  const weeks: AnalyticsData['velocityData'] = [];
  
  // Generate last 8 weeks
  for (let i = 7; i >= 0; i--) {
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - (i * 7));
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 7);
    
    const created = tasks.filter(t => {
      const createdDate = new Date(t.created_at);
      return createdDate >= weekStart && createdDate < weekEnd;
    }).length;
    
    const completed = tasks.filter(t => {
      if (t.status !== 'done') return false;
      const updatedDate = new Date(t.updated_at);
      return updatedDate >= weekStart && updatedDate < weekEnd;
    }).length;
    
    const weekLabel = i === 0 ? 'This Week' : i === 1 ? 'Last Week' : `Week ${8 - i}`;
    weeks.push({ week: weekLabel, created, completed });
  }
  
  return weeks;
}

// Calculate completion data from workspaces and tasks
function calculateCompletionData(workspaces: WorkspaceStats[], tasks: Task[]): AnalyticsData['completionData'] {
  return workspaces.map(workspace => {
    const workspaceTasks = tasks.filter(t => t.workspace_id === workspace.id);
    const total = workspaceTasks.length;
    const completed = workspaceTasks.filter(t => t.status === 'done').length;
    const completionRate = total > 0 ? Math.round((completed / total) * 100) : 0;
    
    return {
      department: workspace.name,
      completionRate,
      taskCount: total,
    };
  }).sort((a, b) => b.completionRate - a.completionRate); // Sort by completion rate descending
}

// Calculate utilization from tasks
function calculateUtilization(tasks: Task[]): AnalyticsData['utilizationData'] {
  const active = tasks.filter(t => t.status === 'in_progress' || t.status === 'assigned').length;
  const blocked = tasks.filter(t => t.status === 'blocked').length;
  const backlog = tasks.filter(t => t.status === 'backlog' || t.status === 'inbox' || t.status === 'planning').length;
  const review = tasks.filter(t => t.status === 'review').length;
  
  return [
    { name: 'In Progress', value: active, color: '#10B981' },
    { name: 'Review', value: review, color: '#3B82F6' },
    { name: 'Backlog', value: backlog, color: '#9CA3AF' },
    { name: 'Blocked', value: blocked, color: '#DC2626' },
  ].filter(item => item.value > 0);
}

const defaultData: AnalyticsData = {
  completionData: [],
  utilizationData: [
    { name: 'In Progress', value: 0, color: '#10B981' },
    { name: 'Review', value: 0, color: '#3B82F6' },
    { name: 'Backlog', value: 0, color: '#9CA3AF' },
    { name: 'Blocked', value: 0, color: '#DC2626' },
  ],
  velocityData: [
    { week: 'Week 1', created: 0, completed: 0 },
    { week: 'Week 2', created: 0, completed: 0 },
    { week: 'Week 3', created: 0, completed: 0 },
    { week: 'Week 4', created: 0, completed: 0 },
    { week: 'Week 5', created: 0, completed: 0 },
    { week: 'Week 6', created: 0, completed: 0 },
    { week: 'Week 7', created: 0, completed: 0 },
    { week: 'Week 8', created: 0, completed: 0 },
  ],
};

export function AnalyticsSection({ data: propData }: AnalyticsSectionProps) {
  const [data, setData] = useState<AnalyticsData>(propData ?? defaultData);
  const [isLoading, setIsLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState('Just now');

  // Fetch real data from API
  useEffect(() => {
    async function loadData() {
      try {
        setIsLoading(true);
        
        // Fetch workspaces with stats and all tasks in parallel
        const [workspacesRes, tasksRes] = await Promise.all([
          fetch('/api/workspaces?stats=true'),
          fetch('/api/tasks'),
        ]);
        
        if (!workspacesRes.ok || !tasksRes.ok) {
          throw new Error('Failed to fetch analytics data');
        }
        
        const workspaces: WorkspaceStats[] = await workspacesRes.json();
        const tasks: Task[] = await tasksRes.json();
        
        // Calculate analytics from real data
        setData({
          completionData: calculateCompletionData(workspaces, tasks),
          utilizationData: calculateUtilization(tasks),
          velocityData: generateVelocityData(tasks),
        });
        
        setLastUpdated(new Date().toLocaleTimeString('en-US', { 
          hour: 'numeric', 
          minute: '2-digit' 
        }));
      } catch (err) {
        console.error('Failed to load analytics data:', err);
      } finally {
        setIsLoading(false);
      }
    }

    // Only fetch if no data prop was provided
    if (!propData) {
      loadData();
      
      // Refresh data every 60 seconds
      const interval = setInterval(loadData, 60000);
      return () => clearInterval(interval);
    } else {
      setIsLoading(false);
    }
  }, [propData]);

  return (
    <motion.section
      className="space-y-6"
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      {/* Section Header */}
      <motion.div variants={itemVariants} className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-[#1A1D26]">Performance Analytics</h2>
          <p className="text-sm text-[#6B7280] mt-1">
            Real-time insights across all departments
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-[#9CA3AF]">
            {isLoading ? 'Updating...' : `Last updated: ${lastUpdated}`}
          </span>
          <div className={`w-2 h-2 rounded-full ${isLoading ? 'bg-amber-400' : 'bg-[#10B981]'} animate-pulse`} />
        </div>
      </motion.div>

      {/* Charts Grid */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Completion Bar Chart - Full width on mobile, spans 2 cols on xl */}
        <motion.div
          variants={itemVariants}
          className="xl:col-span-2 bg-white rounded-xl p-6 shadow-sm border border-[#E5E7EB]"
        >
          <CompletionBarChart data={data.completionData} />
        </motion.div>

        {/* Utilization Pie Chart */}
        <motion.div
          variants={itemVariants}
          className="bg-white rounded-xl p-6 shadow-sm border border-[#E5E7EB]"
        >
          <UtilizationPieChart data={data.utilizationData} />
        </motion.div>

        {/* Velocity Line Chart */}
        <motion.div
          variants={itemVariants}
          className="bg-white rounded-xl p-6 shadow-sm border border-[#E5E7EB]"
        >
          <VelocityLineChart data={data.velocityData} />
        </motion.div>
      </div>
    </motion.section>
  );
}
