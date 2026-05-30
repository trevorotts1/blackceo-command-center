'use client';

import { useMemo } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import { EmptyState } from './EmptyState';
import type { ConvAiMetrics } from './types';

export function SentimentTrend({
  metric,
}: {
  metric?: ConvAiMetrics['sentimentTrend'];
}) {
  const rows = useMemo(() => metric?.data ?? [], [metric]);

  if (!metric?.available) {
    return (
      <EmptyState
        title="Sentiment trend not connected yet"
        hint="Per-day average sentiment appears once conversations carry a sentiment score."
      />
    );
  }
  if (rows.length === 0) {
    return <EmptyState title="No scored conversations in the last 30 days" />;
  }

  return (
    <div style={{ height: 240 }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ left: 0, right: 8, top: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
          <XAxis
            dataKey="day"
            tick={{ fontSize: 11, fill: '#9CA3AF' }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(d: string) => d.slice(5)}
            minTickGap={24}
          />
          <YAxis
            domain={[-1, 1]}
            ticks={[-1, 0, 1]}
            tick={{ fontSize: 11, fill: '#9CA3AF' }}
            axisLine={false}
            tickLine={false}
            width={28}
            tickFormatter={(v: number) => (v > 0 ? '+' : '') + v}
          />
          <ReferenceLine y={0} stroke="#D1D5DB" strokeDasharray="4 4" />
          <Tooltip
            contentStyle={{
              backgroundColor: '#1A1A1A', border: 'none', borderRadius: 12,
              color: '#fff', fontSize: 13, padding: '8px 12px',
            }}
            formatter={(value) => [Number(value).toFixed(2), 'Avg sentiment']}
          />
          <Line type="monotone" dataKey="avg" stroke="#7C3AED" strokeWidth={2.5} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
