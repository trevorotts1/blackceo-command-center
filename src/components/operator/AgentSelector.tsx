'use client';

/**
 * AgentSelector
 *
 * Pill-strip picker for choosing which Bridge agent owns the active chat.
 * The strip mirrors the donor's `UnifiedChat` agent switcher but is its own
 * component so the Bridge page can show the picker independently of the
 * message thread (for example: in a sidebar collapsed mode in a future
 * iteration, or in the Call Mode handoff dropdown).
 *
 * The active pill renders with the agent's accent color tinted at 12%
 * alpha for the background and the full accent for the border and label.
 * Inactive pills sit on the standard bcc-border light gray. Hover lifts
 * the border to a slightly darker gray.
 *
 * Disabled state: while a turn is streaming we forbid agent switching so
 * the in-flight reply is never written into the wrong session. The parent
 * Bridge view passes `disabled={streaming}`.
 */

import { BRIDGE_AGENTS, type BridgeAgent } from '@/lib/bridge/agents';

interface Props {
  activeId: string;
  onSelect: (id: string) => void;
  disabled?: boolean;
}

export default function AgentSelector({ activeId, onSelect, disabled }: Props) {
  return (
    <div
      role="tablist"
      aria-label="Choose Bridge agent"
      className="flex flex-wrap items-center gap-1.5"
    >
      {BRIDGE_AGENTS.map((agent) => (
        <AgentPill
          key={agent.id}
          agent={agent}
          active={activeId === agent.id}
          disabled={disabled}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function AgentPill({
  agent,
  active,
  disabled,
  onSelect,
}: {
  agent: BridgeAgent;
  active: boolean;
  disabled?: boolean;
  onSelect: (id: string) => void;
}) {
  const accent = agent.accent;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      title={agent.description}
      disabled={disabled}
      onClick={() => onSelect(agent.id)}
      className="group flex items-center gap-2 px-3 py-1.5 rounded-full border text-[12.5px] font-medium transition disabled:opacity-50 disabled:cursor-not-allowed"
      style={{
        background: active ? `${accent}1f` : '#FFFFFF',
        borderColor: active ? accent : '#E5E7EB',
        color: active ? '#1A1D26' : '#6B7280',
      }}
    >
      <span
        className="w-2.5 h-2.5 rounded-full"
        style={{ background: accent, opacity: active ? 1 : 0.55 }}
        aria-hidden="true"
      />
      <span>{agent.label}</span>
    </button>
  );
}
