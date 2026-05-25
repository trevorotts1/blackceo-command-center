'use client';

/**
 * SystemStatusDrawer — slide-out drawer with per-component detail (PRD 3.12).
 *
 * Receives the current payload from SystemStatusPill and exposes a refresh
 * button that triggers `?force=1` re-runs. Also exposes a "Re-run bootstrap"
 * admin action that streams `/api/system/bootstrap` SSE output into a modal
 * log view (PRD v4.0.1 P1-13).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { X, RefreshCw, PlayCircle } from 'lucide-react';

type SystemStatus =
  | 'live'
  | 'working'
  | 'busy'
  | 'degraded'
  | 'offline'
  | 'unknown';

interface ProbeResult {
  component: string;
  label: string;
  status: SystemStatus;
  latencyMs: number | null;
  error?: string;
  detail?: Record<string, unknown>;
  probedAt: string;
}

interface StatusPayload {
  overall: SystemStatus;
  probedAt: string;
  components: ProbeResult[];
  fromCache: boolean;
  cacheAgeMs: number | null;
}

interface Props {
  payload: StatusPayload | null;
  loading: boolean;
  onRefresh: () => void;
  onClose: () => void;
}

const STATUS_DOT: Record<SystemStatus, string> = {
  live: 'bg-emerald-500',
  working: 'bg-emerald-500 animate-pulse',
  busy: 'bg-amber-500 animate-pulse',
  degraded: 'bg-orange-500',
  offline: 'bg-red-500',
  unknown: 'bg-gray-400',
};

const STATUS_TEXT: Record<SystemStatus, string> = {
  live: 'text-emerald-700',
  working: 'text-emerald-700',
  busy: 'text-amber-700',
  degraded: 'text-orange-700',
  offline: 'text-red-700',
  unknown: 'text-gray-600',
};

export function SystemStatusDrawer({ payload, loading, onRefresh, onClose }: Props) {
  const components = payload?.components || [];
  const [bootstrapOpen, setBootstrapOpen] = useState(false);
  const [bootstrapRunning, setBootstrapRunning] = useState(false);

  // Group components by category for readability.
  const core = components.filter((c) =>
    ['database', 'openclaw_gateway', 'memory', 'jobs', 'disk', 'agents', 'telegram'].includes(c.component)
  );
  const providers = components.filter((c) => c.component.startsWith('provider_'));

  return (
    <div className="fixed inset-0 z-50 flex">
      <div
        className="flex-1 bg-black/30"
        onClick={onClose}
        aria-hidden
      />
      <aside className="w-96 bg-white border-l border-gray-200 shadow-xl flex flex-col">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-gray-900">System Status</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              {payload?.fromCache
                ? `Cached ${Math.round((payload.cacheAgeMs || 0) / 1000)}s ago`
                : payload
                ? `Live as of ${new Date(payload.probedAt).toLocaleTimeString()}`
                : 'Loading...'}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={onRefresh}
              disabled={loading}
              className="p-1.5 rounded-md text-gray-500 hover:bg-gray-100 disabled:opacity-50"
              title="Force refresh"
              aria-label="Force refresh status"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-md text-gray-500 hover:bg-gray-100"
              title="Close"
              aria-label="Close status drawer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-6">
          <Section title="Core" rows={core} />
          <Section title="Model Providers" rows={providers} />
        </div>

        <div className="border-t border-gray-100 p-4 bg-gray-50">
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
            Admin Actions
          </h3>
          <button
            onClick={() => setBootstrapOpen(true)}
            disabled={bootstrapRunning}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md bg-gray-900 text-white text-sm font-medium hover:bg-gray-800 disabled:opacity-60 disabled:cursor-not-allowed"
            title="Re-run the platform bootstrap script"
          >
            <PlayCircle className="w-4 h-4" />
            {bootstrapRunning ? 'Bootstrap running...' : 'Re-run bootstrap'}
          </button>
          <p className="mt-2 text-[11px] leading-snug text-gray-500">
            Runs the install script for this platform. May take 5 to 15 minutes.
          </p>
        </div>
      </aside>

      {bootstrapOpen && (
        <BootstrapModal
          onClose={() => setBootstrapOpen(false)}
          onRunningChange={setBootstrapRunning}
        />
      )}
    </div>
  );
}

interface BootstrapModalProps {
  onClose: () => void;
  onRunningChange: (running: boolean) => void;
}

type BootstrapStatus = 'idle' | 'running' | 'success' | 'error';

interface LogLine {
  stream: 'stdout' | 'stderr' | 'meta';
  text: string;
}

function BootstrapModal({ onClose, onRunningChange }: BootstrapModalProps) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [status, setStatus] = useState<BootstrapStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [summary, setSummary] = useState<{ exitCode: number; durationMs: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const startedRef = useRef(false);

  const appendLine = useCallback((line: LogLine) => {
    setLines((prev) => {
      // Cap log buffer at 2000 lines so the DOM stays responsive over long runs.
      const next = prev.length > 2000 ? prev.slice(prev.length - 1500) : prev;
      return [...next, line];
    });
  }, []);

  // Parse the SSE stream. We do this manually because EventSource only
  // supports GET requests, and we need POST.
  const startStream = useCallback(async () => {
    setStatus('running');
    setErrorMessage(null);
    setSummary(null);
    onRunningChange(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch('/api/system/bootstrap', {
        method: 'POST',
        signal: controller.signal,
        headers: { Accept: 'text/event-stream' },
      });

      if (!res.ok || !res.body) {
        const detail = await safeReadText(res);
        setStatus('error');
        setErrorMessage(
          detail || `Request failed with status ${res.status}`
        );
        onRunningChange(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE events are separated by a blank line.
        let sepIdx = buffer.indexOf('\n\n');
        while (sepIdx !== -1) {
          const rawEvent = buffer.slice(0, sepIdx);
          buffer = buffer.slice(sepIdx + 2);
          handleSseBlock(rawEvent);
          sepIdx = buffer.indexOf('\n\n');
        }
      }

      // Flush any trailing event without a terminator.
      if (buffer.trim().length > 0) {
        handleSseBlock(buffer);
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        appendLine({
          stream: 'meta',
          text: '[client] Stream canceled. The bootstrap process is still running on the server.',
        });
      } else {
        setStatus('error');
        setErrorMessage(err instanceof Error ? err.message : String(err));
      }
    } finally {
      onRunningChange(false);
      abortRef.current = null;
    }

    function handleSseBlock(block: string) {
      const evtMatch = block.match(/^event:\s*(.+)$/m);
      const dataLines = block
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.replace(/^data:\s?/, ''));
      const eventName = evtMatch ? evtMatch[1].trim() : 'message';
      const data = dataLines.join('\n');

      if (eventName === 'stdout') {
        appendLine({ stream: 'stdout', text: data });
      } else if (eventName === 'stderr') {
        appendLine({ stream: 'stderr', text: data });
      } else if (eventName === 'error') {
        setErrorMessage(data);
      } else if (eventName === 'complete') {
        try {
          const parsed = JSON.parse(data) as { exitCode: number; durationMs: number };
          setSummary(parsed);
          setStatus(parsed.exitCode === 0 ? 'success' : 'error');
        } catch {
          setStatus('error');
          setErrorMessage(`Malformed complete event: ${data}`);
        }
      }
    }
  }, [appendLine, onRunningChange]);

  // Kick off the stream once on mount.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void startStream();
  }, [startStream]);

  // Auto-scroll the log to the bottom as lines arrive.
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [lines.length]);

  const handleCancelStream = () => {
    abortRef.current?.abort();
  };

  const handleClose = () => {
    abortRef.current?.abort();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/50">
      <div className="w-full max-w-3xl max-h-[85vh] bg-white rounded-xl shadow-2xl border border-gray-200 flex flex-col">
        <div className="px-5 py-4 border-b border-gray-100 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Re-run bootstrap</h2>
            <p className="text-xs text-gray-500 mt-1">
              Streaming live output from the install script. Closing this
              window does not stop the bootstrap process on the server.
            </p>
          </div>
          <button
            onClick={handleClose}
            className="p-1.5 rounded-md text-gray-500 hover:bg-gray-100"
            title="Close"
            aria-label="Close bootstrap modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {status === 'success' && summary && (
          <div className="px-5 py-3 bg-emerald-50 border-b border-emerald-100 text-sm text-emerald-800">
            Bootstrap completed in {(summary.durationMs / 1000).toFixed(1)}s (exit 0).
          </div>
        )}
        {status === 'error' && (
          <div className="px-5 py-3 bg-red-50 border-b border-red-100 text-sm text-red-800">
            <div className="font-medium">Bootstrap failed</div>
            <div className="mt-0.5 text-xs text-red-700 break-words">
              {errorMessage || (summary ? `Exit code ${summary.exitCode}` : 'Unknown error')}
            </div>
          </div>
        )}

        <div className="flex-1 overflow-hidden p-4 bg-gray-950">
          <pre
            className="h-full max-h-[55vh] overflow-y-auto text-xs leading-relaxed font-mono text-gray-100 whitespace-pre-wrap break-words"
            aria-live="polite"
          >
            {lines.map((line, idx) => (
              <div
                key={idx}
                className={
                  line.stream === 'stderr'
                    ? 'text-orange-300'
                    : line.stream === 'meta'
                    ? 'text-sky-300 italic'
                    : 'text-gray-100'
                }
              >
                {line.text || ' '}
              </div>
            ))}
            <div ref={logEndRef} />
          </pre>
        </div>

        <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-between gap-2 bg-gray-50">
          <div className="text-xs text-gray-500">
            {status === 'running' && 'Streaming...'}
            {status === 'success' && 'Done.'}
            {status === 'error' && 'Stopped with errors.'}
            {status === 'idle' && 'Starting...'}
          </div>
          <div className="flex items-center gap-2">
            {status === 'running' && (
              <button
                onClick={handleCancelStream}
                className="px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-100"
              >
                Cancel stream
              </button>
            )}
            <button
              onClick={handleClose}
              className="px-3 py-1.5 text-xs font-medium text-white bg-gray-900 rounded-md hover:bg-gray-800"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

async function safeReadText(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return '';
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && 'error' in parsed) {
        return String((parsed as { error: unknown }).error);
      }
    } catch {
      // not JSON, fall through
    }
    return text;
  } catch {
    return '';
  }
}

function Section({ title, rows }: { title: string; rows: ProbeResult[] }) {
  if (rows.length === 0) return null;
  return (
    <section>
      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{title}</h3>
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.component} className="border border-gray-100 rounded-lg p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 min-w-0">
                <span className={`w-2 h-2 rounded-full ${STATUS_DOT[r.status]}`} />
                <span className="text-sm font-medium text-gray-900 truncate">{r.label}</span>
              </div>
              <span className={`text-xs font-semibold uppercase ${STATUS_TEXT[r.status]}`}>
                {r.status}
              </span>
            </div>
            <div className="mt-1 text-xs text-gray-500 flex items-center gap-3">
              {typeof r.latencyMs === 'number' && <span>{r.latencyMs}ms</span>}
              {r.error && <span className="text-orange-600 truncate">{r.error}</span>}
            </div>
            {r.detail && Object.keys(r.detail).length > 0 && (
              <details className="mt-2">
                <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-700">Detail</summary>
                <pre className="mt-1 text-xs text-gray-600 bg-gray-50 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
                  {JSON.stringify(r.detail, null, 2)}
                </pre>
              </details>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
