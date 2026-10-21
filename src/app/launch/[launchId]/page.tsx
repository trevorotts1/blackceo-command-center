import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLaunchRun } from '@/lib/launch-runs';
import type { LaunchUnit, LaunchUnitState } from '@/lib/launch-runs';
import {
  buildPacket,
  diagnosticRows,
  nextAction,
  publicationState,
} from '../_lib/review';

export const dynamic = 'force-dynamic';

const FOCUS =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bcc-primary';

const STATE_STYLES: Record<LaunchUnitState, string> = {
  complete: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  running: 'bg-sky-50 text-sky-700 border-sky-200',
  pending: 'bg-bcc-border-light text-bcc-text-muted border-bcc-border',
  failed: 'bg-red-50 text-red-700 border-red-200',
  blocked: 'bg-amber-50 text-amber-700 border-amber-200',
  dropped: 'bg-bcc-border-light text-bcc-text-muted border-bcc-border line-through',
};

type RouteParams = { params: Promise<{ launchId: string }> };

export async function generateMetadata({ params }: RouteParams): Promise<Metadata> {
  const { launchId } = await params;
  const run = getLaunchRun(decodeURIComponent(launchId));
  if (!run) return { title: 'Launch not found | Command Center' };
  return {
    title: `${run.offerName} launch review | Command Center`,
    description: `Draft review packet for launch ${run.launchId}. Read-only: nothing here sends or goes live.`,
  };
}

function StateBadge({ state }: { state: LaunchUnitState }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.08em] ${STATE_STYLES[state]}`}
    >
      <span className="sr-only">Status: </span>
      {state}
    </span>
  );
}

function Panel({
  id,
  title,
  note,
  children,
}: {
  id: string;
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-labelledby={`${id}-heading`}
      className="rounded-xl border border-bcc-border bg-bcc-white"
    >
      <div className="border-b border-bcc-border px-4 sm:px-5 py-3">
        <h2 id={`${id}-heading`} className="text-card-title text-bcc-text">
          {title}
        </h2>
        {note && <p className="mt-1 text-[13px] text-bcc-text-secondary">{note}</p>}
      </div>
      {children}
    </section>
  );
}

function UnitList({ units, empty }: { units: LaunchUnit[]; empty: string }) {
  if (units.length === 0) {
    return <p className="px-4 sm:px-5 py-6 text-body text-bcc-text-secondary">{empty}</p>;
  }
  return (
    <ul className="divide-y divide-bcc-border">
      {units.map((unit) => (
        <li key={unit.id} className="px-4 sm:px-5 py-3 min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-[13px] font-medium text-bcc-text capitalize break-words">
              {unit.label}
            </div>
            <StateBadge state={unit.state} />
          </div>
          <div className="mt-1 text-[13px] text-bcc-text-secondary break-words">
            {unit.detail}
          </div>
          {unit.waits_for.length > 0 && (
            <div className="mt-1 text-[12px] text-bcc-text-muted break-words">
              Waits for {unit.waits_for.join(', ')}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

export default async function LaunchDetailPage({ params }: RouteParams) {
  const { launchId } = await params;
  const run = getLaunchRun(decodeURIComponent(launchId));
  if (!run) notFound();

  const state = publicationState(run);
  const action = nextAction(run);
  const packet = buildPacket(run);
  const diagnostics = diagnosticRows(run);

  return (
    <div className="max-w-[1400px] mx-auto px-4 sm:px-6 md:px-10 py-8 space-y-6">
      <nav aria-label="Breadcrumb" className="text-[13px]">
        <Link
          href="/launch"
          className={`text-bcc-text-muted hover:text-bcc-text transition-colors rounded ${FOCUS}`}
        >
          All launches
        </Link>
        <span className="mx-2 text-bcc-text-muted" aria-hidden="true">
          /
        </span>
        <span className="text-bcc-text" aria-current="page">
          {run.offerName}
        </span>
      </nav>

      <header className="min-w-0">
        <div className="text-[12px] uppercase tracking-[0.22em] text-bcc-text-muted font-semibold">
          Launch review packet
        </div>
        <h1 className="mt-2 text-page-title text-bcc-text break-words">{run.offerName}</h1>
        <p className="mt-1 font-mono text-[13px] text-bcc-text-secondary break-all">
          {run.launchId}
        </p>
      </header>

      <div
        role="status"
        className={`rounded-xl border p-4 ${
          state.tone === 'ready'
            ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
            : state.tone === 'attention'
              ? 'border-amber-200 bg-amber-50 text-amber-800'
              : 'border-bcc-border bg-bcc-white text-bcc-text-secondary'
        }`}
      >
        <p className="text-body font-semibold text-bcc-text">{state.label}</p>
        <p className="mt-1 text-[13px]">{state.detail}</p>
      </div>

      <section
        aria-labelledby="next-action-heading"
        className="rounded-xl border border-bcc-primary/40 bg-bcc-primary-light px-4 sm:px-5 py-4"
      >
        <h2 id="next-action-heading" className="text-card-title text-bcc-text">
          Next action
        </h2>
        <p className="mt-1 text-body text-bcc-text">
          {action.href ? (
            <a
              href={action.href}
              target="_blank"
              rel="noopener noreferrer"
              className={`font-semibold text-bcc-primary underline underline-offset-2 break-all rounded ${FOCUS}`}
            >
              {action.label} (opens in a new tab)
            </a>
          ) : (
            <span className="font-semibold">{action.label}</span>
          )}
        </p>
        <p className="mt-1 text-[13px] text-bcc-text-secondary break-words">
          {action.detail}
        </p>
      </section>

      {run.warnings.length > 0 && (
        <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-body text-amber-800">
          <p className="font-semibold">
            {run.warnings.length === 1
              ? '1 run warning needs a fix'
              : `${run.warnings.length} run warnings need a fix`}
          </p>
          <ul className="mt-2 list-disc pl-5 text-[13px] space-y-1 break-words">
            {run.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
          <p className="mt-2 text-[13px]">
            Progress may be incomplete until the named file is fixed. Reload after the fix.
          </p>
        </div>
      )}

      <section
        aria-labelledby="progress-heading"
        className="rounded-xl border border-bcc-border bg-bcc-white px-4 sm:px-5 py-4"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="progress-heading" className="text-card-title text-bcc-text">
            Launch percentage
          </h2>
          <span className="font-mono text-3xl text-bcc-text tabular-nums">
            {run.percentage}%
          </span>
        </div>
        <div
          className="mt-3 h-2 w-full rounded-full bg-bcc-border-light overflow-hidden"
          role="progressbar"
          aria-label="Launch percentage"
          aria-valuenow={run.percentage}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuetext={`${run.doneUnits} of ${run.totalUnits} units complete`}
        >
          <div
            className="h-full rounded-full bg-bcc-primary"
            style={{ width: `${run.percentage}%` }}
          />
        </div>
        <p className="mt-2 text-[12px] text-bcc-text-muted">
          {run.doneUnits} of {run.totalUnits} units complete
        </p>

        <dl className="mt-4 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 text-[13px]">
          <div className="rounded-lg border border-bcc-border p-3 min-w-0">
            <dt className="text-[11px] uppercase tracking-[0.18em] text-bcc-text-muted font-semibold">
              Emails
            </dt>
            <dd className="mt-1 font-mono text-2xl text-bcc-text tabular-nums">
              {run.counts.email.done}/{run.counts.email.total}
            </dd>
          </div>
          <div className="rounded-lg border border-bcc-border p-3 min-w-0">
            <dt className="text-[11px] uppercase tracking-[0.18em] text-bcc-text-muted font-semibold">
              Texts
            </dt>
            <dd className="mt-1 font-mono text-2xl text-bcc-text tabular-nums">
              {run.counts.text.done}/{run.counts.text.total}
            </dd>
            <dd className="mt-1 text-[12px] text-bcc-text-muted break-words">
              {run.a2pReady ? 'A2P ready' : 'A2P not approved — texts stay drafts'}
            </dd>
          </div>
          <div className="rounded-lg border border-bcc-border p-3 min-w-0">
            <dt className="text-[11px] uppercase tracking-[0.18em] text-bcc-text-muted font-semibold">
              Automations
            </dt>
            <dd className="mt-1 font-mono text-2xl text-bcc-text tabular-nums">
              {run.counts.automation.done}/{run.counts.automation.total}
            </dd>
          </div>
          <div className="rounded-lg border border-bcc-border p-3 min-w-0">
            <dt className="text-[11px] uppercase tracking-[0.18em] text-bcc-text-muted font-semibold">
              Conversation AI
            </dt>
            <dd className="mt-1 flex flex-wrap items-center gap-2 text-card-title text-bcc-text">
              {run.conversationAi.requested ? run.conversationAi.mode : 'Not requested'}
              <StateBadge state={run.conversationAi.state} />
            </dd>
            <dd className="mt-1 text-[12px] text-bcc-text-muted break-words">
              {run.conversationAi.channels.length > 0
                ? run.conversationAi.channels.join(', ')
                : 'no channels'}
            </dd>
          </div>
        </dl>
      </section>

      <section
        aria-labelledby="calendar-heading"
        className="rounded-xl border border-bcc-border bg-bcc-white px-4 sm:px-5 py-4"
      >
        <h2 id="calendar-heading" className="text-card-title text-bcc-text">
          Launch calendar
        </h2>
        <dl className="mt-3 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 text-[13px]">
          <div className="min-w-0">
            <dt className="text-[11px] uppercase tracking-[0.18em] text-bcc-text-muted font-semibold">
              Doors open
            </dt>
            <dd className="mt-1 text-bcc-text break-words">{run.calendar.doorsOpenAt ?? '—'}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-[11px] uppercase tracking-[0.18em] text-bcc-text-muted font-semibold">
              Doors close
            </dt>
            <dd className="mt-1 text-bcc-text break-words">{run.calendar.doorsCloseAt ?? '—'}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-[11px] uppercase tracking-[0.18em] text-bcc-text-muted font-semibold">
              Launch at
            </dt>
            <dd className="mt-1 text-bcc-text break-words">{run.calendar.launchAt ?? '—'}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-[11px] uppercase tracking-[0.18em] text-bcc-text-muted font-semibold">
              Timezone
            </dt>
            <dd className="mt-1 text-bcc-text break-words">{run.calendar.timezone ?? '—'}</dd>
          </div>
        </dl>
      </section>

      <Panel
        id="packet"
        title="Review packet"
        note="One place for every draft: previews first, then messages and automations. Reviewing here never approves, sends or publishes."
      >
        <div className="px-4 sm:px-5 py-4 space-y-6">
          <div>
            <h3 className="text-[13px] uppercase tracking-[0.14em] text-bcc-text-muted font-semibold">
              Previews
            </h3>
            {packet.previews.length > 0 ? (
              <ul className="mt-2 list-disc pl-5 space-y-1 text-[13px]">
                {packet.previews.map((preview) => (
                  <li key={preview.unitId} className="break-words">
                    <a
                      href={preview.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={`text-bcc-primary underline underline-offset-2 rounded ${FOCUS}`}
                    >
                      {preview.label}
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-[13px] text-bcc-text-secondary">
                No page preview URLs are planned yet.
              </p>
            )}

            {packet.missingPreviews.length > 0 && (
              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
                <p className="text-[13px] font-semibold text-amber-800">
                  Missing input: {packet.missingPreviews.length === 1 ? 'a page still needs' : `${packet.missingPreviews.length} pages still need`} a real preview URL
                </p>
                <ul className="mt-1 list-disc pl-5 text-[13px] text-amber-800 space-y-1 break-words">
                  {packet.missingPreviews.map((unit) => (
                    <li key={unit.id}>
                      {unit.label} — add the live URL to the launch plan, then reload this page.
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div>
            <h3 className="text-[13px] uppercase tracking-[0.14em] text-bcc-text-muted font-semibold">
              Messages
            </h3>
            <UnitList
              units={packet.messages}
              empty="No emails or texts are planned for this launch."
            />
            <p className="mt-2 text-[12px] text-bcc-text-muted">
              Message drafts do not send. A2P approval and sending are separate steps.
            </p>
          </div>

          <div>
            <h3 className="text-[13px] uppercase tracking-[0.14em] text-bcc-text-muted font-semibold">
              Automations
            </h3>
            <UnitList
              units={packet.automations}
              empty="No automations are planned for this launch."
            />
          </div>

          {packet.absentKinds.length > 0 && (
            <div>
              <h3 className="text-[13px] uppercase tracking-[0.14em] text-bcc-text-muted font-semibold">
                Not in this launch
              </h3>
              <p className="mt-1 text-[13px] text-bcc-text-secondary break-words">
                {packet.absentKinds.join(', ')}. These routes are hidden rather than
                shown empty, so nothing unsupported is offered.
              </p>
            </div>
          )}
        </div>
      </Panel>

      <Panel
        id="draft-live"
        title="Draft or live?"
        note="This screen reads plan and progress files. It cannot publish, send, switch anything live, or touch an account."
      >
        <div className="px-4 sm:px-5 py-4 text-[13px] text-bcc-text-secondary space-y-2">
          <p>
            <strong className="text-bcc-text">Draft-ready</strong> means every
            planned unit is built and its progress says complete. It is still a
            draft.
          </p>
          <p>
            <strong className="text-bcc-text">Live</strong> is not a state this
            screen can observe or produce. Going live stays an explicit, separate
            decision per launch.
          </p>
          <p>
            Approval stays exact: each unit carries its own state, so re-review
            happens for the unit that changed — never a blanket yes for the run.
          </p>
        </div>
      </Panel>

      <Panel
        id="diagnostics"
        title="Technical details"
        note="For troubleshooting only. Collapsed by default."
      >
        <details className="px-4 sm:px-5 py-4">
          <summary
            className={`cursor-pointer text-[13px] font-semibold text-bcc-text rounded ${FOCUS}`}
          >
            Show unit IDs, waits and source file
          </summary>
          <dl className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3 text-[12px] text-bcc-text-secondary">
            <div className="min-w-0">
              <dt className="font-semibold text-bcc-text">Source file</dt>
              <dd className="font-mono break-all">{run.sourceFile || 'unknown'}</dd>
            </div>
            <div className="min-w-0">
              <dt className="font-semibold text-bcc-text">Planned units</dt>
              <dd className="font-mono tabular-nums">{run.totalUnits}</dd>
            </div>
          </dl>
          <ul className="mt-3 space-y-2">
            {diagnostics.map((row) => (
              <li key={row.id} className="text-[12px] min-w-0">
                <div className="font-mono text-bcc-text break-all">{row.id}</div>
                <div className="text-bcc-text-secondary break-words">
                  {row.kind} · {row.state}
                  {row.waitsFor.length > 0
                    ? ` · waits for ${row.waitsFor.join(', ')}`
                    : ' · no waits'}
                </div>
              </li>
            ))}
          </ul>
        </details>
      </Panel>

      <p className="text-[12px] text-bcc-text-muted">
        Drafts only. This screen reads plan and progress files; it never sends,
        switches anything live, or touches an account.
      </p>
    </div>
  );
}
