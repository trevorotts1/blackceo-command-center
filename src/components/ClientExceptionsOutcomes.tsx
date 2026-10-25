/**
 * PBB-129 / T-34 — client-facing bookings / failures / outcomes view.
 *
 * Pure presentation over `ExceptionsOutcomesView`. It owns no state, reads no
 * database and performs no action: every fact on screen was computed by
 * `src/lib/cc/exceptions-outcomes.ts`, including the UNKNOWN verdicts.
 *
 * The one rule this component enforces in markup: an unknown surface renders
 * an explicit UNKNOWN notice carrying its REASON. It never renders "0",
 * "No items" or a green state for an unproven surface.
 */

import type {
  BookingRow,
  ClientWorkload,
  ExceptionsOutcomesView,
  OutcomeKind,
  WorkItem,
  WorkloadRollup,
  WorkloadSection,
} from '@/lib/cc/exceptions-outcomes';

const OUTCOME_LABEL: Record<OutcomeKind, string> = {
  gift: 'Gifts delivered',
  contact: 'Contacts captured',
  booking: 'Bookings',
  sale: 'Sales',
};

function UnknownNotice({ what, reason }: { what: string; reason: string | null }) {
  const code = reason ?? 'unknown';
  return (
    <p className="text-sm text-amber-700" data-unknown="true" data-reason={code}>
      <strong>{what}: UNKNOWN.</strong>{' '}
      <span>Not verified — {code}.</span>
    </p>
  );
}

/**
 * Records that could not be used at all (no usable id, or a null row). They
 * are never counted and never dropped silently: the volume is named on screen.
 * `count === null` means the surface itself is UNKNOWN — that renders as the
 * UNKNOWN notice, never as a zero here.
 */
function ExcludedMalformed({ count }: { count: number | null }) {
  if (count === null || count === 0) return null;
  return (
    <p className="text-xs text-amber-700" data-excluded-malformed={count}>
      {count} record(s) arrived without a usable id and are excluded from every
      total above. They are counted here — never dropped.
    </p>
  );
}

function WorkItemRow({ item }: { item: WorkItem }) {
  return (
    <li
      className="border-l-4 border-amber-500 pl-3 py-1"
      data-item-id={item.id}
      data-priority={item.priority ?? 'unknown'}
      data-state={item.state}
      data-owner={item.owner.name ?? item.owner.kind}
    >
      <span className="font-semibold">{item.priority ?? 'UNKNOWN'}</span>{' '}
      <span>{item.title}</span>
      <span className="text-sm text-gray-600">
        {' '}
        — owner: {item.owner.name ?? 'unowned'}
        {item.owner.kind === 'unowned' ? ' (no owner named)' : ''}
      </span>
      <p className="text-sm text-gray-700">Next action: {item.next_action}</p>
      {item.unknown_reason ? (
        <p className="text-sm text-amber-700" data-item-unknown-reason={item.unknown_reason}>
          {item.unknown_reason}
        </p>
      ) : null}
      {item.coalesced_count > 1 ? (
        <p className="text-xs text-gray-600" data-coalesced={item.coalesced_count}>
          {item.coalesced_count} duplicate records coalesced into this item.
        </p>
      ) : null}
    </li>
  );
}

function RollupLine({ section, label }: { section: WorkloadSection; label: string }) {
  if (section.state === 'unknown') {
    return <UnknownNotice what={label} reason={section.reason} />;
  }
  const rollup: WorkloadRollup = section.rollup ?? {
    count: 0,
    by_surface: {},
    latest_at: null,
    owners: [],
  };
  return (
    <p className="text-sm text-gray-700" data-section={section.kind} data-count={rollup.count}>
      {label}: {rollup.count}
      {rollup.count > 0 ? ` (latest ${rollup.latest_at ?? 'time unknown'})` : ''}
    </p>
  );
}

function ImmediateSection({ workload }: { workload: ClientWorkload }) {
  const immediate = workload.immediate;
  if (immediate.state === 'unknown') {
    return <UnknownNotice what="Action items" reason={immediate.reason} />;
  }
  if (immediate.items.length === 0) {
    return <p className="text-sm text-gray-700" data-section="immediate" data-count="0">No P0 or P1 items.</p>;
  }
  return (
    <ul className="space-y-2" data-section="immediate" data-count={immediate.items.length}>
      {immediate.items.map((item) => (
        <WorkItemRow key={item.id} item={item} />
      ))}
    </ul>
  );
}

function FailuresSection({ view }: { view: ExceptionsOutcomesView }) {
  const { failures } = view;
  return (
    <section aria-labelledby="cc-failures-heading" data-surface="failures" data-state={failures.state}>
      <h2 id="cc-failures-heading" className="text-lg font-semibold">
        Failures
      </h2>
      {failures.state === 'unknown' ? (
        <UnknownNotice what="Failures" reason={failures.reason} />
      ) : (
        <>
          <ImmediateSection workload={failures.workload} />
          <RollupLine section={failures.workload.digest} label="P2 in the daily digest" />
          <RollupLine section={failures.workload.monthly} label="P3 in the monthly review" />
          {failures.workload.unknown.items.length > 0 ? (
            <div data-section="unclassified">
              <h3 className="text-sm font-semibold">Unclassified — needs a severity</h3>
              <ul className="space-y-2">
                {failures.workload.unknown.items.map((item) => (
                  <WorkItemRow key={item.id} item={item} />
                ))}
              </ul>
            </div>
          ) : null}
          <p className="text-xs text-gray-600" data-totals="failures">
            {failures.workload.totals.open} open, {failures.workload.totals.cleared} cleared,{' '}
            {failures.workload.totals.duplicates_folded} duplicate records folded.
          </p>
          <ExcludedMalformed count={failures.excluded_malformed} />
        </>
      )}
    </section>
  );
}

function BookingRowView({ row }: { row: BookingRow }) {
  return (
    <tr data-booking-id={row.id} data-stage={row.stage} data-state={row.state}>
      <td>{row.id}</td>
      <td>{row.stage === 'unknown' ? 'UNKNOWN' : row.stage}</td>
      <td>{row.owner.name ?? 'unowned'}</td>
      <td>{row.requested_at ?? 'not recorded'}</td>
      <td>{row.counts_as_sale ? 'counts as sale' : 'not a sale'}</td>
      <td data-booking-reason={row.reason ?? ''}>{row.reason ?? ''}</td>
    </tr>
  );
}

function BookingsSection({ view }: { view: ExceptionsOutcomesView }) {
  const { bookings } = view;
  return (
    <section aria-labelledby="cc-bookings-heading" data-surface="bookings" data-state={bookings.state}>
      <h2 id="cc-bookings-heading" className="text-lg font-semibold">
        Bookings
      </h2>
      {bookings.state === 'unknown' ? (
        <UnknownNotice what="Bookings" reason={bookings.reason} />
      ) : (
        <>
          {bookings.rows.length === 0 ? (
            <p className="text-sm text-gray-700" data-bookings-empty="true">
              {bookings.excluded_malformed
                ? 'No usable bookings in this period.'
                : 'No bookings in this period.'}
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th scope="col">Booking</th>
                  <th scope="col">Stage</th>
                  <th scope="col">Owner</th>
                  <th scope="col">Requested</th>
                  <th scope="col">Revenue</th>
                  <th scope="col">Unproven</th>
                </tr>
              </thead>
              <tbody>
                {bookings.rows.map((row) => (
                  <BookingRowView key={row.id} row={row} />
                ))}
              </tbody>
            </table>
          )}
          <ExcludedMalformed count={bookings.excluded_malformed} />
        </>
      )}
    </section>
  );
}

function OutcomesSection({ view }: { view: ExceptionsOutcomesView }) {
  const { outcomes } = view;
  return (
    <section aria-labelledby="cc-outcomes-heading" data-surface="outcomes" data-state={outcomes.state}>
      <h2 id="cc-outcomes-heading" className="text-lg font-semibold">
        Outcomes
      </h2>
      {outcomes.state === 'unknown' ? (
        <UnknownNotice what="Outcomes" reason={outcomes.reason} />
      ) : (
        <dl className="grid grid-cols-2 gap-2" data-outcomes="live">
          {(Object.keys(OUTCOME_LABEL) as OutcomeKind[]).map((kind) => {
            const bucket = outcomes.counts[kind];
            return (
              <div key={kind} data-outcome-kind={kind} data-state={bucket.state}>
                <dt className="text-sm text-gray-600">{OUTCOME_LABEL[kind]}</dt>
                <dd className="text-xl font-semibold" data-count={bucket.count ?? 'unknown'}>
                  {bucket.count === null ? 'UNKNOWN' : bucket.count}
                </dd>
                {bucket.excluded_unproven > 0 ? (
                  <dd className="text-xs text-amber-700" data-excluded-unproven={bucket.excluded_unproven}>
                    {bucket.excluded_unproven} unproven record(s) excluded from this count.
                  </dd>
                ) : null}
              </div>
            );
          })}
        </dl>
      )}
      {outcomes.excluded_unrecognised_kind !== null && outcomes.excluded_unrecognised_kind > 0 ? (
        <p className="text-xs text-amber-700" data-excluded-unrecognised-kind={outcomes.excluded_unrecognised_kind}>
          {outcomes.excluded_unrecognised_kind} record(s) with an unrecognised outcome kind are not
          counted in any of the four totals.
        </p>
      ) : null}
      <ExcludedMalformed count={outcomes.excluded_malformed} />
      <p className="text-xs text-gray-600">
        Counts are independent: a booking is never counted as a sale.
      </p>
    </section>
  );
}

export default function ClientExceptionsOutcomes({ view }: { view: ExceptionsOutcomesView }) {
  return (
    <div data-view="exceptions-outcomes" data-tenant={view.tenant.slug ?? 'unknown'}>
      <header>
        <h1 className="text-2xl font-semibold">Bookings, failures and outcomes</h1>
        {view.tenant.state === 'unknown' ? (
          <UnknownNotice what="Client" reason={view.tenant.reason} />
        ) : null}
      </header>
      <FailuresSection view={view} />
      <BookingsSection view={view} />
      <OutcomesSection view={view} />
    </div>
  );
}
