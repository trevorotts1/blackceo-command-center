'use client';

import {
  Eye,
  Image as ImageIcon,
  Video,
  Music,
  Mic,
  Sparkles,
  Wrench,
  Code2,
  Globe,
  Type,
  type LucideIcon,
} from 'lucide-react';

/**
 * CapabilityBadge - single capability pill used on ModelCard.
 *
 * Capability vocabulary matches `MODEL_CAPABILITIES` in
 * `src/lib/model-registry.ts` (PRD Section 5.1). Unknown capabilities still
 * render as a neutral pill so a future capability added to the registry does
 * not crash the UI.
 */

export type Capability =
  | 'text'
  | 'vision'
  | 'image_generation'
  | 'video_generation'
  | 'audio_generation'
  | 'audio_transcription'
  | 'embeddings'
  | 'tool_use'
  | 'code_execution'
  | 'web_search';

interface CapabilityMeta {
  label: string;
  Icon: LucideIcon;
  className: string;
}

const CAPABILITY_META: Record<Capability, CapabilityMeta> = {
  text: {
    label: 'Text',
    Icon: Type,
    className: 'bg-gray-100 text-gray-700 border-gray-200',
  },
  vision: {
    label: 'Vision',
    Icon: Eye,
    className: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  },
  image_generation: {
    label: 'Image gen',
    Icon: ImageIcon,
    className: 'bg-pink-50 text-pink-700 border-pink-200',
  },
  video_generation: {
    label: 'Video gen',
    Icon: Video,
    className: 'bg-rose-50 text-rose-700 border-rose-200',
  },
  audio_generation: {
    label: 'Audio gen',
    Icon: Music,
    className: 'bg-orange-50 text-orange-700 border-orange-200',
  },
  audio_transcription: {
    label: 'Transcribe',
    Icon: Mic,
    className: 'bg-amber-50 text-amber-700 border-amber-200',
  },
  embeddings: {
    label: 'Embeddings',
    Icon: Sparkles,
    className: 'bg-teal-50 text-teal-700 border-teal-200',
  },
  tool_use: {
    label: 'Tools',
    Icon: Wrench,
    className: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  },
  code_execution: {
    label: 'Code',
    Icon: Code2,
    className: 'bg-blue-50 text-blue-700 border-blue-200',
  },
  web_search: {
    label: 'Web',
    Icon: Globe,
    className: 'bg-cyan-50 text-cyan-700 border-cyan-200',
  },
};

interface CapabilityBadgeProps {
  capability: string;
  size?: 'sm' | 'md';
}

export function CapabilityBadge({ capability, size = 'sm' }: CapabilityBadgeProps) {
  const meta = CAPABILITY_META[capability as Capability];
  const Icon = meta?.Icon ?? Type;
  const label = meta?.label ?? capability;
  const className = meta?.className ?? 'bg-gray-100 text-gray-600 border-gray-200';

  const iconSize = size === 'md' ? 'w-3.5 h-3.5' : 'w-3 h-3';
  const padding = size === 'md' ? 'px-2 py-0.5 text-xs' : 'px-1.5 py-0.5 text-[10px]';

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border font-medium ${padding} ${className}`}
      title={meta?.label ?? capability}
    >
      <Icon className={iconSize} />
      {label}
    </span>
  );
}

/**
 * Stable list of capability slugs used by the filter bar. Exported here so
 * the filter UI and the badge share a single source of truth.
 */
export const ALL_CAPABILITIES: Capability[] = [
  'text',
  'vision',
  'image_generation',
  'video_generation',
  'audio_generation',
  'audio_transcription',
  'embeddings',
  'tool_use',
  'code_execution',
  'web_search',
];
