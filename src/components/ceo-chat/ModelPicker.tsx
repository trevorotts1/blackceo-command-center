'use client';

/**
 * ModelPicker (U60 / JM-U63f)
 *
 * List-only (spec (f)): fetches `GET /api/models` (the dynamic registry) and
 * `GET /api/openclaw/models` (for the box-wide default), runs the result
 * through `filterModels()` (isForbidden — no Anthropic-prefixed model ever
 * listed), and renders the result. Phase A never lets the user actually
 * SWITCH the live model (U65 gates that on the U64 gateway spike) — the
 * trigger is disabled and carries the honest tooltip "Model is set box-wide
 * for now" per spec (f). The picker still exists and is populated so U65 has
 * a real UI to wire live, and so the ContextMeter has a real context_window
 * to read from the currently-selected (box-default) row.
 */
import { useEffect, useState } from 'react';
import { Cpu } from 'lucide-react';
import ControlPill from '@/components/ui/ControlPill';
import { filterModels } from './filterModels';
import type { ModelOption } from './types';

interface ModelPickerProps {
  onResolved: (model: ModelOption | null) => void;
}

export default function ModelPicker({ onResolved }: ModelPickerProps) {
  const [model, setModel] = useState<ModelOption | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [registryRes, defaultRes] = await Promise.all([
          fetch('/api/models', { cache: 'no-store' }),
          fetch('/api/openclaw/models', { cache: 'no-store' }),
        ]);
        const registry = registryRes.ok ? await registryRes.json() : { models: [] };
        const defaults = defaultRes.ok ? await defaultRes.json() : {};
        const options: ModelOption[] = filterModels(
          (registry.models ?? []).map((m: { model_id: string; label: string; provider: string; context_window: number | null; capabilities?: string[] }) => ({
            model_id: m.model_id,
            label: m.label,
            provider: m.provider,
            context_window: m.context_window ?? null,
            capabilities: m.capabilities ?? [],
          })),
        );
        if (cancelled) return;
        const defaultId: string | undefined = defaults.defaultModel;
        const resolved = (defaultId && options.find((o) => o.model_id === defaultId)) || options[0] || null;
        setModel(resolved);
        onResolved(resolved);
      } catch {
        if (!cancelled) onResolved(null);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <ControlPill
      icon={Cpu}
      label={model ? model.label : 'Model'}
      disabled
      title="Model is set box-wide for now"
      data-testid="control-model-picker"
    />
  );
}
