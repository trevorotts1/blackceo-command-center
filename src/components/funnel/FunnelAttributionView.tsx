import {
  buildFunnelAttributionRows,
  type FunnelAttributionSnapshot,
  type FunnelRow,
} from '@/lib/funnel/attribution';

/**
 * PBB-127 / T-30 — funnel attribution and outcome evidence view.
 *
 * Purely presentational: it renders the row model from
 * `buildFunnelAttributionRows`, so an UNKNOWN state always displays the word
 * UNKNOWN and its reason. A `null` count is never printed as `0`, and the
 * four outcomes are four independent counts — this component draws no funnel
 * bars, no total and no conversion rate, because the source cannot prove a
 * sequence or a cause.
 *
 * Server component (no client hooks, no data fetching): the caller supplies
 * the snapshot, which keeps the view testable without a database or a
 * workspace.
 */
export function FunnelAttributionView({ snapshot }: { snapshot: FunnelAttributionSnapshot }) {
  const rows = buildFunnelAttributionRows(snapshot);

  return (
    <section className="space-y-4" aria-labelledby="funnel-attribution-title">
      <header>
        <h2 id="funnel-attribution-title" className="text-base font-semibold text-gray-800">
          Funnel attribution
        </h2>
        <p className="text-xs text-gray-500">
          Attribution classes are separated; outcome counts are independent. Unknown is never zero.
        </p>
      </header>

      {rows.banner ? (
        <p
          role="status"
          className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900"
        >
          {rows.banner}
        </p>
      ) : null}

      <div>
        <h3 className="mb-2 text-sm font-semibold text-gray-700">Attribution class</h3>
        <ul className="space-y-1">
          {rows.attribution.map((row) => (
            <Row key={row.id} row={row} />
          ))}
        </ul>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-gray-700">Outcomes (counted independently)</h3>
        <ul className="space-y-1">
          {rows.outcomes.map((row) => (
            <Row key={row.id} row={row} />
          ))}
        </ul>
      </div>

      {rows.footnote ? (
        <p className="text-xs text-gray-500">{rows.footnote}</p>
      ) : null}
    </section>
  );
}

function Row({ row }: { row: FunnelRow }) {
  const unknown = row.status === 'UNKNOWN';
  return (
    <li
      className={`flex items-baseline justify-between gap-3 rounded-lg px-3 py-2 ${
        unknown ? 'border border-amber-200 bg-amber-50' : 'bg-gray-50'
      }`}
    >
      <div className="min-w-0">
        <span className="text-sm font-medium text-gray-700">{row.label}</span>
        {row.detail ? (
          <span className="ml-2 text-xs text-amber-800">{row.detail}</span>
        ) : null}
      </div>
      <span
        className={`text-sm font-bold tabular-nums ${
          unknown ? 'text-amber-900' : 'text-gray-900'
        }`}
      >
        {row.count === null ? 'UNKNOWN' : row.count}
      </span>
    </li>
  );
}
