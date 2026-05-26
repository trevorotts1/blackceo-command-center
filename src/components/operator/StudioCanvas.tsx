/**
 * StudioCanvas — top-level Studio client component.
 *
 * Owns:
 *   - Current kind (image | video | audio)
 *   - Per-kind model selection (defaults to first available)
 *   - Prompt state
 *   - Active job + poll loop
 *   - History grid (recent jobs for the current kind)
 *
 * Track B4 (Operator Studio).
 */

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { StudioJob, StudioKind, StudioModelOption } from '@/lib/studio/generators';
import StudioToolbar from './StudioToolbar';
import StudioOutputPanel from './StudioOutputPanel';

interface StudioCanvasProps {
  initialModels: Record<StudioKind, StudioModelOption[]>;
}

const TERMINAL: StudioJob['status'][] = ['succeeded', 'failed'];

export default function StudioCanvas({ initialModels }: StudioCanvasProps) {
  const [kind, setKind] = useState<StudioKind>('image');
  const [prompt, setPrompt] = useState('');

  // Per-kind selected model id. Defaults to first available for that kind.
  const [modelByKind, setModelByKind] = useState<Record<StudioKind, string | null>>(() => ({
    image: initialModels.image[0]?.model_id ?? null,
    video: initialModels.video[0]?.model_id ?? null,
    audio: initialModels.audio[0]?.model_id ?? null,
  }));

  const [activeJob, setActiveJob] = useState<StudioJob | null>(null);
  const [history, setHistory] = useState<StudioJob[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const models = initialModels[kind];
  const busy = Boolean(activeJob && !TERMINAL.includes(activeJob.status));

  // Initial history fetch + refetch on kind change.
  useEffect(() => {
    let alive = true;
    fetch(`/api/operator/studio/jobs?kind=${kind}&limit=24`)
      .then((r) => (r.ok ? r.json() : { jobs: [] }))
      .then((j) => {
        if (!alive) return;
        setHistory((j.jobs as StudioJob[]) ?? []);
      })
      .catch(() => {
        if (alive) setHistory([]);
      });
    return () => {
      alive = false;
    };
  }, [kind]);

  // Poll the active job until it terminates.
  useEffect(() => {
    if (!activeJob || TERMINAL.includes(activeJob.status)) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    const id = activeJob.id;
    pollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`/api/operator/studio/jobs/${id}`);
        if (!r.ok) return;
        const j = (await r.json()) as { job: StudioJob };
        setActiveJob(j.job);
        if (TERMINAL.includes(j.job.status)) {
          // Splice into history once terminal.
          setHistory((h) => {
            const without = h.filter((x) => x.id !== j.job.id);
            return [j.job, ...without].slice(0, 24);
          });
        }
      } catch {
        // network blip — keep polling
      }
    }, 1500);
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [activeJob]);

  const generate = useCallback(async () => {
    const p = prompt.trim();
    if (!p) return;
    const body = {
      kind,
      prompt: p,
      model_id: modelByKind[kind] ?? undefined,
    };
    const res = await fetch('/api/operator/studio/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text();
      setActiveJob({
        id: `local-${Date.now()}`,
        kind,
        status: 'failed',
        prompt: p,
        model_id: modelByKind[kind],
        provider: null,
        result_path: null,
        result_url: null,
        error: detail || `Request failed: ${res.status}`,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        duration_ms: 0,
        metadata: {},
      });
      return;
    }
    const json = (await res.json()) as { job_id: string; status: StudioJob['status']; model_id: string | null; provider: string | null; created_at: string };
    setActiveJob({
      id: json.job_id,
      kind,
      status: json.status,
      prompt: p,
      model_id: json.model_id,
      provider: json.provider,
      result_path: null,
      result_url: null,
      error: null,
      created_at: json.created_at,
      updated_at: json.created_at,
      duration_ms: null,
      metadata: {},
    });
    setPrompt('');
  }, [kind, modelByKind, prompt]);

  const onSelectModel = useCallback(
    (m: string | null) => {
      setModelByKind((prev) => ({ ...prev, [kind]: m }));
    },
    [kind]
  );

  const historyForKind = useMemo(() => history.filter((j) => j.kind === kind), [history, kind]);

  // Bug 6 (v4.0.2): louder empty state when no providers are configured for
  // any kind. The previous "No active generation" placeholder looked
  // identical to a broken page on fresh deploys.
  const noProvidersConfigured =
    initialModels.image.length === 0 &&
    initialModels.video.length === 0 &&
    initialModels.audio.length === 0;

  if (noProvidersConfigured) {
    return (
      <div className="rounded-xl border border-bcc-border bg-bcc-white p-8 text-center">
        <h2 className="text-base font-semibold text-bcc-text">Studio is ready, but no providers are configured yet.</h2>
        <p className="mx-auto mt-3 max-w-xl text-sm text-bcc-text-secondary">
          No image, video, or audio providers configured yet. Add API keys for Fish Audio, xAI Grok, KIE, Fal.ai, or Replicate in Settings, Intelligence Settings to enable generation.
        </p>
        <a
          href="/settings/intelligence"
          className="mt-5 inline-flex items-center rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
        >
          Open Intelligence Settings
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <StudioToolbar
        kind={kind}
        onKindChange={(k) => {
          if (!busy) setKind(k);
        }}
        models={models}
        modelId={modelByKind[kind]}
        onModelChange={onSelectModel}
        prompt={prompt}
        onPromptChange={setPrompt}
        onGenerate={generate}
        busy={busy}
      />

      <StudioOutputPanel job={activeJob} />

      {historyForKind.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-xs uppercase tracking-widest text-bcc-text-muted">Recent {kind} generations</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {historyForKind.map((job) => (
              <HistoryTile key={job.id} job={job} onSelect={() => setActiveJob(job)} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function HistoryTile({ job, onSelect }: { job: StudioJob; onSelect: () => void }) {
  const isDone = job.status === 'succeeded' && job.result_url;
  return (
    <button
      type="button"
      onClick={onSelect}
      className="group overflow-hidden rounded-xl border border-bcc-border bg-bcc-white text-left transition hover:border-bcc-text-secondary"
    >
      <div className="aspect-video w-full bg-bcc-bg">
        {isDone && job.kind === 'image' && job.result_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={job.result_url} alt={job.prompt} className="h-full w-full object-cover" />
        )}
        {isDone && job.kind === 'video' && job.result_url && (
          <video src={job.result_url} muted playsInline preload="metadata" className="h-full w-full object-cover" />
        )}
        {(!isDone || job.kind === 'audio') && (
          <div className="grid h-full w-full place-items-center text-[11px] uppercase tracking-widest text-bcc-text-muted">
            {job.status}
          </div>
        )}
      </div>
      <div className="p-2.5">
        <p className="line-clamp-2 text-xs text-bcc-text">{job.prompt}</p>
        <p className="mt-1 text-[10px] uppercase tracking-widest text-bcc-text-muted">
          {new Date(job.created_at).toLocaleString('en-GB', { hour12: false })}
        </p>
      </div>
    </button>
  );
}
