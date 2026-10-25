'use client';

/**
 * PBB-128 / T-32 — campaign approval board (client controls).
 *
 * Renders exactly what the server projection proved. There is no optimistic
 * "approved" or "published" state here: every badge comes from a real receipt,
 * every UNKNOWN carries its reason, and a STALE row is labelled as stale.
 * The two buttons submit the targeted cc-command via the server action; a
 * refusal is shown verbatim with its code.
 */
import { useMemo, useState, useTransition } from 'react';
import {
  cellStateOf,
  type CampaignApprovalView,
  type CalendarCellState,
  type PublicationState,
} from '@/lib/campaigns/approval-contract';
import {
  submitCampaignCommand,
  type CampaignActionInput,
  type CampaignActionState,
} from '@/app/campaigns/[id]/approval/actions';

const CELL_LABEL: Record<CalendarCellState, string> = {
  published: 'Published',
  scheduled: 'Approved + scheduled',
  held: 'Held',
  unapproved: 'Not approved',
  stale: 'Stale',
  unknown: 'Unknown',
};

const CELL_STYLE: Record<CalendarCellState, string> = {
  published: 'bg-emerald-50 border-emerald-200 text-emerald-800',
  scheduled: 'bg-sky-50 border-sky-200 text-sky-800',
  held: 'bg-amber-50 border-amber-200 text-amber-800',
  unapproved: 'bg-slate-50 border-slate-200 text-slate-700',
  stale: 'bg-orange-50 border-orange-200 text-orange-800',
  unknown: 'bg-fuchsia-50 border-fuchsia-200 text-fuchsia-800',
};

const PUBLICATION_STYLE: Record<PublicationState, string> = {
  CURRENT: 'bg-emerald-100 text-emerald-800',
  BEHIND: 'bg-amber-100 text-amber-800',
  UNKNOWN: 'bg-fuchsia-100 text-fuchsia-800',
};

// The calendar cell is decided in exactly ONE place: `cellStateOf()` in
// approval-contract.ts. This board used to carry its own `cellOf()` with a
// different precedence (freshness before publication), so a row that was both
// published and stale rendered differently here than the contract said it
// should. There is one rule now, and it is the tested one.

export function CampaignApprovalBoard({ view }: { view: CampaignApprovalView }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<CampaignActionState | null>(null);

  const blockedFields = useMemo(() => {
    const fields = new Set<string>();
    for (const placement of view.placements) {
      for (const field of placement.approval_blockers) fields.add(field);
    }
    return [...fields].sort();
  }, [view.placements]);

  const unprovenFields = useMemo(() => {
    const fields = new Set<string>();
    for (const placement of view.placements) {
      for (const field of placement.unknown_fields) fields.add(field);
    }
    return [...fields].sort();
  }, [view.placements]);

  const canApprove = view.placements.length > 0 && view.placements.every((placement) => placement.approvable);

  const submit = (input: CampaignActionInput) => {
    startTransition(async () => {
      const next = await submitCampaignCommand(input);
      setResult(next);
    });
  };

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-slate-900">{view.campaign_name}</h1>
        <p className="text-sm text-slate-600">
          Campaign approval · revision {view.revision} ·{' '}
          <span className="font-medium">{view.approval_summary.state}</span> — {view.approval_summary.reason}
        </p>
        {view.approval_summary.approved_at ? (
          <p className="text-xs text-slate-500">
            Approved {view.approval_summary.approved_at} by {view.approval_summary.approved_by ?? 'unknown actor'}
          </p>
        ) : null}
      </header>

      {result ? (
        <div
          className={`rounded border px-3 py-2 text-sm ${
            result.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-rose-200 bg-rose-50 text-rose-800'
          }`}
          role="status"
        >
          {result.ok ? 'Applied' : `Refused${result.code ? ` (${result.code})` : ''}`}: {result.reason}
        </div>
      ) : null}

      {!canApprove ? (
        <div className="rounded border border-fuchsia-200 bg-fuchsia-50 px-3 py-2 text-sm text-fuchsia-900">
          Approval is unavailable — the placement identity cannot be proven for:{' '}
          <span className="font-mono text-xs">{blockedFields.join(', ') || 'no placements'}</span>. A placement without a real
          date and channel is UNKNOWN, not approved.
        </div>
      ) : null}

      {unprovenFields.length > 0 ? (
        <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
          Manifest fields this box cannot prove (shown as UNKNOWN, never approved):{' '}
          <span className="font-mono">{unprovenFields.join(', ')}</span>. A calendar-scoped approval does not assert these.
        </div>
      ) : null}

      {view.unknowns.length > 0 ? (
        <div className="rounded border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
          Unresolved: <span className="font-mono">{view.unknowns.join(', ')}</span>
        </div>
      ) : null}

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Calendar</h2>
          <button
            type="button"
            disabled={!canApprove || pending}
            onClick={() =>
              submit({
                campaignId: view.campaign_id,
                kind: 'approve_campaign',
                expectedRevision: view.revision,
              })
            }
            className="rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {pending ? 'Submitting…' : `Approve manifest · rev ${view.revision}`}
          </button>
        </div>
        {view.calendar.length === 0 ? (
          <p className="rounded border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600">
            UNKNOWN — no placement carries a scheduled date, so there is nothing to calendar.
          </p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {view.calendar.map((day) => (
              <div key={day.date} className="rounded border border-slate-200 bg-white p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-slate-800">{day.date}</span>
                  <span className="text-xs text-slate-500">{day.placements.length} placement(s)</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {(Object.keys(day.counts) as CalendarCellState[])
                    .filter((cell) => day.counts[cell] > 0)
                    .map((cell) => (
                      <span key={cell} className={`rounded border px-2 py-0.5 text-xs ${CELL_STYLE[cell]}`}>
                        {CELL_LABEL[cell]}: {day.counts[cell]}
                      </span>
                    ))}
                </div>
                {day.has_unknown ? <p className="mt-2 text-xs text-fuchsia-700">Contains UNKNOWN placement(s).</p> : null}
                {day.has_stale ? <p className="mt-1 text-xs text-orange-700">Contains STALE placement(s).</p> : null}
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Placements</h2>
        <div className="overflow-x-auto rounded border border-slate-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Placement</th>
                <th className="px-3 py-2">Approval</th>
                <th className="px-3 py-2">Publication</th>
                <th className="px-3 py-2">Freshness</th>
                <th className="px-3 py-2">Action</th>
              </tr>
            </thead>
            <tbody>
              {view.placements.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-4 text-slate-600">
                    UNKNOWN — this campaign has no placements.
                  </td>
                </tr>
              ) : (
                view.placements.map((placement) => {
                  const cell = cellStateOf(placement);
                  const held = placement.approval_state === 'HELD';
                  const terminal = placement.task_status === 'done';
                  return (
                    <tr key={placement.placement_id} className="border-t border-slate-100 align-top">
                      <td className="px-3 py-2 text-slate-700">{placement.date ?? 'UNKNOWN'}</td>
                      <td className="px-3 py-2">
                        <div className="font-medium text-slate-800">{placement.title}</div>
                        <div className="font-mono text-xs text-slate-500">{placement.placement_id}</div>
                        <div className="text-xs text-slate-500">task status: {placement.task_status}</div>
                      </td>
                      <td className="px-3 py-2">
                        <span className={`rounded border px-2 py-0.5 text-xs ${CELL_STYLE[cell]}`}>
                          {placement.approval_state}
                        </span>
                        <div className="mt-1 text-xs text-slate-500">{placement.approval_reason}</div>
                        {placement.unknown_fields.length > 0 ? (
                          <div className="mt-1 font-mono text-[11px] text-fuchsia-700">
                            unproven: {placement.unknown_fields.join(', ')}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2">
                        <span className={`rounded px-2 py-0.5 text-xs ${PUBLICATION_STYLE[placement.publication_state]}`}>
                          {placement.publication_state}
                        </span>
                        <div className="mt-1 text-xs text-slate-500">{placement.publication_reason}</div>
                        {placement.publication_evidence ? (
                          <div className="mt-1 font-mono text-[11px] text-slate-500">{placement.publication_evidence}</div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2">
                        <span className="text-xs text-slate-700">{placement.freshness}</span>
                        {placement.freshness_reason ? (
                          <div className="text-xs text-orange-700">{placement.freshness_reason}</div>
                        ) : null}
                        {placement.last_event_at ? (
                          <div className="font-mono text-[11px] text-slate-500">last event {placement.last_event_at}</div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          disabled={pending || held || terminal}
                          onClick={() =>
                            submit({
                              campaignId: view.campaign_id,
                              kind: 'hold_placement',
                              placementId: placement.placement_id,
                              expectedRevision: view.revision,
                            })
                          }
                          className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-900 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {held ? 'Held' : terminal ? 'Terminal' : 'Hold'}
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Command receipts</h2>
        {view.receipts.length === 0 ? (
          <p className="rounded border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600">
            No command has been submitted for this campaign yet.
          </p>
        ) : (
          <ul className="space-y-1">
            {view.receipts
              .slice()
              .reverse()
              .map((receipt) => (
                <li key={receipt.command_id} className="rounded border border-slate-200 bg-white px-3 py-2 text-xs">
                  <span className="font-mono">{receipt.action}</span> → <span className="font-mono">{receipt.target_id}</span>{' '}
                  <span className={receipt.state === 'applied' ? 'text-emerald-700' : 'text-rose-700'}>{receipt.state}</span>
                  {receipt.refusal_code ? <span className="text-rose-700"> ({receipt.refusal_code})</span> : null}
                  <span className="text-slate-500"> · revision {receipt.applied_revision ?? '—'} · {receipt.recorded_at}</span>
                  {receipt.freshness === 'stale' ? (
                    <span className="ml-2 text-orange-700">STALE — {receipt.freshness_reason}</span>
                  ) : null}
                  <div className="mt-1 text-slate-600">{receipt.reason}</div>
                </li>
              ))}
          </ul>
        )}
      </section>
    </div>
  );
}
