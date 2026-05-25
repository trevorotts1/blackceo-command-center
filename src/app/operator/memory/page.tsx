import type { Metadata } from 'next';
import MemorySearch from '@/components/operator/MemorySearch';

export const metadata: Metadata = {
  title: 'Memory — Operator Console',
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
        <div className="text-[12px] uppercase tracking-[0.22em] text-bcc-text-muted font-semibold">
          Operator Console
        </div>
        <h1 className="mt-2 text-page-title text-bcc-text">Memory</h1>
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
