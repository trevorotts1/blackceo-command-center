/**
 * /operator/web-agent/session/[id] - live view for a single Web Agent run.
 *
 * Track B9 (SCOPE-ADDITION Section 7).
 *
 * Server component that loads the persisted row directly and hands it to the
 * client-side `WebAgentSession` view. The client component opens the SSE
 * stream when the row's status is still pending or running; otherwise it
 * renders the final state from the row alone.
 */

import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { getSession } from '@/lib/web-agent/runner';
import WebAgentSession from '@/components/operator/WebAgentSession';

interface PageProps {
  params: Promise<{ id: string }> | { id: string };
}

export const dynamic = 'force-dynamic';

export default async function WebAgentSessionPage({ params }: PageProps) {
  const resolved =
    typeof (params as Promise<{ id: string }>).then === 'function'
      ? await (params as Promise<{ id: string }>)
      : (params as { id: string });
  const row = getSession(resolved.id);
  if (!row) {
    notFound();
  }

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[12px] uppercase tracking-[0.22em] text-bcc-text-muted font-semibold">
            Operator Console / Web Agent
          </div>
          <h1 className="mt-2 text-page-title text-bcc-text">Session</h1>
        </div>
        <Link
          href="/operator/web-agent"
          className="inline-flex items-center gap-1 text-[12px] uppercase tracking-[0.16em] text-bcc-text-muted hover:text-bcc-text"
        >
          <ChevronLeft size={14} />
          Back to all sessions
        </Link>
      </header>

      <WebAgentSession
        initial={{
          id: row.id,
          task: row.task,
          status: row.status,
          started_at: row.started_at,
          ended_at: row.ended_at,
          result_markdown: row.result_markdown,
          action_log: row.action_log,
        }}
      />
    </div>
  );
}
