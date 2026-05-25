/**
 * /operator/research/[id] — detail view for a single saved research search.
 *
 * Track B7 (SCOPE-ADDITION Section 5).
 *
 * Server component that fetches the saved row directly from the DB so the
 * page renders without a client round trip. The history sidebar stays
 * client-side so it can refresh after new searches.
 */

import { notFound } from 'next/navigation';
import { getResearchSearch } from '@/lib/research-store';
import ResearchHistory from '@/components/operator/ResearchHistory';
import ResearchResult from '@/components/operator/ResearchResult';

interface PageProps {
  params: { id: string };
}

export const dynamic = 'force-dynamic';

export default function ResearchDetailPage({ params }: PageProps) {
  const row = getResearchSearch(params.id);
  if (!row) {
    notFound();
  }

  return (
    <div className="space-y-6">
      <header>
        <div className="text-[12px] uppercase tracking-[0.22em] text-bcc-text-muted font-semibold">
          Operator Console / Research
        </div>
        <h1 className="mt-2 text-page-title text-bcc-text">Saved search</h1>
      </header>

      <div className="flex flex-col md:flex-row gap-6">
        <ResearchHistory activeId={params.id} />
        <div className="flex-1 min-w-0">
          <ResearchResult
            result={{
              id: row.id,
              query: row.query,
              model: row.model,
              markdown_result: row.result_markdown,
              created_at: row.created_at,
              search_metadata: row.search_metadata,
            }}
          />
        </div>
      </div>
    </div>
  );
}
