/**
 * StudioToolbar — generation form.
 *
 * Kind tabs (image | video | audio), model picker (driven by the registry),
 * prompt textarea, and the Generate button. Hands the request off to the
 * parent StudioCanvas which owns job state.
 *
 * Track B4 (Operator Studio).
 */

'use client';

import { ImageIcon, VideoIcon, MicIcon, SparklesIcon, Loader2Icon } from 'lucide-react';
import type { StudioKind, StudioModelOption } from '@/lib/studio/generators';

const KIND_META: Record<StudioKind, { label: string; icon: React.ReactNode; accent: string; placeholder: string }> = {
  image: {
    label: 'Image',
    icon: <ImageIcon size={14} />,
    accent: '#EC4899',
    placeholder: 'A glowing futuristic dashboard floating in deep space, neon accents, cinematic lighting.',
  },
  video: {
    label: 'Video',
    icon: <VideoIcon size={14} />,
    accent: '#A855F7',
    placeholder: 'Slow zoom into a neon lit cyberpunk city street at night, rain reflections, four seconds.',
  },
  audio: {
    label: 'Audio',
    icon: <MicIcon size={14} />,
    accent: '#22D3EE',
    placeholder: 'Welcome to BlackCEO Command Center. Your studio is online and ready.',
  },
};

interface StudioToolbarProps {
  kind: StudioKind;
  onKindChange: (k: StudioKind) => void;
  models: StudioModelOption[];
  modelId: string | null;
  onModelChange: (m: string | null) => void;
  prompt: string;
  onPromptChange: (s: string) => void;
  onGenerate: () => void;
  busy: boolean;
}

export default function StudioToolbar(props: StudioToolbarProps) {
  const meta = KIND_META[props.kind];
  const noModels = props.models.length === 0;
  const disabled = props.busy || !props.prompt.trim() || noModels;

  return (
    <section className="space-y-3 rounded-xl border border-bcc-border bg-bcc-white p-4">
      <div className="flex flex-wrap items-center gap-2">
        {(Object.keys(KIND_META) as StudioKind[]).map((k) => {
          const m = KIND_META[k];
          const active = props.kind === k;
          return (
            <button
              key={k}
              type="button"
              onClick={() => !props.busy && props.onKindChange(k)}
              disabled={props.busy}
              className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition disabled:opacity-50"
              style={{
                background: active ? `${m.accent}1A` : 'transparent',
                borderColor: active ? m.accent : '#E5E7EB',
                color: active ? '#1A1D26' : '#6B7280',
              }}
            >
              {m.icon}
              {m.label}
            </button>
          );
        })}
        <div className="ml-auto flex items-center gap-2">
          <label className="text-[11px] uppercase tracking-widest text-bcc-text-muted">Model</label>
          <select
            value={props.modelId ?? ''}
            onChange={(e) => props.onModelChange(e.target.value || null)}
            disabled={props.busy || noModels}
            className="rounded-md border border-bcc-border bg-bcc-white px-2 py-1 text-xs text-bcc-text disabled:opacity-50"
          >
            {noModels ? (
              <option value="">No providers configured</option>
            ) : (
              props.models.map((m) => (
                <option key={m.model_id} value={m.model_id}>
                  {m.label} ({m.provider})
                </option>
              ))
            )}
          </select>
        </div>
      </div>

      <textarea
        value={props.prompt}
        onChange={(e) => props.onPromptChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !disabled) {
            e.preventDefault();
            props.onGenerate();
          }
        }}
        rows={3}
        placeholder={meta.placeholder}
        className="w-full resize-y rounded-lg border border-bcc-border bg-bcc-bg px-3 py-2 text-sm text-bcc-text placeholder:text-bcc-text-muted focus:outline-none focus:border-bcc-text-secondary"
      />

      <div className="flex items-center justify-between">
        <p className="text-[11px] uppercase tracking-widest text-bcc-text-muted">
          {noModels
            ? `No model registry rows with the ${props.kind === 'audio' ? 'audio_generation' : props.kind + '_generation'} capability and a configured API key.`
            : 'Press Cmd or Ctrl + Enter to generate.'}
        </p>
        <button
          type="button"
          onClick={props.onGenerate}
          disabled={disabled}
          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition disabled:opacity-40"
          style={{
            background: `${meta.accent}26`,
            border: `1px solid ${meta.accent}66`,
            color: meta.accent,
          }}
        >
          {props.busy ? <Loader2Icon size={14} className="animate-spin" /> : <SparklesIcon size={14} />}
          {props.busy ? 'Generating' : 'Generate'}
        </button>
      </div>
    </section>
  );
}
