'use client';

/**
 * ThinkingSelector (U60 / JM-U63f)
 *
 * Quick · Balanced · Deep · Max — rendered but read-only pending U64's gateway
 * spike S1 (does the gateway honor a reasoning-effort parameter, and what are
 * the accepted values?). Every segment is disabled with the honest tooltip so
 * the control is visibly present (not silently missing) without claiming a
 * live effect it cannot yet have.
 */
import SegmentedControl from '@/components/ui/SegmentedControl';
import { THINKING_LEVELS } from './types';

export default function ThinkingSelector() {
  const segments = THINKING_LEVELS.map((label) => ({
    id: label,
    label,
    disabled: true,
    title: 'Thinking-level control is pending a gateway capability check (coming soon)',
  }));

  return (
    <SegmentedControl
      segments={segments}
      value="Balanced"
      onChange={() => {}}
      data-testid="control-thinking-selector"
    />
  );
}
