'use client';

import { motion } from 'framer-motion';
import {
  LineChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
} from 'recharts';

interface ScoreSparklineProps {
  data: number[];
  width?: number;
  height?: number;
}

export function ScoreSparkline({ data, width = 300, height = 60 }: ScoreSparklineProps) {
  // Transform data into format Recharts expects
  const chartData = data.map((score, index) => ({
    day: `Day ${index + 1}`,
    score,
    index,
  }));

  // Calculate trend
  const firstValue = data[0];
  const lastValue = data[data.length - 1];
  const isTrendingUp = lastValue >= firstValue;
  const trendColor = isTrendingUp ? '#10B981' : '#DC2626';

  // Calculate min/max for Y-axis domain with padding
  const minScore = Math.min(...data);
  const maxScore = Math.max(...data);
  const yDomain = [
    Math.max(0, minScore - 5),
    Math.min(100, maxScore + 5),
  ];

  return (
    <motion.div
      style={{ width, height }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5, delay: 0.8 }}
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
          <defs>
            <linearGradient id="sparklineGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#6366F1" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#6366F1" stopOpacity={0} />
            </linearGradient>
          </defs>

          <XAxis dataKey="day" hide />

          <Tooltip
            content={({ active, payload }) => {
              if (active && payload && payload.length) {
                return (
                  <div className="bg-gray-900 text-white text-xs px-2 py-1 rounded shadow-lg">
                    Score: {payload[0].value}
                  </div>
                );
              }
              return null;
            }}
          />

          <Line
            type="monotone"
            dataKey="score"
            stroke="#6366F1"
            strokeWidth={2}
            dot={false}
            activeDot={{
              r: 4,
              fill: '#6366F1',
              stroke: '#fff',
              strokeWidth: 2,
            }}
            animationDuration={1500}
            animationBegin={500}
          />

          {/* Trend indicator dots at start and end */}
          <Line
            type="monotone"
            dataKey="score"
            stroke="none"
            dot={(props) => {
              const { cx, cy, index } = props;
              if (index === 0 || index === data.length - 1) {
                return (
                  <circle
                    cx={cx}
                    cy={cy}
                    r={index === data.length - 1 ? 5 : 3}
                    fill={index === data.length - 1 ? trendColor : '#9CA3AF'}
                    stroke="#fff"
                    strokeWidth={2}
                  />
                );
              }
              return null;
            }}
          />
        </LineChart>
      </ResponsiveContainer>

      {/* Current value label */}
      <motion.div
        className="flex justify-between items-center mt-1 text-xs text-gray-400"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 1.2 }}
      >
        <span>{data[0]}</span>
        <span className="font-medium" style={{ color: trendColor }}>
          {lastValue > firstValue ? '+' : ''}{lastValue - firstValue}
        </span>
        <span>{lastValue}</span>
      </motion.div>
    </motion.div>
  );
}
