import type { Metadata } from 'next';
import Link from 'next/link';
import { listLaunchRuns } from '@/lib/launch-runs';
import { errorSummary, publicationState } from './_lib/review';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Launches | Command Center',
  description: 'Launch automation runs: emails, texts, automations, Conversation AI and launch percentage.',
};

const FOCUS =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bcc-primary';

function Bar({ percentage, label }: { percentage: number; label: string }) {
  return (
    <div
      className="h-2 w-full rounded-full bg-bcc-border-light overflow-hidden"
      role="progressbar"
      aria-label={label}
      aria-valuenow={percentage}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={`${percentage}% of units complete`}
    >
      <div
        className="h-full rounded-full bg-bcc-primary transition-[width]"
        style={{ width: `${percentage}%` }}
      />
    </div>
  );
}

export default function LaunchListPage() {
  const { runs, errors } = listLaunchRuns();
  const summary = errorSummary(errors);

  return (
    <div className="max-w-[1400px] mx-auto px-4 sm:px-6 md:px-10 py-8 space-y-8">
      <header>
        <div className="text-[12px] uppercase tracking-[0.22em] text-bcc-text-muted font-semibold">
          Launch Automations
        </div>
        <h1 className="mt-2 text-page-title text-bcc-text">Launches</h1>
        <p className="mt-2 text-body text-bcc-text-secondary max-w-[720px]">
          One card per launch run. Each shows the emails, texts, automations,
          Conversation AI state and the launch percentage computed from the
          run&apos;s progress file.
        </p>
        <p className="mt-2 text-body font-semibold text-bcc-text">
          Every run here is a draft. Nothing on this screen is live, sends a
          message, or takes a payment.
        </p>
      </header>

      {summary && (
        <div
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 p-4 text-body text-red-800"
        >
          <a
            href={summary.anchor}
            className={`font-semibold underline underline-offset-2 rounded ${FOCUS}`}
          >
            {summary.heading} — go to the list
          </a>
        </div>
      )}

      {summary && (
        <section
          id="file-errors"
          tabIndex={-1}
          aria-labelledby="file-errors-heading"
          className="rounded-xl border border-bcc-border bg-bcc-white p-4 text-body text-bcc-text-secondary"
        >
          <h2 id="file-errors-heading" className="font-semibold text-bcc-text">
            Files that could not be read
          </h2>
          <ul className="mt-2 list-disc pl-5 font-mono text-[13px] break-words space-y-1">
            {errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
          <p className="mt-3 text-[13px]">
            Fix the file named above, then reload. The rest of the runs below
            are unaffected.
          </p>
        </section>
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
        <ul className="grid gap-4 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3">
          {runs.map((run) => {
            const state = publicationState(run);
            return (
              <li key={run.launchId} className="min-w-0">
                <Link
                  href={`/launch/${encodeURIComponent(run.launchId)}`}
                  aria-label={`Open launch ${run.offerName}: ${run.percentage} percent complete, ${state.label}`}
                  className={`block h-full rounded-xl border border-bcc-border bg-bcc-white p-5 hover:shadow-sm transition-shadow ${FOCUS}`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[12px] uppercase tracking-[0.18em] text-bcc-text-muted font-semibold break-all">
                        {run.launchId}
                      </div>
                      <div className="mt-1 text-card-title text-bcc-text break-words">
                        {run.offerName}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-mono text-2xl text-bcc-text tabular-nums">
                        {run.percentage}%
                      </div>
                      <div className="text-[11px] text-bcc-text-muted">
                        {run.doneUnits}/{run.totalUnits} units
                      </div>
                    </div>
                  </div>

                  <div className="mt-4">
                    <Bar
                      percentage={run.percentage}
                      label={`${run.offerName} launch progress`}
                    />
                  </div>

                  <p className="mt-3 text-[12px] font-semibold text-bcc-text-secondary">
                    {state.label}
                  </p>

                  <dl className="mt-4 grid grid-cols-1 gap-x-4 gap-y-1 text-[13px] text-bcc-text-secondary">
                    <div className="flex justify-between gap-3">
                      <dt>Emails</dt>
                      <dd className="font-mono tabular-nums">
                        {run.counts.email.done}/{run.counts.email.total}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt>Texts</dt>
                      <dd className="font-mono tabular-nums">
                        {run.counts.text.done}/{run.counts.text.total}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt>Automations</dt>
                      <dd className="font-mono tabular-nums">
                        {run.counts.automation.done}/{run.counts.automation.total}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt>Conversation AI</dt>
                      <dd className="text-right break-words">
                        {run.conversationAi.requested
                          ? run.conversationAi.state
                          : 'not requested'}
                      </dd>
                    </div>
                  </dl>

                  {run.warnings.length > 0 && (
                    <p className="mt-3 text-[12px] text-amber-700 break-words">
                      {run.warnings[0]}
                    </p>
                  )}

                  <p className="mt-4 text-[13px] font-semibold text-bcc-primary">
                    Open this run&apos;s review packet
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
