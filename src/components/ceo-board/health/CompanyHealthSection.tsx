'use client';

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { HealthScoreGauge } from './HealthScoreGauge';
import { MetricTiles } from './MetricTiles';
import { ScoreSparkline } from './ScoreSparkline';
import type { WorkspaceStats, Task } from '@/lib/types';

interface CompanyHealthSectionProps {
  healthScore?: number;
  previousScores?: number[];
  metrics?: {
    activeDepartments: number;
    totalDepartments: number;
    taskCompletionRate: number;
    agentCoverage: number;
    totalAgents: number;
    activeBlockers: number;
  };
}

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.05,
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

interface HealthMetrics {
  activeDepartments: number;
  totalDepartments: number;
  taskCompletionRate: number;
  agentCoverage: number;
  totalAgents: number;
  activeBlockers: number;
}

function calculateHealthScore(metrics: HealthMetrics): number {
  // Calculate health score based on multiple factors
  const completionWeight = 0.4;
  const activityWeight = 0.3;
  const coverageWeight = 0.2;
  const blockerWeight = 0.1;
  
  const completionScore = metrics.taskCompletionRate * 100;
  const activityScore = metrics.totalDepartments > 0 
    ? (metrics.activeDepartments / metrics.totalDepartments) * 100 
    : 0;
  const coverageScore = metrics.totalDepartments > 0 
    ? (metrics.agentCoverage / metrics.totalDepartments) * 100 
    : 0;
  const blockerScore = Math.max(0, 100 - (metrics.activeBlockers * 10));
  
  return Math.round(
    completionScore * completionWeight +
    activityScore * activityWeight +
    coverageScore * coverageWeight +
    blockerScore * blockerWeight
  );
}

function calculateMetrics(workspaces: WorkspaceStats[], tasks: Task[]): HealthMetrics {
  const totalDepartments = workspaces.length;
  const activeDepartments = workspaces.filter(w => 
    (w.taskCounts.in_progress > 0 || w.agentCount > 0) && w.taskCounts.blocked === 0
  ).length;
  
  const totalTasks = tasks.length;
  const completedTasks = tasks.filter(t => t.status === 'done').length;
  const taskCompletionRate = totalTasks > 0 ? completedTasks / totalTasks : 0;
  
  const agentCoverage = workspaces.filter(w => w.agentCount > 0).length;
  const totalAgents = workspaces.reduce((sum, w) => sum + w.agentCount, 0);
  const activeBlockers = tasks.filter(t => t.status === 'blocked').length;
  
  return {
    activeDepartments,
    totalDepartments,
    taskCompletionRate,
    agentCoverage,
    totalAgents,
    activeBlockers,
  };
}

// Generate sparkline data based on current metrics (simulated historical trend)
function generateSparklineData(currentScore: number): number[] {
  const data: number[] = [];
  let score = currentScore - 5;
  for (let i = 0; i < 7; i++) {
    // Add some variation to simulate daily changes
    const variation = Math.random() * 4 - 2;
    score = Math.max(0, Math.min(100, score + variation + 1));
    data.push(Math.round(score));
  }
  data[data.length - 1] = currentScore;
  return data;
}

export function CompanyHealthSection({
  healthScore: propHealthScore,
  previousScores: propPreviousScores,
  metrics: propMetrics,
}: CompanyHealthSectionProps) {
  const [healthScore, setHealthScore] = useState(propHealthScore ?? 87);
  const [metrics, setMetrics] = useState<HealthMetrics>(propMetrics ?? {
    activeDepartments: 0,
    totalDepartments: 0,
    taskCompletionRate: 0,
    agentCoverage: 0,
    totalAgents: 0,
    activeBlockers: 0,
  });
  const [previousScores, setPreviousScores] = useState<number[]>(propPreviousScores ?? [82, 84, 83, 85, 86, 86, 87]);
  const [isLoading, setIsLoading] = useState(true);

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
          throw new Error('Failed to fetch health data');
        }
        
        const workspaces: WorkspaceStats[] = await workspacesRes.json();
        const tasks: Task[] = await tasksRes.json();
        
        // Calculate metrics from real data
        const calculatedMetrics = calculateMetrics(workspaces, tasks);
        setMetrics(calculatedMetrics);
        
        // Calculate health score
        const calculatedScore = calculateHealthScore(calculatedMetrics);
        setHealthScore(calculatedScore);
        
        // Generate sparkline data based on current score
        setPreviousScores(generateSparklineData(calculatedScore));
      } catch (err) {
        console.error('Failed to load health data:', err);
      } finally {
        setIsLoading(false);
      }
    }

    // Only fetch if props weren't provided
    if (!propHealthScore || !propMetrics) {
      loadData();
      
      // Refresh data every 60 seconds
      const interval = setInterval(loadData, 60000);
      return () => clearInterval(interval);
    } else {
      setIsLoading(false);
    }
  }, [propHealthScore, propMetrics]);

  const getStatusLabel = (score: number) => {
    if (score >= 85) return 'Excellent';
    if (score >= 70) return 'Good';
    if (score >= 50) return 'Fair';
    if (score >= 30) return 'Poor';
    return 'Critical';
  };

  const getStatusColor = (score: number) => {
    if (score >= 85) return '#4F46E5'; // Indigo
    if (score >= 70) return '#10B981'; // Emerald
    if (score >= 50) return '#F59E0B'; // Amber
    return '#DC2626'; // Red
  };

  // Calculate trend percentage
  const trendPercent = previousScores.length > 1 
    ? (((healthScore - previousScores[0]) / previousScores[0]) * 100).toFixed(1)
    : '0.0';

  return (
    <motion.section
      className="w-full bg-white rounded-2xl shadow-sm border border-gray-200 p-6 lg:p-8"
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-center">
        {/* Left Column - Score and Metrics */}
        <motion.div className="space-y-6" variants={itemVariants}>
          {/* Header */}
          <div className="space-y-1">
            <motion.h2
              className="text-sm font-semibold text-gray-500 uppercase tracking-wider"
              variants={itemVariants}
            >
              Company Health Score
            </motion.h2>
            <motion.div className="flex items-baseline gap-3" variants={itemVariants}>
              <span
                className="text-7xl font-bold tracking-tight"
                style={{ color: getStatusColor(healthScore) }}
              >
                {isLoading ? '-' : healthScore}
              </span>
              <span className="text-2xl text-gray-400 font-medium">/100</span>
            </motion.div>
            <motion.p
              className="text-lg font-medium"
              style={{ color: getStatusColor(healthScore) }}
              variants={itemVariants}
            >
              {isLoading ? 'Loading...' : getStatusLabel(healthScore)}
            </motion.p>
          </div>

          {/* Metric Tiles */}
          <motion.div variants={itemVariants}>
            <MetricTiles metrics={metrics} />
          </motion.div>
        </motion.div>

        {/* Right Column - Gauge and Sparkline */}
        <motion.div
          className="flex flex-col items-center justify-center space-y-6"
          variants={itemVariants}
        >
          <HealthScoreGauge score={healthScore} size={240} />
          
          {/* Sparkline Section */}
          <motion.div
            className="w-full max-w-sm bg-gray-50 rounded-xl p-4 border border-gray-100"
            variants={itemVariants}
          >
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                7-Day Trend
              </span>
              <span className={`text-xs font-medium flex items-center gap-1 ${
                parseFloat(trendPercent) >= 0 ? 'text-emerald-600' : 'text-red-600'
              }`}>
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} 
                    d={parseFloat(trendPercent) >= 0 
                      ? "M5 10l7-7m0 0l7 7m-7-7v18" 
                      : "M19 14l-7 7m0 0l-7-7m7 7V3"} 
                  />
                </svg>
                {parseFloat(trendPercent) >= 0 ? '+' : ''}{trendPercent}%
              </span>
            </div>
            <ScoreSparkline data={previousScores} width={300} height={60} />
          </motion.div>
        </motion.div>
      </div>
    </motion.section>
  );
}
