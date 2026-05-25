'use client';

/**
 * WebAgentSession - live view for a single Web Agent run.
 *
 * Track B9 (SCOPE-ADDITION Section 7).
 *
 * Subscribes to /api/operator/web-agent/session/[id]/stream via EventSource
 * and renders three panes:
 *   1. The latest screenshot (PNG, base64), full-width.
 *   2. A chronological action log on the right.
 *   3. The final markdown result underneath once the run completes.
 *
 * The component bootstraps from the row already persisted on the server
 * (passed in via props) so a page reload after the run finishes still
 * renders everything without depending on the SSE replay.
 */

import { useEffect, useMemo, useState } from 'react';
import { Activity, Camera, CheckCircle2, AlertTriangle, Loader2, FileText } from 'lucide-react';

export type WebAgentStatusValue = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface WebAgentSessionInitial {
  id: string;
  task: string;
  status: WebAgentStatusValue;
  started_at: string;
  ended_at: string | null;
  result_markdown: string | null;
  action_log: Array<{
    ts: string;
    kind: 'action' | 'model' | 'error' | 'system';
    description: string;
    detail?: Record<string, unknown>;
  }>;
}

export interface WebAgentSessionProps {
  initial: WebAgentSessionInitial;
}

interface LogEntry {
  ts: string;
  kind: 'action' | 'model' | 'error' | 'system' | 'status';
  description: string;
}

const STATUS_LABEL: Record<WebAgentStatusValue, string> = {
  pending: 'Pending',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

function StatusBadge({ status }: { status: WebAgentStatusValue }) {
  const cls =
    status === 'completed'
      ? 'bg-green-50 text-green-700 border-green-200'
      : status === 'failed' || status === 'cancelled'
        ? 'bg-red-50 text-red-700 border-red-200'
        : status === 'running'
          ? 'bg-amber-50 text-amber-700 border-amber-200'
          : 'bg-bcc-bg text-bcc-text-secondary border-bcc-border';
  const Icon =
    status === 'completed'
      ? CheckCircle2
      : status === 'failed' || status === 'cancelled'
        ? AlertTriangle
        : status === 'running'
          ? Loader2
          : Activity;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium uppercase tracking-[0.16em] ${cls}`}
    >
      <Icon size={12} className={status === 'running' ? 'animate-spin' : ''} />
      {STATUS_LABEL[status]}
    </span>
  );
}

export default function WebAgentSession({ initial }: WebAgentSessionProps) {
  const [status, setStatus] = useState<WebAgentStatusValue>(initial.status);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [log, setLog] = useState<LogEntry[]>(
    initial.action_log.map((e) => ({
      ts: e.ts,
      kind: e.kind,
      description: e.description,
    }))
  );
  const [resultMarkdown, setResultMarkdown] = useState<string | null>(initial.result_markdown);
  const [endedAt, setEndedAt] = useState<string | null>(initial.ended_at);
  const [streamError, setStreamError] = useState<string | null>(null);

  const isTerminal = useMemo(
    () => status === 'completed' || status === 'failed' || status === 'cancelled',
    [status]
  );

  useEffect(() => {
    // If the session is already over, skip opening the SSE channel. The
    // replay would just resend everything we already rendered server-side.
    if (initial.status === 'completed' || initial.status === 'failed' || initial.status === 'cancelled') {
      return;
    }
    let es: EventSource | null = null;
    try {
      es = new EventSource(`/api/operator/web-agent/session/${initial.id}/stream`);
    } catch (err) {
      setStreamError(err instanceof Error ? err.message : 'EventSource unavailable');
      return;
    }

    function append(entry: LogEntry) {
      setLog((prev) => {
        // Avoid duplicating entries already rendered from the initial row when
        // the SSE replay resends them with the same ts + description.
        const last = prev[prev.length - 1];
        if (last && last.ts === entry.ts && last.description === entry.description) {
          return prev;
        }
        return [...prev, entry];
      });
    }

    es.addEventListener('screenshot', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as { png_base64?: string };
        if (data.png_base64) setScreenshot(data.png_base64);
      } catch {
        // ignore malformed frame
      }
    });
    es.addEventListener('action', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as { ts: string; description: string };
        append({ ts: data.ts, kind: 'action', description: data.description });
      } catch {
        // ignore
      }
    });
    es.addEventListener('log', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as {
          ts: string;
          kind: LogEntry['kind'];
          description: string;
        };
        append({ ts: data.ts, kind: data.kind, description: data.description });
      } catch {
        // ignore
      }
    });
    es.addEventListener('status', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as {
          ts: string;
          status?: WebAgentStatusValue;
          ended_at?: string;
        };
        if (data.status) {
          setStatus(data.status);
          append({ ts: data.ts, kind: 'status', description: `status -> ${data.status}` });
        }
        if (data.ended_at) setEndedAt(data.ended_at);
      } catch {
        // ignore
      }
    });
    es.addEventListener('result', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as { markdown?: string };
        if (data.markdown) setResultMarkdown(data.markdown);
      } catch {
        // ignore
      }
    });
    es.addEventListener('error', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as { ts?: string; message?: string };
        if (data.message) {
          append({
            ts: data.ts || new Date().toISOString(),
            kind: 'error',
            description: data.message,
          });
        }
      } catch {
        // EventSource also fires generic error events with no data - ignore those.
      }
    });
    es.addEventListener('done', () => {
      es?.close();
    });
    es.onerror = () => {
      // The browser auto-reconnects EventSource. Surface a soft notice but
      // keep the source alive so a transient blip does not lose the stream.
      setStreamError('Stream interrupted, reconnecting...');
      setTimeout(() => setStreamError(null), 4000);
    };

    return () => {
      es?.close();
    };
  }, [initial.id, initial.status]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[12px] uppercase tracking-[0.22em] text-bcc-text-muted font-semibold">
            Task
          </div>
          <p className="mt-1 text-body text-bcc-text">{initial.task}</p>
        </div>
        <StatusBadge status={status} />
      </div>

      {streamError ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
          {streamError}
        </div>
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
        <div className="rounded-xl border border-bcc-border bg-black overflow-hidden min-h-[400px] flex items-center justify-center">
          {screenshot ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`data:image/png;base64,${screenshot}`}
              alt="Live browser screenshot"
              className="max-w-full max-h-[640px] object-contain"
            />
          ) : (
            <div className="flex flex-col items-center gap-2 text-bcc-text-muted py-12">
              <Camera size={28} />
              <span className="text-[12px] uppercase tracking-[0.18em]">
                Waiting for first frame...
              </span>
            </div>
          )}
        </div>

        <aside
          className="rounded-xl border border-bcc-border bg-bcc-white flex flex-col min-h-[400px] max-h-[640px]"
          aria-label="Action log"
        >
          <div className="border-b border-bcc-border px-3 py-2 text-[12px] uppercase tracking-[0.22em] text-bcc-text-muted font-semibold">
            Action log
          </div>
          <ol className="flex-1 overflow-y-auto divide-y divide-bcc-border text-[12.5px]">
            {log.length === 0 ? (
              <li className="px-3 py-3 text-bcc-text-muted">No events yet.</li>
            ) : (
              log.map((entry, i) => (
                <li key={`${entry.ts}-${i}`} className="px-3 py-2">
                  <div className="flex items-start gap-2">
                    <KindDot kind={entry.kind} />
                    <div className="flex-1 min-w-0">
                      <div className="text-bcc-text break-words">{entry.description}</div>
                      <div className="text-[10.5px] text-bcc-text-muted mt-0.5">
                        {formatTime(entry.ts)}
                      </div>
                    </div>
                  </div>
                </li>
              ))
            )}
          </ol>
        </aside>
      </div>

      <div className="rounded-xl border border-bcc-border bg-bcc-white p-4">
        <div className="flex items-center gap-2 text-[12px] uppercase tracking-[0.22em] text-bcc-text-muted font-semibold">
          <FileText size={14} />
          Result
        </div>
        {resultMarkdown ? (
          <pre className="mt-3 whitespace-pre-wrap text-[13.5px] text-bcc-text font-mono leading-relaxed">
            {resultMarkdown}
          </pre>
        ) : isTerminal ? (
          <p className="mt-3 text-[13px] text-bcc-text-muted">No final report was produced.</p>
        ) : (
          <p className="mt-3 text-[13px] text-bcc-text-muted">
            The final report appears here once the agent finishes.
          </p>
        )}
        {endedAt ? (
          <p className="mt-3 text-[11px] text-bcc-text-muted">
            Ended {new Date(endedAt).toLocaleString()}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function KindDot({ kind }: { kind: LogEntry['kind'] }) {
  const cls =
    kind === 'action'
      ? 'bg-blue-500'
      : kind === 'model'
        ? 'bg-purple-500'
        : kind === 'error'
          ? 'bg-red-500'
          : kind === 'status'
            ? 'bg-amber-500'
            : 'bg-bcc-text-muted';
  return (
    <span
      aria-hidden
      className={`mt-1 inline-block h-2 w-2 shrink-0 rounded-full ${cls}`}
    />
  );
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return iso;
  }
}
