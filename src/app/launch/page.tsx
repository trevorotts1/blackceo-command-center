import type { Metadata } from 'next';
import Link from 'next/link';
import { listLaunchRuns } from '@/lib/launch-runs';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Launches | Command Center',
  description: 'Launch automation runs: emails, texts, automations, Conversation AI and launch percentage.',
};

function Bar({ percentage }: { percentage: number }) {
  return (
    <div className="h-2 w-full rounded-full bg-bcc-border-light overflow-hidden" role="presentation">
      <div
        className="h-full rounded-full bg-bcc-primary transition-[width]"
        style={{ width: `${percentage}%` }}
      />
    </div>
  );
}

export default function LaunchListPage() {
  const { runs, errors } = listLaunchRuns();

  return (
    <div className="max-w-[1400px] mx-auto px-6 md:px-10 py-8 space-y-8">
      <header>
        <div className="text-[12px] uppercase tracking-[0.22em] text-bcc-text-muted font-semibold">
          Launch Automations
        </div>
        <h1 className="mt-2 text-page-title text-bcc-text">Launches</h1>
        <p className="mt-2 text-body text-bcc-text-secondary max-w-[720px]">
          One card per launch run. Each shows the emails, texts, automations,
          Conversation AI state and the launch percentage computed from the
          run&apos;s progress file. Drafts only — nothing here sends or goes live.
        </p>
      </header>

      {errors.length > 0 && (
        <div className="rounded-xl border border-bcc-border bg-bcc-white p-4 text-body text-bcc-text-secondary">
          <div className="font-semibold text-bcc-text">Files that could not be read</div>
          <ul className="mt-2 list-disc pl-5 font-mono text-[13px]">
            {errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      )}

      {runs.length === 0 ? (
        <div className="rounded-xl border border-dashed border-bcc-border bg-bcc-white p-10 text-center">
          <div className="text-body font-semibold text-bcc-text">No launch runs yet</div>
          <p className="mt-2 text-body text-bcc-text-secondary">
            A run appears once its launch plan and progress file land in the plans
            directory. Set <span className="font-mono">LAUNCH_PLANS_DIR</span> to
            point at another directory.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {runs.map((run) => (
            <Link
              key={run.launchId}
              href={`/launch/${encodeURIComponent(run.launchId)}`}
              className="group rounded-xl border border-bcc-border bg-bcc-white p-5 hover:shadow-sm transition-shadow"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[12px] uppercase tracking-[0.18em] text-bcc-text-muted font-semibold truncate">
                    {run.launchId}
                  </div>
                  <div className="mt-1 text-card-title text-bcc-text truncate">{run.offerName}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className="font-mono text-2xl text-bcc-text tabular-nums">{run.percentage}%</div>
                  <div className="text-[11px] text-bcc-text-muted">
                    {run.doneUnits}/{run.totalUnits} units
                  </div>
                </div>
              </div>

              <div className="mt-4">
                <Bar percentage={run.percentage} />
              </div>

              <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1 text-[13px] text-bcc-text-secondary">
                <div className="flex justify-between">
                  <dt>Emails</dt>
                  <dd className="font-mono tabular-nums">{run.counts.email.done}/{run.counts.email.total}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Texts</dt>
                  <dd className="font-mono tabular-nums">{run.counts.text.done}/{run.counts.text.total}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Automations</dt>
                  <dd className="font-mono tabular-nums">{run.counts.automation.done}/{run.counts.automation.total}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Conversation AI</dt>
                  <dd className="truncate">
                    {run.conversationAi.requested ? run.conversationAi.state : 'not requested'}
                  </dd>
                </div>
              </dl>

              {run.warnings.length > 0 && (
                <p className="mt-3 text-[12px] text-amber-600">{run.warnings[0]}</p>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
