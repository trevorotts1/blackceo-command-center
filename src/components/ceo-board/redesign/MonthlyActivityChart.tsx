'use client';

import { useEffect, useState, useMemo } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import type { Agent } from '@/lib/types';

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface MonthData {
  month: string;
  tasks: number;
  agents: number;
}

interface TaskWithDate {
  id: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export function MonthlyActivityChart() {
  const [tasks, setTasks] = useState<TaskWithDate[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        setLoading(true);
        const [tasksRes, agentsRes] = await Promise.all([
          fetch('/api/tasks?limit=10000'), // Get all tasks for historical data
          fetch('/api/agents'),
        ]);
        if (tasksRes.ok) {
          const data: TaskWithDate[] = await tasksRes.json();
          setTasks(data);
        }
        if (agentsRes.ok) setAgents(await agentsRes.json());
      } catch (err) {
        console.error('Failed to load monthly activity data:', err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const chartData: MonthData[] = useMemo(() => {
    const currentYear = new Date().getFullYear();
    const currentMonth = new Date().getMonth();

    // Initialize all months with zero
    const monthlyData: MonthData[] = MONTH_LABELS.map((label) => ({
      month: label,
      tasks: 0,
      agents: 0,
    }));

    // Count tasks by month based on actual created_at timestamps
    tasks.forEach((task) => {
      try {
        const taskDate = new Date(task.created_at);
        // Only count tasks from current year
        if (taskDate.getFullYear() === currentYear) {
          const monthIndex = taskDate.getMonth();
          if (monthIndex >= 0 && monthIndex <= currentMonth) {
            monthlyData[monthIndex].tasks += 1;
          }
        }
      } catch {
        // Skip invalid dates
      }
    });

    // Count agents created by month
    agents.forEach((agent) => {
      try {
        const agentDate = new Date(agent.created_at || new Date());
        // Only count agents from current year
        if (agentDate.getFullYear() === currentYear) {
          const monthIndex = agentDate.getMonth();
          if (monthIndex >= 0 && monthIndex <= currentMonth) {
            monthlyData[monthIndex].agents += 1;
          }
        }
      } catch {
        // Skip invalid dates
      }
    });

    // For agents, show cumulative count up to each month (not just new agents)
    let cumulativeAgents = 0;
    for (let i = 0; i <= currentMonth; i++) {
      cumulativeAgents += monthlyData[i].agents;
      monthlyData[i].agents = cumulativeAgents;
    }

    // Future months show 0
    for (let i = currentMonth + 1; i < 12; i++) {
      monthlyData[i].tasks = 0;
      monthlyData[i].agents = 0;
    }

    return monthlyData;
  }, [tasks, agents]);

  if (loading) {
    return (
      <div className="h-[280px] rounded-2xl bg-gray-200 animate-pulse" />
    );
  }

  const hasData = chartData.some((d) => d.tasks > 0 || d.agents > 0);

  return (
    <div
      className="rounded-2xl shadow-sm border-0 p-6"
      style={{
        backgroundColor: 'rgba(255,255,255,0.88)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="text-xl font-bold text-gray-900">Monthly Activity</h3>
          <p className="text-sm text-gray-500 mt-0.5">Tasks created and active agents by month</p>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-[#2D5A27]" />
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Tasks</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-[#D4A843]" />
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Agents</span>
          </div>
        </div>
      </div>

      {/* Chart */}
      {hasData ? (
        <div style={{ height: 240 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} barGap={2} barCategoryGap="20%">
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
              <XAxis
                dataKey="month"
                tick={{ fontSize: 11, fontWeight: 600, fill: '#9CA3AF' }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tick={{ fontSize: 11, fill: '#9CA3AF' }}
                axisLine={false}
                tickLine={false}
                width={30}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#1A1A1A',
                  border: 'none',
                  borderRadius: 12,
                  color: '#fff',
                  fontSize: 12,
                  padding: '8px 12px',
                  boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
                }}
                labelStyle={{ color: '#fff', fontWeight: 700 }}
                itemStyle={{ color: '#ccc' }}
                formatter={(value, name) => [
                  Array.isArray(value) ? value.join(', ') : (value ?? 0),
                  String(name) === 'tasks' ? 'Tasks' : 'Agents',
                ]}
              />
              <Bar
                dataKey="tasks"
                fill="#2D5A27"
                radius={[6, 6, 0, 0]}
                maxBarSize={28}
              />
              <Bar
                dataKey="agents"
                fill="#D4A843"
                radius={[6, 6, 0, 0]}
                maxBarSize={28}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="flex items-center justify-center h-[240px] text-gray-400">
          <div className="text-center">
            <p className="text-3xl font-black text-gray-300 mb-2">--</p>
            <p className="text-sm">No activity data yet</p>
          </div>
        </div>
      )}
    </div>
  );
}
