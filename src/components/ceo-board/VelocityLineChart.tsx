'use client';

import { motion } from 'framer-motion';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Area,
  ReferenceLine,
} from 'recharts';
import { TrendingUp, Info } from 'lucide-react';

interface VelocityDataPoint {
  week: string;
  created: number;
  completed: number;
}

interface VelocityLineChartProps {
  data: VelocityDataPoint[];
}

const CustomTooltip = ({ active, payload, label }: {
  active?: boolean;
  payload?: Array<{ dataKey: string; value: number; color: string }>;
  label?: string;
}) => {
  if (active && payload && payload.length) {
    const created = payload.find(p => p.dataKey === 'created')?.value || 0;
    const completed = payload.find(p => p.dataKey === 'completed')?.value || 0;
    const diff = created - completed;
    
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="bg-[#1A1D26] text-white p-4 rounded-lg shadow-xl border border-[#374151]"
      >
        <p className="font-semibold text-sm mb-2">{label}</p>
        
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-[#6366F1]" />
              <span className="text-xs text-[#9CA3AF]">Created</span>
            </div>
            <span className="font-semibold">{created}</span>
          </div>
          
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-[#10B981]" />
              <span className="text-xs text-[#9CA3AF]">Completed</span>
            </div>
            <span className="font-semibold">{completed}</span>
          </div>
          
          <div className="pt-2 mt-2 border-t border-[#374151]">
            <div className="flex items-center justify-between gap-4">
              <span className="text-xs text-[#9CA3AF]">Net Flow</span>
              <span className={`font-semibold ${diff >= 0 ? 'text-[#F59E0B]' : 'text-[#10B981]'}`}>
                {diff >= 0 ? `+${diff}` : diff}
              </span>
            </div>
          </div>
        </div>
      </motion.div>
    );
  }
  return null;
};

export function VelocityLineChart({ data }: VelocityLineChartProps) {
  const totalCreated = data.reduce((acc, d) => acc + d.created, 0);
  const totalCompleted = data.reduce((acc, d) => acc + d.completed, 0);
  const completionRate = Math.round((totalCompleted / totalCreated) * 100);
  
  // Calculate trend (comparing last 4 weeks to first 4 weeks)
  const firstHalf = data.slice(0, 4).reduce((acc, d) => acc + d.completed, 0) / 4;
  const secondHalf = data.slice(4).reduce((acc, d) => acc + d.completed, 0) / 4;
  const trend = secondHalf - firstHalf;
  const trendPercent = Math.round((trend / firstHalf) * 100);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <TrendingUp className="w-5 h-5 text-[#6366F1]" />
          <h3 className="text-lg font-semibold text-[#1A1D26]">
            Weekly Velocity
          </h3>
          <div className="group relative">
            <Info className="w-4 h-4 text-[#9CA3AF] cursor-help" />
            <div className="absolute left-full ml-2 top-1/2 -translate-y-1/2 w-56 p-3 bg-[#1A1D26] text-white text-xs rounded-lg shadow-xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-10">
              Tasks created vs completed over the last 8 weeks. Positive trend indicates accelerating delivery.
            </div>
          </div>
        </div>
        
        {/* Trend Badge */}
        <motion.div
          className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium ${
            trend >= 0
              ? 'bg-[#D1FAE5] text-[#059669]'
              : 'bg-[#FEE2E2] text-[#DC2626]'
          }`}
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.5, duration: 0.3 }}
        >
          {trend >= 0 ? (
            <TrendingUp className="w-3 h-3" />
          ) : (
            <TrendingUp className="w-3 h-3 rotate-180" />
          )}
          <span>{trend >= 0 ? '+' : ''}{trendPercent}%</span>
        </motion.div>
      </div>

      {/* Chart */}
      <div className="h-[260px]">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={data}
            margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
          >
            <defs>
              {/* Gradient for Created line */}
              <linearGradient id="createdGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#6366F1" stopOpacity={0.3} />
                <stop offset="100%" stopColor="#6366F1" stopOpacity={0.05} />
              </linearGradient>
              
              {/* Gradient for Completed line */}
              <linearGradient id="completedGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#10B981" stopOpacity={0.3} />
                <stop offset="100%" stopColor="#10B981" stopOpacity={0.05} />
              </linearGradient>
            </defs>
            
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="#F3F4F6"
              vertical={false}
            />
            
            <XAxis
              dataKey="week"
              axisLine={false}
              tickLine={false}
              tick={{ fill: '#6B7280', fontSize: 10 }}
              tickMargin={8}
            />
            
            <YAxis
              axisLine={false}
              tickLine={false}
              tick={{ fill: '#6B7280', fontSize: 11 }}
              tickMargin={8}
            />
            
            <Tooltip content={<CustomTooltip />} />
            
            {/* Average line */}
            <ReferenceLine
              y={totalCompleted / data.length}
              stroke="#9CA3AF"
              strokeDasharray="4 4"
              strokeWidth={1}
              label={{
                value: 'Avg',
                fill: '#9CA3AF',
                fontSize: 10,
                position: 'right',
              }}
            />
            
            {/* Area under Created line */}
            <Area
              type="monotone"
              dataKey="created"
              stroke="none"
              fill="url(#createdGradient)"
            />
            
            {/* Area under Completed line */}
            <Area
              type="monotone"
              dataKey="completed"
              stroke="none"
              fill="url(#completedGradient)"
            />
            
            {/* Created line */}
            <Line
              type="monotone"
              dataKey="created"
              stroke="#6366F1"
              strokeWidth={3}
              dot={{ fill: '#6366F1', strokeWidth: 2, stroke: '#fff', r: 5 }}
              activeDot={{ r: 7, strokeWidth: 3, stroke: '#fff' }}
              animationDuration={1500}
              animationBegin={200}
              animationEasing="ease-in-out"
            />
            
            {/* Completed line */}
            <Line
              type="monotone"
              dataKey="completed"
              stroke="#10B981"
              strokeWidth={3}
              dot={{ fill: '#10B981', strokeWidth: 2, stroke: '#fff', r: 5 }}
              activeDot={{ r: 7, strokeWidth: 3, stroke: '#fff' }}
              animationDuration={1500}
              animationBegin={400}
              animationEasing="ease-in-out"
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Legend */}
      <div className="flex items-center justify-center gap-6">
        <div className="flex items-center gap-2">
          <div className="w-4 h-1 rounded-full bg-[#6366F1]" />
          <span className="text-sm text-[#6B7280]">Created</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-1 rounded-full bg-[#10B981]" />
          <span className="text-sm text-[#6B7280]">Completed</span>
        </div>
      </div>

      {/* Stats Footer */}
      <motion.div
        className="grid grid-cols-3 gap-4 pt-4 border-t border-[#F3F4F6]"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 1.2, duration: 0.4 }}
      >
        <div className="text-center">
          <p className="text-xl font-bold text-[#6366F1]">{totalCreated}</p>
          <p className="text-xs text-[#9CA3AF]">Total Created</p>
        </div>
        <div className="text-center border-x border-[#F3F4F6]">
          <p className="text-xl font-bold text-[#10B981]">{totalCompleted}</p>
          <p className="text-xs text-[#9CA3AF]">Total Completed</p>
        </div>
        <div className="text-center">
          <p className="text-xl font-bold text-[#1A1D26]">{completionRate}%</p>
          <p className="text-xs text-[#9CA3AF]">Completion Rate</p>
        </div>
      </motion.div>
    </div>
  );
}
