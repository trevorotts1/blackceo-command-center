import type { Metadata } from 'next';
import JournalEntry from '@/components/operator/JournalEntry';

export const metadata: Metadata = {
  title: 'Journal | Operator Console',
  description: 'Daily journal entries mirrored to the operator vault.',
};

interface PageProps {
  searchParams?: { date?: string };
}

export default function OperatorJournalPage({ searchParams }: PageProps) {
  const initialDate = searchParams?.date && /^\d{4}-\d{2}-\d{2}$/.test(searchParams.date)
    ? searchParams.date
    : undefined;

  return (
    <div className="space-y-8">
      <header>
        <div className="text-[12px] uppercase tracking-[0.22em] text-bcc-text-muted font-semibold">
          Operator Console
        </div>
        <h1 className="mt-2 text-page-title text-bcc-text">Journal</h1>
        <p className="mt-2 text-body text-bcc-text-secondary max-w-[640px]">
          One entry per day, mirrored to
          <span className="font-mono"> [vault]/journal/YYYY/MM/YYYY-MM-DD.md</span>.
          Auto-saves every five seconds.
        </p>
      </header>
      <JournalEntry initialDate={initialDate} />
    </div>
  );
}
