'use client';

import { useState, useEffect, useCallback } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

interface SSELogEntry {
  timestamp: Date;
  type: string;
  data: unknown;
}

function formatLogData(data: unknown): string {
  if (data === null || data === undefined) return '';
  if (typeof data === 'object') {
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  }
  return String(data);
}

export function SSEDebugPanel() {
  const [logs, setLogs] = useState<SSELogEntry[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isEnabled, setIsEnabled] = useState(false);

  const addLog = useCallback((type: string, data: unknown) => {
    setLogs(prev => [{
      timestamp: new Date(),
      type,
      data
    }, ...prev].slice(0, 50)); // Keep last 50
  }, []);

  useEffect(() => {
    // Check if debug mode is enabled
    const debugEnabled = localStorage.getItem('MC_DEBUG') === 'true';
    setIsEnabled(debugEnabled);

    if (!debugEnabled) return;

    // Intercept console.log for SSE events
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      originalLog.apply(console, args);

      // Capture SSE and STORE logs
      if (typeof args[0] === 'string') {
        const msg = args[0] as string;
        if (msg.includes('[SSE]') || msg.includes('[STORE]') || msg.includes('[API]')) {
          const type = msg.replace(/^\[([^\]]+)\].*$/, '$1');
          const message = msg.replace(/^\[[^\]]+\]\s*/, '');
          addLog(`${type}: ${message}`, args[1]);
        }
      }
    };

    return () => {
      console.log = originalLog;
    };
  }, [addLog]);

  // Re-check debug mode on storage changes
  useEffect(() => {
    const handleStorage = () => {
      const debugEnabled = localStorage.getItem('MC_DEBUG') === 'true';
      setIsEnabled(debugEnabled);
    };

    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  if (!isEnabled) return null;

  return (
    <div className="fixed bottom-4 left-4 z-50">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-3 py-2 bg-white border border-gray-200 rounded-lg shadow-lg text-sm"
      >
        {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        <span className="text-indigo-600 font-medium">Debug</span>
        <span className="bg-indigo-600 text-white px-2 py-0.5 rounded text-xs">
          {logs.length}
        </span>
      </button>

      {isOpen && (
        <div className="absolute bottom-12 left-0 w-96 max-h-80 bg-white border border-gray-200 rounded-lg shadow-xl overflow-hidden">
          <div className="p-2 border-b border-gray-200 flex justify-between items-center">
            <span className="text-sm font-medium text-gray-900">Debug Events</span>
            <button
              onClick={() => setLogs([])}
              className="text-xs text-gray-500 hover:text-gray-700"
            >
              Clear
            </button>
          </div>
          <div className="overflow-y-auto max-h-64 p-2 space-y-1 font-mono text-xs">
            {logs.length === 0 ? (
              <div className="text-gray-500 text-center py-4">
                Waiting for events...
              </div>
            ) : (
              logs.map((log, i) => (
                <div key={i} className="p-2 bg-gray-50 rounded border border-gray-200">
                  <div className="flex justify-between text-gray-500">
                    <span className="text-indigo-600">{log.type}</span>
                    <span>{log.timestamp.toLocaleTimeString()}</span>
                  </div>
                  {log.data !== null && log.data !== undefined && (
                    <pre className="mt-1 text-gray-700 overflow-x-auto whitespace-pre-wrap">
                      {formatLogData(log.data)}
                    </pre>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
