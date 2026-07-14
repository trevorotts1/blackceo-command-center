'use client';

/**
 * EmptyState (U60 / JM-U63i)
 *
 * The chat column's "pre-flight" hero: shows the live agent + model this
 * session will actually talk to (so a first-time user isn't guessing) and
 * four starter chips that fill the composer without sending — the user can
 * still edit before hitting Enter.
 */
import { Bot } from 'lucide-react';
import type { AgentOption, ModelOption } from './types';

const STARTERS = [
  'Give me a status update on everything in flight',
  'What needs my attention today?',
  'Draft a follow-up for the lead from this morning',
  'What did we ship this week?',
];

interface EmptyStateProps {
  agent: AgentOption | null;
  model: ModelOption | null;
  onStarterClick: (text: string) => void;
}

export default function EmptyState({ agent, model, onStarterClick }: EmptyStateProps) {
  return (
    <div className="text-center mt-12 px-4" data-testid="ceo-chat-empty-state">
      <div className="w-14 h-14 rounded-2xl bg-brand-600 flex items-center justify-center mx-auto mb-4">
        <Bot className="w-7 h-7 text-white" />
      </div>
      <p className="font-medium text-bcc-text text-card-title">Talk directly to your AI CEO</p>
      <p className="text-body text-bcc-text-muted mt-1">
        Ask for anything, or drop a document, image, or video to get started.
      </p>
      {(agent || model) && (
        <p className="text-caption text-bcc-text-muted mt-2 font-mono">
          {agent ? `${agent.avatar_emoji ?? ''} ${agent.name}`.trim() : 'Agent'}
          {model ? ` · ${model.label}` : ''}
        </p>
      )}
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2 max-w-lg mx-auto">
        {STARTERS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onStarterClick(s)}
            className="h-9 px-3 rounded-xl border border-bcc-border bg-bcc-white text-label text-bcc-text-secondary hover:border-brand-300 hover:text-bcc-text hover:shadow-pill"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}
