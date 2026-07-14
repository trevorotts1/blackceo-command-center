'use client';

/**
 * OperationsRail (U60 / JM-U63c)
 *
 * The right-hand "What's happening" activity window, rebuilt as a live
 * delegation timeline. Wires `useOperationsRailEvents` to the existing SSE bus
 * (new broadcast emit points in trust-engine.ts publish a `ceo_chat_task_status`
 * event on every report-back) so a server-side status flip appears within ~2s
 * without a page refresh; the 15-second poll in useCeoChatSession is the
 * silent fallback when the stream is blocked — the live dot simply goes dark,
 * never an error state.
 */
import { Activity } from 'lucide-react';
import TaskTimelineCard from './TaskTimelineCard';
import { useOperationsRailEvents } from './useOperationsRailEvents';
import type { ChatMessage, SpawnedTask } from './types';

interface OperationsRailProps {
  tasks: SpawnedTask[];
  messages: ChatMessage[];
  onRefresh: () => void;
  resolvedByMap: Record<string, string>;
}

export default function OperationsRail({ tasks, messages, onRefresh, resolvedByMap }: OperationsRailProps) {
  const { live } = useOperationsRailEvents(onRefresh);

  return (
    <div data-testid="operations-rail">
      <div className="flex items-center gap-2 mb-3 text-bcc-text">
        <Activity className="w-4 h-4 text-brand-600" />
        <h2 className="font-semibold text-label">What&apos;s happening</h2>
        <span
          className={`ml-auto w-1.5 h-1.5 rounded-full ${live ? 'bg-brand-500 animate-pulse' : 'bg-bcc-border'}`}
          title={live ? 'Live' : 'Reconnecting…'}
          data-testid="ops-rail-live-dot"
        />
      </div>

      {tasks.length === 0 ? (
        <p className="text-label text-bcc-text-muted" data-testid="ops-rail-empty">
          Tasks your AI CEO starts from this chat — or you delegate directly — show up here with live status.
        </p>
      ) : (
        <ul className="space-y-2">
          {tasks.map((t) => (
            <TaskTimelineCard
              key={t.id}
              task={t}
              trustMessages={messages.filter((m) => m.role === 'trust' && m.task_id === t.id)}
              resolvedBy={resolvedByMap[t.id]}
              live={live}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
