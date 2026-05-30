'use client';

import { useMemo } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';
import { EmptyState } from './EmptyState';
import type { ConvAiMetrics } from './types';

// Distinct per-channel hues. Each bar also carries its label on the X axis,
// so color is decorative — channel identity is conveyed by text, not hue.
const CHANNEL_COLORS = [
  '#2D5A27', '#D4A843', '#2563EB', '#7C3AED',
  '#DB2777', '#0E7490', '#65A30D', '#B45309',
];

export function ChannelVolumeChart({
  metric,
}: {
  metric?: ConvAiMetrics['channelVolume'];
}) {
  const rows = useMemo(
    () => (metric?.data ?? []).filter((d) => d.count > 0),
    [metric],
  );

  if (!metric?.available) {
    return (
      <EmptyState
        title="Channel volume not connected yet"
        hint="Once your conversations log starts emitting, per-channel volume appears here."
      />
    );
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No messages logged yet"
        hint="SMS, Email, FB/IG DMs, LinkedIn, Live Chat and All-in-One volume will populate as conversations flow."
      />
    );
  }

  return (
    <div style={{ height: 280 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 16 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
          <XAxis type="number" tick={{ fontSize: 12, fill: '#6B7280' }} axisLine={false} tickLine={false} />
          <YAxis
            type="category"
            dataKey="label"
            width={92}
            tick={{ fontSize: 13, fontWeight: 600, fill: '#374151' }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            cursor={{ fill: 'rgba(0,0,0,0.04)' }}
            contentStyle={{
              backgroundColor: '#1A1A1A', border: 'none', borderRadius: 12,
              color: '#fff', fontSize: 13, padding: '8px 12px',
            }}
            formatter={(value) => [value, 'Messages']}
          />
          <Bar dataKey="count" radius={[0, 6, 6, 0]} maxBarSize={26}>
            {rows.map((_, i) => (
              <Cell key={i} fill={CHANNEL_COLORS[i % CHANNEL_COLORS.length]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
