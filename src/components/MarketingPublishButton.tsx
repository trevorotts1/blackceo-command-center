'use client';

import { useState } from 'react';
import { Megaphone, Check, Loader2, AlertCircle } from 'lucide-react';
import type { Task } from '@/lib/types';

interface MarketingPublishButtonProps {
  task: Task;
  /**
   * Override the platforms list. Defaults to the most common quartet
   * (linkedin, medium, x, wordpress) — same example shown in
   * INSTRUCTIONS.md `## How to trigger this skill`.
   */
  platforms?: string[];
  /**
   * Optional class name for the wrapping <button>.
   */
  className?: string;
  /**
   * Called after a successful queue POST (passes the new publish id).
   */
  onQueued?: (publishId: string) => void;
}

const DEFAULT_PLATFORMS = ['linkedin', 'medium', 'x', 'wordpress'];

function isMarketingTask(task: Task): boolean {
  const dept = (task.department || '').toLowerCase();
  return (
    dept === 'marketing' ||
    dept === 'marketing-dept' ||
    dept === 'social-media' ||
    dept === 'social'
  );
}

/**
 * MarketingPublishButton — visible on Marketing-department task cards.
 *
 * Clicking POSTs to /api/skill-35/publish with
 *   { task_id, topic, platforms[] }
 * The endpoint records the publish intent in the publish_queue table
 * (migration 022) and emits a `publish_queued` SSE event so the
 * dashboard shows "queued" state.
 *
 * Closes the third path documented in INSTRUCTIONS.md `## How to
 * trigger this skill` (the other two ship in onboarding repo v10.14.33).
 */
export function MarketingPublishButton({
  task,
  platforms = DEFAULT_PLATFORMS,
  className,
  onQueued,
}: MarketingPublishButtonProps) {
  const [state, setState] = useState<'idle' | 'queuing' | 'queued' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  if (!isMarketingTask(task)) return null;

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (state === 'queuing' || state === 'queued') return;

    setState('queuing');
    setError(null);

    try {
      const resp = await fetch('/api/skill-35/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task_id: task.id,
          topic: task.title,
          platforms,
          schedule: 'auto',
          requested_by: 'dashboard:marketing-publish-button',
        }),
      });

      if (!resp.ok) {
        const data = (await resp.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `HTTP ${resp.status}`);
      }

      const data = (await resp.json()) as { publish: { id: string } };
      setState('queued');
      if (data.publish?.id && onQueued) onQueued(data.publish.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'failed to queue';
      setError(msg);
      setState('error');
    }
  };

  const base = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-colors';
  let styles = 'bg-pink-100 text-pink-700 hover:bg-pink-200';
  let label: React.ReactNode = (
    <>
      <Megaphone className="h-3.5 w-3.5" /> Publish
    </>
  );

  if (state === 'queuing') {
    styles = 'bg-pink-50 text-pink-500 cursor-wait';
    label = (
      <>
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Queuing…
      </>
    );
  } else if (state === 'queued') {
    styles = 'bg-emerald-100 text-emerald-700 cursor-default';
    label = (
      <>
        <Check className="h-3.5 w-3.5" /> Queued
      </>
    );
  } else if (state === 'error') {
    styles = 'bg-red-100 text-red-700 hover:bg-red-200';
    label = (
      <>
        <AlertCircle className="h-3.5 w-3.5" /> Retry
      </>
    );
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      title={
        state === 'error' && error
          ? `Failed: ${error}`
          : `Queue this topic for the Skill 35 publishing pipeline (platforms: ${platforms.join(', ')})`
      }
      className={[base, styles, className || ''].join(' ').trim()}
    >
      {label}
    </button>
  );
}

export default MarketingPublishButton;
