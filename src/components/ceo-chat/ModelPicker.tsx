'use client';

/**
 * ModelPicker (U60 / JM-U63f, LIVE as of U62 / JM-U65)
 *
 * Fetches `GET /api/models` (the dynamic registry) and `GET /api/openclaw/
 * models` (for the box-wide default), runs the result through
 * `filterModels()` (isForbidden — no Anthropic-prefixed model ever listed —
 * unchanged), and auto-resolves the default on mount exactly as Phase A did
 * (`onResolved` fires once at mount so the ContextMeter always has a real
 * `context_window`, even before the user ever opens the picker).
 *
 * U62/U65: the trigger now OPENS a real dropdown (PickerMenu). Picking a
 * DIFFERENT model fires `onResolved` again (same callback the mount-time
 * auto-resolve uses, so ContextMeter's denominator updates immediately) AND
 * `onUserChange` (a SEPARATE callback that fires ONLY on an explicit user
 * pick — never on the mount-time auto-resolve) so the caller can insert
 * exactly one system chip per real switch, never one on first load.
 *
 * `disabled` is now a real per-render prop (streaming lock — "switching
 * locked mid-stream", spec M.3) rather than a permanent Phase-A state; when
 * disabled the trigger still renders (never vanishes) with `disabledReason`
 * as its honest tooltip, matching the "honest degraded control" rule.
 */
import { useEffect, useState } from 'react';
import { Cpu } from 'lucide-react';
import ControlPill from '@/components/ui/ControlPill';
import PickerMenu from '@/components/ui/PickerMenu';
import { filterModels } from './filterModels';
import type { ModelOption } from './types';

interface ModelPickerProps {
  onResolved: (model: ModelOption | null) => void;
  /** Fires ONLY on an explicit user pick from the open dropdown — never on
   *  the mount-time auto-resolve. Lets the caller insert exactly one system
   *  chip per real switch (BINARY acceptance: "model mid-thread change
   *  inserts exactly one system chip and updates the denominator"). */
  onUserChange?: (model: ModelOption) => void;
  disabled?: boolean;
  disabledReason?: string;
}

export default function ModelPicker({ onResolved, onUserChange, disabled = false, disabledReason }: ModelPickerProps) {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [model, setModel] = useState<ModelOption | null>(null);
  const [open, setOpen] = useState(false);

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
        setModels(options);
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
    <div className="relative">
      <ControlPill
        icon={Cpu}
        label={model ? model.label : 'Model'}
        disabled={disabled}
        title={disabled ? disabledReason : 'Choose the model for this conversation'}
        onClick={() => setOpen((o) => !o)}
        data-testid="control-model-picker"
      />
      <PickerMenu
        open={open && !disabled}
        onClose={() => setOpen(false)}
        selectedId={model?.model_id ?? null}
        items={models.map((m) => ({ id: m.model_id, label: m.label, sublabel: m.provider }))}
        onSelect={(id) => {
          const picked = models.find((m) => m.model_id === id) ?? null;
          if (!picked) return;
          setModel(picked);
          onResolved(picked);
          onUserChange?.(picked);
        }}
        emptyLabel="No models available."
        data-testid="control-model-picker-menu"
      />
    </div>
  );
}
