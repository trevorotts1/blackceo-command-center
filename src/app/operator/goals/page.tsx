import type { Metadata } from 'next';
import GoalsList from '@/components/operator/GoalsList';

export const metadata: Metadata = {
  title: 'Goals | Operator Console',
  description: 'Personal goal tracker, mirrored to the operator vault.',
};

export default function OperatorGoalsPage() {
  return (
    <div className="space-y-8">
      <header>
        <div className="text-[12px] uppercase tracking-[0.22em] text-bcc-text-muted font-semibold">
          Operator Console
        </div>
        <h1 className="mt-2 text-page-title text-bcc-text">Goals</h1>
        <p className="mt-2 text-body text-bcc-text-secondary max-w-[640px]">
          Personal goals for the build. Mirrored to your vault as
          <span className="font-mono"> goals.md </span>
          and per-category subfiles so Obsidian and Memory search pick them up.
        </p>
      </header>
      <GoalsList />
    </div>
  );
}
