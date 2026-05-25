'use client';

/**
 * WebAgentForm - task entry form for the Operator Console Web Agent.
 *
 * Track B9 (SCOPE-ADDITION Section 7).
 *
 * Submits to POST /api/operator/web-agent/run. On success the parent page
 * routes to /operator/web-agent/session/[id] so the live SSE view takes
 * over. Optional `start_url` lets the operator skip the model's first
 * navigation step when they know exactly where the task starts.
 */

import { useState, FormEvent } from 'react';
import { Globe, Loader2 } from 'lucide-react';

export interface WebAgentRunResponse {
  session_id: string;
  status: string;
  started_at: string;
  screenshots_dir: string | null;
}

export interface WebAgentFormProps {
  onStarted?: (response: WebAgentRunResponse) => void;
}

export default function WebAgentForm({ onStarted }: WebAgentFormProps) {
  const [task, setTask] = useState('');
  const [startUrl, setStartUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = task.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { task: trimmed };
      const url = startUrl.trim();
      if (url) {
        body.start_url = url;
      }
      const res = await fetch('/api/operator/web-agent/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Run failed (${res.status}): ${text.slice(0, 200)}`);
      }
      const json = (await res.json()) as WebAgentRunResponse;
      onStarted?.(json);
      setTask('');
      setStartUrl('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-3 rounded-xl border border-bcc-border bg-bcc-white p-4"
      aria-label="Web Agent task form"
    >
      <label className="block">
        <span className="text-[12px] uppercase tracking-[0.22em] text-bcc-text-muted font-semibold">
          Task
        </span>
        <textarea
          value={task}
          onChange={(e) => setTask(e.target.value)}
          placeholder='Example: Find 5 organic ergonomic office chairs under $400 with 4.5+ stars on Amazon. Return a markdown table with name, price, rating, and URL.'
          aria-label="Web Agent task"
          disabled={busy}
          rows={4}
          className="mt-1 w-full rounded-lg border border-bcc-border bg-bcc-bg px-3 py-2 text-[14px] text-bcc-text placeholder:text-bcc-text-muted outline-none focus:border-bcc-text disabled:opacity-60"
        />
      </label>

      <label className="block">
        <span className="text-[12px] uppercase tracking-[0.22em] text-bcc-text-muted font-semibold">
          Start URL (optional)
        </span>
        <input
          type="url"
          value={startUrl}
          onChange={(e) => setStartUrl(e.target.value)}
          placeholder="https://"
          aria-label="Optional start URL"
          disabled={busy}
          className="mt-1 w-full rounded-lg border border-bcc-border bg-bcc-bg px-3 py-2 text-[14px] text-bcc-text placeholder:text-bcc-text-muted outline-none focus:border-bcc-text disabled:opacity-60"
        />
      </label>

      <div className="flex items-center justify-between">
        <p className="text-[11px] text-bcc-text-muted">
          Runs in an isolated headless browser. No cookies or credentials.
        </p>
        <button
          type="submit"
          disabled={busy || !task.trim()}
          className="inline-flex items-center gap-2 rounded-lg bg-bcc-text px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Globe size={14} />}
          {busy ? 'Launching...' : 'Run Web Agent'}
        </button>
      </div>

      {error ? (
        <div className="text-[12px] text-red-600" role="alert">
          {error}
        </div>
      ) : null}
    </form>
  );
}
