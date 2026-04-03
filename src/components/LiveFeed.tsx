'use client';

import { useState } from 'react';
import { ChevronRight, ChevronLeft, Clock } from 'lucide-react';
import { useMissionControl } from '@/lib/store';
import type { Event } from '@/lib/types';
import { formatDistanceToNow } from 'date-fns';

type FeedFilter = 'all' | 'tasks' | 'agents';

export function LiveFeed() {
  const { events } = useMissionControl();
  const [filter, setFilter] = useState<FeedFilter>('all');
  const [isMinimized, setIsMinimized] = useState(false);

  const toggleMinimize = () => setIsMinimized(!isMinimized);

  const filteredEvents = events.filter((event) => {
    if (filter === 'all') return true;
    if (filter === 'tasks')
      return ['task_created', 'task_assigned', 'task_status_changed', 'task_completed'].includes(
        event.type
      );
    if (filter === 'agents')
      return ['agent_joined', 'agent_status_changed', 'message_sent'].includes(event.type);
    return true;
  });

  const getEventIcon = (type: string) => {
    switch (type) {
      case 'task_created':
        return '📋';
      case 'task_assigned':
        return '👤';
      case 'task_status_changed':
        return '🔄';
      case 'task_completed':
        return '✅';
      case 'message_sent':
        return '💬';
      case 'agent_joined':
        return '🎉';
      case 'agent_status_changed':
        return '🔔';
      case 'system':
        return '⚙️';
      default:
        return '📌';
    }
  };

  const getEventColor = (type: string) => {
    switch (type) {
      case 'task_completed':
        return 'text-mc-accent-green';
      case 'task_created':
        return 'text-mc-accent-pink';
      case 'task_assigned':
        return 'text-mc-accent-yellow';
      case 'message_sent':
        return 'text-mc-accent';
      case 'agent_joined':
        return 'text-mc-accent-cyan';
      default:
        return 'text-mc-text-secondary';
    }
  };

  return (
    <aside
      className={`bg-white border-l border-gray-200 flex flex-col transition-all duration-300 ease-in-out ${
        isMinimized ? 'w-12' : 'w-80'
      }`}
    >
      {/* Header */}
      <div className="p-3 border-b border-gray-100">
        <div className="flex items-center">
          <button
            onClick={toggleMinimize}
            className="flex h-10 w-10 items-center justify-center rounded text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700"
            aria-label={isMinimized ? 'Expand feed' : 'Minimize feed'}
          >
            {isMinimized ? (
              <ChevronLeft className="w-4 h-4" />
            ) : (
              <ChevronRight className="w-4 h-4" />
            )}
          </button>
          {!isMinimized && (
            <span className="text-sm font-semibold text-gray-900 ml-1">Live Feed</span>
          )}
        </div>

        {/* Filter Tabs */}
        {!isMinimized && (
          <div className="flex gap-1 mt-3">
            {(['all', 'tasks', 'agents'] as FeedFilter[]).map((tab) => (
              <button
                key={tab}
                onClick={() => setFilter(tab)}
                className={`min-h-[40px] rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  filter === tab
                    ? 'bg-brand-600 text-white'
                    : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                }`}
              >
                {tab.toUpperCase()}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Events List */}
      {!isMinimized && (
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {filteredEvents.length === 0 ? (
            <div className="text-center py-8 text-gray-400 text-sm">
              No events yet
            </div>
          ) : (
            filteredEvents.map((event) => (
              <EventItem key={event.id} event={event} />
            ))
          )}
        </div>
      )}
    </aside>
  );
}

function EventItem({ event }: { event: Event }) {
  const getEventDot = (type: string) => {
    switch (type) {
      case 'task_created':
        return 'bg-blue-500';
      case 'task_assigned':
        return 'bg-brand-500';
      case 'task_status_changed':
        return 'bg-amber-500';
      case 'task_completed':
        return 'bg-emerald-500';
      case 'message_sent':
        return 'bg-brand-500';
      case 'agent_joined':
        return 'bg-cyan-500';
      case 'agent_status_changed':
        return 'bg-orange-500';
      case 'system':
        return 'bg-gray-500';
      default:
        return 'bg-gray-400';
    }
  };

  const isHighlight = event.type === 'task_created' || event.type === 'task_completed';

  return (
    <div
      className={`p-2.5 rounded-lg animate-slide-in transition-colors ${
        isHighlight
          ? 'bg-brand-50 border border-brand-100'
          : 'hover:bg-gray-50'
      }`}
    >
      <div className="flex items-start gap-2.5">
        <span className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${getEventDot(event.type)}`} />
        <div className="flex-1 min-w-0">
          <p className="text-sm text-gray-700 leading-snug">
            {event.message}
          </p>
          <div className="flex items-center gap-1 mt-1 text-sm text-gray-400">
            <Clock className="w-3 h-3" />
            {formatDistanceToNow(new Date(event.created_at), { addSuffix: true })}
          </div>
        </div>
      </div>
    </div>
  );
}
