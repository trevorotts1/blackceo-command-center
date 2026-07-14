'use client';

/**
 * MessageBubble (U60 / JM-U63a — re-skinned, `brand-*`/`bcc-*` tokens only)
 *
 * A 'trust' role message renders as the transcript's system-style chip — the
 * spec's "single trust_done completion chip remains in the transcript,
 * deep-linking to its card" (spec (c)): a `trust_done` chip is clickable and
 * calls `onJumpToTask`, which the page wires to scroll/switch-tab to the
 * matching Operations Rail card.
 */
import { Bot, Paperclip, User } from 'lucide-react';
import type { ChatMessage } from './types';

interface MessageBubbleProps {
  m: ChatMessage;
  onJumpToTask?: (taskId: string) => void;
}

export default function MessageBubble({ m, onJumpToTask }: MessageBubbleProps) {
  const isUser = m.role === 'user';
  const isTrust = m.role === 'trust';
  const isSystem = m.role === 'system';

  if (isSystem || isTrust) {
    const clickable = isTrust && m.kind === 'trust_done' && !!m.task_id;
    return (
      <div className="flex justify-center">
        <button
          type="button"
          disabled={!clickable}
          onClick={() => clickable && m.task_id && onJumpToTask?.(m.task_id)}
          className={`max-w-[85%] text-caption rounded-xl px-3 py-2 border text-left ${
            isTrust
              ? `bg-brand-50 border-brand-200 text-brand-800 ${clickable ? 'hover:bg-brand-100 cursor-pointer' : 'cursor-default'}`
              : 'bg-semantic-warningLight border-amber-200 text-amber-800'
          }`}
        >
          {m.content}
        </button>
      </div>
    );
  }

  return (
    <div className={`flex gap-2 ${isUser ? 'justify-end' : 'justify-start'}`}>
      {!isUser && (
        <div className="w-8 h-8 rounded-lg bg-brand-600 flex items-center justify-center shrink-0">
          <Bot className="w-4 h-4 text-white" />
        </div>
      )}
      <div
        className={`max-w-[85%] sm:max-w-[75%] rounded-2xl px-4 py-2.5 text-body whitespace-pre-wrap break-words ${
          isUser ? 'bg-brand-600 text-white' : 'bg-bcc-white border border-bcc-border text-bcc-text'
        }`}
      >
        {m.kind === 'upload' && m.attachment_name ? (
          <span className="inline-flex items-center gap-1.5">
            <Paperclip className="w-3.5 h-3.5" /> {m.attachment_name}
          </span>
        ) : (
          m.content
        )}
      </div>
      {isUser && (
        <div className="w-8 h-8 rounded-lg bg-bcc-border-light flex items-center justify-center shrink-0">
          <User className="w-4 h-4 text-bcc-text-secondary" />
        </div>
      )}
    </div>
  );
}
