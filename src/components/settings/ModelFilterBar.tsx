'use client';

import { useMemo } from 'react';
import { Search, X, Archive } from 'lucide-react';
import { CapabilityBadge } from './CapabilityBadge';
import type { Capability } from './CapabilityBadge';
import type { ModelCardData, CostBand } from './ModelCard';
import { getCostBand } from './ModelCard';

/**
 * Capability category grouping for the filter bar UI.
 *
 * The canonical 16-tag vocabulary lives in `src/lib/model-providers/types.ts`
 * and `src/lib/model-registry.ts` (kept in sync at commit f9c736d). The
 * grouping below is purely a UI affordance per v4.0.1 P2-15 so operators
 * can scan capabilities by intent instead of one long flat row. Every tag
 * in the canonical list MUST appear in exactly one category here; if a
 * new tag is added upstream, also add it to one of the four groups below
 * or the filter chip will silently disappear from the UI.
 */
const CAPABILITY_GROUPS: { label: string; capabilities: Capability[] }[] = [
  {
    label: 'Input modalities',
    capabilities: ['text', 'vision', 'audio_input'],
  },
  {
    label: 'Output modalities',
    capabilities: [
      'image_generation',
      'video_generation',
      'audio_generation',
      'audio_transcription',
    ],
  },
  {
    label: 'Capabilities',
    capabilities: [
      'tool_use',
      'reasoning',
      'streaming',
      'structured_output',
      'long_context',
      'code_execution',
      'computer_use',
      'web_search',
    ],
  },
  {
    label: 'Other',
    capabilities: ['embeddings'],
  },
];

/**
 * ModelFilterBar - multi-axis filter UI for the model catalog browser.
 *
 * Filters available:
 *   - Provider chips (derived from the loaded model list)
 *   - Capability chips (fixed registry vocabulary from PRD Section 5.1)
 *   - Cost band chips (free / low / mid / high)
 *   - Text search across label, model id, and family
 *
 * Filter state is fully controlled by the parent. The parent owns the
 * model list and applies `applyModelFilters` to produce the visible subset.
 */

export interface ModelFilterState {
  query: string;
  providers: string[];
  capabilities: string[];
  costBands: CostBand[];
  /**
   * D14 (Decision D-HL-5) — opt-in "Show deprecated/stale" toggle. Default
   * `false`: deprecated/unavailable rows stay excluded from the browser AND
   * from the per-card assignment actions (see `ModelCard`'s own `deprecated`
   * gate), exactly as before this unit. When `true`, those rows are included
   * and rendered with a visible "Deprecated" badge — inspectable, never
   * assignable.
   */
  showDeprecated: boolean;
}

export const EMPTY_FILTER_STATE: ModelFilterState = {
  query: '',
  providers: [],
  capabilities: [],
  costBands: [],
  showDeprecated: false,
};

/** Statuses hidden from the default view; only shown when `showDeprecated`. */
const STALE_STATUSES = new Set(['deprecated', 'unavailable']);

const COST_BANDS: { id: CostBand; label: string }[] = [
  { id: 'free', label: 'Free' },
  { id: 'low', label: 'Low cost' },
  { id: 'mid', label: 'Mid cost' },
  { id: 'high', label: 'Premium' },
];

interface ModelFilterBarProps {
  models: ModelCardData[];
  state: ModelFilterState;
  onChange: (next: ModelFilterState) => void;
  visibleCount?: number;
}

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/**
 * Map a provider slug to its user-facing display label. Slugs themselves
 * are stable DB keys (e.g. `xai`); UI surfaces should render the friendlier
 * label when one exists. Slug stays unchanged for DB and API contracts.
 */
const PROVIDER_DISPLAY_LABELS: Record<string, string> = {
  xai: 'xAI (Grok)',
};

export function formatProviderLabel(slug: string): string {
  return PROVIDER_DISPLAY_LABELS[slug] ?? slug;
}

export function ModelFilterBar({ models, state, onChange, visibleCount }: ModelFilterBarProps) {
  const providers = useMemo(() => {
    const set = new Set<string>();
    for (const m of models) {
      if (m.provider) set.add(m.provider);
    }
    return Array.from(set).sort();
  }, [models]);

  const hasAnyFilter =
    state.query.length > 0 ||
    state.providers.length > 0 ||
    state.capabilities.length > 0 ||
    state.costBands.length > 0 ||
    state.showDeprecated;

  return (
    // U50/H+L.8 — sticky above the model grid (D-HL-5 / PRD discoverability
    // gap): the container previously scrolled away over a multi-hundred-row
    // catalog. `top-0` pins it to the viewport once its own scroll position
    // reaches the top; `z-20` keeps it above the card grid beneath it.
    <div className="sticky top-0 z-20 bg-white border border-gray-200 rounded-xl shadow-sm">
      {/* Search + summary */}
      <div className="px-4 py-3 flex items-center gap-3 flex-wrap border-b border-gray-100">
        <div className="w-full sm:flex-1 sm:min-w-[200px] relative">
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="search"
            value={state.query}
            onChange={(e) => onChange({ ...state, query: e.target.value })}
            placeholder="Search models by name, id, or family"
            className="w-full pl-9 pr-3 py-1.5 text-sm bg-gray-50 border border-gray-200 rounded-lg focus:bg-white focus:ring-2 focus:ring-brand-500 focus:border-transparent focus:outline-none"
          />
        </div>
        <div className="text-xs text-gray-500">
          Showing{' '}
          <span className="font-semibold text-gray-700">{visibleCount ?? models.length}</span>{' '}
          of <span className="font-semibold text-gray-700">{models.length}</span> models
        </div>
        {/* D14 (D-HL-5) — opt-in deprecated/stale visibility toggle. Explicitly
            NOT a new search interface; it lives inside the existing filter bar
            per the ratified decision. Default off. */}
        <label className="inline-flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-gray-600 hover:text-gray-900 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={state.showDeprecated}
            onChange={(e) => onChange({ ...state, showDeprecated: e.target.checked })}
            className="w-3.5 h-3.5 rounded border-gray-300 text-brand-600 focus:ring-brand-400"
          />
          <Archive className="w-3.5 h-3.5" />
          Show deprecated/stale
        </label>
        {hasAnyFilter && (
          <button
            type="button"
            onClick={() => onChange(EMPTY_FILTER_STATE)}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-md transition-colors"
          >
            <X className="w-3 h-3" />
            Clear filters
          </button>
        )}
      </div>

      {/* Provider chips */}
      {providers.length > 0 && (
        <FilterRow label="Provider">
          {providers.map((p) => (
            <Chip
              key={p}
              active={state.providers.includes(p)}
              onClick={() => onChange({ ...state, providers: toggle(state.providers, p) })}
            >
              {formatProviderLabel(p)}
            </Chip>
          ))}
        </FilterRow>
      )}

      {/* Capability chips, grouped into 4 categories per v4.0.1 P2-15 */}
      <div className="border-b border-gray-100">
        <div className="px-4 pt-2.5 pb-1 flex items-center gap-3">
          <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider w-20 flex-shrink-0">
            Capability
          </span>
        </div>
        <div className="px-4 pb-2.5 pl-[104px] flex flex-col gap-2">
          {CAPABILITY_GROUPS.map((group) => (
            <div key={group.label} className="flex items-center gap-3 flex-wrap">
              <span className="text-[10px] font-medium text-gray-400 uppercase tracking-wide w-28 flex-shrink-0">
                {group.label}
              </span>
              <div className="flex items-center gap-1.5 flex-wrap">
                {group.capabilities.map((cap) => {
                  const active = state.capabilities.includes(cap);
                  return (
                    <button
                      key={cap}
                      type="button"
                      onClick={() =>
                        onChange({ ...state, capabilities: toggle(state.capabilities, cap) })
                      }
                      className={`rounded-full transition-all ${
                        active
                          ? 'ring-2 ring-brand-400 ring-offset-1'
                          : 'opacity-70 hover:opacity-100'
                      }`}
                    >
                      <CapabilityBadge capability={cap} size="md" />
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Cost band chips */}
      <FilterRow label="Cost band" lastRow>
        {COST_BANDS.map((b) => (
          <Chip
            key={b.id}
            active={state.costBands.includes(b.id)}
            onClick={() => onChange({ ...state, costBands: toggle(state.costBands, b.id) })}
          >
            {b.label}
          </Chip>
        ))}
      </FilterRow>
    </div>
  );
}

function FilterRow({
  label,
  children,
  lastRow,
}: {
  label: string;
  children: React.ReactNode;
  lastRow?: boolean;
}) {
  return (
    <div className={`px-4 py-2.5 flex items-center gap-3 flex-wrap ${lastRow ? '' : 'border-b border-gray-100'}`}>
      <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider w-20 flex-shrink-0">
        {label}
      </span>
      <div className="flex items-center gap-1.5 flex-wrap">{children}</div>
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
        active
          ? 'bg-brand-600 text-white border-brand-600'
          : 'bg-white text-gray-700 border-gray-200 hover:border-brand-300 hover:bg-brand-50'
      }`}
    >
      {children}
    </button>
  );
}

/**
 * Pure filter function exported for the page to apply against its full
 * model list. Keeping this pure makes it cheap to memoize on the consumer
 * side and trivial to unit-test.
 */
export function applyModelFilters(
  models: ModelCardData[],
  state: ModelFilterState
): ModelCardData[] {
  const query = state.query.trim().toLowerCase();
  return models.filter((m) => {
    // D14 (D-HL-5) — deprecated/unavailable rows stay excluded from the
    // default view (and therefore from the per-card assign actions, since
    // hidden rows never render a card at all) unless the operator opts in.
    if (!state.showDeprecated && m.status && STALE_STATUSES.has(m.status)) {
      return false;
    }
    if (state.providers.length > 0 && (!m.provider || !state.providers.includes(m.provider))) {
      return false;
    }
    if (state.capabilities.length > 0) {
      const caps = m.capabilities ?? [];
      const ok = state.capabilities.every((needed) => caps.includes(needed));
      if (!ok) return false;
    }
    if (state.costBands.length > 0) {
      const band = getCostBand(m);
      if (!state.costBands.includes(band)) return false;
    }
    if (query) {
      const hay = `${m.label} ${m.id} ${m.family ?? ''}`.toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  });
}
