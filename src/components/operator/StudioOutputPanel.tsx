/**
 * StudioOutputPanel — single job render (current generation or history detail).
 *
 * Renders image, video, or audio inline based on job kind. Shows status,
 * elapsed time, model, provider, and a download link for completed jobs.
 *
 * Track B4 (Operator Studio).
 */

'use client';

import { AlertCircleIcon, Clock3Icon, DownloadIcon, Loader2Icon } from 'lucide-react';
import type { StudioJob } from '@/lib/studio/generators';

interface StudioOutputPanelProps {
  job: StudioJob | null;
}

export default function StudioOutputPanel({ job }: StudioOutputPanelProps) {
  if (!job) {
    return (
      <section className="rounded-xl border border-dashed border-bcc-border bg-bcc-bg p-8 text-center">
        <p className="text-sm text-bcc-text-secondary">
          No active generation. Type a prompt and hit Generate to start.
        </p>
      </section>
    );
  }

  const isDone = job.status === 'succeeded';
  const isFailed = job.status === 'failed';
  const isWorking = job.status === 'queued' || job.status === 'running';

  return (
    <section className="space-y-3 rounded-xl border border-bcc-border bg-bcc-white p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <StatusBadge status={job.status} />
          <span className="text-xs uppercase tracking-widest text-bcc-text-muted">{job.kind}</span>
          {job.model_id && (
            <span className="text-xs text-bcc-text-secondary">
              {job.provider ? `${job.provider} ` : ''}
              {job.model_id}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-widest text-bcc-text-muted">
          <Clock3Icon size={11} />
          {job.duration_ms != null
            ? `${(job.duration_ms / 1000).toFixed(1)}s`
            : new Date(job.created_at).toLocaleTimeString('en-GB', { hour12: false })}
        </div>
      </header>

      <p className="text-sm text-bcc-text">{job.prompt}</p>

      {isWorking && (
        <div className="flex items-center gap-2 rounded-lg border border-bcc-border bg-bcc-bg p-4 text-sm text-bcc-text-secondary">
          <Loader2Icon size={16} className="animate-spin" />
          {job.status === 'queued' ? 'Queued' : 'Generating'} ...
        </div>
      )}

      {isFailed && (
        <div className="flex items-start gap-2 rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-700">
          <AlertCircleIcon size={14} className="mt-0.5 shrink-0" />
          <div className="min-w-0 break-words">{job.error || 'Generation failed'}</div>
        </div>
      )}

      {isDone && job.result_url && (
        <div className="overflow-hidden rounded-lg border border-bcc-border bg-bcc-bg">
          {job.kind === 'image' && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={job.result_url} alt={job.prompt} className="max-h-[480px] w-full object-contain bg-black" />
          )}
          {job.kind === 'video' && (
            <video src={job.result_url} controls playsInline preload="metadata" className="w-full max-h-[480px] bg-black" />
          )}
          {job.kind === 'audio' && (
            <div className="p-3">
              <audio src={job.result_url} controls preload="metadata" className="w-full" />
            </div>
          )}
        </div>
      )}

      {isDone && job.result_path && (
        <div className="flex items-center justify-between text-[11px] uppercase tracking-widest text-bcc-text-muted">
          <span className="truncate font-mono normal-case" title={job.result_path}>
            {job.result_path}
          </span>
          {job.result_url && (
            <a
              href={job.result_url}
              download
              className="inline-flex items-center gap-1 text-bcc-text-secondary hover:text-bcc-text"
            >
              <DownloadIcon size={11} /> Save
            </a>
          )}
        </div>
      )}
    </section>
  );
}

function StatusBadge({ status }: { status: StudioJob['status'] }) {
  const styles: Record<StudioJob['status'], { bg: string; fg: string; label: string }> = {
    queued: { bg: '#F3F4F6', fg: '#6B7280', label: 'Queued' },
    running: { bg: '#FEF3C7', fg: '#92400E', label: 'Running' },
    succeeded: { bg: '#D1FAE5', fg: '#065F46', label: 'Done' },
    failed: { bg: '#FEE2E2', fg: '#991B1B', label: 'Failed' },
  };
  const s = styles[status];
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest"
      style={{ background: s.bg, color: s.fg }}
    >
      {s.label}
    </span>
  );
}
