'use client';

import { Cpu, Check } from 'lucide-react';
import { CapabilityBadge } from './CapabilityBadge';

/**
 * ModelCard - compact catalog card for the Intelligence Settings model
 * browser. Used inside the "Available Models" panel so operators can scan
 * capability mix and cost band before assigning a model to a department.
 *
 * This component is intentionally read-only. Per PRD line 750 the persona
 * system is not touched here; persona-to-model assignment continues to
 * happen in the existing department picker below.
 */

export interface ModelCardData {
  id: string;
  label: string;
  provider?: string;
  family?: string;
  capabilities?: string[];
  cost_per_million_input?: number;
  cost_per_million_output?: number;
  status?: string;
}

interface ModelCardProps {
  model: ModelCardData;
  selected?: boolean;
  onSelect?: (id: string) => void;
}

/**
 * Cost band classification used on every card.
 *
 * Bands are anchored to the average of input+output cost per million tokens:
 *   - free:   exactly 0
 *   - low:    less than $2
 *   - mid:    $2 to under $10
 *   - high:   $10 and up
 *
 * The same thresholds drive the ModelFilterBar cost chips so a model that
 * matches the "mid" filter chip always renders the "mid" pill.
 */
export type CostBand = 'free' | 'low' | 'mid' | 'high' | 'unknown';

export function getCostBand(model: Pick<ModelCardData, 'cost_per_million_input' | 'cost_per_million_output'>): CostBand {
  const inCost = model.cost_per_million_input;
  const outCost = model.cost_per_million_output;
  if (inCost === undefined && outCost === undefined) return 'unknown';
  const avg = ((inCost ?? 0) + (outCost ?? 0)) / 2;
  if (avg === 0) return 'free';
  if (avg < 2) return 'low';
  if (avg < 10) return 'mid';
  return 'high';
}

const COST_BAND_STYLE: Record<CostBand, { label: string; className: string }> = {
  free: { label: 'Free', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  low: { label: 'Low cost', className: 'bg-green-50 text-green-700 border-green-200' },
  mid: { label: 'Mid cost', className: 'bg-amber-50 text-amber-700 border-amber-200' },
  high: { label: 'Premium', className: 'bg-rose-50 text-rose-700 border-rose-200' },
  unknown: { label: 'Cost N/A', className: 'bg-gray-50 text-gray-500 border-gray-200' },
};

function formatCost(value: number | undefined): string {
  if (value === undefined || value === null) return 'N/A';
  if (value === 0) return 'Free';
  if (value < 1) return `$${value.toFixed(3)}`;
  if (value < 10) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(1)}`;
}

export function ModelCard({ model, selected = false, onSelect }: ModelCardProps) {
  const band = getCostBand(model);
  const bandStyle = COST_BAND_STYLE[band];
  const isClickable = Boolean(onSelect);

  const handleClick = () => {
    if (onSelect) onSelect(model.id);
  };

  return (
    <div
      role={isClickable ? 'button' : undefined}
      tabIndex={isClickable ? 0 : undefined}
      onClick={isClickable ? handleClick : undefined}
      onKeyDown={
        isClickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handleClick();
              }
            }
          : undefined
      }
      className={`relative rounded-xl border p-4 transition-all ${
        selected
          ? 'border-brand-400 bg-brand-50/50 ring-2 ring-brand-100'
          : 'border-gray-200 bg-white hover:border-gray-300 hover:shadow-sm'
      } ${isClickable ? 'cursor-pointer' : ''}`}
    >
      {selected && (
        <div className="absolute top-3 right-3 w-5 h-5 rounded-full bg-brand-600 text-white flex items-center justify-center">
          <Check className="w-3 h-3" />
        </div>
      )}

      {/* Header */}
      <div className="flex items-start gap-2 pr-7">
        <Cpu className="w-4 h-4 text-brand-500 flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-gray-900 text-sm leading-tight truncate" title={model.label}>
            {model.label}
          </div>
          <div className="mt-0.5 text-[11px] text-gray-500 font-mono truncate" title={model.id}>
            {model.id}
          </div>
        </div>
      </div>

      {/* Provider / family / cost band row */}
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {model.provider && (
          <span className="inline-flex items-center rounded-md border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[10px] font-medium text-gray-700">
            {model.provider}
          </span>
        )}
        {model.family && (
          <span className="inline-flex items-center rounded-md border border-violet-200 bg-violet-50 px-1.5 py-0.5 text-[10px] font-medium text-violet-700">
            {model.family}
          </span>
        )}
        <span
          className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${bandStyle.className}`}
        >
          {bandStyle.label}
        </span>
      </div>

      {/* Capabilities */}
      {model.capabilities && model.capabilities.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1">
          {model.capabilities.map((cap) => (
            <CapabilityBadge key={cap} capability={cap} />
          ))}
        </div>
      )}

      {/* Cost footer */}
      <div className="mt-3 pt-2.5 border-t border-gray-100 flex items-center justify-between text-[11px] text-gray-500">
        <span>
          In: <span className="font-mono text-gray-700">{formatCost(model.cost_per_million_input)}</span>
        </span>
        <span>
          Out: <span className="font-mono text-gray-700">{formatCost(model.cost_per_million_output)}</span>
        </span>
      </div>
    </div>
  );
}
