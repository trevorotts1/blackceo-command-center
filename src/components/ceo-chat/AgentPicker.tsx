'use client';

/**
 * AgentPicker (U60 / JM-U63f, LIVE as of U62 / JM-U65)
 *
 * Populated from `GET /api/agents`, with a Master badge on rows where
 * `is_master` is true. `GET /api/agents` returns the enveloped
 * `{ agents: [...] }` shape (U56, E.2 / JM-U52) — resolution runs through
 * `unwrapAgents()` (never a bare-array assumption); the mount-time default
 * still resolves via `resolveMasterAgent()` exactly as Phase A did.
 *
 * U62/U65 (U61/S2-proven addressing): the trigger now OPENS a real dropdown
 * listing every agent. Picking a DIFFERENT agent fires `onResolved` again
 * AND `onUserChange` (fires ONLY on an explicit user pick, never on the
 * mount-time auto-resolve) so the caller can insert exactly one divider/
 * system chip per real switch and rebuild the gateway session `key` for
 * that agent (`gateway.ts`'s `agent:<agentId>:<peer>` — a genuinely
 * separate, non-interleaved thread). `disabled` locks the trigger mid-
 * stream ("switching locked mid-stream", spec M.3) with an honest tooltip —
 * never a silently-vanished control.
 */
import { useEffect, useState } from 'react';
import { Users } from 'lucide-react';
import ControlPill from '@/components/ui/ControlPill';
import PickerMenu from '@/components/ui/PickerMenu';
import { unwrapAgents } from '@/lib/api-envelope';
import { resolveMasterAgent } from './resolveMasterAgent';
import type { AgentOption } from './types';

interface AgentPickerProps {
  onResolved: (agent: AgentOption | null) => void;
  /** Fires ONLY on an explicit user pick from the open dropdown — never on
   *  the mount-time auto-resolve. */
  onUserChange?: (agent: AgentOption) => void;
  disabled?: boolean;
  disabledReason?: string;
}

export default function AgentPicker({ onResolved, onUserChange, disabled = false, disabledReason }: AgentPickerProps) {
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [agent, setAgent] = useState<AgentOption | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch('/api/agents', { cache: 'no-store' });
        if (!res.ok) return;
        const payload = await res.json();
        const all = unwrapAgents<AgentOption>(payload);
        const master = resolveMasterAgent(payload);
        if (cancelled) return;
        setAgents(all);
        setAgent(master);
        onResolved(master);
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
        icon={Users}
        label={agent ? `${agent.avatar_emoji ?? ''} ${agent.name}`.trim() : 'Agent'}
        disabled={disabled}
        title={disabled ? disabledReason : 'Choose which agent this conversation talks to'}
        onClick={() => setOpen((o) => !o)}
        data-testid="control-agent-picker"
      />
      <PickerMenu
        open={open && !disabled}
        onClose={() => setOpen(false)}
        selectedId={agent?.id ?? null}
        items={agents.map((a) => ({
          id: a.id,
          label: `${a.avatar_emoji ?? ''} ${a.name}`.trim(),
          badge: a.is_master ? 'Master' : undefined,
        }))}
        onSelect={(id) => {
          const picked = agents.find((a) => a.id === id) ?? null;
          if (!picked) return;
          setAgent(picked);
          onResolved(picked);
          onUserChange?.(picked);
        }}
        emptyLabel="No agents available."
        data-testid="control-agent-picker-menu"
      />
    </div>
  );
}
