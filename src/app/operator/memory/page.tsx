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
          Search every place you have written anything: the operator vault,
          per-agent scratch directories, journal entries, agent chats, goals,
          research results, tasks, and persona blueprints.
        </p>
      </header>
      <MemorySearch initialQuery={initialQuery} />
    </div>
  );
}
