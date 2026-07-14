'use client';

/**
 * AgentPicker (U60 / JM-U63f)
 *
 * List-only (spec (f)): populated from `GET /api/agents`, with a Master badge
 * on rows where `is_master` is true. Phase A never lets the user actually
 * switch which agent the chat talks to (U65 gates live agent-switch on the
 * U64 S2 gateway spike) — disabled trigger, honest tooltip "Direct agent chat
 * is coming".
 *
 * `GET /api/agents` now returns the enveloped `{ agents: [...] }` shape
 * (U56, E.2 / JM-U52) — resolution runs through `resolveMasterAgent()`
 * (pure, `unwrapAgents()`-backed — never a bare-array assumption) so
 * resolution keeps working post-envelope; `onResolved` always fires (with
 * `null` when the list is empty), matching pre-U56 behavior.
 */
import { useEffect, useState } from 'react';
import { Users } from 'lucide-react';
import ControlPill from '@/components/ui/ControlPill';
import { resolveMasterAgent } from './resolveMasterAgent';
import type { AgentOption } from './types';

interface AgentPickerProps {
  onResolved: (agent: AgentOption | null) => void;
}

export default function AgentPicker({ onResolved }: AgentPickerProps) {
  const [agent, setAgent] = useState<AgentOption | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch('/api/agents', { cache: 'no-store' });
        if (!res.ok) return;
        const master = resolveMasterAgent(await res.json());
        if (cancelled) return;
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
    <ControlPill
      icon={Users}
      label={agent ? `${agent.avatar_emoji ?? ''} ${agent.name}`.trim() : 'Agent'}
      disabled
      title="Direct agent chat is coming"
      data-testid="control-agent-picker"
    />
  );
}
