'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
} from 'recharts';
import { Users, Info } from 'lucide-react';

interface UtilizationData {
  name: string;
  value: number;
  color: string;
}

interface UtilizationPieChartProps {
  data: UtilizationData[];
}

const CustomTooltip = ({ active, payload }: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; payload: UtilizationData }>;
}) => {
  if (active && payload && payload.length) {
    const data = payload[0].payload;
    const total = 220; // Approximate total for demo
    const percentage = Math.round((data.value / total) * 100);
    
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="bg-[#1A1D26] text-white p-3 rounded-lg shadow-xl border border-[#374151]"
      >
        <div className="flex items-center gap-2 mb-1">
          <div
            className="w-3 h-3 rounded-full"
            style={{ backgroundColor: data.color }}
          />
          <p className="font-semibold text-sm">{data.name}</p>
        </div>
        <p className="text-2xl font-bold" style={{ color: data.color }}>
          {data.value}
        </p>
        <p className="text-xs text-[#9CA3AF] mt-1">
          {percentage}% of workforce
        </p>
      </motion.div>
    );
  }
  return null;
};

export function UtilizationPieChart({ data }: UtilizationPieChartProps) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [hoveredSlice, setHoveredSlice] = useState<string | null>(null);

  const total = data.reduce((acc, item) => acc + item.value, 0);

  const handleMouseEnter = (_: unknown, index: number) => {
    setActiveIndex(index);
    setHoveredSlice(data[index]?.name || null);
  };

  const handleMouseLeave = () => {
    setActiveIndex(null);
    setHoveredSlice(null);
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Users className="w-5 h-5 text-[#6366F1]" />
          <h3 className="text-lg font-semibold text-[#1A1D26]">
            Workforce Utilization
          </h3>
          <div className="group relative">
            <Info className="w-4 h-4 text-[#9CA3AF] cursor-help" />
            <div className="absolute left-full ml-2 top-1/2 -translate-y-1/2 w-56 p-3 bg-[#1A1D26] text-white text-xs rounded-lg shadow-xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-10">
              Distribution of agent status across all departments. Click segments for details.
            </div>
          </div>
        </div>
        <div className="text-right">
          <p className="text-2xl font-bold text-[#1A1D26]">{total}</p>
          <p className="text-xs text-[#9CA3AF]">Total Agents</p>
        </div>
      </div>

      {/* Chart Container */}
      <div className="relative h-[280px]">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              innerRadius={70}
              outerRadius={110}
              paddingAngle={3}
              dataKey="value"
              animationDuration={1200}
              animationBegin={400}
              animationEasing="ease-out"
              onMouseEnter={handleMouseEnter}
              onMouseLeave={handleMouseLeave}
            >
              {data.map((entry, index) => (
                <Cell
                  key={`cell-${index}`}
                  fill={entry.color}
                  stroke={activeIndex === index ? '#fff' : 'none'}
                  strokeWidth={activeIndex === index ? 3 : 0}
                  style={{
                    filter: activeIndex === index
                      ? 'drop-shadow(0 4px 8px rgba(0,0,0,0.2))'
                      : 'none',
                    transform: activeIndex === index ? 'scale(1.05)' : 'scale(1)',
                    transformOrigin: 'center',
                    transition: 'all 0.2s ease-out',
                    cursor: 'pointer',
                  }}
                />
              ))}
            </Pie>
            <Tooltip content={<CustomTooltip />} />
          </PieChart>
        </ResponsiveContainer>

        {/* Center Label */}
        <motion.div
          className="absolute inset-0 flex items-center justify-center pointer-events-none"
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.8, duration: 0.4 }}
        >
          <div className="text-center">
            <p className="text-3xl font-bold text-[#1A1D26]">
              {hoveredSlice
                ? `${Math.round((data.find(d => d.name === hoveredSlice)?.value || 0) / total * 100)}%`
                : `${Math.round((data[0]?.value || 0) / total * 100)}%`}
            </p>
            <p className="text-xs text-[#9CA3AF] uppercase tracking-wide">
              {hoveredSlice || data[0]?.name}
            </p>
          </div>
        </motion.div>
      </div>

      {/* Legend */}
      <motion.div
        className="grid grid-cols-2 gap-3"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 1, duration: 0.4 }}
      >
        {data.map((item, index) => (
          <motion.div
            key={item.name}
            className={`flex items-center gap-2 p-2 rounded-lg transition-all cursor-pointer ${
              hoveredSlice === item.name
                ? 'bg-[#F3F4F6]'
                : 'hover:bg-[#F9FAFB]'
            }`}
            onMouseEnter={() => setHoveredSlice(item.name)}
            onMouseLeave={() => setHoveredSlice(null)}
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 1 + index * 0.1, duration: 0.3 }}
          >
            <motion.div
              className="w-4 h-4 rounded-full flex-shrink-0"
              style={{ backgroundColor: item.color }}
              animate={{
                scale: hoveredSlice === item.name ? 1.2 : 1,
              }}
              transition={{ duration: 0.2 }}
            />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-[#1A1D26] truncate">
                {item.name}
              </p>
              <p className="text-xs text-[#9CA3AF]">
                {item.value} agents ({Math.round((item.value / total) * 100)}%)
              </p>
            </div>
          </motion.div>
        ))}
      </motion.div>

      {/* Summary Stats */}
      <div className="pt-4 border-t border-[#F3F4F6]">
        <div className="flex items-center justify-between text-sm">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-[#10B981]" />
            <span className="text-[#6B7280]">
              <span className="font-medium text-[#1A1D26]">{(data[0]?.value || 0) + (data[1]?.value || 0)}</span>
              {' '}productive
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-[#DC2626]" />
            <span className="text-[#6B7280]">
              <span className="font-medium text-[#1A1D26]">{data[2]?.value || 0}</span>
              {' '}need attention
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
