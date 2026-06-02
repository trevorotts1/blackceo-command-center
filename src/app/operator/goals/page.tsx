import type { Metadata } from 'next';
import GoalsList from '@/components/operator/GoalsList';
import OperatorHelpButton from '@/components/operator/OperatorHelpButton';
import ModuleHealthDot from '@/components/operator/ModuleHealthDot';

export const metadata: Metadata = {
  title: 'Goals | Operator Console',
  description: 'Personal goal tracker, mirrored to the operator vault.',
};

export default function OperatorGoalsPage() {
  return (
    <div className="space-y-8">
      <header>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="text-[12px] uppercase tracking-[0.22em] text-bcc-text-muted font-semibold">
              Operator Console
            </div>
            <h1 className="mt-2 text-page-title text-bcc-text flex items-center gap-3">
              Goals
              <ModuleHealthDot module="goals" showLabel />
            </h1>
          </div>
          <OperatorHelpButton card="goals" />
        </div>
        <p className="mt-2 text-body text-bcc-text-secondary max-w-[640px]">
          Goals for the SELECTED client. Mirrored into that client agent&apos;s
          workspace as <span className="font-mono"> goals.md </span>
          and per-category subfiles so its memory crawler and Memory search pick
          them up. Active goals are also injected into the agent&apos;s chat
          context, and a periodic on-track check asks the agent how the build is
          progressing against them.
        </p>
      </header>
      <GoalsList />
    </div>
  );
}
