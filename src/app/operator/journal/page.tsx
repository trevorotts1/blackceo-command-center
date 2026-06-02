import type { Metadata } from 'next';
import JournalEntry from '@/components/operator/JournalEntry';
import OperatorHelpButton from '@/components/operator/OperatorHelpButton';
import ModuleHealthDot from '@/components/operator/ModuleHealthDot';

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
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="text-[12px] uppercase tracking-[0.22em] text-bcc-text-muted font-semibold">
              Operator Console
            </div>
            <h1 className="mt-2 text-page-title text-bcc-text flex items-center gap-3">
              Journal
              <ModuleHealthDot module="journal" showLabel />
            </h1>
          </div>
          <OperatorHelpButton card="journal" />
        </div>
        <p className="mt-2 text-body text-bcc-text-secondary max-w-[640px]">
          One entry per day, written into the SELECTED client&apos;s workspace at
          <span className="font-mono"> [workspace]/journal/YYYY/MM/YYYY-MM-DD.md</span>.
          Auto-saves every five seconds.
        </p>
        <p className="mt-2 text-[13px] text-bcc-text-muted max-w-[640px]">
          The memory loop: the entry lands in that client agent&apos;s own
          workspace, so the agent&apos;s OpenClaw memory crawler picks it up and
          can recall it later. Pick a different client in the header and the
          journal writes to that agent&apos;s memory instead. For a remote
          client the file is delivered over the Cloudflare Access tunnel; if the
          tunnel is down the entry is still saved here and mirrors on the next
          successful save.
        </p>
      </header>
      <JournalEntry initialDate={initialDate} />
    </div>
  );
}
