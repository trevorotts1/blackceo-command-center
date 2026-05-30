'use client';

import { useMemo } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { EmptyState } from './EmptyState';
import type { ConvAiMetrics } from './types';

export function ConversationsTimeline({
  metric,
}: {
  metric?: ConvAiMetrics['conversationsTimeline'];
}) {
  const rows = useMemo(() => metric?.data ?? [], [metric]);

  if (!metric?.available) {
    return (
      <EmptyState
        title="Conversation timeline not connected yet"
        hint="Daily / weekly / monthly conversation counts populate once the conversations log emits."
      />
    );
  }

  if (rows.length === 0) {
    return <EmptyState title="No conversations in the last 30 days" />;
  }

  return (
    <div style={{ height: 240 }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={rows} margin={{ left: 0, right: 8, top: 8 }}>
          <defs>
            <linearGradient id="convGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#2563EB" stopOpacity={0.35} />
              <stop offset="100%" stopColor="#2563EB" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
          <XAxis
            dataKey="day"
            tick={{ fontSize: 11, fill: '#9CA3AF' }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(d: string) => d.slice(5)}
            minTickGap={24}
          />
          <YAxis tick={{ fontSize: 11, fill: '#9CA3AF' }} axisLine={false} tickLine={false} width={28} allowDecimals={false} />
          <Tooltip
            contentStyle={{
              backgroundColor: '#1A1A1A', border: 'none', borderRadius: 12,
              color: '#fff', fontSize: 13, padding: '8px 12px',
            }}
            formatter={(value) => [value, 'Conversations']}
          />
          <Area type="monotone" dataKey="count" stroke="#2563EB" strokeWidth={2.5} fill="url(#convGrad)" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
