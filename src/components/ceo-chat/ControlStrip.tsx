'use client';

/**
 * ControlStrip (U60 / JM-U63a/f; U62 / JM-U65 wires the three controls LIVE)
 *
 * Desktop: a slim row — agent switcher · model selector · thinking-level
 * segmented control · Delegate button (M.2 design direction).
 * Mobile/tablet (< lg): consolidates the three pickers into ONE "Tune" bottom
 * sheet trigger (spec (g)); the Delegate button stays directly tappable
 * outside the sheet since it is the primary action, not a setting.
 *
 * U62: every prop below is a pure passthrough to the picker it belongs to —
 * this component makes no decisions of its own (the mount-vs-user-change
 * distinction, the chip insertion, and the disabled/reason computation all
 * live in the page/hook, which owns the transcript and the streaming state).
 * That keeps this component testable-by-inspection: if a prop isn't wired
 * here, the picker below it is provably inert no matter what the page does.
 */
import { useState } from 'react';
import { SlidersHorizontal, Send as DelegateIcon } from 'lucide-react';
import ControlPill from '@/components/ui/ControlPill';
import BottomSheet from '@/components/ui/BottomSheet';
import AgentPicker from './AgentPicker';
import ModelPicker from './ModelPicker';
import ThinkingSelector from './ThinkingSelector';
import type { AgentOption, ModelOption, ThinkingLevel } from './types';

interface ControlStripProps {
  onAgentResolved: (a: AgentOption | null) => void;
  onAgentUserChange?: (a: AgentOption) => void;
  agentDisabled?: boolean;
  agentDisabledReason?: string;

  onModelResolved: (m: ModelOption | null) => void;
  onModelUserChange?: (m: ModelOption) => void;
  modelDisabled?: boolean;
  modelDisabledReason?: string;

  thinkingLevel: ThinkingLevel;
  onThinkingLevelChange: (level: ThinkingLevel) => void;
  thinkingDisabled?: boolean;
  thinkingDisabledReason?: string;

  onOpenDelegate: () => void;
}

export default function ControlStrip({
  onAgentResolved,
  onAgentUserChange,
  agentDisabled,
  agentDisabledReason,
  onModelResolved,
  onModelUserChange,
  modelDisabled,
  modelDisabledReason,
  thinkingLevel,
  onThinkingLevelChange,
  thinkingDisabled,
  thinkingDisabledReason,
  onOpenDelegate,
}: ControlStripProps) {
  const [tuneOpen, setTuneOpen] = useState(false);

  return (
    <div className="flex items-center gap-2 px-4 sm:px-6 py-2 border-b border-bcc-border bg-bcc-white">
      {/* Desktop: full strip. */}
      <div className="hidden lg:flex items-center gap-2">
        <AgentPicker
          onResolved={onAgentResolved}
          onUserChange={onAgentUserChange}
          disabled={agentDisabled}
          disabledReason={agentDisabledReason}
        />
        <ModelPicker
          onResolved={onModelResolved}
          onUserChange={onModelUserChange}
          disabled={modelDisabled}
          disabledReason={modelDisabledReason}
        />
        <ThinkingSelector
          value={thinkingLevel}
          onChange={onThinkingLevelChange}
          disabled={thinkingDisabled}
          disabledReason={thinkingDisabledReason}
        />
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
            <AgentPicker
              onResolved={onAgentResolved}
              onUserChange={onAgentUserChange}
              disabled={agentDisabled}
              disabledReason={agentDisabledReason}
            />
          </div>
          <div>
            <p className="text-label text-bcc-text-secondary mb-1.5">Model</p>
            <ModelPicker
              onResolved={onModelResolved}
              onUserChange={onModelUserChange}
              disabled={modelDisabled}
              disabledReason={modelDisabledReason}
            />
          </div>
          <div>
            <p className="text-label text-bcc-text-secondary mb-1.5">Thinking level</p>
            <ThinkingSelector
              value={thinkingLevel}
              onChange={onThinkingLevelChange}
              disabled={thinkingDisabled}
              disabledReason={thinkingDisabledReason}
            />
          </div>
        </div>
      </BottomSheet>
    </div>
  );
}
