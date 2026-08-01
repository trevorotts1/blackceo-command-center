/**
 * /operator/archive — MR-42 Archive Browser.
 *
 * Lists soft-archived tasks that have been removed from the visible board
 * (board-hygiene rule 4: done > 30d, and the Sunday weekly-done-clear sweep).
 * The operator can search, inspect, and restore any card with one click.
 *
 * This page closes the gap identified in MR-42: archived tasks disappeared
 * without warning, and the only way to see them was the obscure
 * `?includeArchived=true` query parameter.
 */

import type { Metadata } from 'next';
import ArchiveBrowser from '@/components/operator/ArchiveBrowser';
import OperatorHelpButton from '@/components/operator/OperatorHelpButton';

export const metadata: Metadata = {
  title: 'Archive | Operator Console',
  description: 'Browse and restore soft-archived tasks — hidden from the board, never deleted.',
};

export const dynamic = 'force-dynamic';

export default function OperatorArchivePage() {
  return (
    <div className="space-y-8">
      <header>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="text-[12px] uppercase tracking-[0.22em] text-bcc-text-muted font-semibold">
              Operator Console
            </div>
            <h1 className="mt-2 text-page-title text-bcc-text">Archive</h1>
          </div>
          <OperatorHelpButton card="archive" />
        </div>
        <p className="mt-2 text-body text-bcc-text-secondary max-w-[640px]">
          Done tasks are soft-archived after 30 days (board-hygiene rule 4) and on the
          Sunday sweep — they are hidden from the board but preserved. Restore any task
          to put it back instantly.
        </p>
      </header>
      <ArchiveBrowser />
    </div>
  );
}
