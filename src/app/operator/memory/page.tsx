import type { Metadata } from 'next';
import MemorySearch from '@/components/operator/MemorySearch';
import OperatorHelpButton from '@/components/operator/OperatorHelpButton';

export const metadata: Metadata = {
  title: 'Memory | Operator Console',
  description: 'Full-text search across the vault, scratch dirs, chats, journal, goals, research, tasks, and personas.',
};

interface PageProps {
  searchParams?: { q?: string };
}

export default function OperatorMemoryPage({ searchParams }: PageProps) {
  const initialQuery = searchParams?.q || '';

  return (
    <div className="space-y-8">
      <header>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="text-[12px] uppercase tracking-[0.22em] text-bcc-text-muted font-semibold">
              Operator Console
            </div>
            <h1 className="mt-2 text-page-title text-bcc-text">Memory</h1>
          </div>
          <OperatorHelpButton card="memory" />
        </div>
        <p className="mt-2 text-body text-bcc-text-secondary max-w-[680px]">
          Search the SELECTED client agent&apos;s memory: its workspace
          (including its <span className="font-mono">MEMORY.md</span>,
          <span className="font-mono"> memory/</span> logs, and
          <span className="font-mono"> dreaming/</span> summaries), its scratch
          directories, plus journal entries, agent chats, goals, research
          results, tasks, and persona blueprints. Switch clients in the header
          to search a different agent&apos;s memory. A remote client&apos;s
          workspace is read over the Cloudflare Access tunnel; if it is
          unreachable the search still returns everything else and shows a
          notice.
        </p>
      </header>
      <MemorySearch initialQuery={initialQuery} />
    </div>
  );
}
