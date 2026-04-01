'use client';

import { useEffect, useState, useRef } from 'react';
import { Terminal } from 'lucide-react';

interface LogEntry {
  status: number;
  method: string;
  path: string;
  timestamp?: string;
}

const DEFAULT_LOGS: LogEntry[] = [
  { status: 200, method: 'GET', path: '/api/v1/health' },
  { status: 200, method: 'POST', path: '/deploy/auth-service' },
  { status: 304, method: 'GET', path: '/assets/main.css' },
  { status: 200, method: 'HEAD', path: '/' },
  { status: 200, method: 'GET', path: '/api/v1/metrics' },
  { status: 500, method: 'POST', path: '/api/v1/webhook' },
  { status: 200, method: 'GET', path: '/api/v1/users' },
  { status: 201, method: 'POST', path: '/api/v1/deploy' },
];

function getStatusColor(status: number): string {
  if (status >= 200 && status < 300) return 'text-emerald-500';
  if (status >= 300 && status < 400) return 'text-amber-500';
  if (status >= 400 && status < 500) return 'text-orange-500';
  return 'text-rose-500';
}

export default function LiveLogsSection({
  logs = DEFAULT_LOGS,
}: {
  logs?: LogEntry[];
}) {
  return (
    <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-3">
        <div className="w-1 h-6 rounded-full bg-gray-400 flex-shrink-0" />
        <h2 className="text-section text-gray-900">Live Logs</h2>
      </div>
      <div className="p-6 bg-gray-900 rounded-b-2xl">
        <div className="font-mono text-xs leading-relaxed space-y-1.5">
          {logs.map((log, idx) => (
            <div key={idx} className="flex gap-3 items-center">
              <span className={`${getStatusColor(log.status)} font-bold tabular-nums w-8`}>
                {log.status}
              </span>
              <span className="text-gray-400 font-medium w-12">{log.method}</span>
              <span className="text-gray-300 truncate">{log.path}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
