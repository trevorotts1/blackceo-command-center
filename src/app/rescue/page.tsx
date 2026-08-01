import type { Metadata } from 'next';
import { Breadcrumb } from '@/components/Breadcrumb';
import RescueDashboard from '@/components/rescue/RescueDashboard';

export const metadata: Metadata = {
  title: 'Rescue Rangers',
  description: 'Fleet rescue tickets: open by severity, daily outcomes, standing blocks, and audit timelines.',
};

export const dynamic = 'force-dynamic';

/**
 * /rescue — the Rescue Rangers ticket view (P13 of the 2026-08-01 diagnosis).
 *
 * Until this page, Telegram was the entire rescue interface: no severity view,
 * no per-ticket history, no daily accounting of what came in versus what was
 * fixed. Everything here reads the durable SQLite ticket store on this box; a
 * box without one renders the empty state rather than an error.
 *
 * Server component by design: the shell and breadcrumb render statically and
 * the data-bearing dashboard is the only client component, matching the
 * /podcast transplant's structure.
 */
export default function RescuePage() {
  return (
    <div className="min-h-screen bg-bcc-bg">
      <div className="mx-auto w-full max-w-[1400px] px-4 py-6 md:px-8 md:py-8">
        <Breadcrumb items={[{ label: 'Home', href: '/' }, { label: 'Rescue Rangers' }]} />
        <header className="mb-6">
          <h1 className="text-page-title text-gray-900">Rescue Rangers</h1>
          <p className="mt-1 text-body text-gray-600">
            Every escalation the fleet raised, what we did about it, and who is still waiting.
          </p>
        </header>
        <RescueDashboard />
      </div>
    </div>
  );
}
