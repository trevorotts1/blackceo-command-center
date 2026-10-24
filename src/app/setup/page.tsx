import type { Metadata } from 'next';
import SetupReadinessPanel from '@/components/setup/SetupReadinessPanel';

export const metadata: Metadata = {
  title: 'Setup readiness',
  description: 'What this Command Center installation still needs before it is fully set up.',
};

export const dynamic = 'force-dynamic';

export default function SetupPage() {
  return (
    <div className="min-h-dvh bg-bcc-bg">
      <div className="mx-auto max-w-5xl px-6 py-10 md:px-10">
        <SetupReadinessPanel />
      </div>
    </div>
  );
}
