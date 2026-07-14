'use client';

/**
 * ControlStrip (U60 / JM-U63a/f)
 *
 * Desktop: a slim row — agent switcher · model selector · thinking-level
 * segmented control · Delegate button (M.2 design direction).
 * Mobile/tablet (< lg): consolidates the three pickers into ONE "Tune" bottom
 * sheet trigger (spec (g)); the Delegate button stays directly tappable
 * outside the sheet since it is the primary action, not a setting.
 */
import { useState } from 'react';
import { SlidersHorizontal, Send as DelegateIcon } from 'lucide-react';
import ControlPill from '@/components/ui/ControlPill';
import BottomSheet from '@/components/ui/BottomSheet';
import AgentPicker from './AgentPicker';
import ModelPicker from './ModelPicker';
import ThinkingSelector from './ThinkingSelector';
import type { AgentOption, ModelOption } from './types';

interface ControlStripProps {
  onAgentResolved: (a: AgentOption | null) => void;
  onModelResolved: (m: ModelOption | null) => void;
  onOpenDelegate: () => void;
}

export default function ControlStrip({ onAgentResolved, onModelResolved, onOpenDelegate }: ControlStripProps) {
  const [tuneOpen, setTuneOpen] = useState(false);

  return (
    <div className="flex items-center gap-2 px-4 sm:px-6 py-2 border-b border-bcc-border bg-bcc-white">
      {/* Desktop: full strip. */}
      <div className="hidden lg:flex items-center gap-2">
        <AgentPicker onResolved={onAgentResolved} />
        <ModelPicker onResolved={onModelResolved} />
        <ThinkingSelector />
      </div>

      {/* Mobile/tablet: one Tune trigger consolidates the three pickers. */}
      <div className="lg:hidden">
        <ControlPill
          icon={SlidersHorizontal}
          label="Tune"
          onClick={() => setTuneOpen(true)}
          data-testid="control-tune-trigger"
        />
      </div>

      <button
        type="button"
        onClick={onOpenDelegate}
        className="ml-auto inline-flex items-center gap-1.5 h-9 px-3 rounded-xl bg-brand-600 text-white text-label font-medium hover:bg-brand-700 shrink-0"
        data-testid="control-delegate-button"
      >
        <DelegateIcon className="w-3.5 h-3.5" />
        Delegate
      </button>

      <BottomSheet open={tuneOpen} onClose={() => setTuneOpen(false)} title="Tune this conversation" data-testid="tune-sheet">
        <div className="space-y-4">
          <div>
            <p className="text-label text-bcc-text-secondary mb-1.5">Agent</p>
            <AgentPicker onResolved={onAgentResolved} />
          </div>
          <div>
            <p className="text-label text-bcc-text-secondary mb-1.5">Model</p>
            <ModelPicker onResolved={onModelResolved} />
          </div>
          <div>
            <p className="text-label text-bcc-text-secondary mb-1.5">Thinking level</p>
            <ThinkingSelector />
          </div>
        </div>
      </BottomSheet>
    </div>
  );
}
