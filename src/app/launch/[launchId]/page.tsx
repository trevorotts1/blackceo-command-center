import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLaunchRun } from '@/lib/launch-runs';
import type { LaunchUnit, LaunchUnitState } from '@/lib/launch-runs';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Launch | Command Center',
  description: 'One launch run: emails, texts, automations, Conversation AI and launch percentage.',
};

const STATE_STYLES: Record<LaunchUnitState, string> = {
  complete: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  running: 'bg-sky-50 text-sky-700 border-sky-200',
  pending: 'bg-bcc-border-light text-bcc-text-muted border-bcc-border',
  failed: 'bg-red-50 text-red-700 border-red-200',
  blocked: 'bg-amber-50 text-amber-700 border-amber-200',
  dropped: 'bg-bcc-border-light text-bcc-text-muted border-bcc-border line-through',
};

function StateBadge({ state }: { state: LaunchUnitState }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.08em] ${STATE_STYLES[state]}`}
    >
      {state}
    </span>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-bcc-border bg-bcc-white">
      <div className="flex items-baseline justify-between gap-4 border-b border-bcc-border px-5 py-3">
        <h2 className="text-card-title text-bcc-text">{title}</h2>
        <span className="font-mono text-[12px] text-bcc-text-muted tabular-nums">{count}</span>
      </div>
      {children}
    </section>
  );
}

function UnitTable({ units, empty }: { units: LaunchUnit[]; empty: string }) {
  if (units.length === 0) {
    return <p className="px-5 py-6 text-body text-bcc-text-secondary">{empty}</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-[13px]">
        <thead className="text-[11px] uppercase tracking-[0.12em] text-bcc-text-muted">
          <tr className="border-b border-bcc-border">
            <th className="px-5 py-2 font-semibold">Unit</th>
            <th className="px-5 py-2 font-semibold">Detail</th>
            <th className="px-5 py-2 font-semibold">Waits for</th>
            <th className="px-5 py-2 font-semibold">State</th>
          </tr>
        </thead>
        <tbody>
          {units.map((unit) => (
            <tr key={unit.id} className="border-b border-bcc-border last:border-0">
              <td className="px-5 py-2.5">
                <div className="text-bcc-text font-medium capitalize">{unit.label}</div>
                <div className="font-mono text-[11px] text-bcc-text-muted">{unit.id}</div>
              </td>
              <td className="px-5 py-2.5 text-bcc-text-secondary">{unit.detail}</td>
              <td className="px-5 py-2.5 font-mono text-[11px] text-bcc-text-muted">
                {unit.waits_for.length > 0 ? unit.waits_for.join(', ') : '—'}
              </td>
              <td className="px-5 py-2.5">
                <StateBadge state={unit.state} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function LaunchDetailPage({
  params,
}: {
  params: Promise<{ launchId: string }>;
}) {
  const { launchId } = await params;
  const run = getLaunchRun(decodeURIComponent(launchId));
  if (!run) notFound();

  const emails = run.units.filter((u) => u.kind === 'email');
  const texts = run.units.filter((u) => u.kind === 'text');
  const automations = run.units.filter((u) => u.kind === 'automation');
  const pages = run.units.filter((u) => u.kind === 'page');
  const ai = run.conversationAi;

  return (
    <div className="max-w-[1400px] mx-auto px-6 md:px-10 py-8 space-y-6">
      <nav className="text-[13px]">
        <Link href="/launch" className="text-bcc-text-muted hover:text-bcc-text transition-colors">
          Launches
        </Link>
        <span className="mx-2 text-bcc-text-muted">/</span>
        <span className="text-bcc-text">{run.launchId}</span>
      </nav>

      <header className="flex flex-wrap items-start justify-between gap-6">
        <div className="min-w-0">
          <div className="text-[12px] uppercase tracking-[0.22em] text-bcc-text-muted font-semibold">
            Launch run
          </div>
          <h1 className="mt-2 text-page-title text-bcc-text">{run.offerName}</h1>
          <p className="mt-1 font-mono text-[13px] text-bcc-text-secondary">{run.launchId}</p>
        </div>
        <div className="rounded-xl border border-bcc-border bg-bcc-white px-6 py-4 min-w-[240px]">
          <div className="flex items-baseline justify-between gap-6">
            <span className="text-[11px] uppercase tracking-[0.18em] text-bcc-text-muted font-semibold">
              Launch percentage
            </span>
            <span className="font-mono text-3xl text-bcc-text tabular-nums">{run.percentage}%</span>
          </div>
          <div className="mt-3 h-2 w-full rounded-full bg-bcc-border-light overflow-hidden">
            <div
              className="h-full rounded-full bg-bcc-primary"
              style={{ width: `${run.percentage}%` }}
            />
          </div>
          <div className="mt-2 text-[12px] text-bcc-text-muted">
            {run.doneUnits} of {run.totalUnits} units complete
          </div>
        </div>
      </header>

      {run.warnings.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-body text-amber-800">
          {run.warnings.map((warning) => (
            <div key={warning}>{warning}</div>
          ))}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-xl border border-bcc-border bg-bcc-white p-4">
          <div className="text-[11px] uppercase tracking-[0.18em] text-bcc-text-muted font-semibold">Emails</div>
          <div className="mt-1 font-mono text-2xl text-bcc-text tabular-nums">
            {run.counts.email.done}/{run.counts.email.total}
          </div>
        </div>
        <div className="rounded-xl border border-bcc-border bg-bcc-white p-4">
          <div className="text-[11px] uppercase tracking-[0.18em] text-bcc-text-muted font-semibold">Texts</div>
          <div className="mt-1 font-mono text-2xl text-bcc-text tabular-nums">
            {run.counts.text.done}/{run.counts.text.total}
          </div>
          <div className="mt-1 text-[12px] text-bcc-text-muted">
            {run.a2pReady ? 'A2P ready' : 'A2P not approved — texts stay drafts'}
          </div>
        </div>
        <div className="rounded-xl border border-bcc-border bg-bcc-white p-4">
          <div className="text-[11px] uppercase tracking-[0.18em] text-bcc-text-muted font-semibold">Automations</div>
          <div className="mt-1 font-mono text-2xl text-bcc-text tabular-nums">
            {run.counts.automation.done}/{run.counts.automation.total}
          </div>
        </div>
        <div className="rounded-xl border border-bcc-border bg-bcc-white p-4">
          <div className="text-[11px] uppercase tracking-[0.18em] text-bcc-text-muted font-semibold">Conversation AI</div>
          <div className="mt-1 flex items-center gap-2">
            <span className="text-card-title text-bcc-text">
              {ai.requested ? ai.mode : 'Not requested'}
            </span>
            <StateBadge state={ai.state} />
          </div>
          <div className="mt-1 text-[12px] text-bcc-text-muted">
            {ai.channels.length > 0 ? ai.channels.join(', ') : 'no channels'}
          </div>
        </div>
      </div>

      <section className="rounded-xl border border-bcc-border bg-bcc-white px-5 py-4">
        <div className="grid gap-4 text-[13px] md:grid-cols-2 xl:grid-cols-4">
          <div>
            <div className="text-[11px] uppercase tracking-[0.18em] text-bcc-text-muted font-semibold">Doors open</div>
            <div className="mt-1 text-bcc-text">{run.calendar.doorsOpenAt ?? '—'}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-[0.18em] text-bcc-text-muted font-semibold">Doors close</div>
            <div className="mt-1 text-bcc-text">{run.calendar.doorsCloseAt ?? '—'}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-[0.18em] text-bcc-text-muted font-semibold">Launch at</div>
            <div className="mt-1 text-bcc-text">{run.calendar.launchAt ?? '—'}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-[0.18em] text-bcc-text-muted font-semibold">Timezone</div>
            <div className="mt-1 text-bcc-text">{run.calendar.timezone ?? '—'}</div>
          </div>
        </div>
      </section>

      <Section
        title="Emails"
        count={`${run.counts.email.done}/${run.counts.email.total}`}
      >
        <UnitTable units={emails} empty="No email sequences planned for this launch." />
      </Section>

      <Section
        title="Texts"
        count={`${run.counts.text.done}/${run.counts.text.total}`}
      >
        <UnitTable units={texts} empty="No text sets planned for this launch." />
      </Section>

      <Section
        title="Automations"
        count={`${run.counts.automation.done}/${run.counts.automation.total}`}
      >
        <UnitTable units={automations} empty="No automations planned for this launch." />
      </Section>

      <Section
        title="Pages"
        count={`${run.counts.page.done}/${run.counts.page.total}`}
      >
        <UnitTable units={pages} empty="No pages planned for this launch." />
      </Section>

      <p className="text-[12px] text-bcc-text-muted">
        Drafts only. This screen reads plan and progress files; it never sends,
        switches anything live, or touches an account.
      </p>
    </div>
  );
}
