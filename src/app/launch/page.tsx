import type { Metadata } from 'next';
import Link from 'next/link';
import {
  launchPlansDirConfigured,
  listIngestedLaunches,
  listLaunchRuns,
} from '@/lib/launch-runs';
import { relateLaunchViews } from '@/lib/launch-storage';
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
  const disk = listLaunchRuns();
  const ingested = listIngestedLaunches();
  const { runs } = disk;
  // An unset LAUNCH_PLANS_DIR is not a fault: runs arrive through the ingest
  // database. Report disk errors only when the operator configured the directory
  // or the directory exists but a file in it is bad.
  const diskUnconfigured = !launchPlansDirConfigured() && disk.availability === 'unavailable';
  const errors = diskUnconfigured ? [] : disk.errors;
  const summary = errorSummary(errors);
  const relation = relateLaunchViews(
    runs.map((run) => run.launchId),
    ingested.launches.map((launch) => launch.launchId),
  );
  const reportedBy = new Map(ingested.launches.map((launch) => [launch.launchId, launch]));
  const ingestOnly = ingested.launches.filter((launch) => relation.databaseOnly.includes(launch.launchId));

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

      {ingested.availability === 'unavailable' && (
        <div
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 p-4 text-body text-red-800"
        >
          The launch event database could not be read, so launches reported by
          the launch skills are not shown. This is not the same as no launches.
        </div>
      )}

      {runs.length === 0 && ingestOnly.length === 0 && (
        <div className="rounded-xl border border-dashed border-bcc-border bg-bcc-white p-10 text-center">
          <div className="text-body font-semibold text-bcc-text">No launch runs yet</div>
          <p className="mt-2 text-body text-bcc-text-secondary">
            A run appears as soon as a launch skill reports its first step to
            this Command Center. Launch plan files in{' '}
            <span className="font-mono">LAUNCH_PLANS_DIR</span> are listed too
            when that directory is set.
          </p>
        </div>
      )}

      {runs.length > 0 && (
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

                  {reportedBy.has(run.launchId) && (
                    <p className="mt-3 text-[12px] text-bcc-text-secondary break-words">
                      Reported by:{' '}
                      {reportedBy
                        .get(run.launchId)!
                        .abilities.map((a) => `${a.name} ${a.stagesClosed}/${a.stagesTotal} stages`)
                        .join(', ')}
                    </p>
                  )}

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

      {ingestOnly.length > 0 && (
        <section aria-labelledby="reported-heading" className="space-y-4">
          <h2 id="reported-heading" className="text-card-title text-bcc-text">
            Reported by launch skills
          </h2>
          <p className="text-body text-bcc-text-secondary max-w-[720px]">
            These launches reported their steps to this Command Center. Progress
            is counted in finished steps per skill; there is no plan file to
            open for them.
          </p>
          <ul className="grid gap-4 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3">
            {ingestOnly.map((launch) => (
              <li
                key={launch.launchId}
                className="min-w-0 rounded-xl border border-bcc-border bg-bcc-white p-5"
              >
                <div className="text-[12px] uppercase tracking-[0.18em] text-bcc-text-muted font-semibold break-all">
                  {launch.launchId}
                </div>
                <ul className="mt-4 space-y-4">
                  {launch.abilities.map((a) => (
                    <li key={a.runId}>
                      <div className="flex justify-between gap-3 text-[13px] text-bcc-text-secondary">
                        <span className="font-semibold text-bcc-text">{a.name}</span>
                        <span className="font-mono tabular-nums">
                          {a.stagesClosed}/{a.stagesTotal} steps
                        </span>
                      </div>
                      <div className="mt-1">
                        <Bar percentage={a.percentage} label={`${a.name} launch progress`} />
                      </div>
                      {a.blockedStages.length > 0 && (
                        <p className="mt-1 text-[12px] text-amber-700 break-words">
                          Blocked: {a.blockedStages.join(', ')}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="text-[12px] text-bcc-text-muted max-w-[720px]">{relation.note}</p>
    </div>
  );
}
