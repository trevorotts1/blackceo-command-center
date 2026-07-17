'use client';

/**
 * ThinkingSelector (U60 / JM-U63f, LIVE as of U62 / JM-U65)
 *
 * Quick · Balanced · Deep · Max — the U61/S1 gateway spike PASSed with the
 * accepted-and-landing set for the default model being exactly
 * {off, low, medium, high} (see `@/lib/ceo-chat/thinking-level`), so this
 * control is no longer permanently disabled. `disabled` is now a per-render
 * prop the caller sets for two REAL reasons: streaming is in flight ("all
 * controls disable from first streamed token until done/gateway_down" —
 * spec M.3 acceptance), or the currently-active model lacks the `reasoning`
 * capability tag in the registry — either way, `disabledReason` carries the
 * honest, specific tooltip (never a generic "coming soon" once the control
 * IS live) so the degraded state is always explained, never silently absent.
 */
import SegmentedControl from '@/components/ui/SegmentedControl';
import { THINKING_LEVELS, type ThinkingLevel } from './types';

interface ThinkingSelectorProps {
  value: ThinkingLevel;
  onChange: (level: ThinkingLevel) => void;
  disabled?: boolean;
  disabledReason?: string;
}

export default function ThinkingSelector({ value, onChange, disabled = false, disabledReason }: ThinkingSelectorProps) {
  const segments = THINKING_LEVELS.map((label) => ({
    id: label,
    label,
    disabled,
    title: disabled ? disabledReason : undefined,
  }));

  return (
    <SegmentedControl
      segments={segments}
      value={value}
      onChange={(id) => onChange(id as ThinkingLevel)}
      data-testid="control-thinking-selector"
    />
  );
}
