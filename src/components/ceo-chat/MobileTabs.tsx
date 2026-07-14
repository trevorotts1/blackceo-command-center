'use client';

/**
 * MobileTabs (U60 / JM-U63g)
 *
 * The mobile/tablet `Conversation | What's happening (n)` segmented tab
 * switch (spec (g)) — below `lg` the chat and the Operations Rail are two
 * tabs instead of a side-by-side split, so neither is ever squeezed under a
 * usable width.
 */
import SegmentedControl from '@/components/ui/SegmentedControl';
import type { MobileTab } from './types';

interface MobileTabsProps {
  value: MobileTab;
  onChange: (tab: MobileTab) => void;
  happeningCount: number;
}

export default function MobileTabs({ value, onChange, happeningCount }: MobileTabsProps) {
  return (
    <div className="lg:hidden px-4 py-2 border-b border-bcc-border bg-bcc-white">
      <SegmentedControl
        data-testid="mobile-tabs"
        value={value}
        onChange={(id) => onChange(id as MobileTab)}
        segments={[
          { id: 'conversation', label: 'Conversation' },
          { id: 'happening', label: `What's happening${happeningCount ? ` (${happeningCount})` : ''}` },
        ]}
      />
    </div>
  );
}
